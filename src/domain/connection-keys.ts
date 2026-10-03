// Signing through an app connection: the connection key, the statement a KEY signs
// for it, the vault its private half is kept in, and the posts it signs.
//
// An app that connects by sign-in, anything using /mcp/connect, is given a token for
// the person's KEY and nothing else, so its posts went out unsigned and a SPACE that
// takes signed posts only refused them. A connection key is an Ed25519 key pair D that
// the website makes for one app connection when the person allows it, and that the
// person's KEY authorizes once, with a signed delegation statement:
//
//   statement = canonical({"connection","key","not_after","not_before","peer_id","v":1})
//   signed    = L("connection-key") ‖ statement
//
//   v           1
//   peer_id     the KEY that allows the connection, 64 hex
//   key         D's Ed25519 public key, 64 hex
//   connection  the authorization request's id, a uuid in its lowercase text
//   not_before  whole seconds since 1970: when the statement was made
//   not_after   not_before, the token's lifetime and one hour
//
// A post signed with D counts only when its posted_at, the service's own time, falls from
// not_before to not_after: whoever holds D cannot put it on a post from before the person
// allowed the app, and a page can say when that was.
//
// The statement names no app. The request it names does, and the service holds the
// statement to that request; a client_id in it would publish that two KEYS connected
// through one app's registration, and KEYS are never linked.
//
// The KEY signs it with the envelopes of content/sealed.md section 1, exactly as it
// signs an encryption-key statement: ed25519 over `signed`, or webauthn with H(signed)
// as the prompt's challenge. L, H, canonical, hex and b64u are that file's notation.
//
// THE POST. D signs exactly what an Ed25519 KEY signs for a post, the object-signature
// preimage of its object_id (src/domain/objects.ts). Its envelope, in the request and
// in every proof, is {"alg":"connection","signature":hex,"connection_key":hex}, and a
// proof carries the statement and its signature beside it, so a reader checks both
// without trusting the service: the statement, that its peer_id is the post's author
// and its key the connection_key, that the post's time is not past not_after, and D's
// signature over the preimage. What it proves: the author's KEY allowed this connection
// key for this request from not_before until not_after, and the connection, or the
// service, which held the key, signed these bytes; not that the person saw the post.
// posted_at, which the two are compared with, is the service's own time. The service
// signs with D only while it holds the connection's token in a request.
//
// THE VAULT. D's 32-byte seed is never kept as it is. It is sealed with AES-256-GCM
// under HKDF(empty, secret, L("connection-vault"), 32), with a random 12-byte nonce,
// and kept as nonce ‖ ciphertext ‖ tag. The secret is first the code the person's yes
// made, with the request id's sixteen bytes as additional data, and then the access
// token that code was traded for, with the token's hash as additional data. The
// service keeps only the hashes of both, so nothing it keeps at rest opens a vault: it
// opens one in memory, for one connector call that carries the token.
//
// The checks are the service's own, on node:crypto, beside content/verify-post.mjs,
// which every reader runs: two independent checks of one statement.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { ApiError } from "../db/errors.ts";
import { checkSigned, readSignatureEnvelope, type SignatureEnvelope, type Signer } from "./encryption.ts";
import { canonicalBytes, readCanonical } from "./jcs.ts";
import { peerIdOf, toHex } from "./keys.ts";
import { buildPostObject, signaturePreimageOf, uuidBytes, type BuiltObject } from "./objects.ts";
import { fromBase64url, passkeyPeerIdOf } from "./passkeys.ts";
import {
  HEX_ONLY,
  LABEL_CONNECTION_KEY,
  LABEL_CONNECTION_VAULT,
  REJECTED_PUBLIC_KEYS,
  TOKEN_TTL_DEFAULT_SECONDS,
  labelBytes,
} from "./protocol.ts";
import { UUID, type Fingerprint } from "./validate.ts";

/** A statement's bytes at most: its five fields take about 230. */
export const CONNECTION_STATEMENT_MAX_BYTES = 512;
export const CONNECTION_SEED_BYTES = 32;
/** nonce ‖ ciphertext of the 32-byte seed ‖ tag. */
export const VAULT_BYTES = 12 + CONNECTION_SEED_BYTES + 16;

/** How long a code lasts once the person says yes: oauth_decide() in the database. */
const CODE_SECONDS = 5 * 60;
/** How long a statement lasts: not_after is exactly this after not_before. */
export const STATEMENT_SECONDS = TOKEN_TTL_DEFAULT_SECONDS + 60 * 60;
/**
 * When not_before may be, from the service's clock as it checks the approval: up to an
 * hour before, as a page made it, and up to a minute after, for a website server's clock
 * running ahead of the database's. No more: the connector signs nothing before
 * not_before, so posts after an Allow that kept the key would go unsigned meanwhile.
 */
