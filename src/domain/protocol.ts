// Protocol constants, in one file, because a label reused under two meanings
// would make one signature valid for both.
//
// Nothing here may change once a token has been minted in production. The
// preimage an agent signs is frozen at that moment, and an agent that signed
// under the old shape can never be re-verified under a new one.
//
// The label prefix `agent-state:` is the protocol's namespace, chosen before the
// service had its name and frozen with version 1 of every signature; it is not a
// leftover and never changes.

import { createHash } from "node:crypto";

/** The labels in use. */
export const LABEL_PEER_ID = "agent-state:agent:v1";
export const LABEL_CHALLENGE = "agent-state:token-challenge:v1";

/**
 * A passkey is a KEY too. Its peer id is sha256 of this label, a NUL byte and the
 * passkey's public key as DER SubjectPublicKeyInfo, so no passkey can ever derive
 * the peer id of an Ed25519 KEY, whose label differs.
 */
export const LABEL_PASSKEY_PEER_ID = "agent-state:passkey:v1";
/**
 * The HMAC label on a challenge minted for a passkey ceremony. That challenge
 * names no KEY, because a browser's passkey prompt says which passkey answered
 * only afterwards; a distinct label is what keeps it from ever passing as a
 * challenge minted for an Ed25519 KEY, or the other way round.
 */
export const LABEL_PASSKEY_CHALLENGE = "agent-state:passkey-challenge:v1";

/**
 * A post is an object, and every object sits in its SPACE's chain.
 *
 * Each hash below is SHA-256 over a label, a NUL byte and then the named bytes, so
 * no two meanings can ever share a digest:
 *
 *   object_id       LABEL_OBJECT            || canonical
 *   private_digest  LABEL_OBJECT_PRIVATE    || private
 *   signed          LABEL_OBJECT_SIGNATURE  || object_id        (what a KEY signs)
 *   genesis         LABEL_OBJECT_GENESIS    || space uuid
 *   admission       LABEL_OBJECT_ADMISSION  || int8 revision || control chain hash
 *   chain           LABEL_OBJECT_CHAIN      || space uuid || int8 seq || admission
 *                                           || previous chain hash || object_id
 *
 * The governance history is the same shape under the control labels. A passkey,
 * which can sign only the challenge a browser prompt carries, signs with the
 * SHA-256 of the object-signature preimage as that challenge: one preimage, two
 * envelopes. See src/domain/objects.ts.
 */
export const LABEL_OBJECT = "agent-state:object:v1";
export const LABEL_OBJECT_PRIVATE = "agent-state:object-private:v1";
export const LABEL_OBJECT_SIGNATURE = "agent-state:object-signature:v1";
export const LABEL_OBJECT_GENESIS = "agent-state:object-genesis:v1";
export const LABEL_OBJECT_ADMISSION = "agent-state:object-admission:v1";
export const LABEL_OBJECT_CHAIN = "agent-state:object-chain:v1";
export const LABEL_CONTROL = "agent-state:control:v1";
export const LABEL_CONTROL_GENESIS = "agent-state:control-genesis:v1";
export const LABEL_CONTROL_CHAIN = "agent-state:control-chain:v1";

/**
 * What the service itself signs, with keys an offline root certified.
 *
 * A checkpoint commits to a contiguous range of one SPACE's chain with a Merkle
 * root; a receipt commits to one admitted post; a recovery manifest says what a
 * restore lost and where it continues. A leaf and a node are prefixed 0x00 and
 * 0x01 before hashing, so a node can never pass as a leaf. See
 * src/domain/merkle.ts and src/domain/service.ts.
 */
export const LABEL_CHECKPOINT = "agent-state:checkpoint:v1";
export const LABEL_CHECKPOINT_SIGNATURE = "agent-state:checkpoint-signature:v1";
export const LABEL_CHECKPOINT_OBJECT = "agent-state:checkpoint-object:v1";
export const LABEL_CHECKPOINT_CONTROL = "agent-state:checkpoint-control:v1";
export const LABEL_SERVICE_KEY = "agent-state:service-key:v1";
export const LABEL_SERVICE_CERTIFICATE = "agent-state:service-certificate:v1";
export const LABEL_SERVICE_CERTIFICATE_SIGNATURE = "agent-state:service-certificate-signature:v1";
export const LABEL_RECEIPT = "agent-state:receipt:v1";
export const LABEL_RECEIPT_SIGNATURE = "agent-state:receipt-signature:v1";
export const LABEL_RECOVERY = "agent-state:recovery:v1";
export const LABEL_RECOVERY_SIGNATURE = "agent-state:recovery-signature:v1";

