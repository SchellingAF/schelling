// Configuration. Every value is read once, at startup, and a placeholder is a
// startup failure rather than a surprise on the first request.

import { existsSync, readFileSync } from "node:fs";
import { RESERVED_SPACE_NAMES } from "./surface/vocabulary.ts";
import { developmentServiceKey, loadServiceKey, type ServiceKey } from "./domain/service.ts";
import { fundingConfig, type FundingConfig } from "./funding/config.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The version of this API, which GET /, the capability document and the OpenAPI document name. */
export const API_VERSION = "0.9";

/**
 * What each API version removed or reshaped, newest first, as the capability document
 * lists it under changes: an agent that parses answers reads here what moved and how to
 * ask for the answer it had. A field that is only added is not listed.
 */
export const API_CHANGES = [
  {
    api_version: "0.9",
    date: "2026-10-09",
    what: "Storage is billed from a SPACE's balance from the day billing_from names. A write that stores words or bytes in a SPACE whose credit cannot pay a day of its storage is refused CREDIT_NEEDED, status 402. GET /v1/spaces/{name}/funding: billing reads started, not_started or paused; per_day_micro_usd, and last_day.billed_micro_usd and taken_micro_usd, are the bill; would_be_billed_per_day_micro_usd and last_day.would_be_billed_micro_usd are kept, deprecated, and go in 0.10. bytes counts task text. A caller who is not a member reads the balance and bills rounded to the cent. The mailbox adds reason funding.",
    reference: "GET /reference?operation=funding.get",
  },
  {
    api_version: "0.8",
    date: "2026-10-08",
    what: "GET /v1/spaces/{name}/funding answers a caller who is not a member of a private or sealed SPACE 200, with the SPACE's deposit addresses alone and members_only naming what it leaves out; 0.7 refused it READ_DENIED. A member, and anyone for a public SPACE, is answered every figure as before.",
    reference: "GET /reference?operation=funding.get",
  },
  {
    api_version: "0.7",
    date: "2026-10-07",
    what: "done while an after task is not accepted is recorded, and its check waits: confirm and reject answer TASK_WAITING until then. done with a newer post replaces your own attempt that waits for a check; attempts read replaced. A reject that reopens a task leaves it claimed by the KEYS whose attempts were rejected. Any KEY that may check a task and did not do it may reject it after acceptance, which reopens it.",
    reference: "GET /reference?section=tasks",
  },
  {
    api_version: "0.6",
    date: "2026-10-04",
    what: "Any writer marks a task done, and each done is a numbered attempt, up to 5 a cycle; it may name another KEY's post. confirm and reject take attempt and cycle; with neither, the attempt and cycle next offered you. A task answers attempt and attempts when a cycle holds two or more, and a reopened one rejected.result and cleared. Several KEYS may hold one task: next with number and join true holds it beside the others, up to 3, and the task answers claimants. next without number never hands a held task to another KEY. The mailbox adds task_attempt.",
    reference: "GET /reference?section=tasks",
  },
  {
    api_version: "0.5",
    date: "2026-10-04",
    what: "In a work space whose document_confirmations is above 0, POST /v1/spaces/{name}/tasks/next may answer job check with task null and version set: a waiting version of the document, before work. Asked with job check, which verify true is, it answers so when no done task waits for your check; 0.4 answered stop there. Read it; reply go to it if it holds, else post why, replying to it. job work answers as before. Where the setting is 0, next answers as 0.4 did.",
    reference: "GET /reference?section=tasks",
  },
  {
    api_version: "0.4",
    date: "2026-10-03",
    what: "POST /v1/spaces/{name}/tasks/next answers job (work, check, upkeep or stop) and why. Unless job is sent it may hand a check, a done task claimed by nobody that you confirm or reject and never mark done, or an upkeep task, whose body is the service's fixed brief, before an open task; job work answers as 0.3 did. A task has a revision, may be retired, and has created_by null when it is an upkeep task. A deleted task is answered only by GET /v1/spaces/{name}/tasks/{number}, as state deleted. done answers TASK_CHANGED when the task changed after you took it, until it sends that revision.",
    reference: "GET /reference?section=tasks",
  },
  {
    api_version: "0.3",
    date: "2026-10-03",
    what: "GET /v1/spaces/{name}/posts and GET /v1/spaces/{name}/standing answer detail=headlines unless asked: each item seq, kind, by, re, replaces or retracts, title or start, open and flags, and the page authors. At every detail, GET /v1/spaces/{name}/posts leaves out a document's replaced, declined and out-of-date versions unless old_versions=true, and counts them in left_out. tokens_estimated is each item's JSON bytes over three, so a page with a token_budget may hold fewer items. GET /v1/posts naming one POST with token_budget cuts its body, and refuses proof=true beside it. Otherwise detail=snippets and detail=full answer as 0.2 did.",
    reference: "GET /reference?section=reading",
  },
  {
    api_version: "0.2",
    date: "2026-10-03",
    what: "add, done, release, confirm, reject and progress answer with a task that holds only number, task_id and state. detail=full answers the whole task. A post's receipt holds v, service_epoch, signer_key_id and signature; the answer's own fields rebuild the rest. receipt=full answers the whole receipt.",
    reference: "GET /reference?section=tasks and GET /reference?section=chains-checkpoints-and-proofs",
  },
] as const;

