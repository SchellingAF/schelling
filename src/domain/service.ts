// What the service itself signs, and the keys it signs with.
//
// Two keys. The ROOT key identifies the service and never touches the server: its
// owner makes it on a machine of their own (scripts/service-key.ts), keeps the
// private half there, and publishes the public half. The ONLINE key lives on the server,
// signs checkpoints, receipts and recovery notices, and is trusted because the
// root signed a certificate naming it. Stealing the online key lets a thief sign
// checkpoints until the certificate expires or the root certifies another; it
// never lets anyone forge a post, because posts are signed by their authors.
//
// Every statement is the same shape as a post's: canonical JSON, an id that is
// the SHA-256 of a label and those bytes, and an Ed25519 signature over a second
// label and the id.
//
//   certificate  {"development"?,"key","not_after"?,"not_before","purposes","root","v"}
//   checkpoint   {"created_at","ending_hash","first","last","merkle_root",
//                 "predecessor_hash","previous_checkpoint_id"?,"service_epoch",
//                 "signer_key_id","space_id","stream","v"}
//   receipt      {"chain_hash","object_id","post_id","posted_at","seq",
//                 "service_epoch","signer_key_id","space_id","v"}
//
// A certificate with "development": true was made by a service that found no key
// configured and made itself one for this run. Nothing it signs means more than
// "this process said so", and every reader is told.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { canonicalBytes } from "./jcs.ts";
import { verifySignature } from "./keys.ts";
import {
  LABEL_CHECKPOINT,
  LABEL_CHECKPOINT_SIGNATURE,
  LABEL_RECEIPT,
  LABEL_RECEIPT_SIGNATURE,
  LABEL_RECOVERY,
  LABEL_RECOVERY_SIGNATURE,
  LABEL_SERVICE_CERTIFICATE,
  LABEL_SERVICE_CERTIFICATE_SIGNATURE,
  LABEL_SERVICE_KEY,
  labelBytes,
  labelledHash,
} from "./protocol.ts";

export const CERTIFICATE_PURPOSES = ["checkpoint", "receipt", "recovery"] as const;

export const serviceKeyIdOf = (publicKey: Buffer): Buffer => labelledHash(LABEL_SERVICE_KEY, publicKey);
export const certificateIdOf = (canonical: Buffer): Buffer => labelledHash(LABEL_SERVICE_CERTIFICATE, canonical);
export const checkpointIdOf = (canonical: Buffer): Buffer => labelledHash(LABEL_CHECKPOINT, canonical);
export const receiptIdOf = (canonical: Buffer): Buffer => labelledHash(LABEL_RECEIPT, canonical);
export const recoveryIdOf = (canonical: Buffer): Buffer => labelledHash(LABEL_RECOVERY, canonical);

export type Statement = "certificate" | "checkpoint" | "receipt" | "recovery";

const SIGNATURE_LABELS: Record<Statement, { id: (b: Buffer) => Buffer; label: string }> = {
  certificate: { id: certificateIdOf, label: LABEL_SERVICE_CERTIFICATE_SIGNATURE },
  checkpoint: { id: checkpointIdOf, label: LABEL_CHECKPOINT_SIGNATURE },
  receipt: { id: receiptIdOf, label: LABEL_RECEIPT_SIGNATURE },
  recovery: { id: recoveryIdOf, label: LABEL_RECOVERY_SIGNATURE },
};

/** The bytes a key signs for a statement: the statement's signature label, a NUL, and its id. */
export function statementPreimage(kind: Statement, canonical: Buffer): Buffer {
  const { id, label } = SIGNATURE_LABELS[kind];
  return Buffer.concat([labelBytes(label), id(canonical)]);
}

export function ed25519PublicKeyOf(key: KeyObject): Buffer {
  return Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32));
}

export function signStatement(kind: Statement, canonical: Buffer, key: KeyObject): Buffer {
  return sign(null, statementPreimage(kind, canonical), key);
}

export function verifyStatement(kind: Statement, canonical: Buffer, signature: Buffer, publicKey: Buffer): boolean {
  return verifySignature(publicKey, statementPreimage(kind, canonical), signature);
}

export type Certificate = {
  v: 1;
  key: string;
  root: string;
  purposes: string[];
  not_before: string;
  not_after?: string;
  development?: true;
};

/** A certificate for `online`, signed by `root`. */
export function certify(root: KeyObject, online: Buffer, options: { notBefore?: Date; notAfter?: Date | null; development?: boolean } = {}) {
  const body: Record<string, unknown> = {
    v: 1,
    key: online.toString("hex"),
    root: ed25519PublicKeyOf(root).toString("hex"),
    purposes: [...CERTIFICATE_PURPOSES],
    not_before: (options.notBefore ?? new Date()).toISOString(),
  };
  if (options.notAfter) body.not_after = options.notAfter.toISOString();
  if (options.development) body.development = true;
  const canonical = canonicalBytes(body);
  return { canonical, signature: signStatement("certificate", canonical, root) };
}

