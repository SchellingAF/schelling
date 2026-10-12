// Any KEY takes and finishes a task in an open work space, and never becomes a member:
// migrations/0162_open_tasks_finished.sql, the lines marked open (0162). task_taker_rank()
// raises a KEY below writer to a writer's rank at the entry checks of take, progress, give
// back, done and next with job any or work; checks and upkeep stay a member's. At 0
// confirmations a no-role KEY's result waits for one member's confirm, and the attempts cap
// counts no attempt of a blocked KEY. These drive the rules through the routes, as an agent
// would, and read the database only to set a scene a route cannot. After every case,
// task_mirror_faults() answers nothing.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { mirrorChecked, followDoneAt } from "./lib/mirror.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_open", { apiHost: "api.task-open.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `open-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Transcription", visibility: "public", join_policy: "open", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function setting(owner: Agent, name: string, fields: Record<string, unknown>) {
  const out = await call("PATCH", `/v1/spaces/${name}`, owner.token, fields);
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

async function act(who: Agent, name: string, number: number, action: string, fields: Record<string, unknown> = {}) {
  return call("POST", `/v1/spaces/${name}/tasks/${number}/${action}?detail=full`, who.token, fields);
}

async function posted(who: Agent, name: string, kind = "result", body = `Page ${n++}, transcribed.`) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind, body, title: "Page 3", fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

async function done(who: Agent, name: string, number: number) {
  return act(who, name, number, "done", { post_id: await posted(who, name) });
}

async function task(name: string, number: number) {
  const out = await call("GET", `/v1/spaces/${name}/tasks/${number}`);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.task as Record<string, any>;
}

function ok(out: { status: number; body: any }) {
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

function refused(out: { status: number; body: any }, status: number, code: string, detail?: string) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
  if (detail !== undefined) assert.equal(out.body.error.detail, detail);
}

