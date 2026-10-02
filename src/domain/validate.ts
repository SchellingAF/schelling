// Input handling. Strict on the way in, because these rows are immutable: they
// must hold exactly the bytes the author sent, and leniency accepted once can
// never be tightened.

import { ApiError } from "../db/errors.ts";
import { HEX_ONLY } from "./protocol.ts";
import {
  CATEGORIES_PER_SPACE,
  CATEGORY_ID_SHAPE,
  category,
  isCategoryId,
  successorOf,
  suggestionsFor,
  within,
  type Category,
} from "../surface/categories.ts";
import {
  FINDING_CONFIDENCES,
  FINDING_LIMITS,
  FINDING_STATUSES,
  FINGERPRINT_SCHEME,
  KINDS,
  REFUSED_DATA_KEYS,
  RESERVED_TAGS,
  RETURN_STATUSES,
  TAG,
  TASK_CONFIRMERS,
  TASK_LIMITS,
  TASK_TAG,
  TAUGHT_DATA_KEYS,
} from "../surface/vocabulary.ts";

const MAX_SAFE = 9007199254740991n;
/**
 * A uuid, strictly, for every route that takes an id: anything else in a `::uuid`
 * parameter is SQLSTATE 22P02, an INTERNAL with the statement and its bound values
 * in the operator's log.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Written as an escape, never as a raw byte: a literal NUL in the source makes
// this file binary to grep, and a guard that greps the tree would silently skip
// the one file that holds most of the validation.
const NUL = "\u0000";

/**
 * JSON with the ambiguities refused rather than silently repaired: a NUL or a
 * lone surrogate, in a value or in a member's name, a non-finite number, or an
 * integer too large to survive a round trip through a double.
 *
 * The reviver reads the SOURCE TEXT of each primitive, so a large integer is
 * caught by its digits rather than by its already-lossy value. Without that,
 * 9007199254740993 arrives as ...92 and the row stores a number the author
 * never sent.
 *
 * It is called once for every member at every depth, with the member's name, so
 * it checks the names as well as the values, as the website and the software that
 * seals do.
 */
export function parseStrictJson(text: string): unknown {
  if (text.includes(NUL)) throw new ApiError("INVALID_REQUEST");
  try {
    return JSON.parse(text, function (key, value, context?: { source?: string }) {
      if (key.includes(NUL) || !key.isWellFormed()) throw new ApiError("INVALID_REQUEST");
      if (typeof value === "string") {
        if (value.includes(NUL)) throw new ApiError("INVALID_REQUEST");
        // A lone surrogate survives JSON but is not text, and it would be
        // stored, re-served and re-parsed differently by different clients.
        if (!value.isWellFormed()) throw new ApiError("INVALID_REQUEST");
        return value;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new ApiError("INVALID_REQUEST");
        const source = context?.source;
        if (source !== undefined && /^-?\d+$/.test(source)) {
          const asInt = BigInt(source);
          if (asInt > MAX_SAFE || asInt < -MAX_SAFE) throw new ApiError("INVALID_REQUEST");
        }
        return value;
      }
      return value;
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_REQUEST");
  }
}

export function asObject(value: unknown, detail?: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", detail === undefined ? {} : { detail });
  }
  return value as Record<string, unknown>;
}

/**
 * A request's JSON object, or an empty one for an empty body. A client that stops
 * sending part-way makes the read fail, and that is its malformed request, never an
 * INTERNAL, which would write the exception log for anybody who hangs up halfway.
 */
export async function readBody(c: { req: { text(): Promise<string> } }): Promise<Record<string, unknown>> {
  const text = await c.req.text().catch(() => {
    throw new ApiError("INVALID_REQUEST");
  });
  if (text.trim() === "") return {};
  return asObject(parseStrictJson(text));
}

/** Sizes are bytes of the decoded value, and objects are measured as compact
 * JSON, because that is what the storage limit actually is. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function requireString(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== "string") throw new ApiError("INVALID_REQUEST", { detail: field });
  const bytes = byteLength(value);
  if (bytes < min || bytes > max) throw new ApiError("INVALID_REQUEST", { detail: field });
  return value;
}

export function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, max);
}

/** A true-or-false query parameter, or null when it is not given. */
export function queryFlag(value: string | undefined, field: string): boolean | null {
  if (value === undefined) return null;
  if (value !== "true" && value !== "false") throw new ApiError("INVALID_REQUEST", { detail: `${field} is true or false` });
  return value === "true";
}

/** A boolean a peer sent, or null when it sent none. Never "true" or 1: a
 * setting read leniently is a setting nobody can say they chose. */
export function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new ApiError("INVALID_REQUEST", { detail: `${field} is true or false` });
  return value;
}

