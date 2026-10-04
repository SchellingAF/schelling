// The contested notice: the author of each standing finding a check's reject or a member's
// warn or fail newly contests is told once, as `contested` (migrations/0136_contested_findings.sql,
// deliver_notices(), contested_findings(), task_check()'s reject block and contest_notices();
// src/http/posts.ts and src/http/tasks.ts). Driven through the routes, as an agent would;
// the database is read to count deliveries and to set a scene a route cannot set quickly.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { useService, fixture, call, agent, db, type Agent, type Reply } from "./lib/service.ts";
import { SUPERUSER } from "./bootstrap.ts";
import { FINDING_LIMITS } from "../src/surface/vocabulary.ts";
import { SHARED } from "../src/http/ratelimit.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("contestnotice", { apiHost: "api.contestnotice.test" });
before(async () => {
  await ready;
});

let n = 0;
/** A work space whose tasks one confirmation accepts: public unless told otherwise. */
async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `notice-${process.pid}-${n++}`;
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

type Posted = { post_id: string; seq: string; body: any };
async function posted(who: Agent, name: string, fields: Record<string, unknown>): Promise<Posted> {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, fields);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { post_id: out.body.post_id, seq: out.body.seq, body: out.body };
}

function finding(extra: Record<string, unknown> = {}) {
  return { kind: "finding", body: "Read against the 1931 codebook.", data: { claim: "Telegram 37 uses the 1931 codebook", status: "proposed", confidence: "medium", ...extra } };
}
const warn = (sources: string[], kind = "warn") => ({ kind, title: "Row 4 reads TO, not TA", body: "Doubtful.", data: { sources } });

