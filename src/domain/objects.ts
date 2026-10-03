// A post as an object: the bytes an author signs, and the chain every post sits in.
//
// THE OBJECT. Every post, signed or not, is one canonical JSON object (RFC 8785,
// see jcs.ts), and its object_id is the SHA-256 of the object label, a NUL and
// those bytes. The object names its SPACE by uuid and its author by peer id, so a
// signed post cannot be carried into another SPACE or claimed by another KEY
// without its id changing. It carries an idempotency_key, so two identical posts
// are two objects. A field that is absent is omitted, never null, and a list is
// sorted, so one post has exactly one object and anybody holding the post's
// fields can rebuild its bytes. A signed object must carry its idempotency_key:
// it is what keeps two identical signed posts apart, and signing publishes it.
// The object the service writes for an unsigned post never carries one, because
// that object is served to every reader and the key was never published:
//
//   {"author_id","body","fingerprints","idempotency_key","kind","private_digest",
//    "reply_to","retracts","space_id","summary","supersedes","title","to","v"}
//
//   to            peer ids, ascending, no repeats
//   fingerprints  {scheme, value}, ascending by scheme then value in code point
//                 order, which is how the database sorts them (COLLATE "C")
//
// THE PRIVATE PART. A post's budget, data and run_id are published to the members
// of its SPACE and to nobody else (see render() in src/http/postview.ts). Signing
// must not change that. So those three live in a second canonical object with 32
// random bytes of salt, and the post object carries only its digest. A reader
// outside the SPACE verifies everything it can read and that the rest is
// committed; a member verifies the rest too. The salt is what stops a reader
// guessing a budget from its digest.
//
// A SEALED POST. In a sealed SPACE the words are scrambled on the writer's machine
// (content/sealed.md), so the object carries no title, summary, body, fingerprints or
// private part: it carries `sealed`, the suite and the digests of the header and ciphertext
// the post is stored as, so a signature over the object covers those exact bytes:
//
//   {"author_id","idempotency_key","kind","reply_to","retracts","sealed","space_id",
//    "supersedes","to","v"}     sealed = {"ciphertext","header","suite"}
//
//   header      SHA-256(L("sealed-header") || header), the header digest sealing uses
//   ciphertext  SHA-256(L("sealed-ciphertext") || ciphertext)
//
// THE CHAIN. Each post's chain hash covers its SPACE, its position, the governance
// state it was admitted under, the previous post's chain hash and its object_id.
// The admission is itself a digest of the revision and that revision's control
// chain hash, because a reader outside a SPACE is shown neither: the governance
// log is its members' to read. The database computes all of this in
// append_post(), and the functions below are the same arithmetic for anybody
// checking it.

import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../db/errors.ts";
import { canonicalBytes, readCanonical } from "./jcs.ts";
import { SUMMARY_MAX_BYTES } from "../surface/vocabulary.ts";
import {
  HEX_ONLY,
  LABEL_CONTROL,
  LABEL_CONTROL_CHAIN,
  LABEL_CONTROL_GENESIS,
  LABEL_OBJECT,
  LABEL_OBJECT_ADMISSION,
  LABEL_OBJECT_CHAIN,
  LABEL_OBJECT_GENESIS,
  LABEL_OBJECT_PRIVATE,
  LABEL_OBJECT_SIGNATURE,
  LABEL_SEALED_CIPHERTEXT,
  LABEL_SEALED_HEADER,
  labelBytes,
  labelledHash,
} from "./protocol.ts";
import {
  UUID,
  byteLength,
  requireBudget,
  requireData,
  requireFingerprints,
  requireKind,
  type Fingerprint,
} from "./validate.ts";

export const OBJECT_VERSION = 1;

/**
 * The largest signed object this service accepts, in bytes.
 *
 * Above every field maximum together (a 64 KiB body, fingerprints and titles,
 * written as JSON, which escapes a newline as two bytes), and below the 256 KiB
 * request limit once base64url has made it a third larger. A body written almost
 * entirely of control characters escapes to six bytes each and does not fit: it
 * can still be posted unsigned.
 */
