// Sealing, checked from outside: content/sealed.mjs against RFC 9180's published
// vectors, against Wycheproof's edge cases, against the shared vectors, and
// against test/lib/hpke-node.ts, a second implementation written from
// content/sealed.md on node:crypto without reading the first.
//
// No outside cryptographer has reviewed this. What stands in for one is here.
// Two implementations on different primitives that agree with each other and
// with the RFC, a refusal for every value a lock, a back link or an item binds,
// and the service's own validation rules applied to sealed content, case by case.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as sealed from "../content/sealed.mjs";
import * as twin from "./lib/hpke-node.ts";
import { passkey, passkeyAssertion, type Passkey, type Prompt } from "./lib/passkey.ts";
import { parseStrictJson, requireBudget, requireData, requireFingerprints } from "../src/domain/validate.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const b = (value: Uint8Array) => Buffer.from(value);
const random = (n: number) => sealed.randomBytes(n) as Uint8Array;

async function refuses(what: string, run: () => Promise<unknown> | unknown) {
  await assert.rejects(async () => run(), (error: Error) => error.name === "SealedError" || /does not|auth|refus/i.test(error.message), what);
}

describe("RFC 9180, appendix A.1: suite 1 in the base and auth modes", () => {
  const vectors = fixture("hpke-rfc9180-a1.json").vectors as Array<Record<string, any>>;

  for (const v of vectors) {
    test(`content/sealed.mjs reproduces mode ${v.mode}`, async () => {
      const e = await sealed.deriveKeyPair(bytes(v.ikmE));
      assert.equal(hex(e.sk), v.skEm);
      assert.equal(hex(e.pk), v.pkEm);
      const r = await sealed.deriveKeyPair(bytes(v.ikmR));
      assert.equal(hex(r.sk), v.skRm);
      assert.equal(hex(r.pk), v.pkRm);
      let encap: { sharedSecret: Uint8Array; enc: Uint8Array };
      if (v.mode === 2) {
        const s = await sealed.deriveKeyPair(bytes(v.ikmS));
        assert.equal(hex(s.pk), v.pkSm);
        encap = await sealed.kemAuthEncap(r.pk, s.sk, bytes(v.ikmE));
        assert.equal(hex(await sealed.kemAuthDecap(encap.enc, r.sk, s.pk)), v.shared_secret);
      } else {
        encap = await sealed.kemEncap(r.pk, bytes(v.ikmE));
        assert.equal(hex(await sealed.kemDecap(encap.enc, r.sk)), v.shared_secret);
      }
      assert.equal(hex(encap.enc), v.enc);
      assert.equal(hex(encap.sharedSecret), v.shared_secret);
      const ks = await sealed.keySchedule(v.mode, encap.sharedSecret, bytes(v.info));
      assert.equal(hex(ks.keyScheduleContext), v.key_schedule_context);
      assert.equal(hex(ks.secret), v.secret);
      assert.equal(hex(ks.key), v.key);
      assert.equal(hex(ks.baseNonce), v.base_nonce);
      assert.equal(hex(ks.exporterSecret), v.exporter_secret);
      for (const [seq, x] of (v.encryptions as Array<Record<string, string>>).entries()) {
        const nonce = sealed.nonceFor(ks.baseNonce, seq);
        assert.equal(hex(nonce), x.nonce);
        assert.equal(hex(await sealed.aeadSeal(ks.key, nonce, bytes(x.aad!), bytes(x.pt!))), x.ct);
        assert.equal(hex(await sealed.aeadOpen(ks.key, nonce, bytes(x.aad!), bytes(x.ct!))), x.pt);
      }
    });

    test(`test/lib/hpke-node.ts reproduces mode ${v.mode}`, () => {
      const e = twin.deriveKeyPair(Buffer.from(v.ikmE, "hex"));
      assert.equal(e.pk.toString("hex"), v.pkEm);
      const r = twin.deriveKeyPair(Buffer.from(v.ikmR, "hex"));
      assert.equal(r.sk.toString("hex"), v.skRm);
      const encap = v.mode === 2
        ? twin.authEncap(r.pk, twin.deriveKeyPair(Buffer.from(v.ikmS, "hex")).sk, Buffer.from(v.ikmE, "hex"))
        : twin.encap(r.pk, Buffer.from(v.ikmE, "hex"));
      assert.equal(encap.enc.toString("hex"), v.enc);
      assert.equal(encap.sharedSecret.toString("hex"), v.shared_secret);
      const ks = twin.keySchedule(v.mode, encap.sharedSecret, Buffer.from(v.info, "hex"));
      assert.equal(ks.key.toString("hex"), v.key);
      assert.equal(ks.baseNonce.toString("hex"), v.base_nonce);
      assert.equal(ks.exporterSecret.toString("hex"), v.exporter_secret);
      const first = (v.encryptions as Array<Record<string, string>>)[0]!;
      assert.equal(twin.aeadSeal(ks.key, ks.baseNonce, Buffer.from(first.aad!, "hex"), Buffer.from(first.pt!, "hex")).toString("hex"), first.ct);
    });
  }
});

