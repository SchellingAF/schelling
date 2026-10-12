// A finished SPACE retires its leftover tasks: migrations/0162_open_tasks_finished.sql, the
// lines marked finished (0162). When a decider makes current a version whose stage is
// finished (finished_stage(), FINISHED_STAGES), the trigger space_stages_finished retires
// every open and claimed task of the SPACE, upkeep included, through
// retire_finished_tasks(), as the transaction commits, and tells nobody: a holder's next
// call meets TASK_NOT_OPEN retired. Tasks added in that same transaction, as a create's,
// stay open. Done and accepted tasks stay; a stage moving back reopens nothing; next makes
// no new upkeep there. These
// drive the rules through the routes, and read the database to set a scene a route cannot.
// After every case, task_mirror_faults() answers nothing.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { useService, fixture, call, agent, app, db, config, type Agent, type App } from "./lib/service.ts";
import { SUPERUSER } from "./bootstrap.ts";
import { mirrorChecked } from "./lib/mirror.ts";
import { claimUntil } from "./lib/claims.ts";
import { createApp } from "../src/http/app.ts";
import { FINISHED_STAGES } from "../src/surface/vocabulary.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_finished", { apiHost: "api.task-finished.test" });
mirrorChecked();
let reviewer: Agent;
let reviewerApp: App;
before(async () => {
  await ready;
  reviewer = await agent();
  // The same database with the service's reviewer named, as production runs.
  reviewerApp = createApp({ ...config, oracleReviewer: reviewer.peerId }, db);
});

let n = 0;

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function added(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  const out = await call("POST", `/v1/spaces/${name}/tasks?detail=full`, who.token, { title: `Page ${n++}`, ...fields });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.task as Record<string, any>;
}

async function next(who: Agent, name: string, fields: Record<string, unknown> = {}) {
  const out = await call("POST", `/v1/spaces/${name}/tasks/next`, who.token, fields);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body as Record<string, any>;
}

async function act(who: Agent, name: string, number: number, action: string, fields: Record<string, unknown> = {}) {
  const out = await call("POST", `/v1/spaces/${name}/tasks/${number}/${action}?detail=full`, who.token, fields);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body as Record<string, any>;
}

async function post(who: Agent, name: string, fields: Record<string, unknown>, via: App = app) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, fields, via);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body as Record<string, any>;
}

async function result(who: Agent, name: string) {
  return (await post(who, name, { kind: "result", title: "Page", body: `Page ${n++}, transcribed.` })).post_id as string;
}

/** The current version of the SPACE's document, if any. */
async function currentVersion(name: string): Promise<string | undefined> {
  return (await call("GET", `/v1/spaces/${name}`)).body.document?.version?.post_id;
}

/** A version that goes current at once, by a decider, carrying a stage word. */
async function staged(who: Agent, name: string, word: string, via: App = app, extra: Record<string, unknown> = {}) {
  const supersedes = await currentVersion(name);
  const out = await post(who, name, {
    kind: "version", body: `# Status\n\n${word} ${n++}`, data: { stage: { word } }, ...(supersedes ? { supersedes } : {}), ...extra,
  }, via);
  assert.deepEqual(out.oracle, { state: "current" }, JSON.stringify(out));
  return out;
}

async function states(name: string) {
  const out = await call("GET", `/v1/spaces/${name}/tasks?state=all&detail=full&limit=200`);
  if (out.status !== 200) {
    const rows = await fixture.owner<{ number: number; state: string }[]>`
      select t.number, t.state from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} order by t.number`;
    return Object.fromEntries(rows.map((r) => [r.number, r.state]));
  }
  return Object.fromEntries((out.body.items as any[]).map((t) => [t.number, t.state]));
}

async function rowStates(name: string) {
  const rows = await fixture.owner<{ number: number; state: string; close_reason: string | null; closed_by: Buffer | null }[]>`
    select t.number, t.state, t.close_reason, t.closed_by from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
     where s.name = ${name} order by t.number`;
  return rows;
}

