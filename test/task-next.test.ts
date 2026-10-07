// next answers a job: migrations/0133_task_next_job.sql holds every rule (the order for
// job any, the offer cap, the offers a KEY's next next drops, why from NEXT_WORDS). These
// drive them through the route and the connector, as an agent would, and read the database
// only to set a scene a route cannot, such as a done task an hour old.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { useService, app, db, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import { claimUntil, claimFor, claimsFromRows } from "./lib/claims.ts";
import { followDoneAt, mirrorChecked } from "./lib/mirror.ts";
import { SUPERUSER } from "./bootstrap.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";
import { TASK_JOBS, TASK_LIMITS } from "../src/surface/vocabulary.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { API_CHANGES, API_VERSION } from "../src/config.ts";
import { prune } from "../src/db/prune.ts";
import { renderTask } from "../src/mcp/render.ts";
import { TEST_TITLE } from "./helpers.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  // Ten KEYS asking for work at once queue at the global gate, which refuses one that
  // waits past a second on a busy machine.
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_next", { apiHost: "api.task-next.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;
async function workSpace(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `next-${process.pid}-${n++}`;
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

/** next, answered 200. */
async function job(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  const out = await next(who, name, fields);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body as Record<string, any>;
}

async function act(who: Agent, name: string, number: number, action: string, fields: Record<string, unknown> = {}) {
  return call("POST", `/v1/spaces/${name}/tasks/${number}/${action}?detail=full`, who.token, fields);
}

async function result(who: Agent, name: string) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind: "result", body: "Page 3, transcribed.", fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

function refused(out: { status: number; body: any }, status: number, code: string, detail?: string | RegExp) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
  if (typeof detail === "string") assert.equal(out.body.error.detail, detail);
  else if (detail) assert.match(out.body.error.detail, detail);
}

/** A sentence of NEXT_WORDS with its numbers put in. */
function why(key: keyof typeof NEXT_WORDS.why, values: Record<string, number> = {}): string {
  return Object.entries(values).reduce<string>((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), NEXT_WORDS.why[key]);
}

