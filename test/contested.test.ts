// Contested findings: the mark the service sets beside a finding's status, from a check's
// reject of a post it rests on as a task's result, or from a member's warn or fail citing
// one (migrations/0137_contested_findings.sql, src/http/contested.ts). These drive it
// through the routes, as an agent would, and read the database only to see the projection
// and to hold its limits to the api's.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { PORT, SUPERUSER, MIGRATE_PASSWORD } from "./bootstrap.ts";
import { publicKey } from "./helpers.ts";
import { statementsOf } from "../src/db/migrate.ts";
import { FINDING_LIMITS } from "../src/surface/vocabulary.ts";
import * as sealed from "../content/sealed.mjs";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("contested", { apiHost: "api.contested.test" });
before(async () => {
  await ready;
});

let n = 0;
/** A public work space whose tasks one confirmation accepts. */
async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `contested-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "The wen mi telegrams", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const set = await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: 1 });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  return name;
}

async function grant(owner: Agent, name: string, ...who: Agent[]) {
  for (const k of who) {
    const out = await call("PUT", `/v1/spaces/${name}/members/${k.peerId}`, owner.token, { role: "writer" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
  }
}

type Posted = { post_id: string; seq: string };
/** A post that must be written: its id and seq. */
async function posted(who: Agent, name: string, fields: Record<string, unknown>): Promise<Posted> {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, fields);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { post_id: out.body.post_id, seq: out.body.seq };
}

function finding(extra: Record<string, unknown> = {}) {
  return { kind: "finding", body: "Read against the 1931 codebook.", data: { claim: "Telegram 37 uses the 1931 codebook", status: "proposed", confidence: "medium", ...extra } };
}

async function ok(out: Promise<{ status: number; body: any }>) {
  const r = await out;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** Adds a task; its number. */
async function task(owner: Agent, name: string): Promise<number> {
  const out = await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Read row 4" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.task.number as number;
}
/** The holder takes task `number` and gives `result` as its result. */
async function done(holder: Agent, name: string, number: number, result: string) {
  const taken = await ok(call("POST", `/v1/spaces/${name}/tasks/next`, holder.token, { number }));
  assert.equal(taken.task.number, number);
  await ok(call("POST", `/v1/spaces/${name}/tasks/${number}/done`, holder.token, { post_id: result }));
}
async function reject(checker: Agent, name: string, number: number, post?: string) {
  await ok(call("POST", `/v1/spaces/${name}/tasks/${number}/reject`, checker.token, { reason: "Row 4 reads TO.", ...(post ? { post_id: post } : {}) }));
}
async function confirm(checker: Agent, name: string, number: number) {
  await ok(call("POST", `/v1/spaces/${name}/tasks/${number}/confirm`, checker.token, {}));
}

/** The list's item for a finding, read by nobody in particular. */
async function item(name: string, id: string): Promise<any> {
  const out = await call("GET", `/v1/spaces/${name}/findings`, null);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.items.find((f: any) => f.post_id === id);
}
async function view(id: string, who: Agent | null = null): Promise<any> {
  const out = await call("GET", `/v1/posts/${id}/finding`, who?.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

/** A crew: an owner, a doer and two checkers, in a fresh SPACE. */
async function crew() {
  const owner = await agent();
  const [doer, checker, other] = [await agent(), await agent(), await agent()];
  const name = await space(owner);
  await grant(owner, name, doer, checker, other);
  return { owner, doer, checker, other, name };
}

const TODAY_KEYS = ["number", "post_id", "seq", "author", "posted_at", "claim", "status", "confidence", "sources",
  "cited_by", "source_withdrawn", "supersedes", "superseded_by", "retracted_by", "task"];

describe("a check's reject", () => {
  test("1: a reject of a finding's own post names its seq, the task, the KEY and the check's post", async () => {
    const { owner, doer, checker, name } = await crew();
    const number = await task(owner, name);
    const f = await posted(doer, name, finding());
    await done(doer, name, number, f.post_id);
    const check = await posted(checker, name, { kind: "obs", body: "Check of task 1.", reply_to: f.post_id });
    await reject(checker, name, number, check.post_id);
    const it = await item(name, f.post_id);
    assert.deepEqual(it.contested, [{ cause: "rejected", on: f.seq, task: number, by: checker.peerId, post: check.seq }]);
    assert.deepEqual(Object.keys(it), [...TODAY_KEYS.slice(0, 11), "contested", ...TODAY_KEYS.slice(11)], "after source_withdrawn");
    assert.deepEqual((await view(f.post_id)).finding.contested, it.contested, "the one-post read says the same");
  });

  test("2: a reject of a result a finding rests on names that result's seq, and no post when the reject named none", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const f = await posted(other, name, finding({ sources: [r.seq] }));
    await reject(checker, name, number);
    assert.deepEqual((await item(name, f.post_id)).contested, [{ cause: "rejected", on: r.seq, task: number, by: checker.peerId }]);
  });

  test("3 and 4: another result accepted later keeps the mark; the same post done again and accepted clears it", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const one = await task(owner, name);
    const two = await task(owner, name);
    const r1 = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    const r2 = await posted(doer, name, { kind: "result", body: "Row 5 reads KA." });
    const f1 = await posted(other, name, finding({ sources: [r1.seq] }));
    const f2 = await posted(other, name, finding({ sources: [r2.seq] }));
    await done(doer, name, one, r1.post_id);
    await done(doer, name, two, r2.post_id);
    await reject(checker, name, one);
    await reject(checker, name, two);
    // Task 1 done again with another result, accepted: the first result is still rejected.
    const r3 = await posted(doer, name, { kind: "result", body: "Row 4 reads TO." });
    await done(doer, name, one, r3.post_id);
    await confirm(other, name, one);
    assert.equal((await item(name, f1.post_id)).contested.length, 1);
    // Task 2 done again with the same post, accepted: the mark goes with its cause.
    await done(doer, name, two, r2.post_id);
    assert.equal((await item(name, f2.post_id)).contested.length, 1, "done is not yet accepted");
    await confirm(other, name, two);
    assert.equal("contested" in (await item(name, f2.post_id)), false);
  });

  test("5: rejected twice in two cycles, one cause names the second reject", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    const f = await posted(owner, name, finding({ sources: [r.post_id] }));
    await done(doer, name, number, r.post_id);
    await reject(checker, name, number);
    await done(doer, name, number, r.post_id);
    const second = await posted(other, name, { kind: "obs", body: "Still TO." });
    await reject(other, name, number, second.post_id);
    assert.deepEqual((await item(name, f.post_id)).contested, [{ cause: "rejected", on: r.seq, task: number, by: other.peerId, post: second.seq }]);
  });

  test("6: the task's delete is refused and its retire keeps the mark", async () => {
    const { owner, doer, checker, name } = await crew();
    const number = await task(owner, name);
    const f = await posted(doer, name, finding());
    await done(doer, name, number, f.post_id);
    await reject(checker, name, number);
    const before = (await item(name, f.post_id)).contested;
    assert.equal(before.length, 1);
    const deleted = await call("POST", `/v1/spaces/${name}/tasks/${number}/delete`, owner.token, { reason: "Not needed." });
    assert.equal(deleted.body.error?.code, "TASK_TAKEN", JSON.stringify(deleted.body));
    assert.deepEqual((await item(name, f.post_id)).contested, before);
    await ok(call("POST", `/v1/spaces/${name}/tasks/${number}/retire`, owner.token, { reason: "Not needed." }));
    assert.deepEqual((await item(name, f.post_id)).contested, before);
  });

  test("7: a finding posted after the reject, and a newer one replacing it on the same sources, are both marked", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    await reject(checker, name, number);
    const f = await posted(other, name, finding({ sources: [r.seq] }));
    assert.equal((await item(name, f.post_id)).contested[0].on, r.seq);
    const g = await posted(other, name, { ...finding({ sources: [r.seq], status: "disputed" }), supersedes: f.post_id });
    assert.equal((await item(name, g.post_id)).contested[0].on, r.seq);
    assert.equal((await view(f.post_id)).finding.contested[0].on, r.seq, "the replaced one too");
  });

  test("8 and 9: a hidden or withheld finding carries no mark; an unmarked item's keys are today's", async () => {
    const { owner, doer, checker, name } = await crew();
    const plain = await posted(owner, name, finding({ claim: "Unmarked" }));
    assert.deepEqual(Object.keys(await item(name, plain.post_id)), TODAY_KEYS);
    const number = await task(owner, name);
    const f = await posted(doer, name, finding());
    await done(doer, name, number, f.post_id);
    await reject(checker, name, number);
    assert.ok((await item(name, f.post_id)).contested);
    await ok(call("PUT", `/v1/posts/${f.post_id}/hidden`, owner.token));
    let it = await item(name, f.post_id);
    assert.equal("contested" in it, false);
    assert.equal(it.unavailable.state, "hidden");
    assert.equal("contested" in (await view(f.post_id)).finding, false);
    await ok(call("DELETE", `/v1/posts/${f.post_id}/hidden`, owner.token));
    assert.ok((await item(name, f.post_id)).contested);
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${f.post_id}::uuid`;
    it = await item(name, f.post_id);
    assert.equal("contested" in it, false);
    assert.equal(it.unavailable.state, "withheld");
  });
});

