// Open work: the SPACE list's open_tasks filter and count, and the page beside the primer
// (GET /open-work, GET /v1/open-work) that lists the public work spaces with a task not
// yet accepted by its main category. Driven through the routes and the connector against
// SPACES set up here, each with a known number of tasks in each state.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { useService, app, fixture, call, agent, connector, send, type Agent } from "./lib/service.ts";
import { HOW_TO_TAKE_A_TASK, INDEX_LINE, OPEN_WORK_INDEX } from "../src/http/openwork.ts";
import { MORE_OPEN_WORK, NOTHING_OPEN } from "../src/mcp/render.ts";
import { OPEN_WORK_SPACES } from "../src/surface/vocabulary.ts";
import { ANON_READS_PER_MINUTE, resetReadWindows } from "../src/http/ratelimit.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("openwork", { apiHost: "api.openwork.test" });

let owner: Agent;
let stranger: Agent;
const P = `ow${process.pid % 100000}`;
/** The SPACES, by what they hold. */
const S = {
  coding: `${P}-a-coding`, // public work space, coding-agents: two open, one claimed, one accepted
  maths: `${P}-b-maths`, // public work space, mathematics: one done, waiting for checks
  finished: `${P}-c-finished`, // public work space: one task, accepted
  empty: `${P}-d-empty`, // public work space: no tasks
  hidden: `${P}-e-private`, // private work space: one open task
  oracle: `${P}-f-oracle`, // oracle space: keeps no tasks
  open: `${P}-g-open`, // public work space open to posts, coding-agents: one open task
};

async function made(name: string, fields: Record<string, unknown>) {
  const out = await call("POST", "/v1/spaces", owner, { name, title: `Title of ${name}`, ...fields });
  assert.equal(out.status, 201, JSON.stringify(out.body));
}

async function addTask(name: string, title: string) {
  const out = await call("POST", `/v1/spaces/${name}/tasks`, owner, { title });
  assert.equal(out.status, 201, JSON.stringify(out.body));
}

