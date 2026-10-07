// Attempts at a task: migrations/0140_task_attempts.sql holds every rule. Any writer marks a
// task done with a visible post, its own or another KEY's, and each done is a numbered
// attempt; checks count per attempt, and the first attempt confirmed enough is accepted.
// These drive the rules through the routes, as an agent would, and read the database only
// to set a scene a route cannot, such as a claim that has passed. After every case,
// task_mirror_faults() answers nothing: every row mirrors its attempts.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { claimUntil, claimFor, claimsFromRows } from "./lib/claims.ts";
import { mirrorChecked, followDoneAt } from "./lib/mirror.ts";
import { PORT, SUPERUSER, MIGRATE_PASSWORD } from "./bootstrap.ts";
import { publicKey } from "./helpers.ts";
import { TASK_LIMITS } from "../src/surface/vocabulary.ts";
import { statementsOf } from "../src/db/migrate.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_attempts", { apiHost: "api.task-attempts.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

async function workSpace(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `attempts-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Transcription", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function added(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  const out = await call("POST", `/v1/spaces/${name}/tasks?detail=full`, who.token, { title: "Transcribe page 3", ...fields });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.task as Record<string, any>;
}

async function next(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  return call("POST", `/v1/spaces/${name}/tasks/next`, who.token, fields);
}

async function act(who: Agent, name: string, number: number, action: string, fields?: Record<string, unknown>, detail = "full") {
  return call("POST", `/v1/spaces/${name}/tasks/${number}/${action}${detail ? `?detail=${detail}` : ""}`, who.token, fields);
}

async function get(name: string, number: number) {
  const out = await call("GET", `/v1/spaces/${name}/tasks/${number}`);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.task as Record<string, any>;
}

async function result(who: Agent, name: string, body = "Page 3, transcribed.") {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind: "result", body, fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

async function notices(who: Agent) {
  const out = await call("GET", "/v1/mailbox", who.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return (out.body.items as any[]).filter((i) => i.reason.startsWith("task_"));
}

/**
 * An answer with what differs between runs replaced by a placeholder, numbered by first
 * appearance: ids, keys, times, the SPACE's name and the mailbox positions. A token estimate
 * becomes a number's placeholder too: PostgreSQL trims a timestamp's trailing zeros, so the
 * bytes it counts move by one between runs.
 */
function normalised(value: unknown, names: Map<string, string> = new Map()): unknown {
  const as = (raw: string, kind: string) => {
    if (!names.has(raw)) names.set(raw, `<${kind}${[...names.values()].filter((v) => v.startsWith(`<${kind}`)).length}>`);
    return names.get(raw)!;
  };
  if (Array.isArray(value)) return value.map((v) => normalised(v, names));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, k === "tokens_estimated" && typeof v === "number" ? "<tokens>" : normalised(v, names)]));
  }
  if (typeof value !== "string") return value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return as(value, "id");
  if (/^[0-9a-f]{64}$/.test(value)) return as(value, "key");
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return "<time>";
  if (/^attempts-\d+-\d+$/.test(value)) return as(value, "space");
  return value;
}

const FIXTURE = new URL("./fixtures/one-agent-one-task.json", import.meta.url);

describe("one agent, one task", () => {
  test("answers as it did before attempts: no attempt, attempts or claimants anywhere", async () => {
    const owner = await agent();
    const a = await agent();
    const b = await agent();
    const name = await workSpace(owner);
    await grant(owner, name, a, "writer");
    await grant(owner, name, b, "writer");
    await added(owner, name);
    const answers: Record<string, unknown> = {};
    answers.next = (await next(a, name)).body;
    const post = await result(a, name);
    answers.done = (await act(a, name, 1, "done", { post_id: post }, "")).body;
    answers.again = (await act(a, name, 1, "done", { post_id: post })).body;
    answers.list = (await call("GET", `/v1/spaces/${name}/tasks`)).body;
    answers.compact = (await call("GET", `/v1/spaces/${name}/tasks?detail=compact`)).body;
    const how = await result(b, name, "I compared it with the scan.");
    answers.check = (await act(b, name, 1, "confirm", { post_id: how }, "")).body;
    answers.checked = (await act(owner, name, 1, "confirm", {})).body;
    answers.mailbox = await notices(a);
    const got = normalised(answers);
    if (process.env.WRITE_FIXTURE === "1") writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
    assert.deepEqual(got, JSON.parse(readFileSync(FIXTURE, "utf8")));
    assert.doesNotMatch(JSON.stringify(answers), /"attempts?"|"claimants"/);
  });
});

function refused(out: { status: number; body: any }, status: number, code: string, detail?: string) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
  if (detail !== undefined) assert.equal(out.body.error.detail, detail);
}

/** The owner, a coordinator and six writers of one public work space, two confirmations unless set. */
async function crew(confirmations?: number) {
  const owner = await agent();
  const coordinator = await agent();
  const writers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => agent()));
  const name = await workSpace(owner);
  await grant(owner, name, coordinator, "coordinator");
  for (const w of writers) await grant(owner, name, w, "writer");
  if (confirmations !== undefined) {
    const set = await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: confirmations });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  const [a, b, c, d, e, f] = writers as [Agent, Agent, Agent, Agent, Agent, Agent];
  return { owner, coordinator, a, b, c, d, e, f, name };
}

/** done with post_id, as a writer sends it; the answer is the whole task. */
async function done(who: Agent, name: string, number: number, post: string, fields: Record<string, unknown> = {}) {
  return act(who, name, number, "done", { post_id: post, ...fields });
}

/** A check, confirm or reject, with what else is sent; the answer is the whole task. */
async function check(who: Agent, name: string, number: number, verdict: "confirm" | "reject", fields: Record<string, unknown> = {}) {
  return act(who, name, number, verdict, verdict === "reject" ? { reason: "Line 4 is missing.", ...fields } : fields);
}

/** A claim of task `number` that passed a minute ago. */
async function expire(name: string, number: number) {
  await claimUntil(name, number, "-1 minute");
}

/** Each task notice of a KEY: reason, number, by, attempt and result, in mailbox order. */
async function told(who: Agent) {
  return (await notices(who)).map((i) => [i.reason, i.task.number, i.task.by, i.task.attempt ?? null, i.task.result ?? null]);
}

describe("done is an attempt, by any writer", () => {
  test("a writer that holds nothing finishes an open task in one call", async () => {
    const { owner, b, name } = await crew();
    await added(owner, name);
    const post = await result(b, name);
    const out = await done(b, name, 1, post);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "done");
    assert.equal(out.body.task.claimed_by, b.peerId);
    assert.equal(out.body.task.done_post_id, post);
    assert.equal(out.body.attempt, undefined, "one attempt in the cycle: no attempt named");
    assert.equal(out.body.task.attempts, undefined);
    assert.deepEqual(out.body.task.confirmations, { required: 2, given: [] });
  });

  test("done may name another KEY's post; a hidden, withheld or foreign post is TASK_POST_NOT_FOUND", async () => {
    const { owner, a, b, c, name } = await crew();
    const elsewhere = await workSpace(owner);
    await grant(owner, elsewhere, c, "writer");
    for (let i = 0; i < 4; i++) await added(owner, name);
    const theirs = await result(b, name);
    const out = await done(a, name, 1, theirs);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.done_post_id, theirs);
    assert.equal(out.body.task.claimed_by, a.peerId, "the row names who marked it done");
    assert.deepEqual(await told(b), [["task_attempt", 1, a.peerId, 1, theirs]], "the post's author is told");

    const hidden = await result(c, name);
    assert.equal((await call("PUT", `/v1/posts/${hidden}/hidden`, owner.token)).status, 200);
    refused(await done(a, name, 2, hidden), 422, "TASK_POST_NOT_FOUND");
    const withheld = await result(c, name);
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason)
      select p.post_id, p.space_id, 'malware' from schellingaf.posts p where p.post_id = ${withheld}::uuid`;
    refused(await done(a, name, 3, withheld), 422, "TASK_POST_NOT_FOUND");
    refused(await done(a, name, 4, await result(c, elsewhere)), 422, "TASK_POST_NOT_FOUND");
    // The caller's own post is its own to name, hidden or not, as before.
    const mine = await result(a, name);
    assert.equal((await call("PUT", `/v1/posts/${mine}/hidden`, owner.token)).status, 200);
    assert.equal((await done(a, name, 2, mine)).status, 200);
  });

  test("a done by a KEY that does not hold the task ends the claim and tells its holder", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    const post = await result(b, name);
    const out = await done(b, name, 1, post);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "done");
    assert.equal(out.body.task.claimed_by, b.peerId);
    assert.equal(out.body.task.claimed_until, null);
    assert.deepEqual(await told(a), [["task_attempt", 1, b.peerId, 1, post]]);
    const [item] = await notices(a);
    assert.equal(item.task.state, "done");
    // Its holder's claim is over: progress meets a done task.
    refused(await act(a, name, 1, "progress", { post_id: await result(a, name, "Half way.") }), 409, "TASK_NOT_OPEN", "done");
  });

  test("a second KEY's done is attempt 2; the same KEY again replaces its own, the same post changed false", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    const first = await result(a, name);
    assert.equal((await done(a, name, 1, first)).status, 200);
    const second = await result(b, name, "Page 3, another reading.");
    const out = await done(b, name, 1, second);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.attempt, 2);
    assert.equal(out.body.changed, true);
    const task = out.body.task;
    assert.equal(task.state, "done");
    assert.equal(task.attempt, 1, "the attempt of record is the lowest pending");
    assert.equal(task.claimed_by, a.peerId);
    assert.equal(task.done_post_id, first);
    assert.deepEqual(task.attempts.map((x: any) => [x.attempt, x.by, x.post_id, x.state, x.confirmations]), [
      [1, a.peerId, first, "pending", []],
      [2, b.peerId, second, "pending", []],
    ]);
    const again = await done(b, name, 1, second);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.changed, false);
    assert.equal(again.body.attempt, 2);
    assert.deepEqual(await told(a), [["task_attempt", 1, b.peerId, 2, second]], "the other pending attempt's KEY is told");
    // The short answer names the attempt too.
    const short = await act(b, name, 1, "done", { post_id: second }, "");
    assert.deepEqual(short.body.task, { number: 1, task_id: task.task_id, state: "done" });
    assert.equal(short.body.attempt, 2);
    // a's done again, while its attempt waits, replaces it (migrations/0147_task_corrections.sql).
    const replaced = await done(a, name, 1, await result(a, name, "Again."));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    assert.deepEqual([replaced.body.attempt, replaced.body.replaces], [3, 1]);
  });

  test("two attempts never name one post", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    const post = await result(c, name);
    assert.equal((await done(a, name, 1, post)).status, 200);
    refused(await done(b, name, 1, post), 400, "INVALID_REQUEST", "post_id: attempt 1 names that post");
  });

  test("a post whose author checked in the cycle is never cited: TASK_ALREADY_CHECKED naming the post", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal((await check(c, name, 1, "confirm")).status, 200);
    const cs = await result(c, name, "Page 3, my reading.");
    refused(await done(b, name, 1, cs), 409, "TASK_ALREADY_CHECKED", "post_id: its author checked this task in cycle 0");
  });

  test("the KEY that added a task changes it no more once a KEY made an attempt, though nobody took it", async () => {
    const { a, b, c, name } = await crew();
    await added(a, name);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    assert.equal((await check(c, name, 1, "reject")).body.task.state, "claimed");
    refused(await act(a, name, 1, "change", { revision: 1, reason: "Clearer words.", title: "Transcribe page 3 again" }), 403, "TASK_DENIED");
  });

  test("a give-back is shown no more once an attempt followed it, though a reject reopens the task", async () => {
    const { owner, coordinator, a, b, c, name } = await crew();
    await added(owner, name);
    await next(a, name);
    assert.equal((await act(coordinator, name, 1, "release", { reason: "No progress for a day." })).status, 200);
    assert.equal((await get(name, 1)).released.by, coordinator.peerId);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    assert.equal((await check(c, name, 1, "reject")).body.task.state, "claimed");
    assert.equal((await get(name, 1)).released, undefined);
  });

  test("ten finishers at once: five attempts, numbered 1 to 5, and five TASK_LIMIT", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const keys = await Promise.all(Array.from({ length: 10 }, () => agent()));
    for (const k of keys) await grant(owner, name, k, "writer");
    await added(owner, name);
    const posts = await Promise.all(keys.map((k, i) => result(k, name, `Page 3, reading ${i}.`)));
    const outs = await Promise.all(keys.map((k, i) => done(k, name, 1, posts[i]!)));
    const ok = outs.filter((o) => o.status === 200);
    assert.equal(ok.length, TASK_LIMITS.attempts);
    for (const o of outs.filter((o) => o.status !== 200)) refused(o, 409, "TASK_LIMIT", `attempts: ${TASK_LIMITS.attempts}`);
    const task = await get(name, 1);
    assert.deepEqual(task.attempts.map((x: any) => x.attempt), [1, 2, 3, 4, 5]);
    assert.equal(task.attempt, 1);
  });

  test("a writer that does not hold a task marks it done while its after waits; the task's revision is checked only when sent", async () => {
    const { owner, a, b, name } = await crew();
    const first = await added(owner, name);
    await added(owner, name, { after: [first.task_id] });
    // Recorded, its check waiting (migrations/0147_task_corrections.sql).
    const ahead = await done(b, name, 2, await result(b, name));
    assert.equal(ahead.status, 200, JSON.stringify(ahead.body));
    assert.equal(ahead.body.check_waits_for, 1);
    refused(await done(b, name, 1, await result(b, name), { revision: 2 }), 409, "TASK_CHANGED", "1");
    assert.equal((await done(a, name, 1, await result(a, name), { revision: 1 })).status, 200);
  });

  test("a task with an attempt is never deleted, though nobody took it", async () => {
    const { owner, b, name } = await crew();
    await added(owner, name);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    refused(await act(owner, name, 1, "delete", { reason: "Added by mistake." }), 409, "TASK_TAKEN");
  });

  test("the notices of a first and a later attempt: the holder, the other pending KEYS and the post's author", async () => {
    const { owner, a, b, c, d, name } = await crew();
    await added(owner, name);
    await next(a, name);
    const cs = await result(c, name);
    assert.equal((await done(b, name, 1, cs)).status, 200);
    assert.deepEqual(await told(a), [["task_attempt", 1, b.peerId, 1, cs]], "the holder whose claim it ended");
    assert.deepEqual(await told(c), [["task_attempt", 1, b.peerId, 1, cs]], "the post's author");
    assert.deepEqual(await told(b), [], "never the caller");
    const ds = await result(d, name);
    assert.equal((await done(d, name, 1, ds)).status, 200);
    assert.deepEqual(await told(b), [["task_attempt", 1, d.peerId, 2, ds]], "the other pending attempt's KEY");
    assert.equal((await told(a)).length, 1, "a claim ended once tells its holder once");
    assert.equal((await told(c)).length, 1, "an author is told of its own post only");
    assert.deepEqual(await told(d), []);
  });
});

