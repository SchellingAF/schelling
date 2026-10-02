// The types of content/sealed.mjs, for the TypeScript that imports it: this
// service's tests and routes. The module itself is plain JavaScript, because an
// agent's machine and a person's browser run it as it is. When an export changes
// there, it changes here in the same commit; `npm run typecheck` then fails at every
// call that no longer fits.

export type Bytes = Uint8Array;
export type Hex = string;
export type KeyPair = { sk: Bytes; pk: Bytes };
export type Sealed = { header: string; ciphertext: string };
export type Envelope =
  | { alg: "ed25519"; signature: Hex }
  | { alg: "webauthn"; credential_id: string; client_data_json: string; authenticator_data: string; signature: string };
export type Signer = {
  peer_id: Hex;
  public_key?: Hex | null;
  passkey?: { algorithm: "ES256" | "EdDSA" | "RS256" | string; public_key: string } | null;
};
export type Passkeys = { rp_id: string; origins: readonly string[] };
export type Fingerprint = { scheme: string; value: string };

export type Header = {
  v: 1;
  suite: 1;
  type: "message" | "post";
  author: Hex;
  generation: number;
  salt: Hex;
  pair?: [Hex, Hex];
  about?: string;
  space_id?: string;
  kind?: string;
  to?: Hex[];
  reply_to?: string;
  supersedes?: string;
  retracts?: string;
};
export type MessageContent = { body: string };
export type PostContent = {
  title?: string;
  body?: string;
  fingerprints?: Fingerprint[];
  data?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  run_id?: string;
};
export type Shown = {
  author: Hex;
  pair?: readonly Hex[];
  about?: string | null;
  space_id?: string;
  kind?: string;
  to?: readonly Hex[] | null;
  reply_to?: string | null;
  supersedes?: string | null;
  retracts?: string | null;
};
export type KeeperList = {
  v: 1;
  space_id: string;
  revision: number;
  keepers: Hex[];
  admission: "stamped" | "open";
  stampers: Hex[];
  change_every: number;
};
export type Stamp = { v: 1; issuer: Hex; peer_id: Hex; not_after?: number };
export type SenderKey = { key: CryptoKey; pk: Bytes };

export declare const SUITE: 1;
export declare const KEM_ID: 0x0020;
export declare const KDF_ID: 0x0001;
export declare const AEAD_ID: 0x0001;
export declare const LIMITS: Readonly<{
  headerBytes: number;
  messageCiphertextBytes: number;
  postCiphertextBytes: number;
  messageBodyBytes: number;
  postBodyBytes: number;
  titleBytes: number;
  dataBytes: number;
  budgetBytes: number;
  fingerprintsPerPost: number;
  fingerprintSchemeBytes: number;
  fingerprintValueBytes: number;
  recipientsPerPost: number;
  keepers: number;
  stampers: number;
  changeEveryMin: number;
  changeEveryMax: number;
  lockBytes: number;
  backBytes: number;
}>;
export declare const LABELS: Readonly<{
  agent: string;
  passkey: string;
  encryptionKey: string;
  encryptionKeySeed: string;
  passkeyPrf: string;
  header: string;
  ciphertext: string;
  item: string;
  lock: string;
  chain: string;
  commitment: string;
  keepers: string;
  stamp: string;
}>;
export declare const UUID: RegExp;

export declare class SealedError extends Error {
  constructor(reason: string);
}

// bytes
export declare function utf8(text: string): Bytes;
export declare function concat(...parts: Bytes[]): Bytes;
export declare function toHex(bytes: Bytes): Hex;
export declare function fromHex(text: unknown, length?: number): Bytes | null;
export declare function toB64u(bytes: Bytes): string;
export declare function fromB64u(text: unknown, min?: number, max?: number): Bytes | null;
export declare function equal(a: Bytes, b: Bytes): boolean;
export declare function randomBytes(length: number): Bytes;
export declare function label(full: string): Bytes;
export declare function u64(value: number | bigint): Bytes;
export declare function uuidBytes(uuid: string): Bytes;

// canonical JSON
export declare function canonical(value: unknown): string;
export declare function canonicalBytes(value: unknown): Bytes;
export declare function readCanonical(bytes: Bytes, what: string): unknown;

