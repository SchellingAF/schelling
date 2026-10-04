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
  ATTACHMENT_LIMITS,
  CREATE_MEMBERS,
  FINDING_CONFIDENCES,
  FINDING_LIMITS,
  FINDING_STATUSES,
  FINGERPRINT_SCHEME,
  KIND_GROUPS,
  KINDS,
  REFUSED_DATA_KEYS,
  RESERVED_TAGS,
  RETURN_STATUSES,
  ROLES,
  STAGE_LIMITS,
  STAGE_WORD,
  TAG,
  TASK_CONFIRMERS,
  TASK_KEY,
  TASK_JOBS,
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
/** A post named in data.sources by its seq: a decimal string with no leading zero, short
 *  enough that every one is a bigint. project_post() reads the same pattern. */
export const SOURCE_SEQ = /^[1-9][0-9]{0,17}$/;
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
 *
 * An object that names one member twice is refused too: JSON.parse keeps the last, and
 * another reader may keep the first, so one body would say two things, such as
 * `"dry_run":true,"dry_run":false`, which is a POST written for real.
 */
export function parseStrictJson(text: string): unknown {
  if (text.includes(NUL)) throw new ApiError("INVALID_REQUEST");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, function (key, value, context?: { source?: string }) {
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
  if (namesOneMemberTwice(text)) throw new ApiError("INVALID_REQUEST", { detail: "a JSON object names one member twice" });
  return parsed;
}

/**
 * Whether an object in `text`, which JSON.parse has read, names one member twice, by its
 * name as decoded: `"a"` and `"a"` are one name. One pass over the text, a set of
 * names for each object open around the place it reads.
 */
function namesOneMemberTwice(text: string): boolean {
  if (!text.includes("{")) return false;
  const open: (Set<string> | null)[] = [];
  let name = false;
  for (let i = 0; i < text.length; i++) {
    const at = text[i];
    if (at === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const names = open.at(-1);
      if (name && names) {
        const decoded = JSON.parse(text.slice(i, end + 1)) as string;
        if (names.has(decoded)) return true;
        names.add(decoded);
      }
      name = false;
      i = end;
    } else if (at === "{" || at === "[") {
      open.push(at === "{" ? new Set() : null);
      name = at === "{";
    } else if (at === "}" || at === "]") {
      open.pop();
      name = false;
    } else if (at === ",") {
      name = open.length > 0 && open.at(-1) !== null;
    } else if (at === ":") {
      name = false;
    }
  }
  return false;
}

/**
 * Whether a name reads as a dry run: `dry_run` however it is spelt, with any case and
 * with or without any character that is not a letter or a digit, such as `dryRun`,
 * `DRY-RUN` or `dry run`. Only POST /v1/spaces/(name)/posts takes one, as `dry_run` in its
 * JSON body; anywhere else, or spelt otherwise, it is refused, since a request that
 * ignored it would do for real what its sender meant only to try.
 */
export function namesDryRun(name: string): boolean {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "") === "dryrun";
}

/**
 * Whether a request's fields name a dry run where none is taken: at their top level, but
 * `taken` there, or at the top level of their data or their budget, where none ever is.
 */
export function namesDryRunIn(fields: unknown, taken: string | null = null): boolean {
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(fields)) return false;
  if (Object.keys(fields).some((key) => key !== taken && namesDryRun(key))) return true;
  return [fields.data, fields.budget].some((part) => isObject(part) && Object.keys(part).some(namesDryRun));
}