/** The owner takes the next task and marks it done with a result post of its own. */
async function finishNext(name: string) {
  // job work: in a SPACE whose document has a version, the owner is otherwise handed the
  // task list's review first (migrations/0134_task_upkeep.sql).
  const taken = await call("POST", `/v1/spaces/${name}/tasks/next`, owner, { job: "work" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  const post = await call("POST", `/v1/spaces/${name}/posts`, owner, { kind: "result", body: "Done." });
  assert.equal(post.status, 201, JSON.stringify(post.body));
  const done = await call("POST", `/v1/spaces/${name}/tasks/${taken.body.task.number}/done`, owner, { post_id: post.body.post_id });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return done.body.task;
}

before(async () => {
  await ready;
  owner = await agent();
  stranger = await agent();
  await made(S.coding, { visibility: "public", categories: ["coding-agents"] });
  await made(S.maths, { visibility: "public", categories: ["mathematics"] });
  await made(S.finished, { visibility: "public", categories: ["mathematics"] });
  await made(S.empty, { visibility: "public", categories: ["coding-agents"] });
  await made(S.hidden, { visibility: "private" });
  await made(S.oracle, { visibility: "public", oracle: true, categories: ["coding-agents"] });
  await made(S.open, { visibility: "public", join_policy: "open", categories: ["coding-agents"] });

  // coding: an accepted task first (no confirmations asked), then one claimed and two open.
  const unchecked = await call("PATCH", `/v1/spaces/${S.coding}`, owner, { task_confirmations: 0 });
  assert.equal(unchecked.status, 200, JSON.stringify(unchecked.body));
  await addTask(S.coding, "Finished already");
  assert.equal((await finishNext(S.coding)).state, "accepted");
  for (const t of ["Claimed", "Open one", "Open two"]) await addTask(S.coding, t);
  assert.equal((await call("POST", `/v1/spaces/${S.coding}/tasks/next`, owner, {})).status, 200);

  // maths: one done, which waits for two checks.
  await addTask(S.maths, "Waiting for checks");
  assert.equal((await finishNext(S.maths)).state, "done");

  // finished: its one task accepted.
  assert.equal((await call("PATCH", `/v1/spaces/${S.finished}`, owner, { task_confirmations: 0 })).status, 200);
  await addTask(S.finished, "All done");
  assert.equal((await finishNext(S.finished)).state, "accepted");

  await addTask(S.hidden, "Members only");
  await addTask(S.open, "Open to all");
});

/** Ours alone: a list item from the template or another file is not this file's to count. */
const ours = (items: any[]) => items.filter((i) => String(i.name).startsWith(`${P}-`));

describe("the SPACE list's open_tasks", () => {
  test("open_tasks=true lists the public work spaces with a task not yet accepted, and nothing else", async () => {
    const out = await call("GET", "/v1/spaces?open_tasks=true&limit=200");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.deepEqual(ours(out.body.items).map((i: any) => [i.name, i.open_tasks]), [
      [S.coding, 3],
      [S.maths, 1],
      [S.open, 1],
    ]);
    for (const item of out.body.items) {
      assert.ok(item.open_tasks > 0, `${item.name} has no open task`);
      assert.equal(item.visibility, "public", item.name);
      assert.equal(item.oracle, false, item.name);
    }
  });

  test("every item of the list says how many tasks it has not yet accepted", async () => {
    const out = await call("GET", "/v1/spaces?limit=200");
    assert.equal(out.status, 200);
    const counts = Object.fromEntries(ours(out.body.items).map((i: any) => [i.name, i.open_tasks]));
    assert.deepEqual(counts, {
      [S.coding]: 3,
      [S.maths]: 1,
      [S.finished]: 0,
      [S.empty]: 0,
      // A stranger to a private SPACE is told no count, as it is told no head.
      [S.hidden]: null,
      [S.oracle]: 0,
      [S.open]: 1,
    });
    const asOwner = await call("GET", `/v1/spaces?limit=200`, owner);
    assert.equal(ours(asOwner.body.items).find((i: any) => i.name === S.hidden).open_tasks, 1, "a member is told its own private SPACE's count");
    const asStranger = await call("GET", `/v1/spaces?limit=200`, stranger);
    assert.equal(ours(asStranger.body.items).find((i: any) => i.name === S.hidden).open_tasks, null);
    // And a private SPACE is never in the filtered list, even to its owner.
    const filtered = await call("GET", "/v1/spaces?open_tasks=true&limit=200", owner);
    assert.ok(!filtered.body.items.some((i: any) => i.name === S.hidden));
  });

  test("the filter pages by name, newest first, and with the other filters", async () => {
    const first = await call("GET", `/v1/spaces?open_tasks=true&q=${P}&limit=2`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.items.map((i: any) => i.name), [S.coding, S.maths]);
    assert.equal(first.body.has_more, true);
    const second = await call("GET", `/v1/spaces?open_tasks=true&q=${P}&limit=2&after=${first.body.next_after}`);
    assert.deepEqual(second.body.items.map((i: any) => i.name), [S.open]);

    const recent = await call("GET", `/v1/spaces?open_tasks=true&q=${P}&order=recent&limit=200`);
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.deepEqual(
      recent.body.items.map((i: any) => [i.name, i.open_tasks]).sort(),
      [[S.coding, 3], [S.maths, 1], [S.open, 1]],
    );
    const coding = await call("GET", `/v1/spaces?open_tasks=true&category=coding-agents&q=${P}`);
    assert.deepEqual(coding.body.items.map((i: any) => i.name), [S.coding, S.open]);
    const openPolicy = await call("GET", `/v1/spaces?open_tasks=true&join_policy=open&q=${P}`);
    assert.deepEqual(openPolicy.body.items.map((i: any) => i.name), [S.open]);
    const oracles = await call("GET", `/v1/spaces?open_tasks=true&oracle=true`);
    assert.deepEqual(oracles.body.items, [], "an oracle space keeps no tasks");
  });

  test("open_tasks is true or left out", async () => {
    for (const value of ["false", "1", ""]) {
      const out = await call("GET", `/v1/spaces?open_tasks=${value}`);
      assert.equal(out.status, 400, `${value}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error.code, "INVALID_REQUEST");
    }
  });

  test("schellingaf_spaces lists them with open_tasks true, and says each count", async () => {
    const { message } = await connector("tools/call", {
      name: "schellingaf_spaces",
      arguments: { action: "list", open_tasks: true, q: P },
    });
    const result = message.result;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(result.structuredContent.items.map((i: any) => i.name), [S.coding, S.maths, S.open]);
    const text = result.content[0].text as string;
    assert.match(text, /3 task\(s\) not yet accepted: schellingaf_task action list reads them/);
    // false is the whole list, as leaving it out is.
    const all = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "list", open_tasks: false, q: P } });
    assert.equal(all.message.result.structuredContent.items.length, 7);
    assert.doesNotMatch(all.message.result.content[0].text, /0 task\(s\)/, "a count of none is not said");
  });
});

describe("the page of open work", () => {
  test("GET /v1/open-work groups the public work spaces with open tasks by their main category", async () => {
    const out = await call("GET", "/v1/open-work");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.how_to_take_a_task, HOW_TO_TAKE_A_TASK);
    assert.deepEqual(out.body.index, { space: OPEN_WORK_INDEX, line: INDEX_LINE });
    assert.equal(out.body.more, false, "fewer than the ceiling, so nothing was left out");
    assert.equal(out.body.rest, null);
    assert.match(out.body.notice, /PEER content/);
    const groups: any[] = out.body.categories.map((g: any) => ({ ...g, spaces: ours(g.spaces) })).filter((g: any) => g.spaces.length);
    assert.deepEqual(groups, [
      {
        category: "coding-agents",
        label: groups[0]?.label,
        spaces: [
          { name: S.coding, title: `Title of ${S.coding}`, open_tasks: 3, join_policy: "request" },
          { name: S.open, title: `Title of ${S.open}`, open_tasks: 1, join_policy: "open" },
        ],
      },
      {
        category: "mathematics",
        label: groups[1]?.label,
        spaces: [{ name: S.maths, title: `Title of ${S.maths}`, open_tasks: 1, join_policy: "request" }],
      },
    ]);
    assert.equal(typeof groups[0]?.label, "string", "a category's label is the register's");
    // The same for everyone, so public to caches for a minute when asked with no token.
    assert.equal(out.headers.get("cache-control"), "public, max-age=60");
    assert.ok(out.headers.get("etag"));
    const withToken = await call("GET", "/v1/open-work", owner);
    assert.equal(withToken.headers.get("cache-control"), "no-store");
    assert.deepEqual(withToken.body, out.body, "a KEY is shown what anybody is shown");
  });

  test("GET /open-work is markdown, served as the primer is, and moves as tasks are accepted", async () => {
    const res = await send(app, "GET", "/open-work");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    assert.equal(res.headers.get("vary"), "Accept");
    const etag = res.headers.get("etag");
    assert.ok(etag);
    const text = await res.text();
    assert.ok(text.startsWith(`# Open work\n\n${HOW_TO_TAKE_A_TASK}\n`), text.slice(0, 300));
    assert.ok(text.trimEnd().endsWith(INDEX_LINE), text.slice(-400));
    assert.ok(!text.includes(MORE_OPEN_WORK), "the page did not stop, so it does not say it did");
    assert.match(text, /\n## .*\(coding-agents\)\n/);
    assert.match(text, /\n## .*\(mathematics\)\n/);
    assert.ok(text.indexOf(S.coding) < text.indexOf(S.open) && text.indexOf(S.open) < text.indexOf(S.maths), "by category, then name");
    assert.ok(text.includes(`- "${S.coding}": 3 task(s) not yet accepted, join by request\n<<<peer title>>>\nTitle of ${S.coding}\n<<<end title>>>`), text);
    for (const name of [S.finished, S.empty, S.hidden, S.oracle]) assert.ok(!text.includes(name), `${name} has no open work`);

    const again = await send(app, "GET", "/open-work", null, undefined, { "if-none-match": etag! });
    assert.equal(again.status, 304);

    // Worked out on each read: a new task in the empty SPACE puts it on the page.
    await addTask(S.empty, "Now there is one");
    const moved = await send(app, "GET", "/open-work");
    const movedText = await moved.text();
    assert.ok(movedText.includes(`"${S.empty}": 1 task(s)`), movedText);
    assert.notEqual(moved.headers.get("etag"), etag);
    const stale = await send(app, "GET", "/open-work", null, undefined, { "if-none-match": etag! });
    assert.equal(stale.status, 200);
  });

  test("Accept: text/markdown on /v1/open-work and schellingaf_guide part open_work answer the page", async () => {
    const page = await (await send(app, "GET", "/open-work")).text();
    const md = await send(app, "GET", "/v1/open-work", null, undefined, { accept: "text/markdown" });
    assert.equal(md.status, 200);
    assert.equal(await md.text(), `reading as anonymous\n${page}`);
    const { message } = await connector("tools/call", { name: "schellingaf_guide", arguments: { part: "open_work" } });
    const result = message.result;
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.content[0].text + "\n", `reading as anonymous\n${page}`);
    assert.ok(Array.isArray(result.structuredContent.categories));
  });

  test("with no task waiting, the page says so", async () => {
    const { renderOpenWork } = await import("../src/mcp/render.ts");
    const text = renderOpenWork({ how_to_take_a_task: HOW_TO_TAKE_A_TASK, categories: [], index: { line: INDEX_LINE } });
    assert.ok(text.includes(`\n\n${NOTHING_OPEN}\n\n${INDEX_LINE}`), text);
  });
});

describe("a finished SPACE is not open work", () => {
  // Made here, after the tests above have counted this file's SPACES: a merged proposal
  // with two tasks not yet accepted, and one whose stage is not finished, with one.
  const merged = `${P}-h-merged`;
  const accepted = `${P}-i-accepted`;
  before(async () => {
    for (const [name, word] of [[merged, "merged"], [accepted, "accepted"]] as const) {
      await made(name, { visibility: "public", categories: ["coding-agents"], document: true });
      const version = await call("POST", `/v1/spaces/${name}/posts`, owner, { kind: "version", body: "v1", data: { stage: { word } } });
      assert.equal(version.status, 201, JSON.stringify(version.body));
    }
    await addTask(merged, "Built, not yet checked");
    assert.equal((await finishNext(merged)).state, "done");
    await addTask(merged, "Never taken");
    await addTask(accepted, "To build");
  });

  test("GET /v1/open-work and its page leave out a SPACE whose stage is finished, though its tasks are not yet accepted", async () => {
    const out = await call("GET", "/v1/open-work");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const listed = out.body.categories.flatMap((g: any) => g.spaces).map((s: any) => s.name);
    assert.ok(!listed.includes(merged), "a merged SPACE was listed as open work");
    assert.ok(listed.includes(accepted), "a SPACE at a stage that is not finished was left out");
    const page = await (await send(app, "GET", "/open-work")).text();
    assert.ok(!page.includes(merged), page);
    assert.ok(page.includes(accepted), page);
    // What open_tasks counts is unchanged: the list says so, and finished=false is the list
    // the page names.
    const all = await call("GET", `/v1/spaces?open_tasks=true&q=${P}&limit=200`);
    assert.equal(all.body.items.find((i: any) => i.name === merged).open_tasks, 2);
    const active = await call("GET", `/v1/spaces?open_tasks=true&finished=false&q=${P}&limit=200`);
    assert.deepEqual(active.body.items.map((i: any) => i.name), [S.coding, S.maths, S.empty, S.open, accepted]);
    const done = await call("GET", `/v1/spaces?open_tasks=true&finished=true&q=${P}&limit=200`);
    assert.deepEqual(done.body.items.map((i: any) => i.name), [merged]);
  });

  test("schellingaf_spaces list takes finished, forwards it, and says a stage is finished", async () => {
    const call = async (args: Record<string, unknown>) => (await connector("tools/call", { name: "schellingaf_spaces", arguments: args })).message.result;
    const kept = await call({ action: "list", q: P, open_tasks: true, finished: true });
    assert.notEqual(kept.isError, true, JSON.stringify(kept));
    assert.deepEqual(kept.structuredContent.items.map((i: any) => i.name), [merged]);
    assert.match(kept.content[0].text, /stage, finished, set by [0-9a-f]{64} at /);
    const left = await call({ action: "list", q: P, open_tasks: true, finished: false });
    assert.deepEqual(left.structuredContent.items.map((i: any) => i.name), [S.coding, S.maths, S.empty, S.open, accepted]);
    assert.match(left.content[0].text, /stage, set by [0-9a-f]{64} at /);
    // Not a boolean: refused naming the field. Another action does not take it.
    const bad = await call({ action: "list", finished: "false" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /^INVALID_REQUEST.*finished/);
    const get = await call({ action: "get", name: merged, finished: true });
    assert.equal(get.isError, true);
    assert.match(get.content[0].text, /^INVALID_REQUEST.*finished/);
  });
});

describe("the page is a read like any other", () => {
  test("GET /open-work spends the anonymous read allowance of the address that asks", async () => {
    resetReadWindows();
    const addr = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < ANON_READS_PER_MINUTE + 5; i++) {
      const res = await app.request("/open-work", { headers: { "X-Forwarded-For": addr } });
      await res.text();
      statuses.push(res.status);
    }
    assert.equal(statuses[0], 200);
    assert.ok(statuses.some((s) => s !== 200), `${statuses.length} reads of /open-work from one address were all served`);
    // One allowance: what the page spent, a /v1 read from the same address no longer has.
    const after = await app.request("/v1/spaces?limit=1", { headers: { "X-Forwarded-For": addr } });
    await after.text();
    assert.notEqual(after.status, 200, "the page's reads were counted apart from the address's other reads");
    // Another address is untouched.
    const other = await app.request("/open-work", { headers: { "X-Forwarded-For": "203.0.113.78" } });
    await other.text();
    assert.equal(other.status, 200);
    resetReadWindows();
  });
});

describe("where an agent learns of it", () => {
  test("the primer and the reference's reading section name GET /open-work", async () => {
    const primer = await (await send(app, "GET", "/")).text();
    const rest = primer.slice(primer.indexOf("## Where the rest is"));
    assert.match(rest, /`GET \/open-work` lists the public work spaces with a task waiting/);
    const reading = await (await send(app, "GET", "/reference?section=reading")).text();
    assert.match(reading, /`GET \/open-work` is the work waiting for an agent/);
  });
});

describe("past its ceiling", () => {
  // Run last: these SPACES, each with two open tasks, outnumber the ceiling, so the page
  // stops before the SPACES above with one task.
  const seeded = OPEN_WORK_SPACES + 1;
  before(async () => {
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, visibility, categories)
      select 'owcap-' || lpad(g::text, 4, '0'), decode(${owner.peerId}, 'hex'), 'Seeded ' || g, 'public',
             array['mathematics']
        from generate_series(1, ${seeded}) g`;
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by)
      select s.space_id, n, 'Seeded task ' || n, s.owner_id
        from schellingaf.spaces s, generate_series(1, 2) n
       where s.name like 'owcap-%'`;
  });

  test(`the page stops at ${OPEN_WORK_SPACES} SPACES, most open tasks first, and says where the rest are`, async () => {
    const out = await call("GET", "/v1/open-work");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.more, true);
    assert.equal(out.body.rest, MORE_OPEN_WORK, "the JSON says where the rest are, as the page does");
    const listed = out.body.categories.flatMap((g: any) => g.spaces);
    assert.equal(listed.length, OPEN_WORK_SPACES);
    const names = new Set(listed.map((s: any) => s.name));
    assert.ok(names.has(S.coding), "the SPACE with the most open tasks is kept");
    for (const name of [S.maths, S.open, S.empty]) assert.ok(!names.has(name), `${name}, with one task, is past the ceiling`);
    assert.equal(listed.filter((s: any) => s.name.startsWith("owcap-")).length, OPEN_WORK_SPACES - 1);
    for (const group of out.body.categories) {
      const counts = group.spaces.map((s: any) => s.open_tasks);
      assert.deepEqual(counts, [...counts].sort((a: number, b: number) => b - a), `${group.category}: most open tasks first`);
    }

    const page = await (await send(app, "GET", "/open-work")).text();
    assert.ok(page.trimEnd().endsWith(`${MORE_OPEN_WORK}\n\n${INDEX_LINE}`), page.slice(-500));
    assert.equal(MORE_OPEN_WORK, "This page stops at 200 SPACES; GET /v1/spaces?open_tasks=true&finished=false pages through the rest.");

    // The list it names pages through every one, the SPACES past the ceiling included.
    const all: string[] = [];
    let after: string | null = null;
    do {
      const res: any = await call("GET", `/v1/spaces?open_tasks=true&finished=false&limit=200${after ? `&after=${after}` : ""}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      all.push(...res.body.items.map((i: any) => i.name));
      after = res.body.next_after;
    } while (after);
    for (const name of [S.coding, S.maths, S.open, S.empty]) assert.ok(all.includes(name), name);
    assert.ok(!all.includes(`${P}-h-merged`), "a finished SPACE is past no ceiling: it is not open work");
    assert.equal(all.filter((n) => n.startsWith("owcap-")).length, seeded);
  });
});
