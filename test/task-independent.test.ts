// A check by a KEY that did not do the work it audits: migrations/0147_task_corrections.sql,
// the lines marked C. A task's independent_of names up to 8 tasks of its SPACE; a doer of one
// of them, the submitter of any attempt at it in any cycle or the author of the post of its
// accepted attempt, may neither confirm nor reject this task, and next never offers it the
// check. A confirmation stops counting once its KEY becomes such a doer. A task that names
// none answers as before. These drive the rules through the routes, as an agent would, and
// read the database only to set a scene a route cannot. After every case,
// task_mirror_faults() answers nothing.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { useService, fixture, call, connector, type Agent, agent } from "./lib/service.ts";
import { mirrorChecked, followDoneAt } from "./lib/mirror.ts";
import { SUPERUSER } from "./bootstrap.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_independent", { apiHost: "api.task-independent.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/** The owner, a coordinator and six writers of one public work space; two confirmations unless set. */
async function crew(confirmations?: number) {
  const owner = await agent();
  const coordinator = await agent();
  const writers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => agent()));
  const name = `independent-${process.pid}-${n++}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Audit", visibility: "public" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await grant(owner, name, coordinator, "coordinator");
  for (const w of writers) await grant(owner, name, w, "writer");
  if (confirmations !== undefined) {
    const set = await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: confirmations });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  const [a, b, c, d, e, f] = writers as [Agent, Agent, Agent, Agent, Agent, Agent];
  return { owner, coordinator, a, b, c, d, e, f, name };
}

async function add(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  return call("POST", `/v1/spaces/${name}/tasks?detail=full`, who.token, { title: "Transcribe page 3", ...fields });
}

async function added(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  const out = await add(who, name, fields);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.task as Record<string, any>;
}

async function next(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  return call("POST", `/v1/spaces/${name}/tasks/next`, who.token, fields);
}

async function act(who: Agent, name: string, number: number, action: string, fields?: Record<string, unknown>, detail = "full") {
  return call("POST", `/v1/spaces/${name}/tasks/${number}/${action}${detail ? `?detail=${detail}` : ""}`, who.token, fields);
}

async function get(name: string, number: number, query = "") {
  const out = await call("GET", `/v1/spaces/${name}/tasks/${number}${query}`);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body as Record<string, any>;
}

async function result(who: Agent, name: string, body = "Page 3, transcribed.") {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind: "result", body, title: "Page 3", fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

async function done(who: Agent, name: string, number: number, post?: string) {
  return act(who, name, number, "done", { post_id: post ?? await result(who, name) });
}

async function check(who: Agent, name: string, number: number, verdict: "confirm" | "reject", fields: Record<string, unknown> = {}) {
  return act(who, name, number, verdict, verdict === "reject" ? { reason: "Row 4 is wrong.", ...fields } : fields);
}

function refused(out: { status: number; body: any }, status: number, code: string, detail?: string) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
  if (detail !== undefined) assert.equal(out.body.error.detail, detail);
}

function ok(out: { status: number; body: any }) {
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

/** Task 1, the work, and task 2, its audit, which a doer of task 1 may not check. */
async function audited(owner: Agent, name: string, audit: Record<string, unknown> = {}) {
  const work = await added(owner, name);
  const check = await added(owner, name, { title: "Audit page 3", independent_of: [1], ...audit });
  return { work, check };
}

/** A scene a route cannot make: task `number` done `hours` ago. */
async function doneAgo(name: string, number: number, hours: number) {
  await fixture.owner`
    update schellingaf.tasks t set done_at = now() - make_interval(hours => ${hours})
      from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
  await followDoneAt(name);
}

