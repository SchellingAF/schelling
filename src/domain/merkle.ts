// The Merkle tree a checkpoint commits to, and the proof that one post is in it.
//
// The construction is RFC 9162's (Certificate Transparency version 2):
//
//   leaf     SHA-256(0x00 || the leaf's bytes)
//   node     SHA-256(0x01 || left || right)
//   root     one leaf is its own root; for n > 1, split at the largest power
//            of two strictly below n and hash the two roots together
//
// No last leaf is duplicated to even a level out, which is the mistake that let
// two different trees share a root in Bitcoin's construction. The 0x00 and 0x01
// prefixes are what stop an interior node being presented as a leaf.
//
// A leaf's bytes name its SPACE, its position, its object or command id and its
// chain hash, under a label for its stream, so a proof for one SPACE or stream is
// worthless for another:
//
//   post     "agent-state:checkpoint-object:v1" NUL || space uuid || int8 seq
//            || object_id || chain_hash
//   event    "agent-state:checkpoint-control:v1" NUL || space uuid || int8 revision
//            || command_id || chain_hash
//
// An inclusion path is the RFC's: the sibling hashes from the leaf's level
// upwards. rootFromPath() is its verification algorithm, section 2.1.3.2, step
// for step.

import { createHash } from "node:crypto";
import { LABEL_CHECKPOINT_CONTROL, LABEL_CHECKPOINT_OBJECT, labelBytes } from "./protocol.ts";
import { int8, uuidBytes } from "./objects.ts";

const LEAF = Buffer.from([0]);
const NODE = Buffer.from([1]);

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/**
 * Every leaf of a range of one stream, in order. The prefix the leaves share, the
 * label and the SPACE, is written once rather than once a leaf.
 */
export function leavesOf(stream: "posts" | "events", spaceId: string, rows: { position: bigint; id: Buffer; chainHash: Buffer }[]): Buffer[] {
  const label = stream === "posts" ? LABEL_CHECKPOINT_OBJECT : LABEL_CHECKPOINT_CONTROL;
  const prefix = Buffer.concat([LEAF, labelBytes(label), uuidBytes(spaceId)]);
  return rows.map((row) => sha256(prefix, int8(row.position), row.id, row.chainHash));
}

/** The leaf of one post. */
export function objectLeafOf(spaceId: string, seq: bigint, objectId: Buffer, chainHash: Buffer): Buffer {
  return leavesOf("posts", spaceId, [{ position: seq, id: objectId, chainHash }])[0]!;
}

/** The largest power of two strictly below n, for n > 1. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) throw new RangeError("an empty range has no root, and is never checkpointed");
  if (leaves.length === 1) return leaves[0]!;
  const k = split(leaves.length);
  return sha256(NODE, merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/**
 * The sibling hashes that lead from leaves[index] to the root, lowest first, and
 * the root they lead to, computed on the way up rather than over the tree again.
 */
export function inclusionPath(leaves: Buffer[], index: number): { root: Buffer; path: Buffer[] } {
  if (index < 0 || index >= leaves.length) throw new RangeError("the index is outside the tree");
  if (leaves.length === 1) return { root: leaves[0]!, path: [] };
  const k = split(leaves.length);
  if (index < k) {
    const left = inclusionPath(leaves.slice(0, k), index);
    const right = merkleRoot(leaves.slice(k));
    return { root: sha256(NODE, left.root, right), path: [...left.path, right] };
  }
  const left = merkleRoot(leaves.slice(0, k));
  const right = inclusionPath(leaves.slice(k), index - k);
  return { root: sha256(NODE, left, right.root), path: [...right.path, left] };
}

/** The root a leaf and its path imply, or null when the path cannot belong to a tree of that size. */
export function rootFromPath(leaf: Buffer, index: number, size: number, path: Buffer[]): Buffer | null {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return null;
  let fn = index;
  let sn = size - 1;
  let r = leaf;
  for (const p of path) {
    if (sn === 0) return null;
    if ((fn & 1) === 1 || fn === sn) {
      r = sha256(NODE, p, r);
      if ((fn & 1) === 0) {
        while ((fn & 1) === 0 && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = sha256(NODE, r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 ? r : null;
}
