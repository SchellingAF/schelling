// Task records that follow corrections: migrations/0147_task_corrections.sql holds every rule.
// B1: done while a task in after is not accepted is recorded, and its check waits (held). B2:
// done with a newer post replaces the caller's own attempt while it waits for a check. B3: a
// reject that reopens a task leaves it claimed by the KEYS whose attempts were rejected. B4:
// any KEY that may check a task and did not do it may reject it after acceptance, which
// reopens it as B3 does. These drive the rules through the routes, as an agent would, and read
// the database only to set a scene a route cannot, or to read a column no answer shows. After
// every case, task_mirror_faults() answers nothing.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { useService, fixture, call, connector, type Agent, agent } from "./lib/service.ts";
import { mirrorChecked, followDoneAt } from "./lib/mirror.ts";
import { SUPERUSER } from "./bootstrap.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";
import { TASK_LIMITS } from "../src/surface/vocabulary.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_corrections", { apiHost: "api.task-corrections.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

async function workSpace(owner: Agent): Promise<string> {
  const name = `corrections-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Transcription", visibility: "public" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/** The owner, a coordinator and six writers of one public work space; two confirmations unless set. */
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

async function result(who: Agent, name: string, body = "Page 3, transcribed.", kind = "result") {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind, body, title: "Page 3", fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

async function done(who: Agent, name: string, number: number, post: string, fields: Record<string, unknown> = {}) {
  return act(who, name, number, "done", { post_id: post, ...fields });
}

async function check(who: Agent, name: string, number: number, verdict: "confirm" | "reject", fields: Record<string, unknown> = {}) {
  return act(who, name, number, verdict, verdict === "reject" ? { reason: "Line 4 is missing.", ...fields } : fields);
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

/** Each task notice of a KEY: reason, number, by, attempt and result, in mailbox order. */
async function told(who: Agent) {
  const out = await call("GET", "/v1/mailbox", who.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return (out.body.items as any[]).filter((i) => i.reason.startsWith("task_"));
}

/** A column no answer shows: whether a task is marked to be accepted once its after is. */
async function acceptAfter(name: string, number: number): Promise<boolean> {
  const [row] = await fixture.owner<{ accept_after: boolean }[]>`
    select t.accept_after from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
     where s.name = ${name} and t.number = ${number}`;
  return row!.accept_after;
}

/** A scene a route cannot make: task `number` done `hours` ago. */
async function doneAgo(name: string, number: number, hours: number) {
  await fixture.owner`
    update schellingaf.tasks t set done_at = now() - make_interval(hours => ${hours})
      from schellingaf.spaces s where s.space_id = t.space_id and s.name = ${name} and t.number = ${number}`;
  await followDoneAt(name);
}

/** Tasks 1 and 2, task 2 after task 1. */
async function pair(owner: Agent, name: string) {
  const first = await added(owner, name);
  await added(owner, name, { title: "Check page 3", after: [first.task_id] });
}

describe("B1: done while a task in after waits is recorded, and its check waits", () => {
  test("1. a writer with no claim marks done while after waits: done, check_waits_for 1, on every answer", async () => {
    const { owner, a, name } = await crew();
    await pair(owner, name);
    const out = await done(a, name, 2, await result(a, name));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "done");
    assert.equal(out.body.task.check_waits_for, 1);
    assert.equal(out.body.check_waits_for, 1, "at the top of the answer, as attempt is");
    // The short answer, the compact list and a POST's task say it too.
    const short = await act(a, name, 2, "done", { post_id: out.body.task.done_post_id }, "");
    assert.deepEqual([short.body.changed, short.body.check_waits_for, short.body.task.check_waits_for], [false, 1, undefined]);
    const compact = await call("GET", `/v1/spaces/${name}/tasks?detail=compact`);
    assert.equal(compact.body.items.find((t: any) => t.number === 2).check_waits_for, 1);
    assert.equal(compact.body.items.find((t: any) => t.number === 1).check_waits_for, undefined);
    await added(owner, name, { title: "Page 4", after: [(await get(name, 1)).task_id] });
    const posted = await call("POST", `/v1/spaces/${name}/posts`, a.token, { kind: "result", title: "Page 4", body: "Page 4.", task: { number: 3 } });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.equal(posted.body.task.check_waits_for, 1);
  });

  test("2. next with job check and job any never offers a held task; once its after is accepted, it does", async () => {
    const { owner, a, b, c, d, e, name } = await crew(1);
    await pair(owner, name);
    await added(owner, name, { title: "Page 4" });
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    assert.equal((await done(b, name, 3, await result(b, name))).status, 200);
    // Both waited over an hour, task 2 longer: check first passes it by.
    await doneAgo(name, 2, 3);
    await doneAgo(name, 3, 2);
    const any = ok(await next(c, name));
    assert.deepEqual([any.job, any.task.number], ["check", 3]);
    const asked = ok(await next(c, name, { job: "check" }));
    assert.deepEqual([asked.job, asked.task.number], ["check", 3]);
    ok(await check(c, name, 3, "confirm"));
    assert.equal(ok(await next(c, name, { job: "check" })).job, "stop");
    // Task 1 done and accepted: task 2's check is handed out.
    assert.equal((await done(d, name, 1, await result(d, name))).status, 200);
    assert.equal(ok(await check(e, name, 1, "confirm")).task.state, "accepted");
    const now = ok(await next(c, name, { job: "check" }));
    assert.deepEqual([now.job, now.task.number, now.task.check_waits_for], ["check", 2, undefined]);
  });

  test("3. confirm and reject of a held task are TASK_WAITING naming the task it waits for; the dry run the same", async () => {
    const { owner, a, c, name } = await crew();
    await pair(owner, name);
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    refused(await check(c, name, 2, "confirm"), 409, "TASK_WAITING", "1");
    refused(await check(c, name, 2, "reject"), 409, "TASK_WAITING", "1");
    for (const verdict of ["confirm", "reject"]) {
      const dry = await call("POST", `/v1/spaces/${name}/posts`, c.token, {
        kind: "obs", title: "Checked", body: "Checked.", dry_run: true, task: { number: 2, check: verdict, reason: "Wrong." },
      });
      refused(dry, 409, "TASK_WAITING", "1");
    }
    // The doer meets the same: the hold comes before who may check.
    refused(await check(a, name, 2, "confirm"), 409, "TASK_WAITING", "1");
  });

  test("4. at confirmations 0, a held attempt is accepted with its after, and a chain of three by one done", async () => {
    const { owner, a, b, c, name } = await crew(0);
    const one = await added(owner, name);
    const two = await added(owner, name, { after: [one.task_id] });
    await added(owner, name, { after: [two.task_id] });
    const held = await done(a, name, 2, await result(a, name));
    assert.equal(held.body.task.state, "done", "never accepted while its after waits");
    assert.equal(await acceptAfter(name, 2), true);
    assert.equal((await done(b, name, 3, await result(b, name))).body.task.check_waits_for, 2);
    const first = await done(c, name, 1, await result(c, name));
    assert.equal(first.body.task.state, "accepted");
    for (const number of [2, 3]) {
      const t = await get(name, number);
      assert.equal(t.state, "accepted", `task ${number}`);
      assert.ok(t.accepted_at, `task ${number}`);
      assert.equal(t.check_waits_for, undefined);
      assert.equal(await acceptAfter(name, number), false);
    }
    // A notice is not sent for an acceptance the release made, as upkeep sends none.
    assert.deepEqual((await told(a)).map((i) => i.reason), []);
  });

  test("4b. the release accepts only what done would have accepted: never a hidden post's attempt, nor a blocked submitter's", async () => {
    const { owner, a, b, c, d, name } = await crew(0);
    const one = await added(owner, name);
    await added(owner, name, { after: [one.task_id] });
    await added(owner, name, { after: [one.task_id] });
    const hidden = await result(a, name);
    assert.equal((await done(a, name, 2, hidden)).status, 200);
    assert.equal((await done(b, name, 3, await result(b, name))).status, 200);
    assert.equal((await call("PUT", `/v1/posts/${hidden}/hidden`, owner.token)).status, 200);
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${b.peerId}`, owner.token)).status, 200);
    assert.equal((await done(c, name, 1, await result(c, name))).body.task.state, "accepted");
    for (const number of [2, 3]) {
      const t = await get(name, number);
      assert.deepEqual([t.state, t.check_waits_for], ["done", undefined], `task ${number}`);
      assert.equal(await acceptAfter(name, number), false, `task ${number}`);
    }
    assert.equal(ok(await next(d, name, { job: "check" })).task.number, 2);
  });

  test("4c. nor a withheld post's attempt, nor one whose submitter the operator blocked", async () => {
    const { owner, a, b, c, name } = await crew(0);
    const one = await added(owner, name);
    await added(owner, name, { after: [one.task_id] });
    await added(owner, name, { after: [one.task_id] });
    const withheld = await result(a, name);
    assert.equal((await done(a, name, 2, withheld)).status, 200);
    assert.equal((await done(b, name, 3, await result(b, name))).status, 200);
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason)
      select p.post_id, p.space_id, 'malware' from schellingaf.posts p where p.post_id = ${withheld}::uuid`;
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = ${Buffer.from(b.peerId, "hex")}`;
    try {
      assert.equal((await done(c, name, 1, await result(c, name))).body.task.state, "accepted");
      for (const number of [2, 3]) {
        assert.equal((await get(name, number)).state, "done", `task ${number}`);
        assert.equal(await acceptAfter(name, number), false, `task ${number}`);
      }
    } finally {
      await fixture.owner`update schellingaf.peers set blocked_at = null where peer_id = ${Buffer.from(b.peerId, "hex")}`;
    }
  });

  test("5. at confirmations 0, a rival's attempt while held clears the mark: the release leaves it done", async () => {
    const { owner, a, b, c, d, name } = await crew(0);
    await pair(owner, name);
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    assert.equal(await acceptAfter(name, 2), true);
    assert.equal((await done(b, name, 2, await result(b, name))).body.attempt, 2);
    assert.equal(await acceptAfter(name, 2), false, "a rival contests it");
    assert.equal((await done(c, name, 1, await result(c, name))).body.task.state, "accepted");
    const t = await get(name, 2);
    assert.equal(t.state, "done");
    assert.equal(t.check_waits_for, undefined);
    assert.equal(ok(await next(d, name, { job: "check" })).task.number, 2);
  });

  test("6. retiring the after task releases the check without accepting; a held task retired loses its mark", async () => {
    const { owner, coordinator, a, b, d, name } = await crew(0);
    await pair(owner, name);
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    ok(await act(coordinator, name, 1, "retire", { reason: "Page 3 is gone." }));
    const t = await get(name, 2);
    assert.equal(t.state, "done", "only an acceptance accepts");
    assert.equal(t.check_waits_for, undefined);
    assert.equal(await acceptAfter(name, 2), false);
    assert.equal(ok(await next(d, name, { job: "check" })).task.number, 2);
    // A held task retired itself: the mark goes with the done state.
    const three = await added(owner, name);
    await added(owner, name, { after: [three.task_id] });
    assert.equal((await done(b, name, 4, await result(b, name))).status, 200);
    assert.equal(await acceptAfter(name, 4), true);
    ok(await act(coordinator, name, 4, "retire", { reason: "Not needed." }));
    assert.equal(await acceptAfter(name, 4), false);
  });

  test("7. the review's unchecked signal leaves a held task out", async () => {
    const { owner, coordinator, a, b, name } = await crew();
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { upkeep_document_after: 0 })).status, 200);
    await pair(owner, name);
    await added(owner, name, { title: "Page 4" });
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    assert.equal((await done(b, name, 3, await result(b, name))).status, 200);
    for (const number of [2, 3]) await doneAgo(name, number, 25);
    const out = ok(await next(coordinator, name, { job: "upkeep" }));
    const fill = (text: string, values: Record<string, string | number>) =>
      Object.entries(values).reduce<string>((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text);
    assert.equal(out.why, fill(NEXT_WORDS.why.upkeep_tasks, {
      signals: fill(NEXT_WORDS.signals.unchecked, { tasks: fill(NEXT_WORDS.tasks.one, { numbers: 3 }), hours: 24 }),
    }));
  });

  test("8. a KEY whose claim's task gained an after by a change: its done is held too, never accepted at once", async () => {
    const { owner, coordinator, a, name } = await crew(0);
    const one = await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    assert.equal(ok(await next(a, name, { number: 2 })).task.claimed_by, a.peerId);
    ok(await act(coordinator, name, 2, "change", { revision: 1, reason: "Page 3 first.", after: [one.task_id] }));
    const out = await done(a, name, 2, await result(a, name), { revision: 2 });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "done");
    assert.equal(out.body.check_waits_for, 1);
  });
});

