// Who still stands when a task is checked or reviewed (migrations/0144_tasks.sql).
//
// A confirmation counts toward accepting a task while its KEY is blocked neither in the
// SPACE nor by the operator, read at each confirm: a block is the owner's sign of abuse.
// A KEY that left, was removed without a block or was demoted still counts, and a KEY
// unblocked counts again. The check stays recorded, and nothing accepted is undone.
//
// The task-list review is a coordinator's: a holder demoted below coordinator is not
// handed it again by next, and its done is TASK_DENIED, so the review lapses to a
// coordinator. Every KEY whose standing did not change sees the same flows as before.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { followDoneAt, mirrorChecked } from "./lib/mirror.ts";
import { TASK_LIMITS } from "../src/surface/vocabulary.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("sec_tasks_standing", { apiHost: "api.sec-tasks-standing.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

async function workSpace(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `standing-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Transcription", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function post(who: Agent, name: string, fields: Record<string, unknown>) {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, fields);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

function refused(out: { status: number; body: any }, status: number, code: string) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
}

/** A public work space asking 2 confirmations, with a doer and four checkers, and task 1 done. */
async function doneTask() {
  const owner = await agent();
  const [doer, x, y, z, w] = [await agent(), await agent(), await agent(), await agent(), await agent()];
  const name = await workSpace(owner);
  for (const k of [doer, x, y, z, w]) await grant(owner, name, k, "writer");
  assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Transcribe page 3" })).status, 201);
  const result = await post(doer, name, { kind: "result", body: "Page 3, transcribed." });
  assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/done`, doer.token, { post_id: result })).status, 200);
  return { owner, doer, x, y, z, w, name };
}

async function confirm(who: Agent, name: string) {
  const out = await call("POST", `/v1/spaces/${name}/tasks/1/confirm?detail=full`, who.token, {});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.task as { state: string; confirmations: { given: string[]; required: number } };
}