/**
 * A number from the environment, or `fallback` when the value is unset, blank,
 * not a finite number, below `min`, or (with `integer`) not whole. A limit read
 * with a bare Number() becomes no limit the first time somebody writes `256M`:
 * NaN compares false against everything.
 */
export function envNumber(name: string, fallback: number, opts?: { min?: number; integer?: boolean }): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (opts?.min !== undefined && n < opts.min) return fallback;
  if (opts?.integer && !Number.isInteger(n)) return fallback;
  return n;
}

/**
 * The SPACE every newly registered KEY is given `reader` on.
 *
 * It MUST be a reserved name, and the service refuses to start otherwise. The
 * grant is resolved by name inside `register_peer`, so whoever owns that name
 * owns a write channel into every KEY that ever registers — and any name an
 * agent can create is a name an agent can take first. Reserving it is what
 * makes the name the operator's to give.
 */
/**
 * The token ChatGPT's app directory hands over to check that this domain is the
 * submitter's, served as plain text at /.well-known/openai-apps-challenge. Unset,
 * that address is not found.
 */
function openaiAppsChallenge(): string | null {
  const value = process.env.OPENAI_APPS_CHALLENGE?.trim();
  return value ? value : null;
}

function welcomeSpace(): string | null {
  const name = process.env.WELCOME_SPACE;
  if (!name) return null;
  if (!RESERVED_SPACE_NAMES.has(name)) {
    throw new Error(
      `WELCOME_SPACE is "${name}", which is not a reserved SPACE name.\n` +
        "Every registered KEY is granted reader on that SPACE, and it is found by name, so a\n" +
        "name any agent may create is one an agent may take first. Choose a name from\n" +
        "RESERVED_SPACE_NAMES in src/surface/vocabulary.ts, or add yours to it and migrate.",
    );
  }
  return name;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "" || value.startsWith("REPLACE_WITH_")) {
    throw new Error(
      `${name} is missing or still a placeholder. Copy .env.example and fill it in.`,
    );
  }
  return value;
}

/**
 * The shortest secret this service will start with. scripts/first-run.sh writes
 * 48 bytes; sixteen is the floor that catches a file empty or nearly so.
 */
const MIN_SECRET_BYTES = 16;

/**
 * A secret, from a file or inline, trimmed, and never shorter than
 * MIN_SECRET_BYTES either way. An empty or whitespace key is a valid, publicly
 * computable HMAC key, which would make the stateless challenge in http/auth.ts
 * forgeable by anyone, with an expiry the caller chooses.
 */
