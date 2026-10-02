// Writes test/fixtures/sealed-vectors.json: fixed inputs, and what the independent
// implementation (test/lib/hpke-node.ts) makes of them.
//
// The file only grows. A value in it is a promise that anything sealed that way
// opens forever, so nothing already written is ever changed: run this after adding
// a case, check that the diff only adds, and commit the file with the change that
// needed it. content/sealed.mjs must reproduce every value (test/sealed-format.test.ts),
// and so must every other copy of it.
//
//   node scripts/sealed-vectors.ts

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as twin from "../test/lib/hpke-node.ts";

const OUT = new URL("../test/fixtures/sealed-vectors.json", import.meta.url);

/** Deterministic bytes for a name, so every input is reproducible from this file alone. */
const fixed = (name: string, length = 32) => {
  const out = Buffer.alloc(length);
  for (let i = 0, block = 0; i < length; block++) {
    const chunk = createHash("sha256").update(`sealed-vectors:${name}:${block}`).digest();
    chunk.copy(out, i, 0, Math.min(32, length - i));
    i += 32;
  }
  return out;
};
const hex = (b: Buffer) => b.toString("hex");

const people = ["alice", "bob", "keeper", "newcomer"].map((name) => {
  const secret = fixed(`${name}:secret`);
  const peerId = fixed(`${name}:peer`);
  const pair = twin.encryptionKeyFromSecret(secret, peerId);
  return { name, secret, peerId, ...pair };
});
const [alice, bob, keeper, newcomer] = people as [typeof people[0], typeof people[0], typeof people[0], typeof people[0]];

const encryption_keys = people.map((p) => ({
  name: p.name,
  secret: hex(p.secret),
  peer_id: hex(p.peerId),
  sk: hex(p.sk),
  pk: hex(p.pk),
  statement: hex(twin.statementBytes(p.peerId, p.pk)),
  fingerprint: twin.fingerprint(p.pk),
}));

function lock(container: Buffer, g: number, secret: Buffer, from: typeof alice, to: typeof alice, name: string) {
  const commitment = twin.commitment(container, g, secret);
  const ikmE = fixed(`${name}:ikmE`);
  return {
    name, g, recipient: hex(to.peerId), sender: hex(from.peerId), commitment: hex(commitment), secret: hex(secret),
    pkR: hex(to.pk), skS: hex(from.sk), ikmE: hex(ikmE),
    lock: hex(twin.sealLock({ container, g, recipient: to.peerId, sender: from.peerId, commitment, secret, pkR: to.pk, skS: from.sk, ikmE })),
  };
}

// A sealed pair: one generation, locked by its starter for both.
const pairContainer = twin.pairContainer(alice.peerId, bob.peerId);
const pairSecret = fixed("pair:secret");
const pair = {
  name: "a sealed pair",
  pair: [hex(alice.peerId), hex(bob.peerId)].sort(),
  container: hex(pairContainer),
  generations: [{ g: 1, secret: hex(pairSecret), commitment: hex(twin.commitment(pairContainer, 1, pairSecret)) }],
  locks: [
    lock(pairContainer, 1, pairSecret, alice, alice, "pair:alice"),
    lock(pairContainer, 1, pairSecret, alice, bob, "pair:bob"),
  ],
};

// A sealed SPACE: three generations chained back, and the keeper's locks for the third.
const spaceId = "0192a8c4-7e3b-7b2e-9f00-0123456789ab";
const spaceContainer = twin.spaceContainer(spaceId);
const secrets = [1, 2, 3].map((g) => fixed(`space:secret:${g}`));
const space = {
  name: "a sealed SPACE with three generations",
  space_id: spaceId,
  container: hex(spaceContainer),
  generations: secrets.map((secret, i) => ({
    g: i + 1,
    secret: hex(secret),
    commitment: hex(twin.commitment(spaceContainer, i + 1, secret)),
    ...(i > 0 ? { back: hex(twin.sealBack(spaceContainer, i + 1, secret, secrets[i - 1]!)) } : {}),
  })),
  locks: [
    lock(spaceContainer, 3, secrets[2]!, keeper, alice, "space:alice"),
    lock(spaceContainer, 3, secrets[2]!, keeper, newcomer, "space:newcomer"),
  ],
};

const canonical = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))), "utf8");

function item(name: string, header: Record<string, unknown>, secret: Buffer, content: Record<string, unknown>) {
  const h = canonical(header);
  const c = canonical(content);
  return {
    name, header: hex(h), header_digest: hex(twin.headerDigest(h)), secret: hex(secret),
    content: hex(c), ciphertext: hex(twin.sealItem(h, secret, c)),
  };
}

const [lo, hi] = [hex(alice.peerId), hex(bob.peerId)].sort() as [string, string];
const items = [
  item(
    "a message",
    { v: 1, type: "message", suite: 1, author: hex(alice.peerId), generation: 1, pair: [lo, hi], salt: hex(fixed("message:salt", 16)) },
    pairSecret,
    { body: "Meet in the sealed space at 14:00. ✓" },
  ),
  item(
    "a post under the third generation, addressed and replying",
    {
      v: 1, type: "post", suite: 1, author: hex(alice.peerId), generation: 3, space_id: spaceId, kind: "result",
      to: [hex(newcomer.peerId)], reply_to: "0192a8c4-7e3b-7b2e-9f00-0123456789aa", salt: hex(fixed("post:salt", 16)),
    },
    secrets[2]!,
    { body: "12 of 12 passed", title: "suite green" },
  ),
  item(
    "a post under the first generation, which a newcomer reaches through the chain",
    { v: 1, type: "post", suite: 1, author: hex(keeper.peerId), generation: 1, space_id: spaceId, kind: "dossier", salt: hex(fixed("old:salt", 16)) },
    secrets[0]!,
    { body: "The state as of generation one." },
  ),
];

const doc = {
  about:
    "Sealed conversations and SPACES, version 1, suite 1 (content/sealed.md). Written by scripts/sealed-vectors.ts " +
    "with test/lib/hpke-node.ts, the implementation written from the spec without reading content/sealed.mjs; every input " +
    "is derived from a name, so the file reproduces itself. content/sealed.mjs and every other copy of it must " +
    "reproduce every value. Append only: nothing written here ever changes, because a post sealed this way must open forever.",
  encryption_keys,
  containers: [pair, space],
  items,
};

const text = `${JSON.stringify(doc, null, 2)}\n`;
let before = "";
try {
  before = readFileSync(OUT, "utf8");
} catch {
  // first run
}
writeFileSync(OUT, text);
process.stdout.write(before === text ? "unchanged\n" : before === "" ? "written\n" : "CHANGED: check the diff only adds\n");
