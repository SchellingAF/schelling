// Several claims of one task: migrations/0141_task_claims.sql holds every rule. next without
// a number never hands a task another KEY holds; next with a number and join holds it beside
// them, up to TASK_LIMITS.claimants live claims; the row mirrors the claim rows. These drive
// the rules through the routes, as an agent would, and read the database only to set a scene
// a route cannot, such as a claim that has passed. After every case, task_mirror_faults()
// answers nothing: every row mirrors its claims and attempts.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { useService, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import { claimUntil, claimRows } from "./lib/claims.ts";
import { mirrorChecked } from "./lib/mirror.ts";
import { PORT, SUPERUSER, MIGRATE_PASSWORD } from "./bootstrap.ts";
import { publicKey } from "./helpers.ts";
import { TASK_LIMITS } from "../src/surface/vocabulary.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";
import { statementsOf } from "../src/db/migrate.ts";
import { buildOpenApi } from "../src/surface/openapi.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
});
const ready = useService("task_claims", { apiHost: "api.task-claims.test" });
mirrorChecked();
before(async () => {
  await ready;
});

let n = 0;

async function workSpace(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `claims-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Transcription", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
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

/** next with number and join, as a KEY asks to hold a task beside its holders. */
async function join(who: Agent, name: string, number: number) {
  return next(who, name, { number, join: true });
}

async function act(who: Agent, name: string, number: number, action: string, fields?: Record<string, unknown>, detail = "full") {
  return call("POST", `/v1/spaces/${name}/tasks/${number}/${action}${detail ? `?detail=${detail}` : ""}`, who.token, fields);
}

async function get(name: string, number: number) {
  const out = await call("GET", `/v1/spaces/${name}/tasks/${number}`);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.task as Record<string, any>;
}

async function result(who: Agent, name: string, body = "Page 3, transcribed.") {
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token, {
    kind: "result", body, fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.post_id as string;
}

/** Each task notice of a KEY: reason and number, in mailbox order. */
async function told(who: Agent) {
  const out = await call("GET", "/v1/mailbox", who.token);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return (out.body.items as any[]).filter((i) => i.reason.startsWith("task_")).map((i) => [i.reason, i.task.number]);
}

function refused(out: { status: number; body: any }, status: number, code: string, detail?: string) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
  if (detail !== undefined) assert.equal(out.body.error.detail, detail);
}

/** The owner, a coordinator and six writers of one public work space, two confirmations unless set. */
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

/** The row as the database keeps it: holder, claimed_until and state. */
async function row(name: string, number: number) {
  const [r] = await fixture.owner<{ state: string; claimed_by: string | null; claimed_until: Date | null }[]>`
    select t.state, encode(t.claimed_by, 'hex') as claimed_by, t.claimed_until
      from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
     where s.name = ${name} and t.number = ${number}`;
  return r!;
}

describe("next and join", () => {
  test("next without a number never hands a held task to another KEY", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    assert.equal((await next(a, name)).body.task.number, 1);
    const other = await next(b, name, { job: "work" });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.job, "stop");
    assert.deepEqual((await claimRows(name, 1)).map((c) => c.by), [a.peerId]);
  });

  test("next with the number of a held task and no join is TASK_NOT_OPEN naming join; join without number is INVALID_REQUEST", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    refused(await next(b, name, { number: 1 }), 409, "TASK_NOT_OPEN", "claimed: send join true to hold it beside them");
    refused(await next(b, name, { join: true }), 400, "INVALID_REQUEST", "join needs number");
    const viaTool = await connector("tools/call", { name: "schellingaf_task", arguments: { action: "next", space: name, join: true } }, b.token);
    assert.equal(viaTool.message.result.isError, true, JSON.stringify(viaTool.message));
    assert.match(viaTool.message.result.content[0].text, /join needs number/);
  });

  test("with join a KEY holds the task beside its holder, and the answer names every claimant", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    await next(a, name);
    const out = await join(b, name, 1);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.job, "work");
    assert.equal(out.body.renewed, false);
    assert.equal(out.body.joined, undefined, "joined is next_job's, never an answer's");
    assert.equal(out.body.why, NEXT_WORDS.why.joined.replace("{number}", "1").replace("{others}", "1"));
    // It reads right with one other KEY and with several.
    assert.match(out.body.why, /^You hold task 1\. KEYS holding it beside you: 1\./);
    const third = await join(c, name, 1);
    assert.match(third.body.why, /^You hold task 1\. KEYS holding it beside you: 2\./);
    assert.equal((await act(c, name, 1, "release")).status, 200);
    const task = out.body.task;
    assert.equal(task.state, "claimed");
    assert.equal(task.claimed_by, a.peerId, "the claim taken first");
    assert.deepEqual(task.claimants.map((c: any) => c.by), [a.peerId, b.peerId]);
    assert.equal(task.claimed_until, task.claimants[0].until, "the first claim's own expiry");
    // The compact list names them too.
    const compact = (await call("GET", `/v1/spaces/${name}/tasks?detail=compact`)).body.items[0];
    assert.deepEqual(compact.claimants, [a.peerId, b.peerId]);
    // The OpenAPI document describes every field the compact list sends, claimants included.
    const schema = (buildOpenApi("https://api.task-claims.test", "test") as any).components.schemas.TaskCompact;
    for (const key of Object.keys(compact)) assert.ok(key in schema.properties, `TaskCompact has no ${key}`);
    assert.equal(schema.properties.claimants.maxItems, TASK_LIMITS.claimants);
    assert.equal(schema.properties.claimants.items.pattern, "^[0-9a-f]{64}$");
    // One KEY alone shows no claimants.
    assert.equal((await act(b, name, 1, "release")).body.task.claimants, undefined);
  });

  test("a fourth join is TASK_LIMIT claimants 3, and a claimant's renewal is not refused", async () => {
    const { owner, a, b, c, d, name } = await crew();
    await added(owner, name);
    await next(a, name);
    assert.equal((await join(b, name, 1)).status, 200);
    assert.equal((await join(c, name, 1)).status, 200);
    refused(await join(d, name, 1), 409, "TASK_LIMIT", `claimants: ${TASK_LIMITS.claimants}`);
    const renewed = await join(b, name, 1);
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    assert.equal(renewed.body.renewed, true);
    assert.equal((await next(c, name, { number: 1 })).body.renewed, true, "a holder renews without join");
  });

  test("six KEYS race to join a task one holds: two join, four meet TASK_LIMIT", async () => {
    const owner = await agent();
    const name = await workSpace(owner);
    const keys = await Promise.all(Array.from({ length: 7 }, () => agent()));
    for (const k of keys) await grant(owner, name, k, "writer");
    await added(owner, name);
    await next(keys[0]!, name);
    const outs = await Promise.all(keys.slice(1).map((k) => join(k, name, 1)));
    assert.equal(outs.filter((o) => o.status === 200).length, TASK_LIMITS.claimants - 1);
    for (const o of outs.filter((o) => o.status !== 200)) refused(o, 409, "TASK_LIMIT", `claimants: ${TASK_LIMITS.claimants}`);
    assert.equal((await claimRows(name, 1)).length, TASK_LIMITS.claimants);
  });

  test("one KEY joining four held tasks at once holds three, and meets TASK_HOLD_LIMIT once", async () => {
    const { owner, a, b, c, d, e, name } = await crew();
    for (let i = 0; i < 4; i++) await added(owner, name, { title: `Page ${i + 1}` });
    for (const [k, who] of [a, b, c, d].entries()) assert.equal((await next(who, name, { number: k + 1 })).status, 200);
    const outs = await Promise.all([1, 2, 3, 4].map((number) => join(e, name, number)));
    assert.equal(outs.filter((o) => o.status === 200).length, TASK_LIMITS.held);
    for (const o of outs.filter((o) => o.status !== 200)) refused(o, 409, "TASK_HOLD_LIMIT", String(TASK_LIMITS.held));
  });

  test("a take and a join delete only other KEYS' claims that passed; A passing, D joining, A renewing never makes four", async () => {
    const { owner, a, b, c, d, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    await join(c, name, 1);
    await claimUntil(name, 1, "-1 minute", a.peerId);
    assert.equal((await join(d, name, 1)).status, 200, "two live claims beside it");
    assert.deepEqual((await claimRows(name, 1)).map((x) => x.by).sort(), [b.peerId, c.peerId, d.peerId].sort(), "A's passed claim gave way");
    refused(await next(a, name, { number: 1, join: true }), 409, "TASK_LIMIT", `claimants: ${TASK_LIMITS.claimants}`);
    // Every claim passed: a take deletes them all and holds it alone.
    await claimUntil(name, 1, "-1 minute");
    const taken = await next(a, name, { number: 1 });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.deepEqual((await claimRows(name, 1)).map((x) => x.by), [a.peerId]);
  });

  test("next's step 5 takes a task whose claims all passed, and deletes them", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    await claimUntil(name, 1, "-1 minute");
    const out = await next(c, name, { job: "work" });
    assert.equal(out.body.task.number, 1, JSON.stringify(out.body));
    assert.deepEqual((await claimRows(name, 1)).map((x) => x.by), [c.peerId]);
  });

  test("step 1 renews the caller's own claim of a task it holds beside another, and only its own", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    await claimUntil(name, 1, "1 minute", a.peerId);
    const out = await next(b, name);
    assert.equal(out.body.renewed, true, JSON.stringify(out.body));
    const rows = await claimRows(name, 1);
    assert.ok(rows.find((x) => x.by === a.peerId)!.until.getTime() - Date.now() < 120_000, "a's claim was not renewed");
    const again = await next(a, name);
    assert.equal(again.body.renewed, true);
    assert.equal(again.body.task.number, 1);
  });
});

describe("the row mirrors the claims", () => {
  test("the first claimant, the latest expiry, and open with none", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await claimUntil(name, 1, "30 minutes", a.peerId);
    await join(b, name, 1);
    const kept = await row(name, 1);
    const rows = await claimRows(name, 1);
    assert.equal(kept.state, "claimed");
    assert.equal(kept.claimed_by, a.peerId);
    assert.equal(kept.claimed_until!.getTime(), Math.max(...rows.map((x) => x.until.getTime())), "the latest claim's expiry");
    assert.equal((await act(a, name, 1, "release")).body.task.state, "claimed");
    const left = await row(name, 1);
    assert.equal(left.claimed_by, b.peerId);
    assert.equal((await act(b, name, 1, "release")).body.task.state, "open");
    assert.deepEqual(await row(name, 1), { state: "open", claimed_by: null, claimed_until: null });
  });

  test("the first claimant's claim passes while the second lives: the task, the compact list and the connector name the second", async () => {
    const owner = await agent();
    const a = await agent();
    const b = await agent();
    const name = await workSpace(owner, { join_policy: "open" });
    await grant(owner, name, a, "writer");
    await grant(owner, name, b, "writer");
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    // a's claim passes as time passes: no write follows it, so the row still names a.
    await fixture.owner`
      update schellingaf.task_claims c set claimed_until = now() - interval '1 minute'
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where c.task_id = t.task_id and s.name = ${name} and t.number = 1 and c.peer_id = decode(${a.peerId}, 'hex')`;
    assert.equal((await row(name, 1)).claimed_by, a.peerId);
    const task = await get(name, 1);
    const bs = (await claimRows(name, 1)).find((x) => x.by === b.peerId)!;
    assert.equal(task.state, "claimed");
    assert.equal(task.claimed_by, b.peerId);
    assert.equal(Date.parse(task.claimed_until), bs.until.getTime());
    assert.equal(task.claimants, undefined, "one claim lives");
    assert.equal((await call("GET", `/v1/spaces/${name}/tasks?detail=compact`)).body.items[0].claimed_by, b.peerId);
    // The connector's hint after a POST naming the task says it is still b's.
    const post = await connector("tools/call", {
      name: "schellingaf_post",
      arguments: { space: name, kind: "obs", title: "Half done", body: "Halfway.", fingerprints: [{ scheme: "task.reference", value: `${name}/1` }] },
    }, b.token);
    assert.match(post.message.result.content[0].text, /task 1 is still yours/);
  });

  test("the connector says a task is still yours to a KEY that holds it beside another", async () => {
    const owner = await agent();
    const a = await agent();
    const b = await agent();
    const name = await workSpace(owner, { join_policy: "open" });
    await grant(owner, name, a, "writer");
    await grant(owner, name, b, "writer");
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    const post = await connector("tools/call", {
      name: "schellingaf_post",
      arguments: { space: name, kind: "obs", title: "Half done", body: "Halfway.", fingerprints: [{ scheme: "task.reference", value: `${name}/1` }] },
    }, b.token);
    assert.match(post.message.result.content[0].text, /task 1 is still yours/);
  });
});

describe("release, progress, done, change and retire with several claims", () => {
  test("release gives back the caller's claim alone, and the task stays claimed", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    const out = await act(b, name, 1, "release");
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "claimed");
    assert.equal(out.body.task.claimed_by, a.peerId);
    assert.deepEqual((await claimRows(name, 1)).map((x) => x.by), [a.peerId]);
  });

  test("a coordinator's give-back with two other claims is INVALID_REQUEST counting them; with one it gives it back", async () => {
    const { owner, coordinator, a, b, c, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    refused(await act(coordinator, name, 1, "release", { reason: "No progress for a day." }), 400, "INVALID_REQUEST",
      "claims: give back only a claim one KEY holds alone; KEYS holding it: 2");
    refused(await act(owner, name, 1, "release", { reason: "No progress for a day." }), 400, "INVALID_REQUEST",
      "claims: give back only a claim one KEY holds alone; KEYS holding it: 2");
    // A writer giving back another's is TASK_NOT_CLAIMANT, as before.
    refused(await act(c, name, 1, "release"), 409, "TASK_NOT_CLAIMANT");
    await act(b, name, 1, "release");
    const out = await act(coordinator, name, 1, "release", { reason: "No progress for a day." });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "open");
    assert.equal(out.body.task.released.by, coordinator.peerId);
    assert.deepEqual(await told(a), [["task_reopened", 1]]);
  });

  test("a give-back counts live claims only, and gives back the one live claim's KEY, not the row's stale one", async () => {
    const { owner, coordinator, a, b, name } = await crew();
    const second = await agent();
    await grant(owner, name, second, "coordinator");
    await added(owner, name);
    await added(owner, name, { title: "Page 4" });
    // Task 1: a first, b beside it; task 2: a first, the second coordinator beside it.
    await next(a, name, { number: 1 });
    await join(b, name, 1);
    await next(a, name, { number: 2 });
    await join(second, name, 2);
    // a's claims pass as time passes: no write follows, so each row still names a.
    await fixture.owner`
      update schellingaf.task_claims k set claimed_until = now() - interval '1 minute'
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where k.task_id = t.task_id and s.name = ${name} and k.peer_id = decode(${a.peerId}, 'hex')`;
    assert.equal((await row(name, 1)).claimed_by, a.peerId);
    const out = await act(coordinator, name, 1, "release", { reason: "No progress for a day." });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "open");
    assert.equal((await claimRows(name, 1)).length, 0, "every claim row goes");
    assert.deepEqual(await told(b), [["task_reopened", 1]]);
    assert.deepEqual(await told(a), []);
    // The rank check reads the live claim's KEY: a coordinator's claim is not a coordinator's to give back.
    refused(await act(coordinator, name, 2, "release", { reason: "No progress for a day." }), 403, "TASK_DENIED", owner.peerId);
  });

  test("take_task reads a join sent as null as no join", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    const id = Buffer.from(b.peerId, "hex");
    await assert.rejects(fixture.owner`select schellingaf.take_task(${name}, ${id}, 1, 3, null::boolean, 3)`, /TASK_NOT_OPEN/);
    assert.deepEqual((await claimRows(name, 1)).map((x) => x.by), [a.peerId]);
  });

  test("progress on a claim of the caller's own that passed checks the hold limit against that claim, not the task's latest", async () => {
    const { owner, a, b, name } = await crew();
    for (let i = 0; i < 4; i++) await added(owner, name, { title: `Page ${i + 1}` });
    await next(a, name, { number: 1 });
    await join(b, name, 1);
    assert.equal((await next(b, name, { number: 2 })).status, 200);
    assert.equal((await next(b, name, { number: 3 })).status, 200);
    await claimUntil(name, 1, "-1 minute", b.peerId);
    assert.equal((await next(b, name, { number: 4 })).status, 200, "b holds 2, 3 and 4 live");
    refused(await act(b, name, 1, "progress", { post_id: await result(b, name, "Half way.") }), 409, "TASK_HOLD_LIMIT", String(TASK_LIMITS.held));
  });

  test("next renews a claim of the caller's own that passed, and counts no new take", async () => {
    const { owner, a, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await claimUntil(name, 1, "-1 minute");
    const out = await next(a, name);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.renewed, true);
    const [t] = await fixture.owner<{ takes: number }[]>`
      select t.takes from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id where s.name = ${name} and t.number = 1`;
    assert.equal(t!.takes, 1);
  });

  test("a POST's dry run compares a joiner's own claim's revision, as the write does", async () => {
    const { owner, coordinator, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    assert.equal((await act(coordinator, name, 1, "change", { revision: 1, reason: "Both sides.", body: "Read both sides." })).status, 200);
    await join(b, name, 1);
    const post = (dry: boolean) => call("POST", `/v1/spaces/${name}/posts`, b.token, {
      kind: "result", body: "Page 3, both sides.", fingerprints: [{ scheme: "task.reference", value: `${name}/${n++}` }],
      task: { number: 1 }, ...(dry ? { dry_run: true } : {}),
    });
    const dry = await post(true);
    assert.ok(dry.status < 300, JSON.stringify(dry.body));
    const wrote = await post(false);
    assert.equal(wrote.status, 201, JSON.stringify(wrote.body));
  });

  test("the row names the live claim taken first, or with none live the claim whose expiry is latest, whatever the KEYS' order", async () => {
    const { owner, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    const [lo, hi] = [a.peerId, b.peerId].sort() as [string, string];
    // The higher id took its claim first.
    await fixture.owner`
      update schellingaf.task_claims k set claimed_at = now() - case when k.peer_id = decode(${hi}, 'hex') then interval '1 hour' else interval '1 minute' end
        from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id
       where k.task_id = t.task_id and s.name = ${name} and t.number = 1`;
    await claimUntil(name, 1, "1 hour");
    assert.equal((await row(name, 1)).claimed_by, hi);
    // None live: the higher id's claim passes last.
    await claimUntil(name, 1, "-2 hours", hi);
    await claimUntil(name, 1, "-3 hours", lo);
    await claimUntil(name, 1, "-1 hour", hi);
    assert.equal((await row(name, 1)).claimed_by, hi);
  });

  test("an upkeep task a KEY holds counts toward its hold limit when it joins", async () => {
    const owner = await agent();
    const [a, e] = [await agent(), await agent()];
    const name = await workSpace(owner, { document: true });
    await grant(owner, name, a, "writer");
    await grant(owner, name, e, "writer");
    for (let i = 0; i < 3; i++) await added(owner, name, { title: `Page ${i + 1}` });
    for (const page of [1, 2, 3]) await result(a, name, `Page ${page}, transcribed.`);
    const upkeep = await next(e, name, { job: "upkeep" });
    assert.equal(upkeep.body.job, "upkeep", JSON.stringify(upkeep.body));
    assert.equal((await next(e, name, { number: 1 })).status, 200);
    assert.equal((await next(e, name, { number: 2 })).status, 200);
    assert.equal((await next(a, name, { number: 3 })).status, 200);
    refused(await join(e, name, 3), 409, "TASK_HOLD_LIMIT", String(TASK_LIMITS.held));
  });

  test("progress renews the caller's own claim and no other", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    await claimUntil(name, 1, "1 minute");
    const out = await act(b, name, 1, "progress", { post_id: await result(b, name, "Half way.") });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const rows = await claimRows(name, 1);
    assert.ok(rows.find((x) => x.by === a.peerId)!.until.getTime() - Date.now() < 120_000);
    assert.ok(rows.find((x) => x.by === b.peerId)!.until.getTime() - Date.now() > 3_600_000);
    refused(await act(c, name, 1, "progress", { post_id: await result(c, name, "Mine.") }), 409, "TASK_NOT_OPEN", "claimed");
  });

  test("a joiner's done ends every claim and tells the others task_attempt", async () => {
    const { owner, a, b, c, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    await join(c, name, 1);
    const out = await act(b, name, 1, "done", { post_id: await result(b, name) });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "done");
    assert.equal((await claimRows(name, 1)).length, 0);
    assert.deepEqual(await told(a), [["task_attempt", 1]]);
    assert.deepEqual(await told(c), [["task_attempt", 1]]);
    assert.deepEqual(await told(b), []);
  });

  test("a joiner's done is checked against its own claim's revision", async () => {
    const { owner, coordinator, a, b, name } = await crew();
    await added(owner, name);
    await next(a, name);
    assert.equal((await act(coordinator, name, 1, "change", { revision: 1, reason: "Both sides.", body: "Read both sides." })).status, 200);
    await join(b, name, 1);
    // b took revision 2; a took revision 1.
    assert.equal((await act(b, name, 1, "done", { post_id: await result(b, name) }, "")).status, 200);
  });

  test("where no confirmation is asked, an attempt with a joiner's live claim waits for one", async () => {
    const { owner, a, b, c, name } = await crew(0);
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    const out = await act(a, name, 1, "done", { post_id: await result(a, name) });
    assert.equal(out.body.task.state, "done");
    assert.equal((await act(c, name, 1, "confirm")).body.task.state, "accepted");
  });

  test("change and retire tell every claimant; retire tells every claimant of each dependent", async () => {
    const { owner, coordinator, a, b, c, d, name } = await crew();
    await added(owner, name);
    await next(a, name);
    await join(b, name, 1);
    assert.equal((await act(coordinator, name, 1, "change", { revision: 1, reason: "Both sides.", body: "Read both sides." })).status, 200);
    assert.deepEqual(await told(a), [["task_changed", 1]]);
    assert.deepEqual(await told(b), [["task_changed", 1]]);
    // Task 3 waits for task 2; c and d hold it, taken by number before it waited.
    await added(owner, name, { title: "Page 4" });
    await added(owner, name, { title: "Page 5" });
    await next(c, name, { number: 3 });
    await join(d, name, 3);
    assert.equal((await act(coordinator, name, 3, "change", { revision: 1, reason: "After page 4.", after: [2] })).status, 200);
    assert.equal((await act(coordinator, name, 2, "retire", { reason: "Settled elsewhere." })).status, 200);
    assert.equal((await told(c)).filter((t) => t[0] === "task_changed").length, 2);
    assert.equal((await told(d)).filter((t) => t[0] === "task_changed").length, 2);
    assert.equal((await act(coordinator, name, 1, "retire", { reason: "Settled elsewhere." })).status, 200);
    assert.deepEqual((await told(a)).filter((t) => t[0] === "task_retired"), [["task_retired", 1]]);
    assert.deepEqual((await told(b)).filter((t) => t[0] === "task_retired"), [["task_retired", 1]]);
    assert.equal((await claimRows(name, 1)).length, 0);
  });
});

describe("the functions callers of the release before still call", () => {
  test("task_release with four and five arguments, next_job with nine and twelve, take_task with three and four resolve", async () => {
    const { owner, a, b, name } = await crew();
    for (let i = 0; i < 4; i++) await added(owner, name, { title: `Page ${i + 1}` });
    const id = (who: Agent) => Buffer.from(who.peerId, "hex");
    const three = await fixture.owner<{ out: any }[]>`select schellingaf.take_task(${name}, ${id(a)}, 1) as out`;
    assert.equal(three[0]!.out.task.state, "claimed");
    const four = await fixture.owner<{ out: any }[]>`select schellingaf.take_task(${name}, ${id(a)}, 2, 3) as out`;
    assert.equal(four[0]!.out.task.state, "claimed");
    await assert.rejects(fixture.owner`select schellingaf.take_task(${name}, ${id(b)}, 1, 3)`, /TASK_NOT_OPEN/);
    const nine = await fixture.owner<{ out: any }[]>`select schellingaf.next_job(${name}, ${id(b)}, 'work') as out`;
    assert.equal(nine[0]!.out.task.number, 3);
    const twelve = await fixture.owner<{ out: any }[]>`
      select schellingaf.next_job(${name}, ${id(b)}, 'work', null, 1, null::jsonb, 3, 60, 30, 10000, 2, 4) as out`.catch((e) => e);
    assert.match(String(twelve), /TASK_NOT_OPEN/, "the twelve-argument form never joins");
    const r4 = await fixture.owner<{ out: any }[]>`select schellingaf.task_release(${name}, ${id(a)}, 1) as out`;
    assert.equal(r4[0]!.out.task.state, "open");
    const r5 = await fixture.owner<{ out: any }[]>`select schellingaf.task_release(${name}, ${id(a)}, 2, null::text, true) as out`;
    assert.equal(r5[0]!.out.task.state, "open");
  });

  test("the forms that send no limit send TASK_LIMITS.claimants", async () => {
    const rows = await fixture.owner<{ name: string; n: number; args: string; def: string }[]>`
      select p.proname as name, p.pronargs as n, pg_get_function_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def
        from pg_proc p join pg_namespace s on s.oid = p.pronamespace
       where s.nspname = 'schellingaf' and p.proname in ('next_job', 'take_task') order by p.proname, p.pronargs`;
    const twelve = rows.find((r) => r.name === "next_job" && r.n === 12)!;
    assert.match(twelve.def, new RegExp(`, false, ${TASK_LIMITS.claimants}\\)`), twelve.def);
    const take = rows.find((r) => r.name === "take_task")!;
    assert.match(take.args, new RegExp(`p_claimants_max integer DEFAULT ${TASK_LIMITS.claimants}\\b`));
  });
});

describe("the backfill", () => {
  test("on a database with rows: one claim for each claimed task that is not upkeep, and the mirror whole", async () => {
    const name = `schellingaf_t_claims_backfill_${process.pid}`;
    const admin = postgres(SUPERUSER);
    await admin.unsafe(`create database ${name} owner schellingaf_owner`);
    const owner = postgres({ host: "127.0.0.1", port: PORT, database: name, username: "schellingaf_migrate", password: MIGRATE_PASSWORD, max: 1, onnotice: () => {} });
    try {
      await owner`set role schellingaf_owner`;
      await owner`create schema schellingaf`;
      await owner`create table schellingaf.schema_migrations (version int primary key, name text not null, sha256 text not null, applied_at timestamptz not null default now())`;
      const dir = new URL("../migrations/", import.meta.url);
      const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      const apply = async (file: string) => {
        const text = readFileSync(new URL(file, dir), "utf8");
        if (text.startsWith("-- migrate: no-transaction")) {
          for (const statement of statementsOf(text)) await owner.unsafe(statement);
          return;
        }
        await owner.unsafe("begin");
        await owner.unsafe(text);
        await owner.unsafe("commit");
      };
      for (const file of files.filter((f) => f < "0141")) await apply(file);
      const [boss, doer, other] = await Promise.all(["bc-owner", "bc-doer", "bc-other"].map(async (who) =>
        (await owner<{ id: Buffer }[]>`select schellingaf.register_peer(${publicKey(`${who}-${process.pid}`)}) as id`)[0]!.id));
      await owner`select schellingaf.create_space(${boss!}, 'claims-space', 'C', '', 'request', 'public')`;
      for (const k of [doer!, other!]) {
        await owner`
          insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
          select s.space_id, ${k}, 'writer', 'grant', s.owner_id, 1 from schellingaf.spaces s where s.name = 'claims-space'`;
      }
      for (let i = 1; i <= 3; i++) await owner`select schellingaf.add_task('claims-space', ${boss!}, ${`Task ${i}`}, '', null, '{}'::uuid[])`;
      // 1: held. 2: held by a claim that passed. 3: open. 4: an upkeep task held on its row.
      await owner`select schellingaf.take_task('claims-space', ${doer!}, 1)`;
      await owner`select schellingaf.take_task('claims-space', ${other!}, 2)`;
      await owner`update schellingaf.tasks set claimed_until = now() - interval '1 hour' where number = 2`;
      await owner`
        insert into schellingaf.tasks (space_id, number, title, upkeep, state, claimed_by, claimed_until, claimed_at, claim_revision, takes)
        select s.space_id, 4, 'Upkeep: review the task list', 'tasks', 'claimed', ${doer!}, now() + interval '1 hour', now(), 1, 1
          from schellingaf.spaces s where s.name = 'claims-space'`;

      await apply("0141_task_claims.sql");
      const claims = await owner<{ number: number; same: boolean }[]>`
        select t.number, c.peer_id = t.claimed_by and c.claimed_until = t.claimed_until and c.claimed_at = t.claimed_at
                         and c.claim_revision = t.claim_revision as same
          from schellingaf.task_claims c join schellingaf.tasks t on t.task_id = c.task_id order by t.number`;
      assert.deepEqual(claims.map((c) => [c.number, c.same]), [[1, true], [2, true]]);
      const faults = await owner<{ f: string }[]>`
        select f from schellingaf.spaces s cross join lateral schellingaf.task_mirror_faults(s.space_id) as f where s.name = 'claims-space'`;
      assert.deepEqual(faults.map((r) => r.f), []);
    } finally {
      await owner.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    }
  });
});