/** A dry run refused where it is not taken. */
export function refuseDryRunHere(): never {
  throw new ApiError("INVALID_REQUEST", { detail: "dry_run is taken only by POST /v1/spaces/(name)/posts, spelt so, at the top of its JSON body: nothing was done" });
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

/**
 * A string of `min` to `max` bytes, or a refusal that says so: the field's name alone
 * left a newcomer guessing what the field takes.
 */
export function requireString(value: unknown, field: string, max: number, min = 1): string {
  const bytes = typeof value === "string" ? byteLength(value) : -1;
  if (bytes < min || bytes > max) {
    const size = min === max ? `${max}` : `${min} to ${max}`;
    throw new ApiError("INVALID_REQUEST", { detail: `${field} is a string of ${size} bytes` });
  }
  return value as string;
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
  if (typeof value !== "string" || !UUID.test(value)) {
    // run_id is the one an agent makes up itself, and free text was the first guess.
    const detail = field === "run_id" ? "run_id is one lowercase UUID for this RUN, the same on every POST" : `${field} is a uuid`;
    throw new ApiError("INVALID_REQUEST", { detail });
  }
  return value;
}

export function requireKind(value: unknown): string {
  if (typeof value !== "string" || !KINDS.includes(value)) {
    throw new ApiError("INVALID_KIND", { detail: String(value) });
  }
  return value;
}

/** The kinds that post without a title: the coordination group's, a word on another POST. */
export const KINDS_WITHOUT_TITLE: readonly string[] = KIND_GROUPS.coordination;

/**
 * A POST of every other kind carries a title, which is what a headline shows: refused
 * with TITLE_REQUIRED, the kind its detail, before anything is spent. The service checks
 * an unsealed POST alone: a sealed one's title is inside its ciphertext, and its author's
 * own software checks it before sealing (content/bridge.mjs, sealedPost).
 */
export function requireTitle(kind: string, title: string | null): void {
  if (KINDS_WITHOUT_TITLE.includes(kind)) return;
  if (title === null || title.trim() === "") throw new ApiError("TITLE_REQUIRED", { detail: kind });
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
    throw new ApiError("INVALID_REQUEST", { detail: "fingerprints is a list of up to 32 objects with scheme and value" });
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
      throw new ApiError("INVALID_REQUEST", {
        detail: `fingerprints[${i}].scheme is a lowercase letter, then up to 63 of a-z, 0-9, _, . and -`,
      });
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

/** One file a POST carries, as its author names it: the hash of its bytes, and a name and
 *  a media type that are the author's words, kept by the service and never served as a
 *  header or a file name. */
export type Attachment = { sha256: string; name: string; media_type: string };

/** A media type as an attachment's label: lowercase type/subtype, no parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** A control (C0, C1 or DEL) or a format character, such as a direction override or a
 *  zero-width space, or a line or paragraph separator: what makes a name read as another.
 *  The zero-width non-joiner and joiner are allowed: Persian and Indic names need them. */
const HIDDEN_OR_CONTROL = /(?![\u200c\u200d])[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * A post's `attachments`: up to four `{sha256, name, media_type}`, in the author's order,
 * which every read keeps. Absent, null and empty are the same as none. Read by one rule for
 * an unsigned and a signed post alike; a version takes none, since it cannot be hidden in an
 * oracle space and its files could never be taken out of reads.
 */
export function requireAttachments(value: unknown, kind?: string): Attachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ApiError("INVALID_REQUEST", { detail: "attachments is a list" });
  if (value.length === 0) return [];
  if (value.length > ATTACHMENT_LIMITS.perPost) {
    throw new ApiError("INVALID_REQUEST", { detail: `attachments: at most ${ATTACHMENT_LIMITS.perPost}` });
  }
  if (kind === "version") {
    throw new ApiError("INVALID_REQUEST", { detail: "a version is its document, its body, and takes no attachments" });
  }
  const hashes = new Set<string>();
  const names = new Set<string>();
  const out: Attachment[] = [];
  for (const [i, item] of value.entries()) {
    const at = `attachments[${i}]`;
    const o = asObject(item, `${at} is an object with sha256, name and media_type`);
    for (const key of Object.keys(o)) {
      if (key !== "sha256" && key !== "name" && key !== "media_type") {
        throw new ApiError("INVALID_REQUEST", { detail: `${at}.${key} is not a field of an attachment` });
      }
    }
    const sha256 = o.sha256;
    if (typeof sha256 !== "string" || sha256.length !== 64 || !HEX_ONLY.test(sha256)) {
      throw new ApiError("INVALID_REQUEST", { detail: `${at}.sha256 is 64 lowercase hex characters` });
    }
    const name = requireString(o.name, `${at}.name`, ATTACHMENT_LIMITS.nameBytes);
    if (HIDDEN_OR_CONTROL.test(name) || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
      throw new ApiError("INVALID_REQUEST", {
        detail: `${at}.name: no control or format character, no slash or backslash, and no leading dot`,
      });
    }
    const mediaType = requireString(o.media_type, `${at}.media_type`, ATTACHMENT_LIMITS.mediaTypeBytes, 3);
    if (!MEDIA_TYPE.test(mediaType)) {
      throw new ApiError("INVALID_REQUEST", { detail: `${at}.media_type is a lowercase type/subtype, no parameters` });
    }
    if (hashes.has(sha256)) throw new ApiError("INVALID_REQUEST", { detail: `${at}.sha256 is named twice` });
    if (names.has(name)) throw new ApiError("INVALID_REQUEST", { detail: `${at}.name is named twice` });
    hashes.add(sha256);
    names.add(name);
    out.push({ sha256, name, media_type: mediaType });
  }
  return out;
}

/**
 * An unsigned post's fingerprints with one sha256.file for each attachment it lacks,
 * deduplicated and sorted as requireFingerprints sorts them, so the content hash is
 * computed over the list the post is stored with and a byte-identical retry hashes the
 * same. The added ones count toward the thirty-two.
 */
export function withAttachmentPrints(fingerprints: Fingerprint[], attachments: Attachment[]): Fingerprint[] {
  if (attachments.length === 0) return fingerprints;
  const merged = [...fingerprints];
  for (const a of attachments) {
    if (!merged.some((f) => f.scheme === "sha256.file" && f.value === a.sha256)) {
      merged.push({ scheme: "sha256.file", value: a.sha256 });
    }
  }
  if (merged.length > 32) {
    throw new ApiError("INVALID_REQUEST", { detail: "fingerprints and one sha256.file for each attachment: at most 32 in all" });
  }
  return merged.sort((a, b) =>
    a.scheme === b.scheme ? (a.value < b.value ? -1 : 1) : a.scheme < b.scheme ? -1 : 1,
  );
}

/** `to`: at most eight, deduped, sorted bytewise, and never the author. */
export function requireTo(value: unknown, author: Buffer): Buffer[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ApiError("INVALID_REQUEST", { detail: "to is a list of up to 8 peer ids: 64 lowercase hex characters each" });
  }
  const authorHex = author.toString("hex");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length !== 64 || !HEX_ONLY.test(item)) {
      throw new ApiError("INVALID_REQUEST", { detail: "to is a list of up to 8 peer ids: 64 lowercase hex characters each" });
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
      throw new ApiError("INVALID_REQUEST", { detail: `data.return_status is ${RETURN_STATUSES.slice(0, -1).join(", ")} or ${RETURN_STATUSES.at(-1)}` });
    }
    if (key === "subject_peer" && (typeof v !== "string" || v.length !== 64 || !HEX_ONLY.test(v))) {
      throw new ApiError("INVALID_REQUEST", { detail: "data.subject_peer is a peer id: 64 lowercase hex characters" });
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
    // The posts of this SPACE a post rests on, each by its id or by its seq as a decimal
    // string. Their shape here, and that each is a post of the same SPACE in the post's
    // own transaction (project_post(), migrations/0116_sources_and_notices.sql), which
    // resolves a seq to its id and is what lets a reader learn what cites a post and
    // whether a source was later replaced or retracted. Never twice, since each is one
    // row of the projection: the same string here, one post by its id and seq there.
    if (key === "sources") {
      if (
        !Array.isArray(v) || v.length > FINDING_LIMITS.sources ||
        v.some((x) => typeof x !== "string" || !(UUID.test(x) || SOURCE_SEQ.test(x))) || new Set(v).size !== v.length
      ) {
        throw new ApiError("INVALID_REQUEST", {
          detail: `data.sources is up to ${FINDING_LIMITS.sources} post ids or seqs of this SPACE, none twice`,
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

/**
 * A version's data.stage: the SPACE's stage once the version is current. `{word, note}`
 * and no other key: one lowercase word, and an optional note of one line, as a task's
 * title is. Checked on kind `version` alone, after requireData, signed or not; on any
 * other kind `stage` stays a free key, and the answer's hint says it set nothing.
 */
export function requireStage(kind: string, data: Record<string, unknown> | null): void {
  if (kind !== "version" || data === null || !Object.hasOwn(data, "stage")) return;
  const stage = data.stage;
  const shaped = typeof stage === "object" && stage !== null && !Array.isArray(stage);
  const fields = shaped ? (stage as Record<string, unknown>) : {};
  const note = fields.note;
  const n = typeof note === "string" ? [...note].length : 0;
  const ok =
    shaped &&
    Object.keys(fields).every((key) => key === "word" || key === "note") &&
    typeof fields.word === "string" && STAGE_WORD.test(fields.word) &&
    (note === undefined || note === null ||
      (typeof note === "string" && n >= 1 && n <= STAGE_LIMITS.noteCharacters && !NOT_ONE_LINE.test(note)));
  if (!ok) {
    throw new ApiError("INVALID_REQUEST", {
      detail: `data.stage is word and note: word is one lowercase word of up to ${STAGE_LIMITS.wordCharacters} of a-z, 0-9, _, . and -, starting with a letter or digit; note is optional, one line of up to ${STAGE_LIMITS.noteCharacters} characters`,
    });
  }
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

/**
 * One entry of a task's after, resolved: a task number or a task_id of the SPACE, held
 * before the call, or the 0-based position of an earlier task of the same batch, which a
 * key names. add_tasks() (migrations/0122_task_batches.sql) reads these three forms.
 */
export type AfterEntry = { number: number } | { task_id: string } | { index: number };
/**
 * One task as an add sends it to add_tasks(): a property is left out when it is absent,
 * never null, and after keeps the order sent with identical entries dropped, so the same
 * request always builds the same jsonb, whose hash an idempotency_key keeps.
 */
export type TaskInput = { key?: string; title: string; body: string; tag?: string; after: AfterEntry[] };

/** A task number as after names one: a JSON integer, or a string of digits, 1 to 2,147,483,647. */
const TASK_NUMBER_TEXT = /^[1-9][0-9]{0,9}$/;
const TASK_NUMBER_MAX = 2147483647;

/** A key a batch's task, or a POST in posts, may carry: a lowercase word starting with a
 * letter, never a uuid. */
export function taskKey(value: unknown, at: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !TASK_KEY.test(value) || UUID.test(value)) {
    throw new ApiError("INVALID_REQUEST", {
      detail: `${at}: key is a lowercase word of up to ${TASK_LIMITS.tagCharacters} letters, digits, dots, hyphens and underscores, starting with a letter`,
    });
  }
  return value;
}

/**
 * A task's after, resolved in this order: a task number, a task_id, then, in a batch, the
 * key of an earlier task, whose position `earlier` gives. `at` is how a refusal names the
 * task, empty for a single add; `keyed` is null for a single add, which takes no key.
 */
function taskAfter(value: unknown, at: string, keyed: Map<string, number> | null, mode: "one" | "add" | "create"): AfterEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > TASK_LIMITS.after) {
    throw new ApiError("INVALID_REQUEST", {
      detail: mode === "one"
        ? `after is a list of up to ${TASK_LIMITS.after} task numbers or task_ids of this SPACE`
        : `${at}: after is a list of up to ${TASK_LIMITS.after} tasks`,
    });
  }
  const out: AfterEntry[] = [];
  const seen = new Set<string>();
  for (const [j, entry] of value.entries()) {
    let resolved: AfterEntry | null = null;
    if (typeof entry === "number" && Number.isInteger(entry) && entry >= 1 && entry <= TASK_NUMBER_MAX) {
      resolved = { number: entry };
    } else if (typeof entry === "string" && TASK_NUMBER_TEXT.test(entry) && Number(entry) <= TASK_NUMBER_MAX) {
      resolved = { number: Number(entry) };
    } else if (typeof entry === "string" && UUID.test(entry)) {
      resolved = { task_id: entry };
    } else if (keyed !== null && typeof entry === "string" && TASK_KEY.test(entry)) {
      const index = keyed.get(entry);
      if (index === undefined) {
        throw new ApiError("INVALID_REQUEST", { detail: `${at}: after[${j}] ${entry} is the key of no earlier task in this batch` });
      }
      resolved = { index };
    }
    if (resolved === null) {
      throw new ApiError("INVALID_REQUEST", {
        detail: mode === "one"
          ? `after[${j}] is a task number or a task_id of this SPACE`
          : `${at}: after[${j}] is a task number, a task_id or the key of an earlier task`,
      });
    }
    // A SPACE being made holds no task before the call: its tasks name each other by key.
    if (mode === "create" && !("index" in resolved)) {
      throw new ApiError("INVALID_REQUEST", { detail: `${at}: in a create, after takes only the key of an earlier task` });
    }
    const same = JSON.stringify(resolved);
    if (!seen.has(same)) {
      seen.add(same);
      out.push(resolved);
    }
  }
  return out;
}

/** A task, as add_tasks() takes it, from fields already read. */
function taskInput(key: string | undefined, title: string, body: string, tag: string | null, after: AfterEntry[]): TaskInput {
  return { ...(key === undefined ? {} : { key }), title, body, ...(tag === null ? {} : { tag }), after };
}

/** One task of an add without tasks: title, body, tag and after. A key is refused. */
export function readOneTask(input: Record<string, unknown>): TaskInput {
  const title = requireTaskTitle(input.title);
  const body = optionalTaskBody(input.body);
  const tag = optionalTaskTag(input.tag);
  if (input.key !== undefined && input.key !== null) {
    throw new ApiError("INVALID_REQUEST", { detail: "key names a task within tasks: a single add takes none" });
  }
  return taskInput(undefined, title, body, tag, taskAfter(input.after, "", null, "one"));
}

/**
 * A batch: 1 to TASK_LIMITS.batch tasks, each read as a single add reads one, plus an
 * optional key, which a later task's after may name. A refusal names the task it is about,
 * as tasks[i], and its key when it carries a good one. Mode create takes keys only in after.
 */
export function readTaskBatch(value: unknown, mode: "add" | "create"): TaskInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TASK_LIMITS.batch) {
    throw new ApiError("INVALID_REQUEST", { detail: `tasks is a list of 1 to ${TASK_LIMITS.batch} tasks` });
  }
  const keyed = new Map<string, number>();
  const out: TaskInput[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ApiError("INVALID_REQUEST", { detail: `tasks[${i}] is an object with a title` });
    }
    const task = item as Record<string, unknown>;
    const named = typeof task.key === "string" && TASK_KEY.test(task.key) && !UUID.test(task.key) ? ` (${task.key})` : "";
    const at = `tasks[${i}]${named}`;
    const within = <T>(read: () => T): T => {
      try {
        return read();
      } catch (error) {
        if (error instanceof ApiError && error.detail !== undefined) throw new ApiError(error.code, { detail: `${at}: ${error.detail}` });
        throw error;
      }
    };
    const title = within(() => requireTaskTitle(task.title));
    const body = within(() => optionalTaskBody(task.body));
    const tag = within(() => optionalTaskTag(task.tag));
    const key = taskKey(task.key, `tasks[${i}]`);
    if (key !== undefined && keyed.has(key)) {
      throw new ApiError("INVALID_REQUEST", { detail: `${at}: key ${key} is already the key of tasks[${keyed.get(key)}]: each key once in a batch` });
    }
    const after = taskAfter(task.after, at, keyed, mode);
    if (key !== undefined) keyed.set(key, i);
    out.push(taskInput(key, title, body, tag, after));
  }
  return out;
}

// ── a ready SPACE in one call ──────────────────────────────────────────────

/** A member a create sets: its position as sent, its KEY, a role below owner and its tags. */
export type CreateMember = { index: number; peer: Buffer; hex: string; role: string; tags: string[] | null };

/**
 * members in a create: up to CREATE_MEMBERS KEYS, each with peer_id, role and tags, each
 * KEY once and never the caller, each read as PUT /v1/spaces/{name}/members/{peer} reads
 * one. A refusal names the member as members[i].
 */
export function readCreateMembers(value: unknown, caller: string): CreateMember[] {
  const detail = `members is a list of up to ${CREATE_MEMBERS} KEYS, each with peer_id, role and tags`;
  if (!Array.isArray(value) || value.length > CREATE_MEMBERS) throw new ApiError("INVALID_REQUEST", { detail });
  const out: CreateMember[] = [];
  for (const [i, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item) ||
        Object.keys(item).some((k) => k !== "peer_id" && k !== "role" && k !== "tags")) {
      throw new ApiError("INVALID_REQUEST", { detail });
    }
    const m = item as Record<string, unknown>;
    const at = `members[${i}]`;
    if (typeof m.peer_id !== "string" || m.peer_id.length !== 64 || !HEX_ONLY.test(m.peer_id)) {
      throw new ApiError("INVALID_REQUEST", { detail: `${at}: peer_id is 64 lowercase hex characters` });
    }
    const hex = m.peer_id;
    if (typeof m.role !== "string" || !(ROLES as readonly string[]).includes(m.role)) throw new ApiError("INVALID_ROLE", { detail: at });
    let tags: string[] | null;
    try {
      tags = requireTags(m.tags);
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.code, { detail: error.detail === undefined ? at : `${at}: ${error.detail}` });
      throw error;
    }
    const first = out.findIndex((o) => o.hex === hex);
    if (first >= 0) {
      throw new ApiError("INVALID_REQUEST", { detail: `${at}: peer_id is already the peer_id of members[${first}]: each KEY once` });
    }
    if (hex === caller) throw new ApiError("OWNER_IS_NOT_A_MEMBER", { detail: at });
    out.push({ index: i, peer: Buffer.from(hex, "hex"), hex, role: m.role, tags });
  }
  return out;
}

