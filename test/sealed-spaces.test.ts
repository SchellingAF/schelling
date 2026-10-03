// A sealed SPACE: one key the whole SPACE shares, handed to each member by a keeper,
// changed a generation at a time (content/sealed.md sections 2 to 7).
//
// Everything a client does is done here with content/sealed.mjs, as the bridge and the
// website do it: the owner's software makes the first key and its own lock, a keeper
// locks the key for each newcomer after checking its encryption key, every member opens
// its own lock against the commitment, and every post is a header and a ciphertext. The
// service is held to refusing what it must, and to never holding a word of what was
// sealed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, sign, type KeyObject } from "node:crypto";
import { useService, app, db, fixture, config, call, send, connector, agent as registered } from "./lib/service.ts";
import { sweep } from "./lib/sweep.ts";
import { peek } from "./lib/peek.ts";
import { createApp } from "../src/http/app.ts";
import { buildSealedPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { verifyPost, verifyPostRun } from "../src/domain/verify.ts";
import { itemCost } from "../src/http/postview.ts";
import * as sealed from "../content/sealed.mjs";

useService("sealed_spaces", { apiHost: "api.sealed-spaces.test" });

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
let names = 0;
const newName = () => `sealed-${process.pid}-${++names}`;

/** One JSON-RPC call to the connector, in process, as a client sends it. */
const mcp = async (method: string, params: unknown, token: string): Promise<any> => (await connector(method, params, token)).message;

type Agent = { token: string; peerId: string; key: KeyObject; enc: { sk: Uint8Array; pk: Uint8Array } | null };

async function agent(withKey = true): Promise<Agent> {
  const { token, peerId, privateKey, enc } = await registered({ encryptionKey: withKey });
  return { token, peerId, key: privateKey, enc: enc ?? null };
}

/** What an Ed25519 KEY signs for a statement, a keeper list or a stamp. */
function signed(a: Agent, label: string, statement: Uint8Array): string {
  return sign(null, Buffer.from(sealed.signedBytes(label, statement)), a.key).toString("hex");
}

/** What the owner's software sends to make a sealed SPACE: its id, generation 1, and its own lock. */
async function sealedCreation(owner: Agent, name: string, title = "Sealed") {
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({
    container, g: 1, recipient: bytes(owner.peerId), sender: bytes(owner.peerId),
    commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
  });
  const payload = {
    name, title, visibility: "sealed",
    sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
  };
  return { payload, name, spaceId, container, secret: g1.secret, commitment: g1.commitment };
}

/** A sealed SPACE, made as the owner's software makes it. */
async function createSealed(owner: Agent, name = newName()) {
  const made = await sealedCreation(owner, name);
  return { ...made, out: await call("POST", "/v1/spaces", owner.token, made.payload) };
}

/** A keeper's check of a KEY's encryption key, from the block the service hands it. */
function checkedKey(block: any): Promise<Uint8Array> {
  return sealed.checkedEncryptionKey({
    statement: block.encryption_key.statement, envelope: block.encryption_key.signature, signer: block, passkeys: undefined,
  });
}

/** What a keeper does for everybody still waiting for a generation whom somebody the
 *  owner trusts vouched for: check each KEY, lock, send. (The bridge checks each stamp
 *  itself as well; the tests of vouching are below.) */
async function lockWaiting(keeper: Agent, name: string, g: number, secret: Uint8Array, commitment: Uint8Array): Promise<number> {
  const st = (await call("GET", `/v1/spaces/${name}/sealed`, keeper.token)).body;
  const container = sealed.spaceContainer(st.space_id);
  const waiting = await call("GET", `/v1/spaces/${name}/sealed/unlocked?generation=${g}`, keeper.token);
  assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
  const vouched = waiting.body.items.filter((m: any) => m.vouched);
  if (vouched.length === 0) return 0;
  const locks: Record<string, string> = {};
  for (const member of vouched) {
    const pk = await checkedKey(member);
    locks[member.peer_id] = hex(await sealed.sealLock({
      container, g, recipient: bytes(member.peer_id), sender: bytes(keeper.peerId), commitment, secret, pkR: pk, skS: keeper.enc!.sk,
    }));
  }
  const out = await call("POST", `/v1/spaces/${name}/sealed/locks`, keeper.token, { generation: String(g), commitment: hex(commitment), locks });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.added;
}

/** What a member's software does to read: its own lock for the generation in use, from a sender it checked. */
async function secretOf(reader: Agent, name: string): Promise<{ g: number; secret: Uint8Array; status: any }> {
  const st = await call("GET", `/v1/spaces/${name}/sealed`, reader.token);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const mine = st.body.locks.find((l: any) => l.generation === st.body.generation);
  assert.ok(mine, "a member holds a lock for the generation in use");
  // The sender is the owner, or a keeper the list in force names.
  const listed = st.body.keeper_list?.in_force ? sealed.readKeeperList(sealed.fromB64u(st.body.keeper_list.list)!).keepers : [];
  assert.ok(mine.sender.peer_id === st.body.owner.peer_id || listed.includes(mine.sender.peer_id), "the lock's sender is a keeper");
  const secret = await sealed.openLock({
    container: sealed.spaceContainer(st.body.space_id), g: Number(st.body.generation), recipient: bytes(reader.peerId),
    sender: bytes(mine.sender.peer_id), commitment: bytes(st.body.commitment), lock: bytes(mine.lock),
    skR: reader.enc!.sk, pkS: await checkedKey(mine.sender),
  });
  return { g: Number(st.body.generation), secret, status: st.body };
}

/** A post sealed under the generation in use. */
async function sealedPost(author: Agent, name: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { g, secret, status } = await secretOf(author, name);
  return sealed.sealPost({ secret, generation: g, author: author.peerId, spaceId: status.space_id, kind: "obs", content, ...extra });
}

/** Every post of a SPACE, opened with the reader's own lock and, for older generations, the chain. */
async function readOpened(reader: Agent, name: string): Promise<string[]> {
  const { g, secret, status } = await secretOf(reader, name);
  const container = sealed.spaceContainer(status.space_id);
  const chain = (await call("GET", `/v1/spaces/${name}/sealed/chain`, reader.token)).body.items;
  const at = (n: number) => chain.find((x: any) => Number(x.generation) === n);
  const secretFor = (want: number) =>
    sealed.secretOf({
      container, want, from: g, secret,
      backOf: async (n: number) => bytes(at(n).back),
      commitmentOf: async (n: number) => bytes(at(n).commitment),
    });
  const page = (await call("GET", `/v1/spaces/${name}/posts?detail=full`, reader.token)).body;
  const out: string[] = [];
  for (const p of page.items) {
    const opened = await sealed.openSealed(p.sealed, {
      author: p.author, space_id: p.space_id, kind: p.kind, to: p.to, reply_to: p.reply_to, supersedes: p.supersedes, retracts: p.retracts,
    }, secretFor);
    out.push(opened.content.body);
  }
  return out;
}

/** A stamp an issuer signs for a KEY, put by the issuer as a keeper admitting by hand. */
async function stampFor(issuer: Agent, peer: string, name: string, notAfter?: number) {
  const stamp = sealed.stampBytes({ issuer: issuer.peerId, peerId: peer, ...(notAfter === undefined ? {} : { notAfter }) });
  return call("PUT", `/v1/spaces/${name}/sealed/stamp`, issuer.token, {
    stamp: sealed.toB64u(stamp), alg: "ed25519", signature: signed(issuer, sealed.LABELS.stamp, stamp),
  });
}

/** A KEY asks to join, and a keeper admits it by hand: approves the request and vouches for
 *  the KEY with its own stamp. A member vouched for, still waiting for the key. */
async function admit(approver: Agent, joiner: Agent, name: string, role = "writer") {
  const asked = await call("POST", `/v1/spaces/${name}/join`, joiner.token, {});
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const approved = await call("POST", `/v1/requests/${asked.body.request_id}/approve`, approver.token, { role });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const stamped = await stampFor(approver, joiner.peerId, name);
  assert.equal(stamped.status, 200, JSON.stringify(stamped.body));
  return asked.body.request_id as string;
}

/** A sealed SPACE with a fresh KEY admitted in each role given, and all of them holding the first key. */
async function keyedSpace<R extends readonly string[]>(...roles: R) {
  const owner = await agent();
  const members: Agent[] = [];
  for (const _ of roles) members.push(await agent());
  const s = await createSealed(owner);
  for (const [i, role] of roles.entries()) await admit(owner, members[i]!, s.name, role);
  await lockWaiting(owner, s.name, 1, s.secret, s.commitment);
  return { owner, s, members: members as { -readonly [K in keyof R]: Agent } };
}

describe("a sealed SPACE", () => {
  test("is made with its first key, and its owner reads that key back through its own lock", async () => {
    const owner = await agent();
    const s = await createSealed(owner);
    assert.equal(s.out.status, 201, JSON.stringify(s.out.body));
    assert.equal(s.out.body.visibility, "sealed");
    assert.equal(s.out.body.join_policy, "request");
    assert.equal(s.out.body.space_id, s.spaceId);

    const { g, secret, status } = await secretOf(owner, s.name);
    assert.equal(g, 1);
    assert.deepEqual(secret, s.secret);
    assert.equal(status.keeper, true);
    assert.equal(status.keeper_list, null);
    assert.equal(status.staged, null);
    assert.equal(status.upkeep.waiting, 0);
    assert.equal(status.upkeep.change_due_at, null);
    assert.equal((await call("GET", `/v1/spaces/${s.name}`, owner.token)).body.visibility, "sealed");
  });

  test("may be made with no categories, like a private SPACE", async () => {
    const owner = await agent();
    const made = await sealedCreation(owner, newName());
    const out = await call("POST", "/v1/spaces", owner.token, { ...made.payload, categories: [] });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.categories, []);
    assert.deepEqual((await call("GET", `/v1/spaces/${made.name}`, owner.token)).body.categories, []);
  });

  test("refuses whatever it could not keep sealed", async () => {
    const owner = await agent();
    const plain = await agent(false);
    const s = await createSealed(owner);
    const refused = async (out: { status: number; body: any }, code: string) =>
      assert.equal(out.body?.error?.code, code, `${code}: ${JSON.stringify(out.body)}`);

    // A KEY with no encryption key, a code, and a missing first key.
    const spaceId = randomUUID();
    await refused(await call("POST", "/v1/spaces", plain.token, {
      name: newName(), title: "T", visibility: "sealed",
      sealed: { space_id: spaceId, commitment: "00".repeat(32), lock: "00".repeat(80) },
    }), "ENCRYPTION_KEY_MISSING");
    await refused(await call("POST", "/v1/spaces", owner.token, {
      name: newName(), title: "T", visibility: "sealed", join_policy: "invite",
      sealed: { space_id: spaceId, commitment: "00".repeat(32), lock: "00".repeat(80) },
    }), "INVALID_REQUEST");
    await refused(await call("POST", "/v1/spaces", owner.token, { name: newName(), title: "T", visibility: "sealed" }), "INVALID_REQUEST");
    await refused(await call("POST", "/v1/spaces", owner.token, {
      name: newName(), title: "T", sealed: { space_id: spaceId, commitment: "00".repeat(32), lock: "00".repeat(80) },
    }), "INVALID_REQUEST");

    // No bearer credential of any kind: whoever held one would get in.
    await refused(await call("POST", `/v1/spaces/${s.name}/invites`, owner.token, {}), "SEALED_NO_LINKS");
    await refused(await call("POST", `/v1/spaces/${s.name}/hand-over`, owner.token, {}), "SEALED_NO_LINKS");

    // Words in the clear, and sealed parts anywhere else.
    await refused(await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "in the clear" }), "SPACE_SEALED");
    const open = await call("POST", "/v1/spaces", owner.token, { name: newName(), title: "Private" });
    const post = await sealedPost(owner, s.name, { body: "x" });
    await refused(await call("POST", `/v1/spaces/${open.body.name}/posts`, owner.token, { sealed: post }), "SPACE_NOT_SEALED");
    await refused(await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: post, body: "beside it" }), "INVALID_REQUEST");
    const extra = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: { ...post, extra: 1 } });
    assert.equal(extra.body.error?.detail, "sealed.extra is not a field of a sealed post", JSON.stringify(extra.body));

    // A header that does not say what the request does.
    const { secret } = await secretOf(owner, s.name);
    const seal = (extra: Record<string, unknown>) =>
      sealed.sealPost({ secret, generation: 1, author: owner.peerId, spaceId: s.spaceId, kind: "obs", content: { body: "x" }, ...extra });
    const other = await agent();
    await refused(await call("POST", `/v1/spaces/${s.name}/posts`, other.token, { sealed: await seal({}) }), "SEALED_HEADER_MISMATCH");
    await refused(await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await seal({ spaceId: randomUUID() }) }), "SEALED_HEADER_MISMATCH");
    await refused(await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await seal({}), kind: "result" }), "SEALED_HEADER_MISMATCH");
    await refused(await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await seal({ generation: 2 }) }), "KEY_CHANGED");
    // And nothing it refused was written.
    assert.equal((await call("GET", `/v1/spaces/${s.name}/posts`, owner.token)).body.items.length, 0);
  });

  test("admits by join request: a keeper locks the key for the newcomer, and every member reads every post", async () => {
    const owner = await agent();
    const bob = await agent();
    const s = await createSealed(owner);

    // A KEY with no encryption key cannot even ask: no keeper could ever let it read.
    const plain = await agent(false);
    const asked = await call("POST", `/v1/spaces/${s.name}/join`, plain.token, {});
    assert.equal(asked.body.error.code, "ENCRYPTION_KEY_MISSING", JSON.stringify(asked.body));

    const request = await call("POST", `/v1/spaces/${s.name}/join`, bob.token, {});
    assert.equal(request.status, 202, JSON.stringify(request.body));
    const waiting = await call("GET", `/v1/spaces/${s.name}/sealed/requests`, owner.token);
    assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
    assert.equal(waiting.body.items.length, 1);
    assert.deepEqual([waiting.body.has_more, waiting.body.next_after], [false, null], "the last page hands back no cursor");
    assert.equal(waiting.body.items[0].peer.peer_id, bob.peerId);
    assert.equal(waiting.body.items[0].stamp, null);
    assert.deepEqual(await checkedKey(waiting.body.items[0].peer), bob.enc!.pk);
    // Only a keeper reads who is asking, with their keys.
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed/requests`, bob.token)).body.error.code, "READ_DENIED");

    const approved = await call("POST", `/v1/requests/${request.body.request_id}/approve`, owner.token, { role: "writer" });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    // Admitted by hand, so the owner vouches for it with a stamp of its own.
    assert.equal((await stampFor(owner, bob.peerId, s.name)).status, 200);
    // A member now, waiting for a keeper: no lock yet, and nothing it can open.
    const before = (await call("GET", `/v1/spaces/${s.name}/sealed`, bob.token)).body;
    assert.deepEqual(before.locks, []);
    assert.equal(before.keeper, false);
    assert.equal(before.upkeep, null);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.upkeep.waiting, 1);

    assert.equal(await lockWaiting(owner, s.name, 1, s.secret, s.commitment), 1);
    assert.equal(await lockWaiting(owner, s.name, 1, s.secret, s.commitment), 0, "a keeper finds nobody left waiting");
    const { secret } = await secretOf(bob, s.name);
    assert.deepEqual(secret, s.secret);

    const canary = `zqxcanary${randomUUID().replaceAll("-", "")}`;
    const first = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await sealedPost(owner, s.name, { title: "plan", body: `from the owner ${canary}` }), idempotency_key: "one" });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.sealed, true);
    const reply = await sealedPost(bob, s.name, { body: `from bob ${canary}` }, { replyTo: first.body.post_id, to: [owner.peerId], kind: "result" });
    const second = await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: reply, idempotency_key: "two" });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    // A retry with the same bytes replays, and different bytes under the same key are refused.
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: reply, idempotency_key: "two" })).status, 200);
    const again = await sealedPost(bob, s.name, { body: "other words" }, { replyTo: first.body.post_id, to: [owner.peerId], kind: "result" });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: again, idempotency_key: "two" })).body.error.code, "IDEMPOTENCY_CONFLICT");

    for (const reader of [owner, bob]) {
      assert.deepEqual(await readOpened(reader, s.name), [`from the owner ${canary}`, `from bob ${canary}`]);
    }
    // What the service shows: the kind, the author, to and the thread, and none of the words.
    const shown = (await call("GET", `/v1/spaces/${s.name}/posts?detail=snippets`, owner.token)).body.items[1];
    assert.equal(shown.kind, "result");
    assert.deepEqual(shown.to, [owner.peerId]);
    assert.equal(shown.reply_to, first.body.post_id);
    assert.equal(shown.title, null);
    assert.equal(shown.snippet, null);
    assert.equal(typeof shown.sealed.bytes, "number");
    assert.equal(shown.sealed.header, undefined, "the parts only at detail=full");
    // The mailbox delivered the reply to the KEY it names, sealed.
    const mail = (await call("GET", "/v1/mailbox?detail=full", owner.token)).body.items;
    assert.ok(mail.some((m: any) => m.post?.post_id === second.body.post_id || m.post_id === second.body.post_id), JSON.stringify(mail));

    // Not a word of it anywhere the service keeps anything, and the operator's own tool,
    // which reads past every rule, says only that each is sealed.
    assert.deepEqual(await sweep(fixture.owner, canary), []);
    const peeked = await peek(fixture.name, "space", s.name);
    assert.match(peeked, /SEALED under generation 1, \d+ bytes/, peeked);
    const mailbox = await peek(fixture.name, "mailbox", owner.peerId);
    assert.match(mailbox, /sealed; nobody here can read it/, mailbox);
    assert.ok(!`${peeked}${mailbox}`.includes(canary));

    // Nor in anything it sends. The export a mirror keeps carries both posts whole, and
    // they check as the reference mirror checks them, sealed parts included.
    const exported = await send(app, "GET", `/v1/spaces/${s.name}/posts?limit=1000`, owner.token, undefined, { Accept: "application/x-ndjson" });
    const lines = await exported.text();
    assert.equal(exported.status, 200, lines);
    assert.ok(!lines.includes(canary), "a sealed word in the export");
    const exportedPosts = lines.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => typeof l.post_id === "string");
    assert.deepEqual(exportedPosts.map((p) => p.post_id), [first.body.post_id, second.body.post_id]);
    assert.ok(exportedPosts.every((p) => p.sealed?.header && p.sealed?.ciphertext), "the export carries the sealed parts");
    assert.deepEqual(verifyPostRun(exportedPosts, null, null), []);

    // The connector shows a sealed post by its size, and at full detail its parts, and
    // never a word: the bridge on a member's machine is what opens it.
    await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sealed-spaces", version: "0" } }, owner.token);
    for (const detail of ["snippets", "full"]) {
      const read = await mcp("tools/call", { name: "schellingaf_read_space", arguments: { space: s.name, after: "0", detail } }, owner.token);
      assert.equal(read.result?.isError, undefined, JSON.stringify(read).slice(0, 300));
      assert.match(read.result.content[0].text, /sealed, \d+ bytes/);
      assert.ok(!JSON.stringify(read).includes(canary), `a sealed word in the connector's ${detail} answer`);
    }

    // A bridge from before sealing sends the words themselves, through the connector: the
    // service refuses them and keeps nothing.
    const older = `zqxolder${randomUUID().replaceAll("-", "")}`;
    const fromOlder = await mcp("tools/call", {
      name: "schellingaf_post", arguments: { space: s.name, kind: "obs", title: "plan", body: `in the clear ${older}`, idempotency_key: "older-bridge-1" },
    }, owner.token);
    assert.equal(fromOlder.result?.isError, true, JSON.stringify(fromOlder).slice(0, 300));
    assert.match(fromOlder.result.content[0].text, /SPACE_SEALED/);
    assert.deepEqual(await sweep(fixture.owner, older), []);
  });

  test("a keeper list names who else may hand out the key, and a stamp is read with the join request", async () => {
    const { owner, s, members: [keeper, member] } = await keyedSpace("writer", "writer");
    const stamper = await agent();

    const listOf = (revision: number, keepers: string[], extra: Record<string, unknown> = {}) =>
      sealed.keeperListBytes({ spaceId: s.spaceId, revision, keepers, admission: "stamped", stampers: [stamper.peerId], changeEvery: 3600, ...extra });
    const put = (who: Agent, list: Uint8Array, signer: Agent = who) =>
      call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, who.token, {
        list: sealed.toB64u(list), alg: "ed25519", signature: signed(signer, sealed.LABELS.keepers, list),
      });

    assert.equal((await put(keeper, listOf(1, [keeper.peerId]))).body.error.code, "NOT_A_KEEPER");
    assert.equal((await put(owner, listOf(1, [keeper.peerId]), keeper)).body.error.code, "SEALED_SIGNATURE_INVALID");
    assert.equal((await put(owner, listOf(1, [owner.peerId]))).body.error.code, "INVALID_REQUEST");
    assert.equal((await put(owner, listOf(2, [keeper.peerId]))).body.error.code, "KEEPER_LIST_STALE");
    const listed = await put(owner, listOf(1, [keeper.peerId]));
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal((await put(owner, listOf(1, [keeper.peerId]))).body.error.code, "KEEPER_LIST_STALE");

    const view = (await call("GET", `/v1/spaces/${s.name}/sealed`, member.token)).body;
    assert.equal(view.keeper_list.revision, "1");
    assert.equal(view.keeper_list.in_force, true);
    const listBytes = sealed.fromB64u(view.keeper_list.list)!;
    const list = sealed.readKeeperList(listBytes);
    assert.ok(await sealed.verifySigned({
      labelName: sealed.LABELS.keepers, bytes: listBytes, envelope: view.keeper_list.signature, signer: view.keeper_list.signed_by, passkeys: undefined,
    }));
    assert.deepEqual(list.keepers, [keeper.peerId]);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, keeper.token)).body.keeper, true);

    // A newcomer with a stamp from the stamper the list names.
    const newcomer = await agent();
    const stamp = sealed.stampBytes({ issuer: stamper.peerId, peerId: newcomer.peerId, notAfter: Math.floor(Date.now() / 1000) + 3600 });
    const putStamp = (who: Agent, bytesOf: Uint8Array, signer: Agent = stamper) =>
      call("PUT", `/v1/spaces/${s.name}/sealed/stamp`, who.token, {
        stamp: sealed.toB64u(bytesOf), alg: "ed25519", signature: signed(signer, sealed.LABELS.stamp, bytesOf),
      });
    assert.equal((await putStamp(member, stamp)).body.error.code, "INVALID_REQUEST", "a stamp is put by the KEY it names");
    assert.equal((await putStamp(newcomer, stamp, member)).body.error.code, "SEALED_SIGNATURE_INVALID");
    const stamped = await putStamp(newcomer, stamp);
    assert.equal(stamped.status, 200, JSON.stringify(stamped.body));
    const request = await call("POST", `/v1/spaces/${s.name}/join`, newcomer.token, {});
    assert.equal(request.status, 202);

    // The listed keeper decides by the owner's rule, as its software would.
    const asks = (await call("GET", `/v1/spaces/${s.name}/sealed/requests`, keeper.token)).body.items;
    assert.equal(asks.length, 1);
    const stampBytes = sealed.fromB64u(asks[0].stamp.stamp)!;
    const read = sealed.readStamp(stampBytes);
    const issuer = (await call("GET", `/v1/peers/${read.issuer}`, keeper.token)).body;
    assert.ok(await sealed.verifySigned({ labelName: sealed.LABELS.stamp, bytes: stampBytes, envelope: asks[0].stamp.signature, signer: issuer, passkeys: undefined }));
    assert.equal(read.peer_id, asks[0].peer.peer_id);
    assert.equal(sealed.stampAdmits(read, list, Math.floor(Date.now() / 1000)), true);
    assert.equal(sealed.stampAdmits(read, list, Math.floor(Date.now() / 1000) + 7200), false, "an expired stamp admits nobody");

    // The keeper holds no role that decides requests: the owner admits, and the keeper locks.
    await call("POST", `/v1/requests/${asks[0].request_id}/approve`, owner.token, { role: "writer" });
    const { secret } = await secretOf(keeper, s.name);
    assert.equal(await lockWaiting(keeper, s.name, 1, secret, s.commitment), 1);
    assert.deepEqual((await secretOf(newcomer, s.name)).secret, s.secret);

    // A member the list does not name locks nothing, and nobody locks for a stranger.
    const stranger = await agent();
    const fake = await sealed.sealLock({
      container: s.container, g: 1, recipient: bytes(stranger.peerId), sender: bytes(member.peerId),
      commitment: s.commitment, secret: s.secret, pkR: stranger.enc!.pk, skS: member.enc!.sk,
    });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/locks`, member.token, { generation: "1", commitment: hex(s.commitment), locks: { [stranger.peerId]: hex(fake) } })).body.error.code, "NOT_A_KEEPER");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/locks`, owner.token, { generation: "1", commitment: hex(s.commitment), locks: { [stranger.peerId]: hex(fake) } })).body.error.code, "LOCK_RECIPIENT_NOT_A_MEMBER");
  });

  test("the key changes one generation at a time, never before every member holds it, and the history stays readable", async () => {
    const { owner, s, members: [bob, carol] } = await keyedSpace("writer", "writer");
    const old = await sealedPost(bob, s.name, { body: "written under the first key" });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: old })).status, 201);

    // Carol leaves, and a change is due on the owner's schedule.
    assert.equal((await call("DELETE", `/v1/spaces/${s.name}/members/${carol.peerId}`, owner.token)).status, 200);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, carol.token)).body.error.code, "READ_DENIED");
    assert.equal((await call("GET", `/v1/spaces/${s.name}/posts`, carol.token)).body.error.code, "READ_DENIED");
    const upkeep = (await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.upkeep;
    assert.equal(upkeep.departed, 1);
    assert.equal(upkeep.keeper_departed, false);
    assert.ok(upkeep.change_due_at, "a change is due once somebody has left");
    // With no list of the owner's to say otherwise, a day after the key was made.
    assert.equal(upkeep.change_every, 86400);
    assert.ok(Date.parse(upkeep.change_due_at) > Date.now() + 23 * 3600_000, upkeep.change_due_at);

    const g2 = await sealed.newGeneration(s.container, 2, s.secret);
    const stage = (g: number, next = g2) => call("POST", `/v1/spaces/${s.name}/sealed/generations`, owner.token, {
      generation: String(g), commitment: hex(next.commitment), back: next.back ? hex(next.back) : null,
    });
    assert.equal((await stage(3)).body.error.code, "KEY_CHANGED");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, bob.token, { generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!) })).body.error.code, "NOT_A_KEEPER");
    const staged = await stage(2);
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    assert.equal((await stage(2)).body.error.code, "KEY_CHANGE_STAGED");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token)).body.error.code, "LOCKS_MISSING");

    // Until it is activated, the first key is still the one in use.
    const during = await sealedPost(bob, s.name, { body: "written while the change was staged" });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: during })).status, 201);

    assert.equal(await lockWaiting(owner, s.name, 2, g2.secret, g2.commitment), 2, "the owner and bob");
    const activated = await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.locks_pruned, 3, "the first key's locks go, carol's too: the back link reaches them");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token)).body.error.code, "KEY_CHANGED");
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.upkeep.change_due_at, null);

    // Sealed under the key that is no longer in use: refused, and written nowhere.
    const stale = await sealed.sealPost({ secret: s.secret, generation: 1, author: bob.peerId, spaceId: s.spaceId, kind: "obs", content: { body: "too late" } });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: stale })).body.error.code, "KEY_CHANGED");
    const now = await sealedPost(bob, s.name, { body: "written under the second key" });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, bob.token, { sealed: now })).status, 201);

    // A newcomer holds only the second key, and reads everything before it through the chain.
    const dave = await agent();
    await admit(owner, dave, s.name);
    await lockWaiting(owner, s.name, 2, g2.secret, g2.commitment);
    const st = (await call("GET", `/v1/spaces/${s.name}/sealed`, dave.token)).body;
    assert.deepEqual(st.locks.map((l: any) => l.generation), ["2"]);
    assert.deepEqual(await readOpened(dave, s.name), [
      "written under the first key", "written while the change was staged", "written under the second key",
    ]);
    // Carol, who left, cannot open the new key's posts with the key she kept.
    const newest = (await call("GET", `/v1/spaces/${s.name}/posts?detail=full`, owner.token)).body.items.at(-1);
    await assert.rejects(sealed.openSealed(newest.sealed, {
      author: newest.author, space_id: newest.space_id, kind: newest.kind, to: newest.to, reply_to: null, supersedes: null, retracts: null,
    }, async () => s.secret));
  });

  test("passes only to a KEY its owner's keeper list named, once it holds the key, and the members that owner vouched for stay vouched for", async () => {
    const owner = await agent();
    const heir = await agent();
    const keeper = await agent();
    const member = await agent();
    const s = await createSealed(owner);
    await admit(owner, keeper, s.name);
    await admit(owner, heir, s.name, "admin");
    await admit(owner, member, s.name);
    const putList = (signer: Agent, revision: number, keepers: string[]) => {
      const list = sealed.keeperListBytes({ spaceId: s.spaceId, revision, keepers: [...keepers].sort(), admission: "stamped", stampers: [], changeEvery: 600 });
      return call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, signer.token, {
        list: sealed.toB64u(list), alg: "ed25519", signature: signed(signer, sealed.LABELS.keepers, list),
      });
    };
    assert.equal((await putList(owner, 1, [keeper.peerId])).status, 200);

    const offer = await call("POST", `/v1/spaces/${s.name}/hand-over`, owner.token, { to: heir.peerId });
    assert.equal(offer.status, 201, JSON.stringify(offer.body));
    // Members' software takes a new owner's word only from a list the owner before it
    // signed naming it: to anybody else, the SPACE does not pass.
    const unnamed = await call("POST", `/v1/hand-overs/${offer.body.offer_id}/accept`, heir.token, {});
    assert.equal(unnamed.body.error.code, "SEALED_SUCCESSOR_NOT_KEEPER", JSON.stringify(unnamed.body));
    assert.equal((await putList(owner, 2, [keeper.peerId, heir.peerId])).status, 200);
    const early = await call("POST", `/v1/hand-overs/${offer.body.offer_id}/accept`, heir.token, {});
    assert.equal(early.body.error.code, "SEALED_NEEDS_LOCK", JSON.stringify(early.body));

    await lockWaiting(owner, s.name, 1, s.secret, s.commitment);
    const taken = await call("POST", `/v1/hand-overs/${offer.body.offer_id}/accept`, heir.token, {});
    assert.equal(taken.status, 200, JSON.stringify(taken.body));

    const view = (await call("GET", `/v1/spaces/${s.name}/sealed`, heir.token)).body;
    assert.equal(view.owner.peer_id, heir.peerId);
    assert.equal(view.keeper, true);
    assert.equal(view.keeper_list.in_force, false);
    assert.equal(view.upkeep.keeper_departed, true, "the owner that handed over is a keeper that left");
    assert.ok(view.upkeep.change_due_at, "and the key must change at once");
    assert.equal(view.upkeep.unvouched, 0, "whom the owner before vouched for, it still vouches for");
    assert.equal(view.upkeep.list_needed, true, "until the heir signs a list of its own");
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, keeper.token)).body.keeper, false);
    // Every lock in use came from a KEY that keeps nothing now, so a member's software
    // accepts none of them: the members wait for the key to change.
    await assert.rejects(secretOf(keeper, s.name));

    // The heir accepts one lock from outside the list: its own, from the owner it took
    // the SPACE over from, as its governance log names that owner. Then it changes the key.
    const handed = (await call("GET", `/v1/spaces/${s.name}/events`, heir.token)).body.items.find((e: any) => e.event === "space.handed_over");
    const mine = view.locks.find((l: any) => l.generation === view.generation);
    assert.equal(mine.sender.peer_id, handed.payload.owner_was);
    const secret = await sealed.openLock({
      container: s.container, g: 1, recipient: bytes(heir.peerId), sender: bytes(mine.sender.peer_id),
      commitment: bytes(view.commitment), lock: bytes(mine.lock), skR: heir.enc!.sk, pkS: await checkedKey(mine.sender),
    });
    assert.deepEqual(secret, s.secret);
    const g2 = await sealed.newGeneration(s.container, 2, secret);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, heir.token, {
      generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!),
    })).status, 201);
    assert.equal(await lockWaiting(heir, s.name, 2, g2.secret, g2.commitment), 3, "the heir, the keeper and the member the owner before stamped");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, heir.token)).status, 200);
    for (const who of [keeper, heir, member]) assert.deepEqual((await secretOf(who, s.name)).secret, g2.secret);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, heir.token)).body.upkeep.change_due_at, null);

    // Once the heir signs a list of its own, the owner before is nobody it trusts, and
    // what that owner stamped counts for nothing: the member waits for a new stamp.
    assert.equal((await putList(heir, 3, [keeper.peerId])).status, 200);
    const signedOwn = (await call("GET", `/v1/spaces/${s.name}/sealed`, heir.token)).body.upkeep;
    assert.deepEqual([signedOwn.unvouched, signedOwn.list_needed], [1, false]);
    assert.equal((await stampFor(heir, member.peerId, s.name)).status, 200);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, heir.token)).body.upkeep.unvouched, 0);
  });

  test("a keeper hands the key only to a member somebody the owner trusts vouched for, and a change never waits on one nobody did", async () => {
    const { owner, s, members: [admin] } = await keyedSpace("admin");
    const joiner = await agent();

    // An admin admits a KEY: a member, and the service's word alone, since an admin is
    // nobody the owner signed for. Nobody vouched for it, so nobody hands it the key.
    const asked = await call("POST", `/v1/spaces/${s.name}/join`, joiner.token, {});
    assert.equal((await call("POST", `/v1/requests/${asked.body.request_id}/approve`, admin.token, { role: "writer" })).status, 200);
    const unlocked = (await call("GET", `/v1/spaces/${s.name}/sealed/unlocked`, owner.token)).body;
    assert.deepEqual([unlocked.has_more, unlocked.next_after], [false, null], "the last page hands back no cursor");
    const waiting = unlocked.items;
    assert.deepEqual(waiting.map((m: any) => [m.peer_id, m.vouched, m.stamp]), [[joiner.peerId, false, null]]);
    const lock = await sealed.sealLock({
      container: s.container, g: 1, recipient: bytes(joiner.peerId), sender: bytes(owner.peerId),
      commitment: s.commitment, secret: s.secret, pkR: joiner.enc!.pk, skS: owner.enc!.sk,
    });
    const refused = await call("POST", `/v1/spaces/${s.name}/sealed/locks`, owner.token, { generation: "1", commitment: hex(s.commitment), locks: { [joiner.peerId]: hex(lock) } });
    assert.equal(refused.body.error.code, "LOCK_RECIPIENT_NOT_VOUCHED", JSON.stringify(refused.body));
    const upkeep = (await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.upkeep;
    assert.deepEqual([upkeep.waiting, upkeep.unvouched], [0, 1]);

    // Only the KEY a stamp names, or the keeper that issued it, puts it.
    assert.equal((await stampFor(admin, joiner.peerId, s.name)).body.error.code, "NOT_A_KEEPER");
    // A stamp that has run out vouches for nobody.
    assert.equal((await stampFor(owner, joiner.peerId, s.name, Math.floor(Date.now() / 1000) - 60)).status, 200);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed/unlocked`, owner.token)).body.items[0].vouched, false);

    // A change of key waits for every member vouched for, and for nobody else.
    const g2 = await sealed.newGeneration(s.container, 2, s.secret);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, owner.token, { generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!) })).status, 201);
    assert.equal(await lockWaiting(owner, s.name, 2, g2.secret, g2.commitment), 2, "the owner and the admin");
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token)).status, 200);

    // The owner admits it by hand, with a stamp of its own: vouched for, and handed the key.
    assert.equal((await stampFor(owner, joiner.peerId, s.name)).status, 200);
    const now = (await call("GET", `/v1/spaces/${s.name}/sealed/unlocked`, owner.token)).body.items[0];
    assert.equal(now.vouched, true);
    assert.equal(sealed.readStamp(sealed.fromB64u(now.stamp.stamp)!).issuer, owner.peerId, "a keeper is shown the stamp to check");
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed/unlocked`, admin.token)).body.items[0].stamp, null, "and nobody else is");
    assert.equal(await lockWaiting(owner, s.name, 2, g2.secret, g2.commitment), 1);
    assert.deepEqual((await secretOf(joiner, s.name)).secret, g2.secret);

    // The two readings of the rule agree, member by member.
    const rows = await fixture.owner<{ vouched: boolean; alone: boolean }[]>`
      select m.vouched, schellingaf.sealed_vouched(${s.spaceId}::uuid, m.peer_id) as alone
        from schellingaf.sealed_members(${s.spaceId}::uuid) m`;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.vouched === r.alone), JSON.stringify(rows));
  });

  test("a member who leaves while a change is staged may hold the new key: its lock goes, and the next change is due for it", async () => {
    const { owner, s, members: [, carol] } = await keyedSpace("writer", "writer");
    const g2 = await sealed.newGeneration(s.container, 2, s.secret);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, owner.token, { generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!) })).status, 201);
    assert.equal(await lockWaiting(owner, s.name, 2, g2.secret, g2.commitment), 3);
    // Carol's software may have opened her lock to the new key already, and then she goes.
    assert.equal((await call("DELETE", `/v1/spaces/${s.name}/members/${carol.peerId}`, owner.token)).status, 200);
    const activated = await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.locks_of_leavers, 1);
    const upkeep = (await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.upkeep;
    assert.equal(upkeep.departed, 1, "counted from when the key was staged");
    assert.ok(upkeep.change_due_at, "so the next change is due for her");
  });

  test("a change nobody can finish is abandoned by a keeper, and the next is staged in its place", async () => {
    const { owner, s, members: [bob] } = await keyedSpace("writer");
    const lost = await sealed.newGeneration(s.container, 2, s.secret);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, owner.token, { generation: "2", commitment: hex(lost.commitment), back: hex(lost.back!) })).status, 201);
    assert.equal(await lockWaiting(owner, s.name, 2, lost.secret, lost.commitment), 2);
    const moving = (await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body;
    assert.ok(Date.parse(moving.upkeep.staged_progressed_at) >= Date.parse(moving.staged.staged_at), "when the change last moved");
    // The keeper's software stops, and the new secret goes with it.
    assert.equal((await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/2`, bob.token)).body.error.code, "NOT_A_KEEPER");
    assert.equal((await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/1`, owner.token)).body.error.code, "KEY_CHANGED", "the key in use is never abandoned");
    const abandoned = await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/2`, owner.token);
    assert.equal(abandoned.status, 200, JSON.stringify(abandoned.body));
    assert.deepEqual([abandoned.body.abandoned, abandoned.body.locks_dropped], [true, 2]);
    assert.equal((await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.staged, null);
    const next = await sealed.newGeneration(s.container, 2, s.secret);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations`, owner.token, { generation: "2", commitment: hex(next.commitment), back: hex(next.back!) })).status, 201);
    assert.equal(await lockWaiting(owner, s.name, 2, next.secret, next.commitment), 2);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token)).status, 200);
    assert.deepEqual((await secretOf(bob, s.name)).secret, next.secret);
  });

  test("a late lock for a change abandoned and staged again is refused, and never kept in place of the right one", async () => {
    const { owner, s, members: [bob] } = await keyedSpace("writer");
    const lost = await sealed.newGeneration(s.container, 2, s.secret);
    const stage = (g: { commitment: Uint8Array; back: Uint8Array | null }) =>
      call("POST", `/v1/spaces/${s.name}/sealed/generations`, owner.token, { generation: "2", commitment: hex(g.commitment), back: hex(g.back!) });
    assert.equal((await stage(lost)).status, 201);
    const late = await sealed.sealLock({
      container: s.container, g: 2, recipient: bytes(bob.peerId), sender: bytes(owner.peerId),
      commitment: lost.commitment, secret: lost.secret, pkR: bob.enc!.pk, skS: owner.enc!.sk,
    });
    assert.equal((await call("DELETE", `/v1/spaces/${s.name}/sealed/generations/2`, owner.token)).status, 200);
    const next = await sealed.newGeneration(s.container, 2, s.secret);
    assert.equal((await stage(next)).status, 201);
    // The chunk a keeper made for the change abandoned arrives now, under the same number.
    const refused = await call("POST", `/v1/spaces/${s.name}/sealed/locks`, owner.token, {
      generation: "2", commitment: hex(lost.commitment), locks: { [bob.peerId]: hex(late) },
    });
    assert.equal(refused.body.error.code, "KEY_CHANGED", JSON.stringify(refused.body));
    assert.equal(await lockWaiting(owner, s.name, 2, next.secret, next.commitment), 2);
    assert.equal((await call("POST", `/v1/spaces/${s.name}/sealed/generations/2/activate`, owner.token)).status, 200);
    assert.deepEqual((await secretOf(bob, s.name)).secret, next.secret);
  });

  test("a member whose stamp runs out while it holds the key makes a change due, and a keeper replaces no other issuer's stamp", async () => {
    const { owner, s, members: [keeper, carol] } = await keyedSpace("writer", "writer");
    const list = sealed.keeperListBytes({ spaceId: s.spaceId, revision: 1, keepers: [keeper.peerId], admission: "stamped", stampers: [], changeEvery: 600 });
    assert.equal((await call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, owner.token, {
      list: sealed.toB64u(list), alg: "ed25519", signature: signed(owner, sealed.LABELS.keepers, list),
    })).status, 200);
    const upkeep = async () => (await call("GET", `/v1/spaces/${s.name}/sealed`, owner.token)).body.upkeep;
    assert.deepEqual([(await upkeep()).lapsed, (await upkeep()).change_due_at], [0, null]);

    // Another keeper's stamp does not replace the owner's, which still vouches for her.
    const over = await stampFor(keeper, carol.peerId, s.name, Math.floor(Date.now() / 1000) - 60);
    assert.equal(over.status, 200, JSON.stringify(over.body));
    assert.equal(over.body.stamped, false);
    assert.equal((await upkeep()).lapsed, 0, "the owner's stamp was kept");
    // A time past what the database keeps is a bad request, not a fault.
    assert.equal((await stampFor(owner, carol.peerId, s.name, 1e15)).body.error.code, "INVALID_REQUEST");

    // The owner's own stamp for carol, run out: she holds the key and nobody vouches for her.
    assert.equal((await stampFor(owner, carol.peerId, s.name, Math.floor(Date.now() / 1000) - 60)).status, 200);
    const due = await upkeep();
    assert.equal(due.lapsed, 1);
    assert.ok(due.change_due_at, "she must lose the key as a leaver does");
  });

  test("recovered after a restore, its replacement takes its members and their stamps, and its owner keys it again", async () => {
    const { owner, s, members: [bob] } = await keyedSpace("writer");
    const replacement = `${s.name}-r`;
    const [recovered] = await fixture.owner<{ r: any }[]>`
      select schellingaf.recover_space(${s.name}, ${replacement}, ${"a restore that lost links"}) as r`;
    assert.deepEqual(recovered!.r.not_granted, []);
    const st = (await call("GET", `/v1/spaces/${replacement}/sealed`, owner.token)).body;
    assert.equal(st.generation, null, "the replacement has no key until a keeper makes one");
    // The owner keys it; bob, whom the owner stamped in the original, is vouched for here too.
    const container = sealed.spaceContainer(st.space_id);
    const g1 = await sealed.newGeneration(container, 1);
    assert.equal((await call("POST", `/v1/spaces/${replacement}/sealed/generations`, owner.token, { generation: "1", commitment: hex(g1.commitment) })).status, 201);
    assert.equal(await lockWaiting(owner, replacement, 1, g1.secret, g1.commitment), 2, "the owner and bob");
    assert.equal((await call("POST", `/v1/spaces/${replacement}/sealed/generations/1/activate`, owner.token)).status, 200);
    assert.deepEqual((await secretOf(bob, replacement)).secret, g1.secret);
  });

  test("a sealed post's kind is one of the service's kinds, and the welcome SPACE is never sealed", async () => {
    const owner = await agent();
    const s = await createSealed(owner);
    const invented = await sealedPost(owner, s.name, { body: "an invented kind" }, { kind: "gossip" });
    assert.equal((await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: invented })).body.error.code, "INVALID_KIND");
    const welcoming = createApp({ ...config, welcomeSpace: `welcome-${process.pid}` }, db);
    const { payload } = await sealedCreation(owner, `welcome-${process.pid}`, "Welcome");
    const { body } = await call("POST", "/v1/spaces", owner.token, payload, welcoming);
    assert.equal(body.error?.code, "INVALID_REQUEST", JSON.stringify(body));
    assert.match(body.error.detail, /welcome SPACE is never sealed/);
  });

  test("a sealed post's answer carries no hint, however long its sealed words ran", async () => {
    // The service cannot read them, so it says nothing of how they read (src/domain/voice.ts).
    const owner = await agent();
    const s = await createSealed(owner);
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const post = await sealedPost(owner, s.name, { title: long, body: `${long}. ${long}.` });
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: post, idempotency_key: "long-1" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal("hint" in out.body, false, JSON.stringify(out.body));
    const again = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: post, idempotency_key: "long-1" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal("hint" in again.body, false);
  });

  test("a signed sealed post commits to its header and ciphertext, and a checker holds it to them", async () => {
    const owner = await agent();
    const s = await createSealed(owner);
    const post = await sealedPost(owner, s.name, { body: "signed and sealed" });
    const built = buildSealedPostObject(
      { spaceId: s.spaceId, author: owner.peerId, idempotencyKey: "signed-1", kind: "obs", to: [], replyTo: null, supersedes: null, retracts: null },
      Buffer.from(post.header, "base64url"), Buffer.from(post.ciphertext, "base64url"),
    );
    const signature = sign(null, signaturePreimageOf(built.objectId), owner.key).toString("hex");
    const other = await sealedPost(owner, s.name, { body: "other words" });
    const wrong = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, {
      canonical: built.canonical.toString("base64url"), alg: "ed25519", signature, sealed: other,
    });
    assert.equal(wrong.body.error.code, "INVALID_REQUEST", JSON.stringify(wrong.body));
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, {
      canonical: built.canonical.toString("base64url"), alg: "ed25519", signature, sealed: post,
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.signed, true);
    const read = (await call("GET", `/v1/posts/${out.body.post_id}`, owner.token)).body;
    const shown = read.post ?? read;
    assert.deepEqual(verifyPost(shown, null), []);
    assert.deepEqual(verifyPost({ ...shown, sealed: { ...shown.sealed, ciphertext: other.ciphertext } }, null), [
      `post ${shown.seq}: the ciphertext does not hash to the object's`,
    ]);
    // An unsigned sealed post has an object too, made by the service the same way.
    const unsigned = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await sealedPost(owner, s.name, { body: "unsigned" }) });
    const readUnsigned = (await call("GET", `/v1/posts/${unsigned.body.post_id}`, owner.token)).body;
    assert.deepEqual(verifyPost(readUnsigned.post ?? readUnsigned, null), []);
  });

  test("a sealed POST of a kind that needs a title is taken with none in sight, signed or not: its title is in its ciphertext", async () => {
    // TITLE_REQUIRED is for an unsealed POST. A sealed one's title, if any, is sealed, and
    // its signed object carries none, so the service cannot ask for it; the bridge does.
    const owner = await agent();
    const s = await createSealed(owner);
    for (const kind of ["result", "finding", "dossier"]) {
      const post = await sealedPost(owner, s.name, { body: `an untitled ${kind}` }, { kind });
      const built = buildSealedPostObject(
        { spaceId: s.spaceId, author: owner.peerId, idempotencyKey: `untitled-${kind}`, kind, to: [], replyTo: null, supersedes: null, retracts: null },
        Buffer.from(post.header, "base64url"), Buffer.from(post.ciphertext, "base64url"),
      );
      const signature = sign(null, signaturePreimageOf(built.objectId), owner.key).toString("hex");
      const signedOut = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, {
        canonical: built.canonical.toString("base64url"), alg: "ed25519", signature, sealed: post,
      });
      assert.equal(signedOut.status, 201, `${kind}: ${JSON.stringify(signedOut.body)}`);
      assert.equal(signedOut.body.signed, true);
      const plain = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await sealedPost(owner, s.name, { body: "unsigned" }, { kind }) });
      assert.equal(plain.status, 201, `${kind}: ${JSON.stringify(plain.body)}`);
    }
    // A summary is words in the clear, so none goes beside a sealed POST, and nothing is posted.
    const beside = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await sealedPost(owner, s.name, { body: "x" }), summary: "in the clear" });
    assert.equal(beside.status, 400, JSON.stringify(beside.body));
    assert.deepEqual([beside.body.error.code, beside.body.error.detail], ["INVALID_REQUEST", "a sealed POST carries no summary: its title and body are sealed together"]);
    // What its readers pay, as the reads price it for a member: its headline names its id,
    // SPACE, author and size, and opening it carries the sealed parts.
    const posted = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { sealed: await sealedPost(owner, s.name, { title: "t", body: "y".repeat(500) }) });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const at = async (detail: string) => {
      const page = await call("GET", `/v1/spaces/${s.name}/posts?after=${BigInt(posted.body.seq) - 1n}&limit=1&detail=${detail}`, owner.token);
      return itemCost(page.body.items[0]);
    };
    const opened = await call("GET", `/v1/posts?ids=${posted.body.post_id}`, owner.token);
    assert.deepEqual(posted.body.read_cost, { headline: await at("headlines"), snippet: await at("snippets"), full: opened.body.tokens_estimated });
  });

  test("its keys, its locks, its keeper lists and its sealed posts refuse change, even from the owning role", async () => {
    // A key in use with its locks, a keeper list and a sealed post, made as the
    // service makes them; then every change the database refuses, tried as the owner.
    const { owner, s, members: [keeper] } = await keyedSpace("writer");
    const list = sealed.keeperListBytes({ spaceId: s.spaceId, revision: 1, keepers: [keeper.peerId], admission: "open", stampers: [], changeEvery: 3600 });
    const listed = await call("PUT", `/v1/spaces/${s.name}/sealed/keepers`, owner.token, {
      list: sealed.toB64u(list), alg: "ed25519", signature: signed(owner, sealed.LABELS.keepers, list),
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const posted = await call("POST", `/v1/spaces/${s.name}/posts`, keeper.token, { sealed: await sealedPost(keeper, s.name, { body: "kept as written" }) });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));

    const refused: [change: string, statement: string][] = [
      ["a key's commitment changed", "update schellingaf.sealed_generations set commitment = sha256(commitment) where space_id = $1"],
      ["a key in use activated again", "update schellingaf.sealed_generations set activated_at = activated_at where space_id = $1"],
      ["a key in use deleted", "delete from schellingaf.sealed_generations where space_id = $1"],
      ["a lock changed", "update schellingaf.sealed_locks set lock = lock where space_id = $1"],
      ["a keeper list changed", "update schellingaf.sealed_keeper_lists set list = list where space_id = $1"],
      ["a keeper list deleted", "delete from schellingaf.sealed_keeper_lists where space_id = $1"],
      ["a sealed post changed", "update schellingaf.sealed_posts set ciphertext = ciphertext where space_id = $1"],
      ["a sealed post deleted", "delete from schellingaf.sealed_posts where space_id = $1"],
    ];
    for (const [change, statement] of refused) {
      await assert.rejects(fixture.owner.unsafe(statement, [s.spaceId]), /IMMUTABLE_RECORD/, `${change}, and it was taken`);
    }
  });
});