describe("a member's warn or fail", () => {
  test("10: a warn citing a finding or its source marks it with the warn's title; a fail alike; an obs or result does not", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const s = await posted(doer, name, { kind: "obs", body: "Row 4." });
    const f = await posted(doer, name, finding({ sources: [s.seq] }));
    const quiet = await posted(doer, name, finding({ claim: "Cited by an obs and a result", sources: [s.seq] }));
    assert.equal("contested" in (await item(name, f.post_id)), false);
    await posted(other, name, { kind: "obs", body: "Agrees.", data: { sources: [quiet.seq] } });
    await posted(other, name, { kind: "result", body: "Rests on it.", data: { sources: [quiet.seq] } });
    assert.equal("contested" in (await item(name, quiet.post_id)), false);

    const w = await posted(checker, name, { kind: "warn", title: "Row 4 is TO, not TA", body: "See the scan.", data: { sources: [f.seq] } });
    assert.deepEqual((await item(name, f.post_id)).contested,
      [{ cause: "warn", on: f.seq, by: checker.peerId, post: w.seq, title: "Row 4 is TO, not TA" }]);
    const x = await posted(other, name, { kind: "fail", title: "Scan upside down", body: "Turn it.", data: { sources: [s.seq] } });
    assert.deepEqual((await item(name, f.post_id)).contested, [
      { cause: "fail", on: s.seq, by: other.peerId, post: x.seq, title: "Scan upside down" },
      { cause: "warn", on: f.seq, by: checker.peerId, post: w.seq, title: "Row 4 is TO, not TA" },
    ], "a fail on its source too, newest first");
    assert.equal((await item(name, quiet.post_id)).contested[0].cause, "fail", "a fail citing a source marks every finding resting on it");
  });

  test("11: a KEY with no role posts a warn in an open SPACE: no mark and no row", async () => {
    const owner = await agent();
    const stranger = await agent();
    const name = await space(owner, { join_policy: "open" });
    const f = await posted(owner, name, finding());
    const w = await posted(stranger, name, { kind: "warn", body: "Doubtful.", data: { sources: [f.seq] } });
    assert.equal("contested" in (await item(name, f.post_id)), false);
    const rows = await fixture.owner`select 1 from schellingaf.post_objections where post_id = ${w.post_id}::uuid`;
    assert.equal(rows.length, 0);
  });

  test("12: the warn replaced, retracted or hidden clears the mark; unhidden, it is back", async () => {
    const { owner, doer, checker, name } = await crew();
    const f = await posted(doer, name, finding());
    const marked = async () => "contested" in (await item(name, f.post_id));
    const warn = () => posted(checker, name, { kind: "warn", body: "Doubtful.", data: { sources: [f.seq] } });
    const w1 = await warn();
    assert.equal(await marked(), true);
    await posted(checker, name, { kind: "obs", body: "I take it back.", supersedes: w1.post_id });
    assert.equal(await marked(), false, "replaced");
    const w2 = await warn();
    assert.equal(await marked(), true);
    await posted(checker, name, { kind: "obs", body: "Withdrawn.", retracts: w2.post_id });
    assert.equal(await marked(), false, "retracted");
    const w3 = await warn();
    assert.equal(await marked(), true);
    await ok(call("PUT", `/v1/posts/${w3.post_id}/hidden`, owner.token));
    assert.equal(await marked(), false, "hidden");
    await ok(call("DELETE", `/v1/posts/${w3.post_id}/hidden`, owner.token));
    assert.equal(await marked(), true, "unhidden");
  });

  test("13: a sealed SPACE's warn with sources projects nothing", async () => {
    const me = await agent({ encryptionKey: true });
    const name = `contested-sealed-${process.pid}-${n++}`;
    const spaceId = randomUUID();
    const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
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
    const seal = (kind: string, content: Record<string, unknown>) =>
      sealed.sealPost({ secret: g1.secret, generation: 1, author: me.peerId, spaceId, kind, content });
    const first = await posted(me, name, { sealed: await seal("obs", { body: "Row 4." }) });
    const w = await posted(me, name, { sealed: await seal("warn", { body: "Doubtful.", data: { sources: [first.seq] } }) });
    const rows = await fixture.owner`
      select 1 from schellingaf.post_objections where post_id = ${w.post_id}::uuid
      union all select 1 from schellingaf.post_sources where post_id = ${w.post_id}::uuid`;
    assert.equal(rows.length, 0);
  });

  test("14: nine warns and a reject show eight causes, the reject first; two warns of one batch by seq", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    const f = await posted(owner, name, finding({ sources: [r.seq] }));
    await done(doer, name, number, r.post_id);
    const warns: string[] = [];
    for (let i = 0; i < 7; i++) {
      warns.push((await posted(i % 2 ? other : checker, name, { kind: "warn", body: `Doubt ${i}.`, data: { sources: [r.seq] } })).seq);
    }
    await reject(checker, name, number);
    const batch = await call("POST", `/v1/spaces/${name}/posts`, other.token, {
      posts: [{ kind: "warn", title: "Doubt 7", body: "Doubt 7.", data: { sources: [r.seq] } }, { kind: "warn", title: "Doubt 8", body: "Doubt 8.", data: { sources: [r.seq] } }],
    });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    warns.push(...batch.body.posts.map((p: any) => p.seq as string));
    const causes = (await item(name, f.post_id)).contested;
    assert.equal(causes.length, FINDING_LIMITS.causes);
    assert.equal(causes[0].cause, "rejected");
    assert.deepEqual(causes.slice(1).map((c: any) => c.post), warns.slice(-7).reverse());
  });

  test("21: a fail citing its author's own finding marks nothing; citing another's marks it", async () => {
    const { doer, checker, name } = await crew();
    const own = await posted(doer, name, finding({ claim: "Mine" }));
    const theirs = await posted(checker, name, finding({ claim: "Theirs" }));
    const x = await posted(doer, name, { kind: "fail", body: "Both wrong.", data: { sources: [own.seq, theirs.seq] } });
    assert.equal("contested" in (await item(name, own.post_id)), false);
    assert.equal((await item(name, theirs.post_id)).contested[0].post, x.seq);
    const rows = await fixture.owner<{ source_id: string }[]>`
      select source_id::text from schellingaf.post_objections where post_id = ${x.post_id}::uuid`;
    assert.deepEqual(rows.map((r) => r.source_id), [theirs.post_id]);
  });
});