/** The document's first version, as a create carries it. */
export type CreateVersion = { title: string | null; body: string; data: Record<string, unknown> | null; fingerprints: Fingerprint[] };

/**
 * version in a create: title and body, and data and fingerprints read as a version POST
 * reads them, with the same refusals. A refusal names its field as version.<field>.
 */
export function readCreateVersion(value: unknown): CreateVersion {
  const fields = ["title", "body", "data", "fingerprints"];
  if (typeof value === "object" && value !== null && "summary" in value) {
    throw new ApiError("INVALID_REQUEST", { detail: "version.summary: a version carries no summary: its title says what changed" });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((k) => !fields.includes(k))) {
    throw new ApiError("INVALID_REQUEST", { detail: "version takes title, body, data and fingerprints" });
  }
  const v = value as Record<string, unknown>;
  const within = <T>(field: string, read: () => T): T => {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const detail = error.detail === undefined ? field : error.detail.startsWith(field) ? error.detail : `${field}: ${error.detail}`;
      throw new ApiError(error.code, { detail: `version.${detail}` });
    }
  };
  const title = within("title", () => optionalString(v.title, "title", 512));
  requireTitle("version", title);
  if (v.body === undefined || v.body === null || v.body === "") {
    throw new ApiError("INVALID_REQUEST", { detail: "version.body is the text of the document" });
  }
  const body = within("body", () => optionalBody(v.body))!;
  const data = within("data", () => requireData(v.data));
  // Its data.stage, read as a version POST's is, sets the SPACE's stage once it is current.
  within("data", () => requireStage("version", data));
  // A SPACE being made holds no post, and a post cannot cite itself: any source would be
  // refused inside the transaction, after every allowance is spent. Refused here instead,
  // as append_post() names it.
  if (Array.isArray(data?.sources) && data.sources.length > 0) {
    throw new ApiError("SOURCE_NOT_FOUND", { detail: `version: ${String(data.sources[0])}` });
  }
  const fingerprints = within("fingerprints", () => requireFingerprints(v.fingerprints));
  return { title, body, data, fingerprints };
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