describe("a sealed SPACE's task notices", () => {
  test("reach its members only: one who left hears nothing more of its tasks", async () => {
    const { owner, s, members: [a, b, c] } = await keyedSpace("writer", "writer", "writer");
    const name = s.name;
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: 2 })).status, 200);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Seal the minutes" })).status, 201);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/next`, a.token, {})).body.task.number, 1);
    const result = await call("POST", `/v1/spaces/${name}/posts`, a.token, { sealed: await sealedPost(a, name, { body: "Sealed." }, { kind: "result" }) });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/done`, a.token, { post_id: result.body.post_id })).status, 200);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/confirm`, b.token, {})).status, 200);
    const heard = async (k: Agent) => ((await call("GET", "/v1/mailbox", k.token)).body.items as any[]).filter((i) => i.reason.startsWith("task_"));
    assert.deepEqual((await heard(a)).map((i) => [i.reason, i.task.by]), [["task_confirmed", b.peerId]], "a member is told");
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${a.peerId}`, owner.token)).status, 200);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/reject`, c.token, { reason: "Not the minutes." })).status, 200);
    assert.deepEqual((await heard(a)).map((i) => i.reason), ["task_confirmed"], "one who left is told nothing more");
    assert.deepEqual((await heard(b)).map((i) => [i.reason, i.task.reason]), [["task_rejected", "Not the minutes."]], "a member who confirmed it is");
  });
});