describe("B2: a newer post by the same KEY replaces its pending attempt", () => {
  test("9. done again with a newer post: attempt 2 replaces 1, which reads replaced, and the record names attempt 2", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name);
    const first = await result(a, name);
    assert.equal((await done(a, name, 1, first)).status, 200);
    const second = await result(a, name, "Page 3, corrected.");
    const out = await done(a, name, 1, second);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual([out.body.attempt, out.body.replaces, out.body.changed], [2, 1, true]);
    const t = out.body.task;
    assert.deepEqual([t.state, t.attempt, t.done_post_id, t.claimed_by], ["done", 2, second, a.peerId]);
    assert.deepEqual(t.attempts.map((x: any) => [x.attempt, x.state, x.replaces ?? null, x.post_id]), [
      [1, "replaced", null, first],
      [2, "pending", 1, second],
    ]);
    const short = await done(a, name, 1, await result(a, name, "Page 3, again."), {});
    assert.equal(short.body.replaces, 2, "a replacement may itself be replaced");
  });

  test("10. the same request again is changed false; the replaced post again is INVALID_REQUEST", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name);
    const first = await result(a, name);
    const second = await result(a, name, "Page 3, corrected.");
    assert.equal((await done(a, name, 1, first)).status, 200);
    assert.equal((await done(a, name, 1, second)).status, 200);
    const again = await done(a, name, 1, second);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual([again.body.changed, again.body.attempt, again.body.replaces], [false, 2, undefined]);
    refused(await done(a, name, 1, first), 400, "INVALID_REQUEST", "post_id: attempt 1 names that post");
  });

  test("11. a confirm offered on the replaced attempt is TASK_NOT_DONE naming the one that stands; its offer goes", async () => {
    const { owner, a, c, name } = await crew();
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal(ok(await next(c, name, { job: "check" })).task.number, 1);
    assert.equal((await done(a, name, 1, await result(a, name, "Page 3, corrected."))).status, 200);
    refused(await check(c, name, 1, "confirm"), 409, "TASK_NOT_DONE", "attempt 1: replaced by attempt 2");
    refused(await check(c, name, 1, "confirm", { attempt: 1 }), 409, "TASK_NOT_DONE", "attempt 1: replaced by attempt 2");
    const [offers] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.task_check_offers o where o.peer_id = ${Buffer.from(c.peerId, "hex")}`;
    assert.equal(offers!.n, 0);
    assert.equal(ok(await check(c, name, 1, "confirm", { attempt: 2 })).task.confirmations.given[0], c.peerId);
  });

  test("12. a confirmation of the replaced attempt never counts for the new one", async () => {
    const { owner, a, c, d, e, name } = await crew(2);
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    ok(await check(c, name, 1, "confirm"));
    const out = await done(a, name, 1, await result(a, name, "Page 3, corrected."));
    assert.deepEqual(out.body.task.confirmations, { required: 2, given: [] });
    assert.deepEqual(out.body.task.attempts[0].confirmations, [c.peerId], "recorded on the attempt it checked");
    assert.equal(ok(await check(d, name, 1, "confirm")).task.state, "done", "one of two");
    // c may check the new attempt: it checked other bytes.
    assert.equal(ok(await check(c, name, 1, "confirm", { attempt: 2 })).task.state, "accepted");
    refused(await check(e, name, 1, "confirm"), 409, "TASK_NOT_DONE", "accepted");
  });

  test("13. a rejected attempt is never replaced: TASK_NOT_OPEN done", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    assert.equal(ok(await check(c, name, 1, "reject", { attempt: 1 })).task.state, "done");
    refused(await done(a, name, 1, await result(a, name, "Page 3, corrected.")), 409, "TASK_NOT_OPEN", "done");
  });

  test("14. replaced attempts do not count toward the attempts limit, and a replacement is never refused by it", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const keys = await Promise.all(Array.from({ length: 6 }, () => agent()));
    for (const k of keys) await grant(owner, name, k, "writer");
    await added(owner, name);
    for (const k of keys.slice(0, 4)) assert.equal((await done(k, name, 1, await result(k, name))).status, 200);
    assert.equal((await done(keys[0]!, name, 1, await result(keys[0]!, name, "Corrected."))).body.replaces, 1);
    // Five rows, four standing: a fifth KEY still may.
    assert.equal((await done(keys[4]!, name, 1, await result(keys[4]!, name))).status, 200);
    refused(await done(keys[5]!, name, 1, await result(keys[5]!, name)), 409, "TASK_LIMIT", `attempts: ${TASK_LIMITS.attempts}`);
    const again = await done(keys[1]!, name, 1, await result(keys[1]!, name, "Corrected too."));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replaces, 2);
    assert.equal((await get(name, 1)).attempts.length, 7);
  });

  test("15b. a POST's done, its dry run and its replay all answer replaces and check_waits_for", async () => {
    const { owner, a, name } = await crew();
    await pair(owner, name);
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    const body = { kind: "result", title: "Page 3", body: "Page 3, corrected.", task: { number: 2 } };
    const dry = await call("POST", `/v1/spaces/${name}/posts`, a.token, { ...body, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual([dry.body.task.replaces, dry.body.task.check_waits_for], [1, 1]);
    const keyed = { ...body, idempotency_key: `fix-${name}` };
    const first = await call("POST", `/v1/spaces/${name}/posts`, a.token, keyed);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.task.attempt, first.body.task.replaces, first.body.task.check_waits_for], [2, 1, 1]);
    const again = await call("POST", `/v1/spaces/${name}/posts`, a.token, keyed);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.task, first.body.task);
  });

  test("15c. the connector says a held task's check waits, and which attempt a done replaced", async () => {
    const { owner, a, name } = await crew();
    await pair(owner, name);
    const say = async (args: Record<string, unknown>) =>
      (await connector("tools/call", { name: "schellingaf_task", arguments: { space: name, ...args } }, a)).message.result.content[0].text as string;
    assert.match(await say({ action: "done", number: 2, post_id: await result(a, name) }), /task 2 in "[^"]+": done; its check waits for task 1 to be accepted/);
    const again = await say({ action: "done", number: 2, post_id: await result(a, name, "Page 3, corrected."), detail: "full" });
    assert.match(again, /: done by [0-9a-f]{64} at [^;]+; its check waits for task 1 to be accepted/);
    assert.match(again, /attempt 2 by [0-9a-f]{64}: pending, of record, replaces attempt 1, confirmed 0/);
    assert.match(again, /your call: attempt 2, which replaces attempt 1/);
  });

  test("15. the confirmer of the replaced attempt and the KEY offered it are told task_attempt", async () => {
    const { owner, a, c, d, name } = await crew(2);
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    ok(await check(c, name, 1, "confirm"));
    assert.equal(ok(await next(d, name, { job: "check" })).task.number, 1);
    const second = await result(a, name, "Page 3, corrected.");
    assert.equal((await done(a, name, 1, second)).status, 200);
    for (const who of [c, d]) {
      const last = (await told(who)).filter((i) => i.reason === "task_attempt");
      assert.deepEqual(last.map((i) => [i.task.number, i.task.by, i.task.attempt, i.task.result]), [[1, a.peerId, 2, second]]);
    }
    assert.deepEqual((await told(a)).filter((i) => i.reason === "task_attempt"), [], "never the caller");
  });

  test("15d. a KEY whose offer of the replaced attempt has passed is not told", async () => {
    const { owner, a, d, name } = await crew(2);
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal(ok(await next(d, name, { job: "check" })).task.number, 1);
    await fixture.owner`
      update schellingaf.task_check_offers set offered_at = now() - make_interval(mins => ${TASK_LIMITS.checkOfferMinutes + 1})
       where peer_id = ${Buffer.from(d.peerId, "hex")}`;
    assert.equal((await done(a, name, 1, await result(a, name, "Page 3, corrected."))).status, 200);
    assert.deepEqual((await told(d)).filter((i) => i.reason === "task_attempt"), []);
  });
});

describe("B3: a reject leaves the task held by its doers", () => {
  test("16 and 19. a reject with nothing pending: claimed by the doer, which never held it, for the claim hours", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    const out = ok(await check(c, name, 1, "reject"));
    assert.deepEqual([out.task.state, out.task.cycle, out.task.claimed_by, out.task.rejected.by], ["claimed", 1, a.peerId, c.peerId]);
    const hours = (Date.parse(out.task.claimed_until) - Date.now()) / 3_600_000;
    assert.ok(hours > 3.9 && hours <= 4, String(hours));
    // Nobody else's next hands it out; its doer's renews it.
    assert.equal(ok(await next(b, name)).job, "stop");
    const mine = ok(await next(a, name));
    assert.deepEqual([mine.job, mine.renewed, mine.task.number], ["work", true, 1]);
    // No take is counted for it.
    const [row] = await fixture.owner<{ takes: number }[]>`
      select t.takes from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id where s.name = ${name}`;
    assert.equal(row!.takes, 0);
    // Another KEY may still join it by number.
    assert.equal(ok(await next(b, name, { number: 1, join: true })).task.claimants.length, 2);
  });

  test("17. every rejected submitter of the cycle gets a claim, up to claimants 3, in attempt order", async () => {
    const { owner, a, b, c, d, e, name } = await crew();
    await added(owner, name);
    for (const who of [a, b, d, e]) assert.equal((await done(who, name, 1, await result(who, name))).status, 200);
    for (const attempt of [1, 2, 3]) assert.equal(ok(await check(c, name, 1, "reject", { attempt })).task.state, "done");
    const out = ok(await check(c, name, 1, "reject", { attempt: 4 }));
    assert.equal(out.task.state, "claimed");
    assert.deepEqual(out.task.claimants.map((x: any) => x.by).sort(), [a.peerId, b.peerId, d.peerId].sort());
  });

  test("18. a submitter at 3 live claims gets none, nor a blocked one, nor one under its own give-back lock", async () => {
    const { owner, coordinator, a, b, c, d, name } = await crew();
    for (let i = 0; i < 5; i++) await added(owner, name, { title: `Page ${i + 1}` });
    for (const number of [1, 2, 3]) ok(await next(a, name, { number }));
    for (const who of [a, b]) assert.equal((await done(who, name, 4, await result(who, name))).status, 200);
    ok(await check(c, name, 4, "reject", { attempt: 1 }));
    const held = ok(await check(c, name, 4, "reject", { attempt: 2 }));
    assert.deepEqual([held.task.state, held.task.claimed_by, held.task.claimants], ["claimed", b.peerId, undefined]);
    // Blocked in the SPACE after its attempt: no claim.
    assert.equal((await done(d, name, 5, await result(d, name))).status, 200);
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${d.peerId}`, owner.token)).status, 200);
    const none = ok(await check(coordinator, name, 5, "reject"));
    assert.deepEqual([none.task.state, none.task.claimed_by], ["open", null]);
    // Under its own give-back lock: a coordinator that gave the task back and then did it.
    const six = (await added(owner, name, { title: "Page 6" })).number;
    ok(await next(b, name, { number: six }));
    ok(await act(coordinator, name, six, "release", { reason: "No progress for a day." }));
    assert.equal((await done(coordinator, name, six, await result(coordinator, name))).status, 200);
    const locked = ok(await check(owner, name, six, "reject"));
    assert.deepEqual([locked.task.state, locked.task.claimed_by], ["open", null]);
  });
});

