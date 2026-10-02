// A KEY's encryption key: the statement it signs, checked here before it is kept.
//
// content/sealed.md section 1 is the format. A KEY publishes one X25519 key, for
// life, as the canonical {"kem":32,"peer_id","public_key","v":1}, signed under
// 'agent-state:encryption-key:v1' with the same two envelopes a signed post uses.
//
// The checks here are the service's own, on node:crypto through keys.ts and
// passkeys.ts, and deliberately not content/sealed.mjs, which every reader runs:
// two independent checks of one signature, so a flaw in either shows up as a
// disagreement rather than as a key the service stored and every reader trusted.

import { createHash } from "node:crypto";
import { ApiError } from "../db/errors.ts";
import { readCanonical } from "./jcs.ts";
import { fromHex, toHex, verifySignature } from "./keys.ts";
import { checkAssertion, fromBase64url, importPasskeyKey, isPasskeyAlgorithm } from "./passkeys.ts";
import { HEX_ONLY, LABEL_ENCRYPTION_KEY, PASSKEY_CREDENTIAL_ID_MAX_BYTES, PASSKEY_CREDENTIAL_ID_MIN_BYTES, labelBytes } from "./protocol.ts";

/** RFC 9180's identifier for DHKEM(X25519, HKDF-SHA256). */
const KEM_X25519 = 32;
export const STATEMENT_MAX_BYTES = 512;

function refuse(detail: string): never {
  throw new ApiError("INVALID_REQUEST", { detail });
}

/** The key a statement publishes, once its bytes are canonical, of exactly the shape, and name `peer`. */
export function readEncryptionStatement(bytes: Buffer, peer: Buffer): Buffer {
  const parsed = readCanonical(bytes, "statement");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) refuse("statement is not a JSON object");
  const s = parsed as Record<string, unknown>;
  const names = Object.keys(s).sort().join(",");
  if (names !== "kem,peer_id,public_key,v") refuse("statement has exactly kem, peer_id, public_key and v");
  if (s.v !== 1) refuse("statement.v is 1");
  if (s.kem !== KEM_X25519) refuse("statement.kem is 32, DHKEM(X25519, HKDF-SHA256)");
  if (typeof s.peer_id !== "string" || !HEX_ONLY.test(s.peer_id) || s.peer_id !== toHex(peer)) {
    refuse("statement.peer_id is your own peer id");
  }
  return fromHex(s.public_key, 32) ?? refuse("statement.public_key is 64 lowercase hex characters");
}

/** What a KEY signs: the label, a NUL, and the statement's bytes. */
export const encryptionKeyPreimage = (statement: Buffer): Buffer => Buffer.concat([labelBytes(LABEL_ENCRYPTION_KEY), statement]);

/** The 32 hex characters people compare outside the service. */
export function encryptionFingerprint(publicKey: Buffer): string {
  return createHash("sha256").update(labelBytes(LABEL_ENCRYPTION_KEY)).update(publicKey).digest().subarray(0, 16).toString("hex");
}

export type SignatureEnvelope =
  | { alg: "ed25519"; signature: string }
  | { alg: "webauthn"; credential_id: string; client_data_json: string; authenticator_data: string; signature: string };

/** The signature fields of a request, strictly, exactly as they are kept and served again. */
export function readSignatureEnvelope(input: Record<string, unknown>): SignatureEnvelope {
  if (input.alg === "ed25519") {
    if (fromHex(input.signature, 64) === null) refuse("signature is 128 lowercase hex characters for ed25519");
    for (const key of ["credential_id", "client_data_json", "authenticator_data"]) {
      if (input[key] !== undefined) refuse(`${key} belongs to a passkey signature, and alg is ed25519`);
    }
    return { alg: "ed25519", signature: input.signature as string };
  }
  if (input.alg === "webauthn") {
    if (fromBase64url(input.signature, 8, 1024) === null) refuse("signature is unpadded base64url for webauthn");
    if (fromBase64url(input.credential_id, PASSKEY_CREDENTIAL_ID_MIN_BYTES, PASSKEY_CREDENTIAL_ID_MAX_BYTES) === null) {
      refuse("credential_id is unpadded base64url");
    }
    if (fromBase64url(input.client_data_json, 1, 4096) === null) refuse("client_data_json is unpadded base64url");
    if (fromBase64url(input.authenticator_data, 37, 4096) === null) refuse("authenticator_data is unpadded base64url");
    return {
      alg: "webauthn",
      credential_id: input.credential_id as string,
      client_data_json: input.client_data_json as string,
      authenticator_data: input.authenticator_data as string,
      signature: input.signature as string,
    };
  }
  refuse("alg is ed25519 or webauthn");
}

