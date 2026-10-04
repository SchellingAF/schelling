// Who decides a work space's document, what a waiting version waits for, and versions
// accepted by writers' confirmations (migrations/0138_document_decision.sql;
// proposal-document-decision, its frozen specification's section 10). Driven through the
// routes as an agent would; the database is read to check a row, or written only to set a
// scene a route cannot make.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { useService, app, db, config, fixture, call as rawCall, send, agent, connector, type Agent, type App, type Caller } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { ERRORS, fromDatabaseError, renderableDetail } from "../src/db/errors.ts";
import { ORACLE_LIMITS } from "../src/surface/vocabulary.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { verifyPostRun } from "../src/domain/verify.ts";

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("document_decision", { apiHost: "api.document-decision.test", oracleReviewer: null });

const ROLES = ["owner", "admin", "coordinator"];
// The cast every SPACE here is made with: owner O, admins A1 A2, coordinators C1 C2,
// writers W1 W2 W3, reader R, and a stranger S, who holds no role.
let O: Agent, A1: Agent, A2: Agent, C1: Agent, C2: Agent, W1: Agent, W2: Agent, W3: Agent, R: Agent, S: Agent;
let reviewer: Agent;
let reviewerApp: App;

before(async () => {
  await ready;
  const all = await Promise.all(Array.from({ length: 11 }, () => agent()));
  [O, A1, A2, C1, C2, W1, W2, W3, R, S, reviewer] = all as [Agent, Agent, Agent, Agent, Agent, Agent, Agent, Agent, Agent, Agent, Agent];
  for (const k of [O, A1, A2, C1, C2, W1, W2, W3, R, S, reviewer]) cast.set(k.token, k.peerId);
  reviewerApp = createApp({ ...config, oracleReviewer: reviewer.peerId }, db);
});

// The cast is shared by every test, so a KEY of it has its own allowances filled before
// each request it sends: what is under test is who decides, not how often a KEY may write.
const cast = new Map<string, string>();
async function call(method: string, path: string, who?: Caller, payload?: unknown, on: App = app) {
  const peer = typeof who === "string" ? cast.get(who) : undefined;
  if (peer !== undefined) {
    for (const bucket of ["peer", "ctl", "proposal", "space"]) await fixture.setBucket(`${bucket}:${peer}`, 1000);
  }
  return rawCall(method, path, who, payload, on);
}

let made = 0;
type Made = { name: string; v1: string | null };

/** A public open work space of O's that keeps a document, the cast granted, and O's
 *  first version current unless `first` is false. */
