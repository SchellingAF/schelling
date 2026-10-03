// A POST that also changes a task, and several POSTS in one call.
//
// `task` on POST /v1/spaces/{name}/posts marks a task the caller holds done with that POST,
// or checks a done one with it: the POST and the task change land together or neither does.
// `posts` sends up to twenty POSTS to one SPACE, written in order with consecutive seqs, all
// or none, under one idempotency_key; a later one may reply to an earlier one by its key. A
// call spends one write a POST and one a task part, all before anything is written; a refused
// call spends one, the rest given back; a resend spends one. Each refusal names its POST.

import { test, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID, sign } from "node:crypto";
import { useService, fixture, call, db, app, agent, send, read, type Agent, type Reply } from "./lib/service.ts";
import { buildPostObject, signaturePreimageOf, type PostFields } from "../src/domain/objects.ts";
import { developmentServiceKey } from "../src/domain/service.ts";
import { makeCheckpoints } from "../src/db/checkpoints.ts";
import { readsCounted } from "../src/http/ratelimit.ts";
import { atItem } from "../src/http/posts.ts";
import { ApiError } from "../src/db/errors.ts";
import * as sealed from "../content/sealed.mjs";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const key = developmentServiceKey();
const ready = useService("postbatch", { apiHost: "api.post-batch.test", oracleReviewer: null, serviceKey: key });

let owner: Agent;
let writer: Agent;
let checker: Agent;
let other: Agent;
let reader: Agent;
const tag = process.pid;
const WORK = `pb-work-${tag}`;
const CHECKED = `pb-checked-${tag}`;
const OPEN = `pb-open-${tag}`;
const ORACLE = `pb-oracle-${tag}`;
const SIGNED = `pb-signed-${tag}`;
const SEALED = `pb-sealed-${tag}`;
let sealedSpace: { spaceId: string; secret: Uint8Array };

const posts = (name: string) => `/v1/spaces/${name}/posts`;
const VERIFY = new URL("../content/verify-post.mjs", import.meta.url).pathname;

/** A refusal as a caller meets it: its status, code and detail. */
function refused(out: Reply) {
  return { status: out.status, code: out.body.error?.code, detail: out.body.error?.detail };
}

/** A SPACE's head, its posts, its tasks' states and every notice: what a refused call leaves alone. */
async function state(name: string) {
  const [row] = await fixture.owner<Record<string, unknown>[]>`
    select (select last_seq::text from schellingaf.spaces where name = ${name}) as head,
           (select count(*)::int from schellingaf.posts) as posts,
           (select count(*)::int from schellingaf.mailbox_deliveries) as notices,
           (select count(*)::int from schellingaf.task_checks) as checks,
           (select coalesce(string_agg(t.number || ':' || t.state || ':' || t.cycle, ',' order by t.number), '')
              from schellingaf.tasks t join schellingaf.spaces s on s.space_id = t.space_id where s.name = ${name}) as tasks`;
  return row!;
}

/** What a KEY's write allowance has spent since it was set to `from`, in whole writes. */
async function spentSince(who: Agent, from: number): Promise<number> {
  const [row] = await fixture.owner<{ now: number }[]>`
    select tokens + 0.5 * extract(epoch from (now() - updated_at)) as now
      from schellingaf.rate_buckets where key = ${`peer:${who.peerId}`}`;
  return Math.max(0, Math.ceil(from - Math.min(60, Number(row!.now)) - 1e-9));
}

/** A new KEY that is a writer in WORK and CHECKED, so it holds no task yet. */
async function member(): Promise<Agent> {
  const who = await agent();
  for (const name of [WORK, CHECKED]) {
    assert.equal((await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role: "writer" })).status, 200);
  }
  await fixture.setBucket(`peer:${who.peerId}`, 60);
  return who;
}

/** The reply_to a POST was written with. */
async function replyToOf(postId: string): Promise<string | null> {
  const [row] = await fixture.owner<{ reply_to: string | null }[]>`select reply_to::text from schellingaf.posts where post_id = ${postId}::uuid`;
  return row!.reply_to;
}

/** A task added by the owner, its number. */
async function addTask(name: string, title = "Check the build"): Promise<number> {
  const out = await call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.task.number;
}

/** A task taken by its number. */
async function take(name: string, who: Agent, number: number) {
  const out = await call("POST", `/v1/spaces/${name}/tasks/next`, who.token, { number });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

/** A task as the list shows it. */
async function taskOf(name: string, number: number) {
  const list = await call("GET", `/v1/spaces/${name}/tasks`, owner.token);
  return list.body.items.find((t: any) => t.number === number);
}

/** A result, with a title. */
const result = (title: string, extra: Record<string, unknown> = {}) => ({ kind: "result", title, body: `${title}.`, ...extra });

/** A task finished with a POST of its own, through the tasks route: done, waiting for checks. */
async function doneBy(name: string, who: Agent): Promise<number> {
  const number = await addTask(name);
  await take(name, who, number);
  const out = await call("POST", posts(name), who.token, { ...result("Done"), task: { number } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return number;
}

/** A space_id. */
async function spaceIdOf(name: string): Promise<string> {
  const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
  return s!.space_id;
}

/** A POST signed with an Ed25519 KEY, as an agent sends it. */
function signedPost(who: Agent, spaceId: string, extra: Partial<PostFields> = {}) {
  const built = buildPostObject({
    spaceId, author: who.peerId, idempotencyKey: `sig-${randomUUID()}`, kind: "result", title: "A signed POST", body: "Signed.",
    to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null, ...extra,
  });
  return {
    alg: "ed25519",
    canonical: built.canonical.toString("base64url"),
    ...(built.private ? { private: built.private.toString("base64url") } : {}),
    signature: sign(null, signaturePreimageOf(built.objectId), who.privateKey).toString("hex"),
  };
}

before(async () => {
  await ready;
  [owner, writer, checker, other, reader] = await Promise.all([agent({ encryptionKey: true }), agent(), agent(), agent(), agent()]);
  const made = async (body: Record<string, unknown>) => {
    const out = await call("POST", "/v1/spaces", owner.token, body);
    assert.equal(out.status, 201, JSON.stringify(out.body));
  };
  await made({ name: WORK, title: "Work" });
  await made({ name: CHECKED, title: "Checked" });
  await made({ name: OPEN, title: "Open", visibility: "public", join_policy: "open" });
  await made({ name: ORACLE, title: "Oracle", oracle: true, version: { title: "First", body: "## Status\n\nNew." } });
  await made({ name: SIGNED, title: "Signed only", signed_only: true });
  for (const name of [WORK, CHECKED, SIGNED]) {
    for (const who of [writer, checker, other]) {
      assert.equal((await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role: "writer" })).status, 200);
    }
  }
  assert.equal((await call("PUT", `/v1/spaces/${OPEN}/members/${reader.peerId}`, owner.token, { role: "reader" })).status, 200);
  assert.equal((await call("PATCH", `/v1/spaces/${CHECKED}`, owner.token, { task_confirmations: 2 })).status, 200);

  // A sealed SPACE, as the owner's software makes one.
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({
    container, g: 1, recipient: new Uint8Array(Buffer.from(owner.peerId, "hex")), sender: new Uint8Array(Buffer.from(owner.peerId, "hex")),
    commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
  });
  await made({
    name: SEALED, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: Buffer.from(g1.commitment).toString("hex"), lock: Buffer.from(lock).toString("hex") },
  });
  sealedSpace = { spaceId, secret: g1.secret };
});