describe("checks count per attempt", () => {
  /** Task 1 with two attempts: a's, then b's. */
  async function twoAttempts(confirmations?: number) {
    const k = await crew(confirmations);
    await added(k.owner, k.name);
    const first = await result(k.a, k.name);
    const second = await result(k.b, k.name, "Page 3, another reading.");
    assert.equal((await done(k.a, k.name, 1, first)).status, 200);
    assert.equal((await done(k.b, k.name, 1, second)).status, 200);
    return { ...k, first, second };
  }

  test("a check that names no attempt, with two waiting and no offer, is INVALID_REQUEST naming them", async () => {
    const { c, name } = await twoAttempts();
    refused(await check(c, name, 1, "confirm"), 400, "INVALID_REQUEST", "attempt: name the attempt you checked: 1, 2");
    refused(await check(c, name, 1, "confirm", { attempt: 3 }), 404, "TASK_NOT_FOUND", "attempt 3");
    refused(await check(c, name, 1, "confirm", { cycle: 1 }), 400, "INVALID_REQUEST", "cycle: the task is at cycle 0");
    const out = await check(c, name, 1, "confirm", { attempt: 2 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.attempt, 2);
    assert.deepEqual(out.body.task.attempts.map((x: any) => x.confirmations), [[], [c.peerId]]);
    assert.deepEqual(out.body.task.confirmations.given, [], "given counts the attempt of record's");
    refused(await check(c, name, 1, "reject", { attempt: 2 }), 409, "TASK_ALREADY_CHECKED");
    // One check a KEY an attempt: c may check the other.
    assert.equal((await check(c, name, 1, "confirm", { attempt: 1 })).status, 200);
  });

  test("next offers the lowest attempt it may check, says how many wait, and an unnamed check counts on it", async () => {
    const { c, name } = await twoAttempts();
    const offered = await next(c, name, { job: "check" });
    assert.equal(offered.body.job, "check");
    assert.equal(offered.body.attempt, 1);
    assert.equal(offered.body.why, "Task 1 has 2 attempts waiting. Read each result post. Confirm or reject one, and name its attempt. Without one, your check counts on attempt 1.");
    const out = await check(c, name, 1, "confirm");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.attempt, 1);
    assert.deepEqual(out.body.task.confirmations.given, [c.peerId]);
  });

  test("the offered attempt rejected meanwhile: the unnamed check is TASK_NOT_DONE, never counted on attempt 2", async () => {
    const { c, d, name } = await twoAttempts();
    assert.equal((await next(c, name, { job: "check" })).body.attempt, 1);
    assert.equal((await check(d, name, 1, "reject", { attempt: 1 })).status, 200);
    refused(await check(c, name, 1, "confirm"), 409, "TASK_NOT_DONE", `attempt 1: rejected by ${d.peerId}`);
    const task = await get(name, 1);
    assert.deepEqual(task.attempts.map((x: any) => [x.state, x.confirmations]), [["rejected", []], ["pending", []]]);
    assert.deepEqual((await told(c)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, d.peerId, 1, null]]);
    // The offer is spent: the retry counts on the one attempt that waits.
    const retry = await check(c, name, 1, "confirm");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body.task.confirmations.given, [c.peerId]);
    assert.equal(retry.body.task.attempt, 2);
  });

  test("the first attempt confirmed enough is accepted, and the other reads passed", async () => {
    const { b, c, d, name, second } = await twoAttempts();
    const doneAt = (await get(name, 1)).done_at;
    assert.equal((await check(c, name, 1, "confirm", { attempt: 2 })).status, 200);
    const out = await check(d, name, 1, "confirm", { attempt: 2 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const task = out.body.task;
    assert.equal(task.state, "accepted");
    assert.equal(task.attempt, 2);
    assert.equal(task.claimed_by, b.peerId);
    assert.equal(task.done_post_id, second);
    assert.equal(task.done_at, doneAt, "done_at is the cycle's first attempt's");
    assert.deepEqual(task.confirmations, { required: 2, given: [c.peerId, d.peerId] });
    assert.deepEqual(task.attempts.map((x: any) => x.state), ["passed", "accepted"]);
    assert.deepEqual((await told(b)).map((t) => t[0]), ["task_confirmed", "task_accepted"]);
  });

  test("two confirms completing different attempts at once: the first accepts, the second meets TASK_NOT_DONE accepted", async () => {
    for (let round = 0; round < 3; round++) {
      const { c, d, name } = await twoAttempts(1);
      const outs = await Promise.all([check(c, name, 1, "confirm", { attempt: 1 }), check(d, name, 1, "confirm", { attempt: 2 })]);
      const ok = outs.filter((o) => o.status === 200);
      assert.equal(ok.length, 1, JSON.stringify(outs.map((o) => o.body)));
      refused(outs.find((o) => o.status !== 200)!, 409, "TASK_NOT_DONE", "accepted");
      assert.equal((await get(name, 1)).state, "accepted");
    }
  });

  test("a reject with another attempt waiting moves the attempt of record and keeps done_at", async () => {
    const { a, b, c, name, second } = await twoAttempts();
    const doneAt = (await get(name, 1)).done_at;
    const out = await check(c, name, 1, "reject", { attempt: 1 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const task = out.body.task;
    assert.equal(task.state, "done");
    assert.equal(task.cycle, 0);
    assert.equal(task.attempt, 2);
    assert.equal(task.claimed_by, b.peerId);
    assert.equal(task.done_post_id, second);
    assert.equal(task.done_at, doneAt);
    assert.equal(task.attempts[0].rejected.by, c.peerId);
    assert.equal(task.attempts[0].rejected.reason, "Line 4 is missing.");
    assert.deepEqual((await told(a)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, c.peerId, 1, null]]);
  });

  test("the last reject reopens the task, naming the result it rejected and the confirmations it cleared", async () => {
    const { a, b, c, d, e, f, name, first } = await twoAttempts();
    assert.equal((await check(d, name, 1, "confirm", { attempt: 1 })).status, 200);
    // f's confirmation of attempt 2 is not one this reject clears.
    assert.equal((await check(f, name, 1, "confirm", { attempt: 2 })).status, 200);
    assert.equal((await check(c, name, 1, "reject", { attempt: 2 })).status, 200);
    const out = await check(e, name, 1, "reject", { attempt: 1, reason: "Wrong page." });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const task = out.body.task;
    // Held again by both KEYS whose attempts were rejected (migrations/0147_task_corrections.sql).
    assert.equal(task.state, "claimed");
    assert.equal(task.cycle, 1);
    assert.equal(task.attempt, undefined);
    assert.deepEqual(task.claimants.map((x: any) => x.by).sort(), [a.peerId, b.peerId].sort());
    assert.deepEqual(task.rejected, { by: e.peerId, reason: "Wrong page.", at: task.rejected.at, result: first, cleared: [d.peerId], attempt: 1 });
    assert.deepEqual(task.confirmations, { required: 2, given: [] });
    // Its submitter and the confirmer it cleared are told, with the attempt.
    assert.deepEqual((await told(d)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, e.peerId, 1, null]]);
    assert.deepEqual((await told(a)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, e.peerId, 1, null]]);
    assert.deepEqual((await told(b)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, c.peerId, 2, null]]);
    // The mailbox gives each reject its own attempt's reason.
    const reasons = (await notices(d)).filter((i) => i.reason === "task_rejected").map((i) => i.task.reason);
    assert.deepEqual(reasons, ["Wrong page."]);
    const bs = (await notices(b)).filter((i) => i.reason === "task_rejected").map((i) => i.task.reason);
    assert.deepEqual(bs, ["Line 4 is missing."]);
  });

  test("a single result rejected reopens as before, with cleared empty and no attempt named", async () => {
    const { owner, a, c, name } = await crew();
    await added(owner, name);
    const post = await result(a, name);
    assert.equal((await done(a, name, 1, post)).status, 200);
    const out = await check(c, name, 1, "reject");
    assert.deepEqual(out.body.task.rejected, { by: c.peerId, reason: "Line 4 is missing.", at: out.body.task.rejected.at, result: post, cleared: [] });
  });

  test("a reject tells the author of the post its attempt cited", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    const bs = await result(b, name);
    assert.equal((await done(a, name, 1, bs)).status, 200);
    assert.equal((await check(c, name, 1, "reject")).status, 200);
    assert.deepEqual((await told(b)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, c.peerId, null, null]]);
  });

  test("retire of a done task tells the KEY of a pending attempt that is not the attempt of record", async () => {
    const { owner, b, name } = await twoAttempts();
    assert.equal((await act(owner, name, 1, "retire", { reason: "Settled elsewhere." })).status, 200);
    assert.equal((await told(b)).filter((t) => t[0] === "task_retired").length, 1);
  });

  test("next hands out an attempt while that attempt's confirmations are below the count, whatever a rejected attempt had", async () => {
    const { c, d, e, f, name } = await twoAttempts();
    assert.equal((await check(c, name, 1, "confirm", { attempt: 1 })).status, 200);
    assert.equal((await check(d, name, 1, "reject", { attempt: 1 })).status, 200);
    assert.equal((await check(e, name, 1, "confirm", { attempt: 2 })).status, 200);
    // Step 6, a check when idle, and step 2, a check that waited: both under the cap.
    const idle = await next(f, name);
    assert.equal(idle.body.job, "check", JSON.stringify(idle.body));
    assert.equal(idle.body.why, "No open task for you. Task 1 waits for a check.");
    await fixture.owner`
      update schellingaf.tasks t set done_at = done_at - interval '61 minutes'
        from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name}`;
    await followDoneAt(name);
    const first = await next(f, name);
    assert.equal(first.body.job, "check", JSON.stringify(first.body));
    assert.match(first.body.why, /^Task 1 has waited \d+ minutes for a check\.$/);
  });

  test("a doer checks no attempt of its cycle, and a checker makes none; raced, one of the two lands", async () => {
    const { a, c, name } = await twoAttempts();
    refused(await check(a, name, 1, "confirm", { attempt: 2 }), 409, "TASK_SELF_CHECK", "attempt 1");
    refused(await check(a, name, 1, "confirm", { attempt: 1 }), 409, "TASK_SELF_CHECK", "attempt 1");
    assert.equal((await check(c, name, 1, "confirm", { attempt: 1 })).status, 200);
    refused(await done(c, name, 1, await result(c, name)), 409, "TASK_ALREADY_CHECKED", "attempt: you checked this task in cycle 0");
    for (let round = 0; round < 4; round++) {
      const k = await crew();
      await added(k.owner, k.name);
      assert.equal((await done(k.a, k.name, 1, await result(k.a, k.name))).status, 200);
      const post = await result(k.c, k.name);
      const [checked, tried] = await Promise.all([check(k.c, k.name, 1, "confirm"), done(k.c, k.name, 1, post)]);
      if (checked.status === 200) refused(tried, 409, "TASK_ALREADY_CHECKED", "attempt: you checked this task in cycle 0");
      else {
        assert.equal(tried.status, 200, JSON.stringify(tried.body));
        refused(checked, 400, "INVALID_REQUEST", "attempt: name the attempt you checked: 1, 2");
        refused(await check(k.c, k.name, 1, "confirm", { attempt: 1 }), 409, "TASK_SELF_CHECK", "attempt 2");
      }
    }
  });

  test("a check against a second attempt: check first counts on attempt 1; attempt first, the unnamed check names them", async () => {
    for (let round = 0; round < 4; round++) {
      const k = await crew();
      await added(k.owner, k.name);
      assert.equal((await done(k.a, k.name, 1, await result(k.a, k.name))).status, 200);
      const post = await result(k.b, k.name);
      const [checked, tried] = await Promise.all([check(k.c, k.name, 1, "confirm"), done(k.b, k.name, 1, post)]);
      assert.equal(tried.status, 200, JSON.stringify(tried.body));
      if (checked.status === 200) assert.deepEqual((await get(k.name, 1)).attempts[0].confirmations, [k.c.peerId]);
      else refused(checked, 400, "INVALID_REQUEST", "attempt: name the attempt you checked: 1, 2");
    }
  });

  test("a cited post's author checks no attempt that names its post, and may check another", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    const as = await result(a, name);
    assert.equal((await done(b, name, 1, as)).status, 200);
    assert.equal((await done(c, name, 1, await result(c, name))).status, 200);
    // next offers a the attempt it may check, never the one that names its post.
    const offered = await next(a, name, { job: "check" });
    assert.equal(offered.body.attempt, 2, JSON.stringify(offered.body));
    refused(await check(a, name, 1, "confirm", { attempt: 1 }), 409, "TASK_SELF_CHECK", "attempt 1");
    assert.equal((await check(a, name, 1, "confirm", { attempt: 2 })).status, 200);
    void owner;
  });

  test("a check of a named attempt already rejected is TASK_NOT_DONE naming its rejecter", async () => {
    const { c, d, name } = await twoAttempts();
    assert.equal((await check(c, name, 1, "reject", { attempt: 1 })).status, 200);
    refused(await check(d, name, 1, "confirm", { attempt: 1 }), 409, "TASK_NOT_DONE", `attempt 1: rejected by ${c.peerId}`);
    assert.deepEqual((await told(d)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, c.peerId, 1, null]]);
  });

  test("a result sent again after a reject set it aside is TASK_NOT_DONE naming the rejecter", async () => {
    const { owner, a, c, name } = await crew();
    await added(owner, name);
    const post = await result(a, name);
    assert.equal((await done(a, name, 1, post)).status, 200);
    assert.equal((await check(c, name, 1, "reject")).status, 200);
    refused(await done(a, name, 1, post), 409, "TASK_NOT_DONE", `attempt 1: rejected by ${c.peerId}`);
    assert.equal((await done(a, name, 1, await result(a, name, "Page 3, line 4 too."))).status, 200);
  });

  test("retire tells every pending attempt's KEY and the KEYS that confirmed one", async () => {
    const { owner, a, b, c, d, name } = await twoAttempts();
    assert.equal((await check(c, name, 1, "confirm", { attempt: 1 })).status, 200);
    assert.equal((await check(d, name, 1, "reject", { attempt: 2 })).status, 200);
    assert.equal((await act(owner, name, 1, "retire", { reason: "Settled elsewhere." })).status, 200);
    for (const [who, expected] of [[a, 1], [c, 1], [b, 0], [d, 0]] as const) {
      assert.equal((await told(who)).filter((t) => t[0] === "task_retired").length, expected, who.peerId);
    }
  });
});