/** A scene a route cannot make: task `number` was done `minutes` ago. */
async function doneAgo(name: string, number: number, minutes: number) {
  await fixture.owner`
    update schellingaf.tasks t set done_at = now() - make_interval(mins => ${minutes})
      from schellingaf.spaces s
     where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
  await followDoneAt(name);
}

/** Task `number`, taken and done by `who` with a result of its own. */
async function did(who: Agent, name: string, number: number) {
  const taken = await job(who, name, { number });
  assert.equal(taken.task.number, number);
  const out = await act(who, name, number, "done", { post_id: await result(who, name) });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/** Owner, a doer and two more writers of one public work space, which asks 2 confirmations. */
async function crew(extra: Record<string, unknown> = {}) {
  const owner = await agent();
  const doer = await agent();
  const a = await agent();
  const b = await agent();
  const name = await workSpace(owner, extra);
  for (const k of [doer, a, b]) await grant(owner, name, k, "writer");
  return { owner, doer, a, b, name };
}

describe("next hands out checks of attempts (migrations/0140_task_attempts.sql)", () => {
  test("it passes over a done task the caller made an attempt at, offers one whose other attempt's post it wrote, and records the attempt offered", async () => {
    const { owner, doer, a, b, name } = await crew();
    await added(owner, name);
    await added(owner, name);
    // Task 1: the doer's attempt, then a's. Task 2: an attempt by b with a's post, then the owner's.
    await did(doer, name, 1);
    assert.equal((await act(a, name, 1, "done", { post_id: await result(a, name) })).status, 200);
    assert.equal((await act(b, name, 2, "done", { post_id: await result(a, name) })).status, 200);
    assert.equal((await act(owner, name, 2, "done", { post_id: await result(owner, name) })).status, 200);
    // a made an attempt at task 1, so it is passed over; at task 2 it wrote attempt 1's post,
    // so it is offered attempt 2.
    const offered = await job(a, name, { job: "check" });
    assert.equal(offered.task.number, 2);
    assert.equal(offered.attempt, 2);
    assert.equal(offered.why, why("check_attempts", { number: 2, attempts: 2, attempt: 2 }));
    const [row] = await fixture.owner<{ cycle: number; attempt: number | null }[]>`
      select o.cycle, o.attempt from schellingaf.task_check_offers o
        join schellingaf.tasks t on t.task_id = o.task_id join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.number = 2 and o.peer_id = ${Buffer.from(a.peerId, "hex")}`;
    assert.deepEqual(row, { cycle: 0, attempt: 2 });
    // The doer of task 1 is offered task 2's lowest attempt, and nothing of task 1.
    assert.equal((await job(doer, name, { job: "check" })).task.number, 2);
    // With one attempt left to check, why is the old sentence and no attempt is answered.
    assert.equal((await act(doer, name, 2, "reject", { attempt: 1, reason: "Not page 3." })).status, 200);
    const last = await job(doer, name, { job: "check" });
    assert.equal(last.task.number, 2);
    assert.equal(last.attempt, undefined);
    assert.equal(last.why, why("check_asked", { number: 2 }));
  });
});

describe("next with job any", () => {
  test("a check that waited an hour comes before new work, oldest done first, and claims nothing", async () => {
    const { owner, doer, a, name } = await crew();
    for (let i = 0; i < 4; i++) await added(owner, name, { title: `Page ${i + 1}` });
    await did(doer, name, 1);
    await did(doer, name, 2);
    await doneAgo(name, 1, 61);
    await doneAgo(name, 2, 90);
    const out = await job(a, name);
    assert.equal(out.job, "check");
    assert.equal(out.task.number, 2, "the oldest done first, not the lowest number");
    assert.equal(out.why, why("check_first", { number: 2, minutes: 90 }));
    assert.equal(out.verify, true);
    assert.equal(out.renewed, false);
    assert.equal(out.task.state, "done");
    assert.equal(out.task.claimed_by, doer.peerId, "a check claims nothing");
  });

  test("a check that waited less than an hour waits behind open work, then comes when no work is left", async () => {
    const { owner, doer, a, b, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    await did(doer, name, 1);
    await doneAgo(name, 1, TASK_LIMITS.checkFirstMinutes - 1);
    const work = await job(a, name);
    assert.equal(work.job, "work");
    assert.equal(work.task.number, 2);
    assert.equal(work.why, why("work", { number: 2 }));
    assert.equal(work.verify, false);
    assert.equal(work.task.claimed_by, a.peerId);
    const idle = await job(b, name);
    assert.equal(idle.job, "check");
    assert.equal(idle.task.number, 1);
    assert.equal(idle.why, why("check_idle", { number: 1 }));
  });

  test("a task the caller holds is renewed before any check", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    await did(doer, name, 1);
    await doneAgo(name, 1, 120);
    await job(a, name, { job: "work" });
    const again = await job(a, name);
    assert.equal(again.job, "work");
    assert.equal(again.renewed, true);
    assert.equal(again.task.number, 2);
    assert.equal(again.why, why("renewed", { number: 2 }));
    // Changed after the take: the renewal says so, and from which revision to which.
    const changed = await act(owner, name, 2, "change", { revision: 1, reason: "Page 4 has two columns.", body: "Both columns." });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const moved = await job(a, name);
    assert.deepEqual(moved.changed_since_claim, { from: 1, to: 2 });
    assert.equal(moved.why, why("renewed_changed", { number: 2, from: 1, to: 2 }));
  });

  test("stop says whether every open task waits for another", async () => {
    const { owner, a, name } = await crew();
    const none = await job(a, name);
    assert.equal(none.job, "stop");
    assert.equal(none.task, null);
    assert.equal(none.why, NEXT_WORDS.why.stop);
    assert.equal(none.verify, false);
    const first = await added(owner, name);
    await added(owner, name, { title: "Decode page 1", after: [first.task_id] });
    await job(owner, name, { job: "work" });
    const waiting = await job(a, name);
    assert.equal(waiting.job, "stop");
    assert.equal(waiting.why, NEXT_WORDS.why.stop_waiting);
  });

  test("the KEY that did a task, and one that checked it, are never sent to check it", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    assert.equal((await job(doer, name)).job, "stop");
    assert.equal((await job(a, name)).job, "check");
    assert.equal((await act(a, name, 1, "confirm")).status, 200);
    assert.equal((await job(a, name)).job, "stop");
  });

  test("where only coordinators check, a writer is passed over for checks and is not refused", async () => {
    const { owner, doer, a, name } = await crew();
    const patch = await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmers: "coordinators" });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    await added(owner, name);
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    const out = await job(a, name);
    assert.equal(out.job, "stop");
    refused(await next(a, name, { job: "check" }), 403, "TASK_DENIED");
    assert.equal((await job(owner, name)).job, "check");
  });
});

describe("next with one job", () => {
  test("job work never hands out a check: it answers as 0.3 did, with job and why", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    const work = await job(a, name, { job: "work" });
    assert.equal(work.job, "work");
    assert.equal(work.task.number, 2);
    const stop = await job(owner, name, { job: "work" });
    assert.equal(stop.job, "stop", "a check waits, and job work takes none");
    assert.equal(stop.task, null);
    assert.equal(stop.why, NEXT_WORDS.why.stop);
  });

  test("job check and verify true are one job: the lowest-numbered done task, with no cap", async () => {
    const { owner, doer, a, b, name } = await crew();
    const c = await agent();
    await grant(owner, name, c, "writer");
    for (let i = 0; i < 3; i++) await added(owner, name, { title: `Page ${i + 1}` });
    await did(doer, name, 2);
    await did(doer, name, 3);
    await doneAgo(name, 3, 300);
    const answers = [await job(a, name, { job: "check" }), await job(b, name, { verify: true }), await job(c, name, { job: "check", verify: true })];
    for (const out of answers) {
      assert.equal(out.job, "check");
      assert.equal(out.task.number, 2, "the lowest number, whatever waited longest");
      assert.equal(out.verify, true);
      assert.equal(out.why, why("check_asked", { number: 2 }));
    }
    const none = await job(doer, name, { job: "check" });
    assert.equal(none.job, "stop");
    assert.equal(none.task, null);
    assert.equal(none.verify, true, "verify answers as 0.3 did: a check was asked");
    assert.equal(none.why, NEXT_WORDS.why.stop_check);
  });

  test("job upkeep stops while no upkeep is due, and takes no tag", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name);
    const out = await job(a, name, { job: "upkeep" });
    assert.equal(out.job, "stop");
    assert.equal(out.why, NEXT_WORDS.why.stop_upkeep);
    assert.equal(out.task, null);
    refused(await next(a, name, { job: "upkeep", tag: "solve" }), 400, "INVALID_REQUEST", /never upkeep/);
  });

  test("a job that is none, verify beside another job, and number beside a job but work are refused before anything is spent", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name);
    refused(await next(a, name, { job: "review" }), 400, "INVALID_REQUEST", `job is one of ${TASK_JOBS.join(", ")}`);
    refused(await next(a, name, { job: 3 }), 400, "INVALID_REQUEST");
    refused(await next(a, name, { job: "work", verify: true }), 400, "INVALID_REQUEST", /verify true is job check/);
    refused(await next(a, name, { number: 1, job: "check" }), 400, "INVALID_REQUEST", /number takes no tag, no verify and no job but work/);
    refused(await next(a, name, { number: 1, verify: true }), 400, "INVALID_REQUEST");
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.state = 'claimed'`;
    assert.equal(row!.n, 0);
  });

  test("next with number answers job work, and why says it was asked for or renewed", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    const taken = await job(a, name, { number: 2, job: "work" });
    assert.equal(taken.job, "work");
    assert.equal(taken.why, why("number", { number: 2 }));
    assert.equal(taken.task.number, 2);
    const again = await job(a, name, { number: 2 });
    assert.equal(again.renewed, true);
    assert.equal(again.why, why("renewed", { number: 2 }));
  });
});