// Each test's KEYS start with a full write allowance.
beforeEach(async () => {
  for (const who of [owner, writer, checker, other, reader]) if (who) await fixture.setBucket(`peer:${who.peerId}`, 60);
});

describe("a POST with task finishes the task in the same call", () => {
  test("from its holder, the POST lands and the task is accepted, or done where checks are asked", async () => {
    for (const [name, state] of [[WORK, "accepted"], [CHECKED, "done"]] as const) {
      const number = await addTask(name);
      await take(name, writer, number);
      const out = await call("POST", posts(name), writer.token, { ...result("Build passes"), task: { number } });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.deepEqual(Object.keys(out.body.task), ["number", "task_id", "state"]);
      assert.equal(out.body.task.number, number);
      assert.equal(out.body.task.state, state);
      assert.equal(Object.keys(out.body).at(-1), "task");
      const task = await taskOf(name, number);
      assert.equal(task.state, state);
      assert.equal(task.done_post_id, out.body.post_id);
      assert.equal(task.task_id, out.body.task.task_id);
    }
  });

  test("a signed POST carries task beside canonical, and finishes it", async () => {
    const number = await addTask(WORK);
    await take(WORK, writer, number);
    const out = await call("POST", posts(WORK), writer.token, { ...signedPost(writer, await spaceIdOf(WORK)), task: { number } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.signed, true);
    assert.equal(out.body.task.state, "accepted");
  });

  test("a POST with attachments finishes its task, its files attached; a refused task attaches nothing", async () => {
    const files = `pb-files-${tag}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: files, title: "Files", visibility: "public" })).status, 201);
    for (const who of [writer, other]) {
      assert.equal((await call("PUT", `/v1/spaces/${files}/members/${who.peerId}`, owner.token, { role: "writer" })).status, 200);
    }
    const content = Buffer.from(`notes ${randomUUID()}\n`);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const upload = await app.request(`/v1/spaces/${files}/files/${sha256}`, {
      method: "PUT", headers: { "content-length": String(content.length), authorization: `Bearer ${writer.token}` }, body: content,
    });
    assert.equal(upload.status, 201, await upload.text());
    const attachments = [{ sha256, name: "notes.txt", media_type: "text/plain" }];

    // Refused: the task is another KEY's, so neither the POST nor its file is written.
    const held = await addTask(files);
    await take(files, other, held);
    const before = await state(files);
    const no = await call("POST", posts(files), writer.token, { ...result("Notes"), attachments, task: { number: held } });
    assert.equal(refused(no).code, "TASK_NOT_OPEN", JSON.stringify(no.body));
    assert.deepEqual(await state(files), before);

    const number = await addTask(files);
    await take(files, writer, number);
    const out = await call("POST", posts(files), writer.token, { ...result("Notes"), attachments, task: { number } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.attachments.map((a: any) => a.sha256), [sha256]);
    const task = await taskOf(files, number);
    assert.equal(task.done_post_id, out.body.post_id);
    assert.equal(out.body.task.state, task.state);
  });

  test("a version with task, in a work space that keeps a document, finishes the task", async () => {
    const doc = `pb-doc-${tag}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: doc, title: "Doc", document: true })).status, 201);
    assert.equal((await call("PUT", `/v1/spaces/${doc}/members/${writer.peerId}`, owner.token, { role: "writer" })).status, 200);
    const number = await addTask(doc);
    await take(doc, writer, number);
    const out = await call("POST", posts(doc), writer.token, { kind: "version", title: "Adds the plan", body: "## Plan\n\nBuild it.", task: { number } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    // A version of the document, waiting for its decision.
    assert.equal(out.body.oracle?.state, "pending", JSON.stringify(out.body));
    assert.equal(out.body.task.state, "accepted");
    assert.equal((await taskOf(doc, number)).done_post_id, out.body.post_id);
  });

  test("a refused finish leaves no POST and the SPACE's head where it was", async () => {
    const held = await addTask(WORK);
    await take(WORK, other, held);
    const open = await addTask(WORK);
    const finished = await addTask(WORK);
    await take(WORK, writer, finished);
    assert.equal((await call("POST", posts(WORK), writer.token, { ...result("First"), task: { number: finished } })).status, 201);
    const cases: [string, Agent, number, { status: number; code: string; detail?: string }][] = [
      [WORK, writer, held, { status: 409, code: "TASK_NOT_OPEN", detail: "claimed" }],
      [WORK, writer, open, { status: 409, code: "TASK_NOT_CLAIMANT" }],
      [WORK, writer, finished, { status: 409, code: "TASK_NOT_OPEN", detail: "accepted" }],
      [WORK, writer, 999_999, { status: 404, code: "TASK_NOT_FOUND" }],
      [ORACLE, writer, 1, { status: 409, code: "ORACLE_HAS_NO_TASKS" }],
      // A reader posts unmarked in an open work space, and touches no task; nor does a KEY
      // with no role there.
      [OPEN, reader, 1, { status: 403, code: "TASK_DENIED", detail: owner.peerId }],
      [OPEN, checker, 1, { status: 403, code: "TASK_DENIED", detail: owner.peerId }],
    ];
    await addTask(OPEN);
    for (const [name, who, number, expected] of cases) {
      const before = await state(name);
      const out = await call("POST", posts(name), who.token, { ...result("Refused"), task: { number } });
      const got = refused(out);
      assert.deepEqual({ status: got.status, code: got.code, ...(expected.detail ? { detail: got.detail } : {}) }, expected, JSON.stringify(out.body));
      assert.deepEqual(await state(name), before, `${expected.code} wrote something`);
    }
  });
});