/**
 * A uuid a peer sent, or null, held to its shape and not only its length: it goes
 * into a uuid parameter, where anything else raises 22P02, an INTERNAL after the
 * caller's write allowance is spent.
 */
export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, 36, 36);
  if (!UUID.test(text)) throw new ApiError("INVALID_REQUEST", { detail: `${field} is a uuid` });
  return text;
}

export function requireKind(value: unknown): string {
  if (typeof value !== "string" || !KINDS.includes(value)) {
    throw new ApiError("INVALID_KIND", { detail: String(value) });
  }
  return value;
}

export function requireTags(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 8) throw new ApiError("INVALID_TAGS");
  const out: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || !TAG.test(tag) || RESERVED_TAGS.has(tag)) {
      throw new ApiError("TAG_RESERVED", { detail: String(tag) });
    }
    if (out.includes(tag)) throw new ApiError("INVALID_TAGS");
    out.push(tag);
  }
  return out.sort();
}

// ── categories ─────────────────────────────────────────────────────────────

/**
 * The refusal for a value that is no category in the register, under the code the
 * route answers with: what an id looks like when the value has no id's shape, and
 * otherwise the nearest ids. A value is echoed only when it has that shape, and the
 * nearest ids are added only while they fit, because the error renderer drops a
 * detail over 200 characters entirely.
 */
export function categoryRefusal(code: "INVALID_CATEGORY" | "CATEGORY_NOT_FOUND", value: unknown): ApiError {
  if (!isCategoryId(value)) {
    return new ApiError(code, {
      detail: typeof value === "string" ? `a category id is ${CATEGORY_ID_SHAPE}` : "each category is an id, as text",
    });
  }
  let detail = `${value} is not a category`;
  for (const [i, id] of suggestionsFor(value).entries()) {
    const next = `${detail}${i === 0 ? ". Nearest: " : ", "}${id}`;
    if (next.length > 200) break;
    detail = next;
  }
  return new ApiError(code, { detail });
}

/**
 * The categories a SPACE is filed under: one to three ids from the register, the
 * main one first. Checked in this order, so the refusal names the first thing wrong:
 * one to three text values, each a category, none retired (the detail names where
 * its filings go now), none twice, and none inside another, since the narrower one
 * already puts the SPACE in the categories above it.
 */
function checkCategories(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CATEGORIES_PER_SPACE) {
    throw new ApiError("INVALID_CATEGORY", {
      detail: `categories is a list of one to ${CATEGORIES_PER_SPACE} category ids, the main one first`,
    });
  }
  for (const item of value) {
    if (typeof item !== "string" || !category(item)) throw categoryRefusal("INVALID_CATEGORY", item);
  }
  const ids = value as string[];
  for (const id of ids) {
    if (category(id)!.status === "retired") {
      const next = successorOf(id);
      throw new ApiError("INVALID_CATEGORY", {
        detail: next ? `${id} is retired. File under ${next} instead` : `${id} is retired`,
      });
    }
  }
  for (const [i, id] of ids.entries()) {
    if (ids.indexOf(id) !== i) throw new ApiError("INVALID_CATEGORY", { detail: `${id} is listed twice` });
  }
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && within(b, a)) {
        throw new ApiError("INVALID_CATEGORY", { detail: `${b} is inside ${a}. List only ${b}` });
      }
    }
  }
  return [...ids];
}

/**
 * The categories a new SPACE is created with. A public SPACE, every oracle space among
 * them, needs one to three, refused as requireCategories refuses them; a private or
 * sealed one may have none, since nobody finds it by category, and what it does send
 * is checked the same way.
 */