describe("Wycheproof: X25519 and AES-128-GCM edge cases", () => {
  test("X25519 matches every case, and refuses every one that gives no secret", async () => {
    const cases = fixture("wycheproof-x25519.json").tests as Array<Record<string, any>>;
    let refused = 0;
    for (const c of cases) {
      const zero = /^0+$/.test(c.shared);
      let got: string | null = null;
      try {
        got = hex(await sealed.x25519(bytes(c.private), bytes(c.public)));
      } catch (error) {
        assert.equal((error as Error).name, "SealedError", `case ${c.tcId}`);
      }
      if (zero) {
        assert.equal(got, null, `case ${c.tcId} gives all zero bytes and must be refused`);
        refused++;
      } else if (c.result === "valid") {
        assert.equal(got, c.shared, `case ${c.tcId}`);
      } else if (got !== null) {
        assert.equal(got, c.shared, `case ${c.tcId} is acceptable, and if computed must be right`);
      }
    }
    assert.ok(refused >= 20, "the zero-secret cases were exercised");
  });

  test("AES-128-GCM seals and opens every valid case, and refuses every invalid one, in both implementations", async () => {
    for (const group of fixture("wycheproof-aes128-gcm.json").testGroups as Array<{ tests: Array<Record<string, any>> }>) {
      for (const c of group.tests) {
        const key = bytes(c.key), iv = bytes(c.iv), aad = bytes(c.aad), ct = bytes(c.ct + c.tag);
        if (c.result === "valid") {
          assert.equal(hex(await sealed.aeadSeal(key, iv, aad, bytes(c.msg))), c.ct + c.tag, `case ${c.tcId}`);
          assert.equal(hex(await sealed.aeadOpen(key, iv, aad, ct)), c.msg, `case ${c.tcId}`);
          assert.equal(twin.aeadOpen(b(key), b(iv), b(aad), b(ct)).toString("hex"), c.msg, `case ${c.tcId}`);
        } else {
          await refuses(`case ${c.tcId}`, () => sealed.aeadOpen(key, iv, aad, ct));
          assert.throws(() => twin.aeadOpen(b(key), b(iv), b(aad), b(ct)), `case ${c.tcId}`);
        }
      }
    }
  });
});

describe("the shared vectors", () => {
  test("content/sealed.mjs reproduces every value the independent implementation wrote", async () => {
    const v = fixture("sealed-vectors.json");
    for (const k of v.encryption_keys) {
      const pair = await sealed.encryptionKey(bytes(k.secret), bytes(k.peer_id));
      assert.equal(hex(pair.sk), k.sk);
      assert.equal(hex(pair.pk), k.pk);
      assert.equal(hex(sealed.statementBytes(bytes(k.peer_id), pair.pk)), k.statement);
      assert.equal(await sealed.fingerprint(pair.pk), k.fingerprint);
    }
    for (const c of v.containers) {
      const container = c.pair ? sealed.pairContainer(bytes(c.pair[0]), bytes(c.pair[1])) : sealed.spaceContainer(c.space_id);
      assert.equal(hex(container), c.container);
      for (const g of c.generations) {
        assert.equal(hex(await sealed.commitment(container, g.g, bytes(g.secret))), g.commitment);
        if (g.back) {
          assert.equal(hex(await sealed.sealBack(container, g.g, bytes(g.secret), bytes(c.generations[g.g - 2].secret))), g.back);
        }
      }
      for (const l of c.locks) {
        const lock = await sealed.sealLock({
          container, g: l.g, recipient: bytes(l.recipient), sender: bytes(l.sender), commitment: bytes(l.commitment),
          secret: bytes(l.secret), pkR: bytes(l.pkR), skS: bytes(l.skS), ikmE: bytes(l.ikmE),
        });
        assert.equal(hex(lock), l.lock);
      }
    }
    for (const item of v.items) {
      assert.equal(hex(await sealed.headerDigest(bytes(item.header))), item.header_digest);
      assert.equal(hex(await sealed.sealItem(bytes(item.header), bytes(item.secret), bytes(item.content))), item.ciphertext);
    }
  });
});