describe("the cycle a check reads", () => {
  test("a late confirm with a live offer of an earlier cycle is refused, delivered once, its offer dropped, and the retry counts", async () => {
    const { owner, a, b, c, d, name } = await crew(1);
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal((await next(c, name, { job: "check" })).body.task.number, 1);
    assert.equal((await check(d, name, 1, "reject")).status, 200);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    refused(await check(c, name, 1, "confirm"), 409, "TASK_NOT_DONE", `done: rejected by ${d.peerId}`);
    refused(await check(c, name, 1, "confirm", { cycle: 0 }), 409, "TASK_NOT_DONE", `done: rejected by ${d.peerId}`);
    assert.deepEqual((await told(c)).filter((t) => t[0] === "task_rejected"), [["task_rejected", 1, d.peerId, null, null]], "delivered once");
    const retry = await check(c, name, 1, "confirm");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.task.state, "accepted");
    assert.equal(retry.body.task.cycle, 1);
  });

  test("a second rejected attempt's late notice reaches a KEY told of the first", async () => {
    const { owner, a, b, c, d, e, name } = await crew();
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    assert.equal((await check(c, name, 1, "confirm", { attempt: 1 })).status, 200);
    assert.equal((await check(d, name, 1, "reject", { attempt: 1 })).status, 200);
    assert.equal((await check(e, name, 1, "reject", { attempt: 2 })).status, 200);
    refused(await check(c, name, 1, "confirm", { attempt: 2 }), 409, "TASK_NOT_DONE", `claimed: rejected by ${e.peerId}`);
    assert.deepEqual((await told(c)).filter((t) => t[0] === "task_rejected"), [
      ["task_rejected", 1, d.peerId, 1, null],
      ["task_rejected", 1, e.peerId, 2, null],
    ]);
  });
});

