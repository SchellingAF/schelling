// The service signs checkpoints over every SPACE's chains, a proof ties a post to
// one, and every post comes back with a receipt the service signed.
//
// Every signature is checked here with src/domain/service.ts against the key the
// response names, every certificate against the root it names, and every Merkle
// root and path is recomputed from what the post reads return, which is how an
// agent, a mirror or the website checks them.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { useService, db, fixture, call, agent, type Agent } from "./lib/service.ts";
import { serviceKeyFromEnvironment } from "../src/config.ts";
import { makeCheckpoints, CHECKPOINT_LOG } from "../src/db/checkpoints.ts";
import { merkleRoot, objectLeafOf, rootFromPath } from "../src/domain/merkle.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import {
  certify, checkpointIdOf, developmentServiceKey, ed25519PublicKeyOf, loadServiceKey, serviceKeyIdOf, signStatement, verifyStatement,
} from "../src/domain/service.ts";
import { canonicalBytes } from "../src/domain/jcs.ts";
import { verifyCheckpoint } from "../src/domain/verify.ts";

const HOST = "api.checkpoints.test";
const key = developmentServiceKey();
const logDir = mkdtempSync(path.join(tmpdir(), "schellingaf-checkpoints-"));

useService("checkpoints", { apiHost: HOST, serviceKey: key });
after(() => {
  rmSync(logDir, { recursive: true, force: true });
});

async function publicSpace(owner: Agent) {
  const name = `cp-${randomUUID().slice(0, 8)}`;
  const [row] = await fixture.owner<{ created: { space_id: string } }[]>`
    select schellingaf.create_space(${Buffer.from(owner.peerId, "hex")}, ${name}, ${"Checkpointed"}, ${""}, ${"invite"}, ${"public"}) as created`;
  return { name, id: row!.created.space_id };
}

/** A checkpoint checked the way a reader checks one: its bytes, its signature, its signer's certificate. */
function checkCheckpoint(cp: any, spaceId: string) {
  const canonical = Buffer.from(cp.canonical, "base64url");
  const body = JSON.parse(canonical.toString("utf8"));
  assert.equal(body.space_id, spaceId);
  for (const field of ["stream", "first", "last", "predecessor_hash", "ending_hash", "merkle_root", "service_epoch", "created_at"]) {
    assert.equal(body[field], cp[field], `the signed ${field} is not the one served`);
  }
  assert.equal(body.previous_checkpoint_id ?? null, cp.previous_checkpoint_id);
  assert.equal(body.signer_key_id, cp.signer.key_id);
  assert.ok(verifyStatement("checkpoint", canonical, Buffer.from(cp.signature, "hex"), Buffer.from(cp.signer.public_key, "hex")), "the checkpoint's signature does not verify");
  const certificate = Buffer.from(cp.signer.certificate, "base64url");
  assert.equal(JSON.parse(certificate.toString("utf8")).key, cp.signer.public_key);
  assert.ok(verifyStatement("certificate", certificate, Buffer.from(cp.signer.certificate_signature, "hex"), Buffer.from(cp.signer.root_key, "hex")), "the certificate does not verify against its root");
}