async function block(owner: Agent, name: string, who: Agent, on: boolean) {
  const out = await call(on ? "PUT" : "DELETE", `/v1/spaces/${name}/blocks/${who.peerId}`, owner.token, on ? {} : undefined);
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/** Task `number`'s done_at set `minutes` ago, as a route cannot. */
async function doneAgo(name: string, number: number, minutes: number) {
  await fixture.owner`
    update schellingaf.tasks t set done_at = now() - make_interval(mins => ${minutes})
      from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
  await followDoneAt(name);
}

/** Words of NEXT_WORDS with their values put in. */
function fill(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce<string>((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);
}

async function listed(name: string) {
  const out = await call("GET", `/v1/spaces/${name}/tasks/1`);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.task as { state: string; confirmations: { given: string[] } };
}

describe("a confirmation counts while its KEY is not blocked", () => {
  test("blocked in the SPACE, it stops counting: one more confirmation accepts, and given names those that count", async () => {
    const { owner, x, y, z, name } = await doneTask();
    await confirm(x, name);
    await block(owner, name, x, true);
    assert.deepEqual((await listed(name)).confirmations.given, [], "a blocked KEY's confirmation is not counted in given");
    const second = await confirm(y, name);
    assert.equal(second.state, "done", "the blocked KEY's confirmation did not count toward the two");
    assert.deepEqual(second.confirmations.given, [y.peerId]);
    const third = await confirm(z, name);
    assert.equal(third.state, "accepted");
    assert.deepEqual(third.confirmations.given, [y.peerId, z.peerId]);
    // The check stays recorded.
    const [rows] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.task_checks c join schellingaf.spaces s on s.space_id = c.space_id
       where s.name = ${name} and c.verdict = 'confirm'`;
    assert.equal(rows!.n, 3);
  });

  test("blocked by the operator, it stops counting too", async () => {
    const { x, y, z, name } = await doneTask();
    await confirm(x, name);
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = decode(${x.peerId}, 'hex')`;
    assert.equal((await confirm(y, name)).state, "done");
    assert.equal((await confirm(z, name)).state, "accepted");
  });

  test("unblocked again, it counts again", async () => {
    const { owner, x, y, name } = await doneTask();
    await confirm(x, name);
    await block(owner, name, x, true);
    await block(owner, name, x, false);
    const second = await confirm(y, name);
    assert.equal(second.state, "accepted");
    assert.deepEqual(second.confirmations.given, [x.peerId, y.peerId]);
  });

  test("a KEY that left, was removed without a block or was demoted still counts", async () => {
    for (const leave of ["removed", "demoted", "left"] as const) {
      const { owner, x, y, name } = await doneTask();
      await confirm(x, name);
      if (leave === "removed") assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${x.peerId}`, owner.token)).status, 200);
      if (leave === "demoted") await grant(owner, name, x, "reader");
      if (leave === "left") assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${x.peerId}`, x.token)).status, 200);
      const second = await confirm(y, name);
      assert.equal(second.state, "accepted", leave);
      assert.deepEqual(second.confirmations.given, [x.peerId, y.peerId], leave);
    }
  });

  test("two confirmations by KEYS that stand accept, as before", async () => {
    const { x, y, name } = await doneTask();
    assert.equal((await confirm(x, name)).state, "done");
    const second = await confirm(y, name);
    assert.equal(second.state, "accepted");
    assert.deepEqual(second.confirmations.given, [x.peerId, y.peerId]);
  });

  test("next's offer cap counts only the confirmations that count, so a check is still handed out", async () => {
    const { owner, x, y, w, name } = await doneTask();
    await confirm(x, name);
    await block(owner, name, x, true);
    await confirm(y, name);
    // Done an hour and more ago: job any hands the check first, while the cap leaves room.
    await fixture.owner`
      update schellingaf.tasks t set done_at = now() - make_interval(mins => ${TASK_LIMITS.checkFirstMinutes + 1})
        from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = 1`;
    await followDoneAt(name);
    const out = await call("POST", `/v1/spaces/${name}/tasks/next`, w.token, {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.job, "check", JSON.stringify(out.body));
    assert.equal(out.body.task.number, 1);
  });
});

describe("each count of confirmations leaves a blocked KEY's out", () => {
  /** Task 1 done, confirmed by x, who is then blocked, and by y: one confirmation counts of two. */
  async function halfConfirmed() {
    const scene = await doneTask();
    await confirm(scene.x, scene.name);
    await block(scene.owner, scene.name, scene.x, true);
    assert.equal((await confirm(scene.y, scene.name)).state, "done");
    return scene;
  }

  test("next's check first (step 2): a done task an hour old is handed out before an open task", async () => {
    const { owner, w, name } = await halfConfirmed();
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Transcribe page 4" })).status, 201);
    await doneAgo(name, 1, TASK_LIMITS.checkFirstMinutes + 1);
    const out = await call("POST", `/v1/spaces/${name}/tasks/next`, w.token, {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.job, "check", JSON.stringify(out.body));
    assert.equal(out.body.task.number, 1);
  });

  test("next's check when idle (step 6): a done task under an hour old is handed out with no work left", async () => {
    const { w, name } = await halfConfirmed();
    const out = await call("POST", `/v1/spaces/${name}/tasks/next`, w.token, {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.job, "check", JSON.stringify(out.body));
    assert.equal(out.body.task.number, 1);
  });

  test("each attempt's confirmations name only those that count", async () => {
    const { owner, x, y, z, name } = await doneTask();
    const second = await post(z, name, { kind: "result", body: "Page 3, transcribed again." });
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/done`, z.token, { post_id: second })).status, 200);
    for (const [who, attempt] of [[x, 1], [y, 2]] as const) {
      const out = await call("POST", `/v1/spaces/${name}/tasks/1/confirm`, who.token, { attempt });
      assert.equal(out.status, 200, JSON.stringify(out.body));
    }
    const confirmationsOf = async () => ((await call("GET", `/v1/spaces/${name}/tasks/1`)).body.task.attempts as { confirmations: string[] }[])
      .map((a) => a.confirmations);
    assert.deepEqual(await confirmationsOf(), [[x.peerId], [y.peerId]]);
    await block(owner, name, x, true);
    assert.deepEqual(await confirmationsOf(), [[], [y.peerId]]);
    assert.deepEqual((await listed(name)).confirmations.given, [], "the attempt of record is attempt 1");
  });

  test("the review's unchecked signal counts a task confirmed only by a blocked KEY as unchecked", async () => {
    for (const blocked of [true, false]) {
      const { owner, x, name } = await doneTask();
      await confirm(x, name);
      if (blocked) await block(owner, name, x, true);
      await doneAgo(name, 1, 25 * 60);
      const out = await call("POST", `/v1/spaces/${name}/tasks/next`, owner.token, { job: "upkeep" });
      assert.equal(out.status, 200, JSON.stringify(out.body));
      if (!blocked) {
        assert.equal(out.body.job, "stop", "a confirmation that counts makes the task checked");
        continue;
      }
      assert.equal(out.body.job, "upkeep", JSON.stringify(out.body));
      assert.equal(out.body.task.upkeep, "tasks");
      assert.equal(out.body.why, fill(NEXT_WORDS.why.upkeep_tasks, {
        signals: fill(NEXT_WORDS.signals.unchecked, { tasks: fill(NEXT_WORDS.tasks.one, { numbers: 1 }), hours: 24 }),
      }));
    }
  });
});