describe("where the SPACE asks for no confirmation", () => {
  test("an attempt alone is accepted at once", async () => {
    const { owner, b, name } = await crew(0);
    await added(owner, name);
    const out = await done(b, name, 1, await result(b, name));
    assert.equal(out.body.task.state, "accepted");
  });

  test("with another KEY's live claim it waits for one confirmation by a KEY that made no attempt", async () => {
    const { owner, a, b, name } = await crew(0);
    await added(owner, name);
    await next(a, name);
    const out = await done(b, name, 1, await result(b, name));
    assert.equal(out.body.task.state, "done");
    assert.deepEqual(out.body.task.confirmations, { required: 1, given: [] });
    const confirmed = await check(a, name, 1, "confirm");
    assert.equal(confirmed.body.task.state, "accepted", JSON.stringify(confirmed.body));
  });

  test("with only a claim that passed it is accepted at once", async () => {
    const { owner, a, b, name } = await crew(0);
    await added(owner, name);
    await next(a, name);
    await expire(name, 1);
    assert.equal((await done(b, name, 1, await result(b, name))).body.task.state, "accepted");
  });

  test("by a KEY under its own give-back lock it waits", async () => {
    const { owner, coordinator, a, name } = await crew(0);
    await added(owner, name);
    await next(a, name);
    assert.equal((await act(coordinator, name, 1, "release", { reason: "No progress for a day." })).status, 200);
    const out = await done(coordinator, name, 1, await result(coordinator, name));
    assert.equal(out.body.task.state, "done");
  });

  test("in a later cycle it waits", async () => {
    const { owner, a, b, c, name } = await crew(0);
    await added(owner, name);
    await next(a, name);
    assert.equal((await done(b, name, 1, await result(b, name))).body.task.state, "done");
    assert.equal((await check(c, name, 1, "reject")).body.task.state, "claimed");
    const out = await done(b, name, 1, await result(b, name, "Page 3 again."));
    assert.equal(out.body.task.state, "done");
    assert.equal(out.body.task.cycle, 1);
  });

  test("two doers: one confirms the other's attempt, which is accepted; a doer's reject is TASK_SELF_CHECK", async () => {
    const { owner, a, b, name } = await crew(0);
    await added(owner, name);
    await next(a, name);
    const bs = await result(b, name);
    assert.equal((await done(b, name, 1, bs)).body.task.state, "done");
    const as = await result(a, name, "Page 3, my reading.");
    assert.equal((await done(a, name, 1, as)).body.attempt, 2);
    refused(await check(b, name, 1, "reject", { attempt: 2 }), 409, "TASK_SELF_CHECK", "attempt 1");
    // next never offers a doer the other's attempt.
    assert.equal((await next(b, name, { job: "check" })).body.job, "stop");
    const conceded = await check(b, name, 1, "confirm", { attempt: 2 });
    assert.equal(conceded.status, 200, JSON.stringify(conceded.body));
    assert.equal(conceded.body.task.state, "accepted");
    assert.equal(conceded.body.task.done_post_id, as);
    assert.equal(conceded.body.task.claimed_by, a.peerId);
  });
});