describe("where the mark shows", () => {
  async function marked() {
    const { owner, doer, checker, name } = await crew();
    const f = await posted(doer, name, { ...finding({ claim: "Contested quokka" }), body: "Quokka row." });
    const plain = await posted(doer, name, { ...finding({ claim: "Plain quokka" }), body: "Quokka column." });
    await posted(checker, name, { kind: "warn", body: "Doubtful.", data: { sources: [f.seq] } });
    return { owner, f, plain, name };
  }

  test("15: a SEEK hit carries contested once at every detail; an unmarked hit has no key", async () => {
    const { f, plain, name } = await marked();
    for (const detail of ["snippets", "full", "ids"]) {
      const out = await call("GET", `/v1/seek?q=quokka&space=${name}&detail=${detail}`, null);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      const hit = out.body.items.find((h: any) => h.post_id === f.post_id);
      assert.equal(hit.contested, true, detail);
      if (hit.finding) assert.equal("contested" in hit.finding, false, "not in its finding too");
      assert.equal("contested" in out.body.items.find((h: any) => h.post_id === plain.post_id), false);
    }
  });

  test("16: a finding's snippet in a SPACE read at snippets", async () => {
    const { f, plain, name } = await marked();
    const items = (await call("GET", `/v1/spaces/${name}/posts?detail=snippets`, null)).body.items;
    assert.equal(items.find((p: any) => p.post_id === f.post_id).finding.contested, true);
    assert.equal("contested" in items.find((p: any) => p.post_id === plain.post_id).finding, false);
    const heads = (await call("GET", `/v1/spaces/${name}/posts?detail=headlines`, null)).body.items;
    assert.equal(heads.some((p: any) => "contested" in p || "contested" in (p.finding ?? {})), false, "headlines unchanged");
  });

  test("17: one post's sources each carry their own mark; nothing passes on", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const one = await task(owner, name);
    const two = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    const quiet = await posted(doer, name, { kind: "result", body: "Row 5 reads KA." });
    const gone = await posted(doer, name, { kind: "result", body: "Row 6 reads NA." });
    await done(doer, name, one, r.post_id);
    await done(doer, name, two, gone.post_id);
    await reject(checker, name, one);
    await reject(checker, name, two);
    await ok(call("PUT", `/v1/posts/${gone.post_id}/hidden`, owner.token));
    const g = await posted(other, name, finding({ claim: "G", sources: [r.seq] }));
    const f = await posted(other, name, finding({ claim: "F", sources: [g.seq, quiet.seq, gone.seq] }));
    const h = await posted(other, name, finding({ claim: "H", sources: [g.seq] }));
    const sources = (await view(f.post_id)).sources;
    assert.deepEqual(sources.map((s: any) => [s.post_id, s.contested]), [[g.post_id, true], [quiet.post_id, undefined], [gone.post_id, undefined]]);
    assert.deepEqual(Object.keys(sources[1]), ["post_id", "seq", "kind", "withdrawn"]);
    assert.equal("contested" in (await item(name, h.post_id)), false, "a finding resting on a contested finding is not marked by it");
  });

  test("18: a private SPACE's outsider reads nothing of a marked finding, as before", async () => {
    const owner = await agent();
    const [member, stranger] = [await agent(), await agent()];
    const name = await space(owner, { visibility: "private" });
    await grant(owner, name, member);
    const word = `numbat${process.pid}x${n++}`;
    const f = await posted(owner, name, { ...finding({ claim: `The ${word} row` }), body: `${word} row.` });
    await posted(member, name, { kind: "warn", body: "Doubtful.", data: { sources: [f.seq] } });
    // The member's warn marks it, for whoever reads the SPACE.
    assert.equal((await view(f.post_id, owner)).finding.contested[0].by, member.peerId);
    const seek = async (who: Agent | null) => {
      const out = await call("GET", `/v1/seek?q=${word}&detail=snippets`, who?.token);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      return out.body.items.filter((h: any) => h.post_id === f.post_id);
    };
    assert.equal((await seek(owner))[0].contested, true);
    assert.equal((await call("GET", `/v1/spaces/${name}/findings`, stranger.token)).body.error.code, "READ_DENIED");
    assert.equal((await call("GET", `/v1/posts/${f.post_id}/finding`, stranger.token)).body.error.code, "POST_NOT_FOUND");
    assert.deepEqual(await seek(stranger), []);
    assert.deepEqual(await seek(null), []);
  });
});