describe("next with detail=compact", () => {
  const BODY = "Read page 3 of the 1614 tables. Transcribe every row, then post the rows as a result.";

  test("next with number and detail=compact answers no body, body_bytes, revision and cycle; done with that revision is accepted", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name, { body: BODY });
    const out = await call("POST", `/v1/spaces/${name}/tasks/next?detail=compact`, a.token, { number: 1 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const t = out.body.task;
    assert.equal("body" in t, false);
    assert.equal(t.body_bytes, Buffer.byteLength(BODY, "utf8"));
    assert.equal(t.title, "Transcribe page 3");
    assert.equal(typeof t.cycle, "number");
    assert.equal(out.body.job, "work");
    assert.equal(out.body.why, why("number", { number: 1 }));
    // Everything else the whole answer carries is there.
    const whole = await job(a, name, { number: 1 });
    assert.deepEqual(Object.keys(t).filter((k) => k !== "body_bytes").sort(), Object.keys(whole.task).filter((k) => k !== "body").sort());
    assert.deepEqual(Object.keys(out.body).filter((k) => k !== "renewed").sort(), Object.keys(whole).filter((k) => k !== "renewed").sort());
    const done = await act(a, name, 1, "done", { post_id: await result(a, name), revision: whole.task.revision ?? 1 });
    assert.equal(done.status, 200, JSON.stringify(done.body));
  });

  test("next without detail, with detail=full, and with an unknown detail answers the whole task, as before", async () => {
    const { owner, a, b, doer, name } = await crew();
    await added(owner, name, { body: BODY });
    await added(owner, name, { body: BODY });
    await added(owner, name, { body: BODY });
    const plain = await job(a, name, { number: 1 });
    const full = (await call("POST", `/v1/spaces/${name}/tasks/next?detail=full`, b.token, { number: 2 }));
    assert.equal(full.status, 200, JSON.stringify(full.body));
    // An unknown detail is ignored, as it always was: never refused, and the task is taken.
    const other = (await call("POST", `/v1/spaces/${name}/tasks/next?detail=summary`, doer.token, { number: 3 }));
    assert.equal(other.status, 200, JSON.stringify(other.body));
    for (const out of [plain, full.body, other.body]) {
      assert.equal(out.task.body, BODY);
      assert.equal("body_bytes" in out.task, false);
      assert.equal(out.task.state, "claimed");
    }
    assert.deepEqual(Object.keys(full.body.task).sort(), Object.keys(plain.task).sort());
    assert.deepEqual(Object.keys(other.body.task).sort(), Object.keys(plain.task).sort());
  });

  test("a check handed with detail=compact keeps its cycle and attempt, without the body", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name, { body: BODY });
    await did(doer, name, 1);
    const out = await call("POST", `/v1/spaces/${name}/tasks/next?detail=compact`, a.token, { job: "check" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.job, "check");
    assert.equal("body" in out.body.task, false);
    assert.equal(out.body.task.body_bytes, Buffer.byteLength(BODY, "utf8"));
    const confirmed = await act(a, name, 1, "confirm", { post_id: await result(a, name), cycle: out.body.task.cycle });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  });
});

describe("the offer cap", () => {
  test("ten KEYS at once, one done task an hour old needing 2 confirmations, ten open tasks: exactly 2 are sent to check", async () => {
    const owner = await agent();
    const doer = await agent();
    const name = await workSpace(owner);
    const crowd = await Promise.all(Array.from({ length: 12 }, () => agent()));
    for (const k of [doer, ...crowd]) await grant(owner, name, k, "writer");
    await added(owner, name, { title: "Page 1" });
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    for (let i = 0; i < 10; i++) await added(owner, name, { title: `Page ${i + 2}` });

    const ten = crowd.slice(0, 10);
    const answers = await Promise.all(ten.map((k) => job(k, name)));
    const checks = answers.filter((a) => a.job === "check");
    assert.equal(checks.length, 2, JSON.stringify(answers.map((a) => [a.job, a.task?.number])));
    for (const c of checks) assert.equal(c.task.number, 1);
    const work = answers.filter((a) => a.job === "work").map((a) => a.task.number).sort((x, y) => x - y);
    assert.deepEqual(work, [2, 3, 4, 5, 6, 7, 8, 9]);

    // While both offers live, the next KEY gets work, not a third check.
    const [x, y] = [crowd[10]!, crowd[11]!];
    const third = await job(x, name);
    assert.equal(third.job, "work");
    assert.equal(third.task.number, 10);

    // A KEY sent to check that asks next again drops its offer, and the next KEY is sent.
    const sent = ten[answers.findIndex((a) => a.job === "check")]!;
    const moved = await job(sent, name, { job: "work" });
    assert.equal(moved.job, "work");
    assert.equal(moved.task.number, 11);
    const fourth = await job(y, name);
    assert.equal(fourth.job, "check");
    assert.equal(fourth.task.number, 1);
  });

  test("a confirmation and a live offer count against the cap, and an offer past its minutes does not", async () => {
    const { owner, doer, a, b, name } = await crew();
    const c = await agent();
    await grant(owner, name, c, "writer");
    await added(owner, name);
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    assert.equal((await job(a, name)).job, "check");
    assert.equal((await act(a, name, 1, "confirm")).status, 200);
    assert.equal((await job(b, name)).job, "check");
    // One confirmation and b's live offer: two of two.
    assert.equal((await job(c, name)).job, "stop");
    await fixture.owner`
      update schellingaf.task_check_offers o set offered_at = now() - make_interval(mins => ${TASK_LIMITS.checkOfferMinutes + 1})
        from schellingaf.spaces s where s.space_id = o.space_id and s.name = ${name}`;
    assert.equal((await job(c, name)).job, "check", "b's offer passed");
  });

  test("an offer is a row of its own, never a check: confirming after it counts once", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await did(doer, name, 1);
    await job(a, name, { job: "check" });
    const rows = await fixture.owner<{ peer: string; cycle: number }[]>`
      select encode(o.peer_id, 'hex') as peer, o.cycle from schellingaf.task_check_offers o
        join schellingaf.spaces s on s.space_id = o.space_id where s.name = ${name}`;
    assert.deepEqual([...rows], [{ peer: a.peerId, cycle: 0 }]);
    const confirmed = await act(a, name, 1, "confirm");
    assert.deepEqual(confirmed.body.task.confirmations.given, [a.peerId]);
  });

  test("the api role reads no offer, even of a public SPACE", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await did(doer, name, 1);
    await job(a, name, { job: "check" });
    const [row] = await fixture.owner<{ ok: boolean }[]>`
      select has_table_privilege('schellingaf_api', 'schellingaf.task_check_offers', 'select') as ok`;
    assert.equal(row!.ok, false);
  });
});

