// A second, independent implementation of the sealed formats (suite 1), for the
// tests alone: nothing outside test/ may import it, and it never ships.
//
// Written from content/sealed.md, RFC 9180 (HPKE) and RFC 5869 (HKDF), without
// reading content/sealed.mjs or any other implementation of these formats, so
// that the tests can hold content/sealed.mjs to it. It is built on node:crypto's
// classic API (createHmac, createHash, createCipheriv, diffieHellman) where that
// file uses Web Crypto: two implementations on different primitives that agree
// byte for byte are the reason for having this one.
//
// Every function is pure: randomness (ikmE, secrets, salts) is always passed in,
// never generated here. It checks byte lengths, the two shapes of a container and
// the generations the formulas allow (from 1, and from 2 for a back link). It does
// not check what the spec leaves to the software around it: that a header or its
// content is canonical JSON of the right shape and within its limits, that a
// header names what the service shows, or that a pair only has generation 1.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  timingSafeEqual,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

const EMPTY = Buffer.alloc(0);

// AES(k, pt, aad) in the spec's notation: AES-128-GCM under a nonce of zeros.
const ZERO_NONCE = Buffer.alloc(12);

/** The value as a Buffer; refused unless it is bytes, and of `length` when given. */
function bytes(value: Uint8Array, what: string, length?: number): Buffer {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${what} must be a Buffer`);
  if (length !== undefined && value.length !== length) {
    throw new RangeError(`${what} must be ${length} bytes, not ${value.length}`);
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

// ---------------------------------------------------------------------------
// Notation

/** L(name): the UTF-8 of "agent-state:<name>:v1" followed by one 0x00 byte. */
export function labelBytes(name: string): Buffer {
  if (typeof name !== "string" || name === "" || name.includes("\0")) {
    throw new TypeError("a label's name is a non-empty string without a zero byte");
  }
  return Buffer.concat([Buffer.from(`agent-state:${name}:v1`, "utf8"), Buffer.of(0x00)]);
}

/** H(a ‖ b ‖ ...): SHA-256 of the parts, concatenated. */
export function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(bytes(part, "what is hashed"));
  return hash.digest();
}

/** HKDF-Extract, RFC 5869 section 2.2. A salt not provided is HashLen zero bytes. */
function extract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt.length === 0 ? Buffer.alloc(32) : salt).update(ikm).digest();
}

/** HKDF-Expand, RFC 5869 section 2.3: T(i) = HMAC(PRK, T(i-1) ‖ info ‖ i). */
function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > 255 * 32) {
    throw new RangeError(`HKDF-SHA256 cannot give ${String(length)} bytes`);
  }
  const blocks: Buffer[] = [];
  let previous: Buffer = EMPTY;
  for (let i = 1; blocks.length * 32 < length; i++) {
    previous = createHmac("sha256", prk).update(previous).update(info).update(Buffer.of(i)).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** HKDF(salt, ikm, info, n): HKDF-SHA256, RFC 5869. An empty salt means 32 zero bytes. */
export function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return expand(
    extract(bytes(salt, "the salt"), bytes(ikm, "the input keying material")),
    bytes(info, "the info"),
    length,
  );
}

/** u64(n): an 8-byte signed big-endian integer, which is PostgreSQL's int8send. */
export function u64(n: bigint | number): Buffer {
  const value = typeof n === "bigint" ? n : Number.isSafeInteger(n) ? BigInt(n) : null;
  if (value === null || value < -(2n ** 63n) || value >= 2n ** 63n) {
    throw new RangeError(`${String(n)} is not a whole number that fits in 8 signed bytes`);
  }
  const out = Buffer.alloc(8);
  out.writeBigInt64BE(value);
  return out;
}

// ---------------------------------------------------------------------------
// X25519 through node:crypto, which takes a raw key only inside its RFC 8410
// wrapping: PKCS #8 for a private key, SubjectPublicKeyInfo for a public one.

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function privateKey(sk: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, sk]), format: "der", type: "pkcs8" });
}

function publicKey(pk: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, pk]), format: "der", type: "spki" });
}

/** pk(sk), serialized: the 32 bytes of the public key. */
function publicKeyOf(sk: Buffer): Buffer {
  const spki = createPublicKey(privateKey(sk)).export({ format: "der", type: "spki" });
  if (spki.length !== SPKI_X25519.length + 32 || !spki.subarray(0, SPKI_X25519.length).equals(SPKI_X25519)) {
    throw new Error("node:crypto wrote an X25519 public key in a form this file does not know");
  }
  return Buffer.from(spki.subarray(SPKI_X25519.length));
}

/** DH(sk, pk), refusing an all-zero result as RFC 9180 section 7.1.4 requires. */
function dh(sk: Buffer, pk: Buffer): Buffer {
  const mine = privateKey(sk);
  const theirs = publicKey(pk);
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: mine, publicKey: theirs });
  } catch (cause) {
    // OpenSSL refuses an all-zero X25519 result itself, before the check below sees it,
    // and says only that the derivation failed.
    throw new Error("X25519 gave no result: OpenSSL refuses one of all zero bytes, as RFC 9180 section 7.1.4 does", {
      cause,
    });
  }
  if (shared.length !== 32) throw new Error(`X25519 gave ${shared.length} bytes, not 32`);
  if (shared.every((byte) => byte === 0)) {
    throw new Error("X25519 gave all zero bytes, which RFC 9180 section 7.1.4 refuses");
  }
  return shared;
}

// ---------------------------------------------------------------------------
// HPKE, RFC 9180: DHKEM(X25519, HKDF-SHA256) 0x0020, HKDF-SHA256 0x0001,
// AES-128-GCM 0x0001.

const HPKE_V1 = Buffer.from("HPKE-v1");
const KEM_SUITE_ID = Buffer.concat([Buffer.from("KEM"), Buffer.of(0x00, 0x20)]); // section 4.1
const HPKE_SUITE_ID = Buffer.concat([Buffer.from("HPKE"), Buffer.of(0x00, 0x20, 0x00, 0x01, 0x00, 0x01)]); // section 5.1
const MODE_BASE = 0x00;
const MODE_AUTH = 0x02;
const N_SECRET = 32; // Nsecret; Nenc, Npk and Nsk are 32 as well
const N_K = 16;
const N_N = 12;
const N_H = 32;
const N_TAG = 16;

function labeledExtract(suiteId: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
  return extract(salt, Buffer.concat([HPKE_V1, suiteId, Buffer.from(label), ikm]));
}

function labeledExpand(suiteId: Buffer, prk: Buffer, label: string, info: Buffer, length: number): Buffer {
  const size = Buffer.alloc(2);
  size.writeUInt16BE(length); // I2OSP(L, 2)
  return expand(prk, Buffer.concat([size, HPKE_V1, suiteId, Buffer.from(label), info]), length);
}

/** DeriveKeyPair(ikm), RFC 9180 section 7.1.3. sk is the expanded bytes as they are, unclamped. */
export function deriveKeyPair(ikm: Buffer): { sk: Buffer; pk: Buffer } {
  const dkpPrk = labeledExtract(KEM_SUITE_ID, EMPTY, "dkp_prk", bytes(ikm, "ikm"));
  const sk = labeledExpand(KEM_SUITE_ID, dkpPrk, "sk", EMPTY, N_SECRET);
  return { sk, pk: publicKeyOf(sk) };
}

function extractAndExpand(dhResult: Buffer, kemContext: Buffer): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, "eae_prk", dhResult);
  return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, N_SECRET);
}

/** Encap(pkR), its ephemeral key pair derived from ikmE. */
export function encap(pkR: Buffer, ikmE: Buffer): { sharedSecret: Buffer; enc: Buffer } {
  const recipient = bytes(pkR, "pkR", 32);
  const ephemeral = deriveKeyPair(ikmE);
  const enc = ephemeral.pk;
  const sharedSecret = extractAndExpand(dh(ephemeral.sk, recipient), Buffer.concat([enc, recipient]));
  return { sharedSecret, enc };
}

/** AuthEncap(pkR, skS), its ephemeral key pair derived from ikmE. */
export function authEncap(pkR: Buffer, skS: Buffer, ikmE: Buffer): { sharedSecret: Buffer; enc: Buffer } {
  const recipient = bytes(pkR, "pkR", 32);
  const sender = bytes(skS, "skS", 32);
  const ephemeral = deriveKeyPair(ikmE);
  const enc = ephemeral.pk;
  const dhResult = Buffer.concat([dh(ephemeral.sk, recipient), dh(sender, recipient)]);
  const kemContext = Buffer.concat([enc, recipient, publicKeyOf(sender)]);
  return { sharedSecret: extractAndExpand(dhResult, kemContext), enc };
}

/** Decap(enc, skR): the shared secret. */
export function decap(enc: Buffer, skR: Buffer): Buffer {
  const pkE = bytes(enc, "enc", 32);
  const recipient = bytes(skR, "skR", 32);
  return extractAndExpand(dh(recipient, pkE), Buffer.concat([pkE, publicKeyOf(recipient)]));
}

/** AuthDecap(enc, skR, pkS): the shared secret. */
export function authDecap(enc: Buffer, skR: Buffer, pkS: Buffer): Buffer {
  const pkE = bytes(enc, "enc", 32);
  const recipient = bytes(skR, "skR", 32);
  const sender = bytes(pkS, "pkS", 32);
  const dhResult = Buffer.concat([dh(recipient, pkE), dh(recipient, sender)]);
  return extractAndExpand(dhResult, Buffer.concat([pkE, publicKeyOf(recipient), sender]));
}

/** KeySchedule for mode_base (0) or mode_auth (2), whose psk and psk_id are the empty defaults. */
export function keySchedule(
  mode: 0 | 2,
  sharedSecret: Buffer,
  info: Buffer,
): { keyScheduleContext: Buffer; secret: Buffer; key: Buffer; baseNonce: Buffer; exporterSecret: Buffer } {
  if (mode !== MODE_BASE && mode !== MODE_AUTH) {
    throw new RangeError(`mode ${String(mode)} is neither base (0) nor auth (2)`);
  }
  const shared = bytes(sharedSecret, "the shared secret", N_SECRET);
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "info_hash", bytes(info, "info"));
  const keyScheduleContext = Buffer.concat([Buffer.of(mode), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE_ID, shared, "secret", EMPTY);
  return {
    keyScheduleContext,
    secret,
    key: labeledExpand(HPKE_SUITE_ID, secret, "key", keyScheduleContext, N_K),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", keyScheduleContext, N_N),
    exporterSecret: labeledExpand(HPKE_SUITE_ID, secret, "exp", keyScheduleContext, N_H),
  };
}

/** AES-128-GCM: the ciphertext followed by its 16-byte tag. */
export function aeadSeal(key: Buffer, nonce: Buffer, aad: Buffer, pt: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-gcm", bytes(key, "the key", N_K), bytes(nonce, "the nonce", N_N), {
    authTagLength: N_TAG,
  });
  cipher.setAAD(bytes(aad, "the aad"));
  const ct = Buffer.concat([cipher.update(bytes(pt, "the plaintext")), cipher.final()]);
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

/** AES-128-GCM: the plaintext, or a throw when the ciphertext does not authenticate. */
export function aeadOpen(key: Buffer, nonce: Buffer, aad: Buffer, ct: Buffer): Buffer {
  const sealed = bytes(ct, "the ciphertext");
  if (sealed.length < N_TAG) throw new Error("the ciphertext is shorter than its tag, so it does not authenticate");
  const decipher = createDecipheriv("aes-128-gcm", bytes(key, "the key", N_K), bytes(nonce, "the nonce", N_N), {
    authTagLength: N_TAG,
  });
  decipher.setAuthTag(sealed.subarray(sealed.length - N_TAG));
  decipher.setAAD(bytes(aad, "the aad"));
  const pt = decipher.update(sealed.subarray(0, sealed.length - N_TAG));
  try {
    return Buffer.concat([pt, decipher.final()]);
  } catch {
    throw new Error("the ciphertext does not authenticate");
  }
}

/** ComputeNonce(seq): base_nonce XOR I2OSP(seq, Nn). */
export function nonceFor(baseNonce: Buffer, seq: number): Buffer {
  const base = bytes(baseNonce, "the base nonce", N_N);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError(`sequence number ${String(seq)} is not a whole number from 0`);
  }
  const nonce = Buffer.alloc(N_N);
  nonce.writeBigUInt64BE(BigInt(seq), N_N - 8); // the four bytes above stay zero
  for (let i = 0; i < N_N; i++) nonce[i] = nonce[i]! ^ base[i]!;
  return nonce;
}

/** SealBase(pkR, info, aad, pt): single-shot, so at sequence number 0. */
export function sealBase(pkR: Buffer, info: Buffer, aad: Buffer, pt: Buffer, ikmE: Buffer): { enc: Buffer; ct: Buffer } {
  const { sharedSecret, enc } = encap(pkR, ikmE);
  const { key, baseNonce } = keySchedule(MODE_BASE, sharedSecret, info);
  return { enc, ct: aeadSeal(key, nonceFor(baseNonce, 0), aad, pt) };
}

/** OpenBase(enc, skR, info, aad, ct): the plaintext, or a throw. */
export function openBase(enc: Buffer, skR: Buffer, info: Buffer, aad: Buffer, ct: Buffer): Buffer {
  const { key, baseNonce } = keySchedule(MODE_BASE, decap(enc, skR), info);
  return aeadOpen(key, nonceFor(baseNonce, 0), aad, ct);
}

/** SealAuth(pkR, info, aad, pt, skS): single-shot, so at sequence number 0. */
export function sealAuth(
  pkR: Buffer,
  info: Buffer,
  aad: Buffer,
  pt: Buffer,
  skS: Buffer,
  ikmE: Buffer,
): { enc: Buffer; ct: Buffer } {
  const { sharedSecret, enc } = authEncap(pkR, skS, ikmE);
  const { key, baseNonce } = keySchedule(MODE_AUTH, sharedSecret, info);
  return { enc, ct: aeadSeal(key, nonceFor(baseNonce, 0), aad, pt) };
}

/** OpenAuth(enc, skR, info, aad, ct, pkS): the plaintext, or a throw. */
export function openAuth(enc: Buffer, skR: Buffer, info: Buffer, aad: Buffer, ct: Buffer, pkS: Buffer): Buffer {
  const { key, baseNonce } = keySchedule(MODE_AUTH, authDecap(enc, skR, pkS), info);
  return aeadOpen(key, nonceFor(baseNonce, 0), aad, ct);
}

// ---------------------------------------------------------------------------
// 1. The encryption key

/** (sk, pk) = DeriveKeyPair(HKDF(empty, S, L("encryption-key-seed") ‖ peer_id, 32)). */
export function encryptionKeyFromSecret(secret: Buffer, peerId: Buffer): { sk: Buffer; pk: Buffer } {
  const info = Buffer.concat([labelBytes("encryption-key-seed"), bytes(peerId, "the peer id", 32)]);
  return deriveKeyPair(hkdf(EMPTY, bytes(secret, "S", 32), info, 32));
}

/** canonical({"kem":32,"peer_id":hex,"public_key":hex,"v":1}): the members already in order. */
export function statementBytes(peerId: Buffer, pk: Buffer): Buffer {
  const id = bytes(peerId, "the peer id", 32).toString("hex");
  const key = bytes(pk, "the public key", 32).toString("hex");
  return Buffer.from(`{"kem":32,"peer_id":"${id}","public_key":"${key}","v":1}`, "utf8");
}

/** The first 16 bytes of H(L("encryption-key") ‖ pk), as 32 lowercase hex characters, ungrouped. */
export function fingerprint(pk: Buffer): string {
  return sha256(labelBytes("encryption-key"), bytes(pk, "the public key", 32)).subarray(0, 16).toString("hex");
}

// ---------------------------------------------------------------------------
// 2. Containers and generations

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A sealed pair: 0x01 ‖ lo ‖ hi, the two peer ids in ascending byte order. */
export function pairContainer(a: Buffer, b: Buffer): Buffer {
  const first = bytes(a, "a peer id", 32);
  const second = bytes(b, "a peer id", 32);
  const order = Buffer.compare(first, second);
  if (order === 0) throw new RangeError("a sealed pair is two different peer ids");
  return order < 0 ? Buffer.concat([Buffer.of(0x01), first, second]) : Buffer.concat([Buffer.of(0x01), second, first]);
}

/** A sealed SPACE: 0x02 ‖ uuid(space_id), the uuid's sixteen bytes in network order. */
export function spaceContainer(spaceId: string): Buffer {
  if (typeof spaceId !== "string" || !UUID.test(spaceId)) {
    throw new TypeError(`${String(spaceId)} is not a uuid written in lowercase`);
  }
  return Buffer.concat([Buffer.of(0x02), Buffer.from(spaceId.replaceAll("-", ""), "hex")]);
}

function checkedContainer(c: Buffer): Buffer {
  const container = bytes(c, "the container");
  const pair = container.length === 65 && container[0] === 0x01;
  const space = container.length === 17 && container[0] === 0x02;
  if (!pair && !space) throw new RangeError("a container is 0x01 and two peer ids, or 0x02 and a uuid");
  return container;
}

function checkedGeneration(g: number, least: 1 | 2): number {
  if (!Number.isSafeInteger(g) || g < least) {
    throw new RangeError(`generation ${String(g)} is not a whole number from ${least}`);
  }
  return g;
}

/** commitment_g = H(L("sealed-commitment") ‖ C ‖ u64(g) ‖ secret_g). */
export function commitment(container: Buffer, g: number, secret: Buffer): Buffer {
  return sha256(
    labelBytes("sealed-commitment"),
    checkedContainer(container),
    u64(checkedGeneration(g, 1)),
    bytes(secret, "the secret", 32),
  );
}

// ---------------------------------------------------------------------------
// 3. Locks

function lockInfo(container: Buffer, g: number): Buffer {
  return Buffer.concat([labelBytes("sealed-lock"), container, u64(g)]);
}

function lockAad(recipient: Buffer, sender: Buffer, commitmentG: Buffer): Buffer {
  return Buffer.concat([
    bytes(recipient, "the recipient", 32),
    bytes(sender, "the sender", 32),
    bytes(commitmentG, "the commitment", 32),
  ]);
}

/**
 * enc ‖ ct of SealAuth(pkR, info = L("sealed-lock") ‖ C ‖ u64(g), aad = recipient ‖ sender ‖
 * commitment_g, pt = secret_g, skS): 80 bytes. The commitment is taken as given, not checked
 * against the secret, so a test can make a lock whose commitment does not hold.
 */
export function sealLock(a: {
  container: Buffer;
  g: number;
  recipient: Buffer;
  sender: Buffer;
  commitment: Buffer;
  secret: Buffer;
  pkR: Buffer;
  skS: Buffer;
  ikmE: Buffer;
}): Buffer {
  const container = checkedContainer(a.container);
  const g = checkedGeneration(a.g, 1);
  const aad = lockAad(a.recipient, a.sender, a.commitment);
  const { enc, ct } = sealAuth(a.pkR, lockInfo(container, g), aad, bytes(a.secret, "the secret", 32), a.skS, a.ikmE);
  return Buffer.concat([enc, ct]);
}

/** OpenAuth with the sender's encryption key, then the commitment must hold: the secret, or a throw. */
export function openLock(a: {
  container: Buffer;
  g: number;
  recipient: Buffer;
  sender: Buffer;
  commitment: Buffer;
  lock: Buffer;
  skR: Buffer;
  pkS: Buffer;
}): Buffer {
  const container = checkedContainer(a.container);
  const g = checkedGeneration(a.g, 1);
  const lock = bytes(a.lock, "a lock", 80);
  const aad = lockAad(a.recipient, a.sender, a.commitment);
  const secret = openAuth(lock.subarray(0, 32), a.skR, lockInfo(container, g), aad, lock.subarray(32), a.pkS);
  if (!timingSafeEqual(commitment(container, g, secret), a.commitment)) {
    throw new Error("the lock opened, but its secret does not hold to the commitment");
  }
  return secret;
}

// ---------------------------------------------------------------------------
// 4. The chain

function chainKey(container: Buffer, g: number, secretG: Buffer): Buffer {
  const info = Buffer.concat([labelBytes("sealed-chain"), container, u64(g)]);
  return hkdf(EMPTY, bytes(secretG, "secret_g", 32), info, 16);
}

/** back_g = AES(HKDF(empty, secret_g, L("sealed-chain") ‖ C ‖ u64(g), 16), secret_(g-1), C ‖ u64(g-1)): 48 bytes. */
export function sealBack(container: Buffer, g: number, secretG: Buffer, secretPrevious: Buffer): Buffer {
  const c = checkedContainer(container);
  const generation = checkedGeneration(g, 2);
  const aad = Buffer.concat([c, u64(generation - 1)]);
  return aeadSeal(chainKey(c, generation, secretG), ZERO_NONCE, aad, bytes(secretPrevious, "secret_(g-1)", 32));
}

/**
 * secret_(g-1) from back_g, or a throw when it does not authenticate. The spec's next step,
 * that commitment_(g-1) holds, is the caller's: this signature is not given that commitment.
 */
export function openBack(container: Buffer, g: number, secretG: Buffer, back: Buffer): Buffer {
  const c = checkedContainer(container);
  const generation = checkedGeneration(g, 2);
  const aad = Buffer.concat([c, u64(generation - 1)]);
  return aeadOpen(chainKey(c, generation, secretG), ZERO_NONCE, aad, bytes(back, "a back link", 48));
}

// ---------------------------------------------------------------------------
// 5. Items

const SALT = /^[0-9a-f]{32}$/;

/** The header's "salt": 32 lowercase hex characters, used as the 16 bytes they write. */
function saltOf(header: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header));
  } catch {
    throw new Error("the header is not JSON in UTF-8");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the header is not a JSON object");
  }
  const salt = (parsed as Record<string, unknown>)["salt"];
  if (typeof salt !== "string" || !SALT.test(salt)) {
    throw new Error("the header's salt is not 32 lowercase hex characters");
  }
  return Buffer.from(salt, "hex");
}

/** hd = H(L("sealed-header") ‖ header), over the header's bytes exactly as given. */
export function headerDigest(header: Buffer): Buffer {
  return sha256(labelBytes("sealed-header"), bytes(header, "the header"));
}

function itemKey(header: Buffer, secret: Buffer): { hd: Buffer; k: Buffer } {
  const h = bytes(header, "the header");
  const hd = headerDigest(h);
  const k = hkdf(saltOf(h), bytes(secret, "the secret", 32), Buffer.concat([labelBytes("sealed-item"), hd]), 16);
  return { hd, k };
}

/** ct = AES(HKDF(salt, secret_g, L("sealed-item") ‖ hd, 16), content, aad = hd). */
export function sealItem(header: Buffer, secret: Buffer, content: Buffer): Buffer {
  const { hd, k } = itemKey(header, secret);
  return aeadSeal(k, ZERO_NONCE, hd, bytes(content, "the content"));
}

/** The content's bytes, or a throw when the ciphertext does not authenticate under this header and secret. */
export function openItem(header: Buffer, secret: Buffer, ct: Buffer): Buffer {
  const { hd, k } = itemKey(header, secret);
  return aeadOpen(k, ZERO_NONCE, hd, ct);
}