describe("the mailbox", () => {
  test("a contested item carries each cause read now, a reject's with its reason, and none once they cleared; its causes are charged", async () => {
    const { owner, doer, checker, name } = await crew();
    const number = await task(owner, name);
    const f = await posted(doer, name, finding());
    await done(doer, name, number, f.post_id);
    await reject(checker, name, number);
    // The reject told the finding's author: a post subject, reason contested
    // (test/contested-notices.test.ts holds who is told).
    const read = async () => {
      const out = await call("GET", "/v1/mailbox?reason=contested&detail=snippets", doer.token);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      // The page's price is its one item's: the post's bytes and its causes' bytes, over three.
      assert.equal(out.body.items.length, 1);
      const [only] = out.body.items;
      const third = (x: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(x), "utf8") / 3);
      assert.equal(out.body.tokens_estimated, third(only.post) + ("contested" in only ? third(only.contested) : 0));
      return out.body.items as any[];
    };
    let [one] = await read();
    assert.equal(one.post.post_id, f.post_id);
    assert.equal(one.post.finding.contested, true);
    assert.deepEqual(one.contested, [{ cause: "rejected", on: f.seq, task: number, by: checker.peerId, reason: "Row 4 reads TO." }]);
    // Done again with the same post and accepted: the item keeps its place, with no causes.
    await done(doer, name, number, f.post_id);
    await confirm(owner, name, number);
    [one] = await read();
    assert.equal(one.post.post_id, f.post_id);
    assert.equal("contested" in one, false);
    assert.equal("contested" in one.post.finding, false);
  });
});

