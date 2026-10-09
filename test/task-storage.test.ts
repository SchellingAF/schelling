// A task's words as its SPACE's storage (migrations/0154_task_storage.sql): the counter
// space_storage.task_bytes, kept by one trigger on tasks as tasks are added, changed,
// retired with replacements and deleted; the backfill that fills it for the tasks written
// before it; and the recount, which corrects it and finds a SPACE with tasks and no post.
// The database is touched as the owner only to set a scene a route cannot, and to read
// the true sums the counter is held to.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { useService, fixture, db, call, agent, type Agent } from "./lib/service.ts";
import { recountStorage } from "../src/db/storage.ts";

useService("task_storage", { apiHost: "api.task-storage.test" });

let n = 0;
const newName = () => `task-storage-${process.pid}-${n++}`;

async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<{ name: string; id: string }> {
  const name = newName();
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Task storage", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const [s] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return { name, id: s!.id };
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function add(who: Agent, name: string, fields: Record<string, unknown>) {
  const out = await call("POST", `/v1/spaces/${name}/tasks?detail=full`, who.token, fields);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body;
}

async function act(who: Agent, name: string, number: number, action: string, fields: Record<string, unknown>) {
  const out = await call("POST", `/v1/spaces/${name}/tasks/${number}/${action}?detail=full`, who.token, fields);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
}

/** The counter, 0 when there is no row. */
async function counted(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`select task_bytes::text as b from schellingaf.space_storage where space_id = ${id}::uuid`;
  return Number(row?.b ?? 0);
}

/** The post counter, which a task never moves. */
async function postCounted(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`select post_bytes::text as b from schellingaf.space_storage where space_id = ${id}::uuid`;
  return Number(row?.b ?? 0);
}

/** The true sum, written out here rather than through the migration's functions. */
async function trueSum(id: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`
    select coalesce(sum(octet_length(title) + octet_length(body)), 0)::text as b from schellingaf.tasks where space_id = ${id}::uuid`;
  return Number(row!.b);
}

const bytes = (...words: string[]) => words.reduce((sum, w) => sum + Buffer.byteLength(w, "utf8"), 0);

describe("the counter follows a task's words", () => {
  test("adding a task adds its title and body in bytes, not characters", async () => {
    const owner = await agent();
    const s = await space(owner);
    assert.equal(await counted(s.id), 0);
    const title = "Übersetze Seite drei — 第三页";
    const body = "Lies das Bild. ✓";
    assert.ok(Buffer.byteLength(title) > title.length, "the title has multi-byte characters");
    await add(owner, s.name, { title, body });
    assert.equal(await counted(s.id), bytes(title, body));
    await add(owner, s.name, { title: "Second" });
    assert.equal(await counted(s.id), bytes(title, body, "Second"));
    assert.equal(await counted(s.id), await trueSum(s.id));
    assert.equal(await postCounted(s.id), 0, "a task moves no post bytes");
  });

  test("a batch of three adds their sum; a SPACE created with tasks counts them", async () => {
    const owner = await agent();
    const s = await space(owner);
    const tasks = [{ title: "One", body: "a" }, { title: "Two", body: "bb" }, { title: "Three", body: "ccc" }];
    await add(owner, s.name, { tasks });
    assert.equal(await counted(s.id), bytes("One", "a", "Two", "bb", "Three", "ccc"));
    const made = await space(owner, { tasks: [{ title: "Made with", body: "its first task" }, { title: "And a second" }] });
    assert.equal(await counted(made.id), bytes("Made with", "its first task", "And a second"));
    assert.equal(await counted(made.id), await trueSum(made.id));
  });

  test("a change of body adds new minus old; a change of after alone leaves it", async () => {
    const owner = await agent();
    const s = await space(owner);
    await add(owner, s.name, { title: "Base", body: "short" });
    await add(owner, s.name, { title: "Other", body: "a body that is long" });
    const before = await counted(s.id);
    await act(owner, s.name, 2, "change", { reason: "Shorter.", revision: 1, body: "brief" });
    assert.equal(await counted(s.id), before - bytes("a body that is long") + bytes("brief"));
    const mid = await counted(s.id);
    await act(owner, s.name, 2, "change", { reason: "Order.", revision: 2, after: [1] });
    assert.equal(await counted(s.id), mid, "the words did not change");
    await act(owner, s.name, 1, "change", { reason: "Longer.", revision: 1, title: "Base, longer" });
    assert.equal(await counted(s.id), mid - bytes("Base") + bytes("Base, longer"));
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("retire alone leaves it; retire with replacements adds theirs", async () => {
    const owner = await agent();
    const s = await space(owner);
    await add(owner, s.name, { tasks: [{ title: "First" }, { title: "Second" }] });
    const before = await counted(s.id);
    await act(owner, s.name, 1, "retire", { reason: "Not needed." });
    assert.equal(await counted(s.id), before, "a retired task keeps its words");
    await act(owner, s.name, 2, "retire", { reason: "Split.", tasks: [{ key: "x", title: "Part one", body: "p1" }, { key: "y", title: "Part two" }] });
    assert.equal(await counted(s.id), before + bytes("Part one", "p1", "Part two"));
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("delete takes the task's words away, and never below 0", async () => {
    const owner = await agent();
    const s = await space(owner);
    await add(owner, s.name, { tasks: [{ title: "Keep", body: "kept" }, { title: "Drop", body: "dropped words" }] });
    await act(owner, s.name, 2, "delete", { reason: "Wrong." });
    assert.equal(await counted(s.id), bytes("Keep", "kept"));
    // A counter already short: the delete takes it to 0, not below.
    await fixture.owner`update schellingaf.space_storage set task_bytes = 1 where space_id = ${s.id}::uuid`;
    await act(owner, s.name, 1, "delete", { reason: "Also wrong." });
    assert.equal(await counted(s.id), 0);
    assert.equal(await trueSum(s.id), 0);
  });

  test("an upkeep task's words count", async () => {
    const owner = await agent();
    const a = await agent();
    const b = await agent();
    const s = await space(owner, { document: true });
    for (const k of [a, b]) await grant(owner, s.name, k, "writer");
    const v = await call("POST", `/v1/spaces/${s.name}/posts`, owner.token, { kind: "version", body: "# Pages\n\nNone yet." });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    await add(owner, s.name, { title: "Transcribe page 3" });
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", `/v1/spaces/${s.name}/posts`, a.token, { kind: "result", body: `Page ${i}, transcribed.` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const before = await counted(s.id);
    const job = await call("POST", `/v1/spaces/${s.name}/tasks/next`, b.token, { job: "upkeep" });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    assert.equal(job.body.job, "upkeep", JSON.stringify(job.body));
    assert.ok(job.body.task.body.length > 0);
    assert.equal(await counted(s.id), before + bytes(job.body.task.title, job.body.task.body));
    assert.equal(await counted(s.id), await trueSum(s.id));
  });

  test("the counter equals the true count after a random mix of 50 writes", async () => {
    const owner = await agent();
    const s = await space(owner);
    const word = () => "w".repeat(1 + Math.floor(Math.random() * 40)) + (Math.random() < 0.3 ? "é" : "");
    let tasks = 0;
    const revision = new Map<number, number>();
    const live = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const pick = [...live][Math.floor(Math.random() * live.size)];
      const r = Math.random();
      if (pick === undefined || r < 0.4) {
        await add(owner, s.name, { title: word(), body: word() });
        tasks++;
        live.add(tasks);
        revision.set(tasks, 1);
      } else if (r < 0.8) {
        const rev = revision.get(pick)!;
        await act(owner, s.name, pick, "change", { reason: "Mix.", revision: rev, ...(Math.random() < 0.5 ? { title: word() } : { body: word() }) });
        revision.set(pick, rev + 1);
      } else {
        await act(owner, s.name, pick, "delete", { reason: "Mix." });
        live.delete(pick);
      }
    }
    const [row] = await fixture.owner<{ b: string }[]>`select schellingaf.space_task_bytes_true(${s.id}::uuid)::text as b`;
    assert.equal(await counted(s.id), Number(row!.b));
    assert.equal(await counted(s.id), await trueSum(s.id));
  });
});

describe("the migration", () => {
  test("locks space_storage before tasks, both before the first CREATE, waiting less than the api role's 2 s", () => {
    const text = readFileSync(new URL("../migrations/0154_task_storage.sql", import.meta.url), "utf8");
    const code = text.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    const storage = code.indexOf("LOCK TABLE schellingaf.space_storage IN ACCESS EXCLUSIVE MODE;");
    const tasks = code.indexOf("LOCK TABLE schellingaf.tasks IN SHARE ROW EXCLUSIVE MODE;");
    assert.ok(storage >= 0 && tasks > storage, "space_storage first, then tasks");
    assert.ok(tasks < code.indexOf("ALTER TABLE") && tasks < code.indexOf("CREATE "));
    const timeout = /SET LOCAL lock_timeout = '(\d+)ms';/.exec(code.slice(0, storage));
    assert.ok(timeout && Number(timeout[1]) < 2000, "a lock_timeout under 2 s before the locks");
  });

  test("the backfill sets each SPACE's true count from tasks written before the trigger", async () => {
    const owner = await agent();
    const a = await space(owner);
    const b = await space(owner);
    // Tasks written as they were before 0154: with the trigger off, so no counter moves.
    await fixture.owner.begin(async (tx) => {
      await tx`alter table schellingaf.tasks disable trigger tasks_storage`;
      await tx`update schellingaf.space_storage set task_bytes = 0 where space_id in (${a.id}::uuid, ${b.id}::uuid)`;
      const peer = Buffer.from(owner.peerId, "hex");
      for (const [id, number, title, body] of [[a.id, 1, "Alpha", "first"], [a.id, 2, "Beta", "zweite Ü"], [b.id, 1, "Gamma", ""]] as const) {
        await tx`insert into schellingaf.tasks (space_id, number, title, body, created_by) values (${id}::uuid, ${number}, ${title}, ${body}, ${peer})`;
      }
      await tx`alter table schellingaf.tasks enable trigger tasks_storage`;
    });
    assert.equal(await counted(a.id), 0, "the trigger was off");
    const migration = readFileSync(new URL("../migrations/0154_task_storage.sql", import.meta.url), "utf8").split("\n");
    const from = migration.indexOf("-- backfill begin");
    const to = migration.indexOf("-- backfill end");
    assert.ok(from >= 0 && to > from + 1, "the migration marks its backfill");
    const statement = migration.slice(from + 1, to).join("\n");
    assert.ok(statement.startsWith("INSERT INTO schellingaf.space_storage"), statement);
    await fixture.owner.unsafe(statement);
    assert.equal(await counted(a.id), bytes("Alpha", "first", "Beta", "zweite Ü"));
    assert.equal(await counted(b.id), bytes("Gamma"));
    const [missing] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.spaces s
       where exists (select 1 from schellingaf.tasks k where k.space_id = s.space_id)
         and coalesce((select t.task_bytes from schellingaf.space_storage t where t.space_id = s.space_id), -1)
             <> (select sum(octet_length(k.title) + octet_length(k.body)) from schellingaf.tasks k where k.space_id = s.space_id)`;
    assert.equal(missing!.n, 0, "every SPACE with a task holds its true count");
  });
});

describe("the recount", () => {
  test("corrects task_bytes, logs task_bytes_delta, and finds a SPACE with tasks and no post", async () => {
    const owner = await agent();
    const s = await space(owner);
    await add(owner, s.name, { title: "Only a task", body: "no post" });
    const [seq] = await fixture.owner<{ n: number }[]>`select last_seq::int as n from schellingaf.spaces where space_id = ${s.id}::uuid`;
    assert.equal(seq!.n, 0, "the SPACE has no post");
    const [listed] = await fixture.owner<{ ids: string[] }[]>`
      select schellingaf.storage_recount_spaces(null, 1000)::text[] as ids`;
    assert.ok(listed!.ids.includes(s.id), "a SPACE with a task and no post is recounted");

    await recountStorage(db, () => {});
    const truth = await trueSum(s.id);
    await fixture.owner`update schellingaf.space_storage set task_bytes = task_bytes + 4321 where space_id = ${s.id}::uuid`;
    const lines: string[] = [];
    const out = await recountStorage(db, (line) => lines.push(line));
    assert.equal(out.corrected, 1, JSON.stringify(out));
    assert.equal(out.task_bytes_delta, -4321);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [
      { event: "storage.recount", space_id: s.id, post_bytes_delta: 0, file_bytes_delta: 0, task_bytes_delta: -4321 },
    ]);
    assert.equal(await counted(s.id), truth);
    const again = await recountStorage(db, () => {});
    assert.equal(again.corrected, 0);
  });

  test("the drift check sees task bytes alone", async () => {
    const owner = await agent();
    const s = await space(owner);
    await add(owner, s.name, { title: `Drift ${randomUUID()}` });
    const drift = async () => (await fixture.owner<{ d: boolean }[]>`select schellingaf.storage_recount_drift(${s.id}::uuid) as d`)[0]!.d;
    assert.equal(await drift(), false);
    await fixture.owner`update schellingaf.space_storage set task_bytes = task_bytes + 1 where space_id = ${s.id}::uuid`;
    assert.equal(await drift(), true);
  });
});

describe("privacy", () => {
  test("the api role runs none of the new functions but the recount, and reads no counter", async () => {
    await assert.rejects(fixture.api`select task_bytes from schellingaf.space_storage`, /permission denied/);
    const rows = await fixture.owner<{ name: string; api: boolean; public: boolean }[]>`
      select p.oid::regprocedure::text as name, has_function_privilege('schellingaf_api', p.oid, 'execute') as api,
             has_function_privilege('public', p.oid, 'execute') as public
        from pg_proc p
       where p.pronamespace = 'schellingaf'::regnamespace
         and p.proname in ('task_stored_bytes', 'space_task_bytes_true', 'storage_count_task', 'storage_recount')
       order by 1`;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.filter((r) => r.api).map((r) => r.name), ["storage_recount(uuid)"]);
    assert.deepEqual(rows.filter((r) => r.public).map((r) => r.name), []);
  });
});
