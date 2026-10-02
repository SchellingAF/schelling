// The arithmetic of signed posts, chains and checkpoints, without a database.
//
// Three kinds of evidence, in order of how much they are worth. The RFC 8785
// vectors copied from the RFC itself, which nobody here wrote. The object vectors
// checked by scripts/second-signer.sh, whose OpenSSL and Python share no code
// with this repository. And the Merkle trees checked against hashes written out by
// hand for the small sizes, where the construction can still be seen.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, readCanonical } from "../src/domain/jcs.ts";
import {
  admissionOf,
  buildPostObject,
  commandIdOf,
  controlChainOf,
  controlGenesisOf,
  objectChainOf,
  objectGenesisOf,
  passkeyChallengeOf,
  privateDigestOf,
  readPostObject,
  signaturePreimageOf,
} from "../src/domain/objects.ts";
import { inclusionPath, leavesOf, merkleRoot, objectLeafOf, rootFromPath } from "../src/domain/merkle.ts";

/** A refusal whose detail says `what`: an ApiError carries the reason in its detail, not its message. */
const refusal = (what: RegExp) => (error: unknown) => what.test((error as { detail?: string }).detail ?? "");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (file: string) => JSON.parse(readFileSync(path.join(ROOT, "test", "fixtures", file), "utf8"));

describe("RFC 8785 canonical JSON", () => {
  const vectors = json("jcs-vectors.json");

  test("every canonical vector writes exactly its output, and reads back", () => {
    for (const v of vectors.canonical) {
      assert.equal(canonicalize(JSON.parse(v.input)), v.output, v.name);
      assert.deepEqual(readCanonical(Buffer.from(v.output, "utf8"), "canonical"), JSON.parse(v.output), v.name);
    }
  });

  test("every text that is JSON but not canonical is refused as canonical bytes", () => {
    for (const v of vectors.not_canonical) {
      assert.throws(() => readCanonical(Buffer.from(v.text, "utf8"), "canonical"), Error, v.name);
    }
  });

  test("a value JSON cannot say is an error, never a repair", () => {
    const lone = String.fromCharCode(0xd800);
    for (const bad of [lone, { [lone]: 1 }, Number.NaN, Infinity, undefined, () => 1, new Date(0), 1n]) {
      assert.throws(() => canonicalize(bad), TypeError);
    }
    assert.throws(() => readCanonical(Buffer.from([0xff, 0xfe]), "canonical"), refusal(/UTF-8/));
  });
});

describe("the object vectors", () => {
  const v = json("object-vectors.json");

  test("rebuild from their fields, and hash, sign and link as published", () => {
    const object = JSON.parse(v.object.canonical_utf8);
    const priv = JSON.parse(v.object.private_utf8);
    const built = buildPostObject(
      {
        spaceId: object.space_id,
        author: object.author_id,
        idempotencyKey: object.idempotency_key,
        kind: object.kind,
        title: object.title,
        body: object.body,
        to: object.to ?? [],
        replyTo: null,
        supersedes: null,
        retracts: null,
        fingerprints: object.fingerprints,
        data: priv.data,
        budget: null,
        runId: null,
      },
      Buffer.from(priv.salt, "hex"),
    );
    assert.equal(built.canonical.toString("utf8"), v.object.canonical_utf8);
    assert.equal(built.private!.toString("utf8"), v.object.private_utf8);
    assert.equal(privateDigestOf(built.private!).toString("hex"), v.object.private_digest);
    assert.equal(built.objectId.toString("hex"), v.object.object_id);
    assert.equal(passkeyChallengeOf(built.objectId).toString("hex"), v.object.passkey_challenge_hex);

    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(v.public_key_hex, "hex")]), format: "der", type: "spki" });
    assert.ok(verify(null, signaturePreimageOf(built.objectId), key, Buffer.from(v.object.ed25519_signature_hex, "hex")));

    const command = commandIdOf(Buffer.from(v.control.canonical_utf8, "utf8"));
    assert.equal(command.toString("hex"), v.control.command_id);
    assert.equal(controlGenesisOf(v.space_id).toString("hex"), v.control.genesis_hash);
    const controlLink = controlChainOf(v.space_id, 1n, controlGenesisOf(v.space_id), command);
    assert.equal(controlLink.toString("hex"), v.control.chain_hash);
    const admission = admissionOf(1n, controlLink);
    assert.equal(admission.toString("hex"), v.chain.admission);
    assert.equal(objectGenesisOf(v.space_id).toString("hex"), v.chain.genesis_hash);
    const link = objectChainOf(v.space_id, 1n, admission, objectGenesisOf(v.space_id), built.objectId);
    assert.equal(link.toString("hex"), v.chain.chain_hash);
    assert.equal(objectLeafOf(v.space_id, 1n, built.objectId, link).toString("hex"), v.checkpoint_leaf);
  });

  test("and read strictly: the published object is a valid signed post for its author and SPACE", () => {
    const fields = readPostObject(Buffer.from(v.object.canonical_utf8, "utf8"), Buffer.from(v.object.private_utf8, "utf8"), {
      spaceId: v.space_id,
      author: v.author_id,
    });
    assert.equal(fields.idempotencyKey, "vector-1");
    assert.deepEqual(fields.data, { x_attempts: 2, x_platform: "linux" });
    assert.throws(() => readPostObject(Buffer.from(v.object.canonical_utf8, "utf8"), null, { spaceId: v.space_id, author: v.author_id }), refusal(/not sent/));
    assert.throws(() => readPostObject(Buffer.from(v.object.canonical_utf8, "utf8"), Buffer.from(v.object.private_utf8, "utf8"), { spaceId: v.space_id, author: "00".repeat(32) }), refusal(/author_id/));
  });

  test("agree with a second signer written apart, in OpenSSL and Python", (t) => {
    const run = spawnSync(path.join(ROOT, "scripts", "second-signer.sh"), [], { encoding: "utf8" });
    if (run.status === 77) {
      t.skip(`the second signer cannot run here: ${run.stderr.trim()}`);
      return;
    }
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /second signer agrees/);
  });
});