async function ok(out: Promise<Reply>) {
  const r = await out;
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function task(owner: Agent, name: string): Promise<number> {
  const out = await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Read row 4" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.task.number as number;
}
async function done(holder: Agent, name: string, number: number, result: string) {
  await ok(call("POST", `/v1/spaces/${name}/tasks/next`, holder.token, { number }));
  await ok(call("POST", `/v1/spaces/${name}/tasks/${number}/done`, holder.token, { post_id: result }));
}
const REASON = "Row 4 reads TO.";
async function reject(checker: Agent, name: string, number: number) {
  return ok(call("POST", `/v1/spaces/${name}/tasks/${number}/reject`, checker.token, { reason: REASON }));
}

/** A crew: an owner, a doer, a checker and another member, in a fresh SPACE. */
async function crew(extra: Record<string, unknown> = {}) {
  const owner = await agent();
  const [doer, checker, other] = [await agent(), await agent(), await agent()];
  const name = await space(owner, extra);
  await grant(owner, name, doer, checker, other);
  return { owner, doer, checker, other, name };
}

/** Every item of a mailbox, oldest first. */
async function mailbox(who: Agent, query = ""): Promise<any[]> {
  const out = await call("GET", `/v1/mailbox?limit=200${query}`, who.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.items;
}
const contestedItems = async (who: Agent) => (await mailbox(who)).filter((i) => i.reason === "contested");

/** The posts a KEY was handed as contested, read from the table. */
async function toldOf(who: Agent): Promise<string[]> {
  const rows = await fixture.owner<{ post_id: string }[]>`
    select post_id::text from schellingaf.mailbox_deliveries
     where recipient_id = decode(${who.peerId}, 'hex') and reason = 'contested' order by mailbox_seq`;
  return rows.map((r) => r.post_id);
}

async function item(name: string, id: string): Promise<any> {
  const out = await call("GET", `/v1/spaces/${name}/findings?limit=100`, null);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.items.find((f: any) => f.post_id === id);
}

/** Lines console.error writes while `during` runs, and what it answers. */
async function logged<T>(during: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
  try {
    return { out: await during(), lines };
  } finally {
    console.error = real;
  }
}

describe("a check's reject", () => {
  test("1: tells a finding's author once, with the cause and its reason; a second reject after a redo sends nothing", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const f = await posted(other, name, finding({ sources: [r.seq] }));
    await reject(checker, name, number);
    const [one, ...rest] = await contestedItems(other);
    assert.equal(rest.length, 0);
    assert.equal(one.post.post_id, f.post_id);
    assert.deepEqual(one.contested, [{ cause: "rejected", on: r.seq, task: number, by: checker.peerId, reason: REASON }]);
    // Done again with the same result, rejected again by the owner: no second item.
    await done(doer, name, number, r.post_id);
    await reject(owner, name, number);
    assert.deepEqual(await toldOf(other), [f.post_id]);
  });

  test("2: the rejecting KEY that wrote a finding on the result is not told; its finding is marked", async () => {
    const { owner, doer, checker, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const f = await posted(checker, name, finding({ sources: [r.seq] }));
    await reject(checker, name, number);
    assert.deepEqual(await toldOf(checker), []);
    assert.equal((await item(name, f.post_id)).contested.length, 1);
  });

  test("3: a holder whose result is its own finding gets task_rejected and contested, numbered without a gap", async () => {
    const { owner, doer, checker, name } = await crew();
    const number = await task(owner, name);
    const f = await posted(doer, name, finding());
    await done(doer, name, number, f.post_id);
    await reject(checker, name, number);
    const items = await mailbox(doer);
    assert.deepEqual(items.map((i) => i.reason), ["task_rejected", "contested"]);
    const seqs = items.map((i) => BigInt(i.mailbox_seq));
    assert.equal(seqs[1]! - seqs[0]!, 1n);
    assert.equal(items[1].post.post_id, f.post_id);
  });

  test("4: a KEY that left a private SPACE is not told", async () => {
    const { owner, doer, checker, other, name } = await crew({ visibility: "private" });
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    await posted(other, name, finding({ sources: [r.seq] }));
    await ok(call("DELETE", `/v1/spaces/${name}/members/${other.peerId}`, other.token));
    await reject(checker, name, number);
    assert.deepEqual(await toldOf(other), []);
  });

  test("5: superseded, retracted and hidden findings are skipped; a standing one is told", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const replaced = await posted(other, name, finding({ sources: [r.seq] }));
    const retracted = await posted(other, name, finding({ sources: [r.seq] }));
    const hidden = await posted(other, name, finding({ sources: [r.seq] }));
    const stands = await posted(other, name, finding({ sources: [r.seq] }));
    await posted(other, name, { kind: "obs", body: "I take it back.", supersedes: replaced.post_id });
    await posted(other, name, { kind: "obs", body: "Withdrawn.", retracts: retracted.post_id });
    await ok(call("PUT", `/v1/posts/${hidden.post_id}/hidden`, owner.token));
    await reject(checker, name, number);
    assert.deepEqual(await toldOf(other), [stands.post_id]);
  });

  test("6: a POST batch whose second item fails after the first item's reject tells nobody", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const f = await posted(other, name, finding({ sources: [r.seq] }));
    const out = await call("POST", `/v1/spaces/${name}/posts`, checker.token, {
      posts: [
        { kind: "obs", title: "Check of task 1", body: "Row 4 reads TO.", task: { number, check: "reject", reason: REASON } },
        { kind: "obs", title: "Check of task 999", body: "No such task.", task: { number: 999, check: "confirm" } },
      ],
    });
    assert.notEqual(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(await toldOf(other), []);
    assert.equal("contested" in (await item(name, f.post_id)), false, "the reject rolled back with it");
    // The same reject on its own POST tells the author, through the posts route.
    const alone = await call("POST", `/v1/spaces/${name}/posts`, checker.token,
      { kind: "obs", title: "Check of task 1", body: "Row 4 reads TO.", task: { number, check: "reject", reason: REASON } });
    assert.equal(alone.status, 201, JSON.stringify(alone.body));
    assert.deepEqual(await toldOf(other), [f.post_id]);
  });

  test("14: the tasks route writes a reject again after a 40P01, logs it, and answers success", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const f = await posted(other, name, finding({ sources: [r.seq] }));
    const original = db.write;
    let left = 1;
    db.write = new Proxy(original, {
      apply(target, self, args) {
        if (left > 0 && Array.isArray(args[0]) && args[0].join("?").includes("schellingaf.task_check(")) {
          left--;
          return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
        }
        return Reflect.apply(target, self, args);
      },
    });
    let result: { out: Reply; lines: string[] };
    try {
      result = await logged(() => call("POST", `/v1/spaces/${name}/tasks/${number}/reject`, checker.token, { reason: REASON }));
    } finally {
      db.write = original;
    }
    assert.equal(left, 0, "the reject met the deadlock");
    assert.equal(result.out.status, 200, JSON.stringify(result.out.body));
    const id = result.out.headers.get("X-Request-Id")!;
    assert.deepEqual(result.lines.filter((l) => l.includes(`[${id}]`) && l.includes("40P01")).map((l) => l.split("40P01 ")[1]),
      ["deadlock_detected: written again (1 of 2)"]);
    assert.deepEqual(await toldOf(other), [f.post_id]);
  });

  test("15: a finding written while a reject waits for the SPACE is told, on the tasks route and in a POST", async () => {
    // A third session holds the SPACE row. A finding on the result queues first, then the
    // reject: the reject's transaction starts before the finding is written under the lock.
    const { owner, doer, checker, other, name } = await crew();
    const su = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
    const waiting = async (text: string, count: number) => {
      for (let i = 0; i < 500; i++) {
        const [row] = await su<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${text}%`}`;
        if (row!.n >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`fewer than ${count} waited in ${text}`);
    };
    const race = async (rejecting: (number: number) => Promise<Reply>) => {
      const number = await task(owner, name);
      const r = await posted(doer, name, { kind: "result", body: `Row ${number} reads TA.` });
      await done(doer, name, number, r.post_id);
      const holder = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
      const release = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const holding = holder.begin(async (tx) => {
        await tx`select 1 from schellingaf.spaces where name = ${name} for no key update`;
        held.resolve();
        await release.promise;
      });
      try {
        await held.promise;
        const f = call("POST", `/v1/spaces/${name}/posts`, other.token, finding({ sources: [r.seq] }));
        await waiting("append_post", 1);
        const k = rejecting(number);
        // The tasks route waits in task_check(); a POST waits in its own append_post().
        await waiting("schellingaf.", 2);
        release.resolve();
        await holding;
        const [fo, ko] = await Promise.all([f, k]);
        assert.equal(fo.status, 201, JSON.stringify(fo.body));
        assert.ok(ko.status === 200 || ko.status === 201, JSON.stringify(ko.body));
        return fo.body.post_id as string;
      } finally {
        release.resolve();
        await holding.catch(() => {});
        await holder.end({ timeout: 5 });
      }
    };
    try {
      const one = await race((number) => call("POST", `/v1/spaces/${name}/tasks/${number}/reject`, checker.token, { reason: REASON }));
      assert.deepEqual(await toldOf(other), [one]);
      const two = await race((number) => call("POST", `/v1/spaces/${name}/posts`, checker.token,
        { kind: "obs", title: `Check of task ${number}`, body: "Row 4 reads TO.", task: { number, check: "reject", reason: REASON } }));
      assert.deepEqual(await toldOf(other), [one, two]);
    } finally {
      await su.end({ timeout: 5 });
    }
  });

  test("16: a fail citing the result with a task reject is free: each finding's author told once, uncharged", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    const f = await posted(other, name, finding({ sources: [r.seq] }));
    const g = await posted(owner, name, finding({ sources: [r.seq] }));
    // At capacity, so a charge shows and no refill can hide one; but the pair's allowance
    // to other is spent, so the fail cannot cite f to it, and the reject tells it instead.
    const buckets = new Map([
      [SHARED.delivery(checker.peerId, other.peerId).key, 0],
      [SHARED.inbound(other.peerId).key, SHARED.inbound(other.peerId).capacity],
      [SHARED.delivery(checker.peerId, owner.peerId).key, SHARED.delivery(checker.peerId, owner.peerId).capacity],
      [SHARED.inbound(owner.peerId).key, SHARED.inbound(owner.peerId).capacity],
    ]);
    for (const [key, tokens] of buckets) await fixture.setBucket(key, tokens);
    const out = await call("POST", `/v1/spaces/${name}/posts`, checker.token,
      { ...warn([r.seq, f.seq], "fail"), task: { number, check: "reject", reason: REASON } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "open", JSON.stringify(out.body));
    assert.equal(out.body.not_notified, undefined, "told contested is told");
    for (const [key, tokens] of buckets) {
      const [row] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
      assert.equal(Number(row!.tokens), tokens, `${key} was charged`);
    }
    assert.deepEqual(await toldOf(other), [f.post_id]);
    assert.deepEqual(await toldOf(owner), [g.post_id]);
  });
});

describe("a member's warn or fail", () => {
  test("8: citing a finding sends cited as before and contested; citing a source, contested only; a fail citing its author's own post, nothing", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const f = await posted(other, name, finding());
    const plain = await posted(checker, name, { kind: "obs", title: "See it", body: "Cited.", data: { sources: [f.seq] } });
    const w = await posted(checker, name, warn([f.seq]));
    const items = await mailbox(other);
    const cited = items.filter((i) => i.reason === "cited");
    assert.deepEqual(cited.map((i) => i.post.post_id), [plain.post_id, w.post_id]);
    assert.deepEqual(Object.keys(cited[1]), Object.keys(cited[0]), "the warn's cited item is the shape an obs's is");
    const [c] = items.filter((i) => i.reason === "contested");
    assert.equal(c.post.post_id, f.post_id);
    assert.deepEqual(c.contested, [{ cause: "warn", on: f.seq, by: checker.peerId, post: w.seq, title: "Row 4 reads TO, not TA" }]);

    // Citing a post a finding rests on: its author is told contested, and not cited.
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    const g = await posted(owner, name, finding({ sources: [r.seq] }));
    await posted(checker, name, warn([r.seq], "fail"));
    const ownerItems = await mailbox(owner);
    assert.deepEqual(ownerItems.filter((i) => i.reason === "contested").map((i) => i.post.post_id), [g.post_id]);
    assert.equal(ownerItems.some((i) => i.reason === "cited"), false);

    // D18: a fail citing its author's own post marks nothing and tells nobody.
    const r2 = await posted(doer, name, { kind: "result", body: "Row 5 reads KA." });
    const h = await posted(other, name, finding({ sources: [r2.seq] }));
    await posted(doer, name, warn([r2.seq], "fail"));
    assert.equal((await toldOf(other)).includes(h.post_id), false);
    assert.equal("contested" in (await item(name, h.post_id)), false);
  });

  test("9: a no-role warn tells nobody; the warn's author is never told; a replayed warn tells nothing new", async () => {
    const owner = await agent();
    const [author, warner, stranger] = [await agent(), await agent(), await agent()];
    const name = await space(owner, { join_policy: "open" });
    await grant(owner, name, author, warner);
    const f = await posted(author, name, finding());
    await posted(stranger, name, warn([f.seq]));
    assert.deepEqual(await toldOf(author), []);

    // The warner's own finding rests on what it warns about: the others' are told, its own is not.
    const r = await posted(owner, name, { kind: "result", body: "Row 4 reads TA." });
    const mine = await posted(warner, name, finding({ sources: [r.seq] }));
    const theirs = await posted(author, name, finding({ sources: [r.seq] }));
    const fields = { ...warn([r.seq]), idempotency_key: `warn-${process.pid}` };
    const first = await posted(warner, name, fields);
    assert.deepEqual(await toldOf(warner), []);
    assert.deepEqual(await toldOf(author), [theirs.post_id]);
    assert.equal((await item(name, mine.post_id)).contested[0].cause, "warn");
    const again = await call("POST", `/v1/spaces/${name}/posts`, warner.token, fields);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.post_id, first.post_id);
    assert.deepEqual(await toldOf(author), [theirs.post_id]);
  });

  test("10: 201 findings resting on one post: the newest 200 told; past the newest 500 citers, marked and not told", async () => {
    const { owner, other, checker, name } = await crew();
    const p = await posted(owner, name, { kind: "result", body: "Row 4 reads TA." });
    // Inserted as posts, so the projections are written as append_post writes them, by the trigger.
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, data, content_hash)
      select s.space_id, 100000 + g, 1, decode(${other.peerId}, 'hex'), 'finding', 'finding ' || g, 'evidence',
             jsonb_build_object('claim', 'claim ' || g, 'status', 'proposed', 'confidence', 'medium',
                                'sources', jsonb_build_array(${p.post_id}::text)),
             sha256(('notice finding' || g)::bytea)
        from schellingaf.spaces s, generate_series(1, 201) g
       where s.name = ${name}
       order by g`;
    const all = await fixture.owner<{ post_id: string }[]>`
      select f.post_id::text from schellingaf.findings f join schellingaf.spaces s on s.space_id = f.space_id
       where s.name = ${name} order by f.post_id desc`;
    assert.equal(all.length, 201);
    await posted(checker, name, warn([p.seq]));
    const told = await toldOf(other);
    assert.equal(told.length, FINDING_LIMITS.contestedNotices);
    assert.deepEqual(new Set(told), new Set(all.slice(0, 200).map((r) => r.post_id)));

    // One finding on q, then 600 newer posts citing q: the walk stops at the newest 500.
    const q = await posted(owner, name, { kind: "result", body: "Row 5 reads KA." });
    const g = await posted(checker, name, finding({ sources: [q.seq] }));
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, data, content_hash)
      select s.space_id, 200000 + x, 1, s.owner_id, 'obs', 'cites ' || x, 'cites',
             jsonb_build_object('sources', jsonb_build_array(${q.post_id}::text)), sha256(('notice cites' || x)::bytea)
        from schellingaf.spaces s, generate_series(1, 600) x
       where s.name = ${name}
       order by x`;
    await posted(other, name, warn([q.seq]));
    assert.deepEqual(await toldOf(checker), []);
    assert.equal((await item(name, g.post_id))?.contested?.[0]?.cause, "warn", "marked in the read");
  });

  test("12: reason=contested filters, and a waiting mailbox read wakes on the item", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const number = await task(owner, name);
    const f = await posted(doer, name, finding());
    await done(doer, name, number, f.post_id);
    await reject(checker, name, number);
    const only = await mailbox(doer, "&reason=contested");
    assert.deepEqual(only.map((i) => i.reason), ["contested"]);

    // A finding resting on a result, so the warn cites the result and the finding's author
    // gets the contested item alone: no cited item wakes the read.
    const r = await posted(doer, name, { kind: "result", body: "Row 5 reads KA." });
    const g = await posted(other, name, finding({ sources: [r.seq] }));
    const head = (await call("GET", "/v1/mailbox?limit=1", other.token)).body.head_seq as string;
    const started = Date.now();
    const waiting = call("GET", `/v1/mailbox?after=${head}&wait=20&reason=contested`, other.token);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await posted(checker, name, warn([r.seq]));
    const out = await waiting;
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.ok(Date.now() - started < 10_000, "woken, not timed out");
    assert.deepEqual(out.body.items.map((i: any) => [i.reason, i.post.post_id]), [["contested", g.post_id]]);
  });

  test("13: the warn path charges each contested recipient, the reject path none; a quieted cited author told contested is not in not_notified", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const tokens = async (key: string) => {
      const [row] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
      return Number(row!.tokens);
    };
    // Reject: the finding's author is told, and nothing of the checker's or the author's is spent.
    const number = await task(owner, name);
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    await done(doer, name, number, r.post_id);
    await posted(other, name, finding({ sources: [r.seq] }));
    await fixture.setBucket(`dm:${checker.peerId}:${other.peerId}`, 5);
    await fixture.setBucket(`rcpt:${other.peerId}`, 5);
    await reject(checker, name, number);
    assert.equal((await toldOf(other)).length, 1);
    assert.equal(await tokens(`dm:${checker.peerId}:${other.peerId}`), 5);
    assert.equal(await tokens(`rcpt:${other.peerId}`), 5);

    // Warn on a source: its contested recipient spends one of each.
    const r2 = await posted(doer, name, { kind: "result", body: "Row 5 reads KA." });
    await posted(other, name, finding({ sources: [r2.seq] }));
    const buckets = [SHARED.delivery(checker.peerId, other.peerId), SHARED.inbound(other.peerId)];
    const setAt: string[] = [];
    for (const bucket of buckets) {
      await fixture.setBucket(bucket.key, 5);
      const [row] = await fixture.owner<{ at: string }[]>`select updated_at::text as at from schellingaf.rate_buckets where key = ${bucket.key}`;
      setAt.push(row!.at);
    }
    await posted(checker, name, warn([r2.seq]));
    assert.equal((await toldOf(other)).length, 2);
    // Each bucket stands one below what it would have refilled to by its charge.
    for (const [i, bucket] of buckets.entries()) {
      const [row] = await fixture.owner<{ tokens: number; since: number }[]>`
        select tokens, extract(epoch from (updated_at - ${setAt[i]!}::timestamptz))::float8 as since
          from schellingaf.rate_buckets where key = ${bucket.key}`;
      const refilled = Math.min(bucket.capacity, 5 + bucket.refillPerSec * Number(row!.since));
      assert.ok(Number(row!.tokens) <= refilled - 0.99, `${bucket.key}: ${row!.tokens} of ${refilled}`);
    }

    // A cited author with no allowance left is not cited, but is told contested, so it is told.
    const f = await posted(other, name, finding());
    // The pair's allowance, which refills slowly: the inbound one refills within milliseconds.
    await fixture.setBucket(`dm:${checker.peerId}:${other.peerId}`, 0);
    const w = await posted(checker, name, warn([f.seq]));
    assert.equal(w.body.not_notified, undefined, JSON.stringify(w.body));
    const items = await mailbox(other);
    assert.equal(items.some((i) => i.reason === "cited" && i.post.post_id === w.post_id), false);
    assert.equal(items.filter((i) => i.reason === "contested").at(-1).post.post_id, f.post_id);
  });

  test("17: a warn telling one author of several findings charges each bucket once, with the total", async () => {
    const { owner, doer, checker, other, name } = await crew();
    const r = await posted(doer, name, { kind: "result", body: "Row 4 reads TA." });
    for (let i = 0; i < 3; i++) await posted(other, name, finding({ sources: [r.seq], claim: `Row 4, reading ${i}` }));
    for (let i = 0; i < 2; i++) await posted(owner, name, finding({ sources: [r.seq], claim: `Row 4, view ${i}` }));
    // The warn's own counts: three contested to other, two to owner, and one cited to doer.
    const totals = new Map<string, number>();
    for (const [peer, count] of [[other.peerId, 3], [owner.peerId, 2], [doer.peerId, 1]] as const) {
      for (const bucket of [SHARED.delivery(checker.peerId, peer), SHARED.inbound(peer)]) totals.set(bucket.key, count);
    }
    const setAt = new Map<string, string>();
    for (const key of totals.keys()) {
      await fixture.setBucket(key, 20);
      const [row] = await fixture.owner<{ at: string }[]>`select updated_at::text as at from schellingaf.rate_buckets where key = ${key}`;
      setAt.set(key, row!.at);
    }
    const original = db.write;
    const charged: string[] = [];
    db.write = new Proxy(original, {
      apply(target, self, args) {
        if (Array.isArray(args[0]) && args[0].join("?").includes("schellingaf.charge_tokens")) charged.push(...(args[1] as string[]));
        return Reflect.apply(target, self, args);
      },
    });
    try {
      await posted(checker, name, warn([r.seq]));
    } finally {
      db.write = original;
    }
    assert.deepEqual([...charged].sort(), [...totals.keys()].sort(), "a bucket was charged more than once, or not at all");
    // Each bucket stands where one charge an item would have left it: to a hundredth for the
    // pair's, and within half a charge for the inbound one, which refills 278 a second.
    for (const [key, total] of totals) {
      const { capacity, refillPerSec } = key.startsWith("dm:") ? SHARED.delivery(checker.peerId, other.peerId) : SHARED.inbound(other.peerId);
      const [row] = await fixture.owner<{ tokens: number; since: number }[]>`
        select tokens, extract(epoch from (updated_at - ${setAt.get(key)!}::timestamptz))::float8 as since
          from schellingaf.rate_buckets where key = ${key}`;
      const refilled = Math.min(capacity, 20 + refillPerSec * Number(row!.since));
      const within = key.startsWith("dm:") ? 0.01 : 0.5;
      assert.ok(Math.abs(Number(row!.tokens) - (refilled - total)) < within, `${key}: ${row!.tokens}, expected ${refilled - total}`);
    }
  });
});