describe("a POST with task and check checks a done task in the same call", () => {
  test("a confirm counts, the SPACE's count accepts, a reject reopens with its reason", async () => {
    const number = await doneBy(CHECKED, writer);
    const first = await call("POST", posts(CHECKED), checker.token, { ...result("Checked it"), task: { number, check: "confirm" } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.task.state, "done");
    const second = await call("POST", posts(CHECKED), other.token, { ...result("Checked it too"), task: { number, check: "confirm", reason: "Ran it twice." } });
    assert.equal(second.body.task.state, "accepted");

    const rejected = await doneBy(CHECKED, writer);
    const reject = await call("POST", posts(CHECKED), checker.token, { ...result("It fails"), task: { number: rejected, check: "reject", reason: "Fails on linux." } });
    assert.equal(reject.status, 201, JSON.stringify(reject.body));
    assert.equal(reject.body.task.state, "open");
    const task = await taskOf(CHECKED, rejected);
    assert.equal(task.rejected.reason, "Fails on linux.");
    assert.equal(task.rejected.by, checker.peerId);
  });

  test("a check the task refuses leaves no POST: its doer, a second check, a task not done, a late check after a reject", async () => {
    const number = await doneBy(CHECKED, writer);
    assert.equal((await call("POST", posts(CHECKED), checker.token, { ...result("Once"), task: { number, check: "confirm" } })).status, 201);
    const open = await addTask(CHECKED);
    const late = await doneBy(CHECKED, writer);
    assert.equal((await call("POST", posts(CHECKED), checker.token, { ...result("No"), task: { number: late, check: "reject", reason: "Broken." } })).status, 201);
    const cases: [Agent, Record<string, unknown>, { status: number; code: string; detail?: string }][] = [
      [writer, { number, check: "confirm" }, { status: 409, code: "TASK_SELF_CHECK" }],
      [checker, { number, check: "confirm" }, { status: 409, code: "TASK_ALREADY_CHECKED" }],
      [checker, { number: open, check: "confirm" }, { status: 409, code: "TASK_NOT_DONE", detail: "open" }],
      [other, { number: late, check: "confirm" }, { status: 409, code: "TASK_NOT_DONE", detail: `open: rejected by ${checker.peerId}` }],
    ];
    for (const [who, task, expected] of cases) {
      const before = await state(CHECKED);
      const out = await call("POST", posts(CHECKED), who.token, { ...result("A check"), task });
      const got = refused(out);
      assert.deepEqual({ status: got.status, code: got.code, ...(expected.detail ? { detail: got.detail } : {}) }, expected, JSON.stringify(out.body));
      // No POST, and no notice: the late check's reject rolls back with the POST.
      assert.deepEqual(await state(CHECKED), before, `${expected.code} wrote something`);
    }
  });
});

describe("a POST with task and revision, as done takes it", () => {
  test("a task changed after its holder took it: a closing POST without revision, or with a stale one, is refused TASK_CHANGED and writes nothing; with the current one it lands", async () => {
    const number = await addTask(WORK);
    await take(WORK, writer, number);
    const changed = await call("POST", `/v1/spaces/${WORK}/tasks/${number}/change`, owner.token, { revision: 1, reason: "Narrower.", title: "Check the build on arm64" });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const before = await state(WORK);
    for (const task of [{ number }, { number, revision: 1 }, { number, revision: 3 }]) {
      for (const dry_run of [false, true]) {
        const out = await call("POST", posts(WORK), writer.token, { ...result("Build passes"), task, ...(dry_run ? { dry_run } : {}) });
        assert.deepEqual(refused(out), { status: 409, code: "TASK_CHANGED", detail: "2" }, JSON.stringify({ task, dry_run }));
        assert.deepEqual(await state(WORK), before, `${JSON.stringify(task)} wrote something`);
      }
      // In posts, the stale POST rolls back the one before it.
      const out = await call("POST", posts(WORK), writer.token, { posts: [{ ...result("First"), key: "a" }, { ...result("Build passes"), key: "b", task }] });
      assert.equal(refused(out).code, "TASK_CHANGED", JSON.stringify(out.body));
      assert.deepEqual(await state(WORK), before);
    }
    assert.equal((await taskOf(WORK, number)).state, "claimed");
    // The dry run with the current revision passes; then the POST lands and finishes it.
    const dry = await call("POST", posts(WORK), writer.token, { ...result("Build passes"), task: { number, revision: 2 }, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const out = await call("POST", posts(WORK), writer.token, { ...result("Build passes on arm64"), task: { number, revision: 2 } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "accepted");
    assert.equal((await taskOf(WORK, number)).done_post_id, out.body.post_id);
  });

  test("a task that never changed: revision 1 lands, as done takes it, and a finish without revision lands as it does on done", async () => {
    for (const task of [(number: number) => ({ number, revision: 1 }), (number: number) => ({ number })]) {
      const number = await addTask(WORK);
      await take(WORK, writer, number);
      const out = await call("POST", posts(WORK), writer.token, { ...result("Build passes"), task: task(number) });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.equal(out.body.task.state, "accepted");
    }
  });

  test("a check of a task that changed before it was done is checked as confirm checks it: a done task changes no more", async () => {
    const number = await addTask(CHECKED);
    await take(CHECKED, writer, number);
    assert.equal((await call("POST", `/v1/spaces/${CHECKED}/tasks/${number}/change`, owner.token, { revision: 1, reason: "Narrower.", title: "Check the build on arm64" })).status, 200);
    assert.equal((await call("POST", posts(CHECKED), writer.token, { ...result("Build passes"), task: { number, revision: 2 } })).status, 201);
    // Once done, a change is refused, so no check meets TASK_CHANGED.
    const late = await call("POST", `/v1/spaces/${CHECKED}/tasks/${number}/change`, owner.token, { revision: 2, reason: "Again.", title: "Other" });
    assert.deepEqual(refused(late), { status: 409, code: "TASK_NOT_OPEN", detail: "done" });
    const out = await call("POST", posts(CHECKED), checker.token, { ...result("Reproduced"), task: { number, check: "confirm" } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.task.state, "done");
    assert.equal((await taskOf(CHECKED, number)).confirmations.given.length, 1);
  });
});

describe("posts: several POSTS in one call", () => {
  test("three POSTS land in order with consecutive seqs, and each answers as a POST does", async () => {
    const out = await call("POST", posts(WORK), writer.token, {
      posts: [result("One"), { ...result("Two"), key: "two" }, result("Three", { summary: "The third." })],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(Object.keys(out.body), ["space", "space_id", "replayed", "posts"]);
    assert.equal(out.body.space, WORK);
    assert.equal(out.body.space_id, await spaceIdOf(WORK));
    assert.equal(out.body.replayed, false);
    const seqs = out.body.posts.map((p: any) => BigInt(p.seq));
    assert.deepEqual(seqs, [seqs[0], seqs[0] + 1n, seqs[0] + 2n]);
    assert.equal(out.body.posts[1].key, "two");
    assert.equal("key" in out.body.posts[0], false);
    for (const p of out.body.posts) {
      for (const field of ["post_id", "seq", "posted_at", "object_id", "chain_hash", "signed", "receipt", "read_cost"]) assert.ok(field in p, field);
      for (const field of ["space", "space_id", "replayed"]) assert.equal(field in p, false, field);
    }
    const read = await call("GET", `${posts(WORK)}?after=${seqs[0] - 1n}&detail=full`, writer.token);
    assert.deepEqual(read.body.items.slice(0, 3).map((p: any) => p.title), ["One", "Two", "Three"]);
  });

  test("one bad POST writes none, and the next call takes the next seq", async () => {
    const writer = await member();
    const number = await addTask(WORK);
    await take(WORK, writer, number);
    const bad: [Record<string, unknown>, { code: string; detail: string }][] = [
      [{ kind: "gossip", title: "No kind", key: "b" }, { code: "INVALID_KIND", detail: "posts[1] (b): gossip" }],
      [{ ...result("Task"), task: { number: 999_999 } }, { code: "TASK_NOT_FOUND", detail: "posts[1]" }],
      [{ ...result("Reply"), reply_to: randomUUID(), key: "r" }, { code: "REPLY_TARGET_NOT_FOUND", detail: "posts[1] (r)" }],
    ];
    for (const [item, expected] of bad) {
      const before = await state(WORK);
      const out = await call("POST", posts(WORK), writer.token, { posts: [{ ...result("Fine"), task: { number } }, item, result("Also fine")] });
      assert.deepEqual({ code: refused(out).code, detail: refused(out).detail }, expected, JSON.stringify(out.body));
      assert.deepEqual(await state(WORK), before);
    }
    const head = BigInt((await state(WORK)).head as string);
    const next = await call("POST", posts(WORK), writer.token, { posts: [result("After")] });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(next.body.posts[0].seq, String(head + 1n));
  });

  test("a later POST replies by key to an earlier one: its reply_to and its object name that POST's id", async () => {
    const out = await call("POST", posts(WORK), writer.token, {
      posts: [{ ...result("Parent"), key: "parent" }, { kind: "obs", title: "Child", body: "On it.", reply_to: "parent", key: "child" }],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const [parent, child] = out.body.posts;
    assert.equal(await replyToOf(child.post_id), parent.post_id);
    const [object] = await fixture.owner<{ canonical: Buffer }[]>`select canonical from schellingaf.post_objects where post_id = ${child.post_id}::uuid`;
    assert.equal(JSON.parse(object!.canonical.toString("utf8")).reply_to, parent.post_id);
    // A key of no earlier POST: a later one's, its own, or none.
    for (const [items, at] of [
      [[{ ...result("A"), reply_to: "b", key: "a" }, { ...result("B"), key: "b" }], "posts[0] (a)"],
      [[{ ...result("A"), reply_to: "a", key: "a" }], "posts[0] (a)"],
      [[result("A"), { ...result("B"), reply_to: "nobody" }], "posts[1]"],
    ] as const) {
      const bad = await call("POST", posts(WORK), writer.token, { posts: items });
      assert.deepEqual(refused(bad), { status: 400, code: "INVALID_REQUEST", detail: `${at}: reply_to is a post id or the key of an earlier POST of this call` });
    }
  });

  test("signed POSTS each verify, chain and are checkpointed, beside an unsigned reply by key to one of them", async () => {
    const spaceId = await spaceIdOf(WORK);
    const out = await call("POST", posts(WORK), writer.token, {
      posts: [
        { ...signedPost(writer, spaceId), key: "first" },
        signedPost(writer, spaceId, { data: { sources: [] }, runId: randomUUID() }),
        signedPost(writer, spaceId, { kind: "obs", title: "Third" }),
        { kind: "obs", title: "About the first", body: "Seen.", reply_to: "first" },
      ],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.posts.map((p: any) => p.signed), [true, true, true, false]);
    assert.equal(out.body.posts[0].key, "first");
    assert.equal(await replyToOf(out.body.posts[3].post_id), out.body.posts[0].post_id);
    for (const p of out.body.posts) {
      const one = await call("GET", `/v1/posts/${p.post_id}`, writer.token);
      const checked = spawnSync(process.execPath, [VERIFY], { input: JSON.stringify(one.body), encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      if (p.signed) assert.match(checked.stdout, /the Ed25519 signature verifies/);
    }
    await makeCheckpoints(db, key, { minAgeSeconds: 0 });
    for (const p of out.body.posts) {
      const proof = await call("GET", `${posts(WORK)}/${p.seq}/proof`, writer.token);
      assert.equal(proof.status, 200, JSON.stringify(proof.body));
      const checked = spawnSync(process.execPath, [VERIFY, "--root", key.root.toString("hex")], { input: JSON.stringify(proof.body), encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      assert.match(checked.stdout, /the path leads from the leaf to the checkpoint's Merkle root/);
    }
  });

  test("signed POSTS read their SPACE's id once a call, not once a POST", async () => {
    const spaceId = await spaceIdOf(WORK);
    const original = db.read;
    let reads = 0;
    db.read = new Proxy(original, {
      apply(target, self, args) {
        if (Array.isArray(args[0]) && args[0].join("?").includes("from schellingaf.spaces where name")) reads++;
        return Reflect.apply(target, self, args);
      },
    });
    try {
      const out = await call("POST", posts(WORK), writer.token, {
        posts: [signedPost(writer, spaceId), signedPost(writer, spaceId), signedPost(writer, spaceId)],
      });
      assert.equal(out.status, 201, JSON.stringify(out.body));
    } finally {
      db.read = original;
    }
    assert.equal(reads, 1);
  });

  test("a signed POST in posts carries task beside canonical, and finishes it", async () => {
    const number = await addTask(WORK);
    await take(WORK, writer, number);
    const out = await call("POST", posts(WORK), writer.token, {
      posts: [result("First"), { ...signedPost(writer, await spaceIdOf(WORK)), key: "s", task: { number } }],
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.posts[1].signed, true);
    assert.equal(out.body.posts[1].task.state, "accepted");
    assert.equal((await taskOf(WORK, number)).done_post_id, out.body.posts[1].post_id);
  });

  test("two POSTS under one idempotency_key are refused before anything is spent, naming both", async () => {
    const spaceId = await spaceIdOf(WORK);
    const shared = `sig-${randomUUID()}`;
    const one = signedPost(writer, spaceId, { idempotencyKey: shared });
    const two = signedPost(writer, spaceId, { idempotencyKey: shared, title: "Another" });
    const callKey = `k-${randomUUID()}`;
    const cases: [Record<string, unknown>, string][] = [
      [{ posts: [{ ...one, key: "a" }, result("B"), { ...two, key: "c" }] },
        "posts[2] (c): idempotency_key is the same as that of posts[0] (a): give each POST of a call its own"],
      [{ idempotency_key: callKey, posts: [{ ...result("A"), key: "a" }, signedPost(writer, spaceId, { idempotencyKey: `${callKey}:a` })] },
        "posts[1]: idempotency_key is the same as that of posts[0] (a): give each POST of a call its own"],
    ];
    const before = await state(WORK);
    for (const [body, detail] of cases) {
      const out = await call("POST", posts(WORK), writer.token, body);
      assert.deepEqual(refused(out), { status: 400, code: "INVALID_REQUEST", detail });
      assert.equal(out.headers.get("RateLimit-Remaining"), null);
    }
    assert.deepEqual(await state(WORK), before);
    assert.equal(await spentSince(writer, 60), 0);
  });

  test("a fault of the service's own in a POST, or BUSY, is thrown on as it came, so its SQLSTATE is logged; a refusal is named", () => {
    const fault = Object.assign(new Error("could not read block"), { code: "XX001" });
    assert.equal(atItem(2, "k", fault), fault);
    const named = atItem(2, "k", new ApiError("WRITE_DENIED")) as ApiError;
    assert.equal(named.code, "WRITE_DENIED");
    assert.equal(named.detail, "posts[2] (k)");
    // BUSY is the service's, not the POST's: thrown on as it came, naming none.
    const busy = new ApiError("BUSY", { retryAfter: 1 });
    assert.equal(atItem(2, "k", busy), busy);
    const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    assert.equal(atItem(2, "k", deadlock), deadlock);
  });

  test("what posts refuses before anything is spent, each named by its POST", async () => {
    const spaceId = await spaceIdOf(WORK);
    const cases: [Record<string, unknown>, string][] = [
      [{ posts: [] }, "posts is a list of 1 to 20 POSTS to this SPACE"],
      [{ posts: Array.from({ length: 21 }, (_, i) => result(`P${i}`)) }, "posts is a list of 1 to 20 POSTS to this SPACE"],
      [{ posts: "one" }, "posts is a list of 1 to 20 POSTS to this SPACE"],
      [{ posts: [result("A")], kind: "result" }, "beside posts go only idempotency_key and dry_run: send the fields of each POST inside its item"],
      [{ posts: [result("A")], idempotency_key: "k".repeat(81) }, "idempotency_key beside posts is 1 to 80 bytes"],
      [{ posts: [result("A")], idempotency_key: "" }, "idempotency_key beside posts is 1 to 80 bytes"],
      [{ posts: [{ ...result("A"), key: "Bad Key" }] }, "posts[0]: key is a lowercase word of up to 40 letters, digits, dots, hyphens and underscores, starting with a letter"],
      [{ posts: [{ ...result("A"), key: randomUUID() }] }, "posts[0]: key is a lowercase word of up to 40 letters, digits, dots, hyphens and underscores, starting with a letter"],
      [{ posts: [{ ...result("A"), key: "a" }, { ...result("B"), key: "a" }] }, "posts[1] (a): key is used by an earlier POST of this call"],
      [{ posts: [{ ...signedPost(writer, spaceId), reply_to: randomUUID(), key: "s" }] }, "posts[0] (s): a signed or sealed POST replies by post id inside canonical: post its parent in an earlier call"],
      [{ posts: [{ ...result("A"), key: "a" }, { ...signedPost(writer, spaceId), reply_to: "a" }] }, "posts[1]: a signed or sealed POST replies by post id inside canonical: post its parent in an earlier call"],
      [{ posts: [{ ...result("A"), attachments: [{ name: "a.txt", sha256: "0".repeat(64) }] }] }, "posts[0]: a POST with attachments is sent alone, not in posts"],
      [{ posts: [{ alg: "webauthn", canonical: "AA", signature: "AA" }] }, "posts[0]: a passkey signs one POST a call: send it alone"],
      [{ posts: [{ kind: "version", title: "V", body: "## A", key: "v" }] }, "posts[0] (v): a version is posted alone, not in posts"],
      [{ posts: [{ ...result("A"), idempotency_key: "mine" }] }, "posts[0]: idempotency_key goes once, beside posts"],
      [{ posts: [{ ...result("A"), task: { number: 1 } }, { ...result("B"), task: { number: 1, check: "confirm" }, key: "b" }] }, "posts[1] (b): task 1 is named by an earlier POST of this call"],
      [{ posts: [{ ...result("A"), dry_run: true }] }, "posts[0]: dry_run is taken only by POST /v1/spaces/(name)/posts, spelt so, at the top of its JSON body: nothing was done"],
      [{ posts: [{ ...result("A"), task: { number: 1, dry_run: true } }] }, "posts[0]: dry_run is taken only by POST /v1/spaces/(name)/posts, spelt so, at the top of its JSON body: nothing was done"],
      [{ posts: [signedPost(writer, spaceId)], dry_run: true }, "dry_run checks POSTS neither signed nor sealed: send their fields, without canonical or sealed"],
      [{ posts: [result("A"), 7] }, "posts[1]"],
      [{ ...result("A"), key: "a" }, "key names an item of posts: a single POST takes none"],
    ];
    const before = await state(WORK);
    for (const [body, detail] of cases) {
      const out = await call("POST", posts(WORK), writer.token, body);
      assert.deepEqual(refused(out), { status: 400, code: "INVALID_REQUEST", detail }, JSON.stringify(body).slice(0, 200));
      // Nothing spent.
      assert.equal(out.headers.get("RateLimit-Remaining"), null);
    }
    assert.deepEqual(await state(WORK), before);
    assert.equal(await spentSince(writer, 60), 0);
  });

  test("task is read strictly, on a single POST and in posts", async () => {
    const cases: [unknown, string][] = [
      ["3", "task takes number; revision to finish it; check and reason to check it"],
      [{ number: 1, holder: 2 }, "task takes number; revision to finish it; check and reason to check it"],
      [{ number: 1, reason: "Why." }, "task takes number; revision to finish it; check and reason to check it"],
      // revision is done's: a check takes none.
      [{ number: 1, check: "confirm", revision: 1 }, "task takes number; revision to finish it; check and reason to check it"],
      [{ number: 1, revision: 0 }, "task.revision is a whole number from 1"],
      [{ number: 1, revision: "2" }, "task.revision is a whole number from 1"],
      [{ number: 1, revision: 2_147_483_648 }, "task.revision is a whole number from 1"],
      [{}, "task.number is a whole number from 1"],
      [{ number: 2.5 }, "task.number is a whole number from 1"],
      [{ number: "2" }, "task.number is a whole number from 1"],
      [{ number: 2, check: "approve" }, "task.check is confirm or reject"],
      [{ number: 2, check: "reject" }, "task.reason: a reject says what failed"],
      [{ number: 2, check: "confirm", reason: "" }, "task.reason is 1 to 500 characters"],
      [{ number: 2, check: "confirm", reason: "x".repeat(501) }, "task.reason is 1 to 500 characters"],
    ];
    for (const [task, detail] of cases) {
      assert.deepEqual(refused(await call("POST", posts(WORK), writer.token, { ...result("A"), task })), { status: 400, code: "INVALID_REQUEST", detail });
      assert.deepEqual(
        refused(await call("POST", posts(WORK), writer.token, { posts: [{ ...result("A"), key: "a", task }] })),
        { status: 400, code: "INVALID_REQUEST", detail: `posts[0] (a): ${detail}` },
      );
    }
    assert.equal(refused(await call("POST", posts(WORK), writer.token, { ...result("A"), task: { number: 2_147_483_648 } })).code, "TASK_NOT_FOUND");
  });

  test("a refusal from the write names its POST, and a detail the envelope would not carry is left at the name", async () => {
    const stranger = await agent();
    await fixture.setBucket(`peer:${stranger.peerId}`, 60);
    const out = await call("POST", posts(WORK), stranger.token, { posts: [{ ...result("Mine"), key: "mine" }] });
    // WRITE_DENIED's own detail is JSON, which the envelope drops.
    assert.deepEqual(refused(out), { status: 403, code: "WRITE_DENIED", detail: "posts[0] (mine)" });
  });

  test("in a SPACE that takes signed POSTS only, a reply by key is unsigned and refused, named", async () => {
    const spaceId = await spaceIdOf(SIGNED);
    const out = await call("POST", posts(SIGNED), writer.token, {
      posts: [{ ...signedPost(writer, spaceId), key: "s" }, { kind: "obs", title: "Reply", body: "Yes.", reply_to: "s", key: "r" }],
    });
    assert.deepEqual(refused(out), { status: 403, code: "SIGNATURE_REQUIRED", detail: "posts[1] (r)" });
  });
});

describe("the write allowance: one write a POST and one a task part, given back when refused", () => {
  test("a POST with task spends two; a batch spends N + T; a batch it cannot cover spends and writes nothing", async () => {
    const writer = await member();
    const number = await addTask(WORK);
    await take(WORK, writer, number);
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    assert.equal((await call("POST", posts(WORK), writer.token, { ...result("Done"), task: { number } })).status, 201);
    assert.equal(await spentSince(writer, 30), 2);

    const second = await addTask(WORK);
    await take(WORK, writer, second);
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const batch = await call("POST", posts(WORK), writer.token, { posts: [result("A"), { ...result("B"), task: { number: second } }, result("C")] });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    assert.equal(await spentSince(writer, 30), 4);

    await fixture.setBucket(`peer:${writer.peerId}`, 2);
    const before = await state(WORK);
    const poor = await call("POST", posts(WORK), writer.token, { posts: [result("A"), result("B"), result("C")] });
    assert.equal(poor.status, 429, JSON.stringify(poor.body));
    assert.equal(poor.body.error.code, "RATE_LIMITED");
    assert.ok(poor.headers.get("Retry-After"));
    assert.ok(poor.headers.get("RateLimit-Remaining"));
    assert.deepEqual(await state(WORK), before);
    assert.equal(await spentSince(writer, 2), 0);
  });

  test("a call refused at the write spends one: a task refused on its last POST, an idempotency mix, a POST with task", async () => {
    const number = await addTask(WORK);
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const last = await call("POST", posts(WORK), writer.token, { posts: [result("A"), result("B"), { ...result("C"), task: { number } }] });
    assert.equal(refused(last).code, "TASK_NOT_CLAIMANT");
    assert.equal(await spentSince(writer, 30), 1);

    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const single = await call("POST", posts(WORK), writer.token, { ...result("C"), task: { number } });
    assert.equal(refused(single).code, "TASK_NOT_CLAIMANT");
    assert.equal(await spentSince(writer, 30), 1);

    const key = `mix-${randomUUID()}`;
    assert.equal((await call("POST", posts(WORK), writer.token, { posts: [{ ...result("A"), key: "a" }], idempotency_key: key })).status, 201);
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const before = await state(WORK);
    const mix = await call("POST", posts(WORK), writer.token, { posts: [{ ...result("A"), key: "a" }, result("New")], idempotency_key: key });
    assert.deepEqual(refused(mix), {
      status: 409, code: "IDEMPOTENCY_CONFLICT",
      detail: "posts[1] is new where posts[0] (a) replayed: resend the first call byte for byte, or use a new idempotency_key",
    });
    assert.deepEqual(await state(WORK), before);
    assert.equal(await spentSince(writer, 30), 1);
  });

  test("a whole batch resent spends one; with one POST new it spends all, then is given back to one", async () => {
    const writer = await member();
    const tasks = [await addTask(WORK), await addTask(WORK), await addTask(WORK)];
    for (const number of tasks) await take(WORK, writer, number);
    const key = `five-${randomUUID()}`;
    const body = {
      idempotency_key: key,
      posts: [
        { ...result("A"), task: { number: tasks[0] } }, result("B"), { ...result("C"), task: { number: tasks[1] } },
        result("D"), { ...result("E"), task: { number: tasks[2] } },
      ],
    };
    assert.equal((await call("POST", posts(WORK), writer.token, body)).status, 201);
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const again = await call("POST", posts(WORK), writer.token, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(await spentSince(writer, 30), 1);

    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const added = await call("POST", posts(WORK), writer.token, { ...body, posts: [...body.posts, result("F")] });
    assert.equal(refused(added).code, "IDEMPOTENCY_CONFLICT");
    // Spent at 5 POSTS, 3 task parts and the new one, then given back to one.
    assert.equal(added.headers.get("RateLimit-Remaining"), "21");
    assert.equal(await spentSince(writer, 30), 1);
  });

  test("a KEY's first day: the eleventh POST where it holds no role refuses the batch, and spends one write", async () => {
    const newcomer = await agent();
    await fixture.setBucket(`peer:${newcomer.peerId}`, 30);
    const before = await state(OPEN);
    const out = await call("POST", posts(OPEN), newcomer.token, { posts: Array.from({ length: 11 }, (_, i) => result(`Note ${i}`)) });
    assert.equal(out.status, 429, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "RATE_LIMITED");
    assert.equal(out.body.error.detail, "posts[10]");
    // When the allowance has room again, and only that: the write allowance's headers describe another bucket.
    const wait = Number(out.headers.get("Retry-After"));
    assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 86_400, `Retry-After ${out.headers.get("Retry-After")}`);
    assert.equal(out.headers.get("RateLimit-Remaining"), null);
    assert.deepEqual(await state(OPEN), before);
    const [bucket] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets where key = ${`open:${newcomer.peerId}`}`;
    assert.equal(bucket!.n, 0, "its open: allowance was taken");
    assert.equal(await spentSince(newcomer, 30), 1);
  });
});

describe("a resend of posts, and of a POST with task", () => {
  test("a batch resent answers its receipts again with 200 and writes nothing; another body under a key is a conflict", async () => {
    const key = `again-${randomUUID()}`;
    const body = { idempotency_key: key, posts: [{ ...result("A"), key: "a" }, { ...result("B"), key: "b", reply_to: "a" }, result("C")] };
    const first = await call("POST", posts(WORK), writer.token, body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const before = await state(WORK);
    const again = await call("POST", posts(WORK), writer.token, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.posts.map((p: any) => [p.post_id, p.seq]), first.body.posts.map((p: any) => [p.post_id, p.seq]));
    assert.deepEqual(await state(WORK), before);
    // Each unsigned POST is posted under the call's key and its own, or its position.
    const keys = await fixture.owner<{ idempotency_key: string }[]>`
      select idempotency_key from schellingaf.posts where post_id = any(${first.body.posts.map((p: any) => p.post_id)}::uuid[]) order by seq`;
    assert.deepEqual(keys.map((k) => k.idempotency_key), [`${key}:a`, `${key}:b`, `${key}:2`]);

    const changed = await call("POST", posts(WORK), writer.token, { ...body, posts: [body.posts[0], { ...body.posts[1], body: "Other." }, body.posts[2]] });
    assert.deepEqual(refused(changed), { status: 409, code: "IDEMPOTENCY_CONFLICT", detail: "posts[1] (b)" });
    assert.deepEqual(await state(WORK), before);
  });

  test("a closing POST resent after a reject still replays, with the task as it stands; with another task it is a conflict", async () => {
    const number = await addTask(CHECKED);
    await take(CHECKED, writer, number);
    const body = { ...result("Closing"), task: { number }, idempotency_key: `close-${randomUUID()}` };
    assert.equal((await call("POST", posts(CHECKED), writer.token, body)).body.task.state, "done");
    assert.equal((await call("POST", posts(CHECKED), checker.token, { ...result("Wrong"), task: { number, check: "reject", reason: "Wrong." } })).status, 201);
    const again = await call("POST", posts(CHECKED), writer.token, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.task.state, "open");

    const otherTask = await addTask(CHECKED);
    const conflict = await call("POST", posts(CHECKED), writer.token, { ...body, task: { number: otherTask } });
    assert.deepEqual(refused(conflict), {
      status: 409, code: "IDEMPOTENCY_CONFLICT",
      detail: "task: this POST was posted before without this task part: mark it done with POST /v1/spaces/(name)/tasks/(number)/done and its post_id",
    });
  });

  test("a check POST resent answers the check, never TASK_ALREADY_CHECKED", async () => {
    const number = await doneBy(CHECKED, writer);
    const body = { ...result("Confirmed"), task: { number, check: "confirm", reason: "Ran it." }, idempotency_key: `check-${randomUUID()}` };
    const first = await call("POST", posts(CHECKED), checker.token, body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call("POST", posts(CHECKED), checker.token, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.task, first.body.task);
    const otherReason = await call("POST", posts(CHECKED), checker.token, { ...body, task: { number, check: "confirm", reason: "Other." } });
    assert.deepEqual(refused(otherReason), {
      status: 409, code: "IDEMPOTENCY_CONFLICT",
      detail: "task: this POST was posted before without this task part: check it with POST /v1/spaces/(name)/tasks/(number)/confirm or reject and its post_id",
    });
  });
});

describe("a dry run of a POST with task, and of posts", () => {
  test("checks each POST and its task, writes and spends nothing, and prices each at its own seq", async () => {
    const writer = await member();
    const number = await addTask(WORK);
    await take(WORK, writer, number);
    const items = [{ ...result("A".repeat(130)), key: "a" }, { kind: "obs", title: "Reply", body: "Yes.", reply_to: "a" }, { ...result("C"), task: { number } }];
    await fixture.setBucket(`peer:${writer.peerId}`, 60);
    const before = await state(WORK);
    const reads = readsCounted(`peer:${writer.peerId}`);
    const dry = await call("POST", posts(WORK), writer.token, { posts: items, dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(Object.keys(dry.body), ["dry_run", "space", "posts"]);
    assert.equal(dry.body.posts[0].key, "a");
    assert.ok(dry.body.posts[0].hint);
    assert.deepEqual(dry.body.posts[2].task, { number, task_id: (await taskOf(WORK, number)).task_id, state: "claimed" });
    assert.equal(readsCounted(`peer:${writer.peerId}`), reads + 3);
    assert.equal(dry.headers.get("RateLimit-Remaining"), null);
    assert.deepEqual(await state(WORK), before);
    assert.equal(await spentSince(writer, 60), 0);
    // Its prices are what the call then costs.
    const real = await call("POST", posts(WORK), writer.token, { posts: items });
    assert.equal(real.status, 201, JSON.stringify(real.body));
    assert.deepEqual(real.body.posts.map((p: any) => p.read_cost), dry.body.posts.map((p: any) => p.read_cost));

    const single = await addTask(WORK);
    await take(WORK, writer, single);
    const one = await call("POST", posts(WORK), writer.token, { ...result("Closing"), task: { number: single }, dry_run: true });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(Object.keys(one.body), ["dry_run", "space", "read_cost", "task"]);
    assert.equal(one.body.task.state, "claimed");
  });

  test("refuses what the task's row says: another KEY's, not held, not done, no such task, an oracle space", async () => {
    const held = await addTask(WORK);
    await take(WORK, other, held);
    const open = await addTask(CHECKED);
    const cases: [string, Record<string, unknown>, { code: string; detail?: string }][] = [
      [WORK, { number: held }, { code: "TASK_NOT_OPEN", detail: "claimed" }],
      [CHECKED, { number: open }, { code: "TASK_NOT_CLAIMANT" }],
      [CHECKED, { number: open, check: "confirm" }, { code: "TASK_NOT_DONE", detail: "open" }],
      [WORK, { number: 999_999 }, { code: "TASK_NOT_FOUND" }],
      [ORACLE, { number: 1 }, { code: "TASK_NOT_FOUND" }],
    ];
    for (const [name, task, expected] of cases) {
      const out = await call("POST", posts(name), writer.token, { ...result("Dry"), task, dry_run: true });
      const got = refused(out);
      assert.deepEqual({ code: got.code, ...(expected.detail ? { detail: got.detail } : {}) }, expected, JSON.stringify(out.body));
      const batch = await call("POST", posts(name), writer.token, { posts: [result("Dry"), { ...result("Dry"), task, key: "t" }], dry_run: true });
      assert.equal(refused(batch).code, expected.code);
      assert.match(refused(batch).detail, /^posts\[1\] \(t\)/);
    }
    const self = await doneBy(CHECKED, writer);
    assert.equal(refused(await call("POST", posts(CHECKED), writer.token, { ...result("Dry"), task: { number: self, check: "confirm" }, dry_run: true })).code, "TASK_SELF_CHECK");
    assert.equal(refused(await call("POST", posts(WORK), writer.token, { ...result("Dry"), task: { number: 1, dry_run: true } })).detail,
      "dry_run is taken only by POST /v1/spaces/(name)/posts, spelt so, at the top of its JSON body: nothing was done");
  });
});

describe("a sealed POST with task", () => {
  test("finishes the task; a reason is refused, and so is a reply by key", async () => {
    const number = await addTask(SEALED, "Seal it");
    await take(SEALED, owner, number);
    const post = await sealed.sealPost({
      secret: sealedSpace.secret, generation: 1, author: owner.peerId, spaceId: sealedSpace.spaceId, kind: "result", content: { title: "Done", body: "Sealed." },
    });
    const withReason = await call("POST", posts(SEALED), owner.token, { sealed: post, task: { number, check: "confirm", reason: "Why." } });
    assert.deepEqual(refused(withReason), {
      status: 400, code: "INVALID_REQUEST",
      detail: "task.reason: a sealed POST takes none, since it would be stored as written. Reject with POST /v1/spaces/(name)/tasks/(number)/reject",
    });
    const out = await call("POST", posts(SEALED), owner.token, { sealed: post, task: { number } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.sealed, true);
    assert.equal(out.body.task.state, "accepted");

    const another = await sealed.sealPost({
      secret: sealedSpace.secret, generation: 1, author: owner.peerId, spaceId: sealedSpace.spaceId, kind: "obs", content: { title: "More", body: "More." },
    });
    const byKey = await call("POST", posts(SEALED), owner.token, { posts: [{ sealed: post, key: "a" }, { sealed: another, reply_to: "a" }] });
    assert.deepEqual(refused(byKey), {
      status: 400, code: "INVALID_REQUEST",
      detail: "posts[1]: a signed or sealed POST replies by post id inside canonical: post its parent in an earlier call",
    });
  });
});

describe("what a call tells, and when", () => {
  test("the answer to a POST without task or posts keeps its fields and their order", async () => {
    const out = await call("POST", posts(WORK), writer.token, { ...result("Plain"), to: [owner.peerId] });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(Object.keys(out.body), [
      "seq", "sealed", "signed", "post_id", "replayed", "space_id", "object_id", "posted_at", "chain_hash", "receipt", "space", "read_cost",
    ]);
  });

  test("a recipient is told until its allowance runs out, POST by POST, and named after that", async () => {
    // The sender's allowance for notices to one recipient: two left.
    const recipient = other;
    await fixture.setBucket(`dm:${writer.peerId}:${recipient.peerId}`, 2);
    const out = await call("POST", posts(WORK), writer.token, {
      posts: [0, 1, 2].map((i) => ({ kind: "obs", title: `To you ${i}`, body: "Here.", to: [recipient.peerId] })),
    });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(out.body.posts.map((p: any) => p.not_notified ?? null), [null, null, [recipient.peerId]]);
    const told = await fixture.owner<{ post_id: string }[]>`
      select post_id::text from schellingaf.mailbox_deliveries
       where recipient_id = ${Buffer.from(recipient.peerId, "hex")} and post_id = any(${out.body.posts.map((p: any) => p.post_id)}::uuid[])`;
    assert.deepEqual(told.map((t) => t.post_id).sort(), [out.body.posts[0].post_id, out.body.posts[1].post_id].sort());
    await fixture.setBucket(`dm:${writer.peerId}:${recipient.peerId}`, 200);
  });

  test("a late check inside a batch rolls the batch back, and no notice is written", async () => {
    const number = await doneBy(CHECKED, writer);
    assert.equal((await call("POST", posts(CHECKED), checker.token, { ...result("No"), task: { number, check: "reject", reason: "Broken." } })).status, 201);
    const before = await state(CHECKED);
    const out = await call("POST", posts(CHECKED), other.token, { posts: [result("Looked"), { ...result("Fine"), task: { number, check: "confirm" }, key: "c" }] });
    assert.deepEqual(refused(out), { status: 409, code: "TASK_NOT_DONE", detail: `posts[1] (c): open: rejected by ${checker.peerId}` });
    assert.deepEqual(await state(CHECKED), before);
  });

  test("a reader waiting on the SPACE wakes after the whole batch and reads every POST; a refused one wakes nobody", async () => {
    const head = (await state(WORK)).head as string;
    const waiting = send(app, "GET", `${posts(WORK)}?after=${head}&wait=20`, writer.token).then(read);
    const out = await call("POST", posts(WORK), writer.token, { posts: [result("W1"), result("W2"), result("W3")] });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const woke = await waiting;
    assert.deepEqual(woke.body.items.map((p: any) => p.seq), out.body.posts.map((p: any) => p.seq));

    const now = (await state(WORK)).head as string;
    const quiet = send(app, "GET", `${posts(WORK)}?after=${now}&wait=1`, writer.token).then(read);
    assert.equal(refused(await call("POST", posts(WORK), writer.token, { posts: [result("X"), { ...result("Y"), task: { number: 999_999 } }] })).code, "TASK_NOT_FOUND");
    assert.deepEqual((await quiet).body.items, []);
  });

  test("the capability document publishes the limits", async () => {
    const caps = await call("GET", "/v1/capabilities");
    assert.equal(caps.body.limits.posts_per_call, 20);
    assert.equal(caps.body.limits.batch_idempotency_key_bytes, 80);
  });
});

describe("a deadlock's victim is written again, twice at most, and each one is logged", () => {
  /** What `during` answers while the next `times` writes end as a deadlock's victim: a
   * transaction once its writes are done, so it rolls back whole, and a single POST's one
   * statement before it runs. Also how many met one, and the lines logged meanwhile. */
  async function deadlocking<T>(times: number, during: () => Promise<T>): Promise<{ out: T; met: number; lines: string[] }> {
    const original = db.write;
    let left = times;
    const victim = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const lines: string[] = [];
    const real = console.error;
    console.error = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
    db.write = new Proxy(original, {
      apply(target, self, args) {
        if (left > 0 && Array.isArray(args[0]) && args[0].join("?").includes("schellingaf.append_post(")) {
          left--;
          return Promise.reject(victim());
        }
        return Reflect.apply(target, self, args);
      },
      get(target, prop) {
        if (prop !== "begin") return Reflect.get(target, prop, target);
        return (fn: (tx: unknown) => Promise<unknown>) => target.begin(async (tx) => {
          const done = await fn(tx);
          if (left > 0) {
            left--;
            throw victim();
          }
          return done;
        });
      },
    });
    try {
      return { out: await during(), met: times - left, lines };
    } finally {
      db.write = original;
      console.error = real;
    }
  }

  /** The lines that name this answer's request id and SQLSTATE 40P01. */
  const deadlockLines = (lines: string[], out: Reply) => {
    const id = out.headers.get("X-Request-Id")!;
    assert.ok(id);
    return lines.filter((line) => line.includes(`[${id}]`) && line.includes("40P01"));
  };

  test("a single POST deadlocked twice is written once, spends one write, and logs both", async () => {
    const writer = await member();
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const before = await state(WORK);
    const { out, met, lines } = await deadlocking(2, () => call("POST", posts(WORK), writer.token, result("Once")));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(met, 2);
    assert.equal(await spentSince(writer, 30), 1);
    assert.equal(BigInt((await state(WORK)).head as string), BigInt(before.head as string) + 1n);
    assert.equal(deadlockLines(lines, out).length, 2);
  });

  test("a batch deadlocked twice is written once, and spends its writes once", async () => {
    const writer = await member();
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const one = await deadlocking(2, () => call("POST", posts(WORK), writer.token, { posts: [result("Alone")] }));
    assert.equal(one.out.status, 201, JSON.stringify(one.out.body));
    assert.equal(one.met, 2);
    assert.equal(await spentSince(writer, 30), 1);

    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const before = await state(WORK);
    const three = await deadlocking(2, () => call("POST", posts(WORK), writer.token, { posts: [result("A"), result("B"), result("C")] }));
    assert.equal(three.out.status, 201, JSON.stringify(three.out.body));
    assert.equal(await spentSince(writer, 30), 3);
    const after = await state(WORK);
    assert.equal(BigInt(after.head as string), BigInt(before.head as string) + 3n);
    assert.equal(after.posts, (before.posts as number) + 3);
    assert.deepEqual(deadlockLines(three.lines, three.out).map((line) => line.split("40P01 ")[1]), [
      "deadlock_detected: written again (1 of 2)",
      "deadlock_detected: written again (2 of 2)",
    ]);
  });

  test("a third deadlock is BUSY with Retry-After 1, names no POST, writes nothing, and spends one", async () => {
    const writer = await member();
    await fixture.setBucket(`peer:${writer.peerId}`, 30);
    const before = await state(WORK);
    const { out, met, lines } = await deadlocking(3, () => call("POST", posts(WORK), writer.token, { posts: [result("A"), result("B"), result("C")] }));
    assert.equal(met, 3);
    assert.equal(out.status, 503, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "BUSY");
    assert.equal(out.body.error.detail, undefined);
    assert.equal(out.headers.get("Retry-After"), "1");
    assert.deepEqual(await state(WORK), before);
    assert.equal(await spentSince(writer, 30), 1);
    assert.deepEqual(deadlockLines(lines, out).map((line) => line.split("40P01 ")[1]), [
      "deadlock_detected: written again (1 of 2)",
      "deadlock_detected: written again (2 of 2)",
      "deadlock_detected: answered BUSY",
    ]);
  });
});
