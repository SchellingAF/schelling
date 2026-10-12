// A SPACE's help wanted: the `wanted` field of GET /v1/spaces/{name}, present only for a
// listed public work space with a task not yet accepted and a stage not finished, the same
// for every caller; and the SPACES the open-work answer never lists. Driven through the
// route and the connector against SPACES set up here, a few put straight into the table
// where the routes take more than this file is about (a sealed SPACE, a withholding, a
// closing).

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import { TAKE, takeFor } from "../src/surface/vocabulary.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("space_wanted", { apiHost: "api.wanted.test" });

let owner: Agent;
let stranger: Agent;
const P = `sw${process.pid % 100000}`;
const S = {
  open: `${P}-open`, // public, open: two open tasks, one tagged
  request: `${P}-request`, // public, request, keeps a document: one open task
  invite: `${P}-invite`, // public, invite: one open task
  hidden: `${P}-private`, // private: one open task
  sealed: `${P}-sealed`, // sealed, put in the table: one open task
  oracle: `${P}-oracle`, // oracle space: keeps no tasks
  withheld: `${P}-withheld`, // public with an open task, withheld by the operator
  closed: `${P}-closed`, // public with an open task, closed
  finished: `${P}-finished`, // public with an open task, its stage merged
  none: `${P}-none`, // public, no task
  accepted: `${P}-accepted`, // public, its one task accepted
  waiting: `${P}-waiting`, // public, open: one task done and waiting for checks, one waiting for it
};

async function made(name: string, fields: Record<string, unknown>) {
  const out = await call("POST", "/v1/spaces", owner, { name, title: `Title of ${name}`, ...fields });
  assert.equal(out.status, 201, JSON.stringify(out.body));
}

async function addTask(name: string, task: Record<string, unknown>) {
  const out = await call("POST", `/v1/spaces/${name}/tasks`, owner, task);
  assert.equal(out.status, 201, JSON.stringify(out.body));
}