/** A KEY as the checks need it: its Ed25519 key, or its passkey. */
export type Signer =
  | { keyType: "ed25519"; publicKey: Buffer }
  | { keyType: "passkey"; spki: Buffer; algorithm: number };

/**
 * Whether `signer` signed `preimage` with this envelope: Ed25519 over the preimage
 * itself, or a passkey whose prompt carried the preimage's SHA-256 as its
 * challenge. Refused as `refusal`, ENCRYPTION_KEY_INVALID unless given, the detail
 * naming the check.
 */
export function checkSigned(args: {
  preimage: Buffer;
  envelope: SignatureEnvelope;
  signer: Signer;
  passkeys: { rpId: string; origins: readonly string[] } | null;
  /** The refusal, by what was signed: an encryption key's statement, or a keeper list or stamp. */
  refusal?: "ENCRYPTION_KEY_INVALID" | "SEALED_SIGNATURE_INVALID";
}): void {
  const { envelope, signer } = args;
  const refusal = args.refusal ?? "ENCRYPTION_KEY_INVALID";
  if (envelope.alg === "ed25519") {
    if (signer.keyType !== "ed25519") throw new ApiError(refusal, { detail: "this KEY is a passkey, so alg is webauthn" });
    if (!verifySignature(signer.publicKey, args.preimage, Buffer.from(envelope.signature, "hex"))) {
      throw new ApiError(refusal, { detail: "the signature does not verify against this KEY" });
    }
    return;
  }
  if (signer.keyType !== "passkey") throw new ApiError(refusal, { detail: "this KEY is an Ed25519 KEY, so alg is ed25519" });
  if (!args.passkeys) throw new ApiError("PASSKEYS_UNAVAILABLE");
  if (!isPasskeyAlgorithm(signer.algorithm)) throw new ApiError("INTERNAL");
  const key = importPasskeyKey(signer.spki, signer.algorithm);
  if (!key) throw new ApiError("INTERNAL");
  const checked = checkAssertion({
    clientDataJSON: Buffer.from(envelope.client_data_json, "base64url"),
    authenticatorData: Buffer.from(envelope.authenticator_data, "base64url"),
    signature: Buffer.from(envelope.signature, "base64url"),
    key,
    algorithm: signer.algorithm,
    rpId: args.passkeys.rpId,
    origins: args.passkeys.origins,
    challenge: createHash("sha256").update(args.preimage).digest(),
  });
  if ("code" in checked) throw new ApiError(refusal, { detail: checked.detail });
}

/** A KEY's signing key from its peers row and passkey, as checkSigned takes it. */
export function signerOf(row: {
  public_key: Buffer | null;
  key_type: string;
  passkey_algorithm: number | null;
  passkey_key: Buffer | null;
}): Signer | null {
  if (row.key_type === "passkey") {
    return row.passkey_key && row.passkey_algorithm !== null
      ? { keyType: "passkey", spki: row.passkey_key, algorithm: row.passkey_algorithm }
      : null;
  }
  return row.public_key ? { keyType: "ed25519", publicKey: row.public_key } : null;
}

/**
 * How GET /v1/me and GET /v1/peers/:peer describe a KEY's encryption key: the key,
 * its fingerprint, and the statement and signature every reader checks for
 * itself. Null for a KEY that has none, which nothing can be sealed to.
 */
export function encryptionKeyFields(
  row: { encryption_public_key?: Buffer | null; encryption_statement?: Buffer | null; encryption_signature?: SignatureEnvelope | null } | undefined,
): { encryption_key: null | { public_key: string; fingerprint: string; statement: string; signature: SignatureEnvelope } } {
  if (!row?.encryption_public_key || !row.encryption_statement || !row.encryption_signature) return { encryption_key: null };
  return {
    encryption_key: {
      public_key: toHex(row.encryption_public_key),
      fingerprint: encryptionFingerprint(row.encryption_public_key),
      statement: row.encryption_statement.toString("base64url"),
      signature: row.encryption_signature,
    },
  };
}
