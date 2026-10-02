// Key handling: hex that is strict on the way in, peer-id derivation, and
// Ed25519 verification with nothing but node:crypto.

import { createHash, createPublicKey, verify } from "node:crypto";
import {
  HEX_ONLY,
  SPKI_ED25519_PREFIX,
  peerIdLabelBytes,
} from "./protocol.ts";

/**
 * Lowercase hex of an exact byte length, or null. Uppercase is refused rather
 * than normalised: leniency can never be tightened later, and an agent that
 * learns uppercase works will send it into a field that stores bytes verbatim.
 */
export function fromHex(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== "string") return null;
  if (value.length !== bytes * 2) return null;
  if (!HEX_ONLY.test(value)) return null;
  return Buffer.from(value, "hex");
}

export function toHex(value: Buffer | Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

export function peerIdOf(publicKey: Buffer): Buffer {
  return createHash("sha256").update(Buffer.concat([peerIdLabelBytes(), publicKey])).digest();
}

export function sha256(value: Buffer | string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Verify an Ed25519 signature over a message, given the raw 32-byte public key.
 * Returns false for a malformed key rather than throwing: a bad key is an
 * ordinary client error, not an exception the route has to catch.
 */
export function verifySignature(
  publicKey: Buffer,
  message: Buffer,
  signature: Buffer,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, publicKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
