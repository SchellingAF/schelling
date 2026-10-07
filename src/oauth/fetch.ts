// The only request this service makes to an address somebody else chose.
//
// An app may identify itself by the address of a document it publishes (a client
// ID metadata document), and an app that signs its token requests names where its
// public keys are. Both are fetched from here, on an address an unknown party
// wrote, so this is the one place the service could be turned against its own
// network: asked to fetch http://169.254.169.254/, the database's port, or the
// site's container.
//
// So: https only; every address a name resolves to is checked, and the connection
// is made to the one that was checked, never to a second lookup that could answer
// differently; no redirect is followed; the body is capped and the whole request is
// timed; and nothing a failure says reaches the caller beyond that it failed.
//
// And a fetch costs the service nothing it cannot spare, since two dozen slow ones
// could otherwise stop the whole API: names are resolved by the DNS client, which
// has its own timeout, and never on the thread pool the log and the database
// reconnects share; one document is fetched once at a time however many requests
// name it; a caller may have two fetches running, a network four and the service
// sixty-four, past which a request is told to try later rather than wait; and the
// route gives up its place in the global gate while its fetch runs (sharedFetch
// below).

import { request } from "node:https";
import { promises as dns, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { envNumber } from "../config.ts";

/** Addresses no fetch may reach: this machine, private networks, and every range
 * the IANA special-purpose registries reserve. */
const REFUSED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.31.196.0", 24], ["192.52.193.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["192.175.48.0", 24], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  REFUSED.addSubnet(net, bits, "ipv4");
}
// No rule for ::ffff:0:0/96: Node's BlockList compares an IPv4-mapped address with
// the IPv4 rules above, and the other way round, so that rule would refuse every
// IPv4 address there is, and ::ffff:127.0.0.1 is already refused as 127.0.0.1.
// The two other forms that carry an IPv4 address are refused whole, since no
// document is served from either: IPv4-compatible (::/96, deprecated, and holding
// :: and ::1) and IPv4-translated (::ffff:0:0:0/96). Neither rule is compared with
// an IPv4 address the way the mapped range is.
for (const [net, bits] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7],
  ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  REFUSED.addSubnet(net, bits, "ipv6");
}

/** Whether an address is one no fetch from here may reach. Exported for its test. */
export function refusedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return REFUSED.check(address, family === 4 ? "ipv4" : "ipv6");
}

export class FetchRefused extends Error {}

/** Too many fetches are running, here or for this caller: try later. Never kept as
 * a document's failure, or a flood could make a real app's document look broken. */
export class FetchBusy extends Error {}

export type Fetched = { status: number; contentType: string; cacheControl: string | null; body: string };

/** The DNS client, not getaddrinfo: its queries run on the event loop with their own
 * timeout, where a lookup through the operating system holds one of four threads
 * that file writes share, for as long as a slow name server likes. */
const resolver = new dns.Resolver({ timeout: 1500, tries: 2 });

/** A lookup that answers only with addresses a fetch may reach, and refuses the
 * whole name if any address it resolves to may not be. */
function checkedLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const refused = () => callback(Object.assign(new Error("refused address"), { code: "EREFUSEDADDRESS" }), "");
  // This machine by name, which the DNS client would not look up in the hosts file.
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return refused();
  void Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]).then(([v4, v6]) => {
    const addresses: LookupAddress[] = [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (addresses.length === 0) return callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "");
    if (addresses.some((a) => refusedAddress(a.address))) return refused();
    const first = addresses[0]!;
    if (options.all) callback(null, [first]);
    else callback(null, first.address, first.family);
  });
}

/** What sharedFetch needs of the route's place in the global gate. */
export type GatePlace = { stepOut(): void; stepIn(): Promise<void> };

/** Who a fetch is for, so it is counted against the right caller, and the route's
 * place in the global gate, given up while the fetch runs. */
export type FetchFor = { caller?: string | undefined; network?: string | undefined; place?: GatePlace | undefined };

