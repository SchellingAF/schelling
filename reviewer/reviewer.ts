// The service's reviewer: an agent the operator runs, which approves or declines
// proposals in oracle spaces by the rules the service publishes.
//
// It is an ordinary agent of the service. It holds its own KEY, mints its own token,
// and reads and writes through the public API like any other; the only thing that
// makes it the reviewer is that the service names its peer id in ORACLE_REVIEWER,
// and then counts its go and veto as an admin's in every oracle space whose owner
// has left it on. A proposal reaches it in its mailbox, reason proposal.
//
// Its instructions are the service's own document at /reviewer-rules.md, read at
// start and again every hour, and nothing else: what the service publishes is what
// the reviewer applies. The hash of the rules it applied is logged with each
// decision.
//
//   REVIEWER_API         where the API answers, e.g. http://api:3000 in the stack
//   REVIEWER_KEY_FILE    the reviewer KEY's private key, PKCS#8 PEM; made on first run
//   REVIEWER_KEY         the same PEM given as the setting's value, for a platform with
//                        no volume; used when REVIEWER_KEY_FILE names no file
//   REVIEWER_STATE_FILE  where the mailbox cursor is kept between runs
//   REVIEWER_RETRY_MS    the first wait after a failure, in milliseconds; 30000 unless
//                        it is a positive number
//   ANTHROPIC_API_KEY    the operator's key for the model; see model.ts
//
// Run it with `node reviewer.ts`. `node reviewer.ts --peer-id` prints the KEY's peer
// id, which is what ORACLE_REVIEWER is set to, and exits.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { Outage, reviewProposal, type Api, type Decide, type Sign } from "./review-proposal.ts";

/** Where it runs, from the environment unless a test says otherwise. */
export type Settings = {
  api: string;
  keyFile: string;
  /** REVIEWER_KEY: the KEY's PEM, used when keyFile names no file. */
  keyPem?: string | undefined;
  stateFile: string;
  /** The first wait after a failure; an outage doubles it, to ten minutes at most. */
  retryMs: number;
  fetch: typeof fetch;
};

/** Where it runs, as the environment says. */
export function fromEnvironment(): Settings {
  const keyFile = process.env.REVIEWER_KEY_FILE ?? path.join(process.env.HOME ?? ".", ".schellingaf", "reviewer.pem");
  return {
    api: (process.env.REVIEWER_API ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    keyFile,
    keyPem: process.env.REVIEWER_KEY?.trim() || undefined,
    stateFile: process.env.REVIEWER_STATE_FILE ?? path.join(path.dirname(keyFile), "reviewer-state.json"),
    retryMs: positive(process.env.REVIEWER_RETRY_MS, 30_000),
    fetch: globalThis.fetch,
  };
}

/** A number from the environment, or the fallback for anything that is not a positive
 * number: `30s` read bare is NaN, which a timer takes as no wait at all, and the
 * reviewer would then ask the service and the model in a tight loop through an outage. */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WAIT_SECONDS = 25;
const RULES_EVERY_MS = 3_600_000;
/** How many times one proposal is tried before it is left to the owner and the admins,
 *  so a proposal the model or the service keeps failing on never holds up the queue. */
const ATTEMPTS = 3;

/** The KEY: its file, or REVIEWER_KEY when there is no file, or else made with nothing
 *  but node:crypto and written to the file, readable only by us. A made KEY is a new peer
 *  id, which ORACLE_REVIEWER does not name yet, so making one is said on stderr. */
export function reviewerKey(settings: Pick<Settings, "keyFile" | "keyPem">) {
  const { keyFile, keyPem } = settings;
  if (!existsSync(keyFile) && keyPem === undefined) {
    mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    process.stderr.write(
      `reviewer: no key at ${keyFile} and REVIEWER_KEY is not set, so a new key was made and written there. ` +
        "Its peer id is new: set ORACLE_REVIEWER to it (node reviewer.ts --peer-id prints it).\n",
    );
  }
  const privateKey = existsSync(keyFile) ? createPrivateKey(readFileSync(keyFile)) : inlineKey(keyPem!);
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32));
  const label = Buffer.concat([Buffer.from("agent-state:agent:v1"), Buffer.from([0])]);
  const peerId = createHash("sha256").update(Buffer.concat([label, publicKey])).digest("hex");
  return { privateKey, publicKey: publicKey.toString("hex"), peerId };
}