describe("the two implementations agree", () => {
  test("encryption keys, statements, fingerprints and commitments are the same bytes", async () => {
    for (let i = 0; i < 25; i++) {
      const secret = random(32), peer = random(32);
      const mine = await sealed.encryptionKey(secret, peer);
      const theirs = twin.encryptionKeyFromSecret(b(secret), b(peer));
      assert.equal(hex(mine.sk), theirs.sk.toString("hex"));
      assert.equal(hex(mine.pk), theirs.pk.toString("hex"));
      assert.equal(hex(sealed.statementBytes(peer, mine.pk)), twin.statementBytes(b(peer), theirs.pk).toString("hex"));
      assert.equal(await sealed.fingerprint(mine.pk), twin.fingerprint(theirs.pk));
      const container = sealed.spaceContainer("0192a8c4-7e3b-7b2e-9f00-0123456789ab");
      assert.equal(hex(await sealed.commitment(container, i + 1, secret)), twin.commitment(b(container), i + 1, b(secret)).toString("hex"));
    }
  });

  test("a lock, a back link and an item sealed by one open with the other, both ways", async () => {
    for (let i = 0; i < 40; i++) {
      const keeper = await sealed.deriveKeyPair(random(32));
      const member = await sealed.deriveKeyPair(random(32));
      const [senderId, recipientId] = [random(32), random(32)];
      const container = i % 2 ? sealed.spaceContainer("0192a8c4-7e3b-7b2e-9f00-0123456789ab") : sealed.pairContainer(random(32), random(32));
      const g = i % 2 ? 3 : 1;
      const secret = random(32);
      const c = await sealed.commitment(container, g, secret);
      const args = { container, g, recipient: recipientId, sender: senderId, commitment: c };
      const mine = await sealed.sealLock({ ...args, secret, pkR: member.pk, skS: keeper.sk });
      assert.equal(hex(twin.openLock({ ...bufs(args), lock: b(mine), skR: b(member.sk), pkS: b(keeper.pk) })), hex(secret));
      const theirs = twin.sealLock({ ...bufs(args), secret: b(secret), pkR: b(member.pk), skS: b(keeper.sk), ikmE: b(random(32)) });
      assert.equal(hex(await sealed.openLock({ ...args, lock: new Uint8Array(theirs), skR: member.sk, pkS: keeper.pk })), hex(secret));

      if (g > 1) {
        const previous = random(32);
        const pc = await sealed.commitment(container, g - 1, previous);
        const back = await sealed.sealBack(container, g, secret, previous);
        assert.equal(twin.openBack(b(container), g, b(secret), b(back)).toString("hex"), hex(previous));
        const backTheirs = twin.sealBack(b(container), g, b(secret), b(previous));
        assert.equal(hex(await sealed.openBack(container, g, secret, new Uint8Array(backTheirs), pc)), hex(previous));
      }

      const header = sealed.postHeader({
        author: hex(senderId), spaceId: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", generation: g,
        salt: hex(random(16)), kind: "result", to: [hex(recipientId)],
      });
      const content = sealed.postContent({ title: `run ${i}`, body: `ünïcode ✓ ${i}`, runId: "0192a8c4-7e3b-7b2e-9f00-0123456789ac" });
      const ct = await sealed.sealItem(header, secret, content);
      assert.equal(twin.openItem(b(header), b(secret), b(ct)).toString("hex"), hex(content));
      const ct2 = twin.sealItem(b(header), b(secret), b(content));
      assert.equal(hex(await sealed.openItem(header, secret, new Uint8Array(ct2))), hex(content));
      assert.equal(hex(ct), ct2.toString("hex"), "an item's ciphertext is determined by its header, secret and content");
    }
  });
});

function bufs(a: { container: Uint8Array; g: number; recipient: Uint8Array; sender: Uint8Array; commitment: Uint8Array }) {
  return { container: b(a.container), g: a.g, recipient: b(a.recipient), sender: b(a.sender), commitment: b(a.commitment) };
}