export const SIGNED_OBJECT_MAX_BYTES = 180 * 1024;
export const PRIVATE_MAX_BYTES = 32 * 1024;
export const SALT_BYTES = 32;

export const OBJECT_FIELDS = [
  "author_id", "body", "fingerprints", "idempotency_key", "kind", "private_digest",
  "reply_to", "retracts", "sealed", "space_id", "summary", "supersedes", "title", "to", "v",
] as const;

export const SEALED_SUITE = 1;
export const PRIVATE_FIELDS = ["budget", "data", "run_id", "salt"] as const;

// ── the arithmetic ─────────────────────────────────────────────────────────────

/** A uuid as its sixteen bytes in network order, which is PostgreSQL's uuid_send. */
export function uuidBytes(uuid: string): Buffer {
  if (!UUID.test(uuid)) throw new TypeError(`${uuid} is not a lowercase uuid`);
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

/** An 8-byte signed big-endian integer, which is PostgreSQL's int8send. */
export function int8(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64BE(value);
  return out;
}

export const objectIdOf = (canonical: Buffer): Buffer => labelledHash(LABEL_OBJECT, canonical);
export const sealedHeaderDigestOf = (header: Buffer): Buffer => labelledHash(LABEL_SEALED_HEADER, header);
export const ciphertextDigestOf = (ciphertext: Buffer): Buffer => labelledHash(LABEL_SEALED_CIPHERTEXT, ciphertext);
export const privateDigestOf = (privatePart: Buffer): Buffer => labelledHash(LABEL_OBJECT_PRIVATE, privatePart);

/** What an Ed25519 KEY signs for a post. */
export function signaturePreimageOf(objectId: Buffer): Buffer {
  return Buffer.concat([labelBytes(LABEL_OBJECT_SIGNATURE), objectId]);
}

/**
 * What a passkey signs for a post: this is the challenge its prompt carries.
 *
 * The SHA-256 of exactly the preimage an Ed25519 KEY signs, so the statement is
 * the same for both kinds of KEY. A sign-in challenge is 56 bytes and carries an
 * HMAC tag under its own label; this is 32 bytes and a hash under this one, so
 * neither can ever stand in for the other.
 */
export function passkeyChallengeOf(objectId: Buffer): Buffer {
  return createHash("sha256").update(signaturePreimageOf(objectId)).digest();
}

export const objectGenesisOf = (spaceId: string): Buffer => labelledHash(LABEL_OBJECT_GENESIS, uuidBytes(spaceId));
export const controlGenesisOf = (spaceId: string): Buffer => labelledHash(LABEL_CONTROL_GENESIS, uuidBytes(spaceId));
export const commandIdOf = (canonical: Buffer): Buffer => labelledHash(LABEL_CONTROL, canonical);

export function admissionOf(revision: bigint, controlHash: Buffer): Buffer {
  return labelledHash(LABEL_OBJECT_ADMISSION, int8(revision), controlHash);
}

export function objectChainOf(spaceId: string, seq: bigint, admission: Buffer, previous: Buffer, objectId: Buffer): Buffer {
  return labelledHash(LABEL_OBJECT_CHAIN, uuidBytes(spaceId), int8(seq), admission, previous, objectId);
}

export function controlChainOf(spaceId: string, revision: bigint, previous: Buffer, commandId: Buffer): Buffer {
  return labelledHash(LABEL_CONTROL_CHAIN, uuidBytes(spaceId), int8(revision), previous, commandId);
}

/** Code point order, which is UTF-8 byte order, which is COLLATE "C". */
export function codePointOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function fingerprintOrder(a: Fingerprint, b: Fingerprint): number {
  return codePointOrder(a.scheme, b.scheme) || codePointOrder(a.value, b.value);
}

// ── building one ───────────────────────────────────────────────────────────────

export type PostFields = {
  spaceId: string;
  /** Lowercase hex peer id. */
  author: string;
  idempotencyKey: string | null;
  kind: string;
  title: string | null;
  /** What a reader needs before the body; absent when there is none. Never on a sealed post or a version. */
  summary?: string | null;
  body: string | null;
  /** Lowercase hex peer ids. */
  to: string[];
  replyTo: string | null;
  supersedes: string | null;
  retracts: string | null;
  fingerprints: Fingerprint[];
  data: Record<string, unknown> | null;
  budget: Record<string, unknown> | null;
  runId: string | null;
};

export type BuiltObject = {
  canonical: Buffer;
  private: Buffer | null;
  privateDigest: Buffer | null;
  objectId: Buffer;
};

function withoutNulls(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined));
}

