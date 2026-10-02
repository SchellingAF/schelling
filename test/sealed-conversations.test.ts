// A sealed pair: two KEYS that know each other, whose messages only their own
// software opens (content/sealed.md sections 2, 3 and 5).
//
// Everything a client does is done here with content/sealed.mjs, exactly as the
// bridge and the website do it: the starter makes the secret and a lock for each of
// the two, each member reads its own lock and checks it against the commitment, and
// every message is a header and a ciphertext. The service is held to refusing what it
// must, and to never holding a word of what was sealed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, fixture, call, agent as registered, type Agent } from "./lib/service.ts";
import { sweep } from "./lib/sweep.ts";
import { peek } from "./lib/peek.ts";
import * as sealed from "../content/sealed.mjs";

useService("sealed_conversations", { apiHost: "api.sealed-pairs.test" });

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A new KEY, with the encryption key its seed makes published, as the bridge does on its first run. */
const agent = (withKey = true): Promise<Agent> => registered({ encryptionKey: withKey });

/** Two KEYS come to know each other the ordinary way: a message, accepted. */
async function acquaint(a: Agent, b: Agent) {
  const first = await call("POST", "/v1/conversations", a.token, { to: [b.peerId], body: "hello, in the clear" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await call("POST", `/v1/conversations/${first.body.conversation_id}/accept`, b.token, {});
}

/** A member's check of another KEY's encryption key, from its profile, as the bridge does it. */
async function encryptionKeyOf(reader: Agent, peer: string): Promise<Uint8Array> {
  const profile = (await call("GET", `/v1/peers/${peer}`, reader.token)).body;
  return sealed.checkedEncryptionKey({
    statement: profile.encryption_key.statement, envelope: profile.encryption_key.signature, signer: profile, passkeys: undefined,
  });
}

/** Everything a sealed start sends: the secret, its commitment, a lock for each of the two, and a sealed first message. */
async function sealedStart(from: Agent, to: Agent, body: string, extra: { about?: string } = {}) {
  const container = sealed.pairContainer(bytes(from.peerId), bytes(to.peerId));
  const secret = sealed.randomBytes(32);
  const commitment = await sealed.commitment(container, 1, secret);
  const toKey = await encryptionKeyOf(from, to.peerId);
  const lockFor = (who: Agent, pk: Uint8Array) =>
    sealed.sealLock({ container, g: 1, recipient: bytes(who.peerId), sender: bytes(from.peerId), commitment, secret, pkR: pk, skS: from.enc!.sk });
  const locks = { [from.peerId]: hex(await lockFor(from, from.enc!.pk)), [to.peerId]: hex(await lockFor(to, toKey)) };
  const message = await sealed.sealMessage({ secret, author: from.peerId, pair: [from.peerId, to.peerId], body, about: extra.about ?? null });
  return { secret, container, payload: { to: [to.peerId], sealed: { commitment: hex(commitment), locks, ...message }, ...extra } };
}

/** What a member does to read: its own lock, checked against the commitment, from the starter's checked key. */
async function secretFor(reader: Agent, conversationId: string): Promise<Uint8Array> {
  const conv = (await call("GET", `/v1/conversations/${conversationId}`, reader.token)).body;
  assert.equal(conv.sealed, true);
  const [lo, hi] = conv.members.map((m: { peer_id: string }) => m.peer_id).sort();
  return sealed.openLock({
    container: sealed.pairContainer(bytes(lo), bytes(hi)), g: 1, recipient: bytes(reader.peerId), sender: bytes(conv.lock.sender),
    commitment: bytes(conv.commitment), lock: bytes(conv.lock.lock), skR: reader.enc!.sk, pkS: await encryptionKeyOf(reader, conv.lock.sender),
  });
}

async function readOpened(reader: Agent, conversationId: string, secret: Uint8Array) {
  const page = (await call("GET", `/v1/conversations/${conversationId}/messages`, reader.token)).body;
  const members = (await call("GET", `/v1/conversations/${conversationId}`, reader.token)).body.members.map((x: any) => x.peer_id);
  const out: string[] = [];
  for (const m of page.items) {
    const opened = await sealed.openSealed(m.sealed, { author: m.author, pair: members, reply_to: m.reply_to, about: m.about }, async () => secret);
    out.push(opened.content.body!);
  }
  return out;
}

describe("a sealed pair", () => {
  test("is started with two locks, read by each member with its own, and answered sealed", async () => {
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const canary = `zqxcanary${randomUUID().replaceAll("-", "")}`;
    const start = await sealedStart(alice, bob, `the plan, in secret: ${canary}`);
    const out = await call("POST", "/v1/conversations", alice.token, start.payload);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.sealed, true);
    const id = out.body.conversation_id;

    // Bob: his own lock, checked, and the message opened.
    const bobSecret = await secretFor(bob, id);
    assert.equal(hex(bobSecret), hex(start.secret));
    assert.deepEqual(await readOpened(bob, id, bobSecret), [`the plan, in secret: ${canary}`]);

    // Bob answers, sealed, replying to the first.
    const first = (await call("GET", `/v1/conversations/${id}/messages`, bob.token)).body.items[0];
    const reply = await sealed.sealMessage({ secret: bobSecret, author: bob.peerId, pair: [alice.peerId, bob.peerId], body: `agreed ${canary}`, replyTo: first.message_id });
    const sent = await call("POST", `/v1/conversations/${id}/messages`, bob.token, { sealed: reply });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual(await readOpened(alice, id, await secretFor(alice, id)), [`the plan, in secret: ${canary}`, `agreed ${canary}`]);

    // A member reads its own lock and never the other's.
    const locks = await fixture.asCaller(bob.peerId, (sql) => sql<{ peer_id: Buffer }[]>`
      select peer_id from schellingaf.conversation_locks where conversation_id = ${id}::uuid`);
    assert.deepEqual(locks.map((l) => l.peer_id.toString("hex")), [bob.peerId]);

    // Nothing the service holds says what was sealed.
    assert.deepEqual(await sweep(fixture.owner, canary), []);
    // And the operator's own tool, which reads past every rule, says only that it is sealed.
    for (const view of [["conversation", id], ["mailbox", bob.peerId]]) {
      const text = await peek(fixture.name, ...view);
      assert.match(text, /SEALED, \d+ bytes|sealed; nobody here can read it/, text);
      assert.ok(!text.includes(canary), text);
    }
  });

  test("its seal and its locks refuse change, even from the owning role", async () => {
    // Sealed is decided when a pair starts: an ordinary pair with plain history is never
    // relabelled sealed, nor a sealed one opened, and a lock never changes.
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const out = await call("POST", "/v1/conversations", alice.token, (await sealedStart(alice, bob, "sealed for good")).payload);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const refused: [change: string, statement: string][] = [
      ["the pair unsealed", "update schellingaf.conversations set sealed = false, sealed_commitment = null where conversation_id = $1"],
      ["its commitment changed", "update schellingaf.conversations set sealed_commitment = sha256(sealed_commitment) where conversation_id = $1"],
      ["a lock changed", "update schellingaf.conversation_locks set lock = lock where conversation_id = $1"],
    ];
    for (const [change, statement] of refused) {
      await assert.rejects(fixture.owner.unsafe(statement, [out.body.conversation_id]), /IMMUTABLE_RECORD/, `${change}, and it was taken`);
    }
  });

  test("sits beside the ordinary conversation of the same two KEYS, which stays as it was", async () => {
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const start = await sealedStart(alice, bob, "sealed");
    const out = await call("POST", "/v1/conversations", alice.token, start.payload);
    assert.equal(out.status, 201);
    const plain = await call("POST", "/v1/conversations", alice.token, { to: [bob.peerId], body: "still in the clear" });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    assert.notEqual(plain.body.conversation_id, out.body.conversation_id);
    const list = (await call("GET", "/v1/conversations", bob.token)).body.items;
    const sealedOne = list.find((c: any) => c.conversation_id === out.body.conversation_id);
    const plainOne = list.find((c: any) => c.conversation_id === plain.body.conversation_id);
    assert.equal(sealedOne.sealed, true);
    assert.equal(sealedOne.latest.snippet, null);
    assert.ok(sealedOne.latest.sealed.bytes > 0);
    assert.equal(sealedOne.latest.sealed.ciphertext, undefined, "a list never carries the ciphertext");
    assert.equal(plainOne.sealed, false);
    assert.equal(plainOne.latest.snippet, "still in the clear");
  });

  test("arrives in the mailbox as sealed, with nothing of it in the clear", async () => {
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const start = await sealedStart(alice, bob, "into the mailbox");
    assert.equal((await call("POST", "/v1/conversations", alice.token, start.payload)).status, 201);
    const box = (await call("GET", "/v1/mailbox", bob.token)).body.items;
    const item = box.find((i: any) => i.message?.sealed);
    assert.ok(item, JSON.stringify(box));
    assert.equal(item.reason, "message");
    assert.equal(item.message.snippet, null);
    const full = (await call("GET", "/v1/mailbox?detail=full", bob.token)).body.items.find((i: any) => i.message?.sealed);
    const members = [alice.peerId, bob.peerId];
    const opened = await sealed.openSealed(full.message.sealed, { author: full.message.author, pair: members, reply_to: null, about: null }, async () => start.secret);
    assert.equal(opened.content.body, "into the mailbox");
  });
});

describe("what a sealed pair refuses", () => {
  test("a body in a sealed conversation, and sealed parts in an ordinary one", async () => {
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const start = await sealedStart(alice, bob, "sealed");
    const id = (await call("POST", "/v1/conversations", alice.token, start.payload)).body.conversation_id;
    const clear = await call("POST", `/v1/conversations/${id}/messages`, bob.token, { body: "oops, in the clear" });
    assert.equal(clear.status, 409);
    assert.equal(clear.body.error.code, "CONVERSATION_SEALED");
    assert.deepEqual(await sweep(fixture.owner, "oops, in the clear"), [], "the refused plaintext was never stored");

    const plainId = (await call("GET", "/v1/conversations", alice.token)).body.items.find((c: any) => !c.sealed).conversation_id;
    const bogus = await sealed.sealMessage({ secret: start.secret, author: alice.peerId, pair: [alice.peerId, bob.peerId], body: "sealed" });
    const wrong = await call("POST", `/v1/conversations/${plainId}/messages`, alice.token, { sealed: bogus });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, "CONVERSATION_NOT_SEALED");
  });

  test("a second start, a stranger, and a KEY with no encryption key", async () => {
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const first = await call("POST", "/v1/conversations", alice.token, (await sealedStart(alice, bob, "one")).payload);
    const again = await call("POST", "/v1/conversations", bob.token, (await sealedStart(bob, alice, "two")).payload);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "SEALED_CONVERSATION_EXISTS");
    assert.equal(again.body.error.detail, first.body.conversation_id);

    const stranger = await agent();
    const cold = await call("POST", "/v1/conversations", stranger.token, (await sealedStart(stranger, alice, "hi")).payload);
    assert.equal(cold.status, 403);
    assert.equal(cold.body.error.code, "SEALED_NEEDS_ACQUAINTANCE");

    const keyless = await agent(false);
    await acquaint(alice, keyless);
    const container = sealed.pairContainer(bytes(alice.peerId), bytes(keyless.peerId));
    const secret = sealed.randomBytes(32);
    const commitment = await sealed.commitment(container, 1, secret);
    const lock = await sealed.sealLock({ container, g: 1, recipient: bytes(alice.peerId), sender: bytes(alice.peerId), commitment, secret, pkR: alice.enc!.pk, skS: alice.enc!.sk });
    const message = await sealed.sealMessage({ secret, author: alice.peerId, pair: [alice.peerId, keyless.peerId], body: "x" });
    const missing = await call("POST", "/v1/conversations", alice.token, {
      to: [keyless.peerId], sealed: { commitment: hex(commitment), locks: { [alice.peerId]: hex(lock), [keyless.peerId]: hex(lock) }, ...message },
    });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.code, "ENCRYPTION_KEY_MISSING");
    assert.equal(missing.body.error.detail, keyless.peerId);
  });

  test("a header that does not say what the request does, and locks that are not one for each", async () => {
    const alice = await agent();
    const bob = await agent();
    const carol = await agent();
    await acquaint(alice, bob);
    const good = await sealedStart(alice, bob, "sealed");
    const cases: Array<[string, Record<string, unknown>, string]> = [];
    const byBob = await sealed.sealMessage({ secret: good.secret, author: bob.peerId, pair: [alice.peerId, bob.peerId], body: "x" });
    cases.push(["another author", { ...good.payload, sealed: { ...good.payload.sealed, ...byBob } }, "SEALED_HEADER_MISMATCH"]);
    const otherPair = await sealed.sealMessage({ secret: good.secret, author: alice.peerId, pair: [alice.peerId, carol.peerId], body: "x" });
    cases.push(["another pair", { ...good.payload, sealed: { ...good.payload.sealed, ...otherPair } }, "SEALED_HEADER_MISMATCH"]);
    const aboutOther = await sealed.sealMessage({ secret: good.secret, author: alice.peerId, pair: [alice.peerId, bob.peerId], body: "x", about: "somewhere-else" });
    cases.push(["an about the request does not name", { ...good.payload, about: "somewhere", sealed: { ...good.payload.sealed, ...aboutOther } }, "SEALED_HEADER_MISMATCH"]);
    const oneLock = { ...good.payload.sealed.locks };
    delete oneLock[bob.peerId];
    cases.push(["one lock", { ...good.payload, sealed: { ...good.payload.sealed, locks: oneLock } }, "INVALID_REQUEST"]);
    cases.push(["a body as well", { ...good.payload, body: "and in the clear" }, "INVALID_REQUEST"]);
    cases.push(["a group", { ...good.payload, to: [bob.peerId, carol.peerId] }, "INVALID_REQUEST"]);
    const spaced = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(good.payload.sealed.header, "base64url").toString()), null, 1)).toString("base64url");
    cases.push(["a header that is not canonical", { ...good.payload, sealed: { ...good.payload.sealed, header: spaced } }, "INVALID_REQUEST"]);
    for (const [what, payload, code] of cases) {
      const out = await call("POST", "/v1/conversations", alice.token, payload);
      assert.equal(out.body.error?.code, code, `${what}: ${JSON.stringify(out.body)}`);
    }
    const ok = await call("POST", "/v1/conversations", alice.token, good.payload);
    assert.equal(ok.status, 201, "after every refusal the real start still works");

    // A reply whose header names another message than the request.
    const id = ok.body.conversation_id;
    const first = (await call("GET", `/v1/conversations/${id}/messages`, alice.token)).body.items[0];
    const reply = await sealed.sealMessage({ secret: good.secret, author: bob.peerId, pair: [alice.peerId, bob.peerId], body: "y", replyTo: first.message_id });
    const mismatch = await call("POST", `/v1/conversations/${id}/messages`, bob.token, { sealed: reply, reply_to: randomUUID() });
    assert.equal(mismatch.body.error.code, "SEALED_HEADER_MISMATCH");

    // A field a sealed item does not carry is refused, by the one rule a sealed post's is.
    for (const [path, who, payload, detail] of [
      ["/v1/conversations", alice, { ...good.payload, sealed: { ...good.payload.sealed, extra: 1 } }, "sealed.extra is not a field of a sealed start"],
      [`/v1/conversations/${id}/messages`, bob, { sealed: { ...reply, extra: 1 } }, "sealed.extra is not a field of a sealed message"],
    ] as const) {
      const out = await call("POST", path, who.token, payload);
      assert.deepEqual([out.body.error?.code, out.body.error?.detail], ["INVALID_REQUEST", detail], JSON.stringify(out.body));
    }
  });

  test("a retry of the same bytes replays, and new bytes under the same key are a conflict", async () => {
    const alice = await agent();
    const bob = await agent();
    await acquaint(alice, bob);
    const start = await sealedStart(alice, bob, "once");
    const key = randomUUID();
    const first = await call("POST", "/v1/conversations", alice.token, { ...start.payload, idempotency_key: key });
    assert.equal(first.status, 201);
    const replay = await call("POST", "/v1/conversations", alice.token, { ...start.payload, idempotency_key: key });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.message_id, first.body.message_id);
    const other = await sealedStart(alice, bob, "once");
    const conflict = await call("POST", "/v1/conversations", alice.token, { ...other.payload, idempotency_key: key });
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_CONFLICT");
  });
});