describe("the projection", () => {
  test("20: each cap() name equals its FINDING_LIMITS key", async () => {
    const [row] = await fixture.owner<{ notices: string; scan: string }[]>`
      select schellingaf.cap('contested_notices')::text as notices, schellingaf.cap('contested_scan')::text as scan`;
    assert.deepEqual([Number(row!.notices), Number(row!.scan)], [FINDING_LIMITS.contestedNotices, FINDING_LIMITS.contestedScan]);
  });

  test("22: the migration waits for a POST under way, fills post_objections from the posts before it, and fills task 7 alone", async () => {
    const name = `schellingaf_t_contested_${process.pid}`;
    const admin = postgres(SUPERUSER);
    await admin.unsafe(`create database ${name} owner schellingaf_owner`);
    const db = postgres({ host: "127.0.0.1", port: PORT, database: name, username: "schellingaf_migrate", password: MIGRATE_PASSWORD, max: 1, onnotice: () => {} });
    try {
      await db`set role schellingaf_owner`;
      await db`create schema schellingaf`;
      await db`create table schellingaf.schema_migrations (version int primary key, name text not null, sha256 text not null, applied_at timestamptz not null default now())`;
      const dir = new URL("../migrations/", import.meta.url);
      const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      const apply = async (file: string) => {
        const text = readFileSync(new URL(file, dir), "utf8");
        if (text.startsWith("-- migrate: no-transaction")) {
          for (const statement of statementsOf(text)) await db.unsafe(statement);
          return;
        }
        await db.unsafe("begin");
        await db.unsafe(text);
        await db.unsafe("commit");
      };
      for (const file of files.filter((f) => f < "0137")) await apply(file);
      const [boss, member, stranger] = await Promise.all(["c-owner", "c-member", "c-stranger"].map(async (who) =>
        (await db<{ id: Buffer }[]>`select schellingaf.register_peer(${publicKey(`${who}-${process.pid}`)}) as id`)[0]!.id));
      await db`select schellingaf.create_space(${boss!}, 'before-contested', 'C', '', 'open', 'public')`;
      await db`
        insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
        select s.space_id, ${member!}, 'writer', 'grant', s.owner_id, 1 from schellingaf.spaces s where s.name = 'before-contested'`;
      const put = async (who: Buffer, kind: string, data: unknown, extra: { supersedes?: string; retracts?: string } = {}) => {
        const [p] = await db<{ receipt: { post_id: string; seq: string } }[]>`
          select schellingaf.append_post('before-contested', ${who}, ${kind}, null, ${`A ${kind}`},
                                          ${data === null ? null : db.json(data as never)}, null, '{}'::bytea[], null, null,
                                          ${extra.supersedes ?? null}::uuid, ${extra.retracts ?? null}::uuid, '[]'::jsonb, null) as receipt`;
        return p!.receipt;
      };
      const finding = { claim: "C", status: "proposed", confidence: "low" };
      const a = await put(boss!, "finding", finding);
      const b = await put(member!, "finding", finding);
      // Member warns and fails, with and without sources, of the same author and another,
      // then replaced, retracted and hidden; and a stranger's.
      await put(member!, "warn", { sources: [a.seq, b.seq] });
      await put(member!, "fail", { sources: [a.post_id] });
      await put(member!, "warn", null);
      await put(boss!, "fail", { sources: [b.seq] });
      const replaced = await put(member!, "warn", { sources: [a.seq] });
      await put(member!, "obs", null, { supersedes: replaced.post_id });
      const retracted = await put(boss!, "warn", { sources: [b.seq] });
      await put(boss!, "obs", null, { retracts: retracted.post_id });
      const hidden = await put(member!, "fail", { sources: [a.seq] });
      await db`insert into schellingaf.space_hidden (post_id, space_id, hidden_by, revision)
               select p.post_id, p.space_id, ${boss!}, 1 from schellingaf.posts p where p.post_id = ${hidden.post_id}::uuid`;
      await put(stranger!, "warn", { sources: [a.seq] });
      await put(member!, "obs", { sources: [a.seq] });
      // Two cycle-0 rejects that kept no result, as before 0116: task 7 of cipher-trial-1,
      // which the fill names, and another task, which it must leave alone. The fill's
      // result post is given its id by a superuser with triggers off: the foreign key needs
      // the post to exist, and append_post chooses its own ids.
      const seven = "01a0f762-af09-7cb5-8686-675bcb1d2e15";
      const sevenResult = "01a0f76b-f98d-73cc-bd7f-a374fc7126aa";
      const result = await put(member!, "obs", null);
      const su = postgres({ ...SUPERUSER, database: name, max: 1, onnotice: () => {} });
      try {
        await su.begin(async (tx) => {
          await tx`set local session_replication_role = replica`;
          await tx`update schellingaf.posts set post_id = ${sevenResult}::uuid where post_id = ${result.post_id}::uuid`;
        });
        for (const [task, number] of [[seven, 7], [randomUUID(), 8]] as const) {
          await db`
            insert into schellingaf.tasks (task_id, space_id, number, title, created_by)
            select ${task}::uuid, s.space_id, ${number}, ${`T${number}`}, s.owner_id from schellingaf.spaces s where s.name = 'before-contested'`;
          await db`
            insert into schellingaf.task_checks (task_id, space_id, cycle, peer_id, verdict, reason)
            select ${task}::uuid, s.space_id, 0, s.owner_id, 'reject', 'Wrong.' from schellingaf.spaces s where s.name = 'before-contested'`;
        }
        const before = await db`select task_id, cycle, peer_id, result_post_id from schellingaf.task_checks where task_id <> ${seven}::uuid order by task_id, cycle, peer_id`;
        assert.equal(before.length, 1);
        // A POST that has updated its SPACE and not yet written its post when the migration
        // starts. The migration locks spaces before posts, the writers' order, so it waits
        // for the POST and both commit; in the reverse order one was a deadlock's victim.
        // The POST commits before the migration's lock, so the backfill reads its warn.
        const writer = postgres({ host: "127.0.0.1", port: PORT, database: name, username: "schellingaf_migrate", password: MIGRATE_PASSWORD, max: 1, onnotice: () => {} });
        try {
          let between!: () => void;
          const spaceUpdated = new Promise<void>((resolve) => { between = resolve; });
          const posting = writer.begin(async (tx) => {
            await tx`set local role schellingaf_owner`;
            const [me] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
            await tx`update schellingaf.spaces set updated_at = updated_at where name = 'before-contested'`;
            between();
            // Until the migration waits on a lock this POST holds.
            for (let i = 0; ; i++) {
              const [waiting] = await su<{ n: number }[]>`
                select count(*)::int as n from pg_stat_activity
                 where datname = ${name} and wait_event_type = 'Lock' and pid <> ${me!.pid}`;
              if (waiting!.n > 0) break;
              assert.ok(i < 400, "the migration never waited on the POST");
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await tx`
              select schellingaf.append_post('before-contested', ${member!}, 'warn', null, 'A warn',
                                              ${tx.json({ sources: [a.seq] } as never)}, null, '{}'::bytea[], null, null,
                                              null, null, '[]'::jsonb, null)`;
          });
          await spaceUpdated;
          await Promise.all([posting, apply("0137_contested_findings.sql")]);
        } finally {
          await writer.end({ timeout: 5 });
        }
        assert.deepEqual(await db`select task_id, cycle, peer_id, result_post_id from schellingaf.task_checks where task_id <> ${seven}::uuid order by task_id, cycle, peer_id`, before);
        const [filled] = await db<{ r: string | null }[]>`select result_post_id::text as r from schellingaf.task_checks where task_id = ${seven}::uuid`;
        assert.equal(filled!.r, sevenResult);
      } finally {
        await su.end({ timeout: 5 });
      }
      const want = await db<{ s: string; p: string }[]>`
        select ps.source_id::text as s, ps.post_id::text as p
          from schellingaf.post_sources ps
          join schellingaf.posts w on w.post_id = ps.post_id
          join schellingaf.posts x on x.post_id = ps.source_id
         where w.kind in ('warn', 'fail') and not w.no_role and x.author_id <> w.author_id
         order by 1, 2`;
      const got = await db<{ s: string; p: string }[]>`select source_id::text as s, post_id::text as p from schellingaf.post_objections order by 1, 2`;
      assert.deepEqual(got.map((r) => [r.s, r.p]), want.map((r) => [r.s, r.p]));
      // Member warn a,b (a only: b is its own), fail a, boss fail b, replaced a, retracted b,
      // hidden a, and the warn of a posted while the migration waited: seven rows; the
      // stranger's warn and the obs, none.
      assert.equal(got.length, 7);
    } finally {
      await db.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  // Last in the file, over every post the tests above made.
  test("19: post_objections is the member warns and fails citing another author's post", async () => {
    const want = await fixture.owner<{ s: string; p: string }[]>`
      select ps.source_id::text as s, ps.post_id::text as p
        from schellingaf.post_sources ps
        join schellingaf.posts w on w.post_id = ps.post_id
        join schellingaf.posts x on x.post_id = ps.source_id
       where w.kind in ('warn', 'fail') and not w.no_role and x.author_id <> w.author_id
       order by 1, 2`;
    const got = await fixture.owner<{ s: string; p: string }[]>`
      select source_id::text as s, post_id::text as p from schellingaf.post_objections order by 1, 2`;
    assert.ok(want.length > 10, "the tests above made warns and fails");
    assert.deepEqual(got.map((r) => [r.s, r.p]), want.map((r) => [r.s, r.p]));
  });
});