// A whole number above zero, or sixty-four: a value that is not one would make the
// ceiling no ceiling (NaN compares false) or refuse every fetch (0).
const FETCHES_AT_ONCE = envNumber("OAUTH_FETCHES_AT_ONCE", 64, { min: 1, integer: true });
const FETCHES_PER_CALLER = 2;
const FETCHES_PER_NETWORK = 4;
const running = new Map<string, Promise<Fetched>>();
const perCaller = new Map<string, number>();
const perNetwork = new Map<string, number>();

function hold(counts: Map<string, number>, key: string | undefined): void {
  if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
}
function release(counts: Map<string, number>, key: string | undefined): void {
  if (key === undefined) return;
  const left = (counts.get(key) ?? 1) - 1;
  if (left <= 0) counts.delete(key);
  else counts.set(key, left);
}

/**
 * Fetch a document for a request, at the service's price rather than the caller's.
 *
 * A request naming a document that is already being fetched waits for that fetch.
 * Otherwise a new one starts only while fewer than sixty-four run, this caller runs
 * fewer than two and its network fewer than four, or FetchBusy is thrown: filling
 * every place takes sixteen networks. Either way the request waits outside the
 * global gate, whose places are for requests that use a database connection: a
 * fetch of an address that never answers would hold one for five seconds.
 */
export async function sharedFetch(
  address: string,
  fetcher: (address: string) => Promise<Fetched>,
  { caller, network, place }: FetchFor = {},
): Promise<Fetched> {
  let pending = running.get(address);
  if (!pending) {
    if (running.size >= FETCHES_AT_ONCE) throw new FetchBusy("too many fetches at once");
    if (caller !== undefined && (perCaller.get(caller) ?? 0) >= FETCHES_PER_CALLER) throw new FetchBusy("too many fetches for this caller");
    if (network !== undefined && (perNetwork.get(network) ?? 0) >= FETCHES_PER_NETWORK) throw new FetchBusy("too many fetches for this network");
    hold(perCaller, caller);
    hold(perNetwork, network);
    pending = fetcher(address).finally(() => {
      running.delete(address);
      release(perCaller, caller);
      release(perNetwork, network);
    });
    running.set(address, pending);
  }
  place?.stepOut();
  try {
    return await pending;
  } finally {
    await place?.stepIn();
  }
}

/**
 * GET one small JSON document from an address somebody else chose.
 *
 * Never throws anything but FetchRefused, whose message says why. That reason
 * reaches the request log as the app's refusal and is never shown to the app that
 * caused it.
 */
export async function fetchJsonDocument(
  address: string,
  { maxBytes = 16_384, timeoutMs = 5000 }: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new FetchRefused("not an address");
  }
  if (url.protocol !== "https:") throw new FetchRefused("not https");
  if (url.username !== "" || url.password !== "") throw new FetchRefused("carries credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && refusedAddress(host)) throw new FetchRefused("refused address");

  return await new Promise<Fetched>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "schellingaf (+https://schellingaf.com)" },
        lookup: checkedLookup as never,
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new FetchRefused("too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            status,
            contentType: String(res.headers["content-type"] ?? ""),
            cacheControl: typeof res.headers["cache-control"] === "string" ? res.headers["cache-control"] : null,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", (error) => reject(error instanceof FetchRefused ? error : new FetchRefused(error.message)));
      },
    );
    const overall = setTimeout(() => req.destroy(new FetchRefused("timed out")), timeoutMs);
    overall.unref();
    req.on("timeout", () => req.destroy(new FetchRefused("timed out")));
    req.on("error", (error) => {
      clearTimeout(overall);
      reject(error instanceof FetchRefused ? error : new FetchRefused(error.message));
    });
    req.on("close", () => clearTimeout(overall));
    req.end();
  });
}

/** How long a fetched document may be kept, from its own Cache-Control, between
 * five minutes and a day, and an hour when it says nothing. */
export function keepFor(cacheControl: string | null): number {
  const maxAge = cacheControl ? /max-age=(\d+)/i.exec(cacheControl) : null;
  const seconds = maxAge ? Number(maxAge[1]) : 3600;
  return Math.min(86_400, Math.max(300, seconds)) * 1000;
}