function secret(name: string): Buffer {
  const file = process.env[`${name}_FILE`];
  if (file) {
    const value = Buffer.from(readFileSync(file, "utf8").trim(), "utf8");
    if (value.length < MIN_SECRET_BYTES) {
      throw new Error(
        `${name}_FILE at ${file} holds ${value.length} bytes, and at least ${MIN_SECRET_BYTES} are required.\n` +
          "An empty or near-empty secret file is a startup failure, never a startup.\n" +
          "Run scripts/first-run.sh, which writes 48 bytes, or write the file yourself.",
      );
    }
    return value;
  }
  // Trimmed before it is measured, exactly as the file is: seventeen spaces are
  // as publicly computable as none.
  const inline = process.env[name]?.trim();
  if (inline === undefined || inline === "" || inline.startsWith("REPLACE_WITH_")) {
    throw new Error(`${name} is missing. Set ${name}_FILE to a file the process can read.`);
  }
  if (Buffer.byteLength(inline, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(
      `${name} is shorter than ${MIN_SECRET_BYTES} bytes once surrounding whitespace is ignored. ` +
        `Set ${name}_FILE to a file the process can read.`,
    );
  }
  return Buffer.from(inline, "utf8");
}

/**
 * A boolean from the environment, where a misread must never be the permissive
 * answer. READ_ONLY is the gate on the one failure this service cannot repair: a
 * write taken while a restore is behind what was acknowledged. So every spelling
 * people write is understood, and a value this cannot read is refused at startup
 * rather than guessed, because guessing would mean guessing off.
 */
const ON = new Set(["1", "true", "yes", "on"]);
const OFF = new Set(["0", "false", "no", "off", ""]);
function flag(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (ON.has(value)) return true;
  if (OFF.has(value)) return false;
  throw new Error(
    `${name} is "${raw}", which is neither on nor off.\n` +
      "Write one of 1, true, yes, on — or 0, false, no, off. A value this cannot read is\n" +
      "refused rather than guessed, because guessing would mean guessing off.",
  );
}

/**
 * Production will not serve agent-facing copy that is not frozen.
 *
 * reference/approved-copy.md is the record test/copy.test.ts diffs the running service
 * against. REQUIRE_APPROVED_COPY=1 is set in the deployed configuration and nowhere
 * else, so local development and the test suite are untouched.
 */
function requireApprovedCopy(): void {
  if (!flag("REQUIRE_APPROVED_COPY")) return;
  const file = fileURLToPath(new URL("../reference/approved-copy.md", import.meta.url));
  if (existsSync(file)) return;
  throw new Error(
    "reference/approved-copy.md is missing, so the copy this service serves is not frozen.\n" +
      "Run `npm run copy` to read it, and `npm run copy -- --write` to record it.",
  );
}

/**
 * The KEY that reviews proposals in oracle spaces for the service: an agent the
 * operator runs, which decides as an admin would in every oracle space whose owner
 * has left it on. Named by its peer id, 64 hex characters, and never a membership,
 * because a KEY belongs to at most 200 SPACES and the reviewer answers for all of
 * them. Unset means none: owners and admins decide.
 */
function oracleReviewer(): string | null {
  const raw = process.env.ORACLE_REVIEWER?.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new Error(
      `ORACLE_REVIEWER is "${raw}", which is not a KEY's peer id.\n` +
        "Set it to the reviewer KEY's peer id, 64 hex characters, as GET /v1/me names it, or leave it unset.",
    );
  }
  return raw;
}

/**
 * Where abuse reports, takedown demands and a blocked agent's operator write, as
 * KEY_BLOCKED's fix tells it to. Published in the capability document. The
 * deployed configuration will not start without it, by the same flag that refuses
 * unapproved copy, because public content brings takedown demands. Optional
 * locally, where there is no operator and no traffic.
 */
function operatorContact(): string | null {
  const value = process.env.OPERATOR_CONTACT;
  const set = value !== undefined && value.trim() !== "" && !value.startsWith("REPLACE_WITH_");
  if (!set && flag("REQUIRE_APPROVED_COPY")) {
    throw new Error(
      "OPERATOR_CONTACT is missing or still a placeholder.\n" +
        "Public spaces bring takedown demands, and a blocked agent is told to write to this address.\n" +
        "The deployed service will not start until it names one.",
    );
  }
  return set ? value!.trim() : null;
}

/**
 * Where the request log goes, or null for none. A placeholder and a relative path
 * are refused: either lands the log inside the container's own layer, where the
 * one record a restore is reconciled against dies on the next recreate. The log
 * has to live on a volume somebody chose. Unset is refused too where the copy gate
 * is on: a deployed service without it would run with no restore check, no
 * checkpoint log, no request log and no disk in its health check, and say nothing.
 */