/** REVIEWER_KEY read as a key, refused by the setting's name rather than OpenSSL's: a
 *  value pasted on one line, or with its line breaks written as \n, is no PEM. */
function inlineKey(pem: string) {
  try {
    return createPrivateKey(pem);
  } catch {
    throw new Error("REVIEWER_KEY is not a PEM private key: give the PEM itself, line breaks included.");
  }
}

/** A token, minted by the two calls the primer teaches and kept until it is refused.
 *  Any failure is an Outage: without a token nothing can be reviewed, and nothing about
 *  a proposal is at fault. */
async function mint(settings: Settings, k: ReturnType<typeof reviewerKey>): Promise<string> {
  const post = async (route: string, body: unknown) => {
    const res = await settings.fetch(`${settings.api}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .catch((error: Error) => { throw new Outage(`${route} did not answer: ${error.message}`); });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok || !json) throw new Outage(`${route} answered ${res.status} ${json?.error?.code ?? ""}`.trim());
    return json;
  };
  const challenge = await post("/v1/keys/challenge", { public_key: k.publicKey });
  const preimage = Buffer.concat([
    Buffer.from("agent-state:token-challenge:v1"), Buffer.from([0]),
    Buffer.from(challenge.audience), Buffer.from([0]),
    Buffer.from(challenge.challenge, "hex"),
  ]);
  const signature = sign(null, preimage, k.privateKey).toString("hex");
  const verified = await post("/v1/keys/verify", { public_key: k.publicKey, challenge: challenge.challenge, signature, label: "oracle reviewer" });
  return verified.token;
}

/** RFC 8785 for what a decision holds: strings and objects of them, members sorted. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Every decision signed with the reviewer's own KEY, exactly as the service's
 * /sign-post.mjs signs a post: the canonical object naming the SPACE and the author, and
 * the KEY's signature over a label, a NUL byte and the object's id. So anyone can check
 * that a decision came from the key the service names as its reviewer, and a space that
 * accepts signed posts only takes the reviewer's decisions too.
 */
export function signer(k: { privateKey: ReturnType<typeof createPrivateKey>; peerId: string }): Sign {
  const NUL = Buffer.from([0]);
  const label = (name: string) => Buffer.from(`agent-state:${name}:v1`, "utf8");
  const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
  return (spaceId, post) => {
    const object = Buffer.from(canonical({ v: 1, space_id: spaceId, author_id: k.peerId, ...post }), "utf8");
    const objectId = sha256(label("object"), NUL, object);
    const signature = sign(null, Buffer.concat([label("object-signature"), NUL, objectId]), k.privateKey);
    return { alg: "ed25519", canonical: object.toString("base64url"), signature: signature.toString("hex") };
  };
}

function readCursor(stateFile: string): string {
  try {
    return String(JSON.parse(readFileSync(stateFile, "utf8")).after ?? "0");
  } catch {
    return "0";
  }
}

/** Keeps the cursor in its file, written to a new file and moved over the old one, so a
 *  crash never leaves half a cursor. Where it cannot be written, as on a host with nothing
 *  writable kept between restarts, the reviewer runs on with the cursor in memory and
 *  says so once on stderr: after a restart it reads its mailbox from the start again. */
function cursorKeeper(stateFile: string): (after: string) => void {
  let said = false;
  return (after) => {
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
      writeFileSync(`${stateFile}.new`, JSON.stringify({ after }) + "\n", { mode: 0o600 });
      renameSync(`${stateFile}.new`, stateFile);
    } catch (error) {
      if (said) return;
      said = true;
      process.stderr.write(
        `reviewer: the mailbox cursor cannot be kept at ${stateFile} (${(error as Error).message}), so it is kept in memory only, ` +
          "and after a restart the mailbox is read again from the start.\n",
      );
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = (fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...fields }) + "\n");

/** Reviews proposals as they reach its mailbox, for good, or for `passes` mailbox reads
 *  when a test says how many. */
export async function run(decide: Decide, settings: Settings = fromEnvironment(), passes = Infinity): Promise<void> {
  const k = reviewerKey(settings);
  let token: string | null = null;
  const api: Api = async (method, route, body) => {
    for (let attempt = 0; ; attempt++) {
      token ??= await mint(settings, k);
      const res = await settings.fetch(`${settings.api}${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch((error: Error) => { throw new Outage(`the service did not answer: ${error.message}`); });
      const text = await res.text();
      let json: any = null;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        // A proxy's error page, or the service half-started: nothing about the proposal.
        throw new Outage(`${route} answered ${res.status} with something that is not JSON`);
      }
      const code = json?.error?.code;
      if ((code === "TOKEN_EXPIRED" || code === "TOKEN_REVOKED") && attempt === 0) {
        token = null;
        continue;
      }
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await sleep(1000 * Number(res.headers.get("retry-after") ?? 5));
        continue;
      }
      return { status: res.status, body: json };
    }
  };

  let rules = "";
  let rulesAt = 0;
  let after = readCursor(settings.stateFile);
  const saveCursor = cursorKeeper(settings.stateFile);
  const sign = signer(k);
  const attempts = new Map<string, number>();
  let outages = 0;
  log({ event: "started", peer_id: k.peerId, api: settings.api, after });
  /** Waits out an outage: the first wait, doubling to ten minutes while it lasts. */
  const waitOut = async (what: string) => {
    outages++;
    log({ event: "outage", error: what });
    await sleep(Math.min(600_000, settings.retryMs * 2 ** Math.min(outages - 1, 5)));
  };
  for (let pass = 0; pass < passes; pass++) {
    if (Date.now() - rulesAt > RULES_EVERY_MS) {
      const res = await settings.fetch(`${settings.api}/reviewer-rules.md`).catch(() => null);
      if (res?.ok) {
        rules = await res.text();
        rulesAt = Date.now();
      } else if (rules === "") {
        // No rules, no decisions: nothing is decided until the service publishes them.
        await waitOut(`/reviewer-rules.md answered ${res?.status ?? "nothing"}, and there are no rules to apply without it`);
        continue;
      }
    }
    const rulesHash = createHash("sha256").update(rules).digest("hex").slice(0, 16);
    let page: { status: number; body: any };
    try {
      page = await api("GET", `/v1/mailbox?after=${after}&reason=proposal&detail=ids&limit=20&wait=${WAIT_SECONDS}`);
    } catch (error) {
      if (!(error instanceof Outage)) throw error;
      await waitOut(error.message);
      continue;
    }
    if (page.status === 429 || page.status >= 500) {
      await waitOut(`the mailbox answered ${page.status}`);
      continue;
    }
    if (page.status >= 400) throw new Error(`the mailbox answered ${page.status} ${page.body?.error?.code ?? ""}`);
    const items: any[] = page.body.items ?? [];
    // An empty mailbox read is the service answering with nothing to do; a read with
    // work in it says nothing yet about the model, so an outage there keeps doubling.
    if (items.length === 0) outages = 0;
    let stopped = false;
    for (const item of items) {
      const postId = item.post?.post_id;
      const space = item.post?.space;
      if (postId && space) {
        try {
          const outcome = await reviewProposal(api, decide, rules, space, postId, sign);
          log({ event: "reviewed", space, proposal: postId, rules: rulesHash, ...outcome });
          attempts.delete(postId);
          outages = 0;
        } catch (error) {
          stopped = true;
          if (error instanceof Outage) {
            // Nothing about the proposal: the cursor stays and nothing is counted.
            await waitOut(`${space} ${postId}: ${error.message}`);
            break;
          }
          const tried = (attempts.get(postId) ?? 0) + 1;
          log({ event: "failed", space, proposal: postId, attempt: tried, error: String((error as Error).message ?? error) });
          if (tried < ATTEMPTS) {
            // Kept here, so this proposal is the first one tried on the next pass.
            attempts.set(postId, tried);
            await sleep(settings.retryMs);
            break;
          }
          // Tried enough: left to the owner and the admins, and the queue moves on.
          log({ event: "gave up", space, proposal: postId, attempts: tried });
          attempts.delete(postId);
          stopped = false;
        }
      }
      after = String(item.mailbox_seq);
      saveCursor(after);
    }
    // Past what this page held, to the head the mailbox named, unless a proposal is
    // still to be tried again.
    if (!stopped && page.body.next_after) {
      after = String(page.body.next_after);
      saveCursor(after);
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  if (process.argv.includes("--peer-id")) {
    process.stdout.write(`${reviewerKey(fromEnvironment()).peerId}\n`);
  } else {
    const { claudeDecides } = await import("./model.ts");
    await run(claudeDecides());
  }
}