async function retiredNotices(who: Agent) {
  const out = await call("GET", "/v1/mailbox?reason=task_retired", who.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.items as any[];
}

/** The owner, a coordinator, two writers and a KEY with no role of one open public work space that keeps a document. */
async function crew(extra: Record<string, unknown> = {}) {
  const owner = await agent();
  const coordinator = await agent();
  const a = await agent();
  const b = await agent();
  const stranger = await agent();
  const name = `finished-${process.pid}-${n++}`;
  const made = await call("POST", "/v1/spaces", owner.token, {
    name, title: "Proposal", visibility: "public", join_policy: "open", document: true, ...extra,
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await grant(owner, name, coordinator, "coordinator");
  await grant(owner, name, a, "writer");
  await grant(owner, name, b, "writer");
  return { owner, coordinator, a, b, stranger, name };
}

describe("finished_stage()", () => {
  test("holds FINISHED_STAGES exactly", async () => {
    for (const word of FINISHED_STAGES) {
      const [row] = await fixture.owner<{ f: boolean }[]>`select schellingaf.finished_stage(${word}) as f`;
      assert.equal(row!.f, true, word);
    }
    for (const word of ["accepted", "proposed", "in-progress", "merged-later", "Merged"]) {
      const [row] = await fixture.owner<{ f: boolean }[]>`select schellingaf.finished_stage(${word}) as f`;
      assert.equal(row!.f, false, word);
    }
    // The literal in the function is the vocabulary's list, word for word.
    const [def] = await fixture.owner<{ src: string }[]>`
      select pg_get_functiondef('schellingaf.finished_stage(text)'::regprocedure) as src`;
    const words = [...def!.src.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
    assert.deepEqual(words.sort(), [...FINISHED_STAGES].sort());
  });
});

describe("a finished stage retires the leftover tasks", () => {
  test("B1, B2. a coordinator's merged version retires open and claimed tasks, live and lapsed claims, a stranger's too; done and accepted stay; nobody is told", async () => {
    const { owner, coordinator, a, b, stranger, name } = await crew();
    await added(owner, name); // 1 open
    await added(owner, name); // 2 claimed by a
    await added(owner, name); // 3 claimed by the stranger
    await added(owner, name); // 4 claimed by b, lapsed
    await added(owner, name); // 5 done by a
    await next(a, name, { number: 2 });
    await next(stranger, name, { number: 3 });
    await next(b, name, { number: 4 });
    await claimUntil(name, 4, "-1 minute", b.peerId);
    await next(a, name, { number: 5 });
    await act(a, name, 5, "done", { post_id: await result(a, name) });
    const before = { a: (await retiredNotices(a)).length, b: (await retiredNotices(b)).length, s: (await retiredNotices(stranger)).length };
    const kept = await result(stranger, name);

    await staged(coordinator, name, "merged");
    const rows = await rowStates(name);
    assert.deepEqual(rows.map((r) => [r.number, r.state]), [[1, "retired"], [2, "retired"], [3, "retired"], [4, "retired"], [5, "done"]]);
    for (const r of rows.filter((x) => x.state === "retired")) {
      assert.equal(r.close_reason, "stage merged: the SPACE is finished");
      assert.equal(r.closed_by, null);
    }
    const [claims] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.task_claims c join schellingaf.spaces s on s.space_id = c.space_id where s.name = ${name}`;
    assert.equal(claims!.n, 0, "every claim ends");
    // No KEY is told (a notice would lock mailboxes out of order inside append_post()); a
    // holder's next call says the task is retired.
    assert.deepEqual([(await retiredNotices(a)).length, (await retiredNotices(b)).length, (await retiredNotices(stranger)).length],
                     [before.a, before.b, before.s]);
    const late = await call("POST", `/v1/spaces/${name}/tasks/3/done`, stranger.token, { post_id: kept });
    assert.equal(late.status, 409, JSON.stringify(late.body));
    assert.deepEqual([late.body.error.code, late.body.error.detail], ["TASK_NOT_OPEN", "retired"]);
    // B2: members are still offered the check of the done task.
    const check = await next(b, name, { job: "check" });
    assert.deepEqual([check.job, check.task.number], ["check", 5]);
  });

  test("B1. a task-list review held by a coordinator is retired too", async () => {
    const { owner, coordinator, name } = await crew();
    await staged(owner, name, "accepted");
    await added(owner, name);
    // A scene a route cannot make: the last review was ten hours ago, so the version decided
    // since calls for one.
    await fixture.owner`
      insert into schellingaf.task_upkeep (space_id, last_review_at)
      select s.space_id, now() - interval '10 hours' from schellingaf.spaces s where s.name = ${name}
      on conflict (space_id) do update set last_review_at = excluded.last_review_at`;
    await fixture.owner`
      update schellingaf.oracle_versions v set decided_at = now() - interval '1 hour'
        from schellingaf.spaces s where s.space_id = v.space_id and s.name = ${name} and v.state = 'current'`;
    const review = await next(coordinator, name, { job: "upkeep" });
    assert.deepEqual([review.job, review.task.upkeep, review.task.state], ["upkeep", "tasks", "claimed"]);
    await staged(owner, name, "done");
    assert.deepEqual((await rowStates(name)).map((r) => [r.number, r.state]), [[1, "retired"], [review.task.number, "retired"]]);
  });

  test("a stage set by a writer's version waits for a decider, and one the service's reviewer makes current sets none: nothing retires", async () => {
    const { owner, a, name } = await crew();
    const v1 = await staged(owner, name, "accepted");
    await added(owner, name);
    // A writer's staged version waits for a decision: its stage is set by nobody yet.
    const p = await post(a, name, { kind: "version", body: "# Status\n\nmerged", supersedes: v1.post_id, data: { stage: { word: "merged" } } });
    assert.equal(p.oracle.state, "pending");
    assert.deepEqual(await states(name), { 1: "open" });
    // The reviewer, a coordinator here, makes its own version current, and sets no stage.
    await grant(owner, name, reviewer, "coordinator");
    const current = (await call("GET", `/v1/spaces/${name}`)).body.document;
    const r = await post(reviewer, name, { kind: "version", body: "# Status\n\nclosed", supersedes: current.version.post_id, data: { stage: { word: "closed" } } }, reviewerApp);
    assert.equal(r.oracle.state, "current", JSON.stringify(r));
    assert.equal((await call("GET", `/v1/spaces/${name}`)).body.stage.word, "accepted");
    assert.deepEqual(await states(name), { 1: "open" });
    // The owner's finished stage retires it.
    await staged(owner, name, "merged");
    assert.deepEqual(await states(name), { 1: "retired" });
  });

  test("B3. a done task held by a task that retires is held no more", async () => {
    const { owner, a, coordinator, name } = await crew();
    const first = await added(owner, name);
    await added(owner, name, { after: [first.task_id] });
    await act(a, name, 2, "done", { post_id: await result(a, name) });
    assert.equal((await act(a, name, 2, "done", { post_id: await result(a, name) })).task.check_waits_for, 1);
    await staged(coordinator, name, "merged");
    const out = await call("GET", `/v1/spaces/${name}/tasks/2`);
    assert.equal(out.body.task.state, "done");
    assert.equal("check_waits_for" in out.body.task, false);
  });

  test("B4, B5, B6. tasks added while finished stay open and next hands them out; a stage moving back reopens nothing; a later finished version retires what opened since", async () => {
    const { owner, coordinator, a, name } = await crew();
    await added(owner, name);
    await staged(coordinator, name, "merged");
    assert.deepEqual(await states(name), { 1: "retired" });
    // B6: added while finished, it stays open, and next hands it out.
    await added(owner, name);
    assert.deepEqual(await states(name), { 1: "retired", 2: "open" });
    assert.equal((await next(a, name)).task.number, 2);
    // Help-wanted leaves the SPACE out.
    const listed = await call("GET", `/v1/spaces?prefix=${name}&open_tasks=true`);
    assert.deepEqual(listed.body.items.map((i: any) => i.name), []);
    // B5: back to an unfinished word: nothing reopens, nothing retires.
    await staged(coordinator, name, "accepted");
    assert.deepEqual(await states(name), { 1: "retired", 2: "claimed" });
    await added(owner, name);
    // B4: finished again, the tasks opened since retire.
    await staged(owner, name, "closed");
    assert.deepEqual(await states(name), { 1: "retired", 2: "retired", 3: "retired" });
  });

  test("B7. next makes no new upkeep in a finished SPACE", async () => {
    const { owner, a, name } = await crew();
    await staged(owner, name, "merged");
    for (let i = 0; i < 3; i++) await result(a, name);
    const out = await next(a, name, { job: "upkeep" });
    assert.equal(out.job, "stop");
    const [row] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.upkeep is not null`;
    assert.equal(row!.n, 0);
  });

  test("B9. the stage version hidden afterwards: its tasks stay retired, and the help-wanted list counts it unfinished again", async () => {
    const { owner, coordinator, name } = await crew();
    await added(owner, name);
    const v = await staged(coordinator, name, "merged");
    assert.equal((await call("PUT", `/v1/posts/${v.post_id}/hidden`, owner.token, {})).status, 200);
    assert.deepEqual(await states(name), { 1: "retired" });
    await added(owner, name);
    const listed = await call("GET", `/v1/spaces?prefix=${name}&open_tasks=true`);
    assert.deepEqual(listed.body.items.map((i: any) => i.name), [name]);
  });
});

describe("the trigger runs at commit", () => {
  test("R3. a POST that sets a finished stage and finishes a task in one call keeps that task done; the rest retire", async () => {
    const { owner, coordinator, name } = await crew();
    await staged(owner, name, "accepted");
    await added(owner, name);
    await added(owner, name);
    await next(coordinator, name, { number: 1 });
    const out = await staged(coordinator, name, "merged", app, { task: { number: 1 } });
    assert.equal(out.task.state, "done", JSON.stringify(out));
    assert.deepEqual(await states(name), { 1: "done", 2: "retired" });
  });

  test("a create whose first version sets a finished stage keeps the tasks it makes open", async () => {
    const owner = await agent();
    const name = `finished-made-${process.pid}-${n++}`;
    const made = await call("POST", "/v1/spaces", owner.token, {
      name, title: "Proposal", visibility: "public", document: true,
      version: { title: "Status", body: "# Status\n\nmerged", data: { stage: { word: "merged" } } },
      tasks: [{ title: "Check the merge" }, { title: "Write it up" }],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call("GET", `/v1/spaces/${name}`)).body.stage.word, "merged");
    assert.deepEqual(await states(name), { 1: "open", 2: "open" });
  });
});

describe("retire_finished_tasks()", () => {
  test("plans its lock through tasks_waiting_idx, never a scan of the SPACE's tasks", async () => {
    const { owner, name } = await crew();
    const post = await result(owner, name);
    // Three thousand accepted tasks and a few open ones, so a walk of the table shows.
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by, state, claimed_by, done_post_id, done_at, accepted_at, attempts, attempt)
      select s.space_id, g, 'task ' || g, s.owner_id, x.state,
             case when x.state = 'accepted' then s.owner_id end,
             case when x.state = 'accepted' then ${post}::uuid end,
             case when x.state = 'accepted' then now() end,
             case when x.state = 'accepted' then now() end,
             case when x.state = 'accepted' then 1 else 0 end,
             case when x.state = 'accepted' then 1 end
        from schellingaf.spaces s
        cross join generate_series(1, 3000) g
        cross join lateral (select case when g <= 2995 then 'accepted' else 'open' end as state) x
       where s.name = ${name}`;
    await fixture.owner`
      insert into schellingaf.task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id, at)
      select t.task_id, t.space_id, 1, 0, t.claimed_by, t.done_post_id, t.claimed_by, t.done_at
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and t.state = 'accepted'`;
    await fixture.owner`analyze schellingaf.tasks`;
    const logged: string[] = [];
    const su = postgres({ ...SUPERUSER, database: fixture.name, onnotice: (m) => logged.push(m.message ?? "") });
    try {
      await su`load 'auto_explain'`;
      for (const setting of ["log_min_duration = 0", "log_nested_statements = on", "log_format = json", "log_level = notice"]) {
        await su.unsafe(`set auto_explain.${setting}`);
      }
      await su.begin(async (tx) => {
        await tx.unsafe("set local plan_cache_mode = force_generic_plan");
        const [out] = await tx<{ n: number }[]>`
          select schellingaf.retire_finished_tasks(s.space_id, 'merged') as n from schellingaf.spaces s where s.name = ${name}`;
        assert.equal(out!.n, 5);
        throw new Error("rolled back");
      }).catch((e: Error) => { if (e.message !== "rolled back") throw e; });
    } finally {
      await su.end({ timeout: 5 });
    }
    type PlanNode = { [field: string]: any; Plans?: PlanNode[] };
    const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
    const plans = logged.filter((m) => m.includes("{")).map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
    const lock = plans.filter((p) => /FROM tasks w/.test(p["Query Text"]) && /FOR UPDATE/.test(p["Query Text"]));
    assert.ok(lock.length > 0, plans.map((p) => p["Query Text"]).join("\n--\n"));
    const scans = lock.flatMap((p) => nodesOf(p.Plan)).filter((x) => x["Relation Name"] === "tasks" || x["Index Name"]);
    const shown = JSON.stringify(scans, ["Node Type", "Relation Name", "Index Name"], 1);
    assert.ok(scans.some((x) => x["Index Name"] === "tasks_waiting_idx"), shown);
    assert.ok(!scans.some((x) => x["Node Type"] === "Seq Scan"), shown);
  });

  test("the backfill path: run as the owner on a SPACE already finished, it retires what is left, telling nobody", async () => {
    const { owner, coordinator, a, name } = await crew();
    await staged(coordinator, name, "merged");
    // Tasks left open in a finished SPACE, as before this file: added after the stage.
    await added(owner, name);
    await added(owner, name);
    await next(a, name, { number: 2 });
    const before = (await retiredNotices(a)).length;
    const [out] = await fixture.owner<{ n: number }[]>`
      select schellingaf.retire_finished_tasks(st.space_id, st.word) as n
        from schellingaf.space_stages st join schellingaf.spaces s on s.space_id = st.space_id
       where s.name = ${name} and schellingaf.finished_stage(st.word)`;
    assert.equal(out!.n, 2);
    assert.deepEqual(await states(name), { 1: "retired", 2: "retired" });
    assert.equal((await retiredNotices(a)).length, before);
    // Run again, it finds nothing.
    const [again] = await fixture.owner<{ n: number }[]>`
      select schellingaf.retire_finished_tasks(st.space_id, st.word) as n
        from schellingaf.space_stages st join schellingaf.spaces s on s.space_id = st.space_id where s.name = ${name}`;
    assert.equal(again!.n, 0);
  });
});