type RoutingFields = Pick<PostFields, "spaceId" | "author" | "idempotencyKey" | "kind" | "to" | "replyTo" | "supersedes" | "retracts">;

/** The members every post's object carries, sealed or not: where it is, who wrote it, and what it answers. */
function routingMembers(fields: RoutingFields): Record<string, unknown> {
  return {
    v: OBJECT_VERSION,
    space_id: fields.spaceId,
    author_id: fields.author,
    idempotency_key: fields.idempotencyKey,
    kind: fields.kind,
    to: fields.to.length > 0 ? [...new Set(fields.to)].sort() : null,
    reply_to: fields.replyTo,
    supersedes: fields.supersedes,
    retracts: fields.retracts,
  };
}

/** The one object for these fields. `salt` is for vectors and tests; a real post gets 32 random bytes. */
export function buildPostObject(fields: PostFields, salt?: Buffer): BuiltObject {
  let privatePart: Buffer | null = null;
  if (fields.data !== null || fields.budget !== null || fields.runId !== null) {
    privatePart = canonicalBytes(
      withoutNulls({
        salt: (salt ?? randomBytes(SALT_BYTES)).toString("hex"),
        data: fields.data,
        budget: fields.budget,
        run_id: fields.runId,
      }),
    );
  }
  const privateDigest = privatePart ? privateDigestOf(privatePart) : null;
  const unique = new Map(
    fields.fingerprints.map((f) => [JSON.stringify([f.scheme, f.value]), { scheme: f.scheme, value: f.value }]),
  );
  const canonical = canonicalBytes(
    withoutNulls({
      ...routingMembers(fields),
      title: fields.title,
      summary: fields.summary ?? null,
      body: fields.body === "" ? null : fields.body,
      fingerprints: unique.size > 0 ? [...unique.values()].sort(fingerprintOrder) : null,
      private_digest: privateDigest?.toString("hex") ?? null,
    }),
  );
  return { canonical, private: privatePart, privateDigest, objectId: objectIdOf(canonical) };
}

/** A sealed post's object: its routing fields and the digests of its sealed parts. */
export function buildSealedPostObject(fields: RoutingFields, header: Buffer, ciphertext: Buffer): BuiltObject {
  const canonical = canonicalBytes(
    withoutNulls({
      ...routingMembers(fields),
      sealed: {
        suite: SEALED_SUITE,
        header: sealedHeaderDigestOf(header).toString("hex"),
        ciphertext: ciphertextDigestOf(ciphertext).toString("hex"),
      },
    }),
  );
  return { canonical, private: null, privateDigest: null, objectId: objectIdOf(canonical) };
}

// ── reading a signed one ──────────────────────────────────────────────────────

function refuse(detail: string): never {
  throw new ApiError("INVALID_REQUEST", { detail });
}

function hexOf(value: unknown, bytes: number): string | null {
  return typeof value === "string" && value.length === bytes * 2 && HEX_ONLY.test(value) ? value : null;
}

function strictlyAscending<T>(items: T[], order: (a: T, b: T) => number): boolean {
  return items.every((item, i) => i === 0 || order(items[i - 1]!, item) < 0);
}

/**
 * The fields of a signed post, read strictly from the bytes its author signed.
 *
 * Refused as INVALID_REQUEST with a detail naming the rule, before any signature
 * is checked. Every rule here is one that makes the bytes the only way to write
 * this post, so the object a reader rebuilds from the post's fields is the object
 * that was signed.
 */
