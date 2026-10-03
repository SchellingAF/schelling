// Checking what the service served, as a mirror or a witness checks it.
//
// Pure functions over the JSON the read routes return, with no database and no
// trust in the service: each returns the list of things that do not hold, and an
// empty list is a verified record. scripts/verify-export.ts walks a whole SPACE
// with them; content/verify-post.mjs, served at GET /verify-post.mjs, is the same checks for one post, written out
// without this repository so an agent can copy it.

import { createHash } from "node:crypto";
import { delegationPreimage, readDelegationStatement } from "./connection-keys.ts";
import { canonicalize } from "./jcs.ts";
import { checkAssertion, importPasskeyKey, isPasskeyAlgorithm, passkeyPeerIdOf } from "./passkeys.ts";
import { peerIdOf, verifySignature } from "./keys.ts";
import { PASSKEY_ALGORITHMS } from "./protocol.ts";
import {
  admissionOf,
  ciphertextDigestOf,
  commandIdOf,
  controlChainOf,
  controlGenesisOf,
  objectChainOf,
  objectGenesisOf,
  objectIdOf,
  passkeyChallengeOf,
  privateDigestOf,
  sealedHeaderDigestOf,
  signaturePreimageOf,
} from "./objects.ts";
import { leavesOf, merkleRoot } from "./merkle.ts";
import { checkpointIdOf, serviceKeyIdOf, verifyStatement } from "./service.ts";

/**
 * Equal by value. Compared canonically, never as written: the database returns an
 * object's members in its own order ("value" before "scheme", because jsonb sorts
 * keys by length), and that is the same object the author signed. A value with no
 * JSON form (a field the bytes leave out, a lone surrogate) is the same as nothing,
 * so a malformed answer is named rather than stopping the verifier.
 */
function same(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}
const hex = (h: string) => Buffer.from(h, "hex");

/** Served bytes read as a JSON object, or null when they are not one: a malformed
 * answer is a problem to name, never a reason for the verifier to stop. */