describe("the prune", () => {
  test("drops offers a day old and keeps younger ones", async () => {
    const { owner, doer, a, b, name } = await crew();
    await added(owner, name);
    await did(doer, name, 1);
    await job(a, name, { job: "check" });
    await job(b, name, { job: "check" });
    await fixture.owner`
      update schellingaf.task_check_offers o set offered_at = now() - interval '25 hours'
        from schellingaf.spaces s where s.space_id = o.space_id and s.name = ${name} and o.peer_id = ${Buffer.from(a.peerId, "hex")}`;
    const out = await prune(db);
    assert.equal(out.state, "pruned");
    assert.ok(out.state === "pruned" && out.offers >= 1, JSON.stringify(out));
    const left = await fixture.owner<{ peer: string }[]>`
      select encode(o.peer_id, 'hex') as peer from schellingaf.task_check_offers o
        join schellingaf.spaces s on s.space_id = o.space_id where s.name = ${name}`;
    assert.deepEqual([...left], [{ peer: b.peerId }]);
  });
});

describe("the release before", () => {
  test("next_task, as it called it, answers as 0.3 did, with job, why and renewed added", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    const key = Buffer.from(a.peerId, "hex");
    const [work] = await fixture.owner<{ out: any }[]>`select schellingaf.next_task(${name}, ${key}, null, false) as out`;
    assert.deepEqual(Object.keys(work!.out).sort(), ["job", "renewed", "space", "task", "verify", "why"]);
    assert.equal(work!.out.job, "work", "the release before took work, never a check first");
    assert.equal(work!.out.task.number, 2);
    assert.equal(work!.out.why, null, "it sends no words");
    const [check] = await fixture.owner<{ out: any }[]>`select schellingaf.next_task(${name}, ${key}, null, true) as out`;
    assert.equal(check!.out.job, "check");
    assert.equal(check!.out.verify, true);
    assert.equal(check!.out.task.number, 1);
  });

  test("next_job holds the same numbers as TASK_LIMITS when it is not given them", async () => {
    const [row] = await fixture.owner<{ args: string }[]>`
      select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'schellingaf' and p.proname = 'next_job' and p.pronargs = 9`;
    assert.match(row!.args, new RegExp(`p_held_max integer DEFAULT ${TASK_LIMITS.held}\\b`));
    assert.match(row!.args, new RegExp(`p_check_first_minutes integer DEFAULT ${TASK_LIMITS.checkFirstMinutes}\\b`));
    assert.match(row!.args, new RegExp(`p_offer_minutes integer DEFAULT ${TASK_LIMITS.checkOfferMinutes}\\b`));
  });
});

describe("the words", () => {
  const sql = ["0133_task_next_job.sql", "0134_task_upkeep.sql", "0138_document_decision.sql", "0140_task_attempts.sql", "0141_task_claims.sql"]
    .map((file) => readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).join("\n");

  test("every sentence next_job names is in NEXT_WORDS, and every one in NEXT_WORDS is named", () => {
    const named = new Set([...sql.replace(/--.*$/gm, "").matchAll(/'((?:renewed|renewed_changed|held_upkeep|number|joined|work|check_first|check_idle|check_asked|check_attempts|upkeep_document|upkeep_document_first|upkeep_tasks|stop|stop_waiting|stop_upkeep|stop_check|check_version|check_version_decide))'/g)].map((m) => m[1]!));
    // work and number are also job values and a field name; each sentence key must appear.
    assert.deepEqual([...named].sort(), Object.keys(NEXT_WORDS.why).sort());
  });

  test("why is filled with numbers only: each placeholder is a number next counted, or the signals made of them", async () => {
    // hours is twice the SPACE's claim hours, an upkeep claim's cap. signals is NEXT_WORDS' own signal sentences, filled with task numbers and hours
    // (test/task-upkeep.test.ts).
    const values = { number: "12", minutes: "61", from: "1", to: "3", count: "4", seq: "70", hours: "8", given: "1", required: "2", signals: "a new document version since the last review", attempts: "2", attempt: "1", others: "1" };
    for (const [key, text] of Object.entries(NEXT_WORDS.why)) {
      for (const [, name] of text.matchAll(/\{([a-z_]+)\}/g)) assert.ok(Object.keys(values).includes(name!), `${key}: {${name}}`);
      const [row] = await fixture.owner<{ text: string }[]>`
        select schellingaf.next_why(${fixture.owner.json(NEXT_WORDS as never)}, ${key}, ${fixture.owner.json(values)}) as text`;
      assert.doesNotMatch(row!.text, /[{}]/, `${key}: ${row!.text}`);
      assert.equal(row!.text, Object.entries(values).reduce<string>((s, [k, v]) => s.replaceAll(`{${k}}`, v), text));
    }
    const [none] = await fixture.owner<{ text: string | null }[]>`select schellingaf.next_why(null, 'work', '{}') as text`;
    assert.equal(none!.text, null);
  });

  test("the operation, the capability document and the API version say it", async () => {
    const op = OPERATIONS.find((o) => o.name === "tasks.next")!;
    assert.ok(op.describe.includes(`waited ${TASK_LIMITS.checkFirstMinutes} minutes for a check`), op.describe);
    assert.equal(API_VERSION, API_CHANGES[0].api_version);
    assert.match(API_CHANGES.find((c) => c.api_version === "0.5")!.what, /may answer job check with task null and version set/);
    assert.match(API_CHANGES.find((c) => c.api_version === "0.4")!.what, /answers job \(work, check, upkeep or stop\) and why/);
    const caps = (await call("GET", "/v1/capabilities")).body;
    assert.equal(caps.api_version, API_VERSION);
    assert.equal(caps.limits.tasks.check_first_minutes, 60);
    assert.equal(caps.limits.tasks.check_offer_minutes, 30);
  });

  test("the OpenAPI document takes job and answers job and why", async () => {
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    const body = doc.paths["/v1/spaces/{name}/tasks/next"].post.requestBody.content["application/json"].schema;
    assert.deepEqual(body.properties.job.enum, ["any", "work", "check", "upkeep"]);
    assert.equal(body.properties.job.default, "any");
    const answer = doc.components.schemas.TaskAnswer.properties;
    assert.deepEqual(answer.job.enum, ["work", "check", "upkeep", "stop"]);
    assert.ok(answer.why);
  });

  test("the operation and the OpenAPI document say detail=compact leaves the body out, and an upkeep task keeps it", async () => {
    const op = OPERATIONS.find((o) => o.name === "tasks.next")!;
    assert.ok(op.describe.endsWith("With detail=compact, the task comes without its body, and body_bytes gives its size; an upkeep task keeps its body."), op.describe);
    const doc = (await (await app.request("/openapi.json")).json()) as any;
    const detail = doc.paths["/v1/spaces/{name}/tasks/next"].post.parameters.find((p: any) => p.name === "detail");
    assert.deepEqual(detail.schema.enum, ["compact", "full"]);
    assert.equal(detail.schema.default, "full");
    assert.equal(detail.in, "query");
    const schemas = doc.components.schemas;
    assert.ok(schemas.Task.required.includes("body"), "every route's whole task has its body");
    assert.equal(schemas.Task.properties.body_bytes, undefined);
    assert.deepEqual(schemas.TaskWithoutBody.properties.body.not, {}, "a body is never present");
    assert.equal(schemas.TaskWithoutBody.required.includes("body"), false);
    assert.equal(schemas.TaskWithoutBody.properties.body_bytes.type, "integer");
    assert.ok(schemas.TaskWithoutBody.required.includes("body_bytes"));
    const answer = doc.paths["/v1/spaces/{name}/tasks/next"].post.responses["200"].content["application/json"].schema;
    assert.equal(answer.$ref, "#/components/schemas/TaskNextAnswer");
    assert.deepEqual(schemas.TaskNextAnswer.properties.task.anyOf[0].oneOf.map((s: any) => s.$ref),
      ["#/components/schemas/Task", "#/components/schemas/TaskWithoutBody"]);
    // Every other task write still answers TaskAnswer, whose whole task keeps its body.
    assert.equal(doc.paths["/v1/spaces/{name}/tasks/{number}/done"].post.responses["200"].content["application/json"].schema.$ref, "#/components/schemas/TaskAnswer");
  });
});

