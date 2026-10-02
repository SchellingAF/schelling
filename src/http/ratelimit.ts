// Rate limiting. One token bucket in Postgres per key, taken before the write
// it protects.
//
// Two rules that are not obvious and are both deliberate.
//
// A denied call never debits. A bucket that drains on refusal punishes an agent
// that is backing off correctly, and makes Retry-After a lie.
//
// A limit is only ever reported from the CALLER'S OWN buckets. A shared bucket
// (another peer's inbound allowance, a space's request budget) is an activity
// counter for someone else, so reporting its balance would leak how busy a
// private space or another agent is. When a shared bucket denies, the answer is
// a flat sixty seconds and no headers.

import { isIPv6 } from "node:net";
import type { Context } from "hono";
import { envNumber, type ClientAddressFrom } from "../config.ts";
import { ApiError } from "../db/errors.ts";
import type { Db } from "../db/sql.ts";

export type Bucket = { key: string; capacity: number; refillPerSec: number; own: boolean };

/**
 * The caller's address, as far as it can be trusted: the bucket every per-address
 * limit is keyed on.
 *
 * createApp works it out once per request, with addressFrom and the configured
 * CLIENT_ADDRESS_FROM, and this reads that. A context the app did not prepare (a
 * unit test's) is read as the default, last-forwarded.
 */
export function clientAddress(c: Context): string {
  const resolved = (c as { get?: (key: string) => unknown }).get?.("clientAddress");
  return typeof resolved === "string" ? resolved : addressFrom(c, "last-forwarded");
}

/**
 * The caller's address, read from where `from` says the proxy in front puts it
 * (see ClientAddressFrom in src/config.ts).
 *
 * When that header is absent or empty — a direct connection in a test, or a
 * misconfigured front end — the socket address is used instead, never another
 * header, and when there is neither, every such caller shares one bucket, as does
 * every caller whose address does not parse. That is deliberate: an unattributable
 * caller should be limited more, not less.
 *
 * IPv6 is keyed on its /64. A single subscriber is routinely handed a whole /64,
 * so limiting a full address limits nothing at all.
 */
export function addressFrom(c: Context, from: ClientAddressFrom): string {
  const raw = forwardedAddress(c, from) ?? addressOf(c);
  if (raw === null) return "unattributable";
  return bucketOfAddress(raw);
}

/** The address the proxy's header names, or null when it names none. */
function forwardedAddress(c: Context, from: ClientAddressFrom): string | null {
  // X-Forwarded-For is a list. A proxy that appends to it puts the peer it saw
  // LAST, so every entry before is whatever the caller claimed, and reading the
  // first would let one header buy a fresh bucket per request. Only a proxy that
  // strips what the caller sent and writes the visitor first makes the first
  // entry the one to read.
  let value: string | undefined;
  switch (from) {
    case "last-forwarded":
      value = c.req.header("X-Forwarded-For")?.split(",").at(-1);
      break;
    case "first-forwarded":
      value = c.req.header("X-Forwarded-For")?.split(",")[0];
      break;
    case "x-real-ip":
      value = c.req.header("X-Real-IP");
      break;
    case "socket":
      return null;
  }
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Every caller whose address does not parse. One bucket, shared. */
export const UNPARSEABLE_ADDRESS = "unparseable";

/**
 * The bucket an address belongs to, decided by its VALUE and never by how it is
 * spelled: the text is written by the caller, so a bucket per spelling would let
 * every spelling (a port, a zone, brackets, leading zeros, a mapped address in hex)
 * buy a fresh allowance. So the address is parsed: IPv4 is keyed on its canonical
 * dotted form, IPv6 on its /64 computed from the bits, and an IPv4-mapped IPv6
 * address on the IPv4 host it is. Text that is not an address in any spelling
 * shares ONE bucket with every other such text, which also keeps a bucket key
 * from growing with the header.
 */
function bucketOfAddress(text: string): string {
  const host = hostOf(text.trim());
  if (host === null) return UNPARSEABLE_ADDRESS;
  const v4 = canonicalIpv4(host);
  if (v4 !== null) return v4;
  const groups = ipv6Groups(host);
  if (groups === null) return UNPARSEABLE_ADDRESS;
  // ::ffff:a.b.c.d is one IPv4 host, whichever way it is written. In the /64 of
  // all-zero prefixes, every IPv4 caller arriving that way would share a bucket.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return groups.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
}

/**
 * The network an address's bucket belongs to: its IPv4 /24, or its IPv6 /48, from
 * the key bucketOfAddress made. A key that is not an address is its own network,
 * which for the shared unparseable and unattributable buckets is what they are.
 */
export function networkOfAddress(bucket: string): string {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(bucket);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  const v6 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(bucket);
  if (v6) return `${v6[1]}:${v6[2]}:${v6[3]}::/48`;
  return bucket;
}

/** The host inside `[...]`, or before a real `:port`, with any zone identifier
 * removed — or null when the text has the shape of neither. Brackets and port are
 * taken off BEFORE the zone, or `[fe80::1%25eth0]:443` would keep its port. */
function hostOf(text: string): string | null {
  let host: string;
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close < 0) return null;
    const rest = text.slice(close + 1);
    if (rest !== "" && !isPortSuffix(rest)) return null;
    host = text.slice(1, close);
  } else {
    const colon = text.indexOf(":");
    const oneColon = colon >= 0 && text.indexOf(":", colon + 1) < 0;
    if (oneColon) {
      if (!isPortSuffix(text.slice(colon))) return null;
      host = text.slice(0, colon);
    } else {
      host = text;
    }
  }
  const zone = host.indexOf("%");
  return zone >= 0 ? host.slice(0, zone) : host;
}