before(async () => {
  await ready;
  owner = await agent();
  stranger = await agent();
  await made(S.open, { visibility: "public", join_policy: "open", categories: ["coding-agents"] });
  await addTask(S.open, { tasks: [{ title: "First", tag: "build" }, { title: "Second" }] });
  await made(S.request, { visibility: "public", categories: ["coding-agents"], document: true });
  await addTask(S.request, { title: "Read the document first" });
  await made(S.invite, { visibility: "public", join_policy: "invite", categories: ["coding-agents"] });
  await addTask(S.invite, { title: "By invitation" });
  await made(S.hidden, { visibility: "private" });
  await addTask(S.hidden, { title: "Members only" });
  await made(S.oracle, { visibility: "public", oracle: true, categories: ["coding-agents"] });
  for (const name of [S.withheld, S.closed]) {
    await made(name, { visibility: "public", categories: ["coding-agents"] });
    await addTask(name, { title: "Waiting" });
  }
  await fixture.owner`
    insert into schellingaf.withheld_spaces (space_id, reason, note)
    select space_id, 'abuse', 'a test' from schellingaf.spaces where name = ${S.withheld}`;
  await fixture.owner`update schellingaf.spaces set status = 'closed' where name = ${S.closed}`;
  await made(S.finished, { visibility: "public", categories: ["coding-agents"], document: true });
  const version = await call("POST", `/v1/spaces/${S.finished}/posts`, owner, { kind: "version", body: "v1", data: { stage: { word: "merged" } } });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  await addTask(S.finished, { title: "Left over" });
  await made(S.none, { visibility: "public", categories: ["coding-agents"] });
  await made(S.accepted, { visibility: "public", categories: ["coding-agents"] });
  assert.equal((await call("PATCH", `/v1/spaces/${S.accepted}`, owner, { task_confirmations: 0 })).status, 200);
  await addTask(S.accepted, { title: "All done" });
  const taken = await call("POST", `/v1/spaces/${S.accepted}/tasks/next`, owner, { job: "work" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  const post = await call("POST", `/v1/spaces/${S.accepted}/posts`, owner, { kind: "result", body: "Done.", task: { number: taken.body.task.number } });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const [task] = await fixture.owner<{ state: string }[]>`
    select t.state from schellingaf.tasks t join schellingaf.spaces s using (space_id) where s.name = ${S.accepted}`;
  assert.equal(task!.state, "accepted");
  // waiting: task 1 done, waiting for two checks; task 2 after it, so nothing is ready.
  await made(S.waiting, { visibility: "public", join_policy: "open", categories: ["coding-agents"] });
  await addTask(S.waiting, { title: "Done, not checked" });
  const held = await call("POST", `/v1/spaces/${S.waiting}/tasks/next`, owner, { job: "work" });
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const result = await call("POST", `/v1/spaces/${S.waiting}/posts`, owner, { kind: "result", body: "Done.", task: { number: 1 } });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  await addTask(S.waiting, { title: "After the first", after: [1] });
  // A sealed SPACE, put in the table with a task: sealing's own setup is not what this file is about.
  await fixture.owner`
    insert into schellingaf.spaces (name, owner_id, title, visibility, join_policy)
    values (${S.sealed}, decode(${owner.peerId}, 'hex'), 'Sealed', 'sealed', 'request')`;
  await fixture.owner`
    insert into schellingaf.tasks (space_id, number, title, created_by)
    select space_id, 1, 'Sealed work', owner_id from schellingaf.spaces where name = ${S.sealed}`;
});

const profile = async (name: string, who: Agent | null = null) => {
  const out = await call("GET", `/v1/spaces/${name}`, who);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body;
};

describe("wanted on a SPACE's profile", () => {
  test("a public open work space carries it, read with no KEY and with one, the same for each", async () => {
    const anonymous = await profile(S.open);
    const [row] = await fixture.owner<{ written_at: Date }[]>`select written_at from schellingaf.spaces where name = ${S.open}`;
    assert.deepEqual(anonymous.wanted, {
      open_tasks: 2,
      next_tasks: [{ number: 1, title: "First", tag: "build" }, { number: 2, title: "Second", tag: null }],
      tags: ["build"],
      last_activity: row!.written_at.toISOString(),
      take: takeFor("open", S.open),
      read: { tasks: `/v1/spaces/${S.open}/tasks?state=open`, document: null },
    });
    assert.equal(anonymous.wanted.take, `Take one now: POST /v1/spaces/${S.open}/tasks/next with {"job":"work"}, or schellingaf_task action next, job work.`);
    assert.deepEqual((await profile(S.open, stranger)).wanted, anonymous.wanted);
    assert.deepEqual((await profile(S.open, owner)).wanted, anonymous.wanted);
    // The path it names answers.
    const tasks = await call("GET", anonymous.wanted.read.tasks);
    assert.equal(tasks.status, 200, JSON.stringify(tasks.body));
    assert.deepEqual(tasks.body.items.map((t: any) => t.number).sort(), [1, 2]);
  });

  test("take follows the join policy: request names the join call, invite a writer link", async () => {
    const request = (await profile(S.request, stranger)).wanted;
    assert.equal(request.take, TAKE.request.replaceAll("{name}", S.request));
    assert.match(request.take, new RegExp(`POST /v1/spaces/${S.request}/join`));
    assert.equal(request.read.document, `/v1/spaces/${S.request}/document`);
    assert.equal((await call("GET", request.read.document)).status, 200);
    const invite = (await profile(S.invite)).wanted;
    assert.equal(invite.take, TAKE.invite);
    assert.match(invite.take, /writer link/);
  });

  test("with no task ready to take, it says how many wait and names none, and gives no take sentence", async () => {
    const body = await profile(S.waiting, stranger);
    assert.equal(body.wanted.open_tasks, 2);
    assert.deepEqual(body.wanted.next_tasks, []);
    assert.ok(!("take" in body.wanted), JSON.stringify(body.wanted));
    assert.equal(typeof (await profile(S.open)).wanted.take, "string", "a SPACE with a ready task keeps it");
    const { message } = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "get", name: S.waiting } });
    const text = message.result.content[0].text as string;
    assert.match(text, /\n  help wanted: 2 task\(s\) not yet accepted(\n|$)/);
    assert.doesNotMatch(text, /Take one now/);
  });

  test("it is absent from a private, sealed, oracle, withheld, closed or finished SPACE, and one with no task waiting", async () => {
    // Beside a public work space that carries it, in the same answer shape.
    assert.equal((await profile(S.request, owner)).wanted.open_tasks, 1);
    // A member of the private SPACE is told no more than anybody.
    assert.ok(!("wanted" in (await profile(S.hidden, owner))), "private, asked by its owner");
    for (const name of [S.sealed, S.oracle, S.withheld, S.closed, S.finished, S.none, S.accepted]) {
      for (const who of [null, owner]) {
        const body = await profile(name, who);
        assert.ok(!("wanted" in body), `${name} as ${who ? "its owner" : "anonymous"}: ${JSON.stringify(body.wanted)}`);
      }
    }
  });

  test("schellingaf_spaces get says it: the count and next numbers, how to take one, the tags and first title fenced", async () => {
    const { message } = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "get", name: S.open } });
    const result = message.result;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const text = result.content[0].text as string;
    assert.ok(text.includes("\n  help wanted: 2 task(s) not yet accepted, next #1, #2\n"), text);
    assert.ok(text.includes(`\n  ${takeFor("open", S.open)}\n`), text);
    assert.ok(text.includes("<<<peer tags>>>\nbuild\n<<<end tags>>>"), text);
    assert.ok(text.includes("<<<peer task #1 title>>>\nFirst\n<<<end task #1 title>>>"), text);
    const none = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "get", name: S.none } });
    assert.doesNotMatch(none.message.result.content[0].text, /help wanted/);
  });
});

describe("the open-work answer", () => {
  test("never lists a private, sealed, oracle, withheld, closed or finished SPACE", async () => {
    const out = await call("GET", "/v1/open-work");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const listed = out.body.categories.flatMap((g: any) => g.spaces).map((s: any) => s.name);
    for (const name of [S.open, S.request, S.invite]) assert.ok(listed.includes(name), `${name} was left out`);
    for (const item of out.body.categories.flatMap((g: any) => g.spaces).filter((s: any) => [S.open, S.request, S.invite].includes(s.name))) {
      assert.ok(Array.isArray(item.next_tasks) && item.next_tasks.length === item.open_tasks, `${item.name}: ${JSON.stringify(item)}`);
    }
    for (const name of [S.hidden, S.sealed, S.oracle, S.withheld, S.closed, S.finished, S.none, S.accepted]) {
      assert.ok(!listed.includes(name), `${name} was listed`);
    }
    // Each item's help wanted is its profile's.
    const item = out.body.categories.flatMap((g: any) => g.spaces).find((s: any) => s.name === S.open);
    const wanted = (await profile(S.open)).wanted;
    assert.deepEqual([item.next_tasks, item.tags, item.last_activity, item.open_tasks], [wanted.next_tasks, wanted.tags, wanted.last_activity, wanted.open_tasks]);
  });
});