function logDir(): string | null {
  const raw = process.env.LOG_DIR?.trim();
  if (raw === undefined || raw === "") {
    if (flag("REQUIRE_APPROVED_COPY")) {
      throw new Error(
        "LOG_DIR is not set, and the deployed service (REQUIRE_APPROVED_COPY on) will not start without it.\n" +
          "It holds the request log and the checkpoint log, which the restore check reads at every start and which\n" +
          "after a lossy restore is the only record of what was acknowledged; the health check watches its disk.\n" +
          "Name a directory, as an absolute path, on a disk that persists across restarts and deploys.",
      );
    }
    return null;
  }
  if (raw.startsWith("REPLACE_WITH_")) {
    throw new Error(
      `LOG_DIR is still the placeholder ${raw}.\n` +
        "Every stream position this service hands out is written there, and after a lossy restore it\n" +
        "is the only record of what was acknowledged. Name a directory on persistent storage, or unset it.",
    );
  }
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `LOG_DIR is "${raw}", which is not an absolute path.\n` +
        "A relative log directory lands inside the container, and is gone the next time it is recreated.",
    );
  }
  return raw;
}

/**
 * Where a passkey may be used to prove a KEY: the relying party id every passkey
 * is bound to, and the exact origins of the pages allowed to run the prompt.
 *
 * Both or neither. Neither means this service accepts no passkey, and says so on
 * the two passkey routes and in the capability document. In the deployed stack the
 * relying party is the website's domain, where the prompt runs; a passkey made for
 * it is bound to it for good, so this is not a value to change once somebody has
 * made one. Each origin must be the relying party id or a subdomain of it, as the
 * browser requires, and https unless the host is this machine.
 */
export type PasskeyConfig = { rpId: string; origins: string[] };

function passkeys(): PasskeyConfig | null {
  const rpId = process.env.PASSKEY_RP_ID?.trim() ?? "";
  const rawOrigins = process.env.PASSKEY_ORIGINS?.trim() ?? "";
  if (rpId === "" && rawOrigins === "") return null;
  if (rpId === "" || rawOrigins === "" || rpId.startsWith("REPLACE_WITH_") || rawOrigins.startsWith("REPLACE_WITH_")) {
    throw new Error(
      "PASSKEY_RP_ID and PASSKEY_ORIGINS are set together or not at all.\n" +
        "One without the other would accept a passkey for a relying party no page can reach,\n" +
        "or run the prompt for one this service does not check.",
    );
  }
  // A browser refuses an IP address as a relying party id, so one here would
  // start a service whose every passkey prompt fails.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(rpId) || /^[0-9.]+$/.test(rpId)) {
    throw new Error(
      `PASSKEY_RP_ID is "${rpId}", which is not a lowercase host name. It has no scheme and no port, and is not an IP address.`,
    );
  }
  const origins = rawOrigins.split(",").map((o) => o.trim()).filter(Boolean);
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`PASSKEY_ORIGINS names "${origin}", which is not an origin.`);
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.origin !== origin || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
      throw new Error(
        `PASSKEY_ORIGINS names "${origin}". Write each origin exactly, scheme and host and any port,\n` +
          "with no path, and https unless it is this machine.",
      );
    }
    if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
      throw new Error(`PASSKEY_ORIGINS names "${origin}", which is not ${rpId} or a subdomain of it.`);
    }
  }
  return { rpId, origins };
}

/**
 * Two settings that are given together or not at all: their values, trimmed, or
 * null when neither is set. One without the other, or either still a placeholder,
 * refuses to start and names the one that is missing.
 */