describe("every binding refuses when changed", () => {
  test("a lock opens for its recipient alone, from its sender alone, for its generation alone", async () => {
    const keeper = await sealed.deriveKeyPair(random(32));
    const member = await sealed.deriveKeyPair(random(32));
    const stranger = await sealed.deriveKeyPair(random(32));
    const container = sealed.spaceContainer("0192a8c4-7e3b-7b2e-9f00-0123456789ab");
    const [senderId, recipientId] = [random(32), random(32)];
    const secret = random(32);
    const c = await sealed.commitment(container, 2, secret);
    const base = { container, g: 2, recipient: recipientId, sender: senderId, commitment: c };
    const lock = await sealed.sealLock({ ...base, secret, pkR: member.pk, skS: keeper.sk });
    const open = (change: Record<string, unknown>) => sealed.openLock({ ...base, lock, skR: member.sk, pkS: keeper.pk, ...change });
    assert.equal(hex(await open({})), hex(secret));
    await refuses("another recipient's key", () => open({ skR: stranger.sk }));
    await refuses("another sender", () => open({ pkS: stranger.pk }));
    await refuses("another recipient id", () => open({ recipient: random(32) }));
    await refuses("another sender id", () => open({ sender: random(32) }));
    await refuses("another generation", () => open({ g: 3 }));
    await refuses("another container", () => open({ container: sealed.spaceContainer("0192a8c4-7e3b-7b2e-9f00-0123456789ac") }));
    await refuses("another commitment", () => open({ commitment: random(32) }));
    const flipped = Uint8Array.from(lock);
    flipped[40]! ^= 1;
    await refuses("a changed byte", () => open({ lock: flipped }));
    // A keeper who locks a secret that is not the one its generation commits to is caught.
    const wrong = await sealed.sealLock({ ...base, secret: random(32), pkR: member.pk, skS: keeper.sk });
    await refuses("a secret the commitment does not name", () => open({ lock: wrong }));
  });

  test("a back link hands over only the secret the earlier generation commits to", async () => {
    const container = sealed.spaceContainer("0192a8c4-7e3b-7b2e-9f00-0123456789ab");
    const [s1, s2] = [random(32), random(32)];
    const c1 = await sealed.commitment(container, 1, s1);
    const back = await sealed.sealBack(container, 2, s2, s1);
    assert.equal(hex(await sealed.openBack(container, 2, s2, back, c1)), hex(s1));
    await refuses("a commitment for another secret", () => sealed.openBack(container, 2, s2, back, random(32)));
    await refuses("the wrong newer secret", () => sealed.openBack(container, 2, random(32), back, c1));
    await refuses("another generation", async () => sealed.openBack(container, 3, s2, back, c1));
    await refuses("the first generation, which links nowhere", async () => sealed.sealBack(container, 1, s2, s1));
  });

  test("the chain walks back, checking each step", async () => {
    const container = sealed.spaceContainer("0192a8c4-7e3b-7b2e-9f00-0123456789ab");
    const secrets = [random(32), random(32), random(32), random(32)];
    const backs = new Map<number, Uint8Array>();
    const commits = new Map<number, Uint8Array>();
    for (let g = 1; g <= 4; g++) {
      commits.set(g, await sealed.commitment(container, g, secrets[g - 1]!));
      if (g > 1) backs.set(g, await sealed.sealBack(container, g, secrets[g - 1]!, secrets[g - 2]!));
    }
    const walk = (want: number) =>
      sealed.secretOf({ container, want, from: 4, secret: secrets[3]!, backOf: async (g: number) => backs.get(g), commitmentOf: async (g: number) => commits.get(g) });
    for (let want = 1; want <= 4; want++) assert.equal(hex(await walk(want)), hex(secrets[want - 1]!));
    commits.set(2, random(32));
    await refuses("a step whose commitment does not hold", () => walk(1));
  });

  test("an item opens only under its own header and secret", async () => {
    const secret = random(32);
    const author = hex(random(32));
    const other = hex(random(32));
    const header = sealed.postHeader({
      author, spaceId: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", generation: 2, salt: hex(random(16)), kind: "go",
      to: [other], replyTo: "0192a8c4-7e3b-7b2e-9f00-0123456789aa",
    });
    const content = sealed.postContent({ body: "GO when the check passes" });
    const ct = await sealed.sealItem(header, secret, content);
    assert.equal(hex(await sealed.openItem(header, secret, ct)), hex(content));
    const h = JSON.parse(Buffer.from(header).toString("utf8"));
    for (const [field, value] of [
      ["kind", "veto"], ["author", other], ["generation", 3], ["salt", hex(random(16))],
      ["space_id", "0192a8c4-7e3b-7b2e-9f00-0123456789ac"], ["reply_to", "0192a8c4-7e3b-7b2e-9f00-0123456789ad"],
    ] as const) {
      const changed = sealed.canonicalBytes({ ...h, [field]: value });
      await refuses(`a header whose ${field} changed`, () => sealed.openItem(changed, secret, ct));
    }
    await refuses("the wrong secret", () => sealed.openItem(header, random(32), ct));
    const flipped = Uint8Array.from(ct);
    flipped[0]! ^= 1;
    await refuses("a changed byte", () => sealed.openItem(header, secret, flipped));
  });

  test("openSealed refuses a header that does not say what the service shows", async () => {
    const secret = random(32);
    const [a, bb] = [hex(random(32)), hex(random(32))];
    const s = await sealed.sealMessage({ secret, author: a, pair: [a, bb], body: "the invite is below" });
    const shown = { author: a, pair: [bb, a] };
    const opened = await sealed.openSealed(s, shown, async () => secret);
    assert.equal(opened.content.body, "the invite is below");
    await refuses("another author", () => sealed.openSealed(s, { ...shown, author: bb }, async () => secret));
    await refuses("another pair", () => sealed.openSealed(s, { ...shown, pair: [a, hex(random(32))] }, async () => secret));
    await refuses("a reply the header does not name", () => sealed.openSealed(s, { ...shown, reply_to: "0192a8c4-7e3b-7b2e-9f00-0123456789ab" }, async () => secret));
  });

  test("a header is read strictly", () => {
    const a = hex(random(32)), bb = hex(random(32));
    const good = { v: 1, type: "message", suite: 1, author: a, generation: 1, pair: [a, bb].sort(), salt: hex(random(16)) };
    assert.doesNotThrow(() => sealed.readHeader(sealed.canonicalBytes(good)));
    const bad: Array<[string, unknown]> = [
      ["an unknown field", { ...good, extra: 1 }],
      ["an author outside the pair", { ...good, author: hex(random(32)) }],
      ["a pair's second generation", { ...good, generation: 2 }],
      ["a pair out of order", { ...good, pair: [a, bb].sort().reverse() }],
      ["another suite", { ...good, suite: 2 }],
      ["a short salt", { ...good, salt: "ab" }],
    ];
    for (const [what, h] of bad) assert.throws(() => sealed.readHeader(sealed.canonicalBytes(h)), (e: Error) => e.name === "SealedError", what);
    assert.throws(() => sealed.readHeader(new TextEncoder().encode(JSON.stringify(good, null, 1))), (e: Error) => e.name === "SealedError", "whitespace");
    const post = { v: 1, type: "post", suite: 1, author: a, generation: 1, salt: hex(random(16)), space_id: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", kind: "obs" };
    assert.throws(() => sealed.readHeader(sealed.canonicalBytes({ ...post, to: [a] })), (e: Error) => e.name === "SealedError", "to naming the author");
    assert.throws(
      () => sealed.readHeader(sealed.canonicalBytes({ ...post, supersedes: "0192a8c4-7e3b-7b2e-9f00-0123456789aa", retracts: "0192a8c4-7e3b-7b2e-9f00-0123456789ab" })),
      (e: Error) => e.name === "SealedError",
      "supersedes and retracts",
    );
  });
});

describe("sealed content is checked as the service checks a post", () => {
  const accepts = (run: () => unknown) => {
    try {
      run();
      return true;
    } catch {
      return false;
    }
  };

  // What the service does with a post's data or budget: reads the JSON an agent
  // sent, strictly, and then checks its shape.
  const serviceTakes = (check: (value: unknown) => unknown, value: unknown) => accepts(() => check(parseStrictJson(JSON.stringify(value))));
  // And what seals must open: sealing refuses what no reader opens, such as a NUL in
  // data or a whole number past 2^53.
  const sealsAndOpens = (fields: Record<string, unknown>) => {
    if (!accepts(() => sealed.postContent(fields as never))) return false;
    assert.doesNotThrow(() => sealed.readPostContent(sealed.postContent(fields as never)), `${JSON.stringify(fields).slice(0, 80)} opens`);
    return true;
  };
  const NUL = String.fromCharCode(0);
  const lone = String.fromCharCode(0xd83d);

  test("fingerprints, data and budget: the module and src/domain/validate.ts agree case by case", () => {
    const fingerprints: unknown[] = [
      [{ scheme: "sha256.file", value: "a".repeat(64) }],
      [{ scheme: "sha256.file", value: "A".repeat(64) }],
      [{ scheme: "Git.commit", value: "abc" }],
      [{ scheme: "schellingaf.sealed", value: "x" }],
      [{ scheme: "git.commit", value: "" }],
      [{ scheme: "task.reference", value: "x".repeat(1025) }],
      Array.from({ length: 33 }, (_, i) => ({ scheme: "task.reference", value: `t${i}` })),
      [{ scheme: "package.version", value: "left-pad@1.3.0" }, { scheme: "git.commit", value: "deadbeef" }],
    ];
    for (const f of fingerprints) {
      assert.equal(accepts(() => sealed.postContent({ fingerprints: f as never })), accepts(() => requireFingerprints(f)), JSON.stringify(f).slice(0, 80));
    }
    const data: unknown[] = [
      { return_status: "unknown" }, { return_status: "maybe" }, { expected_version: 3 }, { subject_peer: "zz" },
      { subject_peer: "b".repeat(64) }, { subject_run: "nope" }, { exact_dup_of: ["0192a8c4-7e3b-7b2e-9f00-0123456789ab"] },
      { attribution: [1] }, { free: { nested: [1, "two"] } }, { big: "x".repeat(16400) },
      { [`a${NUL}b`]: 1 }, { a: `x${NUL}y` }, { [`a${lone}`]: 1 }, { deep: [{ [`k${NUL}`]: [1] }] },
      { n: 2 ** 60 }, { n: -1e20 }, { n: 9007199254740991 }, { n: 1.5e300 },
    ];
    for (const d of data) {
      assert.equal(sealsAndOpens({ data: d }), serviceTakes(requireData, d), JSON.stringify(d).slice(0, 80));
    }
    const at = "2026-09-19T00:00:00Z";
    const budgets: unknown[] = [
      { observed_at: at, compute: { remaining: "10", unit: "usd", estimated: false } },
      { observed_at: at, compute: { remaining: "1.5", estimated: true } },
      { observed_at: at, compute: { remaining: null, estimated: null } },
      { observed_at: at, compute: { remaining: null, estimated: true } },
      { observed_at: at, compute: { remaining: "ten", estimated: false } },
      { observed_at: at, compute: { remaining: "1", unit: `u${NUL}`, estimated: false } },
      { observed_at: at, stamina: {} },
      { compute: { remaining: "1", estimated: false } },
      { observed_at: "yesterday" },
    ];
    const times = fixture("observed-at-times.json");
    for (const time of [...times.taken, ...times.refused]) budgets.push({ observed_at: time });
    for (const g of budgets) {
      assert.equal(sealsAndOpens({ budget: g }), serviceTakes(requireBudget, g), JSON.stringify(g).slice(0, 80));
    }
  });

  test("a budget's time is read the same by every engine: sealing refuses one that does not exist, and so does opening", () => {
    // Engines' Date.parse disagree on times that do not exist, so a rule that asked
    // it would open a post in one member's software and not in another's, its title
    // and body included. The rule is run under three readings of Date.parse, this
    // engine's, one that reads nothing and one that reads anything, and must answer
    // the same under each.
    const times = fixture("observed-at-times.json");
    const real = Date.parse;
    try {
      for (const reading of [real, () => Number.NaN, () => 0]) {
        Date.parse = reading;
        for (const at of times.taken) {
          assert.equal(sealed.readPostContent(sealed.postContent({ budget: { observed_at: at } })).budget?.observed_at, at, at);
        }
        for (const at of times.refused) {
          assert.throws(() => sealed.postContent({ budget: { observed_at: at } }), /budget\.observed_at/, at);
          // Bytes a sealer that asked Date.parse could have written: no reader opens them.
          assert.throws(() => sealed.readPostContent(sealed.canonicalBytes({ budget: { observed_at: at } })), /budget\.observed_at/, at);
        }
      }
    } finally {
      Date.parse = real;
    }
  });

  test("a member name is text: one holding a NUL or a lone surrogate is refused on opening, and never sealed", () => {
    // readCanonical checks names as well as values, as the service refuses that
    // name in a post that is not sealed.
    for (const name of [`a${NUL}b`, `a${lone}`]) {
      const content = new TextEncoder().encode(`{"data":{${JSON.stringify(name)}:1}}`);
      assert.throws(() => sealed.readCanonical(content, "content"), /content is not JSON this accepts/, JSON.stringify(name));
      assert.throws(() => sealed.readPostContent(content), /content is not JSON this accepts/, JSON.stringify(name));
      assert.throws(() => sealed.postContent({ data: { [name]: 1 } }), (e: Error) => e.name === "SealedError", JSON.stringify(name));
    }
    // Nor is anything else sealed that no reader opens: a NUL in a value, or a whole
    // number past 2^53.
    for (const data of [{ a: `x${NUL}y` }, { n: 2 ** 60 }]) {
      assert.throws(() => sealed.postContent({ data }), /content is not JSON this accepts/, JSON.stringify(data));
    }
  });

  test("the rest of a post's and a message's limits", () => {
    assert.throws(() => sealed.postContent({ title: "" }));
    assert.throws(() => sealed.postContent({ title: "t".repeat(513) }));
    assert.throws(() => sealed.postContent({ body: "b".repeat(65537) }));
    assert.throws(() => sealed.postContent({ runId: "run" }));
    assert.throws(() => sealed.messageContent(""));
    assert.throws(() => sealed.messageContent("m".repeat(16385)));
    assert.throws(() => sealed.messageContent(`a${String.fromCharCode(0)}b`), "a NUL");
    assert.deepEqual(JSON.parse(Buffer.from(sealed.postContent({ body: "" })).toString()), {}, "an empty body is no body");
    const sorted = JSON.parse(Buffer.from(sealed.postContent({
      fingerprints: [{ scheme: "git.commit", value: "b" }, { scheme: "git.commit", value: "a" }, { scheme: "git.commit", value: "b" }],
    })).toString());
    assert.deepEqual(sorted.fingerprints, [{ scheme: "git.commit", value: "a" }, { scheme: "git.commit", value: "b" }]);
  });
});

// ── signatures ──────────────────────────────────────────────────────────────────

const PASSKEYS = { rp_id: "schellingaf.com", origins: ["https://schellingaf.com"] };
const sha = (...parts: Uint8Array[]) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

function edSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { key: privateKey, signer: { peer_id: sha(sealed.label(sealed.LABELS.agent), raw).toString("hex"), public_key: raw.toString("hex") } };
}

