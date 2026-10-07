// A KEY that may not touch a SPACE's tasks is refused before it waits on the SPACE's lock,
// by every task function the api role can call, the wrappers kept for an earlier release
// included.
//
// Each asks first, unlocked, whether the caller ranks high enough, and only then takes the
// SPACE row (.claude/rules/plpgsql.md, "Check order"). A call refused only after the lock
// queues behind the SPACE's real writers, and how long it waited tells a stranger how busy
// a private SPACE is. Here the SPACE is held by a transaction that does not finish, and
// each refusal must come back inside a 200 ms lock wait.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { useService, call, agent, fixture, db, type Agent } from "./lib/service.ts";
import { mirrorChecked } from "./lib/mirror.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";

const ready = useService("sec_tasks_precheck");
mirrorChecked();

const key = (a: Agent) => Buffer.from(a.peerId, "hex");
const SPACE = "tasks-held";

let owner: Agent;
let reader: Agent;
let writer: Agent;
let stranger: Agent;

before(async () => {
  await ready;
  owner = await agent();
  const made = await call("POST", "/v1/spaces", owner, { name: SPACE, title: "A private work space", join_policy: "invite" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  reader = await agent();
  writer = await agent();
  stranger = await agent();
  for (const [who, role] of [[reader, "reader"], [writer, "writer"]] as const) {
    const out = await call("PUT", `/v1/spaces/${SPACE}/members/${who.peerId}`, owner, { role });
    assert.equal(out.status, 200, JSON.stringify(out.body));
  }
  const added = await call("POST", `/v1/spaces/${SPACE}/tasks`, owner, { title: "Transcribe page 1" });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  // Only coordinators check here, so a writer's check is refused on rank too.
  await fixture.owner`update schellingaf.spaces set task_confirmers = 'coordinators' where name = ${SPACE}`;
});

/** Runs `fn` as the api role while another transaction holds the SPACE's row, and answers
 *  the refusal it met, "ran" when it was not refused, or the lock timeout when it waited. */
async function whileHeld(fn: (tx: any) => Promise<unknown>): Promise<string> {
  let out = "ran";
  await fixture.owner.begin(async (hold) => {
    await hold`select 1 from schellingaf.spaces where name = ${SPACE} for no key update`;
    try {
      // As the api role, which is how the routes call them.
      await db.write.begin(async (tx) => {
        await tx`set local lock_timeout = '200ms'`;
        await fn(tx);
      });
    } catch (e: any) {
      out = e.message;
    }
  });
  return out;
}

/** Every task function and overload the api role may call, with the caller `a`. */
function calls(a: Buffer): [string, (tx: any) => Promise<unknown>][] {
  const words = JSON.parse(JSON.stringify(NEXT_WORDS));
  const post = "00000000-0000-0000-0000-000000000000";
  const one = [{ title: "Transcribe page 2", after: [] }];
  return [
    ["add_tasks", (tx) => tx`select schellingaf.add_tasks(${SPACE}, ${a}, ${tx.json(one)}, null, false, 10000, 20)`],
    ["add_task", (tx) => tx`select schellingaf.add_task(${SPACE}, ${a}, 'Transcribe page 2', '', null, '{}'::uuid[], 10000)`],
    ...(["any", "work", "upkeep"] as const).map((job): [string, (tx: any) => Promise<unknown>] => [
      `next_job ${job}`,
      (tx) => tx`select schellingaf.next_job(${SPACE}, ${a}, ${job}, null, null, ${tx.json(words)}, 3, 60, 30, 10000, 2, 4, false, 3)`,
    ]),
    ["next_job number", (tx) => tx`select schellingaf.next_job(${SPACE}, ${a}, 'any', null, 1, ${tx.json(words)}, 3, 60, 30, 10000, 2, 4, false, 3)`],
    ["next_job number join", (tx) => tx`select schellingaf.next_job(${SPACE}, ${a}, 'work', null, 1, ${tx.json(words)}, 3, 60, 30, 10000, 2, 4, true, 3)`],
    ["next_job twelve", (tx) => tx`select schellingaf.next_job(${SPACE}, ${a}, 'any', null, null, ${tx.json(words)}, 3, 60, 30, 10000, 2, 4)`],
    ["next_job nine", (tx) => tx`select schellingaf.next_job(${SPACE}, ${a}, 'any', null, null, ${tx.json(words)}, 3, 60, 30)`],
    ["next_task", (tx) => tx`select schellingaf.next_task(${SPACE}, ${a}, null, false)`],
    ["take_task", (tx) => tx`select schellingaf.take_task(${SPACE}, ${a}, 1, 3, false, 3)`],
    ["task_progress", (tx) => tx`select schellingaf.task_progress(${SPACE}, ${a}, 1, ${post}::uuid, '{progress}'::text[], 3)`],
    ["task_done seven", (tx) => tx`select schellingaf.task_done(${SPACE}, ${a}, 1, ${post}::uuid, null::int, true, 5)`],
    ["task_done five", (tx) => tx`select schellingaf.task_done(${SPACE}, ${a}, 1, ${post}::uuid, null::int)`],
    ["task_done four", (tx) => tx`select schellingaf.task_done(${SPACE}, ${a}, 1, ${post}::uuid)`],
    ["task_release five", (tx) => tx`select schellingaf.task_release(${SPACE}, ${a}, 1, 'why'::text, true)`],
    ["task_release four", (tx) => tx`select schellingaf.task_release(${SPACE}, ${a}, 1, true)`],
    ["change_task", (tx) => tx`select schellingaf.change_task(${SPACE}, ${a}, 1, 1, 'why', ${tx.json({ title: "Page 1" })}, 50, true)`],
    ["retire_task", (tx) => tx`select schellingaf.retire_task(${SPACE}, ${a}, 1, 'why', null::jsonb, 10000, 20, 50, true)`],
    ["delete_task", (tx) => tx`select schellingaf.delete_task(${SPACE}, ${a}, 1, 'why', true)`],
    ["task_check confirm", (tx) => tx`select schellingaf.task_check(${SPACE}, ${a}, 1, 'confirm', null::uuid, null, true, null::int, null::int, 30)`],
    ["task_check reject", (tx) => tx`select schellingaf.task_check(${SPACE}, ${a}, 1, 'reject', null::uuid, 'why', true, null::int, null::int, 30)`],
  ];
}

/** The calls a writer ranks too low for: a retire, and a check where only coordinators check. */
const ABOVE_A_WRITER = new Set(["retire_task", "task_check confirm", "task_check reject"]);

describe("refused before the SPACE's lock", () => {
  test("every task function and overload, called by a KEY with no role and by a reader", async () => {
    for (const actor of [stranger, reader]) {
      for (const [what, fn] of calls(key(actor))) {
        assert.equal(await whileHeld(fn), "TASK_DENIED", `${what} by a ${actor === reader ? "reader" : "KEY with no role"}`);
      }
    }
  });

  test("a retire, and a check where coordinators check, called by a writer", async () => {
    for (const [what, fn] of calls(key(writer)).filter(([w]) => ABOVE_A_WRITER.has(w))) {
      assert.equal(await whileHeld(fn), "TASK_DENIED", what);
    }
  });

  test("the task settings, called by a writer and by a KEY with no role", async () => {
    for (const actor of [stranger, reader, writer]) {
      assert.equal(await whileHeld((tx) =>
        tx`select schellingaf.set_task_settings(${SPACE}, ${key(actor)}, 1::int, null::text, null::int, null::int, null::int)`), "CONTROL_DENIED");
      assert.equal(await whileHeld((tx) =>
        tx`select schellingaf.set_task_settings(${SPACE}, ${key(actor)}, 1::int, null::text, null::int)`), "CONTROL_DENIED");
    }
  });

  test("a writer's own take still waits for the lock, as every write must", async () => {
    assert.match(await whileHeld((tx) => tx`select schellingaf.take_task(${SPACE}, ${key(writer)}, 1, 3, false, 3)`), /lock timeout/);
  });
});