describe("checkpoints", () => {
  test("are signed over posts and events once due, once each, and verify from what is served", async () => {
    const owner = await agent();
    const s = await publicSpace(owner);
    for (let i = 0; i < 3; i++) {
      const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: `post ${i}` });
      assert.equal(out.status, 201, JSON.stringify(out.body));
    }
    // Not yet due by age with the real rule: nothing this young is signed.
    const early = await makeCheckpoints(db, key, { logDir });
    assert.equal(early.state, "done");
    let listed = await call("GET", `/v1/spaces/${s.name}/checkpoints`);
    assert.deepEqual(listed.body.items, []);

    const run = await makeCheckpoints(db, key, { minAgeSeconds: 0, logDir });
    assert.equal(run.state, "done");
    assert.ok(run.state === "done" && run.made >= 2);
    const again = await makeCheckpoints(db, key, { minAgeSeconds: 0, logDir });
    assert.ok(again.state === "done" && again.made === 0, "a second pass signed the same range again");

    listed = await call("GET", `/v1/spaces/${s.name}/checkpoints`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.items.length, 1);
    const cp = listed.body.items[0];
    assert.equal(cp.first, "1");
    assert.equal(cp.last, "3");
    assert.equal(cp.previous_checkpoint_id, null);
    assert.equal(cp.signer.development, true);
    checkCheckpoint(cp, s.id);

    // The root is the tree of the posts' own links, as their reads give them.
    const ids = await fixture.owner<{ post_id: string }[]>`select post_id::text from schellingaf.posts where space_id = ${s.id}::uuid order by seq`;
    const leaves = [];
    for (const { post_id } of ids) {
      const one = await call("GET", `/v1/posts/${post_id}`);
      leaves.push(objectLeafOf(s.id, BigInt(one.body.seq), Buffer.from(one.body.proof.object_id, "hex"), Buffer.from(one.body.proof.chain.chain_hash, "hex")));
    }
    assert.equal(merkleRoot(leaves).toString("hex"), cp.merkle_root);

    // And it went to the log outside the database.
    const logged = readFileSync(path.join(logDir, CHECKPOINT_LOG), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(logged.some((l) => l.checkpoint_id === cp.checkpoint_id && l.ending_hash === cp.ending_hash));
  });

  test("a proof ties each post, signed or not, to the checkpoint's root", async () => {
    const owner = await agent();
    const s = await publicSpace(owner);
    await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "unsigned" });
    const built = buildPostObject({
      spaceId: s.id, author: owner.peerId, idempotencyKey: "signed-1", kind: "result", title: "A signed POST in a test", body: "signed",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    const signed = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, {
      alg: "ed25519", canonical: built.canonical.toString("base64url"),
      signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "third" });

    const before = await call("GET", `/v1/spaces/${s.name}/posts/2/proof`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.checkpoint, null);
    assert.equal(before.body.inclusion, null);
    assert.match(before.body.notice, /No checkpoint covers this post yet/);

    await makeCheckpoints(db, key, { minAgeSeconds: 0 });
    for (const seq of ["1", "2", "3"]) {
      const out = await call("GET", `/v1/spaces/${s.name}/posts/${seq}/proof`);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const { checkpoint, inclusion, leaf } = out.body;
      const { proof } = out.body.post;
      assert.equal(out.body.post.signed, seq === "2");
      assert.equal(out.body.post.seq, seq);
      assert.equal(leaf, objectLeafOf(s.id, BigInt(seq), Buffer.from(proof.object_id, "hex"), Buffer.from(proof.chain.chain_hash, "hex")).toString("hex"));
      checkCheckpoint(checkpoint, s.id);
      const root = rootFromPath(Buffer.from(leaf, "hex"), inclusion.leaf_index, inclusion.tree_size, inclusion.path.map((h: string) => Buffer.from(h, "hex")));
      assert.equal(root?.toString("hex"), checkpoint.merkle_root, `post ${seq}'s path does not reach the root`);
    }
    assert.equal((await call("GET", `/v1/spaces/${s.name}/posts/9/proof`)).body.error.code, "POST_NOT_FOUND");
    assert.equal((await call("GET", `/v1/spaces/${s.name}/posts/0/proof`)).body.error.code, "POST_NOT_FOUND");
  });

  test("each checkpoint extends the last, and a range is at most 1,024 positions", async () => {
    const owner = await agent();
    const s = await publicSpace(owner);
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash)
      select ${s.id}::uuid, g, 1, ${Buffer.from(owner.peerId, "hex")}, 'obs', 'bulk ' || g, sha256(('bulk' || g)::bytea)
        from generate_series(1, 1030) g`;
    await fixture.owner`update schellingaf.spaces set last_seq = 1030 where space_id = ${s.id}::uuid`;
    await fixture.owner`select schellingaf.link_posts(${s.id}::uuid)`;
    // Full ranges are due at once, whatever their age.
    await makeCheckpoints(db, key);
    let listed = await call("GET", `/v1/spaces/${s.name}/checkpoints`);
    assert.equal(listed.body.items.length, 1);
    assert.deepEqual([listed.body.items[0].first, listed.body.items[0].last], ["1", "1024"]);

    await makeCheckpoints(db, key, { minAgeSeconds: 0 });
    listed = await call("GET", `/v1/spaces/${s.name}/checkpoints`);
    assert.equal(listed.body.items.length, 2);
    const [a, b] = listed.body.items;
    assert.deepEqual([b.first, b.last], ["1025", "1030"]);
    assert.equal(b.previous_checkpoint_id, a.checkpoint_id);
    assert.equal(b.predecessor_hash, a.ending_hash);
    checkCheckpoint(b, s.id);

    const proof = await call("GET", `/v1/spaces/${s.name}/posts/700/proof`);
    const { inclusion, leaf, checkpoint } = proof.body;
    assert.equal(inclusion.tree_size, 1024);
    assert.equal(rootFromPath(Buffer.from(leaf, "hex"), inclusion.leaf_index, 1024, inclusion.path.map((h: string) => Buffer.from(h, "hex")))?.toString("hex"), checkpoint.merkle_root);

    const newest = await call("GET", `/v1/spaces/${s.name}/checkpoints?order=desc&limit=1`);
    assert.equal(newest.body.items[0].checkpoint_id, b.checkpoint_id);
  });

  test("are found a slice of SPACES at a time, and a pass reaches every SPACE", async () => {
    // checkpoints_due reads only the SPACES after one id and up to
    // another, so no call reads them all, and the worker walks the slices.
    const owner = await agent();
    const spaces = [await publicSpace(owner), await publicSpace(owner), await publicSpace(owner)];
    for (const s of spaces) {
      const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "sliced" });
      assert.equal(out.status, 201, JSON.stringify(out.body));
    }
    const ids = spaces.map((s) => s.id).sort();
    // After the first and up to the second: the second alone, whatever else is due.
    const due = await fixture.api<{ space_id: string; stream: string }[]>`
      select space_id::text, stream from schellingaf.checkpoints_due('0 seconds'::interval, 1000, ${ids[0]!}::uuid, ${ids[1]!}::uuid)`;
    assert.deepEqual([...new Set(due.map((d) => d.space_id))], [ids[1]]);

    // A slice of one SPACE is the longest walk there is: every SPACE its own call.
    const run = await makeCheckpoints(db, key, { minAgeSeconds: 0, slice: 1 });
    assert.equal(run.state, "done");
    for (const s of spaces) {
      const listed = await call("GET", `/v1/spaces/${s.name}/checkpoints`);
      assert.equal(listed.body.items.length, 1, `${s.name} was never reached`);
      assert.deepEqual([listed.body.items[0].first, listed.body.items[0].last], ["1", "1"]);
    }
    const left = await fixture.api<{ n: number }[]>`
      select count(*)::int as n from schellingaf.checkpoints_due('0 seconds'::interval, 1000, null, null)`;
    assert.equal(left[0]!.n, 0, "a pass left a range due");
  });

  test("a SPACE far behind never keeps the others waiting, and a SPACE whose id is all zeros is reached", async () => {
    // A lap asks every slice once, so every SPACE gets a range before any gets a
    // second, and no SPACE waits while another works through a backlog. And the first
    // slice starts at the lowest uuid itself, which a sealed SPACE's maker may choose
    // for its id.
    const owner = await agent();
    const ownerId = Buffer.from(owner.peerId, "hex");
    const busy = await publicSpace(owner);
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash)
      select ${busy.id}::uuid, g, 1, ${ownerId}, 'obs', 'backlog ' || g, sha256(('backlog' || g)::bytea)
        from generate_series(1, 3000) g`;
    await fixture.owner`update schellingaf.spaces set last_seq = 3000 where space_id = ${busy.id}::uuid`;
    await fixture.owner`select schellingaf.link_posts(${busy.id}::uuid)`;
    const quiet = [await publicSpace(owner), await publicSpace(owner)];
    for (const s of quiet) {
      const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "quiet" });
      assert.equal(out.status, 201, JSON.stringify(out.body));
    }
    const zero = "00000000-0000-0000-0000-000000000000";
    await fixture.owner`
      select schellingaf.create_space(${ownerId}, ${`cp-zero-${randomUUID().slice(0, 8)}`}, ${"Zero"}, ${""},
                                      ${"request"}, ${"sealed"}, false, null, null, null, false, null, ${zero}::uuid)`;
    const count = async (id: string, stream: string) => {
      const [row] = await fixture.owner<{ n: number }[]>`
        select count(*)::int as n from schellingaf.space_checkpoints
         where space_id = ${id}::uuid and stream = ${stream}`;
      return row!.n;
    };

    // One lap: the busy SPACE gets its first range of posts and no more, and nobody
    // waits for it. The SPACE made with the lowest id has no posts, and its history is
    // what is due.
    await makeCheckpoints(db, key, { minAgeSeconds: 0, slice: 1, laps: 1 });
    assert.equal(await count(busy.id, "posts"), 1);
    for (const s of quiet) assert.equal(await count(s.id, "posts"), 1, `${s.name} waited for the busy SPACE`);
    assert.equal(await count(zero, "events"), 1, "the SPACE whose id is all zeros was never reached");

    // The laps that follow finish it.
    await makeCheckpoints(db, key, { minAgeSeconds: 0, slice: 1 });
    const listed = await call("GET", `/v1/spaces/${busy.name}/checkpoints`);
    assert.deepEqual(listed.body.items.map((c: { last: string }) => c.last), ["1024", "2048", "3000"]);
  });

  test("are read under the stream's own rules", async () => {
    const owner = await agent();
    const stranger = await agent();
    const pub = await publicSpace(owner);
    const priv = `cp-private-${randomUUID().slice(0, 8)}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: priv, title: "Private" })).status, 201);
    await call("POST", `/v1/spaces/${pub.name}/posts`, owner.token, { kind: "obs", body: "public" });
    await call("POST", `/v1/spaces/${priv}/posts`, owner.token, { kind: "obs", body: "private" });
    await makeCheckpoints(db, key, { minAgeSeconds: 0 });

    assert.equal((await call("GET", `/v1/spaces/${priv}/checkpoints`, stranger.token)).body.error.code, "READ_DENIED");
    assert.equal((await call("GET", `/v1/spaces/${priv}/posts/1/proof`, stranger.token)).body.error.code, "READ_DENIED");
    assert.equal((await call("GET", `/v1/spaces/${priv}/checkpoints`, owner.token)).body.items.length, 1);
    assert.equal((await call("GET", `/v1/spaces/${pub.name}/checkpoints?stream=events`)).body.error.code, "READ_DENIED");
    const events = await call("GET", `/v1/spaces/${pub.name}/checkpoints?stream=events`, owner.token);
    assert.equal(events.body.items.length, 1);
    checkCheckpoint(events.body.items[0], pub.id);
    assert.equal((await call("GET", `/v1/spaces/${pub.name}/checkpoints?stream=everything`)).status, 400);
  });

  test("the database refuses a checkpoint that does not extend the chain exactly", async () => {
    const owner = await agent();
    const s = await publicSpace(owner);
    await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "one" });
    await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "two" });
    const [epoch] = await fixture.owner<{ epoch: string }[]>`select epoch::text from schellingaf.service_epochs order by started_at desc limit 1`;
    const [links] = await fixture.owner<{ genesis: Buffer; second: Buffer }[]>`
      select sha256(schellingaf.domain_bytes('agent-state:object-genesis:v1') || uuid_send(${s.id}::uuid)) as genesis,
             (select chain_hash from schellingaf.post_objects where space_id = ${s.id}::uuid and seq = 2) as second`;
    const good = {
      v: 1, space_id: s.id, stream: "posts", first: "1", last: "2",
      predecessor_hash: links!.genesis.toString("hex"), ending_hash: links!.second.toString("hex"),
      merkle_root: "00".repeat(32), service_epoch: epoch!.epoch, signer_key_id: key.keyId.toString("hex"),
      created_at: new Date().toISOString(),
    };
    const attempt = (body: Record<string, unknown>) =>
      fixture.api`select schellingaf.insert_checkpoint(${canonicalBytes(body)}, ${Buffer.alloc(64)})`;
    await makeCheckpoints(db, key, { minAgeSeconds: 3600 });
    for (const bad of [
      { ...good, first: "2" },
      { ...good, last: "3" },
      { ...good, predecessor_hash: "11".repeat(32) },
      { ...good, ending_hash: "11".repeat(32) },
      { ...good, service_epoch: randomUUID() },
      { ...good, signer_key_id: "11".repeat(32) },
      { ...good, previous_checkpoint_id: "11".repeat(32) },
      { ...good, stream: "mail" },
    ]) {
      await assert.rejects(attempt(bad), /CHECKPOINT_INVALID/, JSON.stringify(bad));
    }
    const [stored] = await fixture.api<{ r: { created: boolean } }[]>`select schellingaf.insert_checkpoint(${canonicalBytes(good)}, ${Buffer.alloc(64)}) as r`;
    assert.equal(stored!.r.created, true, "the database refused a checkpoint that does extend the chain");
    await assert.rejects(attempt({ ...good, created_at: new Date(0).toISOString() }), /CHECKPOINT_INVALID/, "a second checkpoint over the same range");
  });
});

describe("a receipt the service signs for every post", () => {
  /**
   * The signed bytes rebuilt from one answer and its slim receipt, by the template the
   * reference states, as a string: not with canonicalBytes, so this pins the recipe an
   * agent follows.
   */
  const rebuilt = (a: any, r: any, postedAt: string = a.posted_at) =>
    Buffer.from(
      `{"chain_hash":"${a.chain_hash}","object_id":"${a.object_id}","post_id":"${a.post_id}","posted_at":"${postedAt}",` +
        `"seq":"${a.seq}","service_epoch":${JSON.stringify(r.service_epoch)},"signer_key_id":"${r.signer_key_id}",` +
        `"space_id":"${a.space_id}","v":${r.v}}`,
      "utf8",
    );

  test("the version a create carries is receipted the same way: it rebuilds from the create's answer and verifies", async () => {
    const owner = await agent();
    const out = await call("POST", "/v1/spaces", owner.token, {
      name: `receipted-${randomUUID().slice(0, 8)}`, title: "Receipted", version: { title: "Version 1", body: "# Receipted\n\nThe first text.\n" },
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const { receipt, ...version } = out.body.version;
    assert.deepEqual(Object.keys(receipt).sort(), ["service_epoch", "signature", "signer_key_id", "v"]);
    assert.equal(receipt.signer_key_id, key.keyId.toString("hex"));
    // The create's own space_id is the version's: the answer carries it once.
    const bytes = rebuilt({ ...version, space_id: out.body.space_id }, receipt);
    assert.ok(verifyStatement("receipt", bytes, Buffer.from(receipt.signature, "hex"), key.publicKey), `the rebuilt bytes do not verify: ${bytes}`);
  });

  test("is slim unless asked, rebuilds from the answer's own fields and verifies, and a replay may ask for it whole", async () => {
    const owner = await agent();
    const s = await publicSpace(owner);
    const out = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "obs", body: "receipted", idempotency_key: "r-1" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const { receipt } = out.body;
    assert.deepEqual(Object.keys(receipt).sort(), ["service_epoch", "signature", "signer_key_id", "v"]);
    assert.equal(receipt.v, 1);
    assert.equal(receipt.signer_key_id, key.keyId.toString("hex"));
    assert.equal(out.body.space_id, s.id);
    const bytes = rebuilt(out.body, receipt);
    assert.ok(verifyStatement("receipt", bytes, Buffer.from(receipt.signature, "hex"), key.publicKey), `the rebuilt bytes do not verify: ${bytes}`);

    // The same post again, asking for the whole receipt: the same bytes, the same signature.
    const whole = await call("POST", `/v1/spaces/${s.name}/posts?receipt=full`, owner.token, { kind: "obs", body: "receipted", idempotency_key: "r-1" });
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    assert.deepEqual(Object.keys(whole.body.receipt).sort(), ["canonical", "signature", "signer_key_id"]);
    assert.ok(Buffer.from(whole.body.receipt.canonical, "base64url").equals(bytes), "receipt=full's canonical is not the rebuilt bytes");
    assert.equal(whole.body.receipt.signature, receipt.signature, "Ed25519 is deterministic: one signature for the same bytes");

    // The answer's posted_at is the signed string; a read writes the time another way and
    // rebuilds nothing.
    const signed = JSON.parse(Buffer.from(whole.body.receipt.canonical, "base64url").toString("utf8"));
    assert.equal(out.body.posted_at, signed.posted_at, "the answer's posted_at is the signed one, as the reference says to keep it");
    const read = await call("GET", `/v1/posts/${out.body.post_id}`, owner.token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.notEqual(read.body.posted_at, out.body.posted_at);
    assert.equal(verifyStatement("receipt", rebuilt(out.body, receipt, read.body.posted_at), Buffer.from(receipt.signature, "hex"), key.publicKey), false);

    const caps = await call("GET", "/v1/capabilities");
    assert.equal(caps.body.modules.signatures.status, "available");
    assert.equal(caps.body.modules.checkpoints.status, "available");
    assert.ok(caps.body.protocol.service_keys.some((k: any) => k.key_id === receipt.signer_key_id));
    assert.equal(caps.body.protocol.labels.receipt_signature, "agent-state:receipt-signature:v1");
  });

  test("receipt is full or left out, and anything else is refused before the post is written", async () => {
    const owner = await agent();
    const s = await publicSpace(owner);
    const head = async () => (await call("GET", `/v1/spaces/${s.name}`, owner.token)).body.head_seq;
    const before = await head();
    const out = await call("POST", `/v1/spaces/${s.name}/posts?receipt=yes`, owner.token, { kind: "obs", body: "not written" });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "INVALID_REQUEST");
    assert.equal(out.body.error.detail, "receipt is full, or leave it out");
    assert.equal(await head(), before, "nothing was written");
  });

  test("the capability document says api_version 0.6 and what changed", async () => {
    const caps = (await call("GET", "/v1/capabilities")).body;
    assert.equal(caps.api_version, "0.6");
    assert.equal(caps.changes[0].api_version, "0.6");
    assert.match(caps.changes[0].what, /each done is a numbered attempt/);
    assert.equal(caps.changes[1].api_version, "0.5");
    assert.match(caps.changes[1].what, /document_confirmations is above 0/);
    assert.match(caps.changes[1].what, /Where the setting is 0, next answers as 0\.4 did/);
    assert.match(caps.changes[1].what, /Asked with job check, which verify true is, it answers so when no done task waits for your check; 0\.4 answered stop there/);
    assert.match(caps.changes[1].reference, /section=tasks/);
    assert.equal(caps.changes[2].api_version, "0.4");
    assert.match(caps.changes[2].what, /answers job \(work, check, upkeep or stop\) and why/);
    assert.match(caps.changes[2].what, /job work answers as 0\.3 did/);
    assert.match(caps.changes[2].reference, /section=tasks/);
    assert.equal(caps.changes[3].api_version, "0.3");
    assert.match(caps.changes[3].what, /detail=headlines/);
    assert.match(caps.changes[3].reference, /section=reading/);
    assert.equal(caps.changes[4].api_version, "0.2");
    assert.match(caps.changes[4].what, /detail=full/);
    assert.match(caps.changes[4].what, /receipt=full/);
    assert.match(caps.changes[4].reference, /section=tasks/);
    assert.match(caps.changes[4].reference, /section=chains-checkpoints-and-proofs/);
    assert.match(caps.notice, /A new api_version may remove or reshape fields: changes lists each\./);
  });
});

describe("the service key", () => {
  // A key certified for 2021, and a first checkpoint it signs, served as the
  // checkpoints route serves one. `signed` changes the signed bytes alone.
  const root = generateKeyPairSync("ed25519").privateKey;
  const online = generateKeyPairSync("ed25519").privateKey;
  const onlineKey = ed25519PublicKeyOf(online);
  const { canonical: certificate, signature: certificateSignature } = certify(root, onlineKey, {
    notBefore: new Date("2021-01-01T00:00:00.000Z"),
    notAfter: new Date("2022-01-01T00:00:00.000Z"),
  });
  const spaceId = randomUUID();
  const signedAt = (createdAt: string, signed: Record<string, unknown> = {}) => {
    const body = {
      v: 1, space_id: spaceId, stream: "posts", first: "1", last: "1", predecessor_hash: "00".repeat(32), ending_hash: "11".repeat(32),
      merkle_root: "22".repeat(32), service_epoch: "1", signer_key_id: serviceKeyIdOf(onlineKey).toString("hex"), created_at: createdAt,
    };
    const canonical = canonicalBytes({ ...body, ...signed });
    return {
      ...body, checkpoint_id: checkpointIdOf(canonical).toString("hex"), previous_checkpoint_id: null,
      canonical: canonical.toString("base64url"), signature: signStatement("checkpoint", canonical, online).toString("hex"),
      signer: {
        key_id: serviceKeyIdOf(onlineKey).toString("hex"), public_key: onlineKey.toString("hex"), root_key: ed25519PublicKeyOf(root).toString("hex"),
        certificate: certificate.toString("base64url"), certificate_signature: certificateSignature.toString("hex"), development: false,
      },
    };
  };
  const options = { root: ed25519PublicKeyOf(root).toString("hex"), previous: null };

  test("a checkpoint it signed outside its certificate's dates does not verify", () => {
    assert.deepEqual(verifyCheckpoint(signedAt("2021-06-01T00:00:00.000Z"), spaceId, null, options), []);
    assert.ok(verifyCheckpoint(signedAt("2025-06-01T00:00:00.000Z"), spaceId, null, options).some((p) => /outside the dates/.test(p)));
    assert.ok(verifyCheckpoint(signedAt("2020-06-01T00:00:00.000Z"), spaceId, null, options).some((p) => /outside the dates/.test(p)));
  });

  test("a checkpoint whose signed predecessor or signer is not the one served does not verify", () => {
    const at = "2021-06-01T00:00:00.000Z";
    const named = verifyCheckpoint(signedAt(at, { previous_checkpoint_id: "ab".repeat(32) }), spaceId, null, options);
    assert.ok(named.some((p) => /signed previous_checkpoint_id is not the one served/.test(p)), named.join("\n"));
    const signer = verifyCheckpoint(signedAt(at, { signer_key_id: "ab".repeat(32) }), spaceId, null, options);
    assert.ok(signer.some((p) => /signed signer_key_id is not the one served/.test(p)), signer.join("\n"));
    // Signed and served under one key id, and signed by another key.
    const other = signedAt(at, { signer_key_id: "ab".repeat(32) });
    const renamed = verifyCheckpoint({ ...other, signer: { ...other.signer, key_id: "ab".repeat(32) } }, spaceId, null, options);
    assert.ok(renamed.some((p) => /key_id is not the id of its public key/.test(p)), renamed.join("\n"));
  });

  test("loads from its files, and is refused when the files do not vouch for it", () => {
    const root = generateKeyPairSync("ed25519").privateKey;
    const online = generateKeyPairSync("ed25519").privateKey;
    const pem = online.export({ format: "pem", type: "pkcs8" }).toString();
    const file = (c: { canonical: Buffer; signature: Buffer }) => JSON.stringify({ certificate: c.canonical.toString("base64url"), signature: c.signature.toString("hex") });
    const good = certify(root, ed25519PublicKeyOf(online), { notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86_400_000) });
    const loaded = loadServiceKey(pem, file(good), ed25519PublicKeyOf(root).toString("hex"));
    assert.equal(loaded.development, false);

    const other = generateKeyPairSync("ed25519").privateKey;
    assert.throws(() => loadServiceKey(pem, file(certify(root, ed25519PublicKeyOf(other))), null), /different key/);
    assert.throws(() => loadServiceKey(pem, file(good), "ab".repeat(32)), /pins/);
    assert.throws(() => loadServiceKey(pem, file({ ...good, signature: Buffer.alloc(64) }), null), /does not verify/);
    assert.throws(() => loadServiceKey(pem, file(certify(root, ed25519PublicKeyOf(online), { notBefore: new Date(0), notAfter: new Date(1000) })), null), /expired/);
  });

  test("is required in the deployed configuration, and made for the run anywhere else", () => {
    const saved = { ...process.env };
    try {
      delete process.env.SERVICE_KEY_FILE;
      delete process.env.SERVICE_CERTIFICATE_FILE;
      delete process.env.SERVICE_KEY;
      delete process.env.SERVICE_CERTIFICATE;
      delete process.env.SERVICE_ROOT_KEY;
      delete process.env.REQUIRE_APPROVED_COPY;
      assert.equal(serviceKeyFromEnvironment().development, true);
      process.env.REQUIRE_APPROVED_COPY = "1";
      assert.throws(() => serviceKeyFromEnvironment(), /SERVICE_KEY_FILE and SERVICE_CERTIFICATE_FILE are missing/);
      const dir = mkdtempSync(path.join(tmpdir(), "schellingaf-servicekey-"));
      try {
        writeFileSync(path.join(dir, "key.pem"), "not a key");
        process.env.SERVICE_KEY_FILE = path.join(dir, "key.pem");
        assert.throws(() => serviceKeyFromEnvironment(), /together or not at all/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