describe("races", () => {
  test("an attempt against its holder's renewal and progress: either order leaves one done task", async () => {
    for (let round = 0; round < 10; round++) {
      const { owner, a, b, name } = await crew();
      await added(owner, name);
      await next(a, name);
      const post = await result(b, name);
      const progress = await result(a, name, "Half way.");
      const [renewed, tried, linked] = await Promise.all([
        next(a, name, { job: "work" }), done(b, name, 1, post), act(a, name, 1, "progress", { post_id: progress }),
      ]);
      assert.equal(tried.status, 200, JSON.stringify(tried.body));
      assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
      if (renewed.body.renewed !== true) assert.equal(renewed.body.job, "stop");
      if (linked.status !== 200) refused(linked, 409, "TASK_NOT_OPEN", "done");
      const task = await get(name, 1);
      assert.equal(task.state, "done");
      assert.equal(task.claimed_by, b.peerId);
    }
  });

  test("a reject against a new attempt: reject first, the attempt lands in the next cycle; attempt first, the task stays done", async () => {
    for (let round = 0; round < 4; round++) {
      const { owner, a, b, c, name } = await crew();
      await added(owner, name);
      assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
      const post = await result(b, name);
      const [rejected, tried] = await Promise.all([check(c, name, 1, "reject", { attempt: 1 }), done(b, name, 1, post)]);
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(tried.status, 200, JSON.stringify(tried.body));
      const task = await get(name, 1);
      assert.equal(task.state, "done");
      assert.equal(task.done_post_id, post);
      assert.ok(task.cycle === 1 ? task.attempts === undefined : task.attempt === 2, JSON.stringify(task));
    }
  });
});