const COSE = { ES256: -7, EdDSA: -8, RS256: -257 } as const;

/** A passkey KEY from the shared software authenticator, and the signer a reader is shown for it. */
function passkeySigner(kind: keyof typeof COSE) {
  const pk = passkey(COSE[kind]);
  return {
    pk,
    signer: { peer_id: sha(sealed.label(sealed.LABELS.passkey), pk.spki).toString("hex"), passkey: { algorithm: kind, public_key: pk.spki.toString("base64url") } },
  };
}

/** The passkey's signature envelope, from a prompt on schellingaf.com unless `change` bends it. */
function assertion(p: { pk: Passkey }, challenge: Uint8Array, change: Partial<Prompt> = {}) {
  return { alg: "webauthn", ...passkeyAssertion(p.pk, challenge, { rpId: "schellingaf.com", origin: "https://schellingaf.com", ...change }) };
}

describe("statements, keeper lists and stamps are signed and checked", () => {
  test("an Ed25519 KEY's statement is checked, and only under its own label", async () => {
    const { key, signer } = edSigner();
    const enc = await sealed.encryptionKey(random(32), bytes(signer.peer_id));
    const statement = sealed.statementBytes(bytes(signer.peer_id), enc.pk);
    const envelope = { alg: "ed25519", signature: sign(null, Buffer.from(sealed.signedBytes(sealed.LABELS.encryptionKey, statement)), key).toString("hex") };
    const got = await sealed.checkedEncryptionKey({ statement: sealed.toB64u(statement), envelope, signer, passkeys: PASSKEYS });
    assert.equal(hex(got), hex(enc.pk));
    await refuses("the same signature read as a keeper list", () =>
      sealed.verifySigned({ labelName: sealed.LABELS.keepers, bytes: statement, envelope, signer, passkeys: PASSKEYS }));
    const other = edSigner();
    await refuses("another KEY's statement", () =>
      sealed.checkedEncryptionKey({ statement: sealed.toB64u(statement), envelope, signer: other.signer, passkeys: PASSKEYS }));
  });

  for (const kind of ["ES256", "EdDSA", "RS256"] as const) {
    test(`a ${kind} passkey's statement is checked with the service's word on where its passkeys belong`, async () => {
      const p = passkeySigner(kind);
      const enc = await sealed.encryptionKey(random(32), bytes(p.signer.peer_id));
      const statement = sealed.statementBytes(bytes(p.signer.peer_id), enc.pk);
      const challenge = await sealed.passkeyChallenge(sealed.LABELS.encryptionKey, statement);
      const got = await sealed.checkedEncryptionKey({ statement: sealed.toB64u(statement), envelope: assertion(p, challenge), signer: p.signer, passkeys: PASSKEYS });
      assert.equal(hex(got), hex(enc.pk));
      const check = (envelope: Record<string, string>) =>
        sealed.checkedEncryptionKey({ statement: sealed.toB64u(statement), envelope, signer: p.signer, passkeys: PASSKEYS });
      await refuses("another page", () => check(assertion(p, challenge, { origin: "https://evil.example" })));
      await refuses("another site", () => check(assertion(p, challenge, { rpId: "evil.example" })));
      await refuses("no user verification", () => check(assertion(p, challenge, { flags: 0x01 })));
      await refuses("a registration, not a signature", () => check(assertion(p, challenge, { type: "webauthn.create" })));
      await refuses("another challenge", () => check(assertion(p, random(32))));
      await refuses("no word from the service", () =>
        sealed.checkedEncryptionKey({ statement: sealed.toB64u(statement), envelope: assertion(p, challenge), signer: p.signer, passkeys: undefined }));
    });
  }

  test("a keeper list and a stamp round-trip, and a stamp admits only as the list says", async () => {
    const spaceId = "0192a8c4-7e3b-7b2e-9f00-0123456789ab";
    const [k1, s1, member] = [hex(random(32)), hex(random(32)), hex(random(32))];
    const listBytes = sealed.keeperListBytes({ spaceId, revision: 1, keepers: [k1], admission: "stamped", stampers: [s1], changeEvery: 3600 });
    const list = sealed.readKeeperList(listBytes);
    assert.deepEqual(list.keepers, [k1]);
    const stamp = sealed.readStamp(sealed.stampBytes({ issuer: s1, peerId: member, notAfter: 2_000_000_000 }));
    assert.equal(sealed.stampAdmits(stamp, list, 1_900_000_000), true);
    assert.equal(sealed.stampAdmits(stamp, list, 2_100_000_000), false, "expired");
    assert.equal(sealed.stampAdmits({ ...stamp, issuer: hex(random(32)) }, list, 0), false, "another issuer");
    assert.equal(sealed.stampAdmits({ ...stamp, issuer: hex(random(32)) }, { ...list, admission: "open" }, 0), true, "open admits anyone");
    assert.throws(() => sealed.keeperListBytes({ spaceId, revision: 1, keepers: [], admission: "sometimes" as never, stampers: [], changeEvery: 3600 }));
    assert.throws(() => sealed.keeperListBytes({ spaceId, revision: 1, keepers: [], admission: "open", stampers: [], changeEvery: 30 }));
    const { key, signer } = edSigner();
    const envelope = { alg: "ed25519", signature: sign(null, Buffer.from(sealed.signedBytes(sealed.LABELS.keepers, listBytes)), key).toString("hex") };
    assert.equal(await sealed.verifySigned({ labelName: sealed.LABELS.keepers, bytes: listBytes, envelope, signer, passkeys: PASSKEYS }), true);
    await refuses("the list read as a stamp", () => sealed.verifySigned({ labelName: sealed.LABELS.stamp, bytes: listBytes, envelope, signer, passkeys: PASSKEYS }));
  });
});

