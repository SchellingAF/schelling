// Read-only at zero (migrations/0157_credit_enforcement.sql): while billing is live, a
// write that would store words or bytes in a SPACE whose credit cannot pay a day of its
// storage is refused CREDIT_NEEDED, status 402, with the day's cost, 30 days' cost and the
// balance in its detail; everything else stays open. credit_refusal() is the rule; seven
// triggers on six tables enforce it. A successor's owner and admins may hide a replaced SPACE's posts.
//
// billing_epoch.real_from is set in the past here, as the owner, so billing is live. A SPACE
// is put over its allowance by setting its post counter as the owner: 6,000,000 bytes over
// is a day of 1,000 micro-dollars, which reads $0.01, and 30 days $0.03. "At zero" is such a
// SPACE with no credit and no free days.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { useService, fixture, db, app, config, call, agent, type Agent, type Reply } from "./lib/service.ts";
import { openDb } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { FUNDING } from "../src/surface/vocabulary.ts";
import { deadlocked, fromDatabaseError } from "../src/db/errors.ts";
import { makeCheckpoints } from "../src/db/checkpoints.ts";
import { developmentServiceKey } from "../src/domain/service.ts";
import * as sealed from "../content/sealed.mjs";

const key = developmentServiceKey();
const ready = useService("credit_enforcement", { apiHost: "api.credit-enforcement.test", serviceKey: key });

const PUB = FUNDING.allowanceBytes.public;
const SEALED = FUNDING.allowanceBytes.sealed;
/** Bytes over an allowance that cost 1,000 micro-dollars a day. */
const OVER = 6_000_000;
/** Bytes over an allowance that cost 0 a day: one more byte makes a day cost 1 micro-dollar. */
const EDGE = 5999;

const detailOf = (name: string) =>
  `with this write a day of storage costs $0.01, the balance is $0.00, and 30 days cost $0.03. Add credit: GET /v1/spaces/${name}/funding`;

let n = 0;
const newName = () => `credit-gate-${process.pid}-${n++}`;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let owner: Agent;

before(async () => {
  await ready;
  owner = await agent({ encryptionKey: true });
  await live();
});

/** Billing live from 1 September, the switch on real. */
async function live() {
  await fixture.owner`update schellingaf.billing_epoch set real_from = '2026-09-01', mode = 'real'`;
}

/** A KEY's write allowance full again: this file writes more than a KEY may in a few seconds. */
async function refill(who: Agent) {
  await fixture.setBucket(`peer:${who.peerId}`, 60);
}

/** A call as `who`, its allowance refilled first. */
async function as(who: Agent, method: string, path: string, payload?: unknown): Promise<Reply> {
  await refill(who);
  return call(method, path, who.token, payload);
}

function ok(out: Pick<Reply, "status" | "body">, status = 200) {
  assert.equal(out.status, status, JSON.stringify(out.body));
}

/** CREDIT_NEEDED, 402, with the detail given or the at-zero detail of `name`. */
function refused(out: Reply, name: string, detail: string | RegExp = detailOf(name)) {
  assert.equal(out.status, 402, JSON.stringify(out.body));
  assert.equal(out.body.error.code, "CREDIT_NEEDED");
  if (typeof detail === "string") assert.equal(out.body.error.detail, detail);
  else assert.match(out.body.error.detail, detail);
  assert.match(out.body.error.fix, /GET \/v1\/spaces\/\{name\}\/funding/);
}

type Space = { name: string; id: string };

async function idOf(name: string): Promise<string> {
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return row!.id;
}

async function space(extra: Record<string, unknown> = {}, who: Agent = owner): Promise<Space> {
  const name = newName();
  const out = await as(who, "POST", "/v1/spaces", { name, title: "Credit gate", visibility: "public", ...extra });
  ok(out, 201);
  return { name, id: await idOf(name) };
}

/** A SPACE's post counter, set as the owner. */
async function setBytes(id: string, bytes: number) {
  await fixture.owner`
    insert into schellingaf.space_storage as t (space_id, post_bytes) values (${id}::uuid, ${bytes})
    on conflict (space_id) do update set post_bytes = excluded.post_bytes`;
}