describe("independent_of on a task", () => {
  test("1. add takes it: the answer, the list, compact and full, and get show it with its numbers; a task without it shows neither", async () => {
    const { owner, name } = await crew();
    const { work, check: audit } = await audited(owner, name);
    assert.deepEqual([audit.independent_of, audit.independent_of_numbers], [[work.task_id], [1]]);
    assert.equal("independent_of" in work, false);
    assert.equal("independent_of_numbers" in work, false);
    const full = await call("GET", `/v1/spaces/${name}/tasks?detail=full`);
    const listed = (number: number) => full.body.items.find((t: any) => t.number === number);
    assert.deepEqual([listed(2).independent_of, listed(2).independent_of_numbers], [[work.task_id], [1]]);
    assert.equal("independent_of" in listed(1), false);
    const compact = await call("GET", `/v1/spaces/${name}/tasks?detail=compact`);
    const row = (number: number) => compact.body.items.find((t: any) => t.number === number);
    assert.deepEqual(row(2).independent_of_numbers, [1]);
    assert.equal("independent_of_numbers" in row(1), false);
    assert.deepEqual((await get(name, 2)).task.independent_of_numbers, [1]);
    // The short answer names no more than before.
    const short = await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Audit page 4", independent_of: [1] });
    assert.deepEqual(Object.keys(short.body.task).sort(), ["number", "state", "task_id"]);
  });

  test("2. it is resolved as after is: a batch names an earlier key; a later key, an unknown task, a deleted one, an upkeep one and itself are refused; more than 8 too", async () => {
    const { owner, coordinator, name } = await crew();
    const batch = await call("POST", `/v1/spaces/${name}/tasks?detail=full`, owner.token, {
      tasks: [{ key: "work", title: "Page 3" }, { key: "audit", title: "Audit page 3", independent_of: ["work"] }],
    });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    assert.deepEqual(batch.body.tasks[1].independent_of_numbers, [1]);
    refused(await call("POST", `/v1/spaces/${name}/tasks`, owner.token, {
      tasks: [{ key: "audit", title: "Audit", independent_of: ["later"] }, { key: "later", title: "Later" }],
    }), 400, "INVALID_REQUEST", "tasks[0] (audit): independent_of[0] later is the key of no earlier task in this batch");
    refused(await add(owner, name, { independent_of: [99] }), 422, "TASK_AFTER_INVALID", "independent_of: 99");
    refused(await call("POST", `/v1/spaces/${name}/tasks`, owner.token, {
      tasks: [{ title: "Page 4" }, { key: "x", title: "Audit", independent_of: [1, 99] }],
    }), 422, "TASK_AFTER_INVALID", "tasks[1] (x): independent_of[1] 99");
    refused(await add(owner, name, { independent_of: ["not a task"] }), 400, "INVALID_REQUEST", "independent_of[0] is a task number or a task_id of this SPACE");
    refused(await add(owner, name, { independent_of: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), 400, "INVALID_REQUEST");
    // Deleted: refused. Retired: allowed, its doers stay its doers.
    const gone = await added(owner, name, { title: "Gone" });
    ok(await act(owner, name, gone.number, "delete", { reason: "Not needed." }));
    refused(await add(owner, name, { independent_of: [gone.number] }), 422, "TASK_AFTER_INVALID", "independent_of: deleted");
    const retired = await added(owner, name, { title: "Retired" });
    ok(await act(coordinator, name, retired.number, "retire", { reason: "Not needed." }));
    assert.deepEqual((await added(owner, name, { independent_of: [retired.number] })).independent_of_numbers, [retired.number]);
    // An upkeep task has no attempts, so it names nobody: refused.
    const [upkeep] = await fixture.owner<{ number: number }[]>`
      insert into schellingaf.tasks (space_id, number, title, body, upkeep, state, claimed_by, claimed_until, claim_revision, claimed_at, takes)
      select s.space_id, (select max(k.number) + 1 from schellingaf.tasks k where k.space_id = s.space_id), 'Review', 'Review the list.',
             'tasks', 'claimed', ${Buffer.from(coordinator.peerId, "hex")}, now() + interval '1 hour', 1, now(), 1
        from schellingaf.spaces s where s.name = ${name}
      returning number`;
    refused(await add(owner, name, { independent_of: [upkeep!.number] }), 422, "TASK_AFTER_INVALID", "independent_of: upkeep");
    // A change naming the task itself is refused as after is.
    refused(await act(owner, name, 2, "change", { revision: 1, reason: "Itself.", independent_of: [2] }), 422, "TASK_AFTER_INVALID", "independent_of: 2 is this task");
    // A create takes keys only, as after does.
    const created = await call("POST", "/v1/spaces", owner.token, {
      name: `${name}-made`, title: "Made", visibility: "public",
      tasks: [{ key: "work", title: "Page 3" }, { key: "audit", title: "Audit", independent_of: ["work"] }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual((await get(`${name}-made`, 2)).task.independent_of_numbers, [1]);
  });

  test("3. a doer of a named task can neither confirm nor reject: TASK_SELF_CHECK task 1; a third KEY confirms", async () => {
    const { owner, a, b, c, name } = await crew(1);
    await audited(owner, name);
    assert.equal((await done(a, name, 1)).status, 200);
    assert.equal((await done(b, name, 2)).status, 200);
    refused(await check(a, name, 2, "confirm"), 409, "TASK_SELF_CHECK", "task 1");
    refused(await check(a, name, 2, "reject"), 409, "TASK_SELF_CHECK", "task 1");
    assert.equal(ok(await check(c, name, 2, "confirm")).task.state, "accepted");
  });

  test("4. the author of the post of a named task's accepted attempt is a doer; the author of a post an attempt only names is not", async () => {
    const { owner, a, b, c, d, name } = await crew(1);
    await audited(owner, name);
    // b marks task 1 done with a's post: a wrote it, b submitted it.
    assert.equal((await done(b, name, 1, await result(a, name))).status, 200);
    assert.equal((await done(d, name, 2)).status, 200);
    // While that attempt only waits, a is no doer: naming a's post cannot bar a from checking.
    const dry = await call("POST", `/v1/spaces/${name}/posts`, a.token, {
      kind: "obs", title: "Audited", body: "Audited.", dry_run: true, task: { number: 2, check: "confirm" },
    });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    // Once it is accepted, a wrote the accepted work.
    assert.equal(ok(await check(c, name, 1, "confirm")).task.state, "accepted");
    refused(await check(a, name, 2, "confirm"), 409, "TASK_SELF_CHECK", "task 1");
    refused(await check(b, name, 2, "confirm"), 409, "TASK_SELF_CHECK", "task 1");
  });

  test("4b. at confirmations 0, the author of the post of an accepted attempt nobody confirmed is no doer: naming an honest KEY's post bars it from nothing", async () => {
    const { owner, a, b, c, d, name } = await crew(0);
    await audited(owner, name);
    // b marks task 1 done with a's post: accepted at once, confirmed by nobody.
    assert.equal((await done(b, name, 1, await result(a, name))).body.task.state, "accepted");
    // c's live claim contests task 2, so d's attempt waits for a check.
    ok(await next(c, name, { number: 2 }));
    assert.equal((await done(d, name, 2)).body.task.state, "done");
    refused(await check(b, name, 2, "confirm"), 409, "TASK_SELF_CHECK", "task 1");
    assert.equal(ok(await check(a, name, 2, "confirm")).task.state, "accepted");
  });

  test("5. a KEY whose attempt at the named task was rejected, in an earlier cycle, is still a doer", async () => {
    const { owner, a, b, c, d, name } = await crew(1);
    await audited(owner, name);
    assert.equal((await done(a, name, 1)).status, 200);
    assert.equal(ok(await check(c, name, 1, "reject")).task.cycle, 1);
    assert.equal((await done(b, name, 2)).status, 200);
    refused(await check(a, name, 2, "confirm"), 409, "TASK_SELF_CHECK", "task 1");
    assert.equal(ok(await check(d, name, 2, "confirm")).task.state, "accepted");
  });

  test("6. next never offers the check to a doer of a named task: job check stops, job any passes it by; a third KEY is offered it", async () => {
    const { owner, a, b, c, name } = await crew(1);
    await audited(owner, name);
    assert.equal((await done(a, name, 1)).status, 200);
    assert.equal((await done(b, name, 2)).status, 200);
    await doneAgo(name, 2, 2);
    const asked = ok(await next(a, name, { job: "check" }));
    assert.equal(asked.job, "stop");
    assert.equal(asked.why, NEXT_WORDS.why.stop_check);
    assert.equal(ok(await next(a, name)).job, "stop", "neither check first nor check when idle");
    const third = ok(await next(c, name, { job: "check" }));
    assert.deepEqual([third.job, third.task.number], ["check", 1]);
    const first = ok(await next(c, name));
    assert.deepEqual([first.job, first.task.number], ["check", 2], "check first: done two hours ago");
  });

  test("6b. next's offer cap counts no confirmation of a KEY that has since done a named task: check first and check when idle", async () => {
    for (const aged of [false, true]) {
      const { owner, b, c, d, e, f, name } = await crew(2);
      await audited(owner, name);
      assert.equal((await done(b, name, 2)).status, 200);
      ok(await check(c, name, 2, "confirm"));
      assert.equal((await done(c, name, 1)).status, 200);
      ok(await check(d, name, 1, "confirm"));
      assert.equal(ok(await check(f, name, 1, "confirm")).task.state, "accepted");
      if (aged) await doneAgo(name, 2, 2);
      // d is offered task 2: one live offer, and c's confirmation no longer counts, so e is too.
      assert.equal(ok(await next(d, name)).task.number, 2);
      const out = ok(await next(e, name));
      assert.deepEqual([out.job, out.task?.number, out.why === NEXT_WORDS.why.check_idle.replace("{number}", "2")], ["check", 2, !aged], `aged ${aged}`);
    }
  });

  test("6c. the review's unchecked signal names a task whose only confirmation is by a KEY that has since done a named task", async () => {
    const { owner, coordinator, b, c, name } = await crew(2);
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { upkeep_document_after: 0 })).status, 200);
    await audited(owner, name);
    assert.equal((await done(b, name, 2)).status, 200);
    ok(await check(c, name, 2, "confirm"));
    assert.equal((await done(c, name, 1)).status, 200);
    await doneAgo(name, 2, 25);
    const out = ok(await next(coordinator, name, { job: "upkeep" }));
    const fill = (text: string, values: Record<string, string | number>) =>
      Object.entries(values).reduce<string>((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);
    assert.equal(out.why, fill(NEXT_WORDS.why.upkeep_tasks, {
      signals: fill(NEXT_WORDS.signals.unchecked, { tasks: fill(NEXT_WORDS.tasks.one, { numbers: 2 }), hours: 24 }),
    }));
  });

  test("7. at confirmations 0, a doer of a named task cannot concede to another's attempt", async () => {
    const { owner, a, b, c, name } = await crew(0);
    await audited(owner, name);
    assert.equal((await done(a, name, 1)).body.task.state, "accepted");
    // c's live claim contests task 2, so b's attempt waits; a makes one too.
    ok(await next(c, name, { number: 2 }));
    assert.equal((await done(b, name, 2)).body.task.state, "done");
    assert.equal((await done(a, name, 2)).body.attempt, 2);
    refused(await check(a, name, 2, "confirm", { attempt: 1 }), 409, "TASK_SELF_CHECK", "task 1");
    assert.equal(ok(await check(c, name, 2, "confirm", { attempt: 1 })).task.state, "accepted");
  });

  test("8b. independent_of changes only with a revision, and never on a done task", async () => {
    const { owner, a, name } = await crew();
    await audited(owner, name);
    const set = (number: number) => fixture.owner`
      update schellingaf.tasks t set independent_of = '{}'
        from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
    await assert.rejects(set(2), /IMMUTABLE_RECORD/);
    assert.equal((await done(a, name, 2)).status, 200);
    await assert.rejects(set(2), /IMMUTABLE_RECORD/);
  });

  test("8. change sets and clears it with a revision; history shows the earlier value; a done task's other words never change", async () => {
    const { owner, coordinator, a, name } = await crew();
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    await added(owner, name, { title: "Audit" });
    const set = ok(await act(coordinator, name, 3, "change", { revision: 1, reason: "Audits both.", independent_of: [1, 2] }));
    assert.deepEqual([set.task.revision, set.task.independent_of_numbers], [2, [1, 2]]);
    const cleared = ok(await act(coordinator, name, 3, "change", { revision: 2, reason: "Anybody may.", independent_of: [] }));
    assert.equal(cleared.task.revision, 3);
    assert.equal("independent_of" in cleared.task, false);
    const history = (await get(name, 3, "?history=true")).history as any[];
    assert.deepEqual(history.map((h) => [h.revision, h.independent_of_numbers ?? null]), [[2, [1, 2]], [1, null]]);
    refused(await act(owner, name, 3, "change", { revision: 3, reason: "x", independent_of: null }), 400, "INVALID_REQUEST", "independent_of is a list: send [] to name no task");
    assert.equal((await done(a, name, 3)).status, 200);
    refused(await act(coordinator, name, 3, "change", { revision: 3, reason: "Too late.", title: "Audit both", independent_of: [1] }), 409, "TASK_NOT_OPEN", "done");
    ok(await act(coordinator, name, 1, "retire", { reason: "Gone." }));
    refused(await act(coordinator, name, 1, "change", { revision: 1, reason: "x", independent_of: [2] }), 409, "TASK_NOT_OPEN", "retired");
  });

  test("8c. a coordinator may change independent_of alone on a done or accepted task; a writer may not; then the KEY it barred may reject it", async () => {
    const { owner, coordinator, a, b, c, d, name } = await crew(1);
    await audited(owner, name);
    assert.equal((await done(a, name, 1)).status, 200);
    assert.equal((await done(b, name, 2)).status, 200);
    assert.equal(ok(await check(c, name, 2, "confirm")).task.state, "accepted");
    refused(await check(a, name, 2, "reject"), 409, "TASK_SELF_CHECK", "task 1");
    const dry = { kind: "obs", title: "Audit", body: "Audited.", dry_run: true, task: { number: 2, check: "reject", reason: "Row 4." } };
    refused(await call("POST", `/v1/spaces/${name}/posts`, a.token, dry), 409, "TASK_SELF_CHECK", "task 1");
    refused(await act(d, name, 2, "change", { revision: 1, reason: "Let a check.", independent_of: [] }), 409, "TASK_NOT_OPEN", "accepted");
    refused(await act(coordinator, name, 2, "change", { revision: 1, reason: "Retitled.", title: "Audit", independent_of: [] }), 409, "TASK_NOT_OPEN", "accepted");
    const changed = ok(await act(coordinator, name, 2, "change", { revision: 1, reason: "Let a check.", independent_of: [] }));
    assert.deepEqual([changed.task.state, changed.task.revision, "independent_of" in changed.task], ["accepted", 2, false]);
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, a.token, dry)).status, 200);
    assert.equal(ok(await check(a, name, 2, "reject")).task.state, "claimed");
  });

  test("9. a retire's replacements take it; a task whose independent_of names the retired task names its replacements too", async () => {
    const { owner, coordinator, name } = await crew();
    await audited(owner, name);
    await added(owner, name, { title: "Audit page 3 again", independent_of: [1] });
    const out = ok(await act(coordinator, name, 1, "retire", {
      reason: "Split in two.",
      tasks: [{ key: "left", title: "Page 3, left" }, { key: "right", title: "Page 3, right", independent_of: ["left"] }],
    }));
    assert.deepEqual(out.tasks.map((t: any) => t.number), [4, 5]);
    assert.deepEqual(out.tasks[1].independent_of_numbers, [4]);
    assert.deepEqual(out.dependents, [], "dependents are the tasks that waited for it");
    const audit = (await get(name, 2, "?history=true"));
    assert.deepEqual([audit.task.independent_of_numbers, audit.task.revision], [[1, 4, 5], 2]);
    assert.equal(audit.task.changed.reason, "replaced: task 1 retired");
    assert.deepEqual(audit.history[0].independent_of_numbers, [1]);
  });

  test("9c. a retire without replacements leaves a task naming it unrevised", async () => {
    const { owner, coordinator, name } = await crew();
    await audited(owner, name);
    ok(await act(coordinator, name, 1, "retire", { reason: "Gone." }));
    const t = (await get(name, 2)).task;
    assert.deepEqual([t.revision, t.independent_of_numbers, t.changed], [1, [1], undefined]);
  });

  test("9d. the claimant of a task that names the retired task in independent_of alone is told task_changed", async () => {
    const { owner, coordinator, d, name } = await crew();
    await audited(owner, name);
    ok(await next(d, name, { number: 2 }));
    ok(await act(coordinator, name, 1, "retire", { reason: "Split.", tasks: [{ title: "Page 3a" }] }));
    const mailbox = await call("GET", "/v1/mailbox", d.token);
    assert.equal(mailbox.status, 200, JSON.stringify(mailbox.body));
    const changed = (mailbox.body.items as any[]).filter((i) => i.reason === "task_changed");
    assert.deepEqual(changed.map((i) => i.task.number), [2]);
  });

  test("9b. a retire whose replacements would put more than 8 tasks in a dependent's independent_of retires nothing", async () => {
    const { owner, coordinator, name } = await crew();
    for (let i = 0; i < 8; i++) await added(owner, name, { title: `Page ${i + 1}` });
    await added(owner, name, { title: "Audit", independent_of: [1, 2, 3, 4, 5, 6, 7, 8] });
    refused(await act(coordinator, name, 1, "retire", { reason: "Split.", tasks: [{ title: "1a" }] }),
      422, "TASK_AFTER_INVALID", "independent_of would hold more than 8 tasks: task 9");
    assert.equal((await get(name, 1)).task.state, "open");
  });

  test("10. delete erases it; a task another's independent_of names may be deleted", async () => {
    const { owner, name } = await crew();
    await audited(owner, name);
    ok(await act(owner, name, 1, "delete", { reason: "Not needed." }));
    ok(await act(owner, name, 2, "delete", { reason: "Not needed." }));
    const [row] = await fixture.owner<{ independent_of: string[] }[]>`
      select t.independent_of from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.number = 2`;
    assert.deepEqual(row!.independent_of, []);
  });

  test("11. a POST's task check by a doer of a named task: the dry run and the write are both TASK_SELF_CHECK task 1", async () => {
    const { owner, a, b, name } = await crew(1);
    await audited(owner, name);
    assert.equal((await done(a, name, 1)).status, 200);
    assert.equal((await done(b, name, 2)).status, 200);
    for (const dry_run of [true, false]) {
      refused(await call("POST", `/v1/spaces/${name}/posts`, a.token, {
        kind: "obs", title: "Audited", body: "Audited.", dry_run, task: { number: 2, check: "reject", reason: "Row 4." },
      }), 409, "TASK_SELF_CHECK", "task 1");
    }
  });

  test("B4 and R10: a doer of a named task cannot reject the accepted task; a confirmation stops counting once its KEY becomes a doer", async () => {
    const { owner, a, b, c, d, e, f, name } = await crew(2);
    await audited(owner, name);
    assert.equal((await done(b, name, 2)).status, 200);
    assert.equal((await done(f, name, 2)).body.attempt, 2);
    ok(await check(c, name, 2, "confirm", { attempt: 1 }));
    // c then works on task 1: its confirmation of task 2 no longer counts, anywhere it is named.
    assert.equal((await done(c, name, 1)).status, 200);
    const now = (await get(name, 2)).task;
    assert.deepEqual(now.confirmations, { required: 2, given: [] });
    assert.deepEqual(now.attempts.map((x: any) => x.confirmations), [[], []]);
    assert.equal(ok(await check(d, name, 2, "confirm", { attempt: 1 })).task.state, "done", "one of two that count");
    assert.equal(ok(await check(e, name, 2, "confirm", { attempt: 1 })).task.state, "accepted");
    refused(await check(c, name, 2, "reject"), 409, "TASK_SELF_CHECK", "task 1");
    // A KEY that did neither task may still reopen it.
    assert.equal(ok(await check(a, name, 2, "reject")).task.state, "claimed");
  });

  test("the connector takes independent_of on add and change, and shows it", async () => {
    const { owner, name } = await crew();
    await added(owner, name);
    const say = async (args: Record<string, unknown>) =>
      (await connector("tools/call", { name: "schellingaf_task", arguments: { space: name, ...args } }, owner)).message.result.content[0].text as string;
    await say({ action: "add", title: "Audit page 3", independent_of: [1] });
    assert.match(await say({ action: "get", number: 2 }), /checked by no doer of task 1 \(task_id [0-9a-f-]{36}\)/);
    await say({ action: "add", tasks: [{ key: "w", title: "Page 4" }, { title: "Audit page 4", independent_of: ["w"] }] });
    assert.deepEqual((await get(name, 4)).task.independent_of_numbers, [3]);
    await say({ action: "change", number: 2, revision: 1, reason: "Both pages.", independent_of: [1, 3] });
    assert.deepEqual((await get(name, 2)).task.independent_of_numbers, [1, 3]);
    assert.match(await say({ action: "list" }), /2 {2}open, independent of 1 3 {2}- {2}Audit page 3/);
  });
});

describe("the plans", () => {
  test("12. next's probe of a doer reads task_attempts by its index, never a Seq Scan", async () => {
    const { owner, a, b, c, name } = await crew(1);
    await audited(owner, name);
    // Three thousand accepted tasks, each with an attempt, so a walk of the attempts shows.
    const post = await result(owner, name);
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by, state, claimed_by, done_post_id, done_at, accepted_at,
                                     attempts, attempt)
      select s.space_id, g + 100, 'task ' || g, s.owner_id, 'accepted', s.owner_id, ${post}::uuid, now(), now(), 1, 1
        from schellingaf.spaces s cross join generate_series(1, 3000) g where s.name = ${name}`;
    await fixture.owner`
      insert into schellingaf.task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id, at)
      select t.task_id, t.space_id, 1, 0, t.claimed_by, t.done_post_id, t.claimed_by, t.done_at
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id where s.name = ${name} and t.number > 100`;
    assert.equal((await done(a, name, 1)).status, 200);
    assert.equal((await done(b, name, 2)).status, 200);
    await fixture.owner`analyze schellingaf.task_attempts`;
    await fixture.owner`analyze schellingaf.tasks`;

    type PlanNode = { [field: string]: any; Plans?: PlanNode[] };
    const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
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
        for (const who of [a, c]) {
          await tx`select schellingaf.next_job(${name}, ${Buffer.from(who.peerId, "hex")}, 'check', null, null, ${tx.json(NEXT_WORDS as never)})`;
        }
      });
    } finally {
      await su.end({ timeout: 5 });
    }
    const plans = logged.filter((m) => m.includes("{")).map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
    const probes = plans.filter((p) => /a\.peer_id = p_peer/.test(p["Query Text"]));
    assert.ok(probes.length > 0, plans.map((p) => p["Query Text"]).join("\n--\n"));
    const scans = probes.flatMap((p) => nodesOf(p.Plan)).filter((x) => x["Relation Name"] || x["Index Name"]);
    const shown = JSON.stringify(scans, ["Node Type", "Relation Name", "Alias", "Index Name", "Index Cond", "Filter"], 1);
    assert.ok(scans.some((x) => x["Relation Name"] === "task_attempts" && /^task_attempts_/.test(x["Index Name"] ?? "")), shown);
    assert.ok(!scans.some((x) => x["Node Type"] === "Seq Scan"), shown);
  });
});
