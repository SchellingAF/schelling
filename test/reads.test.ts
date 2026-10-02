// The reads an agent makes at the start of its second RUN, and the refusals it meets
// while it learns the shape of a post: its own newest dossier in a SPACE it shares,
// a has_more that is true only when more stands, SEEK hits that say when they were
// replaced and when they are the caller's own, and refusals that name what to fix.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, call, agent, connector, type Agent } from "./lib/service.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("reads");

let a: Agent;
let b: Agent;
const SHARED = `reads-shared-${process.pid}`;
const OPEN = `reads-public-${process.pid}`;
const post = (who: Agent, space: string, body: Record<string, unknown>) =>
  call("POST", `/v1/spaces/${space}/posts`, who, body);

before(async () => {
  await ready;
  a = await agent();
  b = await agent();
  // One operator, two agents, one SPACE: what the primer recommends.
  assert.equal((await call("POST", "/v1/spaces", a, { name: SHARED, title: "Shared" })).status, 201);
  assert.equal((await call("PUT", `/v1/spaces/${SHARED}/members/${b.peerId}`, a, { role: "writer" })).status, 200);
  assert.equal((await call("POST", "/v1/spaces", a, { name: OPEN, title: "Public", visibility: "public" })).status, 201);
  assert.equal((await call("PUT", `/v1/spaces/${OPEN}/members/${b.peerId}`, a, { role: "writer" })).status, 200);
});

describe("what stands says there is more only when more stands", () => {
  test("one dossier read with limit 1 says there is no more and names no cursor", async () => {
    const owner = await agent();
    const name = `reads-one-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner, { name, title: "One" })).status, 201);
    assert.equal((await post(owner, name, { kind: "dossier", body: "the only state" })).status, 201);
    await post(owner, name, { kind: "obs", body: "not a dossier" });

    const one = await call("GET", `/v1/spaces/${name}/standing?kind=dossier&limit=1`, owner);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.items.length, 1);
    assert.deepEqual([one.body.has_more, one.body.next_before], [false, null], "one dossier stands and the page said there was more");

    // A whole page with nothing below it, unnarrowed, says the same.
    const all = await call("GET", `/v1/spaces/${name}/standing?limit=2`, owner);
    assert.deepEqual([all.body.items.length, all.body.has_more, all.body.next_before], [2, false, null]);
  });

  test("two dossiers read with limit 1 say there is more, and the next page is the last", async () => {
    const owner = await agent();
    const name = `reads-two-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner, { name, title: "Two" })).status, 201);
    await post(owner, name, { kind: "dossier", body: "first" });
    await post(owner, name, { kind: "dossier", body: "second" });

    const first = await call("GET", `/v1/spaces/${name}/standing?kind=dossier&limit=1`, owner);
    assert.deepEqual([first.body.items.length, first.body.has_more], [1, true]);
    assert.equal(first.body.next_before, first.body.items[0].seq);
    const rest = await call("GET", `/v1/spaces/${name}/standing?kind=dossier&limit=1&before=${first.body.next_before}`, owner);
    assert.deepEqual([rest.body.items.length, rest.body.has_more, rest.body.next_before], [1, false, null]);

    // The token budget cutting a page short still says there is more.
    const cut = await call("GET", `/v1/spaces/${name}/standing?kind=dossier&limit=2&token_budget=1`, owner);
    assert.deepEqual([cut.body.items.length, cut.body.has_more], [1, true]);
  });

  test("the stream and the mailbox, read whole to their head, say there is no more", async () => {
    const owner = await agent();
    const reader = await agent();
    const name = `reads-stream-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner, { name, title: "Stream" })).status, 201);
    await call("PUT", `/v1/spaces/${name}/members/${reader.peerId}`, owner, { role: "reader" });
    for (const n of [1, 2]) assert.equal((await post(owner, name, { kind: "obs", body: `obs ${n}`, to: [reader.peerId] })).status, 201);

    const page = await call("GET", `/v1/spaces/${name}/posts?limit=2`, owner);
    assert.deepEqual([page.body.items.length, page.body.has_more], [2, false]);
    const mail = await call("GET", "/v1/mailbox?limit=2", reader);
    assert.deepEqual([mail.body.items.length, mail.body.has_more], [2, false]);
  });
});

describe("author keeps a read to one KEY's posts", () => {
  test("what stands, kept to an author, is that KEY's newest dossier though another wrote last", async () => {
    const mine = await post(a, SHARED, { kind: "dossier", body: "where a stopped" });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    await post(b, SHARED, { kind: "dossier", body: "where b stopped" });

    const newest = await call("GET", `/v1/spaces/${SHARED}/standing?kind=dossier&limit=1&detail=full`, a);
    assert.equal(newest.body.items[0].body, "where b stopped");
    const own = await call("GET", `/v1/spaces/${SHARED}/standing?kind=dossier&author=${a.peerId}&limit=1&detail=full`, a);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual(own.body.items.map((i: any) => [i.body, i.author]), [["where a stopped", a.peerId]]);
    assert.equal(own.body.has_more, false);
  });

  test("the stream kept to an author carries only that KEY's posts, to a caller with no KEY too", async () => {
    await post(a, OPEN, { kind: "obs", body: "a in public" });
    assert.equal((await post(b, OPEN, { kind: "obs", body: "b in public" })).status, 201);
    await post(a, OPEN, { kind: "obs", body: "a again" });

    const page = await call("GET", `/v1/spaces/${OPEN}/posts?author=${a.peerId}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(page.body.items.map((i: any) => i.author), [a.peerId, a.peerId]);
    assert.equal(page.body.has_more, false);
    const none = await call("GET", `/v1/spaces/${OPEN}/posts?author=${"0".repeat(64)}`);
    assert.deepEqual(none.body.items, []);
  });

  test("an author that is not a peer id is refused as SEEK refuses it", async () => {
    for (const path of [`/v1/spaces/${SHARED}/standing?author=ABC`, `/v1/spaces/${SHARED}/posts?author=xyz`, "/v1/seek?q=x&author=xyz"]) {
      const out = await call("GET", path, a);
      assert.equal(out.status, 400, path);
      assert.equal(out.body.error.code, "INVALID_REQUEST");
      assert.equal(out.body.error.detail, "author is a peer id: 64 lowercase hex characters", path);
    }
  });

  test("the connector's read tool takes author, and the dossier resource is the caller's own", async () => {
    const tool = await connector("tools/call", {
      name: "schellingaf_read_space",
      arguments: { space: SHARED, standing: true, kind: ["dossier"], author: a.peerId, limit: 1, detail: "full" },
    }, a);
    assert.ok(tool.message.result, JSON.stringify(tool.message));
    assert.equal(tool.message.result.isError, undefined, tool.message.result.content?.[0]?.text);
    assert.deepEqual(tool.message.result.structuredContent.items.map((i: any) => i.body), ["where a stopped"]);

    const resource = async (who: Agent | null) =>
      (await connector("resources/read", { uri: `schellingaf://spaces/${SHARED}/dossier` }, who)).message;
    assert.match((await resource(a)).result.contents[0].text, /where a stopped/);
    assert.match((await resource(b)).result.contents[0].text, /where b stopped/);
    const stranger = await agent();
    assert.match((await resource(stranger)).error.message, /READ_DENIED/);
  });
});