/** `:` and a port that can exist: one to five digits, no more than 65535. */
function isPortSuffix(text: string): boolean {
  const m = /^:(\d{1,5})$/.exec(text);
  return m !== null && Number(m[1]) <= 65535;
}

/** Dotted IPv4 in its canonical form, or null. Leading zeros are read as
 * decimal, so 203.0.113.005 and 203.0.113.5 are the one host they name. */
function canonicalIpv4(text: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets.join(".") : null;
}

/** An IPv6 address as its eight 16-bit groups, or null. Validated by the
 * platform first, then expanded, including an embedded dotted tail. */
function ipv6Groups(text: string): number[] | null {
  if (!isIPv6(text)) return null;
  let body = text;
  const tailColon = body.lastIndexOf(":");
  const tail = body.slice(tailColon + 1);
  if (tail.includes(".")) {
    const v4 = canonicalIpv4(tail);
    if (v4 === null) return null;
    const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
    body = body.slice(0, tailColon + 1) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const rear = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const missing = 8 - head.length - rear.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...rear];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** Hono's connection info, which is a Node socket here and absent under the
 * in-process request used by the tests and by the connector bridge. */
function addressOf(c: Context): string | null {
  try {
    const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return info?.socket?.remoteAddress ?? null;
  } catch {
    return null;
  }
}

// ── the numbers ──────────────────────────────────────────────────────────────
//
// Every rate a caller is held to, named once: lower one here. The buckets below
// are built from these, and the capability document and the reference print them.
// The numbers read from the environment are read with envNumber, and the reads
// inside a function are read on every call, so a test can set them.

/** How far a swarm's reach goes: set where no swarm meets it. */
export const SPACE_CREATIONS_PER_DAY = 100_000;
export const REDEMPTIONS_PER_HOUR = 10_000;
export const LINKS_PER_DAY = 100_000;
export const CONTROL_PER_HOUR = 100_000;
export const ASKS_PER_HOUR = 10_000;
export const SPACE_ASKS_PER_HOUR = 100_000;
export const INBOUND_PER_HOUR = 1_000_000;
/** Writes by one KEY: thirty a minute, sixty at once. */
export const WRITES_PER_MINUTE = 30;
export const WRITE_BURST = 60;
/** Direct messages sent by one KEY, a minute. */
export const MESSAGES_PER_MINUTE = 60;
/** Asks from one KEY to one SPACE, a day. */
export const ASKS_PER_SPACE_PER_KEY_DAY = 2;
/** From one KEY to one other, an hour. */
export const DELIVERIES_PER_HOUR = 200;
export const PROPOSALS_PER_DAY = envNumber("PROPOSALS_PER_DAY", 30);
export const PROPOSALS_FIRST_DAY = envNumber("PROPOSALS_FIRST_DAY", 5);
export const OPEN_POSTS_PER_DAY = envNumber("OPEN_POSTS_PER_DAY", 60);
export const OPEN_POSTS_FIRST_DAY = envNumber("OPEN_POSTS_FIRST_DAY", 10);
/** Posts one SPACE takes in a day from KEYS with no role there, versions aside: about
 *  167 KEYS' full allowance. A swarm let in by a link holds roles and is not counted.
 *  Shared, so a refusal from it says nothing of how busy the SPACE is. */
export const OPEN_POSTS_PER_SPACE_PER_DAY = 10_000;

/** Posts a day from a KEY that holds no role in their SPACE, in an oracle space or an
 *  open work space, which any KEY may write in: sixty, and ten for a KEY registered in
 *  the last day, so a key made minutes ago cannot fill a public discussion at the full
 *  write rate. append_post charges its own `open:` bucket under the SPACE lock, from
 *  this capacity, beside OPEN_POSTS_PER_SPACE_PER_DAY for the SPACE. */
export function openPostsPerDay(young: boolean): number {
  return young ? OPEN_POSTS_FIRST_DAY : OPEN_POSTS_PER_DAY;
}

/** Reads a minute, per KEY. Wide: an agent paging a busy space legitimately
 * makes a lot of these; the number stops one caller monopolising the process. */
export const READS_PER_MINUTE = envNumber("READS_PER_MINUTE", 600);

/**
 * Reads one caller may have IN FLIGHT at once, in this process. A rate is the
 * wrong brake for a single-threaded process: two dozen concurrent exports from
 * one KEY sit well inside the rate and still hold the one thread everybody else
 * needs. Six, because an agent pipelining a handful of reads while it thinks is
 * ordinary behaviour.
 */
export const CONCURRENT_READS_PER_CALLER = envNumber("CONCURRENT_READS_PER_CALLER", 6);

/**
 * The same two ceilings for a caller holding no VALID bearer (an expired or
 * revoked token included), and smaller. A KEY is one party that can be blocked
 * and whose allowance only its holder spends; an address is a whole NAT, a whole
 * IPv6 /64, or every unattributable caller sharing one string. Two reads a second
 * and two at once: a crawler paging a public space is never refused, a flood is,
 * and a crawler that wants more registers.
 */
export const ANON_READS_PER_MINUTE = envNumber("ANON_READS_PER_MINUTE", 120);
export const CONCURRENT_READS_PER_ANON = envNumber("CONCURRENT_READS_PER_ANON", 2);

/**
 * The health check's own window per address, apart from the anonymous one and
 * outside the global gate: a health check that fails because a crawler filled the
 * anonymous allowance gets the container restarted. Wide enough for a one-second
 * probe from a load balancer and a container health check at the same address.
 */
export const HEALTH_CHECKS_PER_MINUTE = envNumber("HEALTH_CHECKS_PER_MINUTE", 600);

/** SEEK a minute, per KEY. Tighter, because a seek costs far more than a page
 * read and has its own concurrency gate behind it. */
export const SEEKS_PER_MINUTE = envNumber("SEEKS_PER_MINUTE", 120);

/** SEEKs one caller may have running at once: see src/http/seek.ts. */
export const SEEKS_PER_CALLER = envNumber("SEEKS_PER_CALLER", 1);

/** Requests to the app token endpoint a minute, per address: see src/oauth/routes.ts. */
export const TOKEN_REQUESTS_PER_MINUTE = envNumber("OAUTH_TOKEN_REQUESTS_PER_MINUTE", 1200);

/** Category lookups by name a minute, per address: see src/http/categories.ts. */
export const CATEGORY_LOOKUPS_PER_MINUTE = envNumber("CATEGORY_LOOKUPS_PER_MINUTE", 600);

/** Tokens one address may present a minute that nobody here has seen work: see
 * mayLookUpToken. */
const BAD_BEARERS_PER_MINUTE = envNumber("BAD_BEARERS_PER_MINUTE", 60);

/** Registrations from one address, when REGISTRATION_PER_HOUR and REGISTRATION_BURST
 *  say nothing: a swarm often starts from one host. */
export const REGISTRATIONS_PER_HOUR_DEFAULT = 100_000;
export const REGISTRATION_BURST_DEFAULT = 10_000;
/** Tokens one KEY may mint from one address in an hour, when CHALLENGE_PER_KEY says
 *  nothing. */
export const CHALLENGES_PER_KEY_HOUR_DEFAULT = 20;

/** Registrations from one address: an hour's number, and how many at once. */
export function registrationAllowance(): { perHour: number; burst: number } {
  return {
    perHour: envNumber("REGISTRATION_PER_HOUR", REGISTRATIONS_PER_HOUR_DEFAULT),
    burst: envNumber("REGISTRATION_BURST", REGISTRATION_BURST_DEFAULT),
  };
}

/** Tokens one KEY may mint from one address in an hour. */
export function challengesPerKeyHour(): number {
  return envNumber("CHALLENGE_PER_KEY", CHALLENGES_PER_KEY_HOUR_DEFAULT);
}

/**
 * How many tokens the whole service mints in a day: every new KEY's first, and
 * every one after. 100,000,000 unless REGISTRATIONS_PER_DAY is a whole number above
 * zero. Set where no swarm meets it; REGISTRATIONS_PER_DAY lowers it. The disk
 * alert watches the result. See `serviceTokens`.
 */
export function registrationsPerDay(): number {
  return envNumber("REGISTRATIONS_PER_DAY", 100_000_000, { min: 1, integer: true });
}

/** How old a KEY must be to create a public SPACE, in hours. Each route that asks reads
 *  it once, when the app is built, as the capability document does, so the number the
 *  service publishes and the number it enforces cannot disagree. A test or a local
 *  demo sets it to zero before building the app. */
export const publicKeyAgeHours = (): number => envNumber("PUBLIC_SPACE_MIN_KEY_AGE_HOURS", 0);

/** The allowances for apps signing people in, as the documents say them: what LIMITS's
 *  app buckets below are made from, read the same way. */
export const appAllowances = () => ({
  registrationsPerHour: envNumber("APP_REGISTRATIONS_PER_HOUR", 60),
  registrationBurst: envNumber("APP_REGISTRATION_BURST", 10),
  registrationsPerNetworkHour: envNumber("APP_REGISTRATIONS_PER_NETWORK_HOUR", 120),
  registrationNetworkBurst: envNumber("APP_REGISTRATION_NETWORK_BURST", 20),
  registrationsPerDay: envNumber("APP_REGISTRATIONS_PER_DAY", 20000),
  connectionsPerHour: envNumber("APP_CONNECTIONS_PER_HOUR", 300),
  connectionBurst: envNumber("APP_CONNECTION_BURST", 30),
  connectionsPerNetworkHour: envNumber("APP_CONNECTIONS_PER_NETWORK_HOUR", 120),
  connectionNetworkBurst: envNumber("APP_CONNECTION_NETWORK_BURST", 30),
  connectionsPerDay: envNumber("APP_CONNECTIONS_PER_DAY", 100000),
});

// ── the buckets ──────────────────────────────────────────────────────────────

const HOUR = 3600;
const DAY = 86400;

/** `n` a day, and at most `n` at once. */
const daily = (key: string, n: number, own: boolean): Bucket => ({ key, capacity: n, refillPerSec: n / DAY, own });

/** `n` an hour, and at most `n` at once. */
const hourly = (key: string, n: number, own: boolean): Bucket => ({ key, capacity: n, refillPerSec: n / HOUR, own });

/** `perHour` an hour, and at most `burst` at once. */
const burstHourly = (key: string, burst: number, perHour: number, own: boolean): Bucket => ({
  key,
  capacity: burst,
  refillPerSec: perHour / HOUR,
  own,
});

/** A day's number for the whole service, held an hour's worth at a time: see
 * serviceTokens. Shared, so a refusal carries no numbers. */
const hourOfDay = (key: string, perDay: number): Bucket => ({
  key,
  capacity: Math.max(1, Math.floor(perDay / 24)),
  refillPerSec: perDay / DAY,
  own: false,
});

/** The caller's buckets, and the per-address and whole-service ones for registering
 * and for apps. */
export const LIMITS = {
  /** Writes by one KEY. */
  peerWrites: (peerHex: string): Bucket => ({
    key: `peer:${peerHex}`,
    capacity: WRITE_BURST,
    refillPerSec: WRITES_PER_MINUTE / 60,
    own: true,
  }),
  /** Proposals to oracle spaces: thirty a day, and five for a KEY registered in the
   * last day, because a proposal costs the reviewer a model call and its decision.
   * The two share one bucket, which simply grows when the KEY is a day old. */
  proposals: (peerHex: string, young: boolean): Bucket =>
    daily(`proposal:${peerHex}`, young ? PROPOSALS_FIRST_DAY : PROPOSALS_PER_DAY, true),
  /** SPACES made by one KEY. A swarm's coordinator makes a SPACE for each piece of
   * work, so it is set where no swarm meets it. */
  spaceCreation: (peerHex: string): Bucket => daily(`space:${peerHex}`, SPACE_CREATIONS_PER_DAY, true),
  /**
   * Registration, per address: see registrationAllowance. `POST /v1/keys/challenge`
   * and `POST /v1/keys/verify` answer a caller holding nothing AND write a row, so
   * without this anybody could fill `peers` and `tokens` as fast as they could open
   * connections.
   *
   * NOT the caller's own: everybody behind one NAT, or in one IPv6 /64, shares it,
   * so its balance would tell a registering KEY how many OTHER KEYS registered from
   * its office in the last hour. A registering client needs Retry-After and
   * nothing else.
   */
  registration: (addr: string): Bucket => {
    const allowance = registrationAllowance();
    return burstHourly(`ip:${addr}`, allowance.burst, allowance.perHour, false);
  },
  /**
   * Tokens minted by one KEY from one address: CHALLENGE_PER_KEY an hour.
   *
   * Paired with the address, because a bucket on the public key alone would let a
   * stranger who knows it lock the KEY out of minting tokens from anywhere. And
   * spent at POST /v1/keys/verify, AFTER the signature over the challenge verifies,
   * because an address is shared (one NAT, one IPv6 /64) and a public key is no
   * secret: spent at the challenge, anybody at the victim's address could empty it.
   * So only the holder of the private half spends it, which makes it the caller's
   * own. The challenge itself is an HMAC that writes no row, and scanning many keys
   * from one address meets `registration`.
   *
   * There is deliberately no bucket on the public key alone as a scanning brake:
   * it is exactly the denial of service this pairing prevents.
   */
  challengeForKey: (publicKeyHex: string, addr: string): Bucket =>
    hourly(`key:${publicKeyHex}:${addr}`, challengesPerKeyHour(), true),
  /**
   * The same bucket for a passkey KEY, spent at POST /v1/passkeys/verify after
   * the passkey's signature is verified, for the same reason. Keyed on the peer
   * id, because a passkey is found by its credential id and has no 32-byte
   * public key to name, under its own prefix so it can never be a KEY's bucket.
   */
  challengeForPasskey: (peerIdHex: string, addr: string): Bucket =>
    hourly(`passkey:${peerIdHex}:${addr}`, challengesPerKeyHour(), true),
  /**
   * Every token minted, across the whole service: registrationsPerDay() a day.
   *
   * The other registration limits are per address or per KEY, and addresses are
   * cheap (an IPv6 /48 holds 65,536 of the /64s counted as one). A registration is
   * cheap to make and costly to keep: about 850 bytes never deleted and about 47 KB
   * of change log, which the backups keep for one to two weeks. Every token and not
   * only a new KEY's first, because an existing KEY mints tokens as often as a new
   * one registers.
   *
   * An hour's worth at a time, not a day's: a bucket holding the whole day could be
   * emptied at once and refilled over the next, letting twice the number through on
   * a flood's first day. During a flood an honest agent past it is refused until it
   * refills. Shared, so the refusal carries no numbers: its balance is how many
   * agents everywhere minted a token in the last hour.
   */
  serviceTokens: (): Bucket => hourOfDay("service:tokens", registrationsPerDay()),
  /**
   * Apps registering themselves (RFC 7591), per address: 60 an hour, burst 10.
   *
   * Registering writes a row for a caller holding nothing, so it is rationed per
   * address as a KEY's registration is. The apps people use most identify
   * themselves by a published document instead, which registers nothing, so this
   * brakes everybody else: a program on somebody's own computer registers once.
   * Small, so that emptying the service's allowance takes many networks; what a
   * flood then costs is new registrations only, while every app registered before,
   * or publishing its document, connects throughout. A service registering for many
   * people from one address meets it within the hour, and should publish a client
   * ID metadata document instead, which this server prefers.
   */
  appRegistrations: (addr: string): Bucket => {
    const app = appAllowances();
    return burstHourly(`app-register:${addr}`, app.registrationBurst, app.registrationsPerHour, false);
  },
  /** The same, per network: an IPv4 /24 or an IPv6 /48, which is what one
   * subscriber or one cloud account is handed. 120 an hour, burst 20. */
  appRegistrationsNetwork: (addr: string): Bucket => {
    const app = appAllowances();
    return burstHourly(
      `app-register-net:${networkOfAddress(addr)}`,
      app.registrationNetworkBurst,
      app.registrationsPerNetworkHour,
      false,
    );
  },
  /** Every app registration across the service: 20,000 a day. A registered app
   * that never gets a token is pruned a day later, so this bounds what the table
   * holds as well as how fast it grows. */
  appRegistrationsService: (): Bucket => hourOfDay("service:app-registrations", appAllowances().registrationsPerDay),
  /**
   * Requests to connect an app, per address: 300 an hour, burst 30.
   *
   * These arrive from the person's own browser, so the address is theirs, and
   * each writes a row that lasts a day. A person connecting a few apps never meets
   * this; a page sending browsers here in a loop does.
   */
  appConnections: (addr: string): Bucket => {
    const app = appAllowances();
    return burstHourly(`app-connect:${addr}`, app.connectionBurst, app.connectionsPerHour, false);
  },
  /** The same, per network: an IPv4 /24 or an IPv6 /48. 120 an hour, burst 30. An
   * address alone is an IPv6 /64, and one /48 holds 65,536 of them. */
  appConnectionsNetwork: (addr: string): Bucket => {
    const app = appAllowances();
    return burstHourly(
      `app-connect-net:${networkOfAddress(addr)}`,
      app.connectionNetworkBurst,
      app.connectionsPerNetworkHour,
      false,
    );
  },
  /**
   * Every request to connect across the service: 100,000 a day, an hour's worth at
   * a time. Each writes a row of up to about six kilobytes that is kept for a day,
   * so this holds the table under about 600 megabytes however many networks a
   * flood comes from. The price is the one tokens and registrations pay: during such
   * a flood a person connecting an app is told to try later. With the network's
   * allowance beside it, emptying this at once takes 139 networks and keeping it
   * empty 35.
   */
  appConnectionsService: (): Bucket => hourOfDay("service:app-connections", appAllowances().connectionsPerDay),
  /** Failures count, which is the whole point: guessing is the attack. */
  redemption: (peerHex: string): Bucket => hourly(`redeem:${peerHex}`, REDEMPTIONS_PER_HOUR, true),
} as const;

/**
 * The buckets that protect somebody OTHER than the caller.
 *
 * These are debited only after authority is established — after the caller's
 * right to write and the recipients' membership are confirmed — because
 * otherwise an outsider could drain a peer's inbound allowance from outside the
 * SPACE, which is a denial of service dressed as a rate limit.
 *
 * And they are never reported in a header. A shared bucket's balance is an
 * activity counter for somebody else: how busy a private SPACE is, how much mail
 * another agent is getting. `own: false` is what makes `spend` answer a flat
 * sixty seconds and no numbers.
 */
export const SHARED = {
  /** Sender to one recipient. Co-members of a private SPACE, all admitted by its
   * owner, so this is generous. A KEY with no role, writing in an open work space or
   * an oracle space, is held by its own small allowance for such posts, and reaches
   * nobody who blocks its messages. */
  delivery: (senderHex: string, recipientHex: string): Bucket =>
    hourly(`dm:${senderHex}:${recipientHex}`, DELIVERIES_PER_HOUR, false),
  /** Everything arriving at one recipient, across senders. Requests and
   * decisions do not count: a governor cannot be flooded out of its own
   * governance. */
  inbound: (recipientHex: string): Bucket => hourly(`rcpt:${recipientHex}`, INBOUND_PER_HOUR, false),
  /** Asks arriving at one SPACE. Its notices reach the owner and the first admins
   * alone, however many ask, so a busy door costs no governor its mailbox. */
  spaceRequests: (spaceId: string): Bucket => hourly(`req:${spaceId}`, SPACE_ASKS_PER_HOUR, false),
  /** One peer asking one SPACE. This IS the decline cooldown: a state for
   * "recently refused" would be a second record of the same fact, which can drift. */
  spaceRequestsByPeer: (spaceId: string, peerHex: string): Bucket =>
    daily(`req:${spaceId}:${peerHex}`, ASKS_PER_SPACE_PER_KEY_DAY, false),
} as const;

/** The caller's own buckets for governing and for asking. */
export const OWN = {
  /** Asks made by one KEY, anywhere. */
  requests: (peerHex: string): Bucket => hourly(`req:${peerHex}`, ASKS_PER_HOUR, true),
  /** Grants, revocations, decisions, tag changes, and batches of revoke and remove. */
  control: (peerHex: string): Bucket => hourly(`ctl:${peerHex}`, CONTROL_PER_HOUR, true),
  /** Links made by one KEY, hand-overs and offers among them. */
  invites: (peerHex: string): Bucket => daily(`inv:${peerHex}`, LINKS_PER_DAY, true),
  /** Direct messages sent by one KEY: sixty a minute. Not the general write
   * bucket as well, whose thirty a minute would be the real limit if both were
   * spent. How many of them may be requests is counted in the database, which is
   * the only place that knows who is a stranger. */
  messages: (peerHex: string): Bucket => ({
    key: `msg:${peerHex}`,
    capacity: MESSAGES_PER_MINUTE,
    refillPerSec: MESSAGES_PER_MINUTE / 60,
    own: true,
  }),
} as const;

/**
 * The read window: how often one caller reads, counted in this process.
 *
 * In process rather than in Postgres on purpose: a read flood answered by writing
 * a row per request turns a read problem into a write problem on the hottest small
 * table in the service. The window is per process and resets on restart, which is
 * the right trade for a brake whose job is to stop one caller monopolising a
 * machine.
 *
 * A sliding counter over two minutes rather than a list of timestamps: one small
 * object per key, so a flood of distinct keys costs memory in proportion to the
 * keys and not to the requests. The map is bounded and evicts whole generations,
 * because an unbounded map IS the denial of service it is meant to prevent.
 */
const WINDOW_MS = 60_000;
const MAX_KEYS = 100_000;

type Cell = { minute: number; count: number; previous: number };
let windowKeys = new Map<string, Cell>();
let windowOld = new Map<string, Cell>();

function windowCell(key: string): Cell {
  let cell = windowKeys.get(key);
  if (cell === undefined) {
    cell = windowOld.get(key) ?? { minute: 0, count: 0, previous: 0 };
    // Whole-generation eviction: when the live map is full it becomes the old
    // one and a fresh map starts. A key still in use is carried forward the
    // next time it is seen, so eviction costs a caller nothing but a reset.
    if (windowKeys.size >= MAX_KEYS) {
      windowOld = windowKeys;
      windowKeys = new Map();
    }
    windowKeys.set(key, cell);
  }
  return cell;
}

/**
 * The rate `key` is running at, and the cell it was read from.
 *
 * The rate is the current minute's count plus the previous minute's, weighted
 * by how much of this minute is left — which smooths the edge a fixed window
 * has, where a caller can spend its whole allowance twice either side of a
 * minute boundary. Reading rolls the minute over but counts nothing, so a
 * caller that only asks whether it is over its allowance is not charged for
 * asking.
 */
function windowRate(key: string): { cell: Cell; rate: number; retryAfter: number } {
  const now = Date.now();
  const minute = Math.floor(now / WINDOW_MS);
  const cell = windowCell(key);
  if (cell.minute !== minute) {
    cell.previous = cell.minute === minute - 1 ? cell.count : 0;
    cell.count = 0;
    cell.minute = minute;
  }
  const elapsed = (now % WINDOW_MS) / WINDOW_MS;
  return {
    cell,
    rate: cell.previous * (1 - elapsed) + cell.count,
    retryAfter: Math.max(1, Math.ceil((1 - elapsed) * (WINDOW_MS / 1000))),
  };
}

/**
 * How many calls one address may START in a minute against a bucket kept per
 * address, such as registration's `ip:` bucket, counted in this process before the
 * call takes a place in the global gate.
 *
 * The bucket in Postgres is the limit. But checking it costs a round trip on the
 * write pool while holding a gate place, so an address whose bucket is empty could
 * keep taking places with calls certain to be refused. A rate stops that stream; a
 * concurrency share would not, and would tell several agents behind one office NAT
 * BUSY on the first call they ever made.
 *
 * The rate can never refuse a call the bucket would allow: in any window the
 * bucket admits at most its capacity plus what it refills in that window, and
 * `windowRate` weighs the previous minute into the current one, so it sees up to
 * two minutes. Hence capacity plus two minutes of refill.
 */
export function ceilingPerMinute(bucket: Bucket): number {
  return bucket.capacity + bucket.refillPerSec * 120;
}

/** Count one read against `key`, and say whether it is within `perMinute`. */
export function withinReadWindow(key: string, perMinute: number): { allowed: boolean; retryAfter: number } {
  const window = windowRate(key);
  if (window.rate >= perMinute) return { allowed: false, retryAfter: window.retryAfter };
  window.cell.count++;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Token guessing, the one thing an unauthenticated caller can make the database
 * do: `schellingaf_` and any sixty-four lowercase hex characters passes every
 * cheap gate in `classifyBearer` and reaches a query, on routes that need no token
 * at all. Failures count, because guessing is the attack; counted in this process,
 * for the reason the read window is.
 *
 * The window is per ADDRESS, which is shared (one NAT, one /64), so a bearer this
 * process has already resolved is never held by it: one guesser must not refuse
 * its neighbours' good tokens. It only ever refuses a token nobody here has seen
 * work.
 */
let seenTokens = new Set<string>();
let seenTokensOld = new Set<string>();

/** Whether this lookup may reach the database. Reads nothing and counts
 * nothing; the answer for a bearer that has worked here before is always yes. */
export function mayLookUpToken(addr: string, tokenHash: string): { allowed: boolean; retryAfter: number } {
  if (seenTokens.has(tokenHash) || seenTokensOld.has(tokenHash)) return { allowed: true, retryAfter: 0 };
  const window = windowRate(`bearer:${addr}`);
  if (window.rate >= BAD_BEARERS_PER_MINUTE) return { allowed: false, retryAfter: window.retryAfter };
  return { allowed: true, retryAfter: 0 };
}

/** What the lookup found. Only failures are counted; a bearer that resolved is
 * remembered so its holder is never held by somebody else's guessing. */
export function noteTokenLookup(addr: string, tokenHash: string, resolved: boolean): void {
  if (resolved) {
    // Whole-generation eviction, as above: the live set becomes the old one and
    // a fresh one starts, so a flood of distinct tokens costs memory in
    // proportion to the tokens and not to the requests.
    if (seenTokens.size >= MAX_KEYS) {
      seenTokensOld = seenTokens;
      seenTokens = new Set();
    }
    seenTokens.add(tokenHash);
    return;
  }
  windowRate(`bearer:${addr}`).cell.count++;
}

/**
 * What a read is counted against: the KEY when there is one, the address when
 * there is not. One function for every call site, so no limiter keys every
 * caller without a KEY on one word, where one anonymous SEEK in flight would
 * refuse SEEK to everybody.
 */
export function readKey(c: Context, peerHex: string | null): string {
  return peerHex === null ? `addr:${clientAddress(c)}` : `peer:${peerHex}`;
}

/**
 * The whole service's share of the moment, which is the ceiling none of the
 * others are.
 *
 * Every other limit bounds ONE caller, and a flood spread across many addresses
 * stays inside every one of them: nothing is refused, and an operator sees rising
 * memory and latency with a healthy 200 rate and nothing naming the cause.
 *
 * The gate WAITS before it refuses, for the reason SEEK's does: a caller that
 * arrives while the service is full has done nothing wrong, and refusing it
 * immediately refuses whoever has waited least. Past the queue the refusal is
 * honest again.
 *
 * Twice the read pool, because a request does work either side of its
 * transaction and a ceiling at the pool size would leave connections idle while
 * requests queued. Past that the driver's own queue would do the bounding, and it
 * does none: a query waiting for a connection waits as long as it takes. So the
 * gate covers every path that reaches a pool, not only the reads. See
 * connect_timeout in db/sql.ts for what that setting does and does not bound.
 *
 * Built per app rather than per module: a test has to be able to fill it with a
 * small gate. A process runs one app, so per app is per process where it counts.
 */
export function globalReadGate() {
  return concurrencyGate(
    envNumber("GLOBAL_CONCURRENT_READS", 24),
    envNumber("GLOBAL_READ_QUEUE", 256),
    envNumber("GLOBAL_READ_WAIT_MS", 1000),
  );
}

/**
 * How many of something each caller has in flight, and a ceiling on it: call it
 * with a caller's key and its ceiling to take a share, or be refused BUSY past
 * the ceiling. It returns the release, which the caller MUST run in a `finally`:
 * a share leaked on a thrown request would lock that caller out for the life of
 * the process. A release run twice gives back one share, never another caller's.
 * Only callers with something running are counted, so the count is bounded by
 * concurrency and needs no eviction.
 */
export function inFlightShares(): ((key: string, max: number) => () => void) & { clear(): void } {
  const held = new Map<string, number>();
  const take = (key: string, max: number): (() => void) => {
    const mine = held.get(key) ?? 0;
    if (mine >= max) throw new ApiError("BUSY", { retryAfter: 1 });
    held.set(key, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (held.get(key) ?? 1) - 1;
      if (left <= 0) held.delete(key);
      else held.set(key, left);
    };
  };
  return Object.assign(take, { clear: () => held.clear() });
}

const inFlightReads = inFlightShares();

/** Take one of a caller's in-flight read slots, or refuse with BUSY; see inFlightShares. */
export function holdRead(key: string, max: number): () => void {
  return inFlightReads(key, max);
}

/** For tests: forget every in-flight slot. */
export function resetInFlightReads(): void {
  inFlightReads.clear();
}

/**
 * A bounded number of somethings running at once, with a bounded queue: SEEK's
 * gate and the global read gate. Here rather than in a route so it can be tested
 * directly: how a gate behaves when full is hard to observe through a route.
 *
 * It waits rather than refusing whoever arrives while it is full, which would
 * refuse the caller who has waited least: a caller inside its own share is served
 * late. Its callers take their own share before they join the queue, so one
 * caller never holds more than one place in it. The wait is bounded, because an
 * unbounded wait is a different denial.
 */
export function concurrencyGate(limit: number, queueDepth: number, waitMs: number) {
  type Waiter = { resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> };
  const waiting: Waiter[] = [];
  let running = 0;

  return {
    /** A slot, or BUSY. Resolves only when the slot is this caller's to hold. */
    async take(): Promise<void> {
      if (running < limit) {
        running++;
        return;
      }
      if (waiting.length >= queueDepth) throw new ApiError("BUSY", { retryAfter: 1 });
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const at = waiting.indexOf(waiter);
            if (at >= 0) waiting.splice(at, 1);
            reject(new ApiError("BUSY", { retryAfter: 1 }));
          }, waitMs),
        };
        // setTimeout keeps the process alive; a queued request is not a reason
        // for a shutting-down service to stay up.
        waiter.timer.unref?.();
        waiting.push(waiter);
      });
    },
    /**
     * Give the slot back — to whoever has waited longest if there is one, and
     * otherwise to the pool. Handing it over rather than decrementing and
     * letting the waiters re-check is what makes this first-in-first-out
     * instead of a scramble every caller has to win.
     */
    give(): void {
      const next = waiting.shift();
      if (next === undefined) {
        running--;
        return;
      }
      clearTimeout(next.timer);
      next.resolve();
    },
    /** For tests and for the request log: how loaded this gate is right now. */
    state(): { running: number; waiting: number } {
      return { running, waiting: waiting.length };
    },
  };
}

