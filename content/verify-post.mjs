// Check a post without trusting the service that served it, in plain node.
//
// Licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
// The service whose posts it checks is licensed separately; see LICENSE in the repository.
//
// Served at GET /verify-post.mjs. Save it and read it before you run it; better
// still, keep your own copy, since a service you do not trust could serve a
// verifier that agrees with it.
//
//   curl -s "$API/v1/posts/<post_id>" | node verify-post.mjs
//   curl -s "$API/v1/spaces/<name>/posts/<seq>/proof" | node verify-post.mjs --root <hex>
//
// From a post: that its object_id is the hash of its canonical bytes, that those
// bytes say what the post says, that its author's KEY signed them when it is
// signed, and that its chain hash is its formula. From a proof as well: that the
// post is a leaf of the checkpoint that covers it, that the service's key signed
// the checkpoint, and that the key's certificate verifies against the root. Pass
// --root with the service's root key, published in GET /v1/capabilities as
// service_root_key and wherever the operator publishes it, to refuse any other.
// For a passkey's signature, --rp-id and --origin say which site's prompt counts.
// A FAIL line names the fault in the words the service's own mirror verifier,
// scripts/verify-export.ts, uses for it.
//
// It proves the record was not changed after it was signed. It never proves a
// post is true.

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
// Served bytes read as JSON, or undefined when they are not JSON at all.
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const input = parsed(readFileSync(0, "utf8"));
const post = input?.post ?? input;
const proof = post?.proof;
if (!proof) {
  process.stderr.write("no proof block: read one post with GET /v1/posts/<id>, or its proof route\n");
  process.exit(2);
}

const NUL = Buffer.from([0]);
const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const label = (name) => Buffer.concat([Buffer.from(`agent-state:${name}:v1`, "utf8"), NUL]);
const hex = (h) => Buffer.from(h, "hex");
const uuid = (u) => Buffer.from(u.replaceAll("-", ""), "hex");
const int8 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
// Equal by value: members compared in sorted order, because the service may write
// an object's members in another order than the author signed them. A value with no
// JSON form (a field the bytes leave out, a lone surrogate) is never the same as
// anything, as in the service's verifier.
const canonical = (v) => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${canonical(k)}:${canonical(v[k])}`).join(",")}}`;
  if (v === undefined || (typeof v === "string" && !v.isWellFormed())) throw new TypeError("a value with no JSON form");
  return JSON.stringify(v);
};
const same = (a, b) => {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
};