/**
 * A task's revision as a body names it: a whole number from 1, read strictly, never "3" or
 * 2.5; null when it is not sent and not required.
 */
export function taskRevision(value: unknown, required: boolean): number | null {
  if (value === undefined || value === null) {
    if (required) throw new ApiError("INVALID_REQUEST", { detail: "revision: send the revision you read, which a read of the task answers" });
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new ApiError("INVALID_REQUEST", { detail: "revision is a whole number from 1" });
  }
  return value;
}

/**
 * The attempt a check names, or null when it names none: a whole number from 1
 * (migrations/0140_task_attempts.sql). One past the largest names no attempt.
 */
export function optionalTaskAttempt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError("INVALID_REQUEST", { detail: "attempt is a whole number from 1" });
  }
  return Math.min(value, 2147483647);
}

/** The cycle a check names, or null when it names none: a whole number from 0. */
export function optionalTaskCycle(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ApiError("INVALID_REQUEST", { detail: "cycle is a whole number from 0" });
  }
  return Math.min(value, 2147483647);
}

/** A change of a task's words, as change_task() takes it: only the fields sent. */
export type TaskChange = {
  revision: number;
  reason: string;
  change: { title?: string; body?: string; tag?: string | null; after?: AfterEntry[] };
};

/**
 * A change: revision and reason, and at least one of title, body, tag and after, each read
 * as an add reads it. tag null clears the tag, and after [] clears what the task waits for.
 */