/** A scene a route cannot make: task `number` done `minutes` ago. */
async function doneAgo(name: string, number: number, minutes: number) {
  await fixture.owner`
    update schellingaf.tasks t set done_at = now() - make_interval(mins => ${minutes})
      from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
  await followDoneAt(name);
}

async function memberships(name: string, who: Agent) {
  const [row] = await fixture.owner<{ n: number }[]>`
    select count(*)::int as n from schellingaf.memberships m join schellingaf.spaces s on s.space_id = m.space_id
     where s.name = ${name} and m.peer_id = ${Buffer.from(who.peerId, "hex")}`;
  return row!.n;
}

/** The owner, a writer, a reader and two KEYS with no role of one open public work space. */
async function crew(extra: Record<string, unknown> = {}) {
  const owner = await agent();
  const writer = await agent();
  const reader = await agent();
  const stranger = await agent();
  const other = await agent();
  const name = await space(owner, extra);
  await grant(owner, name, writer, "writer");
  await grant(owner, name, reader, "reader");
  return { owner, writer, reader, stranger, other, name };
}

describe("A1-A3: a KEY with no role takes and finishes work in an open work space", () => {
  test("A1. next with job any and work, next by number, join, progress, release and done all land; a reader's too", async () => {
    const { owner, reader, stranger, other, name } = await crew();
    for (let i = 0; i < 4; i++) await added(owner, name, { title: `Page ${i + 1}` });
    const any = ok(await next(stranger, name));
    assert.deepEqual([any.job, any.task.number, any.task.claimed_by], ["work", 1, stranger.peerId]);
    const work = ok(await next(other, name, { job: "work" }));
    assert.deepEqual([work.job, work.task.number], ["work", 2]);
    const byNumber = ok(await next(reader, name, { number: 3 }));
    assert.deepEqual([byNumber.job, byNumber.task.number, byNumber.task.claimed_by], ["work", 3, reader.peerId]);
    const joined = ok(await next(other, name, { number: 1, join: true }));
    assert.deepEqual(joined.task.claimants.map((c: any) => c.by).sort(), [stranger.peerId, other.peerId].sort());
    const progress = ok(await act(stranger, name, 1, "progress", { post_id: await posted(stranger, name, "progress") }));
    assert.ok(progress.task.progress);
    ok(await act(reader, name, 3, "release"));
    assert.equal((await task(name, 3)).state, "open");
    const finished = ok(await done(stranger, name, 1));
    assert.equal(finished.task.state, "done", "a public SPACE asks for two confirmations");
    assert.equal(ok(await done(reader, name, 3)).task.state, "done");
  });

  test("A2. no membership, event or roster row is made, the revision stays, and whoami lists no SPACE", async () => {
    const { owner, stranger, name } = await crew();
    await added(owner, name);
    const before = (await call("GET", `/v1/spaces/${name}`, owner.token)).body;
    ok(await next(stranger, name));
    ok(await done(stranger, name, 1));
    const after = (await call("GET", `/v1/spaces/${name}`, owner.token)).body;
    assert.equal(after.revision, before.revision);
    assert.equal(after.member_count, before.member_count);
    assert.equal(await memberships(name, stranger), 0);
    const roster = await call("GET", `/v1/spaces/${name}/members`, owner.token);
    assert.equal(JSON.stringify(roster.body).includes(stranger.peerId), false);
    const me = ok(await call("GET", "/v1/me", stranger.token));
    assert.equal(JSON.stringify(me).includes(name), false);
  });

  test("A3. only job any and work are raised: job check, verify and job upkeep answer TASK_DENIED", async () => {
    const { owner, stranger, name } = await crew();
    await added(owner, name);
    refused(await next(stranger, name, { job: "check" }), 403, "TASK_DENIED", owner.peerId);
    refused(await next(stranger, name, { verify: true }), 403, "TASK_DENIED", owner.peerId);
    refused(await next(stranger, name, { job: "upkeep" }), 403, "TASK_DENIED", owner.peerId);
  });

  test("G5. a KEY with no role asking any gets its own live claim back, renewed", async () => {
    const { owner, stranger, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    assert.equal(ok(await next(stranger, name)).task.number, 1);
    const again = ok(await next(stranger, name));
    assert.deepEqual([again.job, again.task.number, again.renewed], ["work", 1, true]);
  });
});

describe("A4-A7: checks and upkeep stay a member's", () => {
  test("A4. never a check, even of a done task that waited an hour; a member is offered it", async () => {
    const { owner, writer, stranger, name } = await crew();
    await added(owner, name);
    ok(await next(writer, name));
    ok(await done(writer, name, 1));
    await doneAgo(name, 1, 90);
    const out = ok(await next(stranger, name));
    assert.deepEqual([out.job, out.task], ["stop", null], JSON.stringify(out));
    const other = await agent();
    await grant(owner, name, other, "writer");
    const member = ok(await next(other, name));
    assert.deepEqual([member.job, member.task.number], ["check", 1], JSON.stringify(member));
  });

  test("A4. never upkeep while document upkeep is due: the stranger gets stop, the member after it the upkeep", async () => {
    const { owner, writer, stranger, name } = await crew({ document: true });
    // Three results by a member, and nothing else to do: document upkeep is due.
    for (let i = 0; i < 3; i++) await posted(writer, name);
    const out = ok(await next(stranger, name));
    assert.deepEqual([out.job, out.task], ["stop", null], JSON.stringify(out));
    const other = await agent();
    await grant(owner, name, other, "writer");
    const member = ok(await next(other, name));
    assert.deepEqual([member.job, member.task.upkeep], ["upkeep", "document"], JSON.stringify(member));
  });

  test("A4. a holder of document upkeep that loses its role renews it no more, links no progress to it and finishes it not", async () => {
    const { owner, writer, name } = await crew({ document: true });
    const gone = await agent();
    await grant(owner, name, gone, "writer");
    for (let i = 0; i < 3; i++) await posted(writer, name);
    const held = ok(await next(gone, name, { job: "upkeep" }));
    assert.equal(held.task.upkeep, "document");
    const number = held.task.number as number;
    const progress = await posted(gone, name, "progress");
    const version = await call("POST", `/v1/spaces/${name}/posts`, gone.token, { kind: "version", body: "# Pages\n\nAll of them." });
    assert.equal(version.status, 201, JSON.stringify(version.body));
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${gone.peerId}`, owner.token)).status, 200);
    const again = ok(await next(gone, name));
    assert.notEqual(again.job, "upkeep", JSON.stringify(again));
    refused(await act(gone, name, number, "progress", { post_id: progress }), 403, "TASK_DENIED", owner.peerId);
    refused(await act(gone, name, number, "done", { post_id: version.body.post_id }), 403, "TASK_DENIED", owner.peerId);
  });

  test("A5. confirm and reject answer TASK_DENIED; a reject that reopens gives the KEY's rejected attempt no claim back, and it may take the task again", async () => {
    const { owner, writer, stranger, name } = await crew();
    await setting(owner, name, { task_confirmations: 1 });
    await added(owner, name);
    ok(await next(stranger, name));
    ok(await done(stranger, name, 1));
    refused(await act(stranger, name, 1, "confirm"), 403, "TASK_DENIED", owner.peerId);
    const other = await agent();
    refused(await act(other, name, 1, "reject", { reason: "No." }), 403, "TASK_DENIED", owner.peerId);
    ok(await act(writer, name, 1, "reject", { reason: "Row 4 is wrong." }));
    const reopened = await task(name, 1);
    assert.equal(reopened.state, "open", "no claim goes back to a KEY below writer");
    const again = ok(await next(stranger, name));
    assert.deepEqual([again.job, again.task.number], ["work", 1]);
  });

  test("A6. the hold limit of 3 live claims binds a KEY with no role", async () => {
    const { owner, stranger, name } = await crew();
    for (let i = 0; i < 4; i++) await added(owner, name, { title: `Page ${i + 1}` });
    for (const number of [1, 2, 3]) ok(await next(stranger, name, { number }));
    refused(await next(stranger, name, { number: 4 }), 409, "TASK_HOLD_LIMIT", "3");
  });

  test("A7. at 0 confirmations a no-role KEY's result stays done, not marked, until one member confirms; a member's is accepted at once", async () => {
    const { owner, writer, stranger, name } = await crew();
    await setting(owner, name, { task_confirmations: 0 });
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    ok(await next(stranger, name, { number: 1 }));
    const theirs = ok(await done(stranger, name, 1));
    assert.equal(theirs.task.state, "done");
    assert.deepEqual(theirs.task.confirmations, { required: 1, given: [] });
    const [row] = await fixture.owner<{ accept_after: boolean }[]>`
      select t.accept_after from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.number = 1`;
    assert.equal(row!.accept_after, false);
    // A member's own result at 0 is accepted at once, as before.
    ok(await next(writer, name, { number: 2 }));
    assert.equal(ok(await done(writer, name, 2)).task.state, "accepted");
    const confirmed = ok(await act(writer, name, 1, "confirm"));
    assert.equal(confirmed.task.state, "accepted");
  });

  test("A7. at 0 confirmations a no-role KEY's result on a held task gets no mark to accept after", async () => {
    const { owner, writer, stranger, name } = await crew();
    await setting(owner, name, { task_confirmations: 0 });
    const first = await added(owner, name);
    await added(owner, name, { title: "Page 4", after: [first.task_id] });
    ok(await done(stranger, name, 2));
    ok(await next(writer, name, { number: 1 }));
    assert.equal(ok(await done(writer, name, 1)).task.state, "accepted");
    assert.equal((await task(name, 2)).state, "done", "the release accepts no stranger's result");
  });

  test("A7. a no-role KEY's held result, its KEY made a writer later, is not accepted when its after is", async () => {
    const { owner, writer, stranger, name } = await crew();
    await setting(owner, name, { task_confirmations: 0 });
    const first = await added(owner, name);
    await added(owner, name, { title: "Page 4", after: [first.task_id] });
    ok(await done(stranger, name, 2));
    await grant(owner, name, stranger, "writer");
    ok(await next(writer, name, { number: 1 }));
    assert.equal(ok(await done(writer, name, 1)).task.state, "accepted");
    assert.equal((await task(name, 2)).state, "done", "it was a stranger's when done: a member confirms it");
  });

  test("R4. a held result whose KEY has since lost its role is not accepted when its after is", async () => {
    const { owner, writer, name } = await crew();
    await setting(owner, name, { task_confirmations: 0 });
    const gone = await agent();
    await grant(owner, name, gone, "writer");
    const first = await added(owner, name);
    await added(owner, name, { title: "Page 4", after: [first.task_id] });
    ok(await done(gone, name, 2));
    const [marked] = await fixture.owner<{ accept_after: boolean }[]>`
      select t.accept_after from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.number = 2`;
    assert.equal(marked!.accept_after, true, "a writer's held result is marked, as before");
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${gone.peerId}`, owner.token)).status, 200);
    ok(await next(writer, name, { number: 1 }));
    assert.equal(ok(await done(writer, name, 1)).task.state, "accepted");
    assert.equal((await task(name, 2)).state, "done", "its KEY ranks below writer now: a member confirms it");
  });
});

describe("A8-A9: blocks", () => {
  test("A8. five junk attempts fill the cap; a block frees their slots, and the dry run agrees with the write each time", async () => {
    const { owner, writer, name } = await crew();
    await added(owner, name);
    const junk: Agent[] = [];
    for (let i = 0; i < 5; i++) {
      const k = await agent();
      junk.push(k);
      ok(await done(k, name, 1));
    }
    const post = await posted(writer, name);
    const body = { kind: "result", body: "Page 3, done right.", title: "Page 3", task: { number: 1 } };
    const dry = await call("POST", `/v1/spaces/${name}/posts`, writer.token, { ...body, dry_run: true });
    refused(dry, 409, "TASK_LIMIT", "attempts: 5");
    refused(await act(writer, name, 1, "done", { post_id: post }), 409, "TASK_LIMIT", "attempts: 5");
    // A block in the SPACE frees one slot.
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${junk[0]!.peerId}`, owner.token)).status, 200);
    const [counted] = await fixture.owner<{ n: number }[]>`
      select schellingaf.task_attempts_live(t.task_id, t.cycle) as n
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id where s.name = ${name} and t.number = 1`;
    assert.equal(counted!.n, 4);
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, writer.token, { ...body, dry_run: true })).status, 200);
    ok(await act(writer, name, 1, "done", { post_id: post }));
    // An operator's block frees another, for the POST and its dry run alike.
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = ${Buffer.from(junk[1]!.peerId, "hex")}`;
    const late = await agent();
    await grant(owner, name, late, "writer");
    const lateBody = { kind: "result", body: "Page 3, again.", title: "Page 3", task: { number: 1 } };
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, late.token, { ...lateBody, dry_run: true })).status, 200);
    const out = await call("POST", `/v1/spaces/${name}/posts`, late.token, lateBody);
    assert.equal(out.status, 201, JSON.stringify(out.body));
  });

  test("A9. a KEY with no role blocked in the SPACE meets WRITE_BLOCKED after the rank check", async () => {
    const { owner, stranger, name } = await crew();
    await added(owner, name);
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${stranger.peerId}`, owner.token)).status, 200);
    refused(await next(stranger, name), 403, "WRITE_BLOCKED", owner.peerId);
    refused(await next(stranger, name, { number: 1 }), 403, "WRITE_BLOCKED", owner.peerId);
  });
});

