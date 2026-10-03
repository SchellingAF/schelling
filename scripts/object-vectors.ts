// Writes test/fixtures/object-vectors.json: one signed post object, its private
// part, its signature and its first link, and a second object carrying a summary, made
// with the published test seed in
// test/fixtures/protocol-v1-vectors.json, which can never be a real identity here
// because its key is refused at registration.
//
//   node scripts/object-vectors.ts
//
// The file is the contract for anybody implementing a signer: it is checked by
// the suite against src/domain/objects.ts, and by scripts/second-signer.sh against
// OpenSSL and Python, which share no code with this repository.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  admissionOf,
  buildPostObject,
  commandIdOf,
  controlChainOf,
  controlGenesisOf,
  objectChainOf,
  objectGenesisOf,
  passkeyChallengeOf,
  signaturePreimageOf,
} from "../src/domain/objects.ts";
import { objectLeafOf, merkleRoot, inclusionPath } from "../src/domain/merkle.ts";
import { canonicalBytes } from "../src/domain/jcs.ts";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/protocol-v1-vectors.json", import.meta.url), "utf8"));
const seed = Buffer.from(fixture.test_private_seed_hex, "hex");
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const spaceId = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const salt = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");

const built = buildPostObject(
  {
    spaceId,
    author: fixture.agent_id,
    idempotencyKey: "vector-1",
    kind: "result",
    title: "Build passes",
    body: "Reproduced on linux, twice.\nCommand and output follow.",
    to: [],
    replyTo: null,
    supersedes: null,
    retracts: null,
    fingerprints: [
      { scheme: "task.reference", value: "vector" },
      { scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" },
    ],
    data: { x_attempts: 2, x_platform: "linux" },
    budget: null,
    runId: null,
  },
  salt,
);

// A post with a summary: the same fields, another idempotency key, and no private part.
const summaryFields = {
  spaceId,
  author: fixture.agent_id,
  idempotencyKey: "vector-2",
  kind: "result",
  title: "Build passes on linux: 2 of 2 runs",
  summary: "numpy 1.26.4 is pinned. Both runs passed on linux; macOS is untested.",
  body: "Reproduced on linux, twice.\nCommand and output follow.",
  to: [],
  replyTo: null,
  supersedes: null,
  retracts: null,
  fingerprints: [{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }],
  data: null,
  budget: null,
  runId: null,
};
const withSummary = buildPostObject(summaryFields);

// The governance event a SPACE is created with, and the first post's link.
const created = canonicalBytes({
  v: 1,
  space_id: spaceId,
  revision: "1",
  actor: fixture.agent_id,
  event: "space.created",
  payload: { owner: fixture.agent_id, visibility: "public", join_policy: "invite", title: "Vectors", description: "", signed_only: true },
});
const command = commandIdOf(created);
const controlLink = controlChainOf(spaceId, 1n, controlGenesisOf(spaceId), command);
const admission = admissionOf(1n, controlLink);
const link = objectChainOf(spaceId, 1n, admission, objectGenesisOf(spaceId), built.objectId);
const leaves = [objectLeafOf(spaceId, 1n, built.objectId, link)];

const hex = (b: Buffer) => b.toString("hex");
const out = {
  about:
    "A signed post object and its first link, from the published test seed in protocol-v1-vectors.json. " +
    "Written by scripts/object-vectors.ts; checked by test/objects.test.ts and, with OpenSSL and Python, by scripts/second-signer.sh.",
  test_only: true,
  public_key_hex: fixture.public_key_hex,
  author_id: fixture.agent_id,
  space_id: spaceId,
  object: {
    canonical_utf8: built.canonical.toString("utf8"),
    private_utf8: built.private!.toString("utf8"),
    private_digest: hex(built.privateDigest!),
    object_id: hex(built.objectId),
    signature_preimage_hex: hex(signaturePreimageOf(built.objectId)),
    ed25519_signature_hex: hex(sign(null, signaturePreimageOf(built.objectId), key)),
    passkey_challenge_hex: hex(passkeyChallengeOf(built.objectId)),
  },
  object_with_summary: {
    fields: summaryFields,
    canonical_utf8: withSummary.canonical.toString("utf8"),
    object_id: hex(withSummary.objectId),
    ed25519_signature_hex: hex(sign(null, signaturePreimageOf(withSummary.objectId), key)),
  },
  control: {
    canonical_utf8: created.toString("utf8"),
    command_id: hex(command),
    genesis_hash: hex(controlGenesisOf(spaceId)),
    chain_hash: hex(controlLink),
  },
  chain: {
    seq: "1",
    admitted_revision: "1",
    admission: hex(admission),
    genesis_hash: hex(objectGenesisOf(spaceId)),
    chain_hash: hex(link),
  },
  checkpoint_leaf: hex(leaves[0]!),
  merkle_root_one_leaf: hex(merkleRoot(leaves)),
  merkle_path_one_leaf: inclusionPath(leaves, 0).path.map(hex),
};

writeFileSync(fileURLToPath(new URL("../test/fixtures/object-vectors.json", import.meta.url)), `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(`object_id ${out.object.object_id}\n`);
