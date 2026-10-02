// A passkey, verified with nothing but node:crypto.
//
// A passkey is a key pair whose private half never leaves a person's device (or
// the password manager that syncs it). The service treats one as a KEY like any
// other: it proves possession by signing, it gets a peer id, and it mints the
// same tokens. What differs is the envelope. An Ed25519 KEY signs the bytes this
// service names; a passkey signs what the browser's WebAuthn prompt builds, which
// is the authenticator's data followed by the SHA-256 of a small JSON document
// the browser writes, holding the challenge and the origin of the page that
// asked. The origin and the relying party id stand in for the audience an
// Ed25519 KEY binds into its signature: a passkey used on a look-alike site signs
// that site's origin and its relying party hash, and neither verifies here.
//
// Nothing here parses CBOR. A browser gives the new passkey's public key as DER
// SubjectPublicKeyInfo (PublicKeyCredential.response.getPublicKey()), and the
// service does not take that on trust: registration also requires a signature
// from the key, over a challenge this service minted.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  LABEL_PASSKEY_PEER_ID,
  PASSKEY_ALGORITHMS,
  type PasskeyAlgorithm,
} from "./protocol.ts";

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/**
 * Unpadded base64url of a length within bounds, or null.
 *
 * Strict for the same reason hex is: a byte string that decodes two ways, or one
 * that a lenient decoder silently truncates, is a field somebody can make mean
 * something the author did not write. Node's decoder ignores what it cannot read,
 * so the result is re-encoded and must match what was sent.
 */
export function fromBase64url(value: unknown, minBytes: number, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return null;
  if (bytes.length < minBytes || bytes.length > maxBytes) return null;
  return bytes;
}

export function isPasskeyAlgorithm(value: unknown): value is PasskeyAlgorithm {
  return (Object.values(PASSKEY_ALGORITHMS) as unknown[]).includes(value);
}

export function algorithmName(algorithm: PasskeyAlgorithm): string {
  return Object.entries(PASSKEY_ALGORITHMS).find(([, v]) => v === algorithm)![0];
}

/**
 * The passkey's public key, imported, when it is the kind of key its algorithm
 * says and is written in canonical DER. Null otherwise.
 *
 * Canonical because the bytes are the identity: the peer id is a hash of them,
 * and two encodings of one key would be two KEYS.
 */
export function importPasskeyKey(spki: Buffer, algorithm: PasskeyAlgorithm): KeyObject | null {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return null;
  }
  const details = key.asymmetricKeyDetails ?? {};
  switch (algorithm) {
    case PASSKEY_ALGORITHMS.ES256:
      if (key.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") return null;
      break;
    case PASSKEY_ALGORITHMS.EdDSA:
      if (key.asymmetricKeyType !== "ed25519") return null;
      break;
    case PASSKEY_ALGORITHMS.RS256:
      // 2048 bits is the floor anything current makes; 8192 bounds the work a
      // verification can be made to do.
      if (key.asymmetricKeyType !== "rsa") return null;
      if ((details.modulusLength ?? 0) < 2048 || (details.modulusLength ?? 0) > 8192) return null;
      break;
    default:
      return null;
  }
  const canonical = key.export({ type: "spki", format: "der" });
  return canonical.equals(spki) ? key : null;
}

/**
 * How GET /v1/me and GET /v1/peers/:peer describe a passkey KEY's key: its
 * algorithm by name, and the DER SubjectPublicKeyInfo in unpadded base64url,
 * the encoding this service keeps for variable-length bytes. Nothing for an
 * Ed25519 KEY, whose key is in public_key.
 */
export function passkeyFields(
  row: { key_type?: string; passkey_algorithm?: number | null; passkey_key?: Buffer | null } | undefined,
): { passkey?: { algorithm: string; public_key: string } } {
  if (!row || row.key_type !== "passkey" || !row.passkey_key || !isPasskeyAlgorithm(row.passkey_algorithm)) return {};
  return {
    passkey: { algorithm: algorithmName(row.passkey_algorithm), public_key: row.passkey_key.toString("base64url") },
  };
}