export function readPostObject(
  canonical: Buffer,
  privatePart: Buffer | null,
  expect: { spaceId: string; author: string; sealed?: { header: Buffer; ciphertext: Buffer } | null },
): PostFields & { idempotencyKey: string } {
  const parsed = readCanonical(canonical, "canonical");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse("canonical is not a JSON object");
  const o = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(o)) {
    if (!(OBJECT_FIELDS as readonly string[]).includes(key)) refuse(`canonical.${key} is not a field of a v1 post object`);
    if (value === null) refuse(`canonical.${key} is null: omit a field that is absent`);
  }
  if (o.v !== OBJECT_VERSION) refuse("canonical.v is 1");
  if (o.space_id !== expect.spaceId) refuse("canonical.space_id is not the space_id of the SPACE this was posted to");
  if (hexOf(o.author_id, 32) !== expect.author) refuse("canonical.author_id is not the peer id of the KEY whose token sent it");
  const idempotencyKey = o.idempotency_key;
  if (typeof idempotencyKey !== "string" || byteLength(idempotencyKey) < 1 || byteLength(idempotencyKey) > 128) {
    refuse("canonical.idempotency_key is required: 1 to 128 bytes, and it keeps two identical posts apart");
  }
  const kind = requireKind(o.kind);
  // A sealed post's object commits to its sealed parts and carries nothing sealed
  // beside them; any other post's object carries no sealed field at all.
  const sealed = expect.sealed ?? null;
  if (sealed === null && o.sealed !== undefined) refuse("canonical.sealed belongs to a sealed post, which carries sealed");
  if (sealed !== null) {
    const x = o.sealed;
    if (x === undefined || x === null || typeof x !== "object" || Array.isArray(x)) {
      refuse("a sealed post's canonical carries sealed: its suite and the digests of its header and ciphertext");
    }
    const y = x as Record<string, unknown>;
    if (Object.keys(y).sort().join(",") !== "ciphertext,header,suite") refuse("canonical.sealed is exactly ciphertext, header and suite");
    if (y.suite !== SEALED_SUITE) refuse("canonical.sealed.suite is 1");
    if (hexOf(y.header, 32) !== sealedHeaderDigestOf(sealed.header).toString("hex")) refuse("sealed.header does not hash to canonical.sealed.header");
    if (hexOf(y.ciphertext, 32) !== ciphertextDigestOf(sealed.ciphertext).toString("hex")) {
      refuse("sealed.ciphertext does not hash to canonical.sealed.ciphertext");
    }
    // A sealed post has no summary at all: its title and body are sealed together, and a
    // summary beside them would be words in the clear.
    if (o.summary !== undefined) refuse("a sealed POST carries no summary: its title and body are sealed together");
    for (const field of ["title", "body", "fingerprints", "private_digest"]) {
      if (o[field] !== undefined) refuse(`canonical.${field} is sealed in a sealed post, never beside it`);
    }
    if (privatePart !== null) refuse("a sealed post has no private part: its data, budget and run_id are sealed");
  }
  const title = o.title === undefined ? null : o.title;
  if (title !== null && (typeof title !== "string" || byteLength(title) < 1 || byteLength(title) > 512)) {
    refuse("canonical.title is 1 to 512 bytes");
  }
  const summary = o.summary === undefined ? null : o.summary;
  if (summary !== null && (typeof summary !== "string" || byteLength(summary) < 1 || byteLength(summary) > SUMMARY_MAX_BYTES)) {
    refuse(`canonical.summary is 1 to ${SUMMARY_MAX_BYTES} bytes`);
  }
  const body = o.body === undefined ? null : o.body;
  if (body !== null && (typeof body !== "string" || byteLength(body) < 1)) refuse("canonical.body is omitted when empty");
  if (typeof body === "string" && byteLength(body) > 65536) throw new ApiError("TOO_LARGE", { detail: "body" });

  let to: string[] = [];
  if (o.to !== undefined) {
    if (!Array.isArray(o.to) || o.to.length === 0 || o.to.length > 8) refuse("canonical.to is 1 to 8 peer ids, or omitted");
    to = o.to.map((item) => hexOf(item, 32) ?? refuse("canonical.to holds peer ids: 64 lowercase hex characters"));
    if (!strictlyAscending(to, codePointOrder)) refuse("canonical.to is ascending, without repeats");
    if (to.includes(expect.author)) refuse("to must not contain your own KEY");
  }

  const uuidField = (name: "reply_to" | "supersedes" | "retracts"): string | null => {
    const value = o[name];
    if (value === undefined) return null;
    if (typeof value !== "string" || !UUID.test(value)) refuse(`canonical.${name} is a post id`);
    return value;
  };
  const replyTo = uuidField("reply_to");
  const supersedes = uuidField("supersedes");
  const retracts = uuidField("retracts");
  if (supersedes !== null && retracts !== null) refuse("a post supersedes or retracts, never both");

  let fingerprints: Fingerprint[] = [];
  if (o.fingerprints !== undefined) {
    if (!Array.isArray(o.fingerprints) || o.fingerprints.length === 0) {
      refuse("canonical.fingerprints is 1 to 32 pairs, or omitted");
    }
    for (const item of o.fingerprints) {
      if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item).join(",") !== "scheme,value") {
        refuse("canonical.fingerprints holds objects of exactly scheme and value");
      }
    }
    // The service's own rules for each pair, then the object's rules for the list.
    const checked = requireFingerprints(o.fingerprints);
    const given = (o.fingerprints as Fingerprint[]).map((f) => ({ scheme: f.scheme, value: f.value }));
    if (checked.length !== given.length || !strictlyAscending(given, fingerprintOrder)) {
      refuse("canonical.fingerprints is ascending by scheme then value in code point order, without repeats");
    }
    fingerprints = given;
  }

  let data: Record<string, unknown> | null = null;
  let budget: Record<string, unknown> | null = null;
  let runId: string | null = null;
  const digest =
    o.private_digest === undefined
      ? null
      : (hexOf(o.private_digest, 32) ?? refuse("canonical.private_digest is 64 lowercase hex characters"));
  if ((digest === null) !== (privatePart === null)) {
    refuse(
      digest === null
        ? "private was sent, and canonical carries no private_digest for it"
        : "canonical.private_digest names a private part that was not sent",
    );
  }
  if (privatePart !== null) {
    if (privateDigestOf(privatePart).toString("hex") !== digest) refuse("private does not hash to canonical.private_digest");
    const p = readCanonical(privatePart, "private");
    if (p === null || typeof p !== "object" || Array.isArray(p)) refuse("private is not a JSON object");
    const q = p as Record<string, unknown>;
    for (const [key, value] of Object.entries(q)) {
      if (!(PRIVATE_FIELDS as readonly string[]).includes(key)) refuse(`private.${key} is not a field of a v1 private part`);
      if (value === null) refuse(`private.${key} is null: omit a field that is absent`);
    }
    if (hexOf(q.salt, SALT_BYTES) === null) refuse("private.salt is 32 random bytes as 64 lowercase hex characters");
    data = requireData(q.data);
    budget = requireBudget(q.budget);
    if (q.run_id !== undefined) {
      if (typeof q.run_id !== "string" || !UUID.test(q.run_id)) refuse("private.run_id is a uuid");
      runId = q.run_id;
    }
    if (data === null && budget === null && runId === null) refuse("private holds data, budget or run_id, or is not sent");
  }

  return {
    spaceId: expect.spaceId,
    author: expect.author,
    idempotencyKey: idempotencyKey as string,
    kind,
    title: title as string | null,
    summary: summary as string | null,
    body: body as string | null,
    to,
    replyTo,
    supersedes,
    retracts,
    fingerprints,
    data,
    budget,
    runId,
  };
}