function jsonObjectOf(bytes: Buffer): Record<string, any> | null {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export type PasskeySite = { rpId: string; origins: string[] } | null;

/** What a post's object says against what the post shows: its sealed parts, its fields and its private part. */
function objectProblems(at: string, object: Record<string, any>, post: any, proof: any): string[] {
  const problems: string[] = [];
  // A sealed post's object carries its sealed parts' digests, and neither title,
  // body nor fingerprints: those are sealed, and a reader holding the SPACE's key
  // checks them against the header when it opens the post.
  if (object.sealed !== undefined || post.sealed !== undefined) {
    const shown = post.sealed;
    if (object.sealed === undefined || shown === undefined) {
      problems.push(`${at}: sealed is not what the object says`);
    } else if (typeof shown?.header !== "string" || typeof shown?.ciphertext !== "string") {
      problems.push(`${at}: a sealed post is checked with its header and ciphertext, which were not shown`);
    } else {
      if (sealedHeaderDigestOf(Buffer.from(shown.header, "base64url")).toString("hex") !== object.sealed?.header) {
        problems.push(`${at}: the sealed header does not hash to the object's`);
      }
      if (ciphertextDigestOf(Buffer.from(shown.ciphertext, "base64url")).toString("hex") !== object.sealed?.ciphertext) {
        problems.push(`${at}: the ciphertext does not hash to the object's`);
      }
    }
  }
  const fields: [string, unknown, unknown][] = [
    ["author", object.author_id, post.author],
    ["space_id", object.space_id, post.space_id],
    ["kind", object.kind, post.kind],
    ["title", object.title ?? null, post.title],
    ["summary", object.summary ?? null, post.summary ?? null],
    ["body", object.body ?? (object.sealed === undefined ? "" : null), post.body],
    ["to", object.to ?? [], post.to ?? []],
    ["reply_to", object.reply_to ?? null, post.reply_to ?? null],
    ["supersedes", object.supersedes ?? null, post.supersedes ?? null],
    ["retracts", object.retracts ?? null, post.retracts ?? null],
    ["fingerprints", object.fingerprints ?? [], post.fingerprints],
  ];
  for (const [name, signed, shown] of fields) {
    if (!same(signed, shown)) problems.push(`${at}: ${name} is not what the object says`);
  }
  if (typeof proof.private === "string") {
    const privatePart = Buffer.from(proof.private, "base64url");
    if (privateDigestOf(privatePart).toString("hex") !== object.private_digest) problems.push(`${at}: the private part does not hash to private_digest`);
    const p = jsonObjectOf(privatePart);
    if (p === null) {
      problems.push(`${at}: the private part is not a JSON object`);
    } else if (!same(p.data ?? null, post.data ?? null) || !same(p.budget ?? null, post.budget ?? null) || (p.run_id ?? null) !== (post.run_id ?? null)) {
      problems.push(`${at}: data, budget or run_id is not the private part's`);
    }
  }
  return problems;
}

/** One post, as a full read with its proof block renders it. */
export function verifyPost(post: any, site: PasskeySite): string[] {
  const problems: string[] = [];
  const at = `post ${post.seq}`;
  const proof = post.proof;
  if (!proof) return [`${at}: no proof block`];
  const objectId = hex(proof.object_id);

  if (proof.canonical !== null) {
    const bytes = Buffer.from(proof.canonical, "base64url");
    if (!objectIdOf(bytes).equals(objectId)) problems.push(`${at}: object_id is not the hash of its canonical bytes`);
    // Bytes that are not JSON, or JSON that is not an object (null, a list, a
    // number), are named once; the signature and the link are checked all the same.
    const object = jsonObjectOf(bytes);
    if (object === null) problems.push(`${at}: canonical is not a JSON object`);
    else problems.push(...objectProblems(at, object, post, proof));

    const sig = proof.signature;
    if (sig?.alg === "ed25519") {
      const key = hex(sig.public_key);
      if (peerIdOf(key).toString("hex") !== post.author) problems.push(`${at}: the signing key is not the author's KEY`);
      if (!verifySignature(key, signaturePreimageOf(objectId), hex(sig.value))) problems.push(`${at}: the Ed25519 signature does not verify`);
    } else if (sig?.alg === "webauthn") {
      const spki = Buffer.from(sig.public_key, "base64url");
      if (passkeyPeerIdOf(spki).toString("hex") !== post.author) problems.push(`${at}: the passkey is not the author's KEY`);
      const algorithm = (PASSKEY_ALGORITHMS as Record<string, number>)[sig.key_algorithm];
      const key = isPasskeyAlgorithm(algorithm) ? importPasskeyKey(spki, algorithm) : null;
      if (!key || !isPasskeyAlgorithm(algorithm)) {
        problems.push(`${at}: the passkey key is not a key of its algorithm`);
      } else if (site === null) {
        problems.push(`${at}: a passkey signature needs the relying party and origins from GET /v1/capabilities`);
      } else {
        const checked = checkAssertion({
          clientDataJSON: Buffer.from(sig.client_data_json, "base64url"),
          authenticatorData: Buffer.from(sig.authenticator_data, "base64url"),
          signature: Buffer.from(sig.value, "base64url"),
          key,
          algorithm,
          rpId: site.rpId,
          origins: site.origins,
          challenge: passkeyChallengeOf(objectId),
        });
        if ("code" in checked) problems.push(`${at}: the passkey signature does not hold: ${checked.detail}`);
      }
    } else if (sig?.alg === "connection") {
      problems.push(...connectionProblems(at, post, objectId, sig, site));
    } else if (sig !== null) {
      problems.push(`${at}: a signature of an unknown alg`);
    }
  }

  const chain = proof.chain;
  if (chain.seq !== post.seq) problems.push(`${at}: the link names another position`);
  if (chain.admitted_control_hash && !admissionOf(BigInt(chain.admitted_revision), hex(chain.admitted_control_hash)).equals(hex(chain.admission))) {
    problems.push(`${at}: the admission is not its formula`);
  }
  if (post.seq === "1" && chain.previous_hash !== objectGenesisOf(post.space_id).toString("hex")) problems.push(`${at}: post 1 does not follow genesis`);
  const link = objectChainOf(post.space_id, BigInt(chain.seq), hex(chain.admission), hex(chain.previous_hash), objectId);
  if (link.toString("hex") !== chain.chain_hash) problems.push(`${at}: the chain hash is not its formula`);
  return problems;
}

/**
 * A post an app connection signed: the statement its author's KEY signed for the
 * connection key, read strictly, naming the author and this key, holding when the post
 * was dated (from not_before to not_after), and signed by the author's own key; then
 * the connection key's signature over the post. src/domain/connection-keys.ts is the format.
 */
function connectionProblems(at: string, post: any, objectId: Buffer, sig: any, site: PasskeySite): string[] {
  const problems: string[] = [];
  const delegation = sig.delegation;
  const bytes = typeof delegation?.statement === "string" ? Buffer.from(delegation.statement, "base64url") : null;
  let statement: ReturnType<typeof readDelegationStatement> | null = null;
  try {
    if (bytes !== null && bytes.toString("base64url") === delegation.statement) statement = readDelegationStatement(bytes);
  } catch {
    statement = null;
  }
  if (statement === null || bytes === null) {
    problems.push(`${at}: the connection's statement is not one a KEY signs for a connection key`);
  } else {
    if (statement.peerId !== post.author) problems.push(`${at}: the connection's statement is not the author's`);
    if (statement.key !== sig.connection_key) problems.push(`${at}: the connection's statement names another connection key`);
    const posted = Date.parse(post.posted_at);
    if (!(posted >= statement.notBefore * 1000)) problems.push(`${at}: the post is dated before the connection's statement was made`);
    if (!(posted <= statement.notAfter * 1000)) problems.push(`${at}: the post is dated after the connection's statement ran out`);
    const preimage = delegationPreimage(bytes);
    const envelope = delegation.signature;
    if (envelope?.alg === "ed25519") {
      const key = hex(typeof sig.public_key === "string" ? sig.public_key : "");
      if (peerIdOf(key).toString("hex") !== post.author) problems.push(`${at}: the signing key is not the author's KEY`);
      if (!verifySignature(key, preimage, hex(typeof envelope.signature === "string" ? envelope.signature : ""))) {
        problems.push(`${at}: the statement's Ed25519 signature does not verify`);
      }
    } else if (envelope?.alg === "webauthn") {
      const spki = Buffer.from(typeof sig.public_key === "string" ? sig.public_key : "", "base64url");
      if (passkeyPeerIdOf(spki).toString("hex") !== post.author) problems.push(`${at}: the passkey is not the author's KEY`);
      const algorithm = (PASSKEY_ALGORITHMS as Record<string, number>)[sig.key_algorithm];
      const key = isPasskeyAlgorithm(algorithm) ? importPasskeyKey(spki, algorithm) : null;
      if (!key || !isPasskeyAlgorithm(algorithm)) {
        problems.push(`${at}: the passkey key is not a key of its algorithm`);
      } else if (site === null) {
        problems.push(`${at}: a passkey signature needs the relying party and origins from GET /v1/capabilities`);
      } else {
        const field = (name: string) => Buffer.from(typeof envelope[name] === "string" ? envelope[name] : "", "base64url");
        const checked = checkAssertion({
          clientDataJSON: field("client_data_json"),
          authenticatorData: field("authenticator_data"),
          signature: field("signature"),
          key,
          algorithm,
          rpId: site.rpId,
          origins: site.origins,
          challenge: createHash("sha256").update(preimage).digest(),
        });
        if ("code" in checked) problems.push(`${at}: the statement's passkey signature does not hold: ${checked.detail}`);
      }
    } else {
      problems.push(`${at}: the connection's statement is signed with an unknown alg`);
    }
  }
  const connectionKey = hex(typeof sig.connection_key === "string" ? sig.connection_key : "");
  const value = hex(typeof sig.signature === "string" ? sig.signature : "");
  if (!verifySignature(connectionKey, signaturePreimageOf(objectId), value)) problems.push(`${at}: the connection signature does not verify`);
  return problems;
}

/** A run of consecutive posts: each verified, and each following the one before. */
export function verifyPostRun(posts: any[], site: PasskeySite, previous: { seq: bigint; chainHash: string } | null): string[] {
  const problems: string[] = [];
  let expect = previous;
  for (const post of posts) {
    problems.push(...verifyPost(post, site));
    const seq = BigInt(post.seq);
    if (expect === null && seq !== 1n) problems.push(`post ${post.seq}: the record starts after post 1`);
    if (expect !== null && seq !== expect.seq + 1n) problems.push(`post ${post.seq}: follows post ${expect.seq}, so posts are missing or out of order`);
    if (expect !== null && post.proof?.chain.previous_hash !== expect.chainHash) problems.push(`post ${post.seq}: does not link to the post before it`);
    expect = { seq, chainHash: post.proof?.chain.chain_hash };
  }
  return problems;
}

/** A run of consecutive governance events from the events export. */
export function verifyEventRun(spaceId: string, events: any[], previous: { revision: bigint; chainHash: string } | null): string[] {
  const problems: string[] = [];
  let expect = previous;
  for (const e of events) {
    const at = `event ${e.revision}`;
    const revision = BigInt(e.revision);
    const bytes = Buffer.from(e.canonical, "base64url");
    if (!commandIdOf(bytes).equals(hex(e.command_id))) problems.push(`${at}: command_id is not the hash of its bytes`);
    const object = jsonObjectOf(bytes);
    if (object === null) {
      problems.push(`${at}: its bytes are not a JSON object`);
    } else if (object.event !== e.event || object.actor !== e.actor || object.revision !== e.revision || !same(object.payload, e.payload)) {
      problems.push(`${at}: the event is not what its bytes say`);
    }
    const before = expect === null ? controlGenesisOf(spaceId).toString("hex") : expect.chainHash;
    if (expect === null && revision !== 1n) problems.push(`${at}: the log starts after revision 1`);
    if (expect !== null && revision !== expect.revision + 1n) problems.push(`${at}: follows revision ${expect.revision}`);
    if (e.previous_hash !== before) problems.push(`${at}: does not link to the event before it`);
    if (controlChainOf(spaceId, revision, hex(e.previous_hash), hex(e.command_id)).toString("hex") !== e.chain_hash) {
      problems.push(`${at}: the chain hash is not its formula`);
    }
    expect = { revision, chainHash: e.chain_hash };
  }
  return problems;
}

/**
 * A checkpoint: its signature, its signer's certificate and root, and, given the
 * links it covers, its predecessor, ending hash and Merkle root.
 */
export function verifyCheckpoint(
  cp: any,
  spaceId: string,
  covered: { position: bigint; id: string; chainHash: string }[] | null,
  options: { root: string | null; previous: any | null },
): string[] {
  const at = `checkpoint ${cp.stream} ${cp.first}-${cp.last}`;
  const problems: string[] = [];
  const canonical = Buffer.from(cp.canonical, "base64url");
  const body = jsonObjectOf(canonical);
  if (body === null) {
    problems.push(`${at}: its signed bytes are not a JSON object`);
  } else {
    for (const field of ["stream", "first", "last", "predecessor_hash", "ending_hash", "merkle_root", "service_epoch", "created_at"]) {
      if (body[field] !== cp[field]) problems.push(`${at}: the signed ${field} is not the one served`);
    }
    // The first checkpoint's bytes carry no previous_checkpoint_id at all.
    if ((body.previous_checkpoint_id ?? null) !== cp.previous_checkpoint_id) problems.push(`${at}: the signed previous_checkpoint_id is not the one served`);
    if (body.signer_key_id !== cp.signer.key_id) problems.push(`${at}: the signed signer_key_id is not the one served`);
  }
  if (cp.signer.key_id !== serviceKeyIdOf(hex(cp.signer.public_key)).toString("hex")) problems.push(`${at}: the signer's key_id is not the id of its public key`);
  if (body !== null && body.space_id !== spaceId) problems.push(`${at}: signed for another SPACE`);
  if (!checkpointIdOf(canonical).equals(hex(cp.checkpoint_id))) problems.push(`${at}: checkpoint_id is not the hash of its bytes`);
  if (!verifyStatement("checkpoint", canonical, hex(cp.signature), hex(cp.signer.public_key))) problems.push(`${at}: the signature does not verify against its signer`);
  const certificate = Buffer.from(cp.signer.certificate, "base64url");
  const cert = jsonObjectOf(certificate);
  if (cert === null) {
    problems.push(`${at}: its certificate is not a JSON object`);
  } else {
    if (cert.key !== cp.signer.public_key) problems.push(`${at}: the certificate names another key`);
    if (!Array.isArray(cert.purposes) || !cert.purposes.includes("checkpoint")) problems.push(`${at}: the certificate does not let its key sign checkpoints`);
  }
  if (!verifyStatement("certificate", certificate, hex(cp.signer.certificate_signature), hex(cp.signer.root_key))) problems.push(`${at}: the certificate does not verify against its root`);
  // A certificate vouches for its key between its dates. A checkpoint signed outside
  // them was signed by a key its root no longer stood behind: stolen, or retired.
  // A minute of slack for not_before, as loadServiceKey allows. A certificate that
  // could not be read says no dates, and is named for that here too.
  const created = Date.parse(cp.created_at);
  const notBefore = Date.parse(cert?.not_before);
  const notAfter = cert?.not_after === undefined ? null : Date.parse(cert.not_after);
  if (Number.isNaN(created) || Number.isNaN(notBefore) || (notAfter !== null && Number.isNaN(notAfter))) {
    problems.push(`${at}: the checkpoint or its certificate does not say when`);
  } else if (created < notBefore - 60_000 || (notAfter !== null && created >= notAfter)) {
    problems.push(`${at}: signed outside the dates its key's certificate is valid`);
  }
  if (options.root !== null && cp.signer.root_key !== options.root) problems.push(`${at}: signed under root ${cp.signer.root_key}, not the root you trust`);

  if (options.previous === null) {
    if (cp.first !== "1" || cp.previous_checkpoint_id !== null) problems.push(`${at}: the first checkpoint must start at 1 and name none before it`);
  } else {
    if (BigInt(cp.first) !== BigInt(options.previous.last) + 1n) problems.push(`${at}: does not start where the last checkpoint ended`);
    if (cp.previous_checkpoint_id !== options.previous.checkpoint_id) problems.push(`${at}: does not name the checkpoint before it`);
    if (cp.predecessor_hash !== options.previous.ending_hash) problems.push(`${at}: does not start from the last checkpoint's ending hash`);
  }

  if (covered !== null) {
    const first = BigInt(cp.first);
    const last = BigInt(cp.last);
    const inRange = covered.filter((c) => c.position >= first && c.position <= last);
    if (BigInt(inRange.length) !== last - first + 1n) {
      problems.push(`${at}: the record holds ${inRange.length} of its ${last - first + 1n} positions`);
    } else {
      const leaves = leavesOf(cp.stream, spaceId, inRange.map((c) => ({ position: c.position, id: hex(c.id), chainHash: hex(c.chainHash) })));
      if (merkleRoot(leaves).toString("hex") !== cp.merkle_root) problems.push(`${at}: the record's Merkle root is not the signed one`);
      if (inRange.at(-1)!.chainHash !== cp.ending_hash) problems.push(`${at}: the record's last link is not the signed ending hash`);
    }
  }
  return problems;
}