async function counters(id: string): Promise<{ posts: number; tasks: number; files: number }> {
  const [row] = await fixture.owner<{ posts: string; tasks: string; files: string }[]>`
    select coalesce((select post_bytes from schellingaf.space_storage where space_id = ${id}::uuid), 0)::text as posts,
           coalesce((select task_bytes from schellingaf.space_storage where space_id = ${id}::uuid), 0)::text as tasks,
           coalesce((select attached_bytes from schellingaf.space_file_totals where space_id = ${id}::uuid), 0)::text as files`;
  return { posts: Number(row!.posts), tasks: Number(row!.tasks), files: Number(row!.files) };
}

async function deposit(id: string, micro: number) {
  await fixture.owner`select * from schellingaf.credit_post(${id}::uuid, 'deposit', ${micro}, ${`deposit:${randomUUID()}`}, 'a test')`;
}

async function grant(s: Space, who: Agent, role: string) {
  ok(await as(owner, "PUT", `/v1/spaces/${s.name}/members/${who.peerId}`, { role }));
}

const post = (who: Agent, s: Space, fields: Record<string, unknown> = {}) =>
  as(who, "POST", `/v1/spaces/${s.name}/posts`, { kind: "obs", title: "A note", body: `Seen ${randomUUID()}.`, ...fields });