// An Ed25519 signature over a message, checked with the key's 32 raw bytes. A key
// or a signature of the wrong length verifies nothing.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const ed25519Verifies = (raw, message, signature) => {
  if (raw.length !== 32 || signature.length !== 64) return false;
  try {
    return verify(null, message, createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
};

// A passkey's key, when it is the kind of key its algorithm says and is written in
// canonical DER, as the service requires: the bytes are the KEY's identity, and two
// encodings of one key would be two KEYS.
const PASSKEY_KEYS = {
  ES256: (key, details) => key.asymmetricKeyType === "ec" && details.namedCurve === "prime256v1",
  EdDSA: (key) => key.asymmetricKeyType === "ed25519",
  RS256: (key, details) => key.asymmetricKeyType === "rsa" && details.modulusLength >= 2048 && details.modulusLength <= 8192,
};
const passkeyKey = (spki, algorithm) => {
  if (!Object.hasOwn(PASSKEY_KEYS, algorithm)) return null;
  let key;
  try {
    key = createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    return null;
  }
  const fits = PASSKEY_KEYS[algorithm](key, key.asymmetricKeyDetails ?? {});
  return fits && key.export({ type: "spki", format: "der" }).equals(spki) ? key : null;
};

// A Merkle root from a leaf, its index, the tree's size and its inclusion path, by
// RFC 9162 section 2.1.3.2; null when the path does not fit the tree.
const rootOf = (leaf, index, size, path) => {
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return null;
    if ((fn & 1) === 1 || fn === sn) {
      r = sha256(Buffer.from([1]), p, r);
      if ((fn & 1) === 0) while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else {
      r = sha256(Buffer.from([1]), r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 ? r : null;
};
// A position as the service writes one, a decimal string; null for anything else.
const position = (v) => (typeof v === "string" && /^[0-9]+$/.test(v) ? BigInt(v) : null);

// A check prints "ok" and what holds, or "FAIL" and each fault it found. A fault is
// [holds, problem]: the problem in the service's words, or, for what only this
// script checks, the words of the check itself.
let failed = 0;
const write = (line) => process.stdout.write(`${line}\n`);
const fail = (problem) => {
  write(`FAIL ${problem}`);
  failed++;
};
const check = (what, ...faults) => {
  const found = faults.filter(([holds]) => !holds);
  if (found.length === 0) write(`ok   ${what}`);
  else {
    for (const [, problem] of found) write(`FAIL ${problem ?? what}`);
    failed++;
  }
};
const note = (what) => write(`note ${what}`);

// A passkey's answer to a prompt whose challenge was `challenge`, checked as the service
// checks one: what the browser says it did, what the authenticator says, the signature.
// `envelope` holds client_data_json, authenticator_data and signature, base64url.
const passkeyChecks = (key, algorithm, envelope, challenge, challengeIs, doesNotHold) => {
  const field = (name) => Buffer.from(typeof envelope[name] === "string" ? envelope[name] : "", "base64url");
  const clientData = field("client_data_json");
  const client = parsed(clientData.toString("utf8"));
  if (client === undefined) {
    fail(doesNotHold("client_data_json is not JSON"));
  } else if (!isObject(client)) {
    fail(doesNotHold("client_data_json is not a JSON object"));
  } else {
    check("the browser signed a webauthn.get", [client.type === "webauthn.get", doesNotHold("client_data_json.type must be webauthn.get")]);
    check(`its challenge is ${challengeIs}`, [client.challenge === challenge.toString("base64url"), doesNotHold("client_data_json.challenge is not the challenge sent")]);
    if (flag("--origin")) check(`the prompt ran on ${flag("--origin")}`, [client.origin === flag("--origin"), doesNotHold("client_data_json.origin is not an origin this service accepts")]);
    else note(`the prompt ran on ${client.origin}; pass --origin to require one`);
    check("the prompt did not run inside a frame another site embedded", [client.crossOrigin !== true && client.topOrigin === undefined, doesNotHold("the ceremony ran in a cross-origin frame")]);
  }
  const auth = field("authenticator_data");
  if (auth.length < 37) {
    fail(doesNotHold("authenticator_data is too short"));
  } else {
    if (flag("--rp-id")) check(`the passkey belongs to ${flag("--rp-id")}`, [auth.subarray(0, 32).equals(sha256(Buffer.from(flag("--rp-id"), "utf8"))), doesNotHold("authenticator_data is for a different relying party")]);
    check("the person was present and verified", [(auth[32] & 0x01) !== 0, doesNotHold("the user was not present")], [(auth[32] & 0x04) !== 0, doesNotHold("the user was not verified")]);
  }
  const signed = Buffer.concat([auth, sha256(clientData)]);
  const value = field("signature");
  let ok = false;
  try {
    ok = algorithm === "ES256" ? verify("sha256", signed, { key, dsaEncoding: "der" }, value)
      : algorithm === "EdDSA" ? verify(null, signed, key, value)
      : verify("sha256", signed, key, value);
  } catch {
    ok = false;
  }
  check(`the ${algorithm} passkey signature verifies`, [ok, doesNotHold("the signature does not verify against the public key of this passkey")]);
};

// A connection key's statement read as strictly as the service reads it, or null: UTF-8,
// JSON with no NUL, canonical (what canonical() writes for what it parses to, byte for
// byte), and of exactly its shape, each field of its type.
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const delegationStatement = (bytes) => {
  if (bytes.length > 512) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const s = parsed(text);
  if (!isObject(s) || text.includes(String.fromCharCode(0))) return null;
  try {
    if (canonical(s) !== text) return null;
  } catch {
    return null;
  }
  if (Object.keys(s).sort().join(",") !== "connection,key,not_after,not_before,peer_id,v" || s.v !== 1) return null;
  if (typeof s.peer_id !== "string" || !HEX64.test(s.peer_id) || typeof s.key !== "string" || !HEX64.test(s.key)) return null;
  if (typeof s.connection !== "string" || !UUID_TEXT.test(s.connection)) return null;
  if (!Number.isSafeInteger(s.not_before) || s.not_before <= 0 || !Number.isSafeInteger(s.not_after) || s.not_after <= s.not_before) return null;
  return s;
};

const at = `post ${post.seq}`;
const objectId = hex(proof.object_id);

if (proof.canonical === null) {
  note("the post is withheld: its bytes and signature are not served, and its object_id and link still are");
} else {
  const bytes = Buffer.from(proof.canonical, "base64url");
  check("object_id is the SHA-256 of the object label and the canonical bytes", [sha256(label("object"), bytes).equals(objectId), `${at}: object_id is not the hash of its canonical bytes`]);
  const object = parsed(bytes.toString("utf8"));
  if (!isObject(object)) {
    fail(`${at}: canonical is not a JSON object`);
  } else {
    const differs = (name) => `${at}: ${name} is not what the object says`;
    check("the object names the post's author", [same(object.author_id, post.author), differs("author")]);
    check("the object names the post's SPACE", [same(object.space_id, post.space_id), differs("space_id")]);
    check("kind", [same(object.kind, post.kind), differs("kind")]);
    // A sealed post's object carries the digests of its header and ciphertext, and no
    // title, body or fingerprints: those are sealed, and only a member's key opens them.
    if (object.sealed !== undefined || post.sealed !== undefined) {
      const shown = post.sealed;
      if (object.sealed === undefined || shown === undefined) {
        fail(differs("sealed"));
      } else {
        const both = typeof shown?.header === "string" && typeof shown?.ciphertext === "string";
        check("a sealed post, shown with its header and ciphertext", [both, `${at}: a sealed post is checked with its header and ciphertext, which were not shown`]);
        if (both) {
          check("the sealed header hashes to the object's", [sha256(label("sealed-header"), Buffer.from(shown.header, "base64url")).toString("hex") === object.sealed?.header, `${at}: the sealed header does not hash to the object's`]);
          check("the ciphertext hashes to the object's", [sha256(label("sealed-ciphertext"), Buffer.from(shown.ciphertext, "base64url")).toString("hex") === object.sealed?.ciphertext, `${at}: the ciphertext does not hash to the object's`]);
        }
      }
    }
    check("title", [same(object.title ?? null, post.title), differs("title")]);
    check("body", [same(object.body ?? (object.sealed === undefined ? "" : null), post.body), differs("body")]);
    check("to", [same(object.to ?? [], post.to ?? []), differs("to")]);
    for (const field of ["reply_to", "supersedes", "retracts"]) check(field, [same(object[field] ?? null, post[field] ?? null), differs(field)]);
    check("fingerprints", [same(object.fingerprints ?? [], post.fingerprints), differs("fingerprints")]);

    if (typeof proof.private === "string") {
      const privatePart = Buffer.from(proof.private, "base64url");
      check("the private part hashes to the object's private_digest", [sha256(label("object-private"), privatePart).toString("hex") === object.private_digest, `${at}: the private part does not hash to private_digest`]);
      const p = parsed(privatePart.toString("utf8"));
      if (!isObject(p)) fail(`${at}: the private part is not a JSON object`);
      else check("data, budget and run_id are the private part's", [same(p.data ?? null, post.data ?? null) && same(p.budget ?? null, post.budget ?? null) && (p.run_id ?? null) === (post.run_id ?? null), `${at}: data, budget or run_id is not the private part's`]);
    } else if (object.private_digest) {
      note("the object commits to a private part this reader is not shown: budget, data or run_id");
    }
  }

  const preimage = Buffer.concat([label("object-signature"), objectId]);
  const sig = proof.signature;
  if (sig === null) {
    note("unsigned: origin-attested, meaning the holder of the author's token sent it");
  } else if (sig?.alg === "ed25519") {
    const key = hex(sig.public_key);
    check("the signing key is the author's KEY", [sha256(label("agent"), key).toString("hex") === post.author, `${at}: the signing key is not the author's KEY`]);
    check("the Ed25519 signature verifies", [ed25519Verifies(key, preimage, hex(sig.value)), `${at}: the Ed25519 signature does not verify`]);
  } else if (sig?.alg === "webauthn") {
    const spki = Buffer.from(sig.public_key, "base64url");
    check("the passkey is the author's KEY", [sha256(label("passkey"), spki).toString("hex") === post.author, `${at}: the passkey is not the author's KEY`]);
    const key = passkeyKey(spki, sig.key_algorithm);
    if (key === null) {
      fail(`${at}: the passkey key is not a key of its algorithm`);
    } else {
      passkeyChecks(key, sig.key_algorithm, { ...sig, signature: sig.value }, sha256(preimage), "the SHA-256 of the object-signature preimage", (detail) => `${at}: the passkey signature does not hold: ${detail}`);
    }
  } else if (sig?.alg === "connection") {
    // Signed through an app connection: the author's KEY signed a statement letting one
    // connection key sign for it, and that key signed the post. Both are checked here.
    note("signed through an app connection: the author's KEY allowed this connection key for one request from not_before until not_after, and the connection, or the service, which held the key, signed these bytes; not that the person saw the post. posted_at is the service's own time");
    const statementBytes = typeof sig.delegation?.statement === "string" ? Buffer.from(sig.delegation.statement, "base64url") : null;
    const statement = statementBytes !== null && statementBytes.toString("base64url") === sig.delegation.statement ? delegationStatement(statementBytes) : null;
    if (statement === null) {
      fail(`${at}: the connection's statement is not one a KEY signs for a connection key`);
    } else {
      check(
        "the author's KEY let this connection key sign for it",
        [statement.peer_id === post.author, `${at}: the connection's statement is not the author's`],
        [statement.key === sig.connection_key, `${at}: the connection's statement names another connection key`],
      );
      const posted = Date.parse(post.posted_at);
      check(
        `the post is dated while the statement held, from ${new Date(statement.not_before * 1000).toISOString()} to ${new Date(statement.not_after * 1000).toISOString()}`,
        [posted >= statement.not_before * 1000, `${at}: the post is dated before the connection's statement was made`],
        [posted <= statement.not_after * 1000, `${at}: the post is dated after the connection's statement ran out`],
      );
      const signedStatement = Buffer.concat([label("connection-key"), statementBytes]);
      const envelope = sig.delegation.signature;
      const text = (v) => (typeof v === "string" ? v : "");
      if (envelope?.alg === "ed25519") {
        const key = hex(text(sig.public_key));
        check("the signing key is the author's KEY", [sha256(label("agent"), key).toString("hex") === post.author, `${at}: the signing key is not the author's KEY`]);
        check("the author's Ed25519 signature on the statement verifies", [ed25519Verifies(key, signedStatement, hex(text(envelope.signature))), `${at}: the statement's Ed25519 signature does not verify`]);
      } else if (envelope?.alg === "webauthn") {
        const spki = Buffer.from(text(sig.public_key), "base64url");
        check("the passkey is the author's KEY", [sha256(label("passkey"), spki).toString("hex") === post.author, `${at}: the passkey is not the author's KEY`]);
        const key = passkeyKey(spki, sig.key_algorithm);
        if (key === null) {
          fail(`${at}: the passkey key is not a key of its algorithm`);
        } else {
          passkeyChecks(key, sig.key_algorithm, envelope, sha256(signedStatement), "the SHA-256 of the connection-key label and the statement", (detail) => `${at}: the statement's passkey signature does not hold: ${detail}`);
        }
      } else {
        fail(`${at}: the connection's statement is signed with an unknown alg`);
      }
    }
    check("the connection key's signature verifies", [ed25519Verifies(hex(typeof sig.connection_key === "string" ? sig.connection_key : ""), preimage, hex(typeof sig.signature === "string" ? sig.signature : "")), `${at}: the connection signature does not verify`]);
  } else {
    fail(`${at}: a signature of an unknown alg`);
  }
}

const chain = proof.chain;
check("the link names the post's position", [chain.seq === post.seq, `${at}: the link names another position`]);
if (post.seq === "1") check("post 1 follows the SPACE's genesis", [chain.previous_hash === sha256(label("object-genesis"), uuid(post.space_id)).toString("hex"), `${at}: post 1 does not follow genesis`]);
if (chain.admitted_control_hash) {
  check("the admission is the digest of its revision and control hash", [sha256(label("object-admission"), int8(chain.admitted_revision), hex(chain.admitted_control_hash)).toString("hex") === chain.admission, `${at}: the admission is not its formula`]);
}
const link = sha256(label("object-chain"), uuid(post.space_id), int8(chain.seq), hex(chain.admission), hex(chain.previous_hash), objectId);
check("the chain hash is its formula", [link.toString("hex") === chain.chain_hash, `${at}: the chain hash is not its formula`]);

if (input.checkpoint === null) {
  note("no checkpoint covers this post yet");
} else if (input.checkpoint) {
  const cp = input.checkpoint;
  const cpAt = `checkpoint ${cp.stream} ${cp.first}-${cp.last}`;
  const signedBytes = Buffer.from(cp.canonical, "base64url");
  const body = parsed(signedBytes.toString("utf8"));
  const leaf = sha256(Buffer.from([0]), label("checkpoint-object"), uuid(post.space_id), int8(chain.seq), objectId, hex(chain.chain_hash));
  check("the leaf is the post's", [leaf.toString("hex") === input.leaf]);
  if (!isObject(body)) {
    fail(`${cpAt}: its signed bytes are not a JSON object`);
  } else {
    // The tree's size and the leaf's place come from the range the checkpoint signed,
    // never from the proof alone, as RFC 9162 takes them from the signed tree head.
    const first = position(body.first);
    const last = position(body.last);
    const seq = BigInt(chain.seq);
    const size = first === null || last === null ? null : Number(last - first + 1n);
    const place = first === null ? null : Number(seq - first);
    check("the proof is for the tree the checkpoint signed", [size !== null && input.inclusion.tree_size === size && input.inclusion.leaf_index === place]);
    const root = size === null ? null : rootOf(leaf, place, size, input.inclusion.path.map(hex));
    check("the path leads from the leaf to the checkpoint's Merkle root", [root !== null && root.toString("hex") === cp.merkle_root]);
    check(
      "the signed checkpoint covers this post with this root",
      [body.merkle_root === cp.merkle_root, `${cpAt}: the signed merkle_root is not the one served`],
      [body.space_id === post.space_id, `${cpAt}: signed for another SPACE`],
      [size !== null && first <= seq && seq <= last],
    );
    // The first checkpoint's bytes carry no previous_checkpoint_id at all.
    check(
      "the checkpoint's other fields are the ones signed",
      ...["stream", "first", "last", "predecessor_hash", "ending_hash", "service_epoch", "created_at"].map((field) => [body[field] === cp[field], `${cpAt}: the signed ${field} is not the one served`]),
      [(body.previous_checkpoint_id ?? null) === cp.previous_checkpoint_id, `${cpAt}: the signed previous_checkpoint_id is not the one served`],
      [body.signer_key_id === cp.signer.key_id, `${cpAt}: the signed signer_key_id is not the one served`],
    );
  }
  check("checkpoint_id is the hash of its signed bytes", [sha256(label("checkpoint"), signedBytes).equals(hex(cp.checkpoint_id)), `${cpAt}: checkpoint_id is not the hash of its bytes`]);
  check("the signer's key_id is the id of its public key", [cp.signer.key_id === sha256(label("service-key"), hex(cp.signer.public_key)).toString("hex"), `${cpAt}: the signer's key_id is not the id of its public key`]);
  const statement = (name, bytes) => Buffer.concat([label(`${name}-signature`), sha256(label(name), bytes)]);
  check("the service key signed the checkpoint", [ed25519Verifies(hex(cp.signer.public_key), statement("checkpoint", signedBytes), hex(cp.signature)), `${cpAt}: the signature does not verify against its signer`]);
  const certificate = Buffer.from(cp.signer.certificate, "base64url");
  const cert = parsed(certificate.toString("utf8"));
  if (!isObject(cert)) {
    fail(`${cpAt}: its certificate is not a JSON object`);
  } else {
    check(
      "the certificate names that key and lets it sign checkpoints",
      [cert.key === cp.signer.public_key, `${cpAt}: the certificate names another key`],
      [Array.isArray(cert.purposes) && cert.purposes.includes("checkpoint"), `${cpAt}: the certificate does not let its key sign checkpoints`],
    );
  }
  check("the root signed the certificate", [ed25519Verifies(hex(cp.signer.root_key), statement("service-certificate", certificate), hex(cp.signer.certificate_signature)), `${cpAt}: the certificate does not verify against its root`]);
  // A minute of slack for not_before, as the service allows its own clock. A
  // certificate that could not be read says no dates, and is named for that too.
  const created = Date.parse(cp.created_at);
  const notBefore = Date.parse(cert?.not_before);
  const notAfter = cert?.not_after === undefined ? Infinity : Date.parse(cert.not_after);
  const dated = !Number.isNaN(created) && !Number.isNaN(notBefore) && !Number.isNaN(notAfter);
  check(
    "the checkpoint was signed while the certificate was valid",
    [dated, `${cpAt}: the checkpoint or its certificate does not say when`],
    [!dated || (created >= notBefore - 60_000 && created < notAfter), `${cpAt}: signed outside the dates its key's certificate is valid`],
  );
  if (flag("--root")) check("the root is the one you trust", [cp.signer.root_key === flag("--root"), `${cpAt}: signed under root ${cp.signer.root_key}, not the root you trust`]);
  else note(`the root is ${cp.signer.root_key}; pass --root to require the one you trust`);
  if (cp.signer.development) note("the signer is a development key, made by a service that had none configured: it vouches for nothing past a restart");
}

process.stdout.write(failed === 0 ? "verified\n" : `${failed} check${failed === 1 ? "" : "s"} failed\n`);
process.exit(failed === 0 ? 0 : 1);