describe("the connector", () => {
  async function tool(who: Agent, args: Record<string, unknown>) {
    const { message } = await connector("tools/call", { name: "schellingaf_task", arguments: args }, who.token);
    const out = message.result;
    return { isError: out.isError === true, text: out.content[0].text as string, json: out.structuredContent };
  }

  test("next passes job, and the job and why come first", async () => {
    const { owner, doer, a, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    const check = await tool(a, { action: "next", space: name });
    assert.equal(check.isError, false, check.text);
    assert.equal(check.text.split("\n")[1], `job: check. ${why("check_first", { number: 1, minutes: 61 })}`);
    assert.match(check.text, /for you to check: confirm or reject it/);
    const work = await tool(a, { action: "next", space: name, job: "work" });
    assert.equal(work.json.job, "work");
    assert.equal(work.text.split("\n")[1], `job: work. ${why("work", { number: 2 })}`);
    const stop = await tool(owner, { action: "next", space: name, job: "upkeep" });
    assert.deepEqual(stop.text.split("\n").slice(1), [`job: stop. ${NEXT_WORDS.why.stop_upkeep}`]);
  });

  test("next with detail compact prints the body's size, not the body", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name, { body: "Read page 3. Transcribe every row." });
    const out = await tool(a, { action: "next", space: name, number: 1, detail: "compact" });
    assert.equal(out.isError, false, out.text);
    assert.equal(out.json.task.body_bytes, 34);
    assert.match(out.text, /\n {2}task body: 34 bytes, left out; read it with get\n/);
    assert.doesNotMatch(out.text, /Transcribe every row/);
    // Without it, the body comes whole, as before.
    const whole = await tool(a, { action: "next", space: name, number: 1 });
    assert.match(whole.text, /Transcribe every row/);
    assert.doesNotMatch(whole.text, /left out/);
  });

  test("an answer with no job, from a service before 0.4, renders as it did", () => {
    assert.match(renderTask("h", { space: "pages", task: null, verify: false }), /no task in "pages" is open to you now/);
    assert.doesNotMatch(renderTask("h", { space: "pages", task: null, verify: false }), /job:/);
  });
});