export const NOT_BEFORE_PAST_SECONDS = 60 * 60;
export const NOT_BEFORE_FUTURE_SECONDS = 60;
/**
 * The earliest not_after may be, from the same moment: the token's lifetime and the
 * code's five minutes, because a token minted from this code expires no later than that,
 * so a connection never outlives the statement that lets it sign.
 */
export const NOT_AFTER_MIN_SECONDS = TOKEN_TTL_DEFAULT_SECONDS + CODE_SECONDS;

/** The DER prefix of an Ed25519 PKCS#8 private key: a 32-byte seed becomes a key by prepending it. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type DelegationStatement = {
  peerId: string;
  key: string;
  connection: string;
  /** Whole seconds since 1970. */
  notBefore: number;
  notAfter: number;
};

function refuse(detail: string): never {
  throw new ApiError("INVALID_REQUEST", { detail });
}

/** The statement's canonical bytes, as the website builds them and the KEY signs them. */
export function delegationStatementBytes(s: DelegationStatement): Buffer {
  return canonicalBytes({
    connection: s.connection,
    key: s.key,
    not_after: s.notAfter,
    not_before: s.notBefore,
    peer_id: s.peerId,
    v: 1,
  });
}

/** What a KEY signs: the label, a NUL, and the statement's bytes. */
export const delegationPreimage = (statement: Buffer): Buffer => Buffer.concat([labelBytes(LABEL_CONNECTION_KEY), statement]);

/**
 * A statement read strictly from its bytes: canonical, of exactly this shape, each
 * field of its type. Refused as INVALID_REQUEST with a detail naming the rule. What it
 * says is checked against the approval, or the post, by whoever reads it.
 */
export function readDelegationStatement(bytes: Buffer): DelegationStatement {
  const field = "connection_key.statement";
  if (bytes.length > CONNECTION_STATEMENT_MAX_BYTES) refuse(`${field} is at most ${CONNECTION_STATEMENT_MAX_BYTES} bytes`);
  const parsed = readCanonical(bytes, field);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse(`${field} is not a JSON object`);
  const s = parsed as Record<string, unknown>;
  if (Object.keys(s).sort().join(",") !== "connection,key,not_after,not_before,peer_id,v") {
    refuse(`${field} has exactly connection, key, not_after, not_before, peer_id and v`);
  }
  if (s.v !== 1) refuse(`${field}.v is 1`);
  if (typeof s.peer_id !== "string" || s.peer_id.length !== 64 || !HEX_ONLY.test(s.peer_id)) {
    refuse(`${field}.peer_id is 64 lowercase hex characters`);
  }
  if (typeof s.key !== "string" || s.key.length !== 64 || !HEX_ONLY.test(s.key)) refuse(`${field}.key is 64 lowercase hex characters`);
  if (typeof s.connection !== "string" || !UUID.test(s.connection)) refuse(`${field}.connection is a uuid in lowercase`);
  if (typeof s.not_before !== "number" || !Number.isSafeInteger(s.not_before) || s.not_before <= 0) {
    refuse(`${field}.not_before is whole seconds since 1970`);
  }
  if (typeof s.not_after !== "number" || !Number.isSafeInteger(s.not_after) || s.not_after <= s.not_before) {
    refuse(`${field}.not_after is whole seconds since 1970, after not_before`);
  }
  return {
    peerId: s.peer_id as string,
    key: s.key as string,
    connection: s.connection as string,
    notBefore: s.not_before as number,
    notAfter: s.not_after as number,
  };
}

/** A connection key's private key from its seed. The DER that carries the seed is zeroed
 * once the key is made, so this keeps no copy of the seed beside the caller's own. */
function privateKeyOf(seed: Buffer): KeyObject {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    der.fill(0);
  }
}

/** The raw 32-byte Ed25519 public key of a 32-byte seed. */
export function connectionPublicKey(seed: Buffer): Buffer {
  const spki = createPublicKey(privateKeyOf(seed)).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32));
}

/** An approval's connection_key, as it is sent: the statement, how the KEY signed it, and D's seed. */
export type ConnectionKeyBody = { statement: Buffer; envelope: SignatureEnvelope; seed: Buffer };