/** The online key the service signs with, and what vouches for it. */
export type ServiceKey = {
  privateKey: KeyObject;
  publicKey: Buffer;
  keyId: Buffer;
  certificate: Buffer;
  certificateSignature: Buffer;
  root: Buffer;
  development: boolean;
  notAfter: Date | null;
};

/**
 * The service key from its two files, checked as a reader would check it: the
 * certificate parses, names this key, carries every purpose the service signs
 * for, is inside its dates, and verifies against the root it names — and that
 * root is the pinned one when a root is pinned. Throws a sentence an operator can
 * act on.
 */
export function loadServiceKey(privatePem: string, certificateFile: string, pinnedRoot: string | null, now = new Date()): ServiceKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privatePem);
  } catch {
    throw new Error("SERVICE_KEY_FILE is not a PEM private key.");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("SERVICE_KEY_FILE is not an Ed25519 key.");
  const publicKey = ed25519PublicKeyOf(privateKey);

  let parsed: { certificate?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(certificateFile);
  } catch {
    throw new Error("SERVICE_CERTIFICATE_FILE is not JSON. Write it with scripts/service-key.ts online.");
  }
  if (typeof parsed.certificate !== "string" || typeof parsed.signature !== "string" || !/^[0-9a-f]{128}$/.test(parsed.signature)) {
    throw new Error("SERVICE_CERTIFICATE_FILE must hold certificate (base64url) and signature (128 hex characters).");
  }
  const certificate = Buffer.from(parsed.certificate, "base64url");
  const signature = Buffer.from(parsed.signature, "hex");
  let body: Certificate;
  try {
    body = JSON.parse(certificate.toString("utf8"));
  } catch {
    throw new Error("the certificate in SERVICE_CERTIFICATE_FILE is not JSON.");
  }
  if (!canonicalBytes(body).equals(certificate)) throw new Error("the certificate is not canonical JSON, so its signature cannot be checked by anybody else.");
  if (body.v !== 1 || body.key !== publicKey.toString("hex")) {
    throw new Error("the certificate names a different key from SERVICE_KEY_FILE. The key and its certificate are made together.");
  }
  for (const purpose of CERTIFICATE_PURPOSES) {
    if (!Array.isArray(body.purposes) || !body.purposes.includes(purpose)) throw new Error(`the certificate does not allow the key to sign a ${purpose}.`);
  }
  if (typeof body.root !== "string" || !/^[0-9a-f]{64}$/.test(body.root)) throw new Error("the certificate names no root key.");
  const root = Buffer.from(body.root, "hex");
  if (!verifyStatement("certificate", certificate, signature, root)) throw new Error("the certificate's signature does not verify against the root key it names.");
  if (pinnedRoot !== null && pinnedRoot !== body.root) {
    throw new Error(`the certificate was signed by root ${body.root}, and SERVICE_ROOT_KEY pins ${pinnedRoot}.`);
  }
  if (Number.isNaN(Date.parse(body.not_before)) || Date.parse(body.not_before) > now.getTime() + 60_000) {
    throw new Error("the certificate is not valid yet.");
  }
  const notAfter = body.not_after === undefined ? null : new Date(body.not_after);
  if (notAfter !== null && (Number.isNaN(notAfter.getTime()) || notAfter.getTime() <= now.getTime())) {
    throw new Error("the certificate has expired. Certify a new online key with the root key: scripts/service-key.ts online.");
  }
  return {
    privateKey,
    publicKey,
    keyId: serviceKeyIdOf(publicKey),
    certificate,
    certificateSignature: signature,
    root,
    development: body.development === true,
    notAfter,
  };
}

/**
 * A key for a service that has none configured: a root and an online key made for
 * this process, the certificate marked development. Local machines and tests only;
 * the deployed service refuses to start without real files (see config.ts).
 */
export function developmentServiceKey(now = new Date()): ServiceKey {
  const root = generateKeyPairSync("ed25519").privateKey;
  const online = generateKeyPairSync("ed25519").privateKey;
  const publicKey = ed25519PublicKeyOf(online);
  const { canonical, signature } = certify(root, publicKey, { notBefore: new Date(now.getTime() - 60_000), development: true });
  return {
    privateKey: online,
    publicKey,
    keyId: serviceKeyIdOf(publicKey),
    certificate: canonical,
    certificateSignature: signature,
    root: ed25519PublicKeyOf(root),
    development: true,
    notAfter: null,
  };
}