describe("the functions callers of the release before still call", () => {
  test("task_done with four and five arguments, task_check with seven, deliver_task_notices with six and both next_job forms resolve", async () => {
    const { owner, a, b, c, name } = await crew();
    for (let i = 0; i < 3; i++) await added(owner, name);
    const id = (who: Agent) => Buffer.from(who.peerId, "hex");
    await next(a, name);
    const four = await fixture.owner<{ out: any }[]>`select schellingaf.task_done(${name}, ${id(a)}, 1, ${await result(a, name)}::uuid) as out`;
    assert.equal(four[0]!.out.task.state, "done");
    assert.equal(four[0]!.out.delivered, undefined, "no deliveries answered to an older caller");
    const five = await fixture.owner<{ out: any }[]>`select schellingaf.task_done(${name}, ${id(b)}, 2, ${await result(b, name)}::uuid, null::int) as out`;
    assert.equal(five[0]!.out.task.state, "done");
    const seven = await fixture.owner<{ out: any }[]>`
      select schellingaf.task_check(${name}, ${id(c)}, 1, 'confirm', null::uuid, null::text, true) as out`;
    assert.equal(seven[0]!.out.task.state, "done");
    const [space] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
    const six = await fixture.owner<{ out: unknown }[]>`
      select schellingaf.deliver_task_notices(${space!.id}::uuid, (select task_id from schellingaf.tasks where space_id = ${space!.id}::uuid and number = 1),
                                              0, ${id(c)}, '{}'::bytea[], '{}'::text[]) as out`;
    assert.deepEqual(six[0]!.out, []);
    const nine = await fixture.owner<{ out: any }[]>`select schellingaf.next_job(${name}, ${id(c)}, 'work') as out`;
    assert.equal(nine[0]!.out.job, "work");
    const twelve = await fixture.owner<{ out: any }[]>`
      select schellingaf.next_job(${name}, ${id(owner)}, 'any', null, null, null::jsonb, 3, 60, 30, 10000, 2, 4) as out`;
    assert.ok(["check", "stop", "work"].includes(twelve[0]!.out.job));
  });
});

