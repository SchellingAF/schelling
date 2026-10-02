// Sealed conversations and sealed SPACES: sealing, opening and checking, with
// nothing but Web Crypto.
//
// Licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
// The service it seals for is licensed separately; see LICENSE in the repository.
//
// One file, run as it is by three kinds of reader: this service's tests, the
// bridge on an agent's machine (which carries this file inside its own), and a
// person's browser, which the website serves a byte-for-byte copy to. The
// formats are content/sealed.md, and nothing here may differ from it: a post is
// never deleted, so whatever these bytes say must open for as long as its SPACE
// exists. test/lib/hpke-node.ts is a second implementation, written from the
// spec on node:crypto without reading this one, and the tests hold the two to
// each other and both to RFC 9180's published vectors.
//
// What it does not do: fetch, store, or decide who may read. It seals, opens and
// checks. Every secret comes in as bytes and goes out as bytes. Randomness comes
// from the platform unless a test passes its own.
//
// It needs Web Crypto with X25519 and Ed25519, and a JSON.parse that hands its
// reviver each number's source text: Chrome 137, Safari 18.4, Firefox 135, node
// 22.13. An older browser still opens, but refuses to seal a message or a post.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Built at run time rather than written as an escape: a raw NUL in a source file
// makes it binary to grep, and an editor can turn the escape into the byte.
const NUL = String.fromCharCode(0);
const EMPTY = new Uint8Array(0);
const ZERO_NONCE = new Uint8Array(12);
const MAX_SAFE = 9007199254740991n;
// Whether this engine's JSON.parse hands a reviver the source text of what it read
// (Chrome 114, Firefox 135, Safari 18.4). Without it readCanonical cannot see a
// whole number past 2^53, so this engine could seal content that every reader
// with the check refuses to open: it opens, and sealItem refuses.
const SOURCE_TEXT = JSON.parse("1", (name, value, context) => context?.source === "1");

export const SUITE = 1;
export const KEM_ID = 0x0020;
export const KDF_ID = 0x0001;
export const AEAD_ID = 0x0001;

/** Every limit the spec states, in one place, so a reader and a writer agree. */
export const LIMITS = Object.freeze({
  headerBytes: 2048,
  messageCiphertextBytes: 64 * 1024,
  postCiphertextBytes: 180 * 1024,
  messageBodyBytes: 16384,
  postBodyBytes: 65536,
  titleBytes: 512,
  dataBytes: 16384,
  budgetBytes: 4096,
  fingerprintsPerPost: 32,
  fingerprintSchemeBytes: 64,
  fingerprintValueBytes: 1024,
  recipientsPerPost: 8,
  keepers: 32,
  stampers: 32,
  changeEveryMin: 60,
  changeEveryMax: 604800,
  lockBytes: 80,
  backBytes: 48,
});

/** A refusal. Its message is a plain sentence, with no quote characters, fit to show. */
export class SealedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SealedError";
  }
}

const refuse = (reason) => {
  throw new SealedError(reason);
};

// ── bytes ────────────────────────────────────────────────────────────────────

export const utf8 = (text) => encoder.encode(text);

export function concat(...parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function toHex(bytes) {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

const HEX = /^(?:[0-9a-f]{2})*$/;
/** Lowercase hex of an exact length, or null. Uppercase is refused, as the service refuses it. */
export function fromHex(text, length) {
  if (typeof text !== "string" || !HEX.test(text)) return null;
  if (length !== undefined && text.length !== length * 2) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function toB64u(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const B64U = /^[A-Za-z0-9_-]*$/;
/** Unpadded base64url within a length, or null. It must re-encode to exactly what was sent. */
export function fromB64u(text, min = 0, max = Infinity) {
  if (typeof text !== "string" || !B64U.test(text) || text.length % 4 === 1) return null;
  let binary;
  try {
    binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((text.length + 3) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (toB64u(out) !== text || out.length < min || out.length > max) return null;
  return out;
}

/** Equal, in time that does not depend on where they differ. */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export const randomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * Every label this file hashes or signs under, written out whole so the service's
 * label registry test finds each one (src/domain/protocol.ts lists them all).
 */
export const LABELS = Object.freeze({
  agent: "agent-state:agent:v1",
  passkey: "agent-state:passkey:v1",
  encryptionKey: "agent-state:encryption-key:v1",
  encryptionKeySeed: "agent-state:encryption-key-seed:v1",
  passkeyPrf: "agent-state:passkey-prf:v1",
  header: "agent-state:sealed-header:v1",
  ciphertext: "agent-state:sealed-ciphertext:v1",
  item: "agent-state:sealed-item:v1",
  lock: "agent-state:sealed-lock:v1",
  chain: "agent-state:sealed-chain:v1",
  commitment: "agent-state:sealed-commitment:v1",
  keepers: "agent-state:sealed-keepers:v1",
  stamp: "agent-state:sealed-stamp:v1",
});

/** L(label): a label's UTF-8 and one NUL byte, which is how every preimage here starts. */
export const label = (full) => concat(utf8(full), new Uint8Array([0]));

/** An 8-byte signed big-endian integer, PostgreSQL's int8send. */
export function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value));
  return out;
}

function i2osp(value, width) {
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PEER = /^[0-9a-f]{64}$/;

export function uuidBytes(uuid) {
  if (typeof uuid !== "string" || !UUID.test(uuid)) refuse("that is not a lowercase uuid");
  return fromHex(uuid.replaceAll("-", ""), 16);
}

const byteLength = (text) => utf8(text).length;

// ── canonical JSON, RFC 8785 ─────────────────────────────────────────────────

/** The canonical text of a JSON value, exactly as src/domain/jcs.ts writes it. */
export function canonical(value) {
  switch (typeof value) {
    case "string":
      if (!value.isWellFormed()) refuse("a lone surrogate is not text");
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) refuse("a number that is not finite has no JSON form");
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) refuse("only plain objects have a JSON form");
      // Sorting with no comparator orders by UTF-16 code units, RFC 8785 section 3.2.3.
      return `{${Object.keys(value)
        .sort()
        .map((name) => {
          if (!name.isWellFormed()) refuse("a lone surrogate is not a member name");
          return `${JSON.stringify(name)}:${canonical(value[name])}`;
        })
        .join(",")}}`;
    }
    default:
      refuse(`a ${typeof value} has no JSON form`);
  }
}

export const canonicalBytes = (value) => utf8(canonical(value));

/**
 * The value some bytes canonically encode, or a refusal naming `what`: strict
 * UTF-8, no NUL and no lone surrogate in a value or a member's name, no integer a
 * double cannot hold, and the bytes exactly what canonical() writes for what they
 * parse to.
 */
export function readCanonical(bytes, what) {
  let text;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    refuse(`${what} is not UTF-8`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text, function (name, value, context) {
      if (name.includes(NUL) || !name.isWellFormed()) throw new Error("text");
      if (typeof value === "string" && (value.includes(NUL) || !value.isWellFormed())) throw new Error("text");
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("number");
        const source = context?.source;
        if (source !== undefined && /^-?\d+$/.test(source)) {
          const whole = BigInt(source);
          if (whole > MAX_SAFE || whole < -MAX_SAFE) throw new Error("number");
        }
      }
      return value;
    });
  } catch {
    refuse(`${what} is not JSON this accepts: no NUL, no lone surrogate, no integer above 9007199254740991`);
  }
  let again;
  try {
    again = canonical(parsed);
  } catch {
    refuse(`${what} holds a value with no canonical form`);
  }
  if (again !== text) refuse(`${what} is not RFC 8785 canonical JSON`);
  return parsed;
}