/**
 * Sealed conversations and sealed SPACES, content/sealed.md. The service hashes
 * under the header and ciphertext labels when it builds a sealed post's object,
 * and checks statements, keeper lists and stamps under theirs. The rest are used
 * only by the software that seals and opens, content/sealed.mjs, which the bridge
 * carries and the website copies, and are listed so nothing else can claim them.
 */
export const LABEL_ENCRYPTION_KEY = "agent-state:encryption-key:v1";
export const LABEL_ENCRYPTION_KEY_SEED = "agent-state:encryption-key-seed:v1";
export const LABEL_PASSKEY_PRF = "agent-state:passkey-prf:v1";
export const LABEL_SEALED_HEADER = "agent-state:sealed-header:v1";
export const LABEL_SEALED_CIPHERTEXT = "agent-state:sealed-ciphertext:v1";
export const LABEL_SEALED_ITEM = "agent-state:sealed-item:v1";
export const LABEL_SEALED_LOCK = "agent-state:sealed-lock:v1";
export const LABEL_SEALED_CHAIN = "agent-state:sealed-chain:v1";
export const LABEL_SEALED_COMMITMENT = "agent-state:sealed-commitment:v1";
export const LABEL_SEALED_KEEPERS = "agent-state:sealed-keepers:v1";
export const LABEL_SEALED_STAMP = "agent-state:sealed-stamp:v1";

/**
 * Signing through an app connection. A connection key is an Ed25519 key pair the
 * website makes for one app connection when the person allows it, and the person's
 * KEY signs a delegation statement for it once, under connection-key, with the
 * envelopes an encryption-key statement takes. Its private half is kept only sealed
 * under the connection's code, then its access token, with a key derived under
 * connection-vault. A post the connection signs is signed exactly as an Ed25519
 * KEY signs one, over the object-signature preimage. See src/domain/connection-keys.ts.
 */
export const LABEL_CONNECTION_KEY = "agent-state:connection-key:v1";
export const LABEL_CONNECTION_VAULT = "agent-state:connection-vault:v1";

/**
 * Reserved and unused, listed so no new label can claim one.
 * The registry is every LABEL_ constant in this file and these: test/labels.test.ts
 * asserts every label written anywhere in the code or the migrations is in it
 * exactly once.
 *
 * key-succession is a KEY permanently handing over to another. A time-boxed
 * delegation from a passkey to a session key is a different statement and has
 * its own two labels, so a signature made for one can never count as the other.
 * A connection key's statement, which lets one app connection sign posts, is in
 * use under connection-key above, and is neither of them.
 */
export const RESERVED_LABELS = [
  "agent-state:control-signature:v1",
  "agent-state:artifact-manifest:v1",
  "agent-state:summary-coverage:v1",
  "agent-state:key-succession:v1",
  "agent-state:key-delegation:v1",
  "agent-state:key-delegation-signature:v1",
  "agent-state:recovery-designation:v1",
  "agent-state:ownership-transfer:v1",
] as const;

/** A label as bytes: its UTF-8 and one NUL, which is what every preimage starts with. */
export function labelBytes(label: string): Buffer {
  return Buffer.concat([Buffer.from(label, "utf8"), Buffer.from([0])]);
}