describe("the Merkle tree a checkpoint commits to", () => {
  const H = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
  const NODE = Buffer.from([1]);
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => H(Buffer.from([0]), Buffer.from(`leaf ${i}`)));

  test("hashes each leaf of either stream from 0x00, its stream's label, the SPACE, the position, the id and the link", () => {
    // The object vector pins a post's one leaf; this holds an event's leaves, and
    // every leaf of a range, to the same formula written out by hand.
    const space = "7d0b54d2-3c6e-4f0a-9b1e-2a5c8e61f4d7";
    const uuid = Buffer.from(space.replaceAll("-", ""), "hex");
    const int8 = (n: bigint) => {
      const out = Buffer.alloc(8);
      out.writeBigInt64BE(n);
      return out;
    };
    const rows = [7n, 8n, 9n].map((position) => ({ position, id: H(Buffer.from(`id ${position}`)), chainHash: H(Buffer.from(`link ${position}`)) }));
    for (const [stream, label] of [["posts", "agent-state:checkpoint-object:v1"], ["events", "agent-state:checkpoint-control:v1"]] as const) {
      const byHand = rows.map((row) => H(Buffer.from([0]), Buffer.from(`${label}\0`, "utf8"), uuid, int8(row.position), row.id, row.chainHash));
      assert.deepEqual(leavesOf(stream, space, rows), byHand, stream);
    }
  });

  test("has the roots RFC 9162 gives for one to five leaves, written out by hand", () => {
    const [a, b, c, d, e] = leaves(5) as [Buffer, Buffer, Buffer, Buffer, Buffer];
    assert.deepEqual(merkleRoot([a]), a);
    assert.deepEqual(merkleRoot([a, b]), H(NODE, a, b));
    assert.deepEqual(merkleRoot([a, b, c]), H(NODE, H(NODE, a, b), c), "the last leaf is not duplicated");
    assert.deepEqual(merkleRoot([a, b, c, d]), H(NODE, H(NODE, a, b), H(NODE, c, d)));
    assert.deepEqual(merkleRoot([a, b, c, d, e]), H(NODE, H(NODE, H(NODE, a, b), H(NODE, c, d)), e));
    assert.throws(() => merkleRoot([]), RangeError);
  });

  test("proves every leaf of trees of 1, 2, 3, 4, 5, 7, 16, 17 and 1,024, and nothing else", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 16, 17, 1024]) {
      const tree = leaves(n);
      const root = merkleRoot(tree);
      const indices = n > 64 ? [0, 1, 511, 512, 1000, n - 1] : tree.map((_, i) => i);
      for (const i of indices) {
        const { root: proved, path } = inclusionPath(tree, i);
        assert.deepEqual(proved, root, `the root proved with leaf ${i} of ${n}`);
        assert.deepEqual(rootFromPath(tree[i]!, i, n, path), root, `leaf ${i} of ${n}`);
        if (n > 1) {
          const moved = rootFromPath(tree[i]!, (i + 1) % n, n, path);
          assert.ok(moved === null || !moved.equals(root), `leaf ${i} of ${n} verified at another index`);
          const tampered = Buffer.from(tree[i]!);
          tampered[0] = tampered[0]! ^ 1;
          assert.ok(!rootFromPath(tampered, i, n, path)?.equals(root), `a tampered leaf ${i} of ${n} verified`);
        }
      }
    }
  });
});