/** The connection_key of an approval's body, read strictly for its shape alone. */
export function readConnectionKeyBody(value: unknown): ConnectionKeyBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    refuse("connection_key is an object of statement, signature and seed");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!["statement", "signature", "seed"].includes(key)) refuse(`connection_key.${key} is not a field: it takes statement, signature and seed`);
  }
  const statement =
    fromBase64url(input.statement, 1, CONNECTION_STATEMENT_MAX_BYTES) ??
    refuse("connection_key.statement is the statement's canonical bytes as unpadded base64url");
  const signature = input.signature;
  if (signature === null || typeof signature !== "object" || Array.isArray(signature)) {
    refuse("connection_key.signature is the envelope the KEY signed the statement with: alg and its fields");
  }
  let envelope: SignatureEnvelope;
  try {
    envelope = readSignatureEnvelope(signature as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ApiError && error.code === "INVALID_REQUEST") refuse(`connection_key.signature: ${error.detail ?? "alg is ed25519 or webauthn"}`);
    throw error;
  }
  for (const key of Object.keys(signature as Record<string, unknown>)) {
    const allowed = envelope.alg === "ed25519" ? ["alg", "signature"] : ["alg", "signature", "credential_id", "client_data_json", "authenticator_data"];
    if (!allowed.includes(key)) refuse(`connection_key.signature.${key} is not a field of a ${envelope.alg} envelope`);
  }
  const seed =
    fromBase64url(input.seed, CONNECTION_SEED_BYTES, CONNECTION_SEED_BYTES) ??
    refuse("connection_key.seed is the connection key's 32-byte Ed25519 seed as unpadded base64url");
  return { statement, envelope, seed };
}

/**
 * A connection key checked as an approval sends it, before anything is kept: the
 * statement canonical and of exactly its shape; its peer_id the approving KEY's; its
 * connection this request; its key the public key of the seed sent; not_before about now
 * and not_after the statement's length after it; the signer's key hashing to the peer
 * id; and the signature. Every refusal is INVALID_REQUEST with a detail naming the
 * check. `nowMs` is the database's clock. Answers what is recorded, and a passkey's
 * signature counter, which the caller moves on.
 */
export function checkConnectionKey(args: {
  body: ConnectionKeyBody;
  approver: Buffer;
  signer: Signer;
  request: { id: string };
  passkeys: { rpId: string; origins: readonly string[] } | null;
  nowMs: number;
}): { statement: DelegationStatement; publicKey: Buffer; signCount: number | null } {
  const { body } = args;
  const statement = readDelegationStatement(body.statement);
  if (statement.peerId !== toHex(args.approver)) refuse("connection_key.statement.peer_id is not the peer id of the KEY allowing the app");
  if (statement.connection !== args.request.id) refuse("connection_key.statement.connection is not this request to connect");
  const publicKey = connectionPublicKey(body.seed);
  if (statement.key !== toHex(publicKey)) refuse("connection_key.statement.key is not the public key of connection_key.seed");
  if (REJECTED_PUBLIC_KEYS.has(statement.key)) refuse("connection_key.statement.key is a published test key, whose private half anybody holds");
  const now = Math.floor(args.nowMs / 1000);
  if (statement.notBefore < now - NOT_BEFORE_PAST_SECONDS || statement.notBefore > now + NOT_BEFORE_FUTURE_SECONDS) {
    refuse("connection_key.statement.not_before is now, as whole seconds since 1970");
  }
  if (statement.notAfter - statement.notBefore !== STATEMENT_SECONDS) {
    refuse("connection_key.statement.not_after is not_before, the token lifetime and one hour");
  }
  if (statement.notAfter < now + NOT_AFTER_MIN_SECONDS) {
    refuse("connection_key.statement.not_after falls before a token minted now would expire: make the statement again");
  }
  const signerPeer = args.signer.keyType === "ed25519" ? peerIdOf(args.signer.publicKey) : passkeyPeerIdOf(args.signer.spki);
  if (toHex(signerPeer) !== statement.peerId) refuse("connection_key.signature: the KEY that signs does not hash to statement.peer_id");
  const checked = checkSigned({
    preimage: delegationPreimage(body.statement),
    envelope: body.envelope,
    signer: args.signer,
    passkeys: args.passkeys,
    refusal: "INVALID_REQUEST",
    field: "connection_key.signature",
  });
  return { statement, publicKey, signCount: checked?.signCount ?? null };
}

// ── the vault ──────────────────────────────────────────────────────────────────

/** The key a vault is sealed under: HKDF-SHA256 of the secret, no salt, under the label. */
function vaultKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), labelBytes(LABEL_CONNECTION_VAULT), 32));
}