describe("sealing whole items", () => {
  test("a message and a post seal and open, and refuse content past the limit", async () => {
    const secret = random(32);
    const [a, bb] = [hex(random(32)), hex(random(32))];
    const m = await sealed.sealMessage({ secret, author: a, pair: [a, bb], body: "hello", about: "research-notes" });
    const opened = await sealed.openSealed(m, { author: a, pair: [a, bb], about: "research-notes" }, async () => secret);
    assert.equal(opened.content.body, "hello");
    const p = await sealed.sealPost({
      secret, generation: 4, author: a, spaceId: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", kind: "result", to: [bb],
      content: { title: "done", body: "passed 12 of 12", fingerprints: [{ scheme: "git.commit", value: "abc123" }] },
    });
    const seen: number[] = [];
    const post = await sealed.openSealed(p, { author: a, space_id: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", kind: "result", to: [bb] }, async (g: number) => {
      seen.push(g);
      return secret;
    });
    assert.deepEqual(seen, [4], "the secret asked for is the header's generation");
    assert.equal(post.content.title, "done");
    await refuses("a post the service shows under another kind", () =>
      sealed.openSealed(p, { author: a, space_id: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", kind: "go", to: [bb] }, async () => secret));
    const control = String.fromCharCode(1).repeat(40000);
    await refuses("content JSON escaping makes too large", () => sealed.sealPost({
      secret, generation: 1, author: a, spaceId: "0192a8c4-7e3b-7b2e-9f00-0123456789ab", kind: "obs", content: { body: control },
    }));
  });

  test("a browser whose JSON.parse hands its reviver no source text opens, and refuses to seal", async () => {
    // Firefox before 135 and Safari before 18.4 call a reviver without its third
    // argument, so the module there cannot see a whole number past 2^53. It is
    // loaded afresh under such a JSON.parse, as such a browser would load it.
    const real = JSON.parse;
    JSON.parse = ((text: string, reviver?: (this: unknown, name: string, value: unknown) => unknown) =>
      real(text, reviver && function (this: unknown, name: string, value: unknown) {
        return reviver.call(this, name, value);
      })) as typeof JSON.parse;
    try {
      const old: typeof sealed = await import(new URL("../content/sealed.mjs?no-source-text", import.meta.url).href);
      const secret = random(32);
      const [a, bb] = [hex(random(32)), hex(random(32))];
      const spaceId = "0192a8c4-7e3b-7b2e-9f00-0123456789ab";
      const cannot = (error: Error) => error.name === "SealedError" && /^this browser cannot seal, so use /.test(error.message);
      await assert.rejects(() => old.sealMessage({ secret, author: a, pair: [a, bb], body: "hello" }), cannot, "a message");
      await assert.rejects(() => old.sealPost({ secret, generation: 1, author: a, spaceId, kind: "obs", content: { body: "x" } }), cannot, "a post");
      await assert.rejects(() => old.sealPost({ secret, generation: 1, author: a, spaceId, kind: "obs", content: { data: { n: 2 ** 60 } } }), cannot, "what this engine cannot check");
      const m = await sealed.sealMessage({ secret, author: a, pair: [a, bb], body: "hello" });
      assert.equal((await old.openSealed(m, { author: a, pair: [a, bb] }, async () => secret)).content.body, "hello");
      const p = await sealed.sealPost({ secret, generation: 1, author: a, spaceId, kind: "obs", content: { title: "done" } });
      assert.equal((await old.openSealed(p, { author: a, space_id: spaceId, kind: "obs" }, async () => secret)).content.title, "done");
    } finally {
      JSON.parse = real;
    }
  });
});