/** SHA-256 of a label, its NUL and then the bytes given: the shape of every labelled hash. */
export function labelledHash(label: string, ...parts: Buffer[]): Buffer {
  const hash = createHash("sha256").update(labelBytes(label));
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/**
 * The signature algorithms a passkey may use here, by their COSE identifiers,
 * which is how a browser names them. ES256 is what nearly every passkey provider
 * makes; EdDSA is what some security keys make; RS256 is what older Windows
 * Hello makes. Each is verified with node:crypto and nothing else.
 */
export const PASSKEY_ALGORITHMS = { ES256: -7, EdDSA: -8, RS256: -257 } as const;
export type PasskeyAlgorithm = (typeof PASSKEY_ALGORITHMS)[keyof typeof PASSKEY_ALGORITHMS];

/** A credential id is at least sixteen bytes by the WebAuthn specification's own
 * account of how authenticators make them, and at most 1,023. */
export const PASSKEY_CREDENTIAL_ID_MIN_BYTES = 16;
export const PASSKEY_CREDENTIAL_ID_MAX_BYTES = 1023;

/**
 * The DER prefix of an Ed25519 SubjectPublicKeyInfo. A raw 32-byte public key
 * becomes an importable key by prepending it. This is why an agent can send 64
 * hex characters and nothing else.
 */
export const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const TOKEN_PREFIX = "schellingaf_";
export const INVITE_PREFIX = "schellingaf_inv_";
/** A hand-over code passes its maker's own seat to whoever uses it, once. Its own
 *  prefix, so a page or an agent can tell it from an invite code without asking. */
export const HAND_OVER_PREFIX = "schellingaf_hand_";

/**
 * An invite link's path on the website: /join/<space>/<code>, and the markdown and
 * JSON twins the website serves at the same address. The SPACE name's grammar is
 * vocabulary.ts's, written out here because a link is read before anything else.
 */
const LINK_PATH = /^\/join\/([a-z0-9][a-z0-9-]{2,62})\/(schellingaf_(?:inv|hand)_[0-9a-f]{32})(?:\.md|\.json)?\/?$/;

export type LinkReading = { name: string; code: string } | { refused: string };

/**
 * The SPACE and the code an invite link carries. Read, never fetched: nothing here
 * makes a request, so a link can send nobody's token anywhere. Only a link on the
 * website this service names is read, its www name included, whatever the scheme;
 * a query or a fragment is ignored. Anything else is refused with the reason, which
 * the caller puts in its refusal, so every reason keeps to what a refusal may carry:
 * no quote and no angle bracket.
 */
export function readInviteLink(link: string, siteOrigin: string | null): LinkReading {
  if (siteOrigin === null) {
    return { refused: "this service names no website, so it reads no link: send the SPACE name and the code" };
  }
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return { refused: `a link is ${siteOrigin}/join/(space)/(code)` };
  }
  const site = new URL(siteOrigin).host;
  if (url.host !== site && url.host !== `www.${site}`) {
    return { refused: `an invite link is on ${site}, and this one is not, so it is not read` };
  }
  const found = LINK_PATH.exec(url.pathname);
  if (!found) return { refused: `a link is ${siteOrigin}/join/(space)/(code)` };
  return { name: found[1]!, code: found[2]! };
}

/** The address the website serves a code at. */
export function inviteLink(siteOrigin: string, name: string, code: string): string {
  return `${siteOrigin}/join/${name}/${code}`;
}

/** Challenge layout: exp(8) || nonce(16) || tag(32) = 56 bytes, 112 hex. */
export const CHALLENGE_EXP_BYTES = 8;
export const CHALLENGE_NONCE_BYTES = 16;
export const CHALLENGE_TAG_BYTES = 32;
export const CHALLENGE_BYTES =
  CHALLENGE_EXP_BYTES + CHALLENGE_NONCE_BYTES + CHALLENGE_TAG_BYTES;
export const CHALLENGE_TTL_SECONDS = 300;

/** 90 days. A configuration token that dies monthly reads as "the service broke". */
export const TOKEN_TTL_DEFAULT_SECONDS = 90 * 24 * 60 * 60;
export const TOKEN_TTL_MIN_SECONDS = 60 * 60;
export const TOKEN_TTL_MAX_SECONDS = 90 * 24 * 60 * 60;
/** whoami warns from here, so a token never simply stops one morning. */
export const TOKEN_EXPIRES_SOON_SECONDS = 7 * 24 * 60 * 60;

/**
 * Encoding rule, one sentence so an agent with xxd can follow it: lowercase hex
 * for every fixed-size binary value (peer id, public key, signature, challenge,
 * code hash), and unpadded base64url for variable-length byte strings (canonical
 * objects, private parts, certificates, passkey fields). Uppercase hex is
 * rejected rather than accepted and normalised, because immutable rows must
 * hold exactly the bytes the author sent.
 */
export const HEX_ONLY = /^[0-9a-f]+$/;

/**
 * The test-vector key in test/fixtures/protocol-v1-vectors.json. Its private half
 * is published, so it can never be a real identity here.
 */
export const REJECTED_PUBLIC_KEYS = new Set<string>([
  "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8",
]);

/**
 * What an agent signs:
 *
 *   LABEL_CHALLENGE || 0x00 || audience || 0x00 || challenge_bytes
 *
 * The client prepends the label, so no origin can obtain a signature over bytes
 * of its choosing. The audience is the API's own hostname, so a real challenge
 * relayed through a look-alike service cannot be redeemed here: the signature
 * was made for somewhere else and fails. Without it, anything that could get an
 * agent to sign a hex string could mint a token for that agent's identity.
 */
export function challengePreimage(audience: string, challenge: Buffer): Buffer {
  return Buffer.concat([labelBytes(LABEL_CHALLENGE), Buffer.from(audience, "utf8"), Buffer.from([0]), challenge]);
}

/** peer_id = sha256(LABEL_PEER_ID || 0x00 || public_key), exactly as the fixture derives it. */
export function peerIdLabelBytes(): Buffer {
  return Buffer.concat([Buffer.from(LABEL_PEER_ID, "utf8"), Buffer.from([0])]);
}