describe("B4: a reject reopens an accepted task", () => {
  test("20. a reject of an accepted task: next cycle, claimed by its doer, rejected names the reason, its finding contested", async () => {
    const { owner, a, b, c, name } = await crew(1);
    await added(owner, name);
    const finding = await call("POST", `/v1/spaces/${name}/posts`, a.token, {
      kind: "finding", title: "Row 4 reads TA", body: "Read against the 1931 codebook.",
      data: { claim: "Row 4 reads TA", status: "proposed", confidence: "medium" },
    });
    assert.equal(finding.status, 201, JSON.stringify(finding.body));
    assert.equal((await done(a, name, 1, finding.body.post_id)).status, 200);
    assert.equal(ok(await check(b, name, 1, "confirm")).task.state, "accepted");
    const findings = async () => (await call("GET", `/v1/spaces/${name}/findings`)).body.items.find((f: any) => f.post_id === finding.body.post_id);
    assert.equal("contested" in (await findings()), false);
    const out = ok(await check(c, name, 1, "reject", { reason: "Row 4 reads TO in the scan." }));
    const t = out.task;
    assert.deepEqual([t.state, t.cycle, t.claimed_by, t.accepted_at, t.done_post_id], ["claimed", 1, a.peerId, null, null]);
    assert.deepEqual([t.rejected.by, t.rejected.reason, t.rejected.result, t.rejected.cleared], [c.peerId, "Row 4 reads TO in the scan.", finding.body.post_id, [b.peerId]]);
    assert.equal((await findings()).contested.length, 1);
    // Its submitter and the confirmer are told, with the reason.
    for (const who of [a, b]) {
      const last = (await told(who)).filter((i) => i.reason === "task_rejected");
      assert.deepEqual(last.map((i) => [i.task.by, i.task.reason]), [[c.peerId, "Row 4 reads TO in the scan."]]);
    }
  });

  test("21. a KEY that confirmed the accepted attempt may reject it later: both checks recorded, and each notice reads its own", async () => {
    const { owner, a, b, c, name } = await crew(2);
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    ok(await check(b, name, 1, "confirm"));
    assert.equal(ok(await check(c, name, 1, "confirm")).task.state, "accepted");
    const out = ok(await check(b, name, 1, "reject", { reason: "My audit fails row 4." }));
    assert.equal(out.task.state, "claimed");
    const rows = await fixture.owner<{ verdict: string; reason: string | null }[]>`
      select k.verdict, k.reason from schellingaf.task_checks k join schellingaf.tasks t on t.task_id = k.task_id
        join schellingaf.spaces s on s.space_id = t.space_id
       where s.name = ${name} and k.peer_id = ${Buffer.from(b.peerId, "hex")} order by k.checked_at`;
    assert.deepEqual(rows.map((r) => [r.verdict, r.reason]), [["confirm", null], ["reject", "My audit fails row 4."]]);
    // The submitter's mailbox: b's confirm keeps no reason, b's reject carries its own.
    const mine = (await told(a)).filter((i) => i.task.by === b.peerId);
    assert.deepEqual(mine.map((i) => [i.reason, i.task.reason ?? null]), [["task_confirmed", null], ["task_rejected", "My audit fails row 4."]]);
    // Asked again, it is the late check of the cycle before.
    refused(await check(b, name, 1, "reject", { reason: "Again." }), 409, "TASK_NOT_DONE", `claimed: rejected by ${b.peerId}`);
  });

  test("21b. a reject meant for the attempt the caller was offered never reopens the accepted one", async () => {
    const { owner, a, b, d, e, name } = await crew(2);
    await added(owner, name);
    assert.equal((await done(a, name, 1, await result(a, name))).status, 200);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    ok(await check(d, name, 1, "confirm", { attempt: 1 }));
    assert.equal(ok(await next(d, name, { job: "check" })).attempt, 2);
    assert.equal(ok(await check(e, name, 1, "confirm", { attempt: 1 })).task.state, "accepted");
    const meant = { kind: "obs", title: "Audit", body: "Audited.", task: { number: 1, check: "reject", reason: "Attempt 2 misreads row 4." } };
    refused(await call("POST", `/v1/spaces/${name}/posts`, d.token, { ...meant, dry_run: true }), 409, "TASK_NOT_DONE", "accepted");
    refused(await check(d, name, 1, "reject", { reason: "Attempt 2 misreads row 4." }), 409, "TASK_NOT_DONE", "accepted");
    assert.equal((await get(name, 1)).state, "accepted");
    // Named, the accepted attempt is reopened.
    assert.equal(ok(await check(d, name, 1, "reject", { attempt: 1, reason: "Attempt 1 misreads row 5." })).task.state, "claimed");
  });

  test("22. a doer is TASK_SELF_CHECK; another attempt, or a confirm, is TASK_NOT_DONE accepted as before; a writer where coordinators check is TASK_DENIED", async () => {
    const { owner, a, b, c, d, name } = await crew(1);
    await added(owner, name);
    const as = await result(a, name);
    assert.equal((await done(a, name, 1, as)).status, 200);
    assert.equal((await done(b, name, 1, await result(b, name))).status, 200);
    assert.equal(ok(await check(c, name, 1, "confirm", { attempt: 1 })).task.state, "accepted");
    refused(await check(a, name, 1, "reject"), 409, "TASK_SELF_CHECK", "attempt 1");
    refused(await check(b, name, 1, "reject"), 409, "TASK_SELF_CHECK", "attempt 2");
    refused(await check(d, name, 1, "reject", { attempt: 2 }), 409, "TASK_NOT_DONE", "accepted");
    refused(await check(d, name, 1, "confirm"), 409, "TASK_NOT_DONE", "accepted");
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmers: "coordinators" })).status, 200);
    refused(await check(d, name, 1, "reject"), 403, "TASK_DENIED", owner.peerId);
    // Its dry run says the same, and a dry run of the reopen passes.
    const dry = (who: Agent, task: Record<string, unknown>) => call("POST", `/v1/spaces/${name}/posts`, who.token, {
      kind: "obs", title: "Audit", body: "Audited.", dry_run: true, task: { number: 1, reason: "Fails.", ...task },
    });
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmers: "members" })).status, 200);
    refused(await dry(a, { check: "reject" }), 409, "TASK_SELF_CHECK", "attempt 1");
    refused(await dry(d, { check: "reject", attempt: 2 }), 409, "TASK_NOT_DONE", "accepted");
    assert.equal((await dry(c, { check: "reject" })).status, 200, "a former confirmer's reject");
    assert.equal((await dry(d, { check: "reject" })).status, 200);
  });

  test("23. a done dependent is held again; an accepted one stays accepted; at confirmations 0 the re-accepted after task does not accept the dependent it held", async () => {
    const { owner, coordinator, a, b, c, d, e, f, name } = await crew(0);
    const one = await added(owner, name);
    await added(owner, name, { title: "Page 4", after: [one.task_id] });
    await added(owner, name, { title: "Page 5", after: [one.task_id] });
    assert.equal((await done(a, name, 1, await result(a, name))).body.task.state, "accepted");
    // Task 2 done but contested by a live claim; task 3 accepted at once.
    ok(await next(c, name, { number: 2 }));
    assert.equal((await done(b, name, 2, await result(b, name))).body.task.state, "done");
    assert.equal((await done(d, name, 3, await result(d, name))).body.task.state, "accepted");
    ok(await check(coordinator, name, 1, "reject", { reason: "Page 3 is page 4." }));
    assert.equal((await get(name, 2)).check_waits_for, 1);
    assert.equal(await acceptAfter(name, 2), false);
    assert.equal((await get(name, 3)).state, "accepted");
    // Task 1 done again (contested: cycle 1) and confirmed: task 2 stays done, its check offered.
    assert.equal((await done(a, name, 1, await result(a, name, "Page 3, again."))).body.task.state, "done");
    assert.equal(ok(await check(e, name, 1, "confirm")).task.state, "accepted");
    const t = await get(name, 2);
    assert.deepEqual([t.state, t.check_waits_for], ["done", undefined]);
    assert.equal(ok(await next(f, name, { job: "check" })).task.number, 2);
  });
});