async function space(confirmations: number, extra: Record<string, unknown> = {}, first = true): Promise<Made> {
  const name = `decide-${process.pid}-${made++}`;
  await fixture.setBucket(`space:${O.peerId}`, 1000);
  const out = await call("POST", "/v1/spaces", O.token, {
    name, title: "Wen mi telegrams", visibility: "public", join_policy: "open", document: true,
    ...(confirmations > 0 ? { document_confirmations: confirmations } : {}), ...extra,
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  for (const [who, role] of [[A1, "admin"], [A2, "admin"], [C1, "coordinator"], [C2, "coordinator"],
                             [W1, "writer"], [W2, "writer"], [W3, "writer"], [R, "reader"]] as const) {
    await grant(name, who, role);
  }
  return { name, v1: first ? (await propose(O, name, null)).body.post_id : null };
}

async function grant(name: string, who: Agent, role: string): Promise<void> {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, O.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

let text = 0;
/** A version by `who`, against `supersedes`; its allowance filled first, since the cast is shared. */
async function propose(who: Agent, name: string, supersedes: string | null, extra: Record<string, unknown> = {}, via: App = app) {
  await fixture.setBucket(`proposal:${who.peerId}`, 1000);
  const out = await call("POST", `/v1/spaces/${name}/posts`, who.token,
    { kind: "version", body: `# The telegrams\n\nVersion ${text++}.`, ...(supersedes ? { supersedes } : {}), ...extra }, via);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out;
}

function go(who: Agent, name: string, version: string, extra: Record<string, unknown> = {}, kind = "go", via: App = app) {
  return call("POST", `/v1/spaces/${name}/posts`, who.token, { kind, body: `A ${kind} ${text++}.`, reply_to: version, ...extra }, via);
}

function refused(out: { status: number; body: any }, status: number, code: string, detail?: string | RegExp) {
  assert.equal(out.status, status, JSON.stringify(out.body));
  assert.equal(out.body.error.code, code, JSON.stringify(out.body));
  if (typeof detail === "string") assert.equal(out.body.error.detail, detail);
  else if (detail) assert.match(out.body.error.detail, detail);
}

const D = {
  work: (name: string) => `only the owner, an admin or a coordinator decides a version here, with go or veto: GET /v1/spaces/${name}/document names them`,
  oracle: (name: string) => `only the owner, an admin or the service reviewer decides a version here, with go or veto: GET /v1/spaces/${name}/document names them`,
  go: (name: string) => `a go on a version counts from a writer, and decides from the owner, an admin or a coordinator: GET /v1/spaces/${name}/document names them`,
  veto: (name: string) => `only the owner, an admin or a coordinator declines a version; a writer confirms with go: GET /v1/spaces/${name}/document names them`,
  stage: (name: string) => `this version sets the stage, so only the owner, an admin or a coordinator decides it: GET /v1/spaces/${name}/document names them`,
};

async function lastSeq(name: string): Promise<string> {
  const [row] = await fixture.owner<{ n: string }[]>`select last_seq::text as n from schellingaf.spaces where name = ${name}`;
  return row!.n;
}

async function versionRow(postId: string) {
  const [row] = await fixture.owner<{ state: string; confirmed_by: string[]; by_confirmations: boolean; decision: string | null }[]>`
    select v.state, array(select encode(x, 'hex') from unnest(v.confirmed_by::bytea[]) with ordinality u(x, i) order by i) as confirmed_by,
           v.by_confirmations, v.decision::text
      from schellingaf.oracle_versions v where v.post_id = ${postId}::uuid`;
  return row!;
}

const hexes = (...who: Agent[]) => who.map((k) => k.peerId);
const sorted = (...who: Agent[]) => who.map((k) => k.peerId).sort();
const full = (name: string) => ({ keys: [{ peer_id: O.peerId, role: "owner" }, ...sorted(A1, A2).map((p) => ({ peer_id: p, role: "admin" })),
                                         ...sorted(C1, C2).map((p) => ({ peer_id: p, role: "coordinator" }))], more: 0, roles: ROLES, name });

/** Members with `role` in SPACE `name`, made straight in the database: KEYS nobody signs as. */
async function crowd(name: string, role: string, count: number): Promise<void> {
  const tag = randomUUID();
  await fixture.owner`
    insert into schellingaf.peers (peer_id, public_key)
    select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(convert_to(${tag} || g, 'UTF8'))),
           sha256(convert_to(${tag} || g, 'UTF8'))
      from generate_series(1, ${count}) g`;
  await fixture.owner`
    insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
    select s.space_id, sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(convert_to(${tag} || g, 'UTF8'))),
           ${role}, 'grant', s.owner_id, 1
      from schellingaf.spaces s, generate_series(1, ${count}) g where s.name = ${name}`;
}

describe("who decides, named, and what a waiting version waits for", () => {
  test("1. nothing waiting: roles and you only; a version waiting: the KEYS in order, and you true for a decider", async () => {
    const { name, v1 } = await space(0);
    const plain = await call("GET", `/v1/spaces/${name}/document`, W1.token);
    assert.deepEqual(plain.body.deciders, { roles: ROLES, you: false });
    await propose(W1, name, v1);
    const read = await call("GET", `/v1/spaces/${name}/document`, W1.token);
    const { name: _n, ...expected } = full(name);
    assert.deepEqual(read.body.deciders, { ...expected, you: false });
    for (const decider of [C1, A1, O]) {
      assert.equal((await call("GET", `/v1/spaces/${name}/document`, decider.token)).body.deciders.you, true);
    }
  });

  test("2. a stranger and no token see the profile's contacts, never a coordinator, and anonymous reads share one ETag", async () => {
    const { name, v1 } = await space(0);
    await propose(W1, name, v1);
    const contacts = (await call("GET", `/v1/spaces/${name}`)).body.contacts;
    for (const who of [null, S.token]) {
      const read = await call("GET", `/v1/spaces/${name}/document`, who);
      assert.deepEqual(read.body.deciders.keys, contacts);
      assert.equal(read.body.deciders.more, null);
      assert.equal(read.body.deciders.you, false);
      const body = JSON.stringify(read.body);
      for (const c of [C1, C2]) assert.ok(!body.includes(c.peerId), "a coordinator reached a non-member");
    }
    const one = await send(app, "GET", `/v1/spaces/${name}/document`, null);
    const two = await send(app, "GET", `/v1/spaces/${name}/document`, null);
    assert.ok(one.headers.get("etag"));
    assert.equal(one.headers.get("etag"), two.headers.get("etag"));
    assert.match(one.headers.get("cache-control") ?? "", /public/);
  });

  test("3. a proposal's receipt says what it waits for and who decides, by who may see them; a replay still pending too", async () => {
    const { name, v1 } = await space(0);
    const stranger = await propose(S, name, v1);
    assert.equal(stranger.body.oracle.state, "pending");
    assert.deepEqual(stranger.body.oracle.waits_for, { decision: ROLES });
    assert.equal(stranger.body.oracle.deciders.more, null);
    for (const c of [C1, C2]) assert.ok(!JSON.stringify(stranger.body).includes(c.peerId));
    const key = `w1-${randomUUID()}`;
    const body = { kind: "version", body: "# The telegrams\n\nW1's.", supersedes: v1, idempotency_key: key };
    await fixture.setBucket(`proposal:${W1.peerId}`, 1000);
    const member = await call("POST", `/v1/spaces/${name}/posts`, W1.token, body);
    assert.equal(member.status, 201, JSON.stringify(member.body));
    const { name: _n, ...expected } = full(name);
    assert.deepEqual(member.body.oracle.deciders, { ...expected, you: false });
    const again = await call("POST", `/v1/spaces/${name}/posts`, W1.token, body);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.oracle.waits_for, { decision: ROLES });
    const owners = await propose(O, name, v1);
    assert.deepEqual(owners.body.oracle, { state: "current" });
  });

  test("3b. the deciders read failing after the write commits: the receipt answers without deciders, and the version stands", async (t) => {
    const { name, v1 } = await space(0);
    const errors = t.mock.method(console, "error", () => {});
    const failing = createApp(config, {
      ...db,
      readTx: (peer, fn) => db.readTx(peer, (sql) => fn(new Proxy(sql, {
        apply(target, self, args) {
          if (Array.isArray(args[0]) && args[0].join("").includes("document_deciders")) throw new Error("forced: deciders not read");
          return Reflect.apply(target, self, args);
        },
      }))),
    } as typeof db);
    const out = await propose(W1, name, v1, {}, failing);
    assert.equal(out.body.oracle.state, "pending");
    assert.deepEqual(out.body.oracle.waits_for, { decision: ROLES });
    assert.equal(out.body.oracle.deciders, undefined);
    assert.equal((await versionRow(out.body.post_id)).state, "pending");
    assert.equal(errors.mock.calls.filter((c) => String(c.arguments[0]).includes("deciders not read")).length, 1);
  });

  test("4. the versions list: the full block once, with nothing waiting too; waits_for on pending items alone", async () => {
    const { name, v1 } = await space(0);
    const quiet = await call("GET", `/v1/spaces/${name}/versions`, W1.token);
    const { name: _n, ...expected } = full(name);
    assert.deepEqual(quiet.body.deciders, { ...expected, you: false });
    const p1 = (await propose(W1, name, v1)).body.post_id;
    assert.equal((await go(C1, name, p1, {}, "veto")).status, 201);
    const p2 = (await propose(W2, name, v1)).body.post_id;
    await propose(W3, name, v1);
    assert.equal((await go(C1, name, p2)).status, 201);
    await propose(W1, name, p2);
    const list = await call("GET", `/v1/spaces/${name}/versions`, W1.token);
    assert.deepEqual(list.body.items.map((i: any) => i.state), ["pending", "out_of_date", "current", "declined", "replaced"]);
    for (const item of list.body.items) {
      if (item.state === "pending") assert.deepEqual(item.waits_for, { decision: ROLES });
      else assert.equal(item.waits_for, undefined, item.state);
    }
  });

  test("5. version=N of a pending version carries waits_for and the full block", async () => {
    const { name, v1 } = await space(0);
    const p = await propose(W1, name, v1);
    const read = await call("GET", `/v1/spaces/${name}/document?version=${p.body.seq}`, W2.token);
    assert.equal(read.body.version.state, "pending");
    assert.deepEqual(read.body.version.waits_for, { decision: ROLES });
    assert.equal(read.body.deciders.keys.length, 5);
  });

  test("6. no version current: one waiting says so and gives the full block; none waiting keeps today's notice", async () => {
    const { name } = await space(0, {}, false);
    const none = await call("GET", `/v1/spaces/${name}/document`, W1.token);
    assert.equal(none.body.notice, `This document has no version yet. Propose the first with POST /v1/spaces/${name}/posts, kind version and no supersedes.`);
    assert.deepEqual(none.body.deciders, { roles: ROLES, you: false });
    await propose(W1, name, null);
    const one = await call("GET", `/v1/spaces/${name}/document`, W1.token);
    assert.equal(one.body.version, null);
    assert.equal(one.body.deciders.keys.length, 5);
    assert.equal(one.body.notice,
      `No version is current yet. 1 proposal(s) wait for a decision. Read them with GET /v1/spaces/${name}/versions?state=pending before you propose.`);
  });

  test("8. an oracle space: the reviewer second where it decides, once if it is an admin, and more counts admins alone", async () => {
    const name = `oracle-decide-${process.pid}-${made++}`;
    assert.equal((await call("POST", "/v1/spaces", O.token, { name, title: "An oracle", oracle: true })).status, 201);
    await grant(name, A1, "admin");
    const v1 = (await propose(O, name, null, {}, reviewerApp)).body.post_id;
    await propose(W1, name, v1, {}, reviewerApp);
    const read = await call("GET", `/v1/spaces/${name}/document`, W1.token, undefined, reviewerApp);
    assert.deepEqual(read.body.deciders.roles, ["owner", "admin", "reviewer"]);
    assert.deepEqual(read.body.deciders.keys[1], { peer_id: reviewer.peerId, role: "reviewer" });
    assert.equal((await call("GET", `/v1/spaces/${name}/document`, reviewer.token, undefined, reviewerApp)).body.deciders.you, true);
    // The reviewer an admin as well: listed once, as the reviewer.
    await grant(name, reviewer, "admin");
    const once = (await call("GET", `/v1/spaces/${name}/document`, O.token, undefined, reviewerApp)).body.deciders;
    assert.equal(once.keys.filter((k: any) => k.peer_id === reviewer.peerId).length, 1);
    assert.equal(once.keys.find((k: any) => k.peer_id === reviewer.peerId).role, "reviewer");
    // Off: no reviewer item, and no reviewer among the roles.
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, O.token, { service_reviewer: false })).status, 200);
    const off = (await call("GET", `/v1/spaces/${name}/document`, O.token, undefined, reviewerApp)).body.deciders;
    assert.deepEqual(off.roles, ["owner", "admin"]);
    assert.ok(!off.keys.some((k: any) => k.role === "reviewer"));
    // 25 admins more, and coordinators, who decide nothing here.
    await crowd(name, "admin", 25);
    await crowd(name, "coordinator", 3);
    const many = (await call("GET", `/v1/spaces/${name}/document`, O.token, undefined, reviewerApp)).body.deciders;
    assert.equal(many.keys.length, 21);
    assert.ok(many.keys.every((k: any) => k.role !== "coordinator"));
    assert.equal(many.more, 7, "27 admins, 20 shown");
  });

  test("9. at the cap: 20 admins and coordinators, more counted, the block within its bytes; a stranger sees at most 10", async () => {
    const { name, v1 } = await space(0);
    await crowd(name, "coordinator", 25);
    await crowd(name, "admin", 10);
    await propose(W1, name, v1);
    const member = (await call("GET", `/v1/spaces/${name}/versions`, W1.token)).body.deciders;
    assert.equal(member.keys.length, 21);
    assert.equal(member.more, 12 + 27 - 20, "12 admins and 27 coordinators, 20 shown");
    assert.ok(JSON.stringify(member).length <= 2304, String(JSON.stringify(member).length));
    // The longest block there is: the owner and 20 coordinators.
    const { name: coordinated } = await space(0, {}, true);
    await crowd(coordinated, "coordinator", 30);
    await fixture.owner`delete from schellingaf.memberships m using schellingaf.spaces s
                         where s.space_id = m.space_id and s.name = ${coordinated} and m.role = 'admin'`;
    const longest = (await call("GET", `/v1/spaces/${coordinated}/versions`, W1.token)).body.deciders;
    assert.equal(longest.keys.length, 21);
    assert.ok(JSON.stringify(longest).length <= 2304, String(JSON.stringify(longest).length));
    const stranger = (await call("GET", `/v1/spaces/${name}/versions`, S.token)).body.deciders;
    assert.ok(stranger.keys.length <= 10, String(stranger.keys.length));
  });

  test("10. a withheld SPACE: READ_DENIED, and document_deciders() answers nothing", async () => {
    const { name, v1 } = await space(0);
    await propose(W1, name, v1);
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select s.space_id, 'abuse', 'a test' from schellingaf.spaces s where s.name = ${name}`;
    refused(await call("GET", `/v1/spaces/${name}/document`, O.token), 403, "READ_DENIED");
    const [row] = await fixture.asCaller(O.peerId, (sql) => sql<{ d: unknown }[]>`
      select schellingaf.document_deciders(s.space_id, null, true) as d from schellingaf.spaces s where s.name = ${name}`);
    assert.equal(row!.d, null);
  });
});

describe("confirmations", () => {
  test("13. at 0 a writer's go is refused as on main, with the new detail, and nothing is posted", async () => {
    const { name, v1 } = await space(0);
    const p = (await propose(W2, name, v1)).body.post_id;
    const before = await lastSeq(name);
    const out = await go(W1, name, p);
    refused(out, 403, "CONTROL_DENIED", D.work(name));
    assert.equal(out.body.error.message, ERRORS.CONTROL_DENIED!.message);
    assert.equal(out.body.error.fix, ERRORS.CONTROL_DENIED!.fix);
    assert.equal(await lastSeq(name), before);
  });

  test("15. at 2: a writer's go counts, a second makes the version current, and every read says by confirmations", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W3, name, v1)).body.post_id;
    const first = await go(W1, name, p);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body.oracle, { confirmed: p, confirmations: { given: hexes(W1), required: 2 } });
    assert.deepEqual(await versionRow(p), { state: "pending", confirmed_by: hexes(W1), by_confirmations: false, decision: null });
    const second = await go(W2, name, p);
    assert.deepEqual(second.body.oracle, { decided: "approved", version: p, by: "confirmations", confirmations: { given: hexes(W1, W2), required: 2 } });
    assert.deepEqual(await versionRow(p), { state: "current", confirmed_by: hexes(W1, W2), by_confirmations: true, decision: second.body.post_id });
    const read = await call("GET", `/v1/spaces/${name}/document`, S.token);
    assert.equal(read.body.version.decided_by.post_id, second.body.post_id);
    assert.equal(read.body.version.decided_by.by, "confirmations");
    assert.deepEqual(read.body.version.decided_by.confirmed_by, hexes(W1, W2));
    const list = await call("GET", `/v1/spaces/${name}/versions`, S.token);
    assert.equal(list.body.items[0].decision.by, "confirmations");
    assert.deepEqual(list.body.items[0].decision.confirmed_by, hexes(W1, W2));
  });

  test("16. at the count every other waiting version goes out of date, its author told, and the proposer hears each go", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W1, name, v1)).body.post_id;
    const q = (await propose(S, name, v1)).body.post_id;
    const a = await go(W2, name, p);
    const b = await go(W3, name, p);
    assert.equal(b.body.oracle.decided, "approved");
    assert.equal((await versionRow(q)).state, "out_of_date");
    const stale = await call("GET", "/v1/mailbox?reason=out_of_date", S.token);
    assert.ok(stale.body.items.some((i: any) => i.post?.post_id === p), JSON.stringify(stale.body));
    const replies = await call("GET", "/v1/mailbox?reason=reply", W1.token);
    for (const g of [a, b]) assert.ok(replies.body.items.some((i: any) => i.post?.post_id === g.body.post_id));
  });

  test("17. ten fresh KEYS with no role are refused, not posted, and the version still waits", async () => {
    const { name, v1 } = await space(1);
    const p = (await propose(W1, name, v1)).body.post_id;
    const before = await lastSeq(name);
    for (const fresh of await Promise.all(Array.from({ length: 10 }, () => agent()))) {
      refused(await go(fresh, name, p), 403, "CONTROL_DENIED", D.go(name));
    }
    assert.equal(await lastSeq(name), before);
    assert.equal((await versionRow(p)).state, "pending");
  });

  test("18. a reader, who posts in the open SPACE unmarked, is refused the same", async () => {
    const { name, v1 } = await space(1);
    const p = (await propose(W1, name, v1)).body.post_id;
    refused(await go(R, name, p), 403, "CONTROL_DENIED", D.go(name));
  });

  test("19. 20. its author cannot confirm it; nobody confirms twice, and the same go again is a replay", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W1, name, v1)).body.post_id;
    refused(await go(W1, name, p), 409, "PROPOSAL_SELF_CONFIRM");
    const key = `confirm-${randomUUID()}`;
    const body = { kind: "go", body: "It holds.", reply_to: p, idempotency_key: key };
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, W2.token, body)).status, 201);
    refused(await go(W2, name, p, { idempotency_key: `other-${randomUUID()}` }), 409, "PROPOSAL_ALREADY_CONFIRMED");
    const again = await call("POST", `/v1/spaces/${name}/posts`, W2.token, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.oracle, { confirmed: p, confirmations: { given: hexes(W2), required: 2 } });
  });

  test("21. the confirmation that reached the count, replayed, says it decided by confirmations", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W1, name, v1)).body.post_id;
    await go(W2, name, p);
    const body = { kind: "go", body: "It holds too.", reply_to: p, idempotency_key: `nth-${randomUUID()}` };
    const nth = await call("POST", `/v1/spaces/${name}/posts`, W3.token, body);
    assert.equal(nth.body.oracle.decided, "approved");
    const again = await call("POST", `/v1/spaces/${name}/posts`, W3.token, body);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.oracle, { decided: "approved", version: p, by: "confirmations", confirmations: { given: hexes(W2, W3), required: 2 } });
    // The setting moved since: the replay still names the count at the decision.
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, O.token, { document_confirmations: 5 })).status, 200);
    const later = await call("POST", `/v1/spaces/${name}/posts`, W3.token, body);
    assert.equal(later.body.replayed, true);
    assert.deepEqual(later.body.oracle.confirmations, { given: hexes(W2, W3), required: 2 });
  });

  test("22. 23. a writer's veto is refused; a go on a version decided already is PROPOSAL_DECIDED with its state", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W1, name, v1)).body.post_id;
    refused(await go(W2, name, p, {}, "veto"), 403, "CONTROL_DENIED", D.veto(name));
    const declined = (await propose(W1, name, v1)).body.post_id;
    await go(C1, name, declined, {}, "veto");
    refused(await go(W2, name, declined), 409, "PROPOSAL_DECIDED", "declined");
    const q = (await propose(W3, name, v1)).body.post_id;
    await go(C1, name, p);
    refused(await go(W2, name, q), 409, "PROPOSAL_DECIDED", "out_of_date");
    refused(await go(W2, name, p), 409, "PROPOSAL_DECIDED", "current");
  });

  test("24. two writers' go at one short of the count, released together, 20 rounds: one decides, one is PROPOSAL_DECIDED", async () => {
    const { name, v1 } = await space(2);
    let at = v1!;
    for (let round = 0; round < 20; round++) {
      const p = (await propose(R, name, at)).body.post_id;
      assert.equal((await go(W1, name, p)).status, 201);
      const both = await Promise.all([go(W2, name, p), go(W3, name, p)]);
      const won = both.filter((o) => o.status === 201);
      const lost = both.filter((o) => o.status !== 201);
      assert.equal(won.length, 1, JSON.stringify(both.map((o) => o.body)));
      refused(lost[0]!, 409, "PROPOSAL_DECIDED", "current");
      const row = await versionRow(p);
      assert.deepEqual([row.state, row.by_confirmations, row.decision, row.confirmed_by.length, row.confirmed_by[0]],
        ["current", true, won[0]!.body.post_id, 2, W1.peerId]);
      at = p;
    }
    const [gaps] = await fixture.owner<{ n: number; last: string }[]>`
      select count(*)::int as n, max(p.seq)::text as last from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
       where s.name = ${name}`;
    assert.equal(String(gaps!.n), gaps!.last, "seqs have a gap");
    assert.equal(gaps!.last, await lastSeq(name));
  });

  test("25. a decider's veto and the go that reaches the count, released together, 20 rounds: one end state", async () => {
    const { name, v1 } = await space(2);
    let at = v1!;
    for (let round = 0; round < 20; round++) {
      const p = (await propose(R, name, at)).body.post_id;
      assert.equal((await go(W1, name, p)).status, 201);
      const [veto, nth] = await Promise.all([go(C1, name, p, {}, "veto"), go(W2, name, p)]);
      const state = (await versionRow(p)).state;
      if (state === "current") {
        assert.equal(nth.status, 201);
        refused(veto, 409, "PROPOSAL_DECIDED", "current");
        at = p;
      } else {
        assert.equal(state, "declined");
        assert.equal(veto.status, 201);
        refused(nth, 409, "PROPOSAL_DECIDED", "declined");
      }
    }
  });

  test("26. a decider's go on a version holding 1 of 2 decides at once, and the confirmation stays on the row", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W1, name, v1)).body.post_id;
    await go(W2, name, p);
    const decided = await go(C1, name, p);
    assert.deepEqual(decided.body.oracle, { decided: "approved", version: p });
    assert.deepEqual(await versionRow(p), { state: "current", confirmed_by: hexes(W2), by_confirmations: false, decision: decided.body.post_id });
    const read = await call("GET", `/v1/spaces/${name}/document`, W1.token);
    assert.equal(read.body.version.decided_by.by, undefined);
  });

  test("27. lowered beside two confirmations, the next go decides; raised beside a go, the go is judged by the count it locked under", async () => {
    const { name, v1 } = await space(3);
    const p = (await propose(W1, name, v1)).body.post_id;
    await go(W2, name, p);
    await go(W3, name, p);
    assert.equal((await call("PATCH", `/v1/spaces/${name}`, O.token, { document_confirmations: 1 })).status, 200);
    assert.equal((await versionRow(p)).state, "pending", "lowering makes nothing current by itself");
    // A writer who has not confirmed it yet: the reader, made one for this.
    await grant(name, R, "writer");
    const body = { kind: "go", body: "It holds at one.", reply_to: p, idempotency_key: `low-${randomUUID()}` };
    const nth = await call("POST", `/v1/spaces/${name}/posts`, R.token, body);
    assert.equal(nth.body.oracle.decided, "approved");
    // The count at the decision, 3 KEYS, not the setting of 1 it met.
    assert.deepEqual(nth.body.oracle.confirmations, { given: hexes(W2, W3, R), required: 3 });
    // The same post resent answers the same required.
    const again = await call("POST", `/v1/spaces/${name}/posts`, R.token, body);
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.oracle, nth.body.oracle);
    await grant(name, R, "reader");

    for (let round = 0; round < 5; round++) {
      const { name: raced, v1: at } = await space(1);
      const r = (await propose(W1, raced, at)).body.post_id;
      const [g, patch] = await Promise.all([go(W2, raced, r), call("PATCH", `/v1/spaces/${raced}`, O.token, { document_confirmations: 3 })]);
      assert.equal(patch.status, 200);
      assert.equal(g.status, 201, JSON.stringify(g.body));
      if (g.body.oracle.decided) {
        assert.equal(g.body.oracle.confirmations.required, 1);
        assert.equal((await versionRow(r)).state, "current");
      } else {
        assert.deepEqual(g.body.oracle.confirmations, { given: hexes(W2), required: 3 });
        assert.equal((await versionRow(r)).state, "pending");
      }
    }
  });

  test("28. a confirmation counts while its author ranks writer: demoted or removed it stops counting; promoted, its go decides", async () => {
    for (const leave of ["demote", "remove"]) {
      const { name, v1 } = await space(2);
      const q = (await propose(R, name, v1)).body.post_id;
      await go(W1, name, q);
      if (leave === "demote") await grant(name, W1, "reader");
      else assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${W1.peerId}`, O.token)).status, 200);
      const list = await call("GET", `/v1/spaces/${name}/versions?state=pending`, S.token);
      assert.deepEqual(list.body.items[0].waits_for.confirmations, { given: [], required: 2 }, leave);
      const second = await go(W2, name, q);
      assert.deepEqual(second.body.oracle.confirmations, { given: hexes(W2), required: 2 }, leave);
      assert.deepEqual((await versionRow(q)).confirmed_by, hexes(W2));
      const third = await go(W3, name, q);
      assert.equal(third.body.oracle.decided, "approved", leave);
      // Made current, it stays current whoever is demoted after.
      await grant(name, W3, "reader");
      assert.equal((await versionRow(q)).state, "current");
      await grant(name, W1, "writer");
      await grant(name, W3, "writer");
    }
    // Promoted to coordinator after confirming, its go is a decider's.
    const { name, v1 } = await space(2);
    const q = (await propose(R, name, v1)).body.post_id;
    await go(W1, name, q);
    await grant(name, W1, "coordinator");
    const decided = await go(W1, name, q);
    assert.deepEqual(decided.body.oracle, { decided: "approved", version: q });
    assert.equal((await versionRow(q)).by_confirmations, false);
    assert.equal((await call("GET", `/v1/spaces/${name}/document`, S.token)).body.version.decided_by.by, undefined);
  });

  test("28b. demoted and restored before another confirmation, its go still counts and it may not confirm again; written out, it may", async () => {
    // (a) Never written out: its first go still counts, a second is PROPOSAL_ALREADY_CONFIRMED.
    const a = await space(3);
    const p = (await propose(R, a.name, a.v1)).body.post_id;
    await go(W1, a.name, p);
    await grant(a.name, W1, "reader");
    await grant(a.name, W1, "writer");
    refused(await go(W1, a.name, p), 409, "PROPOSAL_ALREADY_CONFIRMED");
    const counted = await go(W2, a.name, p);
    assert.deepEqual(counted.body.oracle.confirmations, { given: hexes(W1, W2), required: 3 });
    // (b) Written out by another's confirmation while demoted: restored, it confirms again and counts.
    const b = await space(3);
    const q = (await propose(R, b.name, b.v1)).body.post_id;
    await go(W1, b.name, q);
    await grant(b.name, W1, "reader");
    await go(W2, b.name, q);
    assert.deepEqual((await versionRow(q)).confirmed_by, hexes(W2));
    await grant(b.name, W1, "writer");
    const again = await go(W1, b.name, q);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.deepEqual(again.body.oracle.confirmations, { given: hexes(W2, W1), required: 3 });
    const third = await go(W3, b.name, q);
    assert.deepEqual(third.body.oracle.confirmations, { given: hexes(W2, W1, W3), required: 3 });
    assert.equal(third.body.oracle.decided, "approved");
  });

  test("28c. a confirmer blocked in the SPACE or by the operator stops counting; unblocked, it counts again only while its go is still in the list", async () => {
    const pending = async (name: string) =>
      (await call("GET", `/v1/spaces/${name}/versions?state=pending`, S.token)).body.items[0].waits_for.confirmations;
    const block = async (name: string, who: Agent, on: boolean) => {
      const out = await call(on ? "PUT" : "DELETE", `/v1/spaces/${name}/blocks/${who.peerId}`, O.token);
      assert.equal(out.status, 200, JSON.stringify(out.body));
    };
    const operator = async (who: Agent, on: boolean) => {
      await fixture.owner`update schellingaf.peers set blocked_at = ${on ? new Date() : null}
                           where peer_id = decode(${who.peerId}, 'hex')`;
    };
    for (const by of ["space", "operator"] as const) {
      const set = (name: string, who: Agent, on: boolean) => (by === "space" ? block(name, who, on) : operator(who, on));
      // (a) Unblocked before another confirmation: its go was never written out, so it counts again.
      const a = await space(3);
      const k = await agent();
      cast.set(k.token, k.peerId);
      await grant(a.name, k, "writer");
      const p = (await propose(R, a.name, a.v1)).body.post_id;
      await go(k, a.name, p);
      await set(a.name, k, true);
      assert.deepEqual(await pending(a.name), { given: [], required: 3 }, by);
      await set(a.name, k, false);
      assert.deepEqual(await pending(a.name), { given: hexes(k), required: 3 }, by);
      const counted = await go(W1, a.name, p);
      assert.deepEqual(counted.body.oracle.confirmations, { given: hexes(k, W1), required: 3 }, by);
      // (b) Written out by another's confirmation while blocked: unblocked, it counts only once it confirms again.
      const b = await space(3);
      await grant(b.name, k, "writer");
      const q = (await propose(R, b.name, b.v1)).body.post_id;
      await go(k, b.name, q);
      await set(b.name, k, true);
      const second = await go(W1, b.name, q);
      assert.deepEqual(second.body.oracle.confirmations, { given: hexes(W1), required: 3 }, by);
      assert.deepEqual((await versionRow(q)).confirmed_by, hexes(W1), by);
      await set(b.name, k, false);
      assert.deepEqual(await pending(b.name), { given: hexes(W1), required: 3 }, by);
      const again = await go(k, b.name, q);
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.deepEqual(again.body.oracle.confirmations, { given: hexes(W1, k), required: 3 }, by);
      assert.equal((await versionRow(q)).state, "pending", by);
    }
  });

  test("29. a version that sets the stage waits for a decider: a writer's go is refused, and a coordinator's sets it", async () => {
    const { name, v1 } = await space(1);
    const p = await propose(W1, name, v1, { data: { stage: { word: "merged", note: "All pages in." } } });
    assert.deepEqual(p.body.oracle.waits_for, { decision: ROLES }, "no confirmations for a staged version");
    refused(await go(W2, name, p.body.post_id), 403, "CONTROL_DENIED", D.stage(name));
    const set = await go(C1, name, p.body.post_id);
    assert.equal(set.body.oracle.decided, "approved");
    assert.equal(set.body.stage_set.word, "merged");
  });

  test("30. a signed-only SPACE: an unsigned confirmation is refused, a signed one counts, and the chain verifies", async () => {
    const { name } = await space(1, { signed_only: true }, false);
    const [s] = await fixture.owner<{ space_id: string }[]>`select space_id::text from schellingaf.spaces where name = ${name}`;
    const signed = async (who: Agent, fields: Record<string, unknown>) => {
      const built = buildPostObject({
        spaceId: s!.space_id, author: who.peerId, idempotencyKey: `k-${randomUUID()}`, kind: "obs", title: null, body: "",
        to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
        ...fields,
      } as never);
      await fixture.setBucket(`proposal:${who.peerId}`, 1000);
      return call("POST", `/v1/spaces/${name}/posts`, who.token, {
        alg: "ed25519", canonical: built.canonical.toString("base64url"),
        ...(built.private ? { private: built.private.toString("base64url") } : {}),
        signature: sign(null, signaturePreimageOf(built.objectId), who.privateKey).toString("hex"),
      });
    };
    const v1 = await signed(O, { kind: "version", title: "First", body: "# Signed\n\nOne." });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    const p = await signed(W1, { kind: "version", title: "Second", body: "# Signed\n\nTwo.", supersedes: v1.body.post_id });
    assert.equal(p.body.oracle.state, "pending", JSON.stringify(p.body));
    refused(await go(W2, name, p.body.post_id), 403, "SIGNATURE_REQUIRED");
    const counted = await signed(W2, { kind: "go", body: "It holds.", replyTo: p.body.post_id });
    assert.equal(counted.status, 201, JSON.stringify(counted.body));
    assert.equal(counted.body.oracle.decided, "approved");
    const res = await send(app, "GET", `/v1/spaces/${name}/posts`, O.token, undefined, { accept: "application/x-ndjson" });
    const posts = (await res.text()).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.cursor === undefined);
    assert.deepEqual(verifyPostRun(posts, { rpId: "api.document-decision.test", origins: [] }, null), []);
  });

  test("31. a dry run of a writer's go answers as for any POST and counts nothing", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W1, name, v1)).body.post_id;
    const dry = await go(W2, name, p, { dry_run: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.dry_run, true);
    assert.deepEqual((await versionRow(p)).confirmed_by, []);
  });
});