/** An upload, as an agent sends it: the raw bytes with their length. */
async function put(authorization: string, s: Space, content: string): Promise<Pick<Reply, "status" | "body">> {
  const body = Buffer.from(content, "utf8");
  const res = await app.request(`/v1/spaces/${s.name}/files/${sha(body)}`, {
    method: "PUT",
    headers: { "content-length": String(body.length), authorization },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

const entry = (content: string) => ({ sha256: sha(content), name: "notes.txt", media_type: "text/plain" });

/** A sealed SPACE as the owner's software makes one, with its first key. */
async function sealedSpace(maker: Agent = owner) {
  const name = newName();
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const me = new Uint8Array(Buffer.from(maker.peerId, "hex"));
  const lock = await sealed.sealLock({
    container, g: 1, recipient: me, sender: me, commitment: g1.commitment, secret: g1.secret, pkR: maker.enc!.pk, skS: maker.enc!.sk,
  });
  ok(await as(maker, "POST", "/v1/spaces", {
    name, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
  }), 201);
  return { name, id: spaceId, container, secret: g1.secret };
}

async function sealedPost(who: Agent, s: { name: string; id: string; secret: Uint8Array }, body: string) {
  const item = await sealed.sealPost({ secret: s.secret, generation: 1, author: who.peerId, spaceId: s.id, kind: "obs", content: { title: "Sealed", body } });
  return as(who, "POST", `/v1/spaces/${s.name}/posts`, { sealed: item });
}

describe("refused at zero", () => {
  test("every POST: a note, a reply, a batch, a version, a dossier, a decision; and the dry run, with the same detail", async () => {
    const s = await space({ document: true });
    const first = await post(owner, s);
    ok(first, 201);
    ok(await post(owner, s, { kind: "version", body: "# Pages\n\nNone yet." }), 201);
    const [current] = await fixture.owner<{ id: string }[]>`
      select v.post_id::text as id from schellingaf.oracle_versions v where v.space_id = ${s.id}::uuid and v.state = 'current'`;
    await setBytes(s.id, PUB + OVER);
    const before = await counters(s.id);

    refused(await post(owner, s), s.name);
    refused(await post(owner, s, { kind: "result", reply_to: first.body.post_id }), s.name);
    // A batch names the POST it stopped at.
    refused(await as(owner, "POST", `/v1/spaces/${s.name}/posts`, { posts: [{ kind: "obs", title: "One", body: "one" }, { kind: "obs", title: "Two", body: "two" }] }), s.name, `posts[0]: ${detailOf(s.name)}`);
    refused(await post(owner, s, { kind: "version", supersedes: current!.id, body: "# Pages\n\nOne." }), s.name);
    refused(await post(owner, s, { kind: "dossier", body: "where the work stands" }), s.name);
    refused(await post(owner, s, { kind: "decision", body: "Withdrawn.", retracts: first.body.post_id }), s.name);
    refused(await post(owner, s, { dry_run: true }), s.name);
    assert.deepEqual(await counters(s.id), before, "nothing was stored");
  });

  test("a sealed POST", async () => {
    const s = await sealedSpace();
    await setBytes(s.id, SEALED + OVER);
    refused(await sealedPost(owner, s, "written at zero"), s.name);
  });

  test("an upload, an upload through a grant, and an attachment", async () => {
    const s = await space();
    const kept = `kept ${randomUUID()}`;
    ok(await put(`Bearer ${owner.token}`, s, kept), 201);
    await setBytes(s.id, PUB + OVER);

    const other = `new ${randomUUID()}`;
    const upload = await put(`Bearer ${owner.token}`, s, other);
    assert.equal(upload.status, 402, JSON.stringify(upload.body));
    assert.equal(upload.body.error.code, "CREDIT_NEEDED");
    assert.equal(upload.body.error.detail, detailOf(s.name));

    const asked = await as(owner, "POST", `/v1/spaces/${s.name}/uploads`, { sha256: [sha(other)] });
    ok(asked, 201);
    const granted = await put(asked.body.uploads[0].authorization, s, other);
    assert.equal(granted.status, 402, JSON.stringify(granted.body));
    assert.equal(granted.body.error.code, "CREDIT_NEEDED");

    refused(await post(owner, s, { attachments: [entry(kept)] }), s.name);
  });

  test("tasks: an add, a batch, a change of title and of body, and retire with replacement tasks", async () => {
    const s = await space();
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { tasks: [{ title: "First", body: "one" }, { title: "Second" }] }), 201);
    await setBytes(s.id, PUB + OVER);
    const before = await counters(s.id);

    refused(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { title: "Third" }), s.name);
    refused(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { tasks: [{ title: "Third" }, { title: "Fourth" }] }), s.name);
    refused(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/1/change`, { reason: "Clearer.", revision: 1, title: "First, clearer" }), s.name);
    refused(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/1/change`, { reason: "Clearer.", revision: 1, body: "one, said again" }), s.name);
    refused(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/2/retire`, { reason: "Split.", tasks: [{ key: "x", title: "Part one" }] }), s.name);
    assert.deepEqual(await counters(s.id), before);
  });
});

describe("open at zero", () => {
  test("reads, decryption, the mailbox, joins, leaving, membership, invites, blocks, hiding, task claims and give-back, retire, delete, settings, a sealed key change, a direct message, a new SPACE, checkpoints, hand over and take over", async () => {
    const s = await space();
    const w = await agent();
    const heir = await agent();
    const outsider = await agent();
    await grant(s, w, "writer");
    await grant(s, heir, "admin");
    const note = await post(w, s);
    ok(note, 201);
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, {
      tasks: [{ title: "Claim me" }, { title: "Retire me" }, { title: "Delete me" }, { title: "Order me" }, { title: "Before me" }],
    }), 201);
    const sealedOne = await sealedSpace();
    const secretPost = await sealedPost(owner, sealedOne, "the plan, sealed");
    ok(secretPost, 201);
    await setBytes(s.id, PUB + OVER);
    await setBytes(sealedOne.id, SEALED + OVER);
    refused(await post(owner, s), s.name);

    // Reads.
    ok(await call("GET", `/v1/spaces/${s.name}`));
    ok(await call("GET", `/v1/spaces/${s.name}/posts`));
    ok(await call("GET", `/v1/spaces/${s.name}/tasks`));
    ok(await call("GET", `/v1/spaces/${s.name}/funding`));
    ok(await as(owner, "GET", "/v1/mailbox"));
    // A sealed post read and opened with the key.
    const page = await as(owner, "GET", `/v1/spaces/${sealedOne.name}/posts?detail=full`);
    ok(page);
    const p = page.body.items[0];
    const opened = await sealed.openSealed(p.sealed, {
      author: p.author, space_id: p.space_id, kind: p.kind, to: p.to, reply_to: p.reply_to, supersedes: p.supersedes, retracts: p.retracts,
    }, async () => sealedOne.secret);
    assert.equal(opened.content.body, "the plan, sealed");
    // A sealed key change.
    const g2 = await sealed.newGeneration(sealedOne.container, 2, sealedOne.secret);
    ok(await as(owner, "POST", `/v1/spaces/${sealedOne.name}/sealed/generations`, {
      generation: "2", commitment: hex(g2.commitment), back: hex(g2.back!),
    }), 201);

    // Joining, membership, invites, blocks.
    const asked = await as(outsider, "POST", `/v1/spaces/${s.name}/join`, {});
    assert.ok(asked.status === 200 || asked.status === 202, JSON.stringify(asked.body));
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/invites`, { role: "writer" }), 201);
    ok(await as(owner, "PUT", `/v1/spaces/${s.name}/blocks/${outsider.peerId}`, {}));
    ok(await as(owner, "DELETE", `/v1/spaces/${s.name}/blocks/${outsider.peerId}`));
    ok(await as(owner, "PUT", `/v1/spaces/${s.name}/members/${w.peerId}`, { role: "coordinator" }));
    ok(await as(owner, "PUT", `/v1/spaces/${s.name}/members/${w.peerId}`, { role: "writer" }));

    // Hiding and showing again.
    ok(await as(owner, "PUT", `/v1/posts/${note.body.post_id}/hidden`));
    ok(await as(owner, "DELETE", `/v1/posts/${note.body.post_id}/hidden`));

    // Tasks: a claim, progress, a give-back, retire alone, delete, a change of after alone, settings.
    ok(await as(w, "POST", `/v1/spaces/${s.name}/tasks/next`, { number: 1 }));
    ok(await as(w, "POST", `/v1/spaces/${s.name}/tasks/1/progress`, { post_id: note.body.post_id }));
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/1/release`, { reason: "Somebody else will." }));
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/2/retire`, { reason: "Not needed." }));
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/3/delete`, { reason: "Wrong." }));
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks/4/change`, { reason: "Order.", revision: 1, after: [5] }));
    ok(await as(owner, "PATCH", `/v1/spaces/${s.name}`, { task_confirmations: 1 }));
    ok(await as(owner, "PATCH", `/v1/spaces/${s.name}`, { title: "Credit gate, renamed", description: "Read-only for now." }));

    // A direct message, and a new SPACE with nothing in it.
    ok(await as(owner, "POST", "/v1/conversations", { to: [w.peerId], body: `in the clear ${randomUUID()}` }), 201);
    await space();

    // Checkpoints of a SPACE at zero.
    const run = await makeCheckpoints(db, key, { minAgeSeconds: 0, logDir: null });
    assert.equal(run.state, "done");
    const listed = await call("GET", `/v1/spaces/${s.name}/checkpoints`);
    ok(listed);
    assert.ok(listed.body.items.length >= 1, JSON.stringify(listed.body));

    // Leaving, then hand over and take over.
    ok(await as(w, "DELETE", `/v1/spaces/${s.name}/members/${w.peerId}`));
    const offer = await as(owner, "POST", `/v1/spaces/${s.name}/hand-over`, { to: heir.peerId });
    ok(offer, 201);
    ok(await as(heir, "POST", `/v1/hand-overs/${offer.body.offer_id}/accept`, {}));

    // Still read-only, for its new owner too.
    refused(await post(heir, s), s.name);
  });

  test("next's upkeep task is made in a SPACE at zero", async () => {
    const a = await agent();
    const b = await agent();
    const s = await space({ document: true });
    await grant(s, a, "writer");
    await grant(s, b, "writer");
    ok(await post(owner, s, { kind: "version", body: "# Pages\n\nNone yet." }), 201);
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { title: "Transcribe page 3" }), 201);
    for (let i = 0; i < 3; i++) ok(await post(a, s, { kind: "result", body: `Page ${i}, transcribed.` }), 201);
    await setBytes(s.id, PUB + OVER);
    refused(await post(a, s), s.name);
    const job = await as(b, "POST", `/v1/spaces/${s.name}/tasks/next`, { job: "upkeep" });
    ok(job);
    assert.equal(job.body.job, "upkeep", JSON.stringify(job.body));
  });

  test("recovery: the operator replaces a SPACE at zero", async () => {
    const s = await space();
    ok(await post(owner, s), 201);
    await setBytes(s.id, PUB + OVER);
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${s.name}, ${next}, 'a test')`;
    const [row] = await fixture.owner<{ replaced: string | null }[]>`
      select replaced_by::text as replaced from schellingaf.spaces where space_id = ${s.id}::uuid`;
    assert.equal(row!.replaced, await idOf(next));
  });
});

describe("the crossing", () => {
  test("a POST that would take a public SPACE over at zero is refused and stores nothing; one that stays under is allowed", async () => {
    const s = await space();
    await setBytes(s.id, PUB + EDGE);
    const at = await counters(s.id);
    refused(await post(owner, s), s.name, `with this write a day of storage costs $0.01, the balance is $0.00, and 30 days cost $0.01. Add credit: GET /v1/spaces/${s.name}/funding`);
    assert.deepEqual(await counters(s.id), at);
    await setBytes(s.id, PUB - 100_000);
    ok(await post(owner, s), 201);
  });

  test("a sealed POST that would cross is refused and stores nothing", async () => {
    const s = await sealedSpace();
    await setBytes(s.id, SEALED + EDGE);
    const out = await sealedPost(owner, s, "one byte too many");
    assert.equal(out.status, 402, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "CREDIT_NEEDED");
    assert.equal((await counters(s.id)).posts, SEALED + EDGE);
    await setBytes(s.id, SEALED - 100_000);
    ok(await sealedPost(owner, s, "under"), 201);
  });

  test("a task that would cross is refused; one that stays under is allowed", async () => {
    const s = await space();
    await setBytes(s.id, PUB + EDGE);
    const out = await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { title: "x" });
    assert.equal(out.status, 402, JSON.stringify(out.body));
    assert.equal((await counters(s.id)).tasks, 0);
    await setBytes(s.id, PUB + EDGE - 10);
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { title: "x" }), 201);
    assert.equal((await counters(s.id)).tasks, 1);
  });

  test("a batch of tasks that crosses only together is refused whole", async () => {
    const s = await space();
    // 6 bytes each stays under; the two together, 12, cross.
    await setBytes(s.id, PUB + EDGE - 10);
    const out = await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { tasks: [{ title: "abcdef" }, { title: "ghijkl" }] });
    assert.equal(out.status, 402, JSON.stringify(out.body));
    assert.equal((await counters(s.id)).tasks, 0);
    ok(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { tasks: [{ title: "abcdef" }] }), 201);
  });

  test("an attachment that would cross is refused, after its POST's own bytes stayed under", async () => {
    const s = await space();
    const file = "f".repeat(10_000);
    ok(await put(`Bearer ${owner.token}`, s, file), 201);
    await setBytes(s.id, PUB - 2000);
    const out = await post(owner, s, { attachments: [entry(file)] });
    assert.equal(out.status, 402, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "CREDIT_NEEDED");
    assert.deepEqual(await counters(s.id), { posts: PUB - 2000, tasks: 0, files: 0 });
    ok(await post(owner, s), 201);
  });

  test("a SPACE made with tasks, or forked with a document, over its allowance at zero is refused whole, and its name stays free", async () => {
    const origin = await space({ oracle: true });
    ok(await post(owner, origin, { kind: "version", body: `# Big\n\n${"d".repeat(12_000)}` }), 201);
    // A small allowance for this test alone: no create through the routes can hold 1 MB.
    await fixture.owner.unsafe(`CREATE OR REPLACE FUNCTION schellingaf.billing_rates()
      RETURNS TABLE (micro_usd_per_gb_month bigint, days_per_month integer, bytes_per_gb bigint,
                     public_bytes bigint, private_bytes bigint, sealed_bytes bigint)
      LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
      AS $$ SELECT 5000000::bigint, 30, 1000000000::bigint, 1000::bigint, 1000::bigint, 1000::bigint $$`);
    // A service on new connections: a session that planned the rates before keeps them.
    const fresh = openDb(config);
    const on = createApp(config, fresh);
    const as = async (who: Agent, method: string, path: string, payload?: unknown) => {
      await refill(who);
      return call(method, path, who.token, payload, on);
    };
    try {
      const name = newName();
      const tasks = Array.from({ length: 10 }, (_, i) => ({ title: `Task ${i}`, body: "t".repeat(1000) }));
      const made = await as(owner, "POST", "/v1/spaces", { name, title: "Too much", visibility: "public", tasks });
      assert.equal(made.status, 402, JSON.stringify(made.body));
      assert.equal(made.body.error.code, "CREDIT_NEEDED");
      assert.equal((await call("GET", `/v1/spaces/${name}`)).status, 404);

      const fork = newName();
      const forked = await as(owner, "POST", `/v1/spaces/${origin.name}/fork`, { name: fork });
      assert.equal(forked.status, 402, JSON.stringify(forked.body));
      assert.equal(forked.body.error.code, "CREDIT_NEEDED");
      assert.equal((await call("GET", `/v1/spaces/${fork}`)).status, 404);

      ok(await as(owner, "POST", "/v1/spaces", { name, title: "Empty", visibility: "public" }), 201);
    } finally {
      await fresh.end();
      await fixture.owner.unsafe(`CREATE OR REPLACE FUNCTION schellingaf.billing_rates()
        RETURNS TABLE (micro_usd_per_gb_month bigint, days_per_month integer, bytes_per_gb bigint,
                       public_bytes bigint, private_bytes bigint, sealed_bytes bigint)
        LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
        AS $$ SELECT 5000000::bigint, 30, 1000000000::bigint, 25000000::bigint, 10000000::bigint, 1000000::bigint $$`);
    }
    const [r] = await fixture.api<{ pub: string }[]>`select public_bytes::text as pub from schellingaf.billing_rates()`;
    assert.equal(Number(r!.pub), PUB, "the rates are back");
  });
});