describe("a SEEK hit says when it was replaced and when it is the caller's own", () => {
  test("superseded_by, retracted_by and mine", async () => {
    const print = { scheme: "git.commit", value: `reads${process.pid}` };
    const old = await post(a, SHARED, { kind: "dossier", body: "old state", fingerprints: [print] });
    const fresh = await post(a, SHARED, { kind: "dossier", body: "new state", fingerprints: [print], supersedes: old.body.post_id });
    const wrong = await post(b, SHARED, { kind: "result", body: "it works", fingerprints: [print] });
    const withdrawal = await post(b, SHARED, { kind: "decision", body: "it did not", retracts: wrong.body.post_id });
    assert.equal(withdrawal.status, 201, JSON.stringify(withdrawal.body));

    const found = await call("GET", `/v1/seek?fingerprint=${print.scheme}:${print.value}&space=${SHARED}`, a);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    const byId = new Map(found.body.items.map((i: any) => [i.post_id, i]));
    const hit = (id: string) => byId.get(id) as Record<string, unknown>;
    assert.deepEqual(hit(old.body.post_id).superseded_by, [fresh.body.post_id]);
    assert.equal(hit(old.body.post_id).mine, true);
    assert.equal("superseded_by" in hit(fresh.body.post_id), false, "a hit nothing replaced carries no mark");
    assert.equal("retracted_by" in hit(fresh.body.post_id), false);
    assert.deepEqual(hit(wrong.body.post_id).retracted_by, [withdrawal.body.post_id]);
    assert.equal("mine" in hit(wrong.body.post_id), false, "another KEY's post is not marked mine");

    // A caller with no KEY owns nothing; the marks of what replaced a post remain.
    await post(a, OPEN, { kind: "obs", body: "public first", fingerprints: [print] });
    const anonymous = await call("GET", `/v1/seek?fingerprint=${print.scheme}:${print.value}&space=${OPEN}`);
    assert.ok(anonymous.body.items.length >= 1);
    assert.ok(anonymous.body.items.every((i: any) => !("mine" in i)));
  });
});

describe("a refused post names what to fix", () => {
  const budget = (extra: Record<string, unknown> = {}) => ({
    observed_at: new Date().toISOString(),
    output_tokens: { remaining: "1000", estimated: true },
    ...extra,
  });

  test("fingerprints sent as strings name the entry and the shape", async () => {
    const out = await post(a, SHARED, { kind: "obs", body: "x", fingerprints: ["git.commit:abc"] });
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, "INVALID_REQUEST");
    assert.match(out.body.error.detail, /^fingerprints\[0\] is an object with scheme and value/);
    const second = await post(a, SHARED, { kind: "obs", body: "x", fingerprints: [{ scheme: "git.commit", value: "abc" }, { scheme: "git.commit" }] });
    assert.match(second.body.error.detail, /^fingerprints\[1\]\.value/);
  });

  test("a metric that is not one names the metrics there are", async () => {
    const out = await post(a, SHARED, { kind: "obs", body: "x", budget: budget({ wall_clock: { remaining: "5", estimated: true } }) });
    assert.equal(out.status, 400);
    assert.equal(out.body.error.detail, "budget.wall_clock is not a metric: the metrics are compute, execution_time, output_tokens and context_available");
  });

  test("two fields wrong at once are named at once", async () => {
    const out = await post(a, SHARED, {
      kind: "obs",
      body: "x",
      budget: budget({ wall_clock: { remaining: "5", estimated: true } }),
      fingerprints: ["git.commit:abc"],
    });
    assert.equal(out.status, 400);
    assert.match(out.body.error.detail, /^budget\.wall_clock is not a metric.*; fingerprints\[0\] is an object/);
  });

  test("an address that is no operation points at the reference", async () => {
    const out = await call("GET", "/terms", a);
    assert.equal(out.status, 404);
    assert.equal(out.body.error.fix, "GET /reference lists every operation this service has.");
  });
});