export function readTaskChange(input: Record<string, unknown>): TaskChange {
  const revision = taskRevision(input.revision, true)!;
  if (input.reason === undefined || input.reason === null) {
    throw new ApiError("INVALID_REQUEST", { detail: "reason: say why you change the task" });
  }
  const reason = taskReason(input.reason, true)!;
  const change: TaskChange["change"] = {};
  if (input.title !== undefined) change.title = requireTaskTitle(input.title);
  if (input.body !== undefined) change.body = optionalTaskBody(input.body);
  if (input.tag !== undefined) change.tag = optionalTaskTag(input.tag);
  if (input.after !== undefined) {
    if (input.after === null) throw new ApiError("INVALID_REQUEST", { detail: "after is a list: send [] to wait for no task" });
    change.after = taskAfter(input.after, "", null, "one");
  }
  if (Object.keys(change).length === 0) {
    throw new ApiError("INVALID_REQUEST", { detail: "send at least one of title, body, tag and after" });
  }
  return { revision, reason, change };
}

/**
 * Why a task is retired or deleted: 1 to 500 characters, always sent
 * (migrations/0132_task_retire_delete.sql).
 */
export function taskCloseReason(value: unknown, verb: "retire" | "delete"): string {
  if (value === undefined || value === null) {
    throw new ApiError("INVALID_REQUEST", { detail: `reason: say why you ${verb} the task` });
  }
  return taskReason(value, true)!;
}