describe("the backfill", () => {
  test("on a database with rows: attempt 1 for each result on record that is not upkeep, its checks of the cycle, and the mirror whole", async () => {
    // As the runner applies the file: every file before it, then rows made by the functions
    // of the release before, then the file, each in a transaction of its own.
    const name = `schellingaf_t_attempts_backfill_${process.pid}`;
    const admin = postgres(SUPERUSER);
    await admin.unsafe(`create database ${name} owner schellingaf_owner`);
    const owner = postgres({ host: "127.0.0.1", port: PORT, database: name, username: "schellingaf_migrate", password: MIGRATE_PASSWORD, max: 1, onnotice: () => {} });
    try {
      await owner`set role schellingaf_owner`;
      await owner`create schema schellingaf`;
      await owner`create table schellingaf.schema_migrations (version int primary key, name text not null, sha256 text not null, applied_at timestamptz not null default now())`;
      const dir = new URL("../migrations/", import.meta.url);
      const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      // A file whose first line says so is sent a statement at a time, outside a
      // transaction, as src/db/migrate.ts sends it.
      const apply = async (file: string) => {
        const text = readFileSync(new URL(file, dir), "utf8");
        if (text.startsWith("-- migrate: no-transaction")) {
          for (const statement of statementsOf(text)) await owner.unsafe(statement);
          return;
        }
        await owner.unsafe("begin");
        await owner.unsafe(text);
        await owner.unsafe("commit");
      };
      for (const file of files.filter((f) => f < "0140")) await apply(file);
      const [boss, doer, checker, other] = await Promise.all(["bf-owner", "bf-doer", "bf-checker", "bf-other"].map(async (who) =>
        (await owner<{ id: Buffer }[]>`select schellingaf.register_peer(${publicKey(`${who}-${process.pid}`)}) as id`)[0]!.id));
      await owner`select schellingaf.create_space(${boss!}, 'backfill-space', 'B', '', 'request', 'public')`;
      for (const k of [doer!, checker!, other!]) {
        await owner`
          insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
          select s.space_id, ${k}, 'writer', 'grant', s.owner_id, 1 from schellingaf.spaces s where s.name = 'backfill-space'`;
      }
      const post = async (body: string) => (await owner<{ receipt: { post_id: string } }[]>`
        select schellingaf.append_post('backfill-space', ${doer!}, 'result', 'A result', ${body}, null, null,
                                        '{}'::bytea[], null, null, null, null, '[]'::jsonb, null) as receipt`)[0]!.receipt.post_id;
      for (let i = 1; i <= 4; i++) await owner`select schellingaf.add_task('backfill-space', ${boss!}, ${`Task ${i}`}, '', null, '{}'::uuid[])`;
      const take = (n: number) => owner`select schellingaf.take_task('backfill-space', ${doer!}, ${n})`;
      const finish = async (n: number) => owner`select schellingaf.task_done('backfill-space', ${doer!}, ${n}, ${await post(`Result ${n}`)}::uuid)`;
      // 1: accepted, with two confirmations. 2: retired after done. 3: a claim that passed.
      await take(1); await finish(1);
      await owner`select schellingaf.task_check('backfill-space', ${checker!}, 1, 'confirm')`;
      await owner`select schellingaf.task_check('backfill-space', ${other!}, 1, 'confirm')`;
      await take(2); await finish(2);
      await owner`select schellingaf.retire_task('backfill-space', ${boss!}, 2, 'Settled elsewhere.')`;
      await take(3);
      await owner`update schellingaf.tasks set claimed_until = now() - interval '1 hour' where number = 3`;
      // 4: rejected in cycle 0, done again in cycle 1 and confirmed once there.
      await take(4); await finish(4);
      await owner`select schellingaf.task_check('backfill-space', ${checker!}, 4, 'reject', null, 'Wrong page.')`;
      await take(4); await finish(4);
      await owner`select schellingaf.task_check('backfill-space', ${other!}, 4, 'confirm')`;
      // 5: an accepted upkeep task, its result kept on the row.
      const upkeepPost = await post("A decision.");
      await owner`
        insert into schellingaf.tasks (space_id, number, title, upkeep, state, claimed_by, done_post_id, done_at, accepted_at,
                                       claimed_at, claim_revision, takes)
        select s.space_id, 5, 'Upkeep: review the task list', 'tasks', 'accepted', ${doer!}, ${upkeepPost}::uuid, now(), now(),
               now(), 1, 1
          from schellingaf.spaces s where s.name = 'backfill-space'`;

      await apply("0140_task_attempts.sql");
      const tasks = await owner<{ number: number; attempts: number; attempt: number | null }[]>`
        select number, attempts, attempt from schellingaf.tasks order by number`;
      assert.deepEqual(tasks.map((t) => [t.number, t.attempts, t.attempt]), [[1, 1, 1], [2, 1, 1], [3, 0, null], [4, 1, 1], [5, 0, null]]);
      const attempts = await owner<{ number: number; attempt: number; cycle: number; same: boolean }[]>`
        select t.number, a.attempt, a.cycle,
               a.peer_id = t.claimed_by and a.post_id = t.done_post_id and a.author_id = ${doer!} and a.at = t.done_at as same
          from schellingaf.task_attempts a join schellingaf.tasks t on t.task_id = a.task_id order by t.number`;
      assert.deepEqual(attempts.map((a) => [a.number, a.attempt, a.cycle, a.same]), [[1, 1, 0, true], [2, 1, 0, true], [4, 1, 1, true]]);
      const checks = await owner<{ number: number; cycle: number; verdict: string; attempt: number | null }[]>`
        select t.number, c.cycle, c.verdict, c.attempt
          from schellingaf.task_checks c join schellingaf.tasks t on t.task_id = c.task_id order by t.number, c.cycle, c.verdict`;
      assert.deepEqual(checks.map((c) => [c.number, c.cycle, c.verdict, c.attempt]), [
        [1, 0, "confirm", 1], [1, 0, "confirm", 1], [4, 0, "reject", null], [4, 1, "confirm", 1],
      ]);
      const faults = await owner<{ f: string }[]>`
        select f from schellingaf.spaces s cross join lateral schellingaf.task_mirror_faults(s.space_id) as f where s.name = 'backfill-space'`;
      assert.deepEqual(faults.map((r) => r.f), []);
      // The guard on the checks holds again after the file.
      await assert.rejects(owner`update schellingaf.task_checks set reason = 'changed'`);
    } finally {
      await owner.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    }
  });
});