/** Refuse a read that is over its window. Reads answer BUSY rather than
 * RATE_LIMITED: there is no bucket to report a balance from, and BUSY already
 * means "retry, this is not about you". */
export function limitRead(key: string, perMinute: number): void {
  const out = withinReadWindow(key, perMinute);
  if (!out.allowed) throw new ApiError("BUSY", { retryAfter: out.retryAfter });
}

/** For tests: forget every window, and every bearer this process has seen work. */
export function resetReadWindows(): void {
  windowKeys = new Map();
  windowOld = new Map();
  seenTokens = new Set();
  seenTokensOld = new Set();
}

/**
 * Spend from a bucket or refuse the request. On refusal an own bucket reports
 * its own numbers; a shared one reports nothing but a coarse wait.
 */
export async function spend(
  c: Context,
  db: Db,
  bucket: Bucket,
  cost = 1,
): Promise<void> {
  const [row] = await db.write<{ take: { allowed: boolean; tokens: number; retry_after_s: number } }[]>`
    select schellingaf.take_tokens(${bucket.key}, ${bucket.capacity},
                                   ${bucket.refillPerSec}, ${cost}) as take`;
  const result = row!.take;
  // On a refusal as well as on a success: the 429 is where a caller most needs
  // its own numbers, and the reference promises RateLimit-* whenever the bucket
  // that refused was the caller's own.
  if (bucket.own) {
    c.header("RateLimit-Limit", String(bucket.capacity));
    c.header("RateLimit-Remaining", String(Math.max(0, Math.floor(result.tokens))));
    c.header("RateLimit-Reset", String(Math.ceil((bucket.capacity - result.tokens) / bucket.refillPerSec)));
  }
  if (result.allowed) return;
  throw new ApiError("RATE_LIMITED", {
    retryAfter: bucket.own ? Math.max(1, result.retry_after_s) : 60,
    // A refusal from a shared bucket carries no numbers at all, and that has to
    // hold even when an earlier own-bucket spend in the same request already set
    // them: a response mixing a flat minute with a stale remaining count is both
    // confusing and a partial answer to a question the caller may not ask.
    shared: !bucket.own,
  });
}