describe("when a balance opens it", () => {
  test("frozen and short: a deposit below one day still refuses; one covering a day allows at once", async () => {
    const s = await space();
    await fixture.owner`update schellingaf.spaces set created_at = '2026-01-01' where space_id = ${s.id}::uuid`;
    await setBytes(s.id, PUB + OVER);
    await fixture.api`select * from schellingaf.billing_day_begin('2026-09-02')`;
    const [b] = await fixture.api<{ state: string }[]>`select state from schellingaf.bill_space_day(${s.id}::uuid, '2026-09-02'::date)`;
    assert.equal(b!.state, "short");
    await deposit(s.id, 999);
    refused(await post(owner, s), s.name);
    await deposit(s.id, 1);
    ok(await post(owner, s), 201);
  });

  test("not frozen, with a balance above 0 and below a day: allowed until a bill freezes it", async () => {
    const s = await space();
    await setBytes(s.id, PUB + OVER);
    await deposit(s.id, 500);
    ok(await post(owner, s), 201);
  });

  test("free days, under the allowance, withheld, the switch on shadow, and before real_from: allowed", async () => {
    const free = await space();
    await setBytes(free.id, PUB + OVER);
    await fixture.owner`insert into schellingaf.space_credit (space_id, free_until) values (${free.id}::uuid, '2099-01-01')`;
    ok(await post(owner, free), 201);

    const under = await space();
    await setBytes(under.id, PUB - 1);
    ok(await post(owner, under), 201);

    const withheld = await space();
    await setBytes(withheld.id, PUB + OVER);
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${withheld.id}::uuid, 'abuse', 'a test')`;
    const [w] = await fixture.api<{ r: string | null }[]>`select schellingaf.credit_refusal(${withheld.id}::uuid, 0) as r`;
    assert.equal(w!.r, null);

    const s = await space();
    await setBytes(s.id, PUB + OVER);
    refused(await post(owner, s), s.name);
    await fixture.api`select * from schellingaf.billing_set_mode('shadow')`;
    try {
      ok(await post(owner, s), 201);
    } finally {
      await fixture.api`select * from schellingaf.billing_set_mode('real')`;
    }
    refused(await post(owner, s), s.name);
    await fixture.owner`update schellingaf.billing_epoch set real_from = '2099-01-01'`;
    try {
      ok(await post(owner, s), 201);
    } finally {
      await live();
    }
  });

  test("hiding posts below the allowance opens it at once", async () => {
    const s = await space();
    const w = await agent();
    await grant(s, w, "writer");
    const big = await post(w, s, { body: `${"x".repeat(8000)} ${randomUUID()}` });
    ok(big, 201);
    const { posts } = await counters(s.id);
    await setBytes(s.id, PUB - 1 + posts);
    refused(await post(owner, s), s.name, /^with this write a day of storage costs \$0\.01, the balance is \$0\.00, and 30 days cost \$0\.0[1-3]\. /);
    ok(await as(owner, "PUT", `/v1/posts/${big.body.post_id}/hidden`));
    ok(await post(owner, s), 201);
  });
});

describe("who meets it", () => {
  test("a KEY with no role posting in an open public work space at zero meets the same refusal", async () => {
    const s = await space({ join_policy: "open" });
    await setBytes(s.id, PUB + OVER);
    const stranger = await agent();
    refused(await post(stranger, s), s.name);
  });

  test("a refusal is answered as it comes: CREDIT_NEEDED is no deadlock, so neither route writes it again", async () => {
    const error = Object.assign(new Error("CREDIT_NEEDED"), { code: "P0001", detail: detailOf("x") });
    assert.equal(deadlocked(error), false);
    const api = fromDatabaseError(error);
    assert.deepEqual({ code: api.code, detail: api.detail }, { code: "CREDIT_NEEDED", detail: detailOf("x") });
    const s = await space();
    await setBytes(s.id, PUB + OVER);
    refused(await as(owner, "POST", `/v1/spaces/${s.name}/tasks`, { title: "Once" }), s.name);
    refused(await post(owner, s), s.name);
  });
});

describe("a successor pays for what it replaced", () => {
  test("refused through its predecessor's due while under its own allowance; its owner and admins hide the predecessor's posts and get out", async () => {
    const pred = await space();
    const w = await agent();
    await grant(pred, w, "writer");
    const big = await post(w, pred, { body: `${"x".repeat(8000)} ${randomUUID()}` });
    ok(big, 201);
    const small = await post(w, pred);
    ok(small, 201);
    const { posts } = await counters(pred.id);
    await setBytes(pred.id, PUB - 1 + posts);
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${pred.name}, ${next}, 'a test')`;
    const succ: Space = { name: next, id: await idOf(next) };
    const admin = await agent();
    await grant(succ, admin, "admin");
    assert.equal((await counters(succ.id)).posts, 0, "the successor holds nothing of its own");

    const out = await post(owner, succ);
    assert.equal(out.status, 402, JSON.stringify(out.body));
    assert.match(out.body.error.detail, new RegExp(`^with this write a day of storage costs \\$0\\.01, the balance is \\$0\\.00, and 30 days cost \\$0\\.0[1-3]\\. Add credit: GET /v1/spaces/${next}/funding$`));

    // A writer of the successor may not; its admin may, for a post by a KEY ranked below it.
    const denied = await as(w, "PUT", `/v1/posts/${small.body.post_id}/hidden`);
    assert.equal(denied.body.error.code, "CONTROL_DENIED", JSON.stringify(denied.body));
    ok(await as(admin, "PUT", `/v1/posts/${big.body.post_id}/hidden`));
    ok(await post(owner, succ), 201);
    ok(await as(owner, "DELETE", `/v1/posts/${big.body.post_id}/hidden`));
    assert.equal((await post(owner, succ)).status, 402);
    // The owner hides it again, and the successor writes.
    ok(await as(owner, "PUT", `/v1/posts/${big.body.post_id}/hidden`));
    ok(await post(owner, succ), 201);
  });

  test("a private predecessor: an admin added to the successor after the recovery hides its posts; a KEY of neither is told no such post", async () => {
    const pred = await space({ visibility: "private" });
    const w = await agent();
    await grant(pred, w, "writer");
    const p = await post(w, pred);
    ok(p, 201);
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${pred.name}, ${next}, 'a test')`;
    const succ: Space = { name: next, id: await idOf(next) };
    const admin = await agent();
    await grant(succ, admin, "admin");
    const [member] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.memberships where space_id = ${pred.id}::uuid and peer_id = ${Buffer.from(admin.peerId, "hex")}`;
    assert.equal(member!.n, 0, "the admin is no member of the predecessor");
    ok(await as(admin, "PUT", `/v1/posts/${p.body.post_id}/hidden`));
    ok(await as(admin, "DELETE", `/v1/posts/${p.body.post_id}/hidden`));
    const stranger = await agent();
    const out = await as(stranger, "PUT", `/v1/posts/${p.body.post_id}/hidden`);
    assert.equal(out.body.error.code, "POST_NOT_FOUND", JSON.stringify(out.body));
  });

  test("a SPACE the operator closed without a successor still refuses hiding", async () => {
    const s = await space();
    const w = await agent();
    await grant(s, w, "writer");
    const p = await post(w, s);
    ok(p, 201);
    await fixture.owner`update schellingaf.spaces set status = 'closed' where space_id = ${s.id}::uuid`;
    const out = await as(owner, "PUT", `/v1/posts/${p.body.post_id}/hidden`);
    assert.equal(out.body.error.code, "SPACE_CLOSED", JSON.stringify(out.body));
  });
});