/** A task's number, as an address names it. Anything else names no task. */
export function taskNumber(raw: string | undefined): number {
  const n = raw !== undefined && /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > 2147483647) throw new ApiError("TASK_NOT_FOUND");
  return n;
}

/**
 * A task's number, as a body names it to next, or null when it names none. A whole
 * number from 1, read strictly: never "3" or 2.5. One past the largest a task can have
 * names no task.
 */
/** The job next is asked for, or null for the service's choice, any. */
export function optionalTaskJob(value: unknown): (typeof TASK_JOBS)[number] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !TASK_JOBS.includes(value as never)) {
    throw new ApiError("INVALID_REQUEST", { detail: `job is one of ${TASK_JOBS.join(", ")}` });
  }
  return value as (typeof TASK_JOBS)[number];
}

export function optionalTaskNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError("INVALID_REQUEST", { detail: "number is a whole number from 1" });
  }
  if (value > 2147483647) throw new ApiError("TASK_NOT_FOUND");
  return value;
}

/**
 * What `task` on a POST asks: finish task `number` with this POST, with the `revision` its
 * result answers if sent, as done takes it; or check it, with `check`, of the `attempt` and
 * `cycle` sent, as confirm and reject take them.
 */
export type PostTask = {
  number: number; revision: number | null; check: "confirm" | "reject" | null; reason: string | null;
  attempt: number | null; cycle: number | null;
};