describe("whom confirmation_counts() answers", () => {
  test("about a private SPACE: a member, never a KEY outside it or nobody; its writes count on the write pool", async () => {
    const owner = await agent();
    const [doer, x, y, outsider] = [await agent(), await agent(), await agent(), await agent()];
    const name = `standing-private-${process.pid}-${n++}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "A private work space", join_policy: "invite" })).status, 201);
    for (const k of [doer, x, y]) await grant(owner, name, k, "writer");
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: 2 })).status, 200);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Transcribe page 3" })).status, 201);
    const result = await post(doer, name, { kind: "result", body: "Page 3, transcribed." });
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/1/done`, doer.token, { post_id: result })).status, 200);
    await confirm(x, name);
    await block(owner, name, x, true);
    const asks = async (caller: string | null) => fixture.asCaller(caller, async (sql) => {
      const [row] = await sql<{ blocked: boolean; free: boolean }[]>`
        select schellingaf.confirmation_counts(s.space_id, decode(${x.peerId}, 'hex')) as blocked,
               schellingaf.confirmation_counts(s.space_id, decode(${y.peerId}, 'hex')) as free
          from schellingaf.spaces s where s.name = ${name}`;
      return row;
    });
    assert.deepEqual(await asks(doer.peerId), { blocked: false, free: true }, "a member reads it");
    assert.deepEqual(await asks(outsider.peerId), { blocked: false, free: false }, "a KEY outside it learns nothing");
    assert.deepEqual(await asks(null), { blocked: false, free: false }, "nobody learns nothing");
    // The writes, on the write pool, count as the rule says: the blocked KEY's does not.
    const second = await confirm(y, name);
    assert.equal(second.state, "done");
    assert.deepEqual(second.confirmations.given, [y.peerId]);
    const read = await call("GET", `/v1/spaces/${name}/tasks/1`, doer.token);
    assert.deepEqual(read.body.task.confirmations.given, [y.peerId], "the member's read names the same");
  });
});

describe("the task-list review is a coordinator's while it is held", () => {
  /** A work space keeping a document, a coordinator holding its review, and the review's number. */
  async function review() {
    const owner = await agent();
    const [coordinator, other] = [await agent(), await agent()];
    const name = await workSpace(owner, { document: true });
    await grant(owner, name, coordinator, "coordinator");
    await grant(owner, name, other, "coordinator");
    await post(owner, name, { kind: "version", body: "# Pages" });
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title: "Transcribe page 3" })).status, 201);
    const out = await call("POST", `/v1/spaces/${name}/tasks/next`, coordinator.token, { job: "upkeep" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.upkeep, "tasks");
    return { owner, coordinator, other, name, number: out.body.task.number as number };
  }

  test("demoted to writer, its holder is not handed it again, its done is TASK_DENIED, and it lapses to a coordinator", async () => {
    const { owner, coordinator, other, name, number } = await review();
    await grant(owner, name, coordinator, "writer");
    const next = await call("POST", `/v1/spaces/${name}/tasks/next`, coordinator.token, {});
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.notEqual(next.body.task?.number, number, JSON.stringify(next.body));
    const upkeep = await call("POST", `/v1/spaces/${name}/tasks/next`, coordinator.token, { job: "upkeep" });
    assert.equal(upkeep.body.job, "stop", JSON.stringify(upkeep.body));
    const decision = await post(coordinator, name, { kind: "decision", body: "Kept task 1." });
    refused(await call("POST", `/v1/spaces/${name}/tasks/${number}/progress`, coordinator.token, { post_id: decision }), 403, "TASK_DENIED");
    refused(await call("POST", `/v1/spaces/${name}/tasks/${number}/done`, coordinator.token, { post_id: decision }), 403, "TASK_DENIED");
    refused(await call("POST", `/v1/spaces/${name}/posts`, coordinator.token,
      { kind: "decision", title: "Kept task 1", body: "Kept task 1, again.", task: { number } }), 403, "TASK_DENIED");
    // Its claim passes, and the next coordinator to ask takes the same review.
    await fixture.owner`
      update schellingaf.tasks t set claimed_until = now() - interval '1 minute'
        from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
    const taken = await call("POST", `/v1/spaces/${name}/tasks/next`, other.token, { job: "upkeep" });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.equal(taken.body.task.number, number);
    assert.equal(taken.body.task.claimed_by, other.peerId);
  });

  test("a coordinator that keeps its rank renews and finishes its review as before", async () => {
    const { coordinator, name, number } = await review();
    const renewed = await call("POST", `/v1/spaces/${name}/tasks/next`, coordinator.token, {});
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.task.number, number);
    assert.equal(renewed.body.renewed, true);
    const note = await post(coordinator, name, { kind: "progress", body: "Read the list; two to change." });
    const linked = await call("POST", `/v1/spaces/${name}/tasks/${number}/progress`, coordinator.token, { post_id: note });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const decision = await post(coordinator, name, { kind: "decision", body: "Kept task 1." });
    const done = await call("POST", `/v1/spaces/${name}/tasks/${number}/done`, coordinator.token, { post_id: decision });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.task.state, "accepted");
  });
});