describe("privacy", () => {
  test("the api role reads the rule, and never runs the refusal, the trigger functions or credit_post()", async () => {
    await assert.rejects(fixture.api`select schellingaf.refuse_unfunded(gen_random_uuid(), 0)`, /permission denied/);
    await assert.rejects(
      fixture.api`select * from schellingaf.credit_post(gen_random_uuid(), 'deposit', 1, ${`deposit:${randomUUID()}`}, '')`,
      /permission denied/,
    );
    const fns = await fixture.owner<{ name: string; api: boolean; public: boolean }[]>`
      select p.oid::regprocedure::text as name, has_function_privilege('schellingaf_api', p.oid, 'execute') as api,
             has_function_privilege('public', p.oid, 'execute') as public
        from pg_proc p
       where p.pronamespace = 'schellingaf'::regnamespace
         and p.proname in ('usd_of_cents', 'credit_refusal', 'refuse_unfunded', 'credit_gate_row')
       order by 1`;
    assert.equal(fns.length, 4, fns.map((f) => f.name).join(", "));
    assert.deepEqual(fns.filter((f) => f.public).map((f) => f.name), []);
    assert.deepEqual(fns.filter((f) => f.api).map((f) => f.name), ["credit_refusal(uuid,bigint)"]);
    const triggers = await fixture.owner<{ name: string; table: string }[]>`
      select t.tgname as name, c.relname as table from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where t.tgfoid = 'schellingaf.credit_gate_row()'::regprocedure
       order by 1`;
    assert.deepEqual([...triggers], [
      { name: "file_uploads_credit", table: "file_uploads" },
      { name: "post_attachments_credit", table: "post_attachments" },
      { name: "post_objects_storage_credit", table: "post_objects" },
      { name: "posts_credit", table: "posts" },
      { name: "sealed_posts_storage_credit", table: "sealed_posts" },
      { name: "tasks_storage_credit_insert", table: "tasks" },
      { name: "tasks_storage_credit_update", table: "tasks" },
    ]);
  });
});