describe("a finding that is an attempt's post", () => {
  test("names its task, its attempt and its own confirmers, the attempt of record and the other alike", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    const findingOf = async (who: Agent, claim: string) => {
      const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
        kind: "finding", title: claim, body: "Read against the scan.", data: { claim, status: "proposed", confidence: "medium" },
      });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      return out.body.post_id as string;
    };
    const first = await findingOf(a, "Page 3 reads one way");
    const second = await findingOf(b, "Page 3 reads another way");
    assert.equal((await done(a, name, 1, first)).status, 200);
    assert.equal((await done(b, name, 1, second)).status, 200);
    assert.equal((await check(c, name, 1, "confirm", { attempt: 2 })).status, 200);
    const items = (await call("GET", `/v1/spaces/${name}/findings`)).body.items as any[];
    const taskOf = (id: string) => items.find((f) => f.post_id === id).task;
    assert.deepEqual(taskOf(second), { number: 1, state: "done", confirmed_by: [c.peerId], rejected_by: [], attempt: 2 });
    assert.deepEqual(taskOf(first), { number: 1, state: "done", confirmed_by: [], rejected_by: [], attempt: 1 });
    assert.deepEqual((await call("GET", `/v1/posts/${second}/finding`)).body.finding.task, taskOf(second));
  });
});