describe("A10-A13: where a KEY with no role still meets a refusal, and the join answer", () => {
  test("A10. invite and request spaces refuse it; an oracle space keeps no tasks; add, change, retire and delete stay a member's", async () => {
    const owner = await agent();
    const stranger = await agent();
    for (const join_policy of ["request", "invite"]) {
      const name = await space(owner, { join_policy });
      await added(owner, name);
      refused(await next(stranger, name), 403, "TASK_DENIED", owner.peerId);
      refused(await next(stranger, name, { number: 1 }), 403, "TASK_DENIED", owner.peerId);
      refused(await act(stranger, name, 1, "done", { post_id: await posted(owner, name) }), 403, "TASK_DENIED", owner.peerId);
    }
    const oracle = `open-oracle-${process.pid}-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: oracle, title: "Oracle", visibility: "public", oracle: true })).status, 201);
    refused(await next(stranger, oracle), 409, "ORACLE_HAS_NO_TASKS");
    const name = await space(owner);
    const t = await added(owner, name);
    refused(await call("POST", `/v1/spaces/${name}/tasks`, stranger.token, { title: "Mine" }), 403, "TASK_DENIED", owner.peerId);
    refused(await act(stranger, name, 1, "change", { revision: t.revision, reason: "Clearer.", title: "Page three" }), 403, "TASK_DENIED", owner.peerId);
    refused(await act(stranger, name, 1, "retire", { reason: "Done elsewhere." }), 403, "TASK_DENIED", owner.peerId);
    refused(await act(stranger, name, 1, "delete", { reason: "Mistake." }), 403, "TASK_DENIED", owner.peerId);
    // The same KEY in that open SPACE takes the task and finishes it.
    assert.equal(ok(await next(stranger, name)).task.number, 1);
    assert.equal(ok(await done(stranger, name, 1)).task.state, "done");
  });

  test("A11. once the SPACE is open no more, its next call meets TASK_DENIED", async () => {
    const { owner, stranger, name } = await crew();
    await added(owner, name);
    ok(await next(stranger, name));
    const post = await posted(stranger, name);
    await setting(owner, name, { join_policy: "request" });
    refused(await act(stranger, name, 1, "done", { post_id: post }), 403, "TASK_DENIED", owner.peerId);
    refused(await next(stranger, name), 403, "TASK_DENIED", owner.peerId);
  });

  test("A12. taking a task spends no ask and grants nothing", async () => {
    const { owner, stranger, name } = await crew();
    await added(owner, name);
    ok(await next(stranger, name));
    const asks = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.rate_buckets where key like ${`req:%${stranger.peerId}%`}`;
    assert.equal(asks[0]!.n, 0);
    assert.equal(await memberships(name, stranger), 0);
  });

  test("A13. a join of an open SPACE answers start start-tasks while a task waits, and says to take one; none once every task is accepted", async () => {
    const { owner, writer, stranger, name } = await crew();
    const empty = ok(await call("POST", `/v1/spaces/${name}/join`, stranger.token, {}));
    assert.equal(empty.state, "open");
    assert.equal("start" in empty, false);
    assert.match(empty.notice, /take a task with POST \/v1\/spaces\/\{name\}\/tasks\/next and \{"job":"work"\}/);
    await setting(owner, name, { task_confirmations: 0 });
    await added(owner, name);
    const waiting = ok(await call("POST", `/v1/spaces/${name}/join`, stranger.token, {}));
    assert.equal(waiting.start, "start-tasks");
    ok(await next(writer, name));
    ok(await done(writer, name, 1));
    const after = ok(await call("POST", `/v1/spaces/${name}/join`, stranger.token, {}));
    assert.equal("start" in after, false);
  });
});