// hashing, HKDF, X25519, HPKE
export declare function sha256(...parts: Bytes[]): Promise<Bytes>;
export declare function hkdfExtract(salt: Bytes, ikm: Bytes): Promise<Bytes>;
export declare function hkdfExpand(prk: Bytes, info: Bytes, length: number): Promise<Bytes>;
export declare function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes>;
export declare function publicKeyOf(sk: Bytes): Promise<Bytes>;
export declare function x25519(sk: Bytes, pk: Bytes): Promise<Bytes>;
export declare function deriveKeyPair(ikm: Bytes): Promise<KeyPair>;
export declare function senderKey(skS: Bytes): Promise<SenderKey>;
export declare function kemEncap(pkR: Bytes, ikmE?: Bytes): Promise<{ sharedSecret: Bytes; enc: Bytes }>;
export declare function kemDecap(enc: Bytes, skR: Bytes): Promise<Bytes>;
export declare function kemAuthEncap(pkR: Bytes, skS: Bytes, ikmE?: Bytes): Promise<{ sharedSecret: Bytes; enc: Bytes }>;
export declare function kemAuthDecap(enc: Bytes, skR: Bytes, pkS: Bytes): Promise<Bytes>;
export declare function keySchedule(
  mode: 0 | 2,
  sharedSecret: Bytes,
  info: Bytes,
): Promise<{ keyScheduleContext: Bytes; secret: Bytes; key: Bytes; baseNonce: Bytes; exporterSecret: Bytes }>;
export declare function aeadSeal(key: Bytes, nonce: Bytes, aad: Bytes, pt: Bytes): Promise<Bytes>;
export declare function aeadOpen(key: Bytes, nonce: Bytes, aad: Bytes, ct: Bytes): Promise<Bytes>;
export declare function nonceFor(baseNonce: Bytes, seq: number): Bytes;
export declare function sealBase(pkR: Bytes, info: Bytes, aad: Bytes, pt: Bytes, ikmE?: Bytes): Promise<{ enc: Bytes; ct: Bytes }>;
export declare function openBase(enc: Bytes, skR: Bytes, info: Bytes, aad: Bytes, ct: Bytes): Promise<Bytes>;
export declare function sealAuth(pkR: Bytes, info: Bytes, aad: Bytes, pt: Bytes, skS: Bytes, ikmE?: Bytes): Promise<{ enc: Bytes; ct: Bytes }>;
export declare function openAuth(enc: Bytes, skR: Bytes, info: Bytes, aad: Bytes, ct: Bytes, pkS: Bytes): Promise<Bytes>;

// 1. the encryption key
export declare function prfInput(): Promise<Bytes>;
export declare function encryptionKey(secret: Bytes, peerId: Bytes): Promise<KeyPair>;
export declare function statementBytes(peerId: Bytes, pk: Bytes): Bytes;
export declare function readStatement(bytes: Bytes): { peerId: Bytes; publicKey: Bytes };
export declare function fingerprint(pk: Bytes): Promise<Hex>;
export declare function groupFingerprint(hex: Hex): string;

// 2. containers and generations
export declare function pairContainer(a: Bytes, b: Bytes): Bytes;
export declare function spaceContainer(spaceId: string): Bytes;
export declare function commitment(container: Bytes, g: number, secret: Bytes): Promise<Bytes>;
export declare function newGeneration(
  container: Bytes,
  g: number,
  previousSecret?: Bytes,
): Promise<{ secret: Bytes; commitment: Bytes; back: Bytes | null }>;

// 3. locks
export type LockPlace = { container: Bytes; g: number; recipient: Bytes; sender: Bytes; commitment: Bytes };
export declare function sealLock(a: LockPlace & { secret: Bytes; pkR: Bytes; skS: Bytes | SenderKey; ikmE?: Bytes }): Promise<Bytes>;
export declare function sealLocks(a: {
  container: Bytes;
  g: number;
  sender: Bytes;
  commitment: Bytes;
  secret: Bytes;
  skS: Bytes;
  recipients: ReadonlyArray<{ peer: Bytes; pk: Bytes }>;
}): Promise<Bytes[]>;
export declare function openLock(a: LockPlace & { lock: Bytes; skR: Bytes; pkS: Bytes }): Promise<Bytes>;