describe("the SPACE lock and the release", () => {
  test("a confirm of the after task racing its retire, and racing its reject: the dependent follows whichever landed first", async () => {
    for (let round = 0; round < 6; round++) {
      const { owner, coordinator, a, b, c, d, e, name } = await crew(0);
      await pair(owner, name);
      // Task 1 done but contested by c's live claim; task 2 held, to be accepted with it.
      ok(await next(c, name, { number: 1 }));
      assert.equal((await done(a, name, 1, await result(a, name))).body.task.state, "done");
      assert.equal((await done(b, name, 2, await result(b, name))).status, 200);
      assert.equal(await acceptAfter(name, 2), true);
      const [confirm, other] = await Promise.all([
        check(d, name, 1, "confirm"),
        round % 2 === 0 ? act(coordinator, name, 1, "retire", { reason: "Gone." }) : check(e, name, 1, "reject"),
      ]);
      const first = (await get(name, 1)).state;
      const second = await get(name, 2);
      if (confirm.status === 200) {
        // The confirm landed first: both accepted; a retire after it is refused, a reject reopens task 1 alone.
        assert.equal(second.state, "accepted");
        if (round % 2 === 0) refused(other, 409, "TASK_NOT_OPEN", "accepted");
        else assert.equal(first, "claimed");
      } else {
        assert.equal(second.state, "done");
        assert.equal(first, round % 2 === 0 ? "retired" : "claimed");
        assert.equal(second.check_waits_for, round % 2 === 0 ? undefined : 1);
      }
      assert.equal(await acceptAfter(name, 2), second.state === "done" && second.check_waits_for !== undefined);
    }
  });

  test("a retire with replacements fires the release: the dependent's check is offered, its after unchanged", async () => {
    const { owner, coordinator, a, d, name } = await crew(0);
    await pair(owner, name);
    assert.equal((await done(a, name, 2, await result(a, name))).status, 200);
    const before = (await get(name, 2)).after;
    const out = ok(await act(coordinator, name, 1, "retire", { reason: "Split in two.", tasks: [{ title: "Page 3a" }, { title: "Page 3b" }] }));
    assert.deepEqual(out.tasks.map((t: any) => t.number), [3, 4]);
    assert.deepEqual(out.dependents, [], "a done task's after never changes");
    const t = await get(name, 2);
    assert.deepEqual([t.state, t.check_waits_for, t.after], ["done", undefined, before]);
    assert.equal(await acceptAfter(name, 2), false);
    assert.equal(ok(await next(d, name, { job: "check" })).task.number, 2);
  });

  test("a POST with two confirms releases the dependents of both: the guard is cleared for the second", async () => {
    const { owner, a, b, c, d, e, name } = await crew(0);
    const one = await added(owner, name);
    const two = await added(owner, name, { title: "Page 4" });
    await added(owner, name, { title: "Check 3", after: [one.task_id] });
    await added(owner, name, { title: "Check 4", after: [two.task_id] });
    // Tasks 1 and 2 done, contested by a live claim each; 3 and 4 held.
    ok(await next(c, name, { number: 1 }));
    ok(await next(c, name, { number: 2 }));
    assert.equal((await done(a, name, 1, await result(a, name))).body.task.state, "done");
    assert.equal((await done(a, name, 2, await result(a, name))).body.task.state, "done");
    assert.equal((await done(b, name, 3, await result(b, name))).status, 200);
    assert.equal((await done(e, name, 4, await result(e, name))).status, 200);
    const out = await call("POST", `/v1/spaces/${name}/posts`, d.token, {
      posts: [
        { kind: "obs", title: "Checked 1", body: "Checked.", task: { number: 1, check: "confirm" } },
        { kind: "obs", title: "Checked 2", body: "Checked.", task: { number: 2, check: "confirm" } },
      ],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    for (const number of [1, 2, 3, 4]) assert.equal((await get(name, number)).state, "accepted", `task ${number}`);
  });

  test("the release's worklist reads tasks_accept_after_idx, never the SPACE's tasks", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const post = await result(owner, name);
    // Three thousand accepted tasks, so a walk of the SPACE's tasks shows.
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by, state, claimed_by, done_post_id, done_at, accepted_at,
                                     attempts, attempt)
      select s.space_id, g, 'task ' || g, s.owner_id, 'accepted', s.owner_id, ${post}::uuid, now(), now(), 1, 1
        from schellingaf.spaces s cross join generate_series(1, 3000) g where s.name = ${name}`;
    await fixture.owner`
      insert into schellingaf.task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id, at)
      select t.task_id, t.space_id, 1, 0, t.claimed_by, t.done_post_id, t.claimed_by, t.done_at
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id where s.name = ${name}`;
    const doer = await agent();
    const checker = await agent();
    await grant(owner, name, doer, "writer");
    await grant(owner, name, checker, "writer");
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, owner.token, { task_confirmations: 0 })).status, 200);
    const one = await added(owner, name);
    await added(owner, name, { after: [one.task_id] });
    ok(await next(checker, name, { number: 3001 }));
    assert.equal((await done(doer, name, 3001, await result(doer, name))).body.task.state, "done");
    assert.equal((await done(owner, name, 3002, await result(owner, name))).status, 200);
    assert.equal(await acceptAfter(name, 3002), true);
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
        await tx`select schellingaf.task_check(${name}, ${Buffer.from(owner.peerId, "hex")}, 3001, 'confirm')`;
        await tx`select schellingaf.next_job(${name}, ${Buffer.from(checker.peerId, "hex")}, 'check', null, null, ${tx.json(NEXT_WORDS as never)})`;
      });
    } finally {
      await su.end({ timeout: 5 });
    }
    const plans = logged.filter((m) => m.includes("{")).map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
    const walk = plans.filter((p) => /k\.accept_after AND v_id = ANY/.test(p["Query Text"]));
    assert.ok(walk.length > 0, plans.map((p) => p["Query Text"]).join("\n--\n"));
    const scans = walk.flatMap((p) => nodesOf(p.Plan)).filter((x) => x["Relation Name"] || x["Index Name"]);
    const shown = JSON.stringify(scans, ["Node Type", "Relation Name", "Index Name", "Index Cond", "Filter"], 1);
    assert.ok(scans.some((x) => x["Index Name"] === "tasks_accept_after_idx"), shown);
    assert.ok(!scans.some((x) => x["Node Type"] === "Seq Scan"), shown);
    // Whether a later attempt replaced one: a probe of task_attempts_replaces_idx, in a check
    // and in next's offers, never a walk of the attempts.
    const replaced = plans.filter((p) => /n\.replaces = /.test(p["Query Text"]))
      .flatMap((p) => nodesOf(p.Plan)).filter((x) => x.Alias === "n");
    const seen = JSON.stringify(replaced, ["Node Type", "Relation Name", "Alias", "Index Name", "Index Cond"], 1);
    assert.ok(replaced.length > 0 && replaced.every((x) => x["Index Name"] === "task_attempts_replaces_idx"), seen);
    // Released as the api role calls it: the dependent was accepted.
    assert.equal((await get(name, 3002)).state, "accepted");
  });
});