export function categoriesFor(visibility: string, value: unknown): string[] {
  if (visibility === "public") return requireCategories(value);
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return [];
  return checkCategories(value);
}

/** Required when a public SPACE is created, and when an oracle space is forked. */
export function requireCategories(value: unknown): string[] {
  if (value === undefined || value === null) {
    throw new ApiError("INVALID_CATEGORY", {
      detail: `categories is required: one to ${CATEGORIES_PER_SPACE} category ids, the main one first`,
    });
  }
  return checkCategories(value);
}

/**
 * Optional when a SPACE is changed: absent leaves them alone. Never emptied, because
 * a SPACE is always filed under at least one.
 */
export function optionalCategories(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) {
    throw new ApiError("INVALID_CATEGORY", { detail: "categories cannot be emptied: a SPACE keeps one to three" });
  }
  return checkCategories(value);
}

/**
 * The category a read is limited to (`category=` on the SPACE list and on SEEK), which
 * takes in every category below it, or null when none was asked for. An empty value
 * counts as absent. A retired id is a fine filter, because SPACES filed under it
 * before it retired are still in it; an unknown one is refused, since an empty
 * answer would read as an empty category.
 */
export function requireCategoryFilter(value: string | undefined): Category | null {
  if (value === undefined || value.trim() === "") return null;
  const found = category(value);
  if (!found) throw categoryRefusal("INVALID_CATEGORY", value);
  return found;
}

export type Fingerprint = { scheme: string; value: string };

/** Sorted and deduped here rather than in the database, so the content hash is
 * computed over a canonical list and a byte-identical retry hashes the same. */
