// A signed post's signature, read from a request and checked against its author's key.
//
// Two envelopes for one statement. An Ed25519 KEY signs the object-signature
// preimage itself: the label, a NUL, and the object_id. A passkey can sign only
// what a browser's WebAuthn prompt builds around a challenge, so its challenge is
// the SHA-256 of that same preimage, and checkAssertion() verifies the envelope
// exactly as it does at sign-in, with the challenge recomputed from the post
// rather than minted by this service. See passkeyChallengeOf in objects.ts.
//
// What a signature proves, and the reference says it in these words: the holder
// of this KEY signed these bytes. Not who the holder is, not that the content is
// true, and not that the SPACE admitted it for any reason but its policy.

import { ApiError } from "../db/errors.ts";
import { fromHex, verifySignature } from "./keys.ts";
import { fromBase64url } from "./passkeys.ts";
import { PASSKEY_CREDENTIAL_ID_MAX_BYTES, PASSKEY_CREDENTIAL_ID_MIN_BYTES } from "./protocol.ts";
import { PRIVATE_MAX_BYTES, SIGNED_OBJECT_MAX_BYTES, signaturePreimageOf } from "./objects.ts";

/** The only fields a signed post's request may carry: its content is in `canonical`,
 * and a sealed post's in the sealed parts `canonical` commits to. */
export const SIGNED_POST_FIELDS = [
  "alg", "canonical", "private", "signature", "credential_id", "client_data_json", "authenticator_data", "sealed",
] as const;

export type SignedPostRequest = {
  canonical: Buffer;
  private: Buffer | null;
  signature:
    | { alg: "ed25519"; value: Buffer }
    | { alg: "webauthn"; value: Buffer; credentialId: Buffer; clientDataJSON: Buffer; authenticatorData: Buffer };
};

function refuse(detail: string): never {
  throw new ApiError("INVALID_REQUEST", { detail });
}

/**
 * The signed-post fields of a request body, strictly, or a refusal naming the one
 * that is wrong. Called only when `canonical` is present.
 */
export function readSignedPostRequest(input: Record<string, unknown>): SignedPostRequest {
  for (const key of Object.keys(input)) {
    if (!(SIGNED_POST_FIELDS as readonly string[]).includes(key)) {
      refuse(`a signed post carries its content in canonical only, so ${key} is not sent beside it`);
    }
  }
  const canonical = fromBase64url(input.canonical, 1, SIGNED_OBJECT_MAX_BYTES);
  if (canonical === null) {
    if (typeof input.canonical === "string" && input.canonical.length > Math.ceil((SIGNED_OBJECT_MAX_BYTES * 4) / 3)) {
      throw new ApiError("TOO_LARGE", { detail: "canonical" });
    }
    refuse("canonical is the object bytes as unpadded base64url");
  }
  const privatePart =
    input.private === undefined ? null : (fromBase64url(input.private, 1, PRIVATE_MAX_BYTES) ?? refuse("private is unpadded base64url"));

  if (input.alg === "ed25519") {
    for (const key of ["credential_id", "client_data_json", "authenticator_data"]) {
      if (input[key] !== undefined) refuse(`${key} belongs to a passkey signature, and alg is ed25519`);
    }
    const value = fromHex(input.signature, 64) ?? refuse("signature is 128 lowercase hex characters for ed25519");
    return { canonical, private: privatePart, signature: { alg: "ed25519", value } };
  }
  if (input.alg === "webauthn") {
    const value = fromBase64url(input.signature, 8, 1024) ?? refuse("signature is unpadded base64url for webauthn");
    const credentialId =
      fromBase64url(input.credential_id, PASSKEY_CREDENTIAL_ID_MIN_BYTES, PASSKEY_CREDENTIAL_ID_MAX_BYTES) ??
      refuse("credential_id is unpadded base64url");
    const clientDataJSON = fromBase64url(input.client_data_json, 1, 4096) ?? refuse("client_data_json is unpadded base64url");
    const authenticatorData = fromBase64url(input.authenticator_data, 37, 4096) ?? refuse("authenticator_data is unpadded base64url");
    return {
      canonical,
      private: privatePart,
      signature: { alg: "webauthn", value, credentialId, clientDataJSON, authenticatorData },
    };
  }
  refuse("alg is ed25519 or webauthn");
}

/** Whether an Ed25519 KEY signed this object. */
export function ed25519SignedObject(publicKey: Buffer, objectId: Buffer, signature: Buffer): boolean {
  return verifySignature(publicKey, signaturePreimageOf(objectId), signature);
}