/** A connection key's seed sealed under a secret the service never keeps: the code, then the token. */
export function sealVault(secret: string, seed: Buffer, additional: Buffer): Buffer {
  if (seed.length !== CONNECTION_SEED_BYTES) throw new TypeError("a connection key's seed is 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(secret), nonce);
  cipher.setAAD(additional);
  return Buffer.concat([nonce, cipher.update(seed), cipher.final(), cipher.getAuthTag()]);
}

/** The seed a vault holds, or null for a vault this secret and these bytes do not open. */
export function openVault(secret: string, vault: Buffer, additional: Buffer): Buffer | null {
  if (vault.length !== VAULT_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", vaultKey(secret), vault.subarray(0, 12));
    decipher.setAAD(additional);
    decipher.setAuthTag(vault.subarray(12 + CONNECTION_SEED_BYTES));
    return Buffer.concat([decipher.update(vault.subarray(12, 12 + CONNECTION_SEED_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

/** The additional data a code's vault is sealed with: the request id's sixteen bytes. */
export const codeVaultData = (requestId: string): Buffer => uuidBytes(requestId);

// ── the posts a connection signs ───────────────────────────────────────────────

/**
 * The private part's salt for a post with an idempotency key: an HMAC under D's seed of
 * the SPACE and the key, as the bridge's signedPost() draws it from the KEY's, so the
 * same post sent again is the same bytes and replays.
 */
export function connectionSalt(seed: Buffer, spaceId: string, idempotencyKey: string): Buffer {
  return createHmac("sha256", seed).update(`schellingaf bridge private salt\n${spaceId}\n${idempotencyKey}`).digest();
}

/**
 * The idempotency key a post's object carries, for one the agent gave a key: an HMAC under
 * D's seed of the SPACE and the agent's key, as 64 hex characters. A signed object
 * publishes its idempotency key, and an agent posting through an app never chose to sign,
 * so its own key stays its own; the same key again is the same object, and replays.
 */
export function connectionIdempotencyKey(seed: Buffer, spaceId: string, idempotencyKey: string): string {
  return createHmac("sha256", seed).update(`schellingaf connection idempotency key\n${spaceId}\n${idempotencyKey}`).digest("hex");
}

/** D's signature for a post: Ed25519 over the object-signature preimage, as a KEY's. */
export function signAsConnection(seed: Buffer, objectId: Buffer): Buffer {
  return sign(null, signaturePreimageOf(objectId), privateKeyOf(seed));
}

/** The fields a post tool call carries, as the connector's schema took them. */
export type PostArguments = {
  kind?: string | undefined;
  title?: string | undefined;
  summary?: string | undefined;
  body?: string | undefined;
  data?: Record<string, unknown> | undefined;
  budget?: Record<string, unknown> | undefined;
  fingerprints?: Fingerprint[] | undefined;
  to?: string[] | undefined;
  reply_to?: string | undefined;
  supersedes?: string | undefined;
  retracts?: string | undefined;
  run_id?: string | undefined;
  idempotency_key?: string | undefined;
};

/**
 * A post signed by a connection key, as the bridge's signedPost() signs one with a KEY:
 * the object buildPostObject() makes from the fields given (an empty string is a field
 * not given), the private part when there is data, a budget or a run_id, its salt drawn
 * from D's seed, the SPACE and the idempotency key when there is one and random
 * otherwise, and an idempotency key in the object always: one drawn the same way from the
 * agent's (connectionIdempotencyKey), or a fresh uuid when none was given. Answers the
 * request body that carries it: the service reads every field from the signed bytes, and
 * refuses them as it refuses any signed post's.
 */
export function connectionSignedPost(
  seed: Buffer,
  where: { spaceId: string; author: string },
  args: PostArguments,
): { body: Record<string, string>; built: BuiltObject } {
  const text = (value: string | undefined): string | null => (typeof value === "string" && value !== "" ? value : null);
  const idempotencyKey = text(args.idempotency_key);
  const salt = idempotencyKey === null ? randomBytes(32) : connectionSalt(seed, where.spaceId, idempotencyKey);
  const built = buildPostObject(
    {
      spaceId: where.spaceId,
      author: where.author,
      idempotencyKey: idempotencyKey === null ? randomUUID() : connectionIdempotencyKey(seed, where.spaceId, idempotencyKey),
      kind: args.kind as string,
      title: text(args.title),
      summary: text(args.summary),
      body: text(args.body),
      to: args.to ?? [],
      replyTo: text(args.reply_to),
      supersedes: text(args.supersedes),
      retracts: text(args.retracts),
      fingerprints: args.fingerprints ?? [],
      data: args.data ?? null,
      budget: args.budget ?? null,
      runId: text(args.run_id),
    },
    salt,
  );
  return {
    built,
    body: {
      canonical: built.canonical.toString("base64url"),
      ...(built.private ? { private: built.private.toString("base64url") } : {}),
      alg: "connection",
      signature: signAsConnection(seed, built.objectId).toString("hex"),
      connection_key: toHex(connectionPublicKey(seed)),
    },
  };
}