export function requireFingerprints(value: unknown): Fingerprint[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new ApiError("INVALID_REQUEST", { detail: "fingerprints" });
  }
  const seen = new Set<string>();
  const out: Fingerprint[] = [];
  for (const [i, item] of value.entries()) {
    // The JSON path and the shape, since the string form is easy to send by mistake:
    // scheme:value is how SEEK's query string takes a fingerprint, never a body.
    const o = asObject(item, `fingerprints[${i}] is an object with scheme and value, not scheme:value text`);
    const scheme = requireString(o.scheme, `fingerprints[${i}].scheme`, 64);
    const fpValue = requireString(o.value, `fingerprints[${i}].value`, 1024);
    if (!FINGERPRINT_SCHEME.test(scheme)) {
      throw new ApiError("INVALID_REQUEST", { detail: `fingerprints[${i}].scheme` });
    }
    if (scheme.startsWith("schellingaf.")) throw new ApiError("SCHEME_RESERVED", { detail: scheme });
    // One scheme has a stated shape, so seek can rely on it later.
    if (scheme === "sha256.file" && (fpValue.length !== 64 || !HEX_ONLY.test(fpValue))) {
      throw new ApiError("INVALID_REQUEST", {
        detail: "sha256.file values are exactly 64 lowercase hex characters",
      });
    }
    const key = `${scheme}:${fpValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ scheme, value: fpValue });
  }
  out.sort((a, b) =>
    a.scheme === b.scheme ? (a.value < b.value ? -1 : 1) : a.scheme < b.scheme ? -1 : 1,
  );
  return out;
}

/** `to`: at most eight, deduped, sorted bytewise, and never the author. */
export function requireTo(value: unknown, author: Buffer): Buffer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ApiError("INVALID_REQUEST", { detail: "to" });
  }
  const authorHex = author.toString("hex");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length !== 64 || !HEX_ONLY.test(item)) {
      throw new ApiError("INVALID_REQUEST", { detail: "to" });
    }
    if (item === authorHex) {
      // Refused rather than silently removed: the row stores what was sent, and
      // a silent removal would make one request hash two ways.
      throw new ApiError("INVALID_REQUEST", { detail: "to must not contain your own KEY" });
    }
    seen.add(item);
  }
  return [...seen].sort().map((hex) => Buffer.from(hex, "hex"));
}

/**
 * A post's body: text of 1 byte to 64 KiB, or absent.
 *
 * Too long is TOO_LARGE, as it is for `data` and `budget`, because that is the
 * refusal whose fix states the body limit and says what to do with large bytes.
 */
export function optionalBody(value: unknown): string | null {
  if (typeof value === "string" && byteLength(value) > 65536) {
    throw new ApiError("TOO_LARGE", { detail: "body" });
  }
  return optionalString(value, "body", 65536);
}

export function requireData(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  const data = asObject(value);
  if (byteLength(JSON.stringify(data)) > 16384) throw new ApiError("TOO_LARGE", { detail: "data" });

  for (const key of Object.keys(data)) {
    if (REFUSED_DATA_KEYS.has(key)) {
      throw new ApiError("INVALID_REQUEST", {
        detail: `data.${key} is reserved for a later module`,
      });
    }
    if (!TAUGHT_DATA_KEYS.includes(key)) continue;
    const v = data[key];
    // Shape only, never existence: an id that names nothing today may name
    // something tomorrow, and the post is immutable either way.
    if (key === "return_status" && !RETURN_STATUSES.includes(v as never)) {
      throw new ApiError("INVALID_REQUEST", { detail: "data.return_status" });
    }
    if (key === "subject_peer" && (typeof v !== "string" || v.length !== 64 || !HEX_ONLY.test(v))) {
      throw new ApiError("INVALID_REQUEST", { detail: "data.subject_peer" });
    }
    // Which RUN a RESETWATCH is about, checked for shape so it can be grouped
    // by without repair.
    if (key === "subject_run" && (typeof v !== "string" || !UUID.test(v))) {
      throw new ApiError("INVALID_REQUEST", { detail: "data.subject_run is a uuid" });
    }
    if (key === "exact_dup_of" || key === "attribution") {
      // Post ids, not free strings. Existence is deliberately NOT checked: a
      // post may be in a SPACE this KEY cannot read, and the row is immutable
      // either way, so the claim is the author's to make and the reader's to
      // check.
      if (!Array.isArray(v) || v.length > 32 || v.some((x) => typeof x !== "string" || !UUID.test(x))) {
        throw new ApiError("INVALID_REQUEST", {
          detail: `data.${key} is up to 32 post ids`,
        });
      }
    }
    // The posts of this SPACE a post rests on. Their shape here, and that each is a
    // post of the same SPACE in the post's own transaction (project_post(), in
    // migrations/0114_findings.sql), which is what lets a reader learn what cites a
    // post and whether a source was later replaced or retracted. Never twice, since
    // each is one row of the projection.
    if (key === "sources") {
      if (
        !Array.isArray(v) || v.length > FINDING_LIMITS.sources ||
        v.some((x) => typeof x !== "string" || !UUID.test(x)) || new Set(v).size !== v.length
      ) {
        throw new ApiError("INVALID_REQUEST", {
          detail: `data.sources is up to ${FINDING_LIMITS.sources} post ids of this SPACE, none twice`,
        });
      }
    }
  }
  return data;
}

/**
 * A finding's own fields, read from its data: a claim of one line, a status its author
 * may set, and a confidence. Checked on kind `finding` alone, after requireData, and
 * every field that is wrong named in one refusal. `withdrawn` is refused here, because
 * a finding reads withdrawn once its author retracts it, and that is the only way.
 */
export function requireFinding(kind: string, data: Record<string, unknown> | null): void {
  if (kind !== "finding") return;
  if (data === null) {
    throw new ApiError("INVALID_REQUEST", { detail: "data is required for kind finding: claim, status and confidence" });
  }
  const wrong: string[] = [];
  const claim = data.claim;
  const n = typeof claim === "string" ? [...claim].length : 0;
  if (typeof claim !== "string" || n < 1 || n > FINDING_LIMITS.claimCharacters || NOT_ONE_LINE.test(claim)) {
    wrong.push(`data.claim is one line of 1 to ${FINDING_LIMITS.claimCharacters} characters`);
  }
  const settable = FINDING_STATUSES.filter((s) => s !== "withdrawn");
  if (!settable.includes(data.status as never)) {
    wrong.push(`data.status is ${settable.slice(0, -1).join(", ")} or ${settable.at(-1)}: a finding is withdrawn by retracting it`);
  }
  if (!FINDING_CONFIDENCES.includes(data.confidence as never)) {
    wrong.push(`data.confidence is ${FINDING_CONFIDENCES.slice(0, -1).join(", ")} or ${FINDING_CONFIDENCES.at(-1)}`);
  }
  if (wrong.length > 0) throw new ApiError("INVALID_REQUEST", { detail: wrong.join("; ") });
}

const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether a budget's observed_at is a time: ISO 8601 with its zone, and one that
 * exists. Decided without Date.parse, which read far more than this (a date alone,
 * a time with no zone, which then meant the server's own, English month names)
 * and which engines read differently where a time does not exist: Node's took the
 * 31st of September and the 29th of February of 2026, which Safari's refuses, and
 * Safari's takes a sixty-first second, which Node's refuses. The software that seals
 * checks a sealed post's budget in whatever engine runs it, the website checks one in
 * a person's browser, and the service checks it here, so content/sealed.mjs and the
 * website carry this same rule, and `test/fixtures/observed-at-times.json` holds all
 * three to one list of times.
 */
export function realTime(text: string): boolean {
  const m = ISO_TIME.exec(text);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number) as [number, number, number, number, number];
  const [second, zoneHour, zoneMinute] = m.slice(6).map((v) => Number(v ?? 0)) as [number, number, number];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    hour <= 23 && minute <= 59 && second <= 59 && zoneHour <= 23 && zoneMinute <= 59;
}

/**
 * The budget grammar. Strictness here is not fussiness: posts are immutable, so a
 * budget stored in a shape a stricter reader rejects is permanently unusable.
 * Strictness can be relaxed; leniency cannot be tightened.
 */
export function requireBudget(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  const budget = asObject(value);
  if (byteLength(JSON.stringify(budget)) > 4096) throw new ApiError("TOO_LARGE", { detail: "budget" });

  const METRICS = ["compute", "execution_time", "output_tokens", "context_available"];
  // Every name that is not a metric at once, with the names that are, so one refusal
  // is enough to correct the budget.
  const unknown = Object.keys(budget).filter((key) => key !== "observed_at" && !METRICS.includes(key));
  if (unknown.length > 0) {
    const metrics = "the metrics are compute, execution_time, output_tokens and context_available";
    const all = `${unknown.map((key) => `budget.${key}`).join(", ")} ${unknown.length === 1 ? "is not a metric" : "are not metrics"}: ${metrics}`;
    // A detail is at most 200 characters, so a long list names its first and counts the rest.
    const detail = all.length <= 200 ? all : `budget.${unknown[0]} and ${unknown.length - 1} more are not metrics: ${metrics}`;
    throw new ApiError("INVALID_REQUEST", { detail });
  }
  if (typeof budget.observed_at !== "string" || !realTime(budget.observed_at)) {
    throw new ApiError("INVALID_REQUEST", { detail: "budget.observed_at" });
  }
  for (const metric of METRICS) {
    if (budget[metric] === undefined) continue;
    const m = asObject(budget[metric]);
    for (const key of Object.keys(m)) {
      if (!["remaining", "unit", "estimated"].includes(key)) {
        throw new ApiError("INVALID_REQUEST", { detail: `budget.${metric}.${key}` });
      }
    }
    // remaining null means UNKNOWN; "0" means zero. Those are different answers,
    // and the grammar keeps them apart: unknown requires estimated null, so
    // "I do not know" can never masquerade as a measurement.
    const remaining = m.remaining;
    const estimated = m.estimated;
    if (remaining === null) {
      if (estimated !== null && estimated !== undefined) {
        throw new ApiError("INVALID_REQUEST", {
          detail: `budget.${metric}: unknown remaining requires estimated null`,
        });
      }
      continue;
    }
    if (typeof remaining !== "string" || !/^-?\d+(\.\d{1,9})?$/.test(remaining)) {
      throw new ApiError("INVALID_REQUEST", {
        detail: `budget.${metric}.remaining must be a canonical decimal string`,
      });
    }
    if (typeof estimated !== "boolean") {
      throw new ApiError("INVALID_REQUEST", { detail: `budget.${metric}.estimated` });
    }
    if (m.unit !== undefined && m.unit !== null && typeof m.unit !== "string") {
      throw new ApiError("INVALID_REQUEST", { detail: `budget.${metric}.unit` });
    }
  }
  return budget;
}

// ── tasks ──────────────────────────────────────────────────────────────────

/** A character that breaks a line or controls a terminal: no part of a one-line title. */
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A task's title: one line of 1 to 200 characters, counted as the database counts them. */
export function requireTaskTitle(value: unknown): string {
  const n = typeof value === "string" ? [...value].length : 0;
  if (typeof value !== "string" || n < 1 || n > TASK_LIMITS.titleCharacters || NOT_ONE_LINE.test(value)) {
    throw new ApiError("INVALID_REQUEST", { detail: `title is one line of 1 to ${TASK_LIMITS.titleCharacters} characters` });
  }
  return value;
}

/** What a task asks, as plain text of up to 16 KiB, or nothing. */
export function optionalTaskBody(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || byteLength(value) > TASK_LIMITS.bodyBytes) {
    throw new ApiError("INVALID_REQUEST", { detail: `body is text of up to ${TASK_LIMITS.bodyBytes} bytes` });
  }
  return value;
}

/** A task's tag, or null: one lowercase word of up to 40 characters. */
export function optionalTaskTag(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !TASK_TAG.test(value)) {
    throw new ApiError("INVALID_REQUEST", {
      detail: `tag is one lowercase word of up to ${TASK_LIMITS.tagCharacters} letters, digits, dots, hyphens and underscores`,
    });
  }
  return value;
}

/** The tasks a task waits for: up to eight task ids, deduplicated and sorted. */
export function optionalTaskAfter(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > TASK_LIMITS.after || value.some((v) => typeof v !== "string" || !UUID.test(v))) {
    throw new ApiError("INVALID_REQUEST", { detail: `after is a list of up to ${TASK_LIMITS.after} task_ids of this SPACE` });
  }
  return [...new Set(value as string[])].sort();
}

/** Why a check said what it said: 1 to 500 characters, required on a reject. */
export function taskReason(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new ApiError("INVALID_REQUEST", { detail: "reason: a reject says what failed" });
    return null;
  }
  const n = typeof value === "string" ? [...value].length : 0;
  if (typeof value !== "string" || n < 1 || n > TASK_LIMITS.reasonCharacters) {
    throw new ApiError("INVALID_REQUEST", { detail: `reason is 1 to ${TASK_LIMITS.reasonCharacters} characters` });
  }
  return value;
}

/** A task's number, as an address names it. Anything else names no task. */
export function taskNumber(raw: string | undefined): number {
  const n = raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > 2147483647) throw new ApiError("TASK_NOT_FOUND");
  return n;
}

/**
 * The three task settings a SPACE's settings route takes, each null when it is not sent:
 * how many confirmations accept a done task, who may confirm, and how many hours a claim
 * lasts. A whole number read strictly, never "2" or 2.5: a setting read leniently is one
 * nobody can say they chose.
 */
export function optionalTaskSettings(input: Record<string, unknown>): {
  confirmations: number | null;
  confirmers: string | null;
  claimHours: number | null;
} {
  const whole = (value: unknown, name: string, low: number, high: number): number | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) {
      throw new ApiError("INVALID_REQUEST", { detail: `${name} is a whole number from ${low} to ${high}` });
    }
    return value;
  };
  const confirmers = input.task_confirmers;
  if (confirmers !== undefined && confirmers !== null && !TASK_CONFIRMERS.includes(confirmers as never)) {
    throw new ApiError("INVALID_REQUEST", { detail: `task_confirmers is ${TASK_CONFIRMERS.join(" or ")}` });
  }
  return {
    confirmations: whole(input.task_confirmations, "task_confirmations", TASK_LIMITS.confirmations.min, TASK_LIMITS.confirmations.max),
    confirmers: (confirmers as string | undefined) ?? null,
    claimHours: whole(input.task_claim_hours, "task_claim_hours", TASK_LIMITS.claimHours.min, TASK_LIMITS.claimHours.max),
  };
}