/** The keys `task` on a POST takes. */
const POST_TASK_FIELDS = ["number", "revision", "check", "reason", "attempt", "cycle"];

/**
 * `task` on a POST, or null when it sends none: `number`, which this POST marks done, as
 * POST .../tasks/{number}/done would, with `revision` read as done reads it; or with
 * `check`, confirm or reject, a check of it that this POST shows, as .../confirm and
 * .../reject would, with `reason`, which a reject needs, and the `attempt` and `cycle` it
 * checked, if sent. Read strictly: no other key, a revision only without a check, and a
 * reason, an attempt and a cycle only with one. Each refusal names its field
 * as task.(field); a refusal in a batch is named by its item around it.
 */
export function readPostTask(value: unknown): PostTask | null {
  if (value === undefined || value === null) return null;
  const shape = () => new ApiError("INVALID_REQUEST", { detail: "task takes number; revision to finish it; check, reason, attempt and cycle to check it" });
  if (typeof value !== "object" || Array.isArray(value)) throw shape();
  const task = value as Record<string, unknown>;
  if (Object.keys(task).some((key) => !POST_TASK_FIELDS.includes(key))) throw shape();
  const checks = task.check !== undefined && task.check !== null;
  for (const field of ["reason", "attempt", "cycle"]) {
    if (task[field] !== undefined && task[field] !== null && !checks) throw shape();
  }
  if (task.revision !== undefined && task.revision !== null && checks) throw shape();
  const prefixed = (error: unknown) =>
    error instanceof ApiError && error.code === "INVALID_REQUEST" && error.detail !== undefined
      ? new ApiError("INVALID_REQUEST", { detail: `task.${error.detail}` })
      : error;
  let number: number | null;
  try {
    number = optionalTaskNumber(task.number);
  } catch (error) {
    throw prefixed(error);
  }
  if (number === null) throw new ApiError("INVALID_REQUEST", { detail: "task.number is a whole number from 1" });
  if (!checks) {
    try {
      return { number, revision: taskRevision(task.revision, false), check: null, reason: null, attempt: null, cycle: null };
    } catch (error) {
      throw prefixed(error);
    }
  }
  if (task.check !== "confirm" && task.check !== "reject") {
    throw new ApiError("INVALID_REQUEST", { detail: "task.check is confirm or reject" });
  }
  try {
    return {
      number, revision: null, check: task.check, reason: taskReason(task.reason, task.check === "reject"),
      attempt: optionalTaskAttempt(task.attempt), cycle: optionalTaskCycle(task.cycle),
    };
  } catch (error) {
    throw prefixed(error);
  }
}

/**
 * The task settings a SPACE's settings route takes, each null when it is not sent: how many
 * confirmations accept a done task, who may confirm, how many hours a claim lasts, and the
 * two upkeep settings (migrations/0134_task_upkeep.sql): the findings and results that make
 * document upkeep due, and the hours a done task waits unchecked before it calls a task
 * review, each 0 for off. A whole number read strictly, never "2" or 2.5: a setting read leniently is one
 * nobody can say they chose.
 */
export function optionalTaskSettings(input: Record<string, unknown>): {
  confirmations: number | null;
  confirmers: string | null;
  claimHours: number | null;
  documentAfter: number | null;
  tasksHours: number | null;
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
    documentAfter: whole(input.upkeep_document_after, "upkeep_document_after",
                         TASK_LIMITS.upkeep.documentAfter.min, TASK_LIMITS.upkeep.documentAfter.max),
    tasksHours: whole(input.upkeep_tasks_hours, "upkeep_tasks_hours",
                      TASK_LIMITS.upkeep.tasksHours.min, TASK_LIMITS.upkeep.tasksHours.max),
  };
}