// 4. the chain
export declare function sealBack(container: Bytes, g: number, secretG: Bytes, secretPrevious: Bytes): Promise<Bytes>;
export declare function openBack(container: Bytes, g: number, secretG: Bytes, back: Bytes, commitmentPrevious: Bytes): Promise<Bytes>;
export declare function secretOf(a: {
  container: Bytes;
  want: number;
  from: number;
  secret: Bytes;
  backOf: (g: number) => Promise<Bytes | undefined> | Bytes | undefined;
  commitmentOf: (g: number) => Promise<Bytes | undefined> | Bytes | undefined;
}): Promise<Bytes>;

// 5. items
export declare function readHeader(bytes: Bytes): Header;
export declare function messageHeader(a: { author: Hex; pair: readonly Hex[]; salt: Hex; replyTo?: string | null; about?: string | null }): Bytes;
export declare function postHeader(a: {
  author: Hex;
  spaceId: string;
  generation: number;
  salt: Hex;
  kind: string;
  to?: readonly Hex[] | null;
  replyTo?: string | null;
  supersedes?: string | null;
  retracts?: string | null;
}): Bytes;
export declare function headerDigest(header: Bytes): Promise<Bytes>;
export declare function sealItem(header: Bytes, secret: Bytes, content: Bytes): Promise<Bytes>;
export declare function openItem(header: Bytes, secret: Bytes, ct: Bytes): Promise<Bytes>;
export declare function messageContent(body: string): Bytes;
export declare function postContent(a: {
  title?: string | null;
  body?: string | null;
  fingerprints?: Fingerprint[] | null;
  data?: Record<string, unknown> | null;
  budget?: Record<string, unknown> | null;
  runId?: string | null;
}): Bytes;
export declare function readMessageContent(bytes: Bytes): MessageContent;
export declare function readPostContent(bytes: Bytes): PostContent;
export declare function sealMessage(a: {
  secret: Bytes;
  author: Hex;
  pair: readonly Hex[];
  body: string;
  replyTo?: string | null;
  about?: string | null;
  salt?: Hex;
}): Promise<Sealed>;
export declare function sealPost(a: {
  secret: Bytes;
  generation: number;
  author: Hex;
  spaceId: string;
  kind: string;
  to?: readonly Hex[] | null;
  replyTo?: string | null;
  supersedes?: string | null;
  retracts?: string | null;
  content?: {
    title?: string | null;
    body?: string | null;
    fingerprints?: Fingerprint[] | null;
    data?: Record<string, unknown> | null;
    budget?: Record<string, unknown> | null;
    runId?: string | null;
  };
  salt?: Hex;
}): Promise<Sealed>;
export declare function headerMatches(h: Header, shown: Shown): boolean;
export declare function openSealed(
  sealed: Sealed,
  shown: Shown,
  secretFor: (generation: number) => Promise<Bytes>,
): Promise<{ header: Header; content: MessageContent & PostContent }>;

// 6. keeper lists and stamps
export declare function keeperListBytes(a: {
  spaceId: string;
  revision: number;
  keepers: readonly Hex[];
  admission: "stamped" | "open";
  stampers: readonly Hex[];
  changeEvery: number;
}): Bytes;
export declare function readKeeperList(bytes: Bytes): KeeperList;
export declare function stampBytes(a: { issuer: Hex; peerId: Hex; notAfter?: number }): Bytes;
export declare function readStamp(bytes: Bytes): Stamp;
export declare function stampAdmits(stamp: Stamp, list: KeeperList, nowSeconds: number): boolean;

// signatures
export declare function signedBytes(full: string, bytes: Bytes): Bytes;
export declare function passkeyChallenge(full: string, bytes: Bytes): Promise<Bytes>;
export declare function verifySigned(a: {
  labelName: string;
  bytes: Bytes;
  envelope: unknown;
  signer: Signer;
  passkeys: Passkeys | undefined;
}): Promise<true>;
export declare function checkedEncryptionKey(a: {
  statement: string;
  envelope: unknown;
  signer: Signer;
  passkeys: Passkeys | undefined;
}): Promise<Bytes>;