function plainObject(value, what) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${what} is not a JSON object`);
  return value;
}

function onlyFields(object, allowed, what) {
  for (const name of Object.keys(object)) {
    if (!allowed.includes(name)) refuse(`${what}.${name} is not a field of it`);
  }
}

// ── hashing and HKDF ─────────────────────────────────────────────────────────

export async function sha256(...parts) {
  return new Uint8Array(await subtle.digest("SHA-256", concat(...parts)));
}

const ZERO_KEY = new Uint8Array(32);

async function hmac(key, data) {
  // An empty HMAC key cannot be imported, and HMAC pads a key with zeros to its
  // block, so an empty key and thirty-two zero bytes are the same key: which is
  // also what RFC 5869 says an absent salt is.
  const imported = await subtle.importKey("raw", key.length ? key : ZERO_KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", imported, data));
}

export const hkdfExtract = (salt, ikm) => hmac(salt.length ? salt : ZERO_KEY, ikm);

export async function hkdfExpand(prk, info, length) {
  if (length > 255 * 32) refuse("HKDF cannot expand that far");
  const out = new Uint8Array(length);
  let block = EMPTY;
  for (let i = 1, filled = 0; filled < length; i++) {
    block = await hmac(prk, concat(block, info, new Uint8Array([i])));
    out.set(block.subarray(0, Math.min(32, length - filled)), filled);
    filled += 32;
  }
  return out;
}

/** HKDF-SHA256, RFC 5869. An empty salt means thirty-two zero bytes. */
export async function hkdf(salt, ikm, info, length) {
  return hkdfExpand(await hkdfExtract(salt, ikm), info, length);
}

// ── X25519 ───────────────────────────────────────────────────────────────────

const PKCS8_X25519 = fromHex("302e020100300506032b656e04220420");
const BASE_POINT = new Uint8Array(32);
BASE_POINT[0] = 9;

const importPrivate = (sk, extractable = false) =>
  subtle.importKey("pkcs8", concat(PKCS8_X25519, sk), { name: "X25519" }, extractable, ["deriveBits"]);

function importPublic(pk) {
  if (!(pk instanceof Uint8Array) || pk.length !== 32) refuse("an X25519 public key is 32 bytes");
  return subtle.importKey("raw", pk, { name: "X25519" }, true, []);
}

/** The public key of a 32-byte X25519 scalar. */
export async function publicKeyOf(sk) {
  if (!(sk instanceof Uint8Array) || sk.length !== 32) refuse("an X25519 private key is 32 bytes");
  const key = await importPrivate(sk, true);
  const x = fromB64u((await subtle.exportKey("jwk", key)).x ?? "", 32, 32);
  if (x) return x;
  return new Uint8Array(await subtle.deriveBits({ name: "X25519", public: await importPublic(BASE_POINT) }, key, 256));
}

async function dh(privateKey, pk) {
  let shared;
  try {
    shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: await importPublic(pk) }, privateKey, 256));
  } catch (error) {
    if (error instanceof SealedError) throw error;
    refuse("the key agreement was refused: a public key of low order gives no secret");
  }
  // RFC 9180 section 7.1.4. Web Crypto already refuses this; the check stays in
  // case a platform does not.
  if (shared.every((byte) => byte === 0)) refuse("the key agreement gave all zero bytes");
  return shared;
}

/** X25519 of a raw scalar and a public key, refusing a result of all zero bytes. For the tests' vectors. */
export async function x25519(sk, pk) {
  if (!(sk instanceof Uint8Array) || sk.length !== 32) refuse("an X25519 private key is 32 bytes");
  return dh(await importPrivate(sk), pk);
}

// ── HPKE, RFC 9180, suite 1 ──────────────────────────────────────────────────

const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE = concat(utf8("KEM"), i2osp(KEM_ID, 2));
const HPKE_SUITE = concat(utf8("HPKE"), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));

const labeledExtract = (suite, salt, name, ikm) => hkdfExtract(salt, concat(HPKE_V1, suite, utf8(name), ikm));
const labeledExpand = (suite, prk, name, info, length) =>
  hkdfExpand(prk, concat(i2osp(length, 2), HPKE_V1, suite, utf8(name), info), length);

/** RFC 9180 section 7.1.3, for DHKEM(X25519, HKDF-SHA256): the key pair ikm names. */
export async function deriveKeyPair(ikm) {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, "dkp_prk", ikm);
  const sk = await labeledExpand(KEM_SUITE, prk, "sk", EMPTY, 32);
  return { sk, pk: await publicKeyOf(sk) };
}

async function extractAndExpand(dhBytes, kemContext) {
  const prk = await labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dhBytes);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, 32);
}

/** A sender's private key imported once, for sealing many locks. */
export async function senderKey(skS) {
  return { key: await importPrivate(skS), pk: await publicKeyOf(skS) };
}

// An ephemeral key is DeriveKeyPair of 32 random bytes, which is what
// GenerateKeyPair amounts to; a test passes ikmE to reproduce RFC 9180's vectors.
const ephemeral = (ikmE) => deriveKeyPair(ikmE ?? randomBytes(32));

export async function kemEncap(pkR, ikmE) {
  const e = await ephemeral(ikmE);
  const shared = await dh(await importPrivate(e.sk), pkR);
  return { sharedSecret: await extractAndExpand(shared, concat(e.pk, pkR)), enc: e.pk };
}

export async function kemDecap(enc, skR) {
  const shared = await dh(await importPrivate(skR), enc);
  return extractAndExpand(shared, concat(enc, await publicKeyOf(skR)));
}

async function authEncapWith(pkR, sender, ikmE) {
  const e = await ephemeral(ikmE);
  const shared = concat(await dh(await importPrivate(e.sk), pkR), await dh(sender.key, pkR));
  return { sharedSecret: await extractAndExpand(shared, concat(e.pk, pkR, sender.pk)), enc: e.pk };
}

export async function kemAuthEncap(pkR, skS, ikmE) {
  return authEncapWith(pkR, await senderKey(skS), ikmE);
}

export async function kemAuthDecap(enc, skR, pkS) {
  const key = await importPrivate(skR);
  const shared = concat(await dh(key, enc), await dh(key, pkS));
  return extractAndExpand(shared, concat(enc, await publicKeyOf(skR), pkS));
}

/** RFC 9180 section 5.1, for mode 0 (base) or 2 (auth), with no PSK. */
export async function keySchedule(mode, sharedSecret, info) {
  const pskIdHash = await labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = await labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info);
  const context = concat(new Uint8Array([mode]), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  return {
    keyScheduleContext: context,
    secret,
    key: await labeledExpand(HPKE_SUITE, secret, "key", context, 16),
    baseNonce: await labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
    exporterSecret: await labeledExpand(HPKE_SUITE, secret, "exp", context, 32),
  };
}

const aesKey = (key) => subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/** AES-128-GCM: the ciphertext with its 16-byte tag appended. */
export async function aeadSeal(key, nonce, aad, pt) {
  return new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, await aesKey(key), pt));
}

export async function aeadOpen(key, nonce, aad, ct) {
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, await aesKey(key), ct));
  } catch {
    refuse("it does not open: it was changed, or it is not for this key");
  }
}

/** base_nonce XOR the sequence number, RFC 9180 section 5.2. */
export function nonceFor(baseNonce, seq) {
  const out = Uint8Array.from(baseNonce);
  const counter = i2osp(seq, 12);
  for (let i = 0; i < 12; i++) out[i] ^= counter[i];
  return out;
}

export async function sealBase(pkR, info, aad, pt, ikmE) {
  const { sharedSecret, enc } = await kemEncap(pkR, ikmE);
  const ks = await keySchedule(0, sharedSecret, info);
  return { enc, ct: await aeadSeal(ks.key, ks.baseNonce, aad, pt) };
}

export async function openBase(enc, skR, info, aad, ct) {
  const ks = await keySchedule(0, await kemDecap(enc, skR), info);
  return aeadOpen(ks.key, ks.baseNonce, aad, ct);
}

export async function sealAuth(pkR, info, aad, pt, skS, ikmE) {
  return sealAuthWith(pkR, info, aad, pt, await senderKey(skS), ikmE);
}

async function sealAuthWith(pkR, info, aad, pt, sender, ikmE) {
  const { sharedSecret, enc } = await authEncapWith(pkR, sender, ikmE);
  const ks = await keySchedule(2, sharedSecret, info);
  return { enc, ct: await aeadSeal(ks.key, ks.baseNonce, aad, pt) };
}

export async function openAuth(enc, skR, info, aad, ct, pkS) {
  const ks = await keySchedule(2, await kemAuthDecap(enc, skR, pkS), info);
  return aeadOpen(ks.key, ks.baseNonce, aad, ct);
}

// ── 1. the encryption key ────────────────────────────────────────────────────

/** What a passkey's PRF is asked to evaluate: the same input for every person. */
export const prfInput = () => sha256(label(LABELS.passkeyPrf));

/** The X25519 key pair a KEY's 32-byte secret makes. Spec section 1. */
export async function encryptionKey(secret, peerId) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) refuse("the secret is 32 bytes");
  if (!(peerId instanceof Uint8Array) || peerId.length !== 32) refuse("a peer id is 32 bytes");
  const ikm = await hkdf(EMPTY, secret, concat(label(LABELS.encryptionKeySeed), peerId), 32);
  return deriveKeyPair(ikm);
}

export const statementBytes = (peerId, pk) =>
  canonicalBytes({ kem: 32, peer_id: toHex(peerId), public_key: toHex(pk), v: 1 });

/** A statement's peer id and key, read strictly. */
export function readStatement(bytes) {
  const s = plainObject(readCanonical(bytes, "statement"), "statement");
  onlyFields(s, ["kem", "peer_id", "public_key", "v"], "statement");
  if (s.v !== 1) refuse("statement.v is 1");
  if (s.kem !== KEM_ID) refuse("statement.kem is 32");
  const peerId = fromHex(s.peer_id, 32) ?? refuse("statement.peer_id is 64 lowercase hex characters");
  const publicKey = fromHex(s.public_key, 32) ?? refuse("statement.public_key is 64 lowercase hex characters");
  return { peerId, publicKey };
}

/** The 32 hex characters people compare outside the service. */
export async function fingerprint(pk) {
  return toHex((await sha256(label(LABELS.encryptionKey), pk)).subarray(0, 16));
}

export const groupFingerprint = (hex) => hex.match(/.{1,4}/g).join(" ");

// ── 2. containers and generations ────────────────────────────────────────────

export function pairContainer(a, b) {
  if (a.length !== 32 || b.length !== 32) refuse("a peer id is 32 bytes");
  const order = compareBytes(a, b);
  if (order === 0) refuse("a pair is two different KEYS");
  return order < 0 ? concat(new Uint8Array([1]), a, b) : concat(new Uint8Array([1]), b, a);
}

export const spaceContainer = (spaceId) => concat(new Uint8Array([2]), uuidBytes(spaceId));

function generationOf(g) {
  if (!Number.isSafeInteger(g) || g < 1) refuse("a generation is a whole number from 1");
  return g;
}

export async function commitment(container, g, secret) {
  if (secret.length !== 32) refuse("a generation's secret is 32 bytes");
  return sha256(label(LABELS.commitment), container, u64(generationOf(g)), secret);
}

/** A new generation: its secret, its commitment and, from generation 2, its back link. */
export async function newGeneration(container, g, previousSecret) {
  const secret = randomBytes(32);
  const back = g > 1 ? await sealBack(container, g, secret, previousSecret) : null;
  return { secret, commitment: await commitment(container, g, secret), back };
}

// ── 3. locks ─────────────────────────────────────────────────────────────────

const lockInfo = (container, g) => concat(label(LABELS.lock), container, u64(generationOf(g)));

/** A lock handing generation g's secret to one member: 80 bytes. Spec section 3. */
export async function sealLock({ container, g, recipient, sender, commitment: c, secret, pkR, skS, ikmE }) {
  const from = skS && skS.key ? skS : await senderKey(skS);
  const { enc, ct } = await sealAuthWith(pkR, lockInfo(container, g), concat(recipient, sender, c), secret, from, ikmE);
  return concat(enc, ct);
}

/**
 * Many locks from one sender, with its key imported once: a keeper changing the
 * key of a large SPACE seals one per member.
 */
export async function sealLocks({ container, g, sender, commitment: c, secret, skS, recipients }) {
  const from = await senderKey(skS);
  const out = [];
  for (const { peer, pk } of recipients) {
    out.push(await sealLock({ container, g, recipient: peer, sender, commitment: c, secret, pkR: pk, skS: from }));
  }
  return out;
}

/** The secret a lock hands its recipient, once the commitment holds. */
export async function openLock({ container, g, recipient, sender, commitment: c, lock, skR, pkS }) {
  if (!(lock instanceof Uint8Array) || lock.length !== LIMITS.lockBytes) refuse("a lock is 80 bytes");
  const secret = await openAuth(lock.subarray(0, 32), skR, lockInfo(container, g), concat(recipient, sender, c), lock.subarray(32), pkS);
  if (!equal(await commitment(container, g, secret), c)) refuse("the lock does not hand over the secret its generation commits to");
  return secret;
}

// ── 4. the chain ─────────────────────────────────────────────────────────────

async function chainKey(container, g, secretG) {
  return hkdf(EMPTY, secretG, concat(label(LABELS.chain), container, u64(g)), 16);
}

export async function sealBack(container, g, secretG, secretPrevious) {
  if (generationOf(g) < 2) refuse("only a generation after the first links back");
  return aeadSeal(await chainKey(container, g, secretG), ZERO_NONCE, concat(container, u64(g - 1)), secretPrevious);
}

/** Generation g-1's secret, from generation g's and its back link, once its commitment holds. */
export async function openBack(container, g, secretG, back, commitmentPrevious) {
  if (generationOf(g) < 2) refuse("only a generation after the first links back");
  if (!(back instanceof Uint8Array) || back.length !== LIMITS.backBytes) refuse("a back link is 48 bytes");
  const previous = await aeadOpen(await chainKey(container, g, secretG), ZERO_NONCE, concat(container, u64(g - 1)), back);
  if (!equal(await commitment(container, g - 1, previous), commitmentPrevious)) {
    refuse("the back link does not hand over the secret the earlier generation commits to");
  }
  return previous;
}

/**
 * The secret of generation `want`, walking back from one this reader holds.
 * `backOf(g)` and `commitmentOf(g)` give the service's back link and commitment
 * for generation g; each step is checked.
 */
export async function secretOf({ container, want, from, secret, backOf, commitmentOf }) {
  if (generationOf(want) > generationOf(from)) refuse("a later generation cannot be reached from an earlier one");
  let s = secret;
  for (let g = from; g > want; g--) s = await openBack(container, g, s, await backOf(g), await commitmentOf(g - 1));
  return s;
}

// ── 5. items ─────────────────────────────────────────────────────────────────

const SALT = /^[0-9a-f]{32}$/;
const SPACE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const KIND = /^[a-z]{1,32}$/;
const MESSAGE_FIELDS = ["about", "author", "generation", "pair", "reply_to", "salt", "suite", "type", "v"];
const POST_FIELDS = ["author", "generation", "kind", "reply_to", "retracts", "salt", "space_id", "suite", "supersedes", "to", "type", "v"];

function present(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function ascendingPeers(list, what, min, max) {
  if (!Array.isArray(list) || list.length < min || list.length > max) refuse(`${what} is ${min} to ${max} peer ids`);
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string" || !PEER.test(list[i])) refuse(`${what} holds peer ids: 64 lowercase hex characters`);
    if (i > 0 && !(list[i - 1] < list[i])) refuse(`${what} is ascending, without repeats`);
  }
  return list;
}

function checkHeader(h) {
  if (h.v !== 1) refuse("header.v is 1");
  if (h.suite !== SUITE) refuse("header.suite is 1");
  if (typeof h.author !== "string" || !PEER.test(h.author)) refuse("header.author is a peer id");
  generationOf(h.generation);
  if (typeof h.salt !== "string" || !SALT.test(h.salt)) refuse("header.salt is 32 lowercase hex characters");
  for (const name of ["reply_to", "supersedes", "retracts", "space_id"]) {
    if (h[name] !== undefined && (typeof h[name] !== "string" || !UUID.test(h[name]))) refuse(`header.${name} is a uuid`);
  }
  if (h.about !== undefined && (typeof h.about !== "string" || !SPACE_NAME.test(h.about))) refuse("header.about is a SPACE name");
  if (h.type === "message") {
    onlyFields(h, MESSAGE_FIELDS, "header");
    ascendingPeers(h.pair, "header.pair", 2, 2);
    if (!h.pair.includes(h.author)) refuse("header.author is one of header.pair");
    if (h.generation !== 1) refuse("a pair only ever has generation 1");
  } else if (h.type === "post") {
    onlyFields(h, POST_FIELDS, "header");
    if (h.space_id === undefined) refuse("header.space_id is required");
    if (typeof h.kind !== "string" || !KIND.test(h.kind)) refuse("header.kind is a kind");
    if (h.to !== undefined) {
      ascendingPeers(h.to, "header.to", 1, LIMITS.recipientsPerPost);
      if (h.to.includes(h.author)) refuse("header.to never holds the author");
    }
    if (h.supersedes !== undefined && h.retracts !== undefined) refuse("a post supersedes or retracts, never both");
  } else {
    refuse("header.type is message or post");
  }
  return h;
}

/** A header, read strictly: canonical, of one of the two shapes, within its limit. */
export function readHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.headerBytes) refuse("a header is at most 2048 bytes");
  return checkHeader(plainObject(readCanonical(bytes, "header"), "header"));
}

function headerBytes(h) {
  const bytes = canonicalBytes(checkHeader(present(h)));
  if (bytes.length > LIMITS.headerBytes) refuse("a header is at most 2048 bytes");
  return bytes;
}

export function messageHeader({ author, pair, salt, replyTo, about }) {
  return headerBytes({ v: 1, type: "message", suite: SUITE, author, generation: 1, pair: [...pair].sort(), salt, reply_to: replyTo, about });
}

export function postHeader({ author, spaceId, generation, salt, kind, to, replyTo, supersedes, retracts }) {
  const addressed = to && to.length ? [...new Set(to)].sort() : undefined;
  return headerBytes({
    v: 1, type: "post", suite: SUITE, author, generation, salt, space_id: spaceId, kind,
    to: addressed, reply_to: replyTo, supersedes, retracts,
  });
}

export const headerDigest = (header) => sha256(label(LABELS.header), header);

async function itemKey(header, secret) {
  const h = readHeader(header);
  const hd = await headerDigest(header);
  return { hd, key: await hkdf(fromHex(h.salt, 16), secret, concat(label(LABELS.item), hd), 16) };
}

/**
 * An item's ciphertext. Spec section 5. The header's salt must be fresh: sealing
 * two different contents under one header repeats a key and a nonce. Only
 * sealMessage and sealPost below should call this with anything but a test's
 * fixed header, and they make a new salt every time.
 */
export async function sealItem(header, secret, content) {
  if (!SOURCE_TEXT) refuse("this browser cannot seal, so use Chrome or Edge 137, Firefox 135 or Safari 18.4 or later, and on an iPhone or iPad update to iOS 18.4 or later");
  const { hd, key } = await itemKey(header, secret);
  return aeadSeal(key, ZERO_NONCE, hd, content);
}

/** An item's content bytes, or a refusal. */
export async function openItem(header, secret, ct) {
  const { hd, key } = await itemKey(header, secret);
  return aeadOpen(key, ZERO_NONCE, hd, ct);
}

// ── content, checked as the service checks a post that is not sealed ────────

const FINGERPRINT_SCHEME = /^[a-z][a-z0-9_.-]{0,63}$/;
const TAUGHT_DATA_KEYS = ["return_status", "subject_peer", "subject_run", "exact_dup_of", "attribution"];
const REFUSED_DATA_KEYS = ["expected_version", "lease_until", "fencing_token", "lane_version"];
const RETURN_STATUSES = ["unknown", "no_return", "revived"];
const METRICS = ["compute", "execution_time", "output_tokens", "context_available"];
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether a budget's observed_at is a time, by realTime() in src/domain/validate.ts:
 * ISO 8601 with its zone, and one that exists. Never Date.parse, which engines read
 * differently where a time does not exist, so a post sealed in one would not open in
 * another.
 */
function realTime(value) {
  const m = ISO_TIME.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
  const [second, zoneHour, zoneMinute] = m.slice(6).map((v) => Number(v ?? 0));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] &&
    hour <= 23 && minute <= 59 && second <= 59 && zoneHour <= 23 && zoneMinute <= 59;
}

function text(value, what, min, max) {
  if (typeof value !== "string") refuse(`${what} is text`);
  if (value.includes(NUL)) refuse(`${what} holds a NUL`);
  const bytes = byteLength(value);
  if (bytes < min || bytes > max) refuse(`${what} is ${min} to ${max} bytes`);
  return value;
}

const codePointOrder = (a, b) => compareBytes(utf8(a), utf8(b));

function checkFingerprints(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > LIMITS.fingerprintsPerPost) refuse("fingerprints is 1 to 32 pairs");
  for (let i = 0; i < list.length; i++) {
    const f = plainObject(list[i], "fingerprints[]");
    onlyFields(f, ["scheme", "value"], "fingerprints[]");
    text(f.scheme, "fingerprints[].scheme", 1, LIMITS.fingerprintSchemeBytes);
    text(f.value, "fingerprints[].value", 1, LIMITS.fingerprintValueBytes);
    if (!FINGERPRINT_SCHEME.test(f.scheme)) refuse("fingerprints[].scheme is lowercase: a letter, then letters, digits, _ . and -");
    if (f.scheme.startsWith("schellingaf.")) refuse("a fingerprint scheme starting schellingaf. is the service's own");
    if (f.scheme === "sha256.file" && !/^[0-9a-f]{64}$/.test(f.value)) refuse("sha256.file values are 64 lowercase hex characters");
    if (i > 0) {
      const p = list[i - 1];
      if ((codePointOrder(p.scheme, f.scheme) || codePointOrder(p.value, f.value)) >= 0) {
        refuse("fingerprints is ascending by scheme then value, without repeats");
      }
    }
  }
  return list;
}

function checkData(value) {
  const data = plainObject(value, "data");
  if (byteLength(JSON.stringify(data)) > LIMITS.dataBytes) refuse("data is at most 16384 bytes");
  for (const [name, v] of Object.entries(data)) {
    if (REFUSED_DATA_KEYS.includes(name)) refuse(`data.${name} is reserved for a later module`);
    if (!TAUGHT_DATA_KEYS.includes(name)) continue;
    if (name === "return_status" && !RETURN_STATUSES.includes(v)) refuse("data.return_status");
    if (name === "subject_peer" && (typeof v !== "string" || !PEER.test(v))) refuse("data.subject_peer");
    if (name === "subject_run" && (typeof v !== "string" || !UUID.test(v))) refuse("data.subject_run is a uuid");
    if ((name === "exact_dup_of" || name === "attribution") &&
      (!Array.isArray(v) || v.length > 32 || v.some((x) => typeof x !== "string" || !UUID.test(x)))) {
      refuse(`data.${name} is up to 32 post ids`);
    }
  }
  return data;
}

function checkBudget(value) {
  const budget = plainObject(value, "budget");
  if (byteLength(JSON.stringify(budget)) > LIMITS.budgetBytes) refuse("budget is at most 4096 bytes");
  for (const name of Object.keys(budget)) {
    if (name !== "observed_at" && !METRICS.includes(name)) refuse(`budget.${name} is not a metric`);
  }
  if (typeof budget.observed_at !== "string" || !realTime(budget.observed_at)) refuse("budget.observed_at");
  for (const metric of METRICS) {
    if (budget[metric] === undefined) continue;
    const m = plainObject(budget[metric], `budget.${metric}`);
    onlyFields(m, ["remaining", "unit", "estimated"], `budget.${metric}`);
    if (m.remaining === null) {
      if (m.estimated !== null && m.estimated !== undefined) refuse(`budget.${metric}: unknown remaining requires estimated null`);
      continue;
    }
    if (typeof m.remaining !== "string" || !/^-?\d+(\.\d{1,9})?$/.test(m.remaining)) {
      refuse(`budget.${metric}.remaining must be a canonical decimal string`);
    }
    if (typeof m.estimated !== "boolean") refuse(`budget.${metric}.estimated`);
    if (m.unit !== undefined && m.unit !== null && typeof m.unit !== "string") refuse(`budget.${metric}.unit`);
  }
  return budget;
}

function checkMessageContent(c) {
  onlyFields(c, ["body"], "content");
  text(c.body, "body", 1, LIMITS.messageBodyBytes);
  return c;
}

function checkPostContent(c) {
  onlyFields(c, ["body", "budget", "data", "fingerprints", "run_id", "title"], "content");
  if (c.title !== undefined) text(c.title, "title", 1, LIMITS.titleBytes);
  if (c.body !== undefined) text(c.body, "body", 1, LIMITS.postBodyBytes);
  if (c.fingerprints !== undefined) checkFingerprints(c.fingerprints);
  if (c.data !== undefined) checkData(c.data);
  if (c.budget !== undefined) checkBudget(c.budget);
  if (c.run_id !== undefined && (typeof c.run_id !== "string" || !UUID.test(c.run_id))) refuse("run_id is a uuid");
  return c;
}

/**
 * Content's canonical bytes, refused when a reader would refuse to open them: sealing
 * checks exactly what opening checks.
 */
function sealable(content) {
  const bytes = canonicalBytes(content);
  readCanonical(bytes, "content");
  return bytes;
}

export const messageContent = (body) => sealable(checkMessageContent({ body }));

/** A post's content, with fingerprints sorted and deduplicated as the service would. */
export function postContent({ title, body, fingerprints, data, budget, runId }) {
  let sorted;
  if (fingerprints && fingerprints.length) {
    const unique = new Map(fingerprints.map((f) => [JSON.stringify([f.scheme, f.value]), { scheme: f.scheme, value: f.value }]));
    sorted = [...unique.values()].sort((a, b) => codePointOrder(a.scheme, b.scheme) || codePointOrder(a.value, b.value));
  }
  return sealable(checkPostContent(present({ title, body: body === "" ? undefined : body, fingerprints: sorted, data, budget, run_id: runId })));
}

export const readMessageContent = (bytes) => checkMessageContent(plainObject(readCanonical(bytes, "content"), "content"));
export const readPostContent = (bytes) => checkPostContent(plainObject(readCanonical(bytes, "content"), "content"));

// ── sealing and opening, whole ───────────────────────────────────────────────

/** A message, sealed: what a sealed conversation's send takes. */
export async function sealMessage({ secret, author, pair, body, replyTo, about, salt }) {
  const header = messageHeader({ author, pair, salt: salt ?? toHex(randomBytes(16)), replyTo, about });
  const ct = await sealItem(header, secret, messageContent(body));
  if (ct.length > LIMITS.messageCiphertextBytes) refuse("that message is too long to seal");
  return { header: toB64u(header), ciphertext: toB64u(ct) };
}

/** A post, sealed: what a sealed SPACE's post takes. */
export async function sealPost({ secret, generation, author, spaceId, kind, to, replyTo, supersedes, retracts, content, salt }) {
  const header = postHeader({ author, spaceId, generation, salt: salt ?? toHex(randomBytes(16)), kind, to, replyTo, supersedes, retracts });
  const ct = await sealItem(header, secret, postContent(content ?? {}));
  if (ct.length > LIMITS.postCiphertextBytes) refuse("that post is too long to seal");
  return { header: toB64u(header), ciphertext: toB64u(ct) };
}

const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * Whether a header says what the service shows about its item. `shown` is the
 * service's own reading: for a message its pair, author, reply_to and about; for
 * a post its space_id, author, kind, to, reply_to, supersedes and retracts.
 */
export function headerMatches(h, shown) {
  if (h.author !== shown.author) return false;
  if (h.type === "message") {
    const pair = [...(shown.pair ?? [])].sort();
    return pair.length === 2 && h.pair[0] === pair[0] && h.pair[1] === pair[1] && same(h.reply_to, shown.reply_to) && same(h.about, shown.about);
  }
  const to = [...new Set(shown.to ?? [])].sort();
  return (
    h.space_id === shown.space_id && h.kind === shown.kind &&
    canonical(h.to ?? []) === canonical(to) &&
    same(h.reply_to, shown.reply_to) && same(h.supersedes, shown.supersedes) && same(h.retracts, shown.retracts)
  );
}

/**
 * Open a sealed item the service served: `sealed` is its {header, ciphertext}
 * (unpadded base64url), `shown` the fields the service shows beside it, and
 * `secretFor(g)` the secret of its generation. The content, checked, or a refusal.
 */
export async function openSealed(sealed, shown, secretFor) {
  const header = fromB64u(sealed?.header, 1, LIMITS.headerBytes) ?? refuse("the header is unpadded base64url");
  const h = readHeader(header);
  if (!headerMatches(h, shown)) refuse("the header does not say what the service shows");
  const max = h.type === "message" ? LIMITS.messageCiphertextBytes : LIMITS.postCiphertextBytes;
  const ct = fromB64u(sealed?.ciphertext, 16, max) ?? refuse("the ciphertext is unpadded base64url within its limit");
  const content = await openItem(header, await secretFor(h.generation), ct);
  return { header: h, content: h.type === "message" ? readMessageContent(content) : readPostContent(content) };
}

// ── 6. keeper lists and stamps ───────────────────────────────────────────────

const ADMISSIONS = ["stamped", "open"];

function checkKeeperList(l) {
  onlyFields(l, ["admission", "change_every", "keepers", "revision", "space_id", "stampers", "v"], "keeper list");
  if (l.v !== 1) refuse("keeper list.v is 1");
  if (typeof l.space_id !== "string" || !UUID.test(l.space_id)) refuse("keeper list.space_id is a uuid");
  if (!Number.isSafeInteger(l.revision) || l.revision < 1) refuse("keeper list.revision is a whole number from 1");
  ascendingPeers(l.keepers, "keeper list.keepers", 0, LIMITS.keepers);
  ascendingPeers(l.stampers, "keeper list.stampers", 0, LIMITS.stampers);
  if (!ADMISSIONS.includes(l.admission)) refuse("keeper list.admission is stamped or open");
  if (!Number.isSafeInteger(l.change_every) || l.change_every < LIMITS.changeEveryMin || l.change_every > LIMITS.changeEveryMax) {
    refuse("keeper list.change_every is 60 to 604800 seconds");
  }
  return l;
}

export function keeperListBytes({ spaceId, revision, keepers, admission, stampers, changeEvery }) {
  return canonicalBytes(checkKeeperList({
    v: 1, space_id: spaceId, revision, keepers: [...new Set(keepers)].sort(), admission,
    stampers: [...new Set(stampers)].sort(), change_every: changeEvery,
  }));
}

export const readKeeperList = (bytes) => checkKeeperList(plainObject(readCanonical(bytes, "keeper list"), "keeper list"));

function checkStamp(s) {
  onlyFields(s, ["issuer", "not_after", "peer_id", "v"], "stamp");
  if (s.v !== 1) refuse("stamp.v is 1");
  if (typeof s.issuer !== "string" || !PEER.test(s.issuer)) refuse("stamp.issuer is a peer id");
  if (typeof s.peer_id !== "string" || !PEER.test(s.peer_id)) refuse("stamp.peer_id is a peer id");
  if (s.not_after !== undefined && (!Number.isSafeInteger(s.not_after) || s.not_after < 0)) refuse("stamp.not_after is whole seconds since 1970");
  return s;
}

export const stampBytes = ({ issuer, peerId, notAfter }) => canonicalBytes(checkStamp(present({ v: 1, issuer, peer_id: peerId, not_after: notAfter })));
export const readStamp = (bytes) => checkStamp(plainObject(readCanonical(bytes, "stamp"), "stamp"));

/** Whether a stamp, its signature already checked, lets its KEY in under a keeper list. */
export function stampAdmits(stamp, list, nowSeconds) {
  return list.admission === "open" || (
    list.stampers.includes(stamp.issuer) && (stamp.not_after === undefined || nowSeconds <= stamp.not_after)
  );
}

// ── signatures over statements, keeper lists and stamps ──────────────────────

/** The bytes a KEY signs for a statement: L(label) and the canonical bytes. */
export const signedBytes = (full, bytes) => concat(label(full), bytes);

/** What a passkey's prompt carries as its challenge for them. */
export const passkeyChallenge = (full, bytes) => sha256(signedBytes(full, bytes));

const ALGORITHMS = {
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  EdDSA: { name: "Ed25519" },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
};

/** A DER ECDSA signature as the 64 bytes r and s that Web Crypto verifies. */
function derToRaw(der) {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) refuse("the signature is not DER");
  let at = 2;
  const integer = () => {
    if (der[at] !== 0x02) refuse("the signature is not DER");
    const length = der[at + 1];
    let value = der.subarray(at + 2, at + 2 + length);
    if (value.length !== length || length === 0) refuse("the signature is not DER");
    at += 2 + length;
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) refuse("the signature is not a P-256 signature");
    const out = new Uint8Array(32);
    out.set(value, 32 - value.length);
    return out;
  };
  const r = integer();
  const s = integer();
  if (at !== der.length) refuse("the signature is not DER");
  return concat(r, s);
}

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;

async function webauthnVerifies(envelope, spki, algorithm, challenge, passkeys) {
  const clientData = fromB64u(envelope.client_data_json, 1, 4096) ?? refuse("client_data_json is unpadded base64url");
  const auth = fromB64u(envelope.authenticator_data, 37, 4096) ?? refuse("authenticator_data is unpadded base64url");
  const signature = fromB64u(envelope.signature, 8, 1024) ?? refuse("the signature is unpadded base64url");
  let client;
  try {
    client = JSON.parse(strictUtf8.decode(clientData));
  } catch {
    refuse("client_data_json is not JSON");
  }
  if (client === null || typeof client !== "object") refuse("client_data_json is not a JSON object");
  if (client.type !== "webauthn.get") refuse("client_data_json.type must be webauthn.get");
  if (client.challenge !== toB64u(challenge)) refuse("the passkey signed another challenge");
  if (typeof client.origin !== "string" || !passkeys.origins.includes(client.origin)) refuse("the passkey signed on a page the service does not name");
  if (client.crossOrigin === true || client.topOrigin !== undefined) refuse("the passkey signed in a frame another site embedded");
  if (!equal(auth.subarray(0, 32), await sha256(utf8(passkeys.rp_id)))) refuse("the passkey signed for another site");
  if ((auth[32] & USER_PRESENT) === 0 || (auth[32] & USER_VERIFIED) === 0) refuse("the passkey signed without its person present and verified");
  const params = ALGORITHMS[algorithm] ?? refuse("that passkey algorithm is not one this checks");
  let key;
  try {
    key = await subtle.importKey("spki", spki, params, false, ["verify"]);
  } catch {
    refuse("the passkey key does not import");
  }
  const signed = concat(auth, await sha256(clientData));
  const raw = algorithm === "ES256" ? derToRaw(signature) : signature;
  const verify = algorithm === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : params;
  return subtle.verify(verify, key, raw, signed);
}

/**
 * Whether `signer` signed `bytes` under L(`labelName`), a full label from LABELS. `signer` is a KEY as the
 * service's profile describes it: its peer_id, and either its Ed25519
 * public_key (hex) or its passkey {algorithm, public_key (base64url SPKI)}.
 * `passkeys` is the service's {rp_id, origins}. True, or a refusal saying why.
 */
export async function verifySigned({ labelName, bytes, envelope, signer, passkeys }) {
  const peerId = fromHex(signer?.peer_id, 32) ?? refuse("the signer has no peer id");
  const signed = signedBytes(labelName, bytes);
  if (envelope?.alg === "ed25519") {
    const pk = fromHex(signer.public_key, 32) ?? refuse("the signer has no Ed25519 key");
    if (!equal(await sha256(label(LABELS.agent), pk), peerId)) refuse("the key is not the one the peer id names");
    const signature = fromHex(envelope.signature, 64) ?? refuse("an Ed25519 signature is 128 lowercase hex characters");
    let key;
    try {
      key = await subtle.importKey("raw", pk, { name: "Ed25519" }, false, ["verify"]);
    } catch {
      refuse("the Ed25519 key does not import");
    }
    if (!(await subtle.verify({ name: "Ed25519" }, key, signature, signed))) refuse("the signature does not verify");
    return true;
  }
  if (envelope?.alg === "webauthn") {
    const spki = fromB64u(signer.passkey?.public_key, 1, 4096) ?? refuse("the signer has no passkey");
    if (!equal(await sha256(label(LABELS.passkey), spki), peerId)) refuse("the passkey is not the one the peer id names");
    if (!passkeys || typeof passkeys.rp_id !== "string" || !Array.isArray(passkeys.origins)) refuse("a passkey is checked only with the service's word on where its passkeys belong");
    if (!(await webauthnVerifies(envelope, spki, signer.passkey.algorithm, await sha256(signed), passkeys))) {
      refuse("the signature does not verify");
    }
    return true;
  }
  refuse("alg is ed25519 or webauthn");
}

/**
 * A KEY's encryption key, from its statement and signature, once both check out:
 * the only way a reader should ever come by one.
 */
export async function checkedEncryptionKey({ statement, envelope, signer, passkeys }) {
  const bytes = fromB64u(statement, 1, 512) ?? refuse("the statement is unpadded base64url");
  const s = readStatement(bytes);
  if (toHex(s.peerId) !== signer?.peer_id) refuse("the statement names another KEY");
  await verifySigned({ labelName: LABELS.encryptionKey, bytes, envelope, signer, passkeys });
  return s.publicKey;
}