describe("the setting", () => {
  test("32. PATCH: the owner or an admin, a whole number 0 to 5, a work space's document; one event; the profile says it", async () => {
    const { name } = await space(0);
    refused(await call("PATCH", `/v1/spaces/${name}`, C1.token, { document_confirmations: 2 }), 403, "CONTROL_DENIED", O.peerId);
    for (const bad of [6, -1, 1.5, "2"]) {
      refused(await call("PATCH", `/v1/spaces/${name}`, O.token, { document_confirmations: bad }), 400, "INVALID_REQUEST",
        "document_confirmations is a whole number from 0 to 5");
    }
    const oracle = `oracle-setting-${process.pid}-${made++}`;
    assert.equal((await call("POST", "/v1/spaces", O.token, { name: oracle, title: "An oracle", oracle: true })).status, 201);
    refused(await call("PATCH", `/v1/spaces/${oracle}`, O.token, { document_confirmations: 1 }), 400, "INVALID_REQUEST",
      "document_confirmations is a setting of a work space document: an oracle space is decided by its owner, an admin or the service reviewer");
    const plain = `plain-setting-${process.pid}-${made++}`;
    assert.equal((await call("POST", "/v1/spaces", O.token, { name: plain, title: "Plain" })).status, 201);
    refused(await call("PATCH", `/v1/spaces/${plain}`, O.token, { document_confirmations: 2 }), 400, "INVALID_REQUEST",
      "document_confirmations needs a document: send document true with it");
    assert.equal((await call("PATCH", `/v1/spaces/${plain}`, O.token, { document_confirmations: 0 })).body.changed, false);
    const both = await call("PATCH", `/v1/spaces/${plain}`, O.token, { document: true, document_confirmations: 2 });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.equal(both.body.document_confirmations, 2);
    // An admin who also sends an owner's field changes nothing.
    await grant(name, A1, "admin");
    refused(await call("PATCH", `/v1/spaces/${name}`, A1.token, { document_confirmations: 2, title: "renamed" }), 403, "CONTROL_DENIED");
    assert.equal((await call("GET", `/v1/spaces/${name}`)).body.document_confirmations, 0);
    const set = await call("PATCH", `/v1/spaces/${name}`, A1.token, { document_confirmations: 2 });
    assert.deepEqual([set.status, set.body.changed, set.body.document_confirmations], [200, true, 2]);
    const events = async () => (await call("GET", `/v1/spaces/${name}/events`, O.token)).body.items as { event: string; payload: any }[];
    const after = await events();
    assert.deepEqual(after.filter((e) => e.payload.document_confirmations !== undefined).map((e) => [e.event, e.payload]),
      [["space.updated", { document_confirmations: 2 }]]);
    const same = await call("PATCH", `/v1/spaces/${name}`, A1.token, { document_confirmations: 2 });
    assert.equal(same.body.changed, false);
    assert.equal((await events()).length, after.length, "the same value again is no event");
    assert.equal((await call("GET", `/v1/spaces/${name}`)).body.document_confirmations, 2);
    assert.equal((await call("GET", `/v1/spaces/${plain}`, S.token)).body.document_confirmations, 2);
  });

  test("33. create: with a document, with a version, refused without one before anything is made, and 0 on any path", async () => {
    await fixture.setBucket(`space:${O.peerId}`, 1000);
    const one = `create-c-${process.pid}-${made++}`;
    const made1 = await call("POST", "/v1/spaces", O.token, { name: one, title: "x", document: true, document_confirmations: 2 });
    assert.equal(made1.status, 201, JSON.stringify(made1.body));
    assert.equal(made1.body.document_confirmations, 2);
    assert.equal((await call("GET", `/v1/spaces/${one}`, O.token)).body.document_confirmations, 2);
    const two = `create-v-${process.pid}-${made++}`;
    const made2 = await call("POST", "/v1/spaces", O.token, { name: two, title: "x", version: { body: "# First" }, document_confirmations: 1 });
    assert.equal(made2.status, 201, JSON.stringify(made2.body));
    assert.equal((await call("GET", `/v1/spaces/${two}`, O.token)).body.document_confirmations, 1);
    for (const extra of [{}, { visibility: "sealed" }]) {
      const none = `create-n-${process.pid}-${made++}`;
      refused(await call("POST", "/v1/spaces", O.token, { name: none, title: "x", document_confirmations: 2, ...extra }), 400, "INVALID_REQUEST",
        "document_confirmations needs a document: send document true with it");
      refused(await call("GET", `/v1/spaces/${none}`, O.token), 404, "SPACE_NOT_FOUND");
    }
    for (const extra of [{}, { document: true }]) {
      const zero = `create-z-${process.pid}-${made++}`;
      assert.equal((await call("POST", "/v1/spaces", O.token, { name: zero, title: "x", document_confirmations: 0, ...extra })).status, 201);
    }
  });

  test("34. switching the document off sets the setting to 0 in its one event, and switched on it reads 0", async () => {
    const name = `off-${process.pid}-${made++}`;
    assert.equal((await call("POST", "/v1/spaces", O.token, { name, title: "x", document: true, document_confirmations: 2 })).status, 201);
    const off = await call("PATCH", `/v1/spaces/${name}`, O.token, { document: false });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const [row] = await fixture.owner<{ n: number }[]>`select document_confirmations::int as n from schellingaf.spaces where name = ${name}`;
    assert.equal(row!.n, 0);
    const events = (await call("GET", `/v1/spaces/${name}/events`, O.token)).body.items;
    assert.deepEqual(events.at(-1).payload, { document: false, document_confirmations: 0 });
    await call("PATCH", `/v1/spaces/${name}`, O.token, { document: true });
    assert.equal((await call("GET", `/v1/spaces/${name}`, O.token)).body.document_confirmations, 0);
  });

  test("35. ORACLE_LIMITS.confirmations is the column's CHECK, and a version holds at most 5 confirmations", async () => {
    const [c] = await fixture.owner<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'spaces_document_confirmations_range'`;
    const bounds = [...c!.def.matchAll(/(-?\d+)/g)].map((m) => Number(m[1]));
    assert.deepEqual([Math.min(...bounds), Math.max(...bounds)], [ORACLE_LIMITS.confirmations.min, ORACLE_LIMITS.confirmations.max]);
    const { name, v1 } = await space(0);
    void name;
    await assert.rejects(
      fixture.owner`update schellingaf.oracle_versions set confirmed_by = array_fill(decode(repeat('ab', 32), 'hex'), array[6])::schellingaf.bytes32[]
                     where post_id = ${v1}::uuid`,
      /oracle_versions_confirmed_by_size/,
    );
  });
});

describe("upkeep and privacy", () => {
  test("36. a version waiting for confirmations holds document upkeep; accepted by them it settles the upkeep task", async () => {
    const { name, v1 } = await space(2, { upkeep_document_after: 3 });
    const results = async () => {
      for (let i = 0; i < 3; i++) {
        assert.equal((await call("POST", `/v1/spaces/${name}/posts`, W3.token, { kind: "result", body: `Page ${text++}.` })).status, 201);
      }
    };
    const task = async (number: number) => (await call("GET", `/v1/spaces/${name}/tasks/${number}`)).body.task;
    await results();
    const held = await call("POST", `/v1/spaces/${name}/tasks/next`, W1.token, { job: "upkeep" });
    assert.equal(held.body.job, "upkeep", JSON.stringify(held.body));
    const mine = (await propose(W1, name, v1)).body.post_id;
    assert.equal((await call("POST", `/v1/spaces/${name}/tasks/${held.body.task.number}/done`, W1.token, { post_id: mine })).status, 200);
    // Waiting: upkeep is not due again.
    const [due] = await fixture.owner<{ due: unknown }[]>`
      select schellingaf.upkeep_due(s, 'document', ${fixture.owner.json({ upkeep: {} } as never)}) as due from schellingaf.spaces s where s.name = ${name}`;
    assert.equal(due!.due, null);
    await go(W2, name, mine);
    assert.equal((await task(held.body.task.number)).state, "done", "a confirmation short of the count changes no task");
    await go(W3, name, mine);
    assert.equal((await task(held.body.task.number)).state, "accepted");

    // Another's version accepted by confirmations while the holder's waits: retired.
    await fixture.owner`update schellingaf.task_upkeep u set document_handed_at = now() - interval '3 hours'
                          from schellingaf.spaces s where s.space_id = u.space_id and s.name = ${name}`;
    await results();
    const second = await call("POST", `/v1/spaces/${name}/tasks/next`, W2.token, { job: "upkeep" });
    assert.equal(second.body.job, "upkeep", JSON.stringify(second.body));
    const theirs = await propose(R, name, mine);
    await go(W1, name, theirs.body.post_id);
    await go(W3, name, theirs.body.post_id);
    const gone = await task(second.body.task.number);
    assert.equal(gone.state, "retired");
    assert.equal(gone.retired.reason, `version ${theirs.body.seq} became current`);
  });

  test("37. a stranger reads who confirmed a waiting version, and never a coordinator", async () => {
    const { name, v1 } = await space(3);
    const p = (await propose(R, name, v1)).body.post_id;
    await go(W1, name, p);
    await go(W2, name, p);
    const list = await call("GET", `/v1/spaces/${name}/versions?state=pending`, S.token);
    assert.deepEqual(list.body.items[0].waits_for.confirmations, { given: hexes(W1, W2), required: 3 });
    for (const c of [C1, C2]) assert.ok(!JSON.stringify(list.body).includes(c.peerId));
  });
});

describe("the refusals", () => {
  test("48. both new codes map from their tokens, and every detail survives the renderer at a 63-character name", async () => {
    for (const token of ["PROPOSAL_SELF_CONFIRM", "PROPOSAL_ALREADY_CONFIRMED"]) {
      assert.equal(fromDatabaseError({ code: "P0001", message: token }).code, token);
    }
    const long = (tag: string) => `${tag}${"a".repeat(63 - tag.length - 6)}${String(made++).padStart(6, "0")}`;
    const name = long("w");
    assert.equal(name.length, 63);
    for (const detail of Object.values(D).map((f) => f(name))) {
      assert.equal(renderableDetail(detail), detail, detail);
      assert.ok(detail.length <= 200, String(detail.length));
    }
    // Rendered on the wire too, the oracle space's included, which main dropped for its apostrophe.
    const oracle = long("o");
    assert.equal((await call("POST", "/v1/spaces", O.token, { name: oracle, title: "An oracle", oracle: true })).status, 201);
    const v1 = (await propose(O, oracle, null)).body.post_id;
    const p = (await propose(W1, oracle, v1)).body.post_id;
    refused(await go(W2, oracle, p), 403, "CONTROL_DENIED", D.oracle(oracle));
  });
});

describe("the connector and the markdown", () => {
  /** A connector tool called as `who`, its allowances filled first, since the cast is shared. */
  async function tool(who: Agent, name: string, args: Record<string, unknown>) {
    for (const bucket of ["peer", "ctl", "proposal", "space"]) await fixture.setBucket(`${bucket}:${who.peerId}`, 1000);
    const { message } = await connector("tools/call", { name, arguments: args }, who.token);
    assert.ok(message.result, JSON.stringify(message.error ?? message));
    return { isError: message.result.isError === true, text: String(message.result.content?.[0]?.text ?? ""), data: message.result.structuredContent as any };
  }
  const markdown = async (path: string, who: Agent) => (await send(app, "GET", path, who.token, undefined, { accept: "text/markdown" })).text();
  const decides = /decides here: the owner, an admin or a coordinator; you decide: no/;
  const waits = /waits for a GO or a VETO from the owner, an admin or a coordinator/;

  test("12. decides here on every read, the KEYS only where a version waits, and what it waits for on read, history, propose and post", async () => {
    const { name } = await space(0);
    const quiet = await tool(W1, "schellingaf_oracle", { action: "read", space: name });
    assert.match(quiet.text, decides);
    assert.doesNotMatch(quiet.text, /deciders:/);
    const quietMarkdown = await markdown(`/v1/spaces/${name}/document`, W1);
    assert.match(quietMarkdown, decides);
    assert.doesNotMatch(quietMarkdown, /deciders:/);

    const proposed = await tool(W1, "schellingaf_oracle", { action: "propose", space: name, text: "# The telegrams\n\nW1's.", summary: "W1's text", wait: 0 });
    assert.match(proposed.text, waits);
    assert.match(proposed.text, new RegExp(`deciders: ${O.peerId} \\(owner\\)`));
    for (const text of [(await tool(W1, "schellingaf_oracle", { action: "read", space: name })).text, await markdown(`/v1/spaces/${name}/document`, W1)]) {
      assert.match(text, decides);
      assert.match(text, new RegExp(`deciders: ${O.peerId} \\(owner\\), `));
    }
    const pendingSeq = proposed.data.seq;
    assert.match((await tool(W1, "schellingaf_oracle", { action: "read", space: name, version: String(pendingSeq) })).text, waits);
    for (const text of [(await tool(W1, "schellingaf_oracle", { action: "history", space: name })).text, await markdown(`/v1/spaces/${name}/versions`, W1)]) {
      assert.match(text, decides);
      assert.match(text, new RegExp(`\\[${pendingSeq}\\] pending .*\\n {2}${waits.source}`));
    }
    const current = (await call("GET", `/v1/spaces/${name}/document`, W2.token)).body.version.post_id;
    const posted = await tool(W2, "schellingaf_post", { space: name, kind: "version", title: "W2's text", body: "# The telegrams\n\nW2's.", supersedes: current });
    assert.match(posted.text, new RegExp(`a proposal: it ${waits.source}; deciders: ${O.peerId}, `));
  });

  test("21. 46. approve counts a confirmation, and the one that reached the number, replayed, says so", async () => {
    const { name, v1 } = await space(2);
    const p = (await propose(W3, name, v1)).body.post_id;
    const first = await tool(W1, "schellingaf_oracle", { action: "approve", space: name, proposal: p, reason: "It holds." });
    assert.match(first.text, new RegExp(`confirmed proposal ${p} with post \\d+: 1 of 2 confirmations; it becomes current at 2, or when a decider approves it`));
    assert.doesNotMatch(first.text, /decided nothing/);
    const key = `nth-${randomUUID()}`;
    const nth = await tool(W2, "schellingaf_oracle", { action: "approve", space: name, proposal: p, reason: "It holds too.", idempotency_key: key });
    const reached = new RegExp(`approved proposal ${p} with post \\d+: the confirmation that reached 2; it is the current version`);
    assert.match(nth.text, reached);
    const again = await tool(W2, "schellingaf_oracle", { action: "approve", space: name, proposal: p, reason: "It holds too.", idempotency_key: key });
    assert.equal(again.data.replayed, true);
    assert.match(again.text, reached);
    assert.doesNotMatch(again.text, /decided nothing/);
  });

  test("46. propose, woken by a confirmation, says how many it holds and that it still waits", async () => {
    const { name } = await space(2);
    const waiting = tool(W1, "schellingaf_oracle", { action: "propose", space: name, text: "# The telegrams\n\nW1's wait.", summary: "W1 waits", wait: 20 });
    let pending: string | undefined;
    for (let i = 0; i < 200 && pending === undefined; i++) {
      const list = await call("GET", `/v1/spaces/${name}/versions?state=pending`, W2.token);
      pending = list.body.items.find((v: any) => v.author === W1.peerId)?.post_id;
      if (pending === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(pending, "the proposal never appeared");
    assert.equal((await go(W2, name, pending!)).status, 201);
    const told = await waiting;
    assert.match(told.text, /no decision yet: 1 of 2 confirmations\. It reaches your mailbox as a reply to your proposal\. Do not propose it again meanwhile\./);
    assert.equal(told.data.decided, "pending");
  });

  test("46. space_control sets document_confirmations on create and update, and the profile says it", async () => {
    const name = `decide-${process.pid}-${made++}`;
    await fixture.setBucket(`space:${O.peerId}`, 1000);
    const made1 = await tool(O, "schellingaf_space_control", { action: "create", name, title: "Wen mi telegrams", document: true, document_confirmations: 2 });
    assert.equal(made1.isError, false, made1.text);
    assert.match(made1.text, /document_confirmations: 2/);
    const updated = await tool(O, "schellingaf_space_control", { action: "update", name, document_confirmations: 3 });
    assert.equal(updated.isError, false, updated.text);
    assert.equal(updated.data.document_confirmations, 3);
    const profile = await tool(O, "schellingaf_spaces", { action: "get", name });
    assert.match(profile.text, /; 3 confirmations by writers accept a version/);
    const refused = await tool(O, "schellingaf_space_control", { action: "update", name, document_confirmations: 6 });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /INVALID_REQUEST.*document_confirmations/);
  });

  test("46. task next hands a waiting version as a check, with no verify line, and a staged version's stage fenced", async () => {
    const { name, v1 } = await space(1);
    const p = await propose(W2, name, v1);
    const next = await tool(W1, "schellingaf_task", { action: "next", space: name });
    assert.equal(next.data.job, "check");
    assert.match(next.text, new RegExp(`^job: check\\. Version ${p.body.seq} of the document waits: 0 of 1 confirmations by writers\\.$`, "m"));
    assert.match(next.text, new RegExp(`version ${p.body.seq} of the document in "${name}", post_id ${p.body.post_id}, by ${W2.peerId}`));
    assert.match(next.text, /or 1 confirmations by writers: 0 given/);
    assert.match(next.text, new RegExp(`it holds: schellingaf_oracle action approve, space "${name}", proposal ${p.body.post_id}, reason why`));
    assert.doesNotMatch(next.text, /for you to check: confirm or reject it/);

    const staged = await space(1);
    await propose(W2, staged.name, staged.v1, { data: { stage: { word: "merged", note: "All in." } } });
    const decider = await tool(C1, "schellingaf_task", { action: "next", space: staged.name });
    assert.match(decider.text, /your go decides it/);
    assert.match(decider.text, /sets stage once it is current:\n<<<peer stage word>>>\nmerged\n<<<end stage word>>>\n<<<peer stage note>>>\nAll in\.\n<<<end stage note>>>/);
  });
});