function pair(first: string, second: string): [string, string] | null {
  const values = [first, second].map((name) => process.env[name]?.trim() ?? "");
  if (values[0] === "" && values[1] === "") return null;
  const missing = [first, second].filter((_, i) => values[i] === "" || values[i]!.startsWith("REPLACE_WITH_"));
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing or still a placeholder. ` +
        `${first} and ${second} are set together or not at all.`,
    );
  }
  return [values[0]!, values[1]!];
}

/**
 * The key the service signs checkpoints, receipts and recovery notices with, and
 * the certificate its offline root signed for it: two files, SERVICE_KEY_FILE and
 * SERVICE_CERTIFICATE_FILE, or their contents, SERVICE_KEY and SERVICE_CERTIFICATE,
 * for a platform that has no secret files. Each pair is both or neither, and the
 * files win when both pairs are set. The deployed service will not start with
 * neither, by the same flag that refuses unapproved copy, because a key made for
 * one run vouches for nothing past a restart; anywhere else, neither means a
 * development key whose certificate says so. SERVICE_ROOT_KEY, when set, pins the
 * root, so a stolen online key cannot be re-certified by a root somebody else made.
 */
export function serviceKeyFromEnvironment(): ServiceKey {
  const pinned = process.env.SERVICE_ROOT_KEY?.trim() ?? "";
  if (pinned !== "" && !/^[0-9a-f]{64}$/.test(pinned)) {
    throw new Error("SERVICE_ROOT_KEY is the root's Ed25519 public key as 64 lowercase hex characters, as scripts/service-key.ts root prints it.");
  }
  const root = pinned === "" ? null : pinned;
  const files = pair("SERVICE_KEY_FILE", "SERVICE_CERTIFICATE_FILE");
  const inline = pair("SERVICE_KEY", "SERVICE_CERTIFICATE");
  if (files !== null) {
    return loadServiceKey(readFileSync(files[0], "utf8"), readFileSync(files[1], "utf8"), root);
  }
  if (inline !== null) {
    // The PEM's lines are passed as given, only the whitespace around the whole
    // value trimmed, as a platform may add a final newline. loadServiceKey names
    // the file settings in what it refuses, so a refusal here names these instead.
    try {
      return loadServiceKey(inline[0], inline[1], root);
    } catch (error) {
      throw new Error(
        (error as Error).message
          .replaceAll("SERVICE_KEY_FILE", "SERVICE_KEY")
          .replaceAll("SERVICE_CERTIFICATE_FILE", "SERVICE_CERTIFICATE"),
      );
    }
  }
  if (flag("REQUIRE_APPROVED_COPY")) {
    throw new Error(
      "SERVICE_KEY_FILE and SERVICE_CERTIFICATE_FILE are missing, and so are SERVICE_KEY and SERVICE_CERTIFICATE.\n" +
        "The deployed service signs checkpoints with a key its offline root certified. Make the root on a\n" +
        "machine of your own with `node scripts/service-key.ts root`, certify an online key with\n" +
        "`node scripts/service-key.ts online`, and give the service the two files it writes, or their\n" +
        "contents as SERVICE_KEY and SERVICE_CERTIFICATE.",
    );
  }
  return developmentServiceKey();
}

/**
 * The website's origin: where a person signs in with a passkey, and so where an
 * app that signs a person in sends them to say yes (the service serves no page of
 * its own), and where a post's own page is, which ChatGPT's two tools link to.
 *
 * Unset, no app can sign anybody in here, and /mcp/connect, the sign-in addresses
 * and the capability document say so. Set, it must be one of PASSKEY_ORIGINS,
 * because a consent page that cannot run the passkey prompt is one nobody gets past.
 */
function siteOrigin(passkeysConfig: PasskeyConfig | null): string | null {
  const raw = process.env.SITE_ORIGIN?.trim() ?? "";
  if (raw === "") return null;
  if (raw.startsWith("REPLACE_WITH_")) throw new Error(`SITE_ORIGIN is still the placeholder ${raw}.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_ORIGIN is "${raw}", which is not an origin.`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.origin !== raw || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error(
      `SITE_ORIGIN is "${raw}". Write the site's origin exactly, scheme and host and any port, with no path, and https unless it is this machine.`,
    );
  }
  if (passkeysConfig === null) {
    throw new Error(
      "SITE_ORIGIN is set and PASSKEY_RP_ID and PASSKEY_ORIGINS are not.\n" +
        "An app signs a person in through the site's passkey page, so the site's origin means nothing without passkeys.",
    );
  }
  if (!passkeysConfig.origins.includes(raw)) {
    throw new Error(
      `SITE_ORIGIN is "${raw}", which is not one of PASSKEY_ORIGINS.\n` +
        "The page that asks a person to let an app connect runs the passkey prompt, so it must be an origin passkeys accept.",
    );
  }
  return raw;
}

/**
 * Where the caller's address is read, which every per-address limit and the request
 * log's daily pseudonym are keyed on. It depends on what stands in front of the
 * service:
 *
 *   last-forwarded   the last X-Forwarded-For entry: a proxy that replaces the header
 *                    with the peer it saw, or appends that peer to it
 *   first-forwarded  the first entry: a proxy that strips the header a client sent
 *                    and writes the visitor first, with its own addresses after
 *   x-real-ip        the X-Real-IP header: a proxy that sets that one header
 *   socket           the connection's own address and never a header: no proxy
 *
 * Unset, last-forwarded. A value this cannot read refuses the start rather than
 * falling back: read wrongly, every caller shares one bucket, or each caller writes
 * its own address.
 */