describe("the plans inside next_job", () => {
  type PlanNode = { [field: string]: any; Plans?: PlanNode[] };
  const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];

  /** The plans of the statements next_job runs, as the api role, read from auto_explain. */
  async function plansInside(call: (tx: postgres.TransactionSql) => Promise<unknown>) {
    const logged: string[] = [];
    const su = postgres({ ...SUPERUSER, database: fixture.name, onnotice: (m) => logged.push(m.message ?? "") });
    try {
      await su`load 'auto_explain'`;
      for (const setting of ["log_min_duration = 0", "log_nested_statements = on", "log_analyze = on", "log_timing = off", "log_format = json", "log_level = notice"]) {
        await su.unsafe(`set auto_explain.${setting}`);
      }
      await su.begin(async (tx) => {
        await tx.unsafe("set local role schellingaf_api");
        await tx.unsafe("set local plan_cache_mode = force_generic_plan");
        await call(tx);
      });
    } finally {
      await su.end({ timeout: 5 });
    }
    return logged
      .filter((m) => m.includes("{"))
      .map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
  }

  test("each step probes its index: the done tasks, the waiting tasks, the checks and the offers by key", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const post = await result(owner, name);
    // Three thousand tasks, all but a few accepted, a few done ones at the end of the list,
    // and an offer from the owner on each accepted one, so a walk of either table shows.
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by, state, claimed_by, claimed_until,
                                     done_post_id, done_at, accepted_at, attempts, attempt)
      select s.space_id, g, 'task ' || g, s.owner_id, x.state,
             case when x.state <> 'open' then s.owner_id end,
             case when x.state = 'claimed' then now() + interval '1 hour' end,
             case when x.state in ('done', 'accepted') then ${post}::uuid end,
             case when x.state in ('done', 'accepted') then now() - interval '2 hours' end,
             case when x.state = 'accepted' then now() end,
             case when x.state in ('done', 'accepted') then 1 else 0 end,
             case when x.state in ('done', 'accepted') then 1 end
        from schellingaf.spaces s
        cross join generate_series(1, 3000) g
        cross join lateral (select case when g <= 2990 then 'accepted' when g % 3 = 0 then 'open'
                                        when g % 3 = 1 then 'claimed' else 'done' end as state) x
       where s.name = ${name}`;
    await claimsFromRows(name);
    // Each result is attempt 1 (migrations/0140_task_attempts.sql).
    await fixture.owner`
      insert into schellingaf.task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id, at)
      select t.task_id, t.space_id, 1, 0, t.claimed_by, t.done_post_id, t.claimed_by, t.done_at
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.state in ('done', 'accepted')`;
    // A thousand KEYs, as passkeys hold them, to spread the offers and checks over.
    await fixture.owner`
      insert into schellingaf.peers (peer_id, key_type)
      select sha256(convert_to(${name} || '/' || g, 'UTF8')), 'passkey' from generate_series(1, 1000) g`;
    for (const table of ["task_check_offers", "task_checks"]) {
      await fixture.owner.unsafe(`
        insert into schellingaf.${table} (space_id, task_id, cycle, peer_id${table === "task_checks" ? ", verdict, attempt" : ""})
        select t.space_id, t.task_id, 0, sha256(convert_to($1 || '/' || (t.number % 1000 + 1), 'UTF8'))${table === "task_checks" ? ", 'confirm', 1" : ""}
          from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
         where s.name = $1 and t.state = 'accepted'`, [name]);
    }
    // Another SPACE where those KEYs hold two thousand tasks (migrations/0141_task_claims.sql),
    // so a walk of every claim shows.
    const crowd = await workSpace(owner);
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by, state, claimed_by, claimed_until, claimed_at, claim_revision, takes)
      select s.space_id, g, 'task ' || g, s.owner_id, 'claimed', sha256(convert_to(${name} || '/' || (g % 1000 + 1), 'UTF8')),
             now() + interval '1 hour', now(), 1, 1
        from schellingaf.spaces s cross join generate_series(1, 2000) g where s.name = ${crowd}`;
    await claimsFromRows(crowd);
    await fixture.owner`analyze schellingaf.task_claims`;
    await fixture.owner`analyze schellingaf.tasks`;
    await fixture.owner`analyze schellingaf.task_check_offers`;
    await fixture.owner`analyze schellingaf.task_checks`;
    await fixture.owner`analyze schellingaf.task_attempts`;
    const other = await agent();
    await grant(owner, name, other, "writer");
    const key = Buffer.from(other.peerId, "hex");
    const words = NEXT_WORDS as never;

    const scansOf = (plans: { "Query Text": string; Plan: PlanNode }[], pattern: RegExp) => {
      const statements = plans.filter((p) => pattern.test(p["Query Text"]) && !/next_job\(/.test(p["Query Text"]));
      assert.ok(statements.length > 0, `auto_explain logged no statement like ${pattern}:\n${plans.map((p) => p["Query Text"]).join("\n--\n")}`);
      const scans = statements.flatMap((p) => nodesOf(p.Plan)).filter((n) => n["Relation Name"] || n["Index Name"]);
      return { scans, shown: JSON.stringify(scans, ["Node Type", "Relation Name", "Alias", "Index Name", "Index Cond", "Filter"], 1) };
    };

    // job any: the drop, check first (the done tasks have waited two hours), with the cap.
    const any = await plansInside((tx) => tx`select schellingaf.next_job(${name}, ${key}, 'any', null, null, ${tx.json(words)})`);
    const drop = scansOf(any, /DELETE FROM task_check_offers o WHERE o\.space_id = s\.space_id/);
    assert.ok(drop.scans.some((n) => n["Index Name"] === "task_check_offers_peer_idx"), drop.shown);
    const first = scansOf(any, /ORDER BY d\.done_at/);
    assert.ok(!first.scans.some((n) => n["Node Type"] === "Seq Scan"), `next walked a whole table:\n${first.shown}`);
    // The attempts' probes (migrations/0140_task_attempts.sql): one check a KEY an attempt, and
    // the attempts of the task's cycle, by key.
    for (const index of ["tasks_done_idx", "task_checks_attempt_key", "task_check_offers_pkey"]) {
      assert.ok(first.scans.some((n) => n["Index Name"] === index), `${index} unused:\n${first.shown}`);
    }
    assert.ok(first.scans.some((n) => n["Relation Name"] === "task_attempts" && n["Node Type"] !== "Seq Scan"), first.shown);

    // job work: the take walks the waiting tasks.
    const work = await plansInside((tx) => tx`select schellingaf.next_job(${name}, ${key}, 'work', null, null, ${tx.json(words)})`);
    const take = scansOf(work, /UPDATE tasks c SET takes = c.takes \+ 1/);
    assert.ok(!take.scans.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "tasks"), take.shown);
    assert.ok(take.scans.some((n) => n["Index Name"] === "tasks_waiting_idx"), take.shown);
    // Step 1 reads the caller's claims by its index, never every claim.
    const held = scansOf(work, /FROM task_claims c JOIN tasks k/);
    assert.ok(!held.scans.some((n) => n["Node Type"] === "Seq Scan"), held.shown);
    assert.ok(held.scans.some((n) => n["Index Name"] === "task_claims_peer_idx"), held.shown);

    // Check when idle, with no work left for this caller: every open task is held.
    await fixture.owner`
      update schellingaf.tasks t set state = 'claimed', claimed_by = s.owner_id, claimed_until = now() + interval '1 hour'
        from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.state = 'open'`;
    await claimsFromRows(name);
    // A KEY that holds none, since the one above took a task.
    const idler = await agent();
    await grant(owner, name, idler, "writer");
    const idleKey = Buffer.from(idler.peerId, "hex");
    const idle = await plansInside((tx) => tx`select schellingaf.next_job(${name}, ${idleKey}, 'any', null, null, ${tx.json(words)}, 3, 600)`);
    const lowest = scansOf(idle, /FROM tasks d[\s\S]*ORDER BY d\.number/);
    assert.ok(!lowest.scans.some((n) => n["Node Type"] === "Seq Scan"), lowest.shown);
    assert.ok(lowest.scans.some((n) => n["Index Name"] === "tasks_done_idx"), lowest.shown);
  });

  test("43. a waiting version for next is found through oracle_versions_pending, the posts key and posts_reply_idx", async () => {
    const owner = await agent();
    const name = await workSpace(owner, { document: true, document_confirmations: 2 });
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    // Three thousand posts, a hundred of them replies to versions, and twenty versions of
    // which one waits, so a walk of posts or of oracle_versions shows in the plan.
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select ${s!.space_id}::uuid, g, 1, decode(${owner.peerId}, 'hex'), case when g <= 20 then 'version' else 'obs' end,
             'post ' || g, 'body ' || g, sha256(convert_to(${name} || g, 'UTF8'))
        from generate_series(1, 2900) g`;
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash, reply_to)
      select ${s!.space_id}::uuid, g, 1, decode(${owner.peerId}, 'hex'), 'obs', 'reply ' || g, 'body ' || g,
             sha256(convert_to(${name} || g, 'UTF8')),
             (select v.post_id from schellingaf.posts v where v.space_id = ${s!.space_id}::uuid and v.seq = (g % 20) + 1)
        from generate_series(2901, 3000) g`;
    await fixture.owner`
      insert into schellingaf.oracle_versions (post_id, space_id, seq, author_id, state, text_hash)
      select p.post_id, p.space_id, p.seq, p.author_id, case when p.seq = 20 then 'pending' when p.seq = 19 then 'current' else 'replaced' end,
             sha256(convert_to(p.body, 'UTF8'))
        from schellingaf.posts p where p.space_id = ${s!.space_id}::uuid and p.kind = 'version'`;
    await fixture.owner`update schellingaf.spaces set last_seq = 3000 where name = ${name}`;
    await fixture.owner`vacuum analyze`;
    const writer = await agent();
    await grant(owner, name, writer, "writer");
    const key = Buffer.from(writer.peerId, "hex");
    // Through next_job(), as the route calls it: next_version_check() is internal.
    const plans = await plansInside((tx) => tx`
      select schellingaf.next_job(${name}, ${key}, 'any', null, null, ${tx.json(NEXT_WORDS as never)}, 3, 60, 30, 10000, 2, 4)`);
    const inner = plans.filter((p) => /FROM oracle_versions v/.test(p["Query Text"]) && /no_role/.test(p["Query Text"])
                                      && !/next_job\(/.test(p["Query Text"]));
    assert.equal(inner.length, 1, plans.map((p) => p["Query Text"]).join("\n--\n"));
    const scans = nodesOf(inner[0]!.Plan).filter((n) => n["Relation Name"] || n["Index Name"]);
    const shown = JSON.stringify(scans, ["Node Type", "Relation Name", "Index Name", "Index Cond", "Filter"], 1);
    for (const index of ["oracle_versions_pending", "posts_pkey", "posts_reply_idx"]) {
      assert.ok(scans.some((n) => n["Index Name"] === index), `${index} unused:\n${shown}`);
    }
    assert.ok(!scans.some((n) => n["Node Type"] === "Seq Scan"), `a table was walked:\n${shown}`);
  });
});