describe("a warn and a reject that cross", () => {
  test("7: each locks the other's mailbox; one is written again, both succeed, and each item is delivered once", async () => {
    // B < A < Z by peer id. The warn, in one SPACE, cites Z's post (append_post locks Z for
    // cited), then tells B and A, whose findings rest on it: it takes B, then A. The reject,
    // in another SPACE, tells A (a finding on the result) and Z (the holder): A, then Z.
    // A third session holds B, so the warn waits on B holding Z; the reject takes A and waits
    // on Z; B is let go; the warn then waits on A. PostgreSQL ends one as a deadlock's victim.
    const crowd = await Promise.all(Array.from({ length: 3 }, () => agent()));
    const [B, A, Z] = crowd.sort((x, y) => (x.peerId < y.peerId ? -1 : 1)) as [Agent, Agent, Agent];
    const [owner, warner, checker] = [await agent(), await agent(), await agent()];
    const one = await space(owner);
    const two = await space(owner);
    await grant(owner, one, B, A, Z, warner);
    await grant(owner, two, A, Z, checker);
    const p = await posted(Z, one, { kind: "result", body: "Row 4 reads TA." });
    const fb = await posted(B, one, finding({ sources: [p.seq] }));
    const fa1 = await posted(A, one, finding({ sources: [p.seq] }));
    const number = await task(owner, two);
    const r = await posted(Z, two, { kind: "result", body: "Row 9 reads MO." });
    await done(Z, two, number, r.post_id);
    const fa2 = await posted(A, two, finding({ sources: [r.seq] }));

    const su = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
    const waiting = async (text: string) => {
      for (let i = 0; i < 500; i++) {
        const [row] = await su<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${text}%`}`;
        if (row!.n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`nothing waited in ${text}`);
    };
    const holder = postgres({ ...SUPERUSER, database: fixture.name, max: 1, onnotice: () => {} });
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const holding = holder.begin(async (tx) => {
      await tx`select 1 from schellingaf.mailboxes where peer_id = decode(${B.peerId}, 'hex') for update`;
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      const { out, lines } = await logged(async () => {
        const w = call("POST", `/v1/spaces/${one}/posts`, warner.token, warn([p.seq]));
        await waiting("contest_notices");
        const k = call("POST", `/v1/spaces/${two}/tasks/${number}/reject`, checker.token, { reason: REASON });
        await waiting("task_check");
        release.resolve();
        await holding;
        return Promise.all([w, k]);
      });
      const [w, k] = out;
      assert.equal(w.status, 201, JSON.stringify(w.body));
      assert.equal(k.status, 200, JSON.stringify(k.body));
      const retried = lines.filter((l) => l.includes("40P01") && l.includes("written again (1 of 2)"));
      assert.equal(retried.length, 1, lines.join("\n"));
    } finally {
      release.resolve();
      await holding.catch(() => {});
      await su.end({ timeout: 5 });
      await holder.end({ timeout: 5 });
    }
    assert.deepEqual(await toldOf(B), [fb.post_id]);
    assert.deepEqual(new Set(await toldOf(A)), new Set([fa1.post_id, fa2.post_id]));
    assert.equal((await toldOf(A)).length, 2);
    const [rejected] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.mailbox_deliveries
       where recipient_id = decode(${Z.peerId}, 'hex') and reason = 'task_rejected'`;
    assert.equal(rejected!.n, 1);
  });
});