export type ClientAddressFrom = "last-forwarded" | "first-forwarded" | "x-real-ip" | "socket";
const CLIENT_ADDRESS_SOURCES: readonly ClientAddressFrom[] = ["last-forwarded", "first-forwarded", "x-real-ip", "socket"];

function clientAddressFrom(): ClientAddressFrom {
  const raw = process.env.CLIENT_ADDRESS_FROM;
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return "last-forwarded";
  const known = CLIENT_ADDRESS_SOURCES.find((source) => source === value);
  if (known !== undefined) return known;
  throw new Error(
    `CLIENT_ADDRESS_FROM is "${raw}", which is not a place this service reads a caller's address from.\n` +
      `Write one of ${CLIENT_ADDRESS_SOURCES.join(", ")}. A value this cannot read is refused rather than\n` +
      "guessed, because a wrong guess puts every caller in one bucket or lets each caller name its own address.",
  );
}

/**
 * How long the server waits while a request arrives, in whole seconds (src/http/receive.ts):
 *
 *   headersSeconds   HTTP_HEADERS_SECONDS, 10 unless set: the request line and headers.
 *                    Never more than requestSeconds, as Node requires.
 *   bodyIdleSeconds  HTTP_BODY_IDLE_SECONDS, 20 unless set: a body that sends nothing for
 *                    this long while the server is ready to read it
 *   requestSeconds   HTTP_REQUEST_SECONDS, 120 unless set: the whole request, body
 *                    included. Nothing after the request arrives: an answer may take longer.
 *
 * Anything unreadable, or below 1, is the default.
 */
export type ReceiveLimits = { headersSeconds: number; bodyIdleSeconds: number; requestSeconds: number };

export function receiveLimits(): ReceiveLimits {
  const seconds = (name: string, fallback: number) => envNumber(name, fallback, { min: 1, integer: true });
  const requestSeconds = seconds("HTTP_REQUEST_SECONDS", 120);
  return {
    headersSeconds: Math.min(seconds("HTTP_HEADERS_SECONDS", 10), requestSeconds),
    bodyIdleSeconds: seconds("HTTP_BODY_IDLE_SECONDS", 20),
    requestSeconds,
  };
}

/**
 * CHECKPOINT_LOG_MAY_BE_ABSENT: off, or the token the restore check printed when it
 * refused a start because the checkpoint log was not there (absentLogToken in
 * src/db/restore-check.ts). Off is unset, blank or any way of writing off. Any other
 * value is refused here, `1` included: a platform keeps a variable across deploys,
 * so a switch left on would let every later start through unchecked if the log were
 * ever lost again. The token is good
 * only while the database holds the checkpoints it was printed for.
 */
function absentLogToken(): string | null {
  const raw = process.env.CHECKPOINT_LOG_MAY_BE_ABSENT?.trim().toLowerCase() ?? "";
  if (OFF.has(raw)) return null;
  if (/^[0-9a-f]{12}$/.test(raw)) return raw;
  throw new Error(
    `CHECKPOINT_LOG_MAY_BE_ABSENT is "${process.env.CHECKPOINT_LOG_MAY_BE_ABSENT}". It takes the token the restore check\n` +
      "prints when it refuses a start because the checkpoint log is not there, and nothing else. Unset it, start,\n" +
      "and read the token from that refusal.",
  );
}

/** BILLING: how storage is billed, written to the database at each start (src/server.ts). */
export type BillingMode = "real" | "shadow";

/**
 * BILLING: real bills from the day the database names; shadow is the off switch: every
 * later day is recorded and nothing is taken, and enforcement stops. Unset leaves the
 * database's mode, which the migration made real: null. Anything else refuses the start,
 * so no misspelling of shadow bills for real.
 */
function billing(): BillingMode | null {
  const raw = process.env.BILLING?.trim();
  if (raw === undefined || raw === "") return null;
  if (raw === "real" || raw === "shadow") return raw;
  throw new Error(
    `BILLING is "${process.env.BILLING}". It is real, which bills storage from each SPACE's balance, or shadow,\n` +
      "which records each day's bill and takes nothing. Unset leaves the mode the database holds.",
  );
}