describe("next hands a waiting version of the document as a check, where the SPACE sets document_confirmations", () => {
  /** A public work space of a fresh owner's that keeps a document, confirmations as given,
   *  with writers w1 w2 w3, a coordinator and the owner's first version current. */
  async function documented(confirmations: number, extra: Record<string, unknown> = {}) {
    const owner = await agent();
    const [w1, w2, w3, coordinator] = await Promise.all([agent(), agent(), agent(), agent()]);
    const name = await workSpace(owner, { document: true, document_confirmations: confirmations, ...extra });
    for (const k of [w1, w2, w3]) await grant(owner, name, k, "writer");
    await grant(owner, name, coordinator, "coordinator");
    const v1 = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "version", body: "# Pages\n\nOne." });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    return { owner, w1, w2, w3, coordinator, name, v1: v1.body.post_id as string };
  }

  async function propose(who: Agent, name: string, supersedes: string, extra: Record<string, unknown> = {}) {
    const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, { kind: "version", body: `# Pages\n\n${n++}.`, supersedes, ...extra });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    return out.body as { post_id: string; seq: string };
  }

  async function postedAt(postId: string): Promise<string> {
    const [row] = await fixture.owner<{ at: string }[]>`select to_jsonb(posted_at) #>> '{}' as at from schellingaf.posts where post_id = ${postId}::uuid`;
    return row!.at;
  }

  /** The words next sends, with the two version sentences left out: older words. */
  const olderWords = () => {
    const { check_version: _a, check_version_decide: _b, ...why } = NEXT_WORDS.why;
    return { ...NEXT_WORDS, why };
  };

  /** next_job() called straight, inside a transaction rolled back, so nothing it claims stays. */
  async function rolledBack<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await fixture.owner.begin(async (tx) => {
      out = await fn(tx);
      throw new Error("rolled back");
    }).catch((error: Error) => {
      if (error.message !== "rolled back") throw error;
    });
    return out!;
  }

  test("14. at 0 next answers exactly as main's next_job() did, with a version waiting", async () => {
    const { owner, w1, w2, name, v1 } = await documented(0);
    await propose(w2, name, v1);
    const source = readFileSync(new URL("../migrations/0134_task_upkeep.sql", import.meta.url), "utf8");
    const start = source.indexOf("CREATE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,");
    const main = source.slice(start, source.indexOf("END $$;", start) + "END $$;".length)
      .replace("CREATE FUNCTION schellingaf.next_job(", "CREATE FUNCTION schellingaf.next_job_main(");
    const key = Buffer.from(w1.peerId, "hex");
    const times = (x: unknown) => JSON.stringify(x).replace(/\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:\d\d)/g, "<time>");
    for (const scene of ["no task", "an open task"]) {
      if (scene === "an open task") await added(owner, name);
      for (const job of ["any", "check", "work"]) {
        const theirs = await rolledBack(async (tx) => {
          await tx.unsafe(main);
          return (await tx`select schellingaf.next_job_main(${name}, ${key}, ${job}, null, null, ${tx.json(NEXT_WORDS as never)}, 3, 60, 30, 10000, 2, 4) as out`)[0]!.out;
        });
        const mine = await rolledBack(async (tx) =>
          (await tx`select schellingaf.next_job(${name}, ${key}, ${job}, null, null, ${tx.json(NEXT_WORDS as never)}, 3, 60, 30, 10000, 2, 4) as out`)[0]!.out);
        assert.equal(times(mine), times(theirs), `${scene}, job ${job}`);
      }
    }
  });

  test("38. a writer is handed the waiting version with job any, as 6.3 says; its author, a confirmer and a replier are not", async () => {
    const { owner, w1, w2, w3, coordinator, name, v1 } = await documented(2);
    const p = await propose(w2, name, v1);
    const out = await job(w1, name);
    const { notice, ...answer } = out;
    assert.equal(typeof notice, "string");
    assert.deepEqual(answer, {
      space: name, job: "check", why: why("check_version", { seq: Number(p.seq), given: 0, required: 2 }),
      verify: true, renewed: false, task: null,
      version: {
        post_id: p.post_id, seq: String(p.seq), author: w2.peerId, posted_at: await postedAt(p.post_id), summary: TEST_TITLE,
        waits_for: { decision: ["owner", "admin", "coordinator"], confirmations: { given: [], required: 2 } },
      },
    });
    assert.notEqual((await job(w2, name)).job, "check", "its author");
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, w3.token, { kind: "go", body: "Holds.", reply_to: p.post_id })).status, 201);
    assert.notEqual((await job(w3, name)).job, "check", "a confirmer");
    assert.equal((await job(w1, name)).why, why("check_version", { seq: Number(p.seq), given: 1, required: 2 }));
    const replier = await agent();
    await grant(owner, name, replier, "writer");
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, replier.token, { kind: "obs", body: "Page 3 is wrong.", reply_to: p.post_id })).status, 201);
    assert.notEqual((await job(replier, name)).job, "check", "a KEY that replied");
    // job work, a tag and a number never hand one.
    assert.equal((await job(w1, name, { job: "work" })).version, undefined);
    assert.equal((await job(w1, name, { tag: "pages" })).version, undefined);
    await added(owner, name);
    assert.equal((await job(w1, name, { number: 1 })).job, "work");

    // A version that sets the stage goes to a decider alone, with its stage.
    const staged = await documented(1);
    const s = await propose(staged.w2, staged.name, staged.v1, { data: { stage: { word: "merged", note: "All in." } } });
    assert.notEqual((await job(staged.w1, staged.name)).job, "check");
    const decide = await job(staged.coordinator, staged.name);
    assert.equal(decide.job, "check");
    assert.equal(decide.why, why("check_version_decide", { seq: Number(s.seq) }));
    assert.deepEqual(decide.version.stage, { word: "merged", note: "All in." });
    assert.deepEqual(decide.version.waits_for, { decision: ["owner", "admin", "coordinator"] });
    void coordinator;
  });

  test("39. a stranger's version is never handed, with job any or job check", async () => {
    const { w1, name, v1 } = await documented(1, { join_policy: "open" });
    const stranger = await agent();
    await propose(stranger, name, v1);
    assert.equal((await job(w1, name)).job, "stop");
    assert.equal((await job(w1, name, { job: "check" })).job, "stop");
  });

  test("40. a check that waited comes first; then the version, before an open task and a task review; job work takes the task", async () => {
    const { owner, w1, w2, w3, coordinator, name, v1 } = await documented(2);
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: 1 })).status, 200);
    const doer = await agent();
    await grant(owner, name, doer, "writer");
    await added(owner, name, { title: "Page 1" });
    await added(owner, name, { title: "Page 2" });
    await did(doer, name, 1);
    await doneAgo(name, 1, 61);
    const p = await propose(w2, name, v1);
    const first = await job(w1, name);
    assert.deepEqual([first.job, first.task?.number], ["check", 1]);
    // The offer to w1 holds task 1's one place, so w3 is handed the version, before task 2.
    const second = await job(w3, name);
    assert.deepEqual([second.job, second.version?.post_id], ["check", p.post_id]);
    const work = await job(w3, name, { job: "work" });
    assert.deepEqual([work.job, work.task?.number], ["work", 2]);
    // A coordinator, whom a task review would wait for, is handed the version first, to decide.
    const decide = await job(coordinator, name);
    assert.deepEqual([decide.job, decide.why], ["check", why("check_version_decide", { seq: Number(p.seq) })]);
  });

  test("41. job check: the version when no done task waits, and the done task when one does", async () => {
    const { owner, w1, w2, name, v1 } = await documented(2);
    const p = await propose(w2, name, v1);
    const asked = await job(w1, name, { job: "check" });
    assert.deepEqual([asked.job, asked.version?.post_id, asked.task], ["check", p.post_id, null]);
    const doer = await agent();
    await grant(owner, name, doer, "writer");
    await added(owner, name);
    await did(doer, name, 1);
    const task = await job(w1, name, { job: "check" });
    assert.deepEqual([task.job, task.task?.number, task.version], ["check", 1, undefined]);
  });

  test("42. no words, or older words without check_version, never hand a version", async () => {
    const { w1, w2, name, v1 } = await documented(1);
    await propose(w2, name, v1);
    const key = Buffer.from(w1.peerId, "hex");
    const answers = await rolledBack(async (tx) => {
      const out: unknown[] = [];
      for (const j of ["any", "check"]) {
        out.push((await tx`select schellingaf.next_job(${name}, ${key}, ${j}) as out`)[0]!.out);
        out.push((await tx`select schellingaf.next_job(${name}, ${key}, ${j}, null, null, ${tx.json(olderWords() as never)}) as out`)[0]!.out);
        out.push((await tx`select schellingaf.next_job(${name}, ${key}, ${j}, null, null, ${tx.json(olderWords() as never)}, 3, 60, 30, 10000, 2, 4) as out`)[0]!.out);
      }
      out.push((await tx`select schellingaf.next_task(${name}, ${key}, null, true) as out`)[0]!.out);
      return out as Record<string, unknown>[];
    });
    for (const a of answers) assert.equal(a.version, undefined, JSON.stringify(a));
    // And the same call with today's words does.
    const today = await rolledBack(async (tx) =>
      (await tx`select schellingaf.next_job(${name}, ${key}, 'any', null, null, ${tx.json(NEXT_WORDS as never)}, 3, 60, 30, 10000, 2, 4) as out`)[0]!.out);
    assert.equal((today as { job: string }).job, "check");
  });
});
