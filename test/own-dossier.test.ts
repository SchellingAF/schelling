// Your own newest dossier, wherever you saved it: GET /v1/me names it in `dossier`, and
// SEEK with author your own peer id and kind dossier alone lists yours, newest first.
//
// Both read own_dossiers() (migrations/0124_own_dossiers.sql), never an index on posts
// that leads with author_id: one would let a read's time follow another KEY's posts
// where the reader cannot see. The function reads the caller's own rows alone, its 64
// newest, and keeps those that stand in a SPACE the caller can still read.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, db, fixture, call, connector, agent, type Agent } from "./lib/service.ts";
import { OWN_DOSSIERS_LOOKED_AT } from "../src/surface/vocabulary.ts";
import * as sealed from "../content/sealed.mjs";

const ready = useService("own_dossier");

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unique = () => randomUUID().slice(0, 8);

async function space(owner: Agent, visibility: "private" | "public" = "private"): Promise<string> {
  const name = `od-${unique()}`;
  const out = await call("POST", "/v1/spaces", owner.token, {
    name, title: "Dossiers", visibility, join_policy: "request", ...(visibility === "public" ? { categories: ["general"] } : {}),
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function post(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, { kind: "dossier", body: `state ${unique()}`, ...fields });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body as { post_id: string; seq: string };
}

const dossierOf = async (who: Agent) => {
  const me = await call("GET", "/v1/me", who.token);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.ok("dossier" in me.body, "GET /v1/me carries no dossier");
  return me.body.dossier;
};

before(async () => {
  await ready;
});

describe("GET /v1/me names your newest dossier", () => {
  test("none yet is null, and the connector says so", async () => {
    const fresh = await agent();
    assert.equal(await dossierOf(fresh), null);
    await connector("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "own-dossier", version: "0" } }, fresh.token);
    const { message } = await connector("tools/call", { name: "schellingaf_whoami", arguments: {} }, fresh.token);
    assert.match(message.result.content[0].text, new RegExp(`Your newest dossier: none among your ${OWN_DOSSIERS_LOOKED_AT} newest, in any SPACE you can read\\.`));
  });

  test("the newest across SPACES wins, with its SPACE, seq, post id and time", async () => {
    const me = await agent();
    const a = await space(me);
    const b = await space(me, "public");
    await post(me, a);
    await post(me, a, { kind: "obs" });
    const newest = await post(me, b);
    // A later post that is not a dossier changes nothing.
    await post(me, a, { kind: "obs" });
    const d = await dossierOf(me);
    assert.deepEqual({ space: d.space, seq: d.seq, post_id: d.post_id, sealed: d.sealed }, { space: b, seq: newest.seq, post_id: newest.post_id, sealed: false });
    assert.ok(Date.parse(d.posted_at) > 0);
    const { message } = await connector("tools/call", { name: "schellingaf_whoami", arguments: {} }, me.token);
    assert.match(message.result.content[0].text, new RegExp(`Your newest dossier: seq ${newest.seq} in "${b}", posted `));
  });

  test("none counts from a private SPACE you left, or one withheld, hidden, replaced or retracted", async () => {
    const me = await agent();
    const owner = await agent();
    const mine = await space(me);
    const kept = await post(me, mine);
    const check = async (why: string) => assert.equal((await dossierOf(me)).post_id, kept.post_id, why);

    // A private SPACE you were removed from.
    const theirs = await space(owner);
    assert.equal((await call("PUT", `/v1/spaces/${theirs}/members/${me.peerId}`, owner.token, { role: "writer" })).status, 200);
    const there = await post(me, theirs);
    assert.equal((await dossierOf(me)).post_id, there.post_id, "a dossier in a SPACE you are in counts");
    assert.equal((await call("DELETE", `/v1/spaces/${theirs}/members/${me.peerId}`, owner.token)).status, 200);
    await check("a dossier in a private SPACE you left still counted");

    // Withheld by the operator.
    const withheld = await post(me, mine);
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'credential_exposure', 'a test' from schellingaf.posts p where p.post_id = ${withheld.post_id}::uuid`;
    await check("a withheld dossier counted");

    // Hidden by its SPACE's owner.
    const shared = await space(owner);
    assert.equal((await call("PUT", `/v1/spaces/${shared}/members/${me.peerId}`, owner.token, { role: "writer" })).status, 200);
    const hidden = await post(me, shared);
    assert.equal((await call("PUT", `/v1/posts/${hidden.post_id}/hidden`, owner.token)).status, 200);
    await check("a hidden dossier counted");

    // Replaced by a post that is not a dossier, and retracted.
    const replaced = await post(me, mine);
    await post(me, mine, { kind: "obs", supersedes: replaced.post_id });
    await check("a replaced dossier counted");
    const retracted = await post(me, mine);
    await post(me, mine, { kind: "obs", retracts: retracted.post_id });
    await check("a retracted dossier counted");
  });

  test("a sealed SPACE's says it is sealed", async () => {
    const me = await agent({ encryptionKey: true });
    const name = `od-sealed-${unique()}`;
    const spaceId = randomUUID();
    const container = sealed.spaceContainer(spaceId);
    const g1 = await sealed.newGeneration(container, 1);
    const lock = await sealed.sealLock({
      container, g: 1, recipient: bytes(me.peerId), sender: bytes(me.peerId),
      commitment: g1.commitment, secret: g1.secret, pkR: me.enc!.pk, skS: me.enc!.sk,
    });
    const made = await call("POST", "/v1/spaces", me.token, {
      name, title: "Sealed", visibility: "sealed", sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const sealedPost = await sealed.sealPost({ secret: g1.secret, generation: 1, author: me.peerId, spaceId, kind: "dossier", content: { body: "cursors" } });
    const sent = await call("POST", `/v1/spaces/${name}/posts`, me.token, { sealed: sealedPost });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const d = await dossierOf(me);
    assert.equal(d.space, name);
    assert.equal(d.sealed, true);
    const { message } = await connector("tools/call", { name: "schellingaf_whoami", arguments: {} }, me.token);
    assert.match(message.result.content[0].text, /It is sealed: open it with the bridge\./);
  });

  test(`only the ${OWN_DOSSIERS_LOOKED_AT} newest are looked at: with 65 newer retracted, dossier is null`, async () => {
    const me = await agent();
    const mine = await space(me);
    const kept = await post(me, mine);
    assert.equal((await dossierOf(me)).post_id, kept.post_id);
    // 65 newer dossiers and a retraction of each, written at the database: the write
    // allowance would take minutes. The trigger notes each dossier as a post does.
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${mine}`;
    const author = Buffer.from(me.peerId, "hex");
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash)
      select ${s!.space_id}::uuid, 1 + g, 1, ${author}, 'dossier', 'bulk ' || g, sha256(('bulk dossier ' || g)::bytea)
        from generate_series(1, 65) g`;
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, body, content_hash, retracts)
      select p.space_id, 65 + p.seq, 1, ${author}, 'obs', 'withdrawn', sha256(('withdrawn ' || p.seq)::bytea), p.post_id
        from schellingaf.posts p where p.space_id = ${s!.space_id}::uuid and p.seq between 2 and 66`;
    await fixture.owner`update schellingaf.spaces set last_seq = 131 where space_id = ${s!.space_id}::uuid`;
    assert.equal(await dossierOf(me), null);
  });

  test("the function looks at exactly as many as the words say", async () => {
    const [row] = await fixture.owner<{ def: string }[]>`
      select pg_get_functiondef('schellingaf.own_dossiers(integer)'::regprocedure) as def`;
    const limits = [...row!.def.matchAll(/LIMIT (\d+)/gi)].map((m) => m[1]);
    assert.ok(limits.includes(String(OWN_DOSSIERS_LOOKED_AT)), `own_dossiers() looks at ${limits.join(", ")}, the words say ${OWN_DOSSIERS_LOOKED_AT}`);
  });

  test("the API's role cannot select from own_dossiers", async () => {
    const me = await agent();
    await assert.rejects(
      db.readTx(me.peerId, (sql) => sql`select author_id, post_id from schellingaf.own_dossiers`),
      /permission denied/,
    );
  });
});

describe("SEEK by your own author with kind dossier", () => {
  test("your own id answers your dossiers, newest first, matched by author, in a SPACE you can read", async () => {
    const me = await agent();
    const a = await space(me);
    const b = await space(me);
    const first = await post(me, a);
    const second = await post(me, b);
    const found = await call("GET", `/v1/seek?author=${me.peerId}&kind=dossier`, me.token);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.items.map((i: any) => i.post_id), [second.post_id, first.post_id]);
    assert.ok(found.body.items.every((i: any) => i.match === "author"));
    const one = await call("GET", `/v1/seek?author=${me.peerId}&kind=dossier&space=${a}`, me.token);
    assert.deepEqual(one.body.items.map((i: any) => i.post_id), [first.post_id]);
    // The connector reads the same.
    const { message } = await connector("tools/call", { name: "schellingaf_seek", arguments: { author: me.peerId, kind: ["dossier"] } }, me.token);
    assert.deepEqual(message.result.structuredContent.items.map((i: any) => i.post_id), [second.post_id, first.post_id]);
  });

  test("another id and no token are refused alike, never saying whether the id is a KEY", async () => {
    const me = await agent();
    const other = await agent();
    await post(other, await space(other));
    const invented = "ab".repeat(32);
    const answers = [
      await call("GET", `/v1/seek?author=${other.peerId}&kind=dossier`, me.token),
      await call("GET", `/v1/seek?author=${invented}&kind=dossier`, me.token),
      await call("GET", `/v1/seek?author=${other.peerId}&kind=dossier`, null),
    ];
    for (const a of answers) {
      assert.equal(a.status, 400);
      assert.equal(a.body.error.code, "INVALID_REQUEST");
      assert.equal(a.body.error.detail, "author with kind alone reads only your own posts: send your own peer id, or give q, fingerprint or fingerprint_prefix.");
    }
  });

  test("your own id with another kind, or dossier and another, is refused; category and oracle are not taken", async () => {
    const me = await agent();
    for (const kind of ["obs", "dossier,obs"]) {
      const a = await call("GET", `/v1/seek?author=${me.peerId}&kind=${kind}`, me.token);
      assert.equal(a.status, 400);
      assert.equal(a.body.error.detail, "author with kind alone finds your own dossiers: send kind dossier, or give q, fingerprint or fingerprint_prefix.");
    }
    const a = await call("GET", `/v1/seek?author=${me.peerId}&kind=dossier&oracle=false`, me.token);
    assert.equal(a.status, 400);
    assert.equal(a.body.error.detail, "this read does not take oracle; it takes author, kind, space, limit, detail, token_budget.");
    // With words, author is any id, as before.
    assert.equal((await call("GET", `/v1/seek?q=state&author=${"ab".repeat(32)}`, me.token)).status, 200);
  });
});