/** peer_id = sha256(LABEL_PASSKEY_PEER_ID || 0x00 || spki), as register_passkey derives it. */
export function passkeyPeerIdOf(spki: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.from(LABEL_PASSKEY_PEER_ID, "utf8"))
    .update(Buffer.from([0]))
    .update(spki)
    .digest();
}

/** The flags in authenticator data this service reads. */
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;

/** Refused as PASSKEY_INVALID, with a detail naming the check that failed. The
 * signature is one of them: SIGNATURE_INVALID's fix describes how an Ed25519 KEY
 * signs, which is no help to anybody holding a passkey. */
export type AssertionRefusal = { code: "PASSKEY_INVALID"; detail: string };

/**
 * Check one assertion from navigator.credentials.get().
 *
 * In this order: what the browser says it did, then what the authenticator says,
 * then the signature. Every check before the signature is on bytes the signature
 * covers, so the order changes which refusal a forgery gets and never whether it
 * gets one.
 */
export function checkAssertion(args: {
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
  key: KeyObject;
  algorithm: PasskeyAlgorithm;
  rpId: string;
  origins: readonly string[];
  challenge: Buffer;
}): { signCount: number } | AssertionRefusal {
  let client: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(args.clientDataJSON.toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { code: "PASSKEY_INVALID", detail: "client_data_json is not a JSON object" };
    }
    client = parsed as Record<string, unknown>;
  } catch {
    return { code: "PASSKEY_INVALID", detail: "client_data_json is not JSON" };
  }
  // A registration's clientData says webauthn.create, and carries no signature
  // over the challenge from a passkey that attests nothing, which is most of them.
  if (client.type !== "webauthn.get") {
    return { code: "PASSKEY_INVALID", detail: "client_data_json.type must be webauthn.get" };
  }
  if (client.challenge !== args.challenge.toString("base64url")) {
    return { code: "PASSKEY_INVALID", detail: "client_data_json.challenge is not the challenge sent" };
  }
  if (typeof client.origin !== "string" || !args.origins.includes(client.origin)) {
    return { code: "PASSKEY_INVALID", detail: "client_data_json.origin is not an origin this service accepts" };
  }
  // A prompt run inside a frame another site embedded.
  if (client.crossOrigin === true || client.topOrigin !== undefined) {
    return { code: "PASSKEY_INVALID", detail: "the ceremony ran in a cross-origin frame" };
  }

  const auth = args.authenticatorData;
  if (auth.length < 37) return { code: "PASSKEY_INVALID", detail: "authenticator_data is too short" };
  const rpIdHash = createHash("sha256").update(args.rpId, "utf8").digest();
  if (!auth.subarray(0, 32).equals(rpIdHash)) {
    return { code: "PASSKEY_INVALID", detail: "authenticator_data is for a different relying party" };
  }
  const flags = auth[32]!;
  if ((flags & USER_PRESENT) === 0) return { code: "PASSKEY_INVALID", detail: "the user was not present" };
  // Required, not preferred: a passkey that signs without a fingerprint, a face
  // or a PIN is a passkey anybody holding the device can use.
  if ((flags & USER_VERIFIED) === 0) return { code: "PASSKEY_INVALID", detail: "the user was not verified" };
  const signCount = auth.readUInt32BE(33);

  const signed = Buffer.concat([auth, createHash("sha256").update(args.clientDataJSON).digest()]);
  let ok = false;
  try {
    switch (args.algorithm) {
      case PASSKEY_ALGORITHMS.ES256:
        // WebAuthn's ES256 signatures are DER, not the raw r||s JOSE uses.
        ok = verify("sha256", signed, { key: args.key, dsaEncoding: "der" }, args.signature);
        break;
      case PASSKEY_ALGORITHMS.EdDSA:
        ok = verify(null, signed, args.key, args.signature);
        break;
      case PASSKEY_ALGORITHMS.RS256:
        ok = verify("sha256", signed, args.key, args.signature);
        break;
    }
  } catch {
    ok = false;
  }
  // No apostrophes in any detail here: renderableDetail() in src/db/errors.ts
  // drops a detail carrying a quote character, and the refusal arrives bare.
  return ok ? { signCount } : { code: "PASSKEY_INVALID", detail: "the signature does not verify against the public key of this passkey" };
}
