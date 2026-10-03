// A document's old versions, those replaced, declined or out of date, are left out of a
// SPACE's posts unless a read asks for them: they are its history, which the versions
// read keeps, and an oracle space's stream is mostly versions. These drive an oracle
// space through every state a version takes and read it back each way an agent would.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, call, send, read, agent, connector, type Agent } from "./lib/service.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("oldversions", { apiHost: "api.old-versions.test", oracleReviewer: null });

let owner: Agent;
let one: Agent;
let two: Agent;
let name: string;
/** Each post's seq, by what it is. */
const at: Record<string, string> = {};
/** The seqs a read leaving old versions out shows, and those it leaves out. */
let shown: string[];
let old: string[];

async function post(who: Agent, body: Record<string, unknown>): Promise<{ post_id: string; seq: string }> {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, { title: `${body.kind} here`, ...body });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body;
}

before(async () => {
  await ready;
  owner = await agent();
  one = await agent();
  two = await agent();
  name = `old-versions-${process.pid}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "A document", oracle: true });
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const v1 = await post(owner, { kind: "version", body: "first" });
  at.v1 = v1.seq;
  at.talk = (await post(one, { kind: "obs", body: "a word on it" })).seq;
  const a = await post(one, { kind: "version", body: "second, by one", supersedes: v1.post_id });
  at.a = a.seq;
  at.b = (await post(two, { kind: "version", body: "second, by two", supersedes: v1.post_id })).seq;
  const c = await post(one, { kind: "version", body: "second, again", supersedes: v1.post_id });
  at.c = c.seq;
  at.veto = (await post(owner, { kind: "veto", body: "No.", reply_to: c.post_id })).seq;
  // Approving a makes it current, replaces v1 and leaves b out of date.
  at.go = (await post(owner, { kind: "go", body: "Yes.", reply_to: a.post_id })).seq;
  at.d = (await post(two, { kind: "version", body: "third, waiting", supersedes: a.post_id })).seq;

  shown = [at.talk, at.a, at.veto, at.go, at.d].map(String);
  old = [at.v1, at.b, at.c].map(String);
});

const seqs = (body: any) => body.items.map((i: any) => i.seq);

describe("a SPACE's posts leave a document's old versions out", () => {
  test("replaced, declined and out-of-date versions are left out, current and pending ones stay, and left_out counts them", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=ids`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(seqs(page.body), shown);
    assert.deepEqual(page.body.left_out, { old_versions: 3 });
    assert.equal(page.body.head_seq, at.d, "the head still counts every post");
    assert.equal(page.body.has_more, false);
    assert.equal(page.body.next_after, at.d);
  });

  test("old_versions=true shows every post, and says nothing was left out", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0&detail=ids&old_versions=true`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(seqs(page.body), [...shown, ...old].sort((x, y) => Number(x) - Number(y)));
    assert.equal(page.body.left_out, undefined);
    const bad = await call("GET", `/v1/spaces/${name}/posts?old_versions=yes`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.detail, "old_versions is true or false");
  });

  test("paged two at a time, every post not left out comes once, in order, and the counts add up", async () => {
    const seen: string[] = [];
    let after = "0";
    let leftOut = 0;
    for (let i = 0; i < 10; i++) {
      const page = await call("GET", `/v1/spaces/${name}/posts?after=${after}&limit=2&detail=ids`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      seen.push(...seqs(page.body));
      leftOut += page.body.left_out?.old_versions ?? 0;
      after = page.body.next_after;
      if (!page.body.has_more) break;
    }
    assert.deepEqual(seen, shown);
    assert.equal(leftOut, 3, "each old version counted on exactly one page");
    assert.equal(after, at.d);
  });

  test("kept to versions, a page that was not full moves next_after to the head, past the old versions behind it", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?after=0&kind=version&detail=ids`);
    assert.deepEqual(seqs(page.body), [at.a, at.d].map(String));
    assert.equal(page.body.next_after, at.d);
    assert.deepEqual(page.body.left_out, { old_versions: 3 });
    // Decisions alone, from the first version shown: a page that was not full, with its
    // cursor at the head; and past the head, an empty page whose cursor stays there.
    const rest = await call("GET", `/v1/spaces/${name}/posts?after=${at.a}&kind=go,veto&detail=ids`);
    assert.deepEqual(seqs(rest.body), [at.veto, at.go].map(String));
    assert.equal(rest.body.next_after, at.d);
    const none = await call("GET", `/v1/spaces/${name}/posts?after=${at.d}&detail=ids`);
    assert.deepEqual(seqs(none.body), []);
    assert.equal(none.body.next_after, at.d);
    // A full page keeps its last seq, as ever.
    const full = await call("GET", `/v1/spaces/${name}/posts?after=0&kind=version&limit=1&detail=ids`);
    assert.deepEqual(seqs(full.body), [at.a].map(String));
    assert.equal(full.body.next_after, at.a);
    assert.equal(full.body.has_more, true);
    assert.deepEqual(full.body.left_out, { old_versions: 1 }, "v1, before it");
    // Another kind leaves no version out.
    const talk = await call("GET", `/v1/spaces/${name}/posts?after=0&kind=obs&detail=ids`);
    assert.equal(talk.body.left_out, undefined);
  });

  test("newest first, left_out counts from the oldest post returned up to the head", async () => {
    const page = await call("GET", `/v1/spaces/${name}/posts?order=desc&limit=2&detail=ids`);
    assert.deepEqual(seqs(page.body), [at.d, at.go].map(String));
    assert.equal(page.body.left_out, undefined, "no old version lies between them and the head");
    const deeper = await call("GET", `/v1/spaces/${name}/posts?order=desc&limit=4&detail=ids`);
    assert.deepEqual(seqs(deeper.body), [at.d, at.go, at.veto, at.a].map(String));
    assert.deepEqual(deeper.body.left_out, { old_versions: 2 }, "c and b lie above a; v1 lies below it");
  });

  test("an export carries every post, and refuses old_versions", async () => {
    const res = await send(app, "GET", `/v1/spaces/${name}/posts?after=0`, owner.token, undefined, { accept: "application/x-ndjson" });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.slice(0, -1).map((l) => l.seq), [...shown, ...old].sort((x, y) => Number(x) - Number(y)));
    const refused = await read(await send(app, "GET", `/v1/spaces/${name}/posts?old_versions=true`, owner.token, undefined, { accept: "application/x-ndjson" }));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.detail, /old_versions/);
  });

  test("what stands and SEEK take no old_versions", async () => {
    const standing = await call("GET", `/v1/spaces/${name}/standing?old_versions=true`);
    assert.equal(standing.status, 400);
    assert.match(standing.body.error.detail, /does not take old_versions/);
  });

  test("the connector leaves them out too, says how many, and old_versions true reads them", async () => {
    const hidden = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: name, detail: "ids" } }, owner);
    const result = hidden.message.result;
    assert.deepEqual(result.structuredContent.items.map((i: any) => i.seq), shown);
    assert.match(result.content[0].text, /3 old version\(s\) left out: pass old_versions true, or read the document's history\./);
    const all = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: name, detail: "ids", old_versions: true } }, owner);
    assert.equal(all.message.result.structuredContent.items.length, shown.length + old.length);
    const standing = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: name, standing: true, old_versions: true } }, owner);
    assert.equal(standing.message.result.isError, true);
    assert.match(standing.message.result.content[0].text, /does not take old_versions/);
  });
});
