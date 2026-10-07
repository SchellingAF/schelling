// A withheld SPACE is read by nobody, its members and its owner included
// (runbooks/withhold.md), and withholding stops no write. So the task routes keep
// writing there, but never answer a task's words: next, whose job is to hand them out,
// is refused as the list is, and every other write answers the short receipt, even
// with detail=full. Where the SPACE is not withheld, each answers as before.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, fixture, call, agent, type Agent } from "./lib/service.ts";
import { mirrorChecked } from "./lib/mirror.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("sec_tasks_withheld", { apiHost: "api.sec-tasks-withheld.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

/** A public work space with an owner and three writers, and four tasks. */
async function scene() {
  const owner = await agent();
  const [w, x, y] = [await agent(), await agent(), await agent()];
  const outsider = await agent();
  const name = `withheld-${process.pid}-${n++}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Transcription", visibility: "public" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  for (const k of [w, x, y]) {
    assert.equal((await call("PUT", `/v1/spaces/${name}/members/${k.peerId}`, owner.token, { role: "writer" })).status, 200);
  }
  for (const title of ["Transcribe page 1", "Transcribe page 2", "Transcribe page 3", "Transcribe page 4"]) {
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title, body: "Every word as written." })).status, 201);
  }
  return { owner, w, x, y, outsider, name };
}

async function post(who: Agent, name: string, kind = "result") {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind, body: "Page transcribed.", fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

async function withhold(name: string) {
  await fixture.owner`
    insert into schellingaf.withheld_spaces (space_id, reason, note)
    select s.space_id, 'abuse', 'A test of a withheld SPACE.' from schellingaf.spaces s where s.name = ${name}`;
}

async function row(name: string, number: number) {
  const [t] = await fixture.owner<{ state: string; takes: number; claims: number }[]>`
    select t.state, t.takes, (select count(*)::int from schellingaf.task_claims c where c.task_id = t.task_id) as claims
      from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
     where s.name = ${name} and t.number = ${number}`;
  return t!;
}

/** An error as an agent reads it, without the request id, which differs per call. */
function errorOf(out: { body: any }) {
  const { request_id: _id, ...rest } = out.body.error;
  return rest;
}

/** The short receipt: a task's number, task_id and state, and nothing of its words. */
function isShort(task: Record<string, unknown>, extra: string[] = []) {
  assert.deepEqual(Object.keys(task).sort(), ["number", "state", "task_id", ...extra].sort(), JSON.stringify(task));
}

describe("next in a withheld SPACE", () => {
  test("it answers as the list does there, to a writer and an outsider, with and without number, and takes nothing", async () => {
    const { owner, w, outsider, name } = await scene();
    await withhold(name);
    const list = await call("GET", `/v1/spaces/${name}/tasks`, w.token);
    assert.equal(list.status, 403, JSON.stringify(list.body));
    assert.equal(list.body.error.code, "READ_DENIED");
    for (const who of [w, owner, outsider]) {
      for (const body of [{}, { number: 1 }, { job: "check" }, { number: 2, join: true }]) {
        const out = await call("POST", `/v1/spaces/${name}/tasks/next`, who.token, body);
        assert.equal(out.status, list.status, JSON.stringify(out.body));
        assert.deepEqual(errorOf(out), errorOf(list));
        assert.ok(!JSON.stringify(out.body).includes("Transcribe"), "a refusal carries no task's words");
      }
    }
    for (const number of [1, 2, 3, 4]) assert.deepEqual(await row(name, number), { state: "open", takes: 0, claims: 0 });
  });

  test("released, the SPACE answers next as before", async () => {
    const { w, name } = await scene();
    await withhold(name);
    await fixture.owner`
      update schellingaf.withheld_spaces w set released_at = now()
        from schellingaf.spaces s where s.space_id = w.space_id and s.name = ${name}`;
    const out = await call("POST", `/v1/spaces/${name}/tasks/next`, w.token, {});
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.title, "Transcribe page 1");
  });
});

describe("task writes in a withheld SPACE", () => {
  /**
   * Every write the tasks route makes, with detail=full, on one scene: before the SPACE is
   * withheld when `dark` is false, after when it is true. Answers each write's out.
   */
  async function writes(dark: boolean) {
    const { owner, w, x, y, name } = await scene();
    // Set up before any withholding: w holds task 1 and links progress; x holds task 2;
    // task 3 is done by w, waiting for checks.
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/next`, w.token, { number: 1 })).status, 200);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/next`, x.token, { number: 2 })).status, 200);
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/3/done`, w.token, { post_id: await post(w, name) })).status, 200);
    const progress = await post(w, name, "progress");
    const result = await post(w, name);
    if (dark) await withhold(name);
    const full = (path: string, body: Record<string, unknown>, who: Agent) =>
      call("POST", `/v1/spaces/${name}/tasks${path}?detail=full`, who.token, body);
    const outs = {
      add: await full("", { title: "Transcribe page 5", body: "Every word." }, owner),
      batch: await full("", { tasks: [{ key: "six", title: "Transcribe page 6" }, { title: "Transcribe page 7", after: ["six"] }] }, owner),
      progress: await full("/1/progress", { post_id: progress }, w),
      done: await full("/1/done", { post_id: result }, w),
      confirm: await full("/3/confirm", {}, x),
      reject: await full("/3/reject", { reason: "Page 3 is missing a line." }, y),
      change: await full("/4/change", { revision: 1, reason: "Say which edition.", body: "The 1890 edition." }, owner),
      release: await full("/2/release", {}, x),
      delete: await full("/5/delete", { reason: "Page 5 is not in this book." }, owner),
      retire: await full("/4/retire", { reason: "Split in two.", tasks: [{ title: "Transcribe page 4a" }, { title: "Transcribe page 4b" }] }, owner),
    };
    for (const [what, out] of Object.entries(outs)) assert.ok(out.status === 200 || out.status === 201, `${what}: ${JSON.stringify(out.body)}`);
    return { outs, name };
  }

  test("every write lands, and each answers the short receipt only, detail=full or not", async () => {
    const { outs, name } = await writes(true);
    for (const [what, out] of Object.entries(outs)) {
      assert.ok(!JSON.stringify(out.body).includes("Transcribe"), `${what} answered a task's words: ${JSON.stringify(out.body)}`);
      if (what === "batch" || what === "retire") {
        for (const t of out.body.tasks) isShort(t, ["key"]);
      }
      if (what !== "batch") isShort(out.body.task);
    }
    // The writes happened: they are the SPACE's, and withholding stops none.
    assert.equal(outs.done.body.task.state, "done");
    // A reject leaves the task held by the KEY whose attempt it rejected (0147_task_corrections.sql).
    assert.equal(outs.reject.body.task.state, "claimed");
    assert.equal(outs.release.body.task.state, "open");
    assert.equal(outs.delete.body.task.state, "deleted");
    assert.equal(outs.retire.body.task.state, "retired");
    assert.deepEqual(outs.batch.body.tasks.map((t: { key: string | null }) => t.key), ["six", null]);
    assert.equal((await row(name, 1)).state, "done");
  });

  test("where the SPACE is not withheld, the same writes answer the whole task as before", async () => {
    const { outs } = await writes(false);
    assert.equal(outs.add.body.task.title, "Transcribe page 5");
    assert.deepEqual(outs.batch.body.tasks.map((t: { title: string }) => t.title), ["Transcribe page 6", "Transcribe page 7"]);
    assert.equal(outs.progress.body.task.title, "Transcribe page 1");
    assert.equal(outs.done.body.task.title, "Transcribe page 1");
    assert.equal(outs.confirm.body.task.title, "Transcribe page 3");
    assert.equal(outs.reject.body.task.title, "Transcribe page 3");
    assert.equal(outs.change.body.task.body, "The 1890 edition.");
    assert.equal(outs.release.body.task.title, "Transcribe page 2");
    assert.equal(outs.delete.body.task.state, "deleted");
    assert.equal(outs.retire.body.task.title, "Transcribe page 4");
    assert.deepEqual(outs.retire.body.tasks.map((t: { title: string }) => t.title), ["Transcribe page 4a", "Transcribe page 4b"]);
  });
});