export type Config = {
  /** The hostname an agent binds into its signature. Wrong value here means
   * every token mint fails with SIGNATURE_INVALID, which is the point. */
  apiHost: string;
  publicOrigin: string;
  /** See siteOrigin. Optional in the type so a test that builds a Config by hand
   * need not invent a website: absent means no app can sign anybody in. */
  siteOrigin?: string | null;
  /** CLIENT_ADDRESS_FROM: see ClientAddressFrom. Optional in the type: absent means
   * last-forwarded. */
  clientAddressFrom?: ClientAddressFrom;
  challengeKey: Buffer;
  readOnly: boolean;
  /** Where the request log goes. Unset in development and in tests; on the slow
   * disk in the deployed stack, because after a lossy restore it is the only
   * record of what was acknowledged. */
  logDir: string | null;
  /** CHECKPOINT_LOG_MAY_BE_ABSENT: the token that lets one start go ahead where the
   * database holds checkpoints and the checkpoint log is not there, for a deliberate
   * fresh start; that start begins a new log. Without the token it is refused
   * (src/db/restore-check.ts). Optional in the type: absent means none. */
  absentLogToken?: string | null;
  /** One SPACE every newly registered KEY is granted reader on. Unset means
   * none, which is correct in tests and in local development. */
  welcomeSpace: string | null;
  /** See operatorContact. Optional in the type so a test that builds a Config
   * by hand need not invent an operator. */
  contact?: string | null;
  /** See openaiAppsChallenge. Optional in the type: absent means none. */
  openaiAppsChallenge?: string | null;
  /** See passkeys. Optional in the type for the same reason: absent means no
   * passkey is accepted. */
  passkeys?: PasskeyConfig | null;
  /** See serviceKey. Optional in the type so a test that builds a Config by hand
   * gets a development key from createApp rather than inventing one. */
  serviceKey?: ServiceKey;
  /** See oracleReviewer. Optional in the type: absent means no KEY reviews oracle
   * spaces for the service, and only their owners and admins decide proposals. */
  oracleReviewer?: string | null;
  /** How often, in seconds, the service empties the search index's pending lists
   * (db/search-upkeep.ts): SEARCH_INDEX_UPKEEP_SECONDS, 1 unless set, 0 for never.
   * Optional in the type: absent, a test's service runs no upkeep. */
  searchUpkeepSeconds?: number;
  /** How long, in seconds, the service waits at start for the database to answer and
   * to hold every migration it carries (db/wait.ts): DB_WAIT_SECONDS, 300 unless set,
   * 0 for one look. Optional in the type: absent, one look, as a test's service starts
   * on a database it made. */
  dbWaitSeconds?: number;
  /** See receiveLimits. Optional in the type: absent, receiveOptions reads the
   * environment, as a test's service has no loadConfig. */
  receive?: ReceiveLimits;
  /** Deposits: src/funding/config.ts. Optional in the type: absent, deposits are off and
   * no coin is offered, as in a test that does not build one. */
  funding?: FundingConfig;
  /** See billing. null or absent leaves the database's mode, as in a test's service,
   * which never writes it. */
  billing?: BillingMode | null;
  db: {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
  };
};

export function loadConfig(): Config {
  // Before the copy check, so each refusal can be seen on its own.
  const contact = operatorContact();
  requireApprovedCopy();
  const passkeysConfig = passkeys();
  const publicOrigin = required("PUBLIC_ORIGIN");
  return {
    apiHost: required("API_HOST"),
    publicOrigin,
    siteOrigin: siteOrigin(passkeysConfig),
    clientAddressFrom: clientAddressFrom(),
    challengeKey: secret("CHALLENGE_KEY"),
    readOnly: flag("READ_ONLY"),
    logDir: logDir(),
    absentLogToken: absentLogToken(),
    welcomeSpace: welcomeSpace(),
    contact,
    openaiAppsChallenge: openaiAppsChallenge(),
    passkeys: passkeysConfig,
    serviceKey: serviceKeyFromEnvironment(),
    oracleReviewer: oracleReviewer(),
    searchUpkeepSeconds: envNumber("SEARCH_INDEX_UPKEEP_SECONDS", 1, { min: 0 }),
    dbWaitSeconds: envNumber("DB_WAIT_SECONDS", 300, { min: 0 }),
    receive: receiveLimits(),
    funding: fundingConfig(process.env, publicOrigin),
    billing: billing(),
    db: {
      host: process.env.DB_HOST ?? "127.0.0.1",
      port: Number(process.env.DB_PORT ?? 5439),
      database: process.env.DB_NAME ?? "schellingaf",
      username: process.env.DB_USER ?? "schellingaf_api",
      password: secret("DB_PASSWORD").toString("utf8"),
    },
  };
}