/**
 * Refuse if a shared bucket is already empty, WITHOUT debiting it.
 *
 * This is how "charge only after authority" is kept without writing a second
 * copy of the authority rules out here. A read costs the bucket nothing, so an
 * outsider calling this cannot drain anybody's allowance; the debit happens only
 * after the write function — the one thing allowed to decide who may do what —
 * has actually accepted the post.
 *
 * A denial carries a flat minute and no numbers. The balance of somebody else's
 * inbound allowance is a measure of how much mail they are getting, and that is
 * theirs.
 */
export async function refuseIfEmpty(db: Db, buckets: Bucket[], cost = 1): Promise<void> {
  if ((await emptyOf(db, buckets, cost)).size > 0) {
    throw new ApiError("RATE_LIMITED", { retryAfter: 60, shared: true });
  }
}

/**
 * The keys of the shared buckets that cannot pay `cost` now, read and never
 * debited, exactly as refuseIfEmpty reads them. A post asks it which recipients to
 * leave out of its notices rather than refusing the post for a busy recipient.
 */
export async function emptyOf(db: Db, buckets: Bucket[], cost = 1): Promise<Set<string>> {
  const empty = new Set<string>();
  if (buckets.length === 0) return empty;
  // A plain SELECT, not take_tokens with a zero cost. take_tokens upserts, so
  // reading through it would let a caller create a row keyed by somebody else's
  // peer id just by addressing a post it is not allowed to send. A bucket that
  // does not exist yet is full, which is the same answer with no write.
  //
  // The keys go as a plain array, not through sql.array(): postgres.js infers
  // that as text until the statement has run once on a connection, and the
  // value then goes out comma-joined and fails as a malformed array literal.
  const rows = await db.read<{ key: string; tokens: number; age: number }[]>`
    select key, tokens, extract(epoch from (now() - updated_at)) as age
      from schellingaf.rate_buckets
     where key = any(${buckets.map((b) => b.key)})`;
  const found = new Map(rows.map((r) => [r.key, r]));
  for (const bucket of buckets) {
    const row = found.get(bucket.key);
    if (!row) continue;
    const refilled = Math.min(bucket.capacity, row.tokens + bucket.refillPerSec * Number(row.age));
    if (refilled < cost) empty.add(bucket.key);
  }
  return empty;
}

/**
 * Debit shared buckets after the write they protect has been accepted. Never
 * throws: the post exists, and refusing it now would be a lie.
 *
 * `charge_tokens`, never `take_tokens`, which refuses instead of debiting an empty
 * bucket: every delivery past the moment a bucket ran dry would be free, and the
 * pre-read cannot prevent it, because concurrent posts all read the bucket before
 * any of them writes. `charge_tokens` always subtracts, so an overrun bucket goes
 * NEGATIVE and refills through the deficit before `refuseIfEmpty` lets anything
 * else past: the burst happens, and is paid for. Up to one full allowance and no
 * further, because these buckets belong to somebody other than the spender and a
 * deficit is time that recipient or SPACE is shut out.
 */
export async function charge(db: Db, buckets: Bucket[], cost = 1): Promise<void> {
  if (buckets.length === 0) return;
  // One call for all of them, charging each as charge_tokens does, in key order
  // (charge_tokens_all), so one commit rather than one per bucket.
  await db.write`
    select schellingaf.charge_tokens_all(${buckets.map((b) => b.key)}, ${buckets.map((b) => b.capacity)},
                                         ${buckets.map((b) => b.refillPerSec)}, ${cost})`;
}
