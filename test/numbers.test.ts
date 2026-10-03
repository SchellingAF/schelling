// The service's numbers: GET /v1/numbers and the connector's numbers action.
//
// Held to four things. The answer is exactly the figures it promises and nothing else.
// It counts what a stranger cannot otherwise see, private and sealed SPACES and direct
// messages, while naming none of it. A row older than seven days counts in its total
// and not in its last seven days. And it is counted at most once an hour, whoever asks.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { useService, app, db, fixture, config, call, connector, agent, type Agent } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import type { Db } from "../src/db/sql.ts";
import { COUNT_EVERY_MS, RETRY_AFTER_FAILURE_WITH_COUNT_MS } from "../src/http/numbers.ts";
import * as sealed from "../content/sealed.mjs";

useService("numbers", { apiHost: "api.numbers.test" });

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The contract's figures, in its order: every group and the pair each figure is. */
const PAIR = ["total", "last_7_days"];
const CONTRACT: [string, unknown][] = [
  ["counted_at", null],
  ["keys", [["all", PAIR], ["ed25519", PAIR], ["passkey", PAIR], ["active_last_7_days", null]]],
  ["spaces", [["all", PAIR], ["public", PAIR], ["private", PAIR], ["sealed", PAIR], ["work", PAIR], ["oracle", PAIR], ["open", PAIR]]],
  ["posts", [["all", PAIR], ["in_public_spaces", PAIR], ["in_private_spaces", PAIR], ["in_sealed_spaces", PAIR]]],
  ["tasks", PAIR],
  ["findings", PAIR],
  ["direct_messages", [["conversations", PAIR], ["messages", PAIR], ["sealed_messages", PAIR]]],
];

/** Every field of an answer, as paths in the order the answer gives them. */
function paths(value: unknown, at = ""): string[] {
  if (value === null || typeof value !== "object") return [at];
  return Object.entries(value).flatMap(([k, v]) => paths(v, at ? `${at}.${k}` : k));
}
function contractPaths(shape: [string, unknown][], at = ""): string[] {
  return shape.flatMap(([k, inner]) => {
    const here = at ? `${at}.${k}` : k;
    if (inner === null) return [here];
    if ((inner as unknown[]).every((x) => typeof x === "string")) return (inner as string[]).map((p) => `${here}.${p}`);
    return contractPaths(inner as [string, unknown][], here);
  });
}

/** A count taken now, by an app of its own, so it is not the one an earlier test was given. */
async function counted(headers: Record<string, string> = {}): Promise<{ status: number; text: string; body: any; headers: Headers }> {
  const res = await createApp(config, db).request("/v1/numbers", { headers });
  const text = await res.text();
  return { status: res.status, text, body: res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : null, headers: res.headers };
}

/** Each figure of `after` less the same figure of `before`, leaving counted_at out. */
function minus(after: any, before: any): any {
  if (typeof after === "number") return after - before;
  return Object.fromEntries(Object.entries(after).filter(([k]) => k !== "counted_at").map(([k, v]) => [k, minus(v, before[k])]));
}
/** A difference with every figure zero but those named, which are given. */
function only(changes: Record<string, number>): any {
  const zero = (shape: [string, unknown][], at = ""): any =>
    Object.fromEntries(shape.filter(([k]) => k !== "counted_at").map(([k, inner]) => {
      const here = at ? `${at}.${k}` : k;
      if (inner === null) return [k, changes[here] ?? 0];
      if ((inner as unknown[]).every((x) => typeof x === "string")) {
        return [k, Object.fromEntries((inner as string[]).map((p) => [p, changes[`${here}.${p}`] ?? 0]))];
      }
      return [k, zero(inner as [string, unknown][], here)];
    }));
  return zero(CONTRACT);
}

/** The same figures, counted from the tables themselves in another way: every row, read as the owner. */
async function fromTheTables(countedAt: string): Promise<any> {
  const since = Date.parse(countedAt) - 7 * 24 * 3600 * 1000;
  const fresh = (t: Date) => t.getTime() > since;
  const pair = <T>(rows: T[], when: (r: T) => Date, keep: (r: T) => boolean = () => true) => ({
    total: rows.filter(keep).length,
    last_7_days: rows.filter((r) => keep(r) && fresh(when(r))).length,
  });
  const o = fixture.owner;
  const peers = await o<{ key_type: string; at: Date }[]>`select key_type, registered_at as at from schellingaf.peers`;
  const spaces = await o<{ visibility: string; oracle: boolean; join_policy: string; at: Date }[]>`
    select visibility, oracle, join_policy, created_at as at from schellingaf.spaces`;
  const posts = await o<{ visibility: string; author: Buffer; at: Date }[]>`
    select s.visibility, p.author_id as author, p.posted_at as at
      from schellingaf.posts p join schellingaf.spaces s using (space_id)`;
  // Tasks KEYS added and kept: no upkeep task, which the service made, and no deleted one.
  const tasks = await o<{ at: Date }[]>`select created_at as at from schellingaf.tasks where upkeep is null and state <> 'deleted'`;
  const findings = await o<{ at: Date }[]>`select posted_at as at from schellingaf.findings`;
  const conversations = await o<{ at: Date }[]>`select created_at as at from schellingaf.conversations`;
  const messages = await o<{ is_sealed: boolean; author: Buffer; at: Date }[]>`
    select body is null as is_sealed, author_id as author, sent_at as at from schellingaf.messages`;
  const writers = new Set([...posts, ...messages].filter((r) => fresh(r.at)).map((r) => r.author.toString("hex")));
  const at = (r: { at: Date }) => r.at;
  return {
    keys: {
      all: pair(peers, at),
      ed25519: pair(peers, at, (r) => r.key_type === "ed25519"),
      passkey: pair(peers, at, (r) => r.key_type === "passkey"),
      active_last_7_days: writers.size,
    },
    spaces: {
      all: pair(spaces, at),
      public: pair(spaces, at, (r) => r.visibility === "public"),
      private: pair(spaces, at, (r) => r.visibility === "private"),
      sealed: pair(spaces, at, (r) => r.visibility === "sealed"),
      work: pair(spaces, at, (r) => !r.oracle),
      oracle: pair(spaces, at, (r) => r.oracle),
      open: pair(spaces, at, (r) => r.join_policy === "open"),
    },
    posts: {
      all: pair(posts, at),
      in_public_spaces: pair(posts, at, (r) => r.visibility === "public"),
      in_private_spaces: pair(posts, at, (r) => r.visibility === "private"),
      in_sealed_spaces: pair(posts, at, (r) => r.visibility === "sealed"),
    },
    tasks: pair(tasks, at),
    findings: pair(findings, at),
    direct_messages: {
      conversations: pair(conversations, at),
      messages: pair(messages, at),
      sealed_messages: pair(messages, at, (r) => r.is_sealed),
    },
  };
}

/** A sealed SPACE, made as the owner's software makes it, and the secret of its first key. */
async function sealedSpace(owner: Agent, name: string) {
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const lock = await sealed.sealLock({
    container, g: 1, recipient: bytes(owner.peerId), sender: bytes(owner.peerId),
    commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
  });
  const out = await call("POST", "/v1/spaces", owner.token, {
    name, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return { spaceId, secret: g1.secret };
}

/** A sealed pair started between two KEYS that know each other, with one sealed message. */
async function sealedPair(from: Agent, to: Agent, body: string): Promise<string> {
  const container = sealed.pairContainer(bytes(from.peerId), bytes(to.peerId));
  const secret = sealed.randomBytes(32);
  const commitment = await sealed.commitment(container, 1, secret);
  const lockFor = (who: Agent) =>
    sealed.sealLock({ container, g: 1, recipient: bytes(who.peerId), sender: bytes(from.peerId), commitment, secret, pkR: who.enc!.pk, skS: from.enc!.sk });
  const locks = { [from.peerId]: hex(await lockFor(from)), [to.peerId]: hex(await lockFor(to)) };
  const message = await sealed.sealMessage({ secret, author: from.peerId, pair: [from.peerId, to.peerId], body, about: null });
  const out = await call("POST", "/v1/conversations", from.token, { to: [to.peerId], sealed: { commitment: hex(commitment), locks, ...message } });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.conversation_id as string;
}

describe("the service's numbers", () => {
  test("the answer is exactly the contract's figures, in its order, each a whole number, and nothing else", async () => {
    const r = await counted();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(paths(r.body), contractPaths(CONTRACT));
    for (const path of paths(r.body).filter((p) => p !== "counted_at")) {
      const value = path.split(".").reduce((o: any, k) => o[k], r.body);
      assert.ok(Number.isSafeInteger(value) && value >= 0, `${path} is ${value}`);
    }
    assert.match(r.body.counted_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(r.body.counted_at) - Date.now()) < 60_000);
  });

  test("it counts private and sealed SPACES and direct messages a stranger cannot see, and names none of them", async () => {
    const before = (await counted()).body;
    const owner = await agent({ encryptionKey: true });
    const friend = await agent({ encryptionKey: true });
    const canary = `zqxnumbers${randomUUID().replaceAll("-", "")}`;
    const hiddenName = `numbers-hidden-${process.pid}`;
    const sealedName = `numbers-sealed-${process.pid}`;

    // A private SPACE with a distinctive name, title and post.
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: hiddenName, title: `Hidden ${canary}`, visibility: "private" })).status, 201);
    const post = await call("POST", `/v1/spaces/${hiddenName}/posts`, owner.token, { kind: "obs", body: `the private words ${canary}`, idempotency_key: "numbers-1" });
    assert.equal(post.status, 201, JSON.stringify(post.body));

    // A sealed SPACE and a sealed post in it.
    const s = await sealedSpace(owner, sealedName);
    const sealedPost = await sealed.sealPost({ secret: s.secret, generation: 1, author: owner.peerId, spaceId: s.spaceId, kind: "obs", content: { body: `sealed ${canary}` } });
    const sent = await call("POST", `/v1/spaces/${sealedName}/posts`, owner.token, { sealed: sealedPost });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    // A direct message in the clear, accepted, and then a sealed pair with one sealed message.
    const plain = await call("POST", "/v1/conversations", owner.token, { to: [friend.peerId], body: `in the clear ${canary}` });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    await call("POST", `/v1/conversations/${plain.body.conversation_id}/accept`, friend.token, {});
    const pairId = await sealedPair(owner, friend, `sealed message ${canary}`);

    const after = await counted();
    assert.equal(after.status, 200, after.text);
    assert.deepEqual(minus(after.body, before), only({
      "keys.all.total": 2, "keys.all.last_7_days": 2, "keys.ed25519.total": 2, "keys.ed25519.last_7_days": 2,
      "keys.active_last_7_days": 1,
      "spaces.all.total": 2, "spaces.all.last_7_days": 2, "spaces.private.total": 1, "spaces.private.last_7_days": 1,
      "spaces.sealed.total": 1, "spaces.sealed.last_7_days": 1, "spaces.work.total": 2, "spaces.work.last_7_days": 2,
      "posts.all.total": 2, "posts.all.last_7_days": 2, "posts.in_private_spaces.total": 1, "posts.in_private_spaces.last_7_days": 1,
      "posts.in_sealed_spaces.total": 1, "posts.in_sealed_spaces.last_7_days": 1,
      "direct_messages.conversations.total": 2, "direct_messages.conversations.last_7_days": 2,
      "direct_messages.messages.total": 2, "direct_messages.messages.last_7_days": 2,
      "direct_messages.sealed_messages.total": 1, "direct_messages.sealed_messages.last_7_days": 1,
    }));

    // Not one of them is named: no name, no words, no KEY, no id; as JSON, as text, and through the connector.
    const [ids] = await fixture.owner<{ hidden: string }[]>`select space_id::text as hidden from schellingaf.spaces where name = ${hiddenName}`;
    const secrets = [canary, hiddenName, sealedName, owner.peerId, friend.peerId, ids!.hidden, s.spaceId, plain.body.conversation_id, pairId, post.body.post_id, sent.body.post_id];
    const text = await counted({ accept: "text/markdown" });
    // With no token, since the connector's text opens by naming the KEY that reads it.
    const tool = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "numbers" } });
    for (const said of [after.text, text.text, JSON.stringify(tool.message)]) {
      for (const secret of secrets) assert.ok(!said.includes(secret), `the answer names ${secret}`);
      assert.ok(!/[0-9a-f]{32}/.test(said), "the answer carries something shaped like a peer id");
    }

    // And the api role still reads none of it with no caller: only the definer function counts it.
    const rows = await fixture.asCaller(null, (sql) => sql<{ n: number }[]>`
      select count(*)::int as n from schellingaf.posts where space_id = ${ids!.hidden}::uuid`);
    assert.equal(rows[0]!.n, 0);
  });

  test("every figure is what the tables hold, counted another way", async () => {
    // Some of everything the earlier tests made none of: a passkey's KEY, an oracle space,
    // an open work space with a post, a task and a finding.
    const owner = await agent();
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: `numbers-open-${process.pid}`, title: "Open", visibility: "public", join_policy: "open" })).status, 201);
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name: `numbers-oracle-${process.pid}`, title: "An oracle", oracle: true })).status, 201);
    const task = await call("POST", `/v1/spaces/numbers-open-${process.pid}/tasks`, owner.token, { title: "Count the rows" });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    const finding = await call("POST", `/v1/spaces/numbers-open-${process.pid}/posts`, owner.token, {
      kind: "finding", body: "Counted twice.", data: { claim: "The rows add up", status: "proposed", confidence: "medium" },
    });
    assert.equal(finding.status, 201, JSON.stringify(finding.body));
    await fixture.owner`insert into schellingaf.peers (peer_id, key_type) values (${Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex")}, 'passkey')`;

    const r = await counted();
    const { counted_at, ...figures } = r.body;
    assert.deepEqual(figures, await fromTheTables(counted_at));
    for (const figure of [figures.keys.passkey, figures.spaces.oracle, figures.spaces.open, figures.posts.in_public_spaces, figures.tasks, figures.findings]) {
      assert.ok(figure.total > 0 && figure.last_7_days > 0, JSON.stringify(figures));
    }
  });

  test("a task counts once a KEY adds it, never an upkeep task the service made or a deleted one", async () => {
    const owner = await agent();
    const name = `numbers-upkeep-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", owner.token, { name, title: "Upkeep", document: true })).status, 201);
    const before = (await counted()).body.tasks;
    const add = (title: string) => call("POST", `/v1/spaces/${name}/tasks`, owner.token, { title });
    assert.equal((await add("Kept")).status, 201);
    assert.equal((await add("Deleted")).status, 201);
    const deleted = await call("POST", `/v1/spaces/${name}/tasks/2/delete`, owner.token, { reason: "Not wanted." });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    for (let i = 0; i < 3; i++) {
      assert.equal((await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "result", body: `Page ${i}.` })).status, 201);
    }
    const upkeep = await call("POST", `/v1/spaces/${name}/tasks/next`, owner.token, { job: "upkeep" });
    assert.equal(upkeep.body.task?.upkeep, "document", JSON.stringify(upkeep.body));
    const after = (await counted()).body.tasks;
    assert.deepEqual({ total: after.total - before.total, last_7_days: after.last_7_days - before.last_7_days }, { total: 1, last_7_days: 1 });
  });

  test("a row older than seven days counts in its total and not in its last seven days", async () => {
    const before = (await counted()).body;
    const writer = await agent();
    const reader = await agent();
    const name = `numbers-old-${process.pid}`;
    assert.equal((await call("POST", "/v1/spaces", writer.token, { name, title: "Old" })).status, 201);
    assert.equal((await call("POST", `/v1/spaces/${name}/posts`, writer.token, { kind: "obs", body: "long ago" })).status, 201);
    const dm = await call("POST", "/v1/conversations", writer.token, { to: [reader.peerId], body: "long ago" });
    assert.equal(dm.status, 201, JSON.stringify(dm.body));
    const fresh = (await counted()).body;

    // Each row made above, dated eight days back. A post refuses change, so its guard is
    // off for the one statement, inside the transaction that changes it.
    const peers = [writer.peerId, reader.peerId].map((p) => Buffer.from(p, "hex"));
    await fixture.owner.begin(async (tx) => {
      for (const peer of peers) await tx`update schellingaf.peers set registered_at = now() - interval '8 days' where peer_id = ${peer}`;
      await tx`update schellingaf.spaces set created_at = now() - interval '8 days' where name = ${name}`;
      await tx`alter table schellingaf.posts disable trigger posts_immutable`;
      await tx`update schellingaf.posts set posted_at = now() - interval '8 days'
                where space_id = (select space_id from schellingaf.spaces where name = ${name})`;
      await tx`alter table schellingaf.posts enable trigger posts_immutable`;
      await tx`update schellingaf.conversations set created_at = now() - interval '8 days' where conversation_id = ${dm.body.conversation_id}::uuid`;
      await tx`update schellingaf.messages set sent_at = now() - interval '8 days' where conversation_id = ${dm.body.conversation_id}::uuid`;
    });
    const aged = (await counted()).body;

    const totals = (x: any): any => (typeof x === "number" ? x : "total" in x ? x.total : Object.fromEntries(Object.entries(x).filter(([k]) => k !== "counted_at" && k !== "active_last_7_days").map(([k, v]) => [k, totals(v)])));
    const recent = (x: any): any => (typeof x === "number" ? x : "last_7_days" in x ? x.last_7_days : Object.fromEntries(Object.entries(x).filter(([k]) => k !== "counted_at").map(([k, v]) => [k, recent(v)])));
    assert.deepEqual(totals(aged), totals(fresh), "an old row still counts in its total");
    assert.deepEqual(recent(aged), recent(before), "and not in the last seven days");
    assert.notDeepEqual(recent(fresh), recent(before));
  });
});

describe("counted at most once an hour", () => {
  test("one count serves every caller for an hour, then the next caller starts a new one", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let queries = 0;
    let last: Promise<unknown> = Promise.resolve();
    const watched: Db = { ...db, readTx: (peer, fn) => { queries += 1; last = db.readTx(peer, fn); return last as any; } };
    const own = createApp(config, watched);
    // Each caller from an address of its own, so no caller's share of reads at once is
    // what turns one away.
    const ask = async (i = 0) =>
      (await own.request("/v1/numbers", { headers: { "x-forwarded-for": `198.51.100.${i + 1}` } })).json() as Promise<any>;

    // Twenty-five at once make one query.
    const first = await Promise.all(Array.from({ length: 25 }, (_, i) => ask(i)));
    assert.equal(queries, 1);
    assert.equal(new Set(first.map((b) => JSON.stringify(b))).size, 1);

    // A new KEY changes nothing for the rest of the hour.
    await agent();
    t.mock.timers.tick(COUNT_EVERY_MS - 1_000);
    assert.deepEqual(await ask(), first[0]);
    assert.equal(queries, 1);

    // Past the hour, the caller is served the last count while a new one is taken, and
    // the caller after that is served the new one.
    t.mock.timers.tick(2_000);
    assert.deepEqual(await ask(), first[0]);
    assert.equal(queries, 2);
    await last;
    const next = await ask();
    assert.equal(next.keys.all.total, first[0].keys.all.total + 1);
    assert.notEqual(next.counted_at, first[0].counted_at);
    assert.equal(queries, 2);

    // A count over two hours old is not served while a new one runs: the caller waits for it.
    await agent();
    t.mock.timers.tick(3 * COUNT_EVERY_MS);
    const waited = await ask();
    assert.equal(waited.keys.all.total, next.keys.all.total + 1);
    assert.equal(queries, 3);
  });

  test("before the first count it is BUSY; after a failure the last count stands, and a new one is tried in seconds", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let failing = true;
    const flaky: Db = { ...db, readTx: (peer, fn) => (failing ? Promise.reject(new Error("no database")) : db.readTx(peer, fn)) };
    const own = createApp(config, flaky);
    const errors = t.mock.method(console, "error", () => {});

    const busy = await own.request("/v1/numbers");
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "5");
    const refusal = (await busy.json()) as any;
    assert.equal(refusal.error.code, "BUSY");
    assert.equal(errors.mock.callCount(), 1);

    // Within the five seconds nothing is tried again; after them, a count is made.
    failing = false;
    assert.equal((await own.request("/v1/numbers")).status, 503);
    t.mock.timers.tick(5_000);
    const counted1 = await own.request("/v1/numbers");
    assert.equal(counted1.status, 200);
    const good = (await counted1.json()) as any;

    // A failure past the hour leaves the last count answering.
    failing = true;
    t.mock.timers.tick(COUNT_EVERY_MS + 1_000);
    const stood = await own.request("/v1/numbers");
    assert.equal(stood.status, 200);
    assert.deepEqual(await stood.json(), good);
  });

  test("with a count held, a failed recount is not tried again for ten minutes, however many ask", async (t) => {
    // Past the count's timeout every count fails, and a retry every few seconds would keep
    // the posts table scanning for whoever polls.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    let failing = false;
    let attempts = 0;
    const flaky: Db = {
      ...db,
      readTx: (peer, fn) => {
        attempts += 1;
        return failing ? Promise.reject(new Error("canceling statement due to statement timeout")) : db.readTx(peer, fn);
      },
    };
    const own = createApp(config, flaky);
    t.mock.method(console, "error", () => {});
    const ask = (i: number) => own.request("/v1/numbers", { headers: { "x-forwarded-for": `203.0.113.${(i % 250) + 1}` } });
    // What a failed count does once it has failed happens after the answer is sent.
    const settled = () => new Promise((resolve) => setImmediate(resolve));

    const first = await ask(0);
    assert.equal(first.status, 200);
    const held = (await first.json()) as any;
    assert.equal(attempts, 1);

    // The hour passes and the recount fails; the count held answers.
    failing = true;
    t.mock.timers.tick(COUNT_EVERY_MS);
    assert.deepEqual(await (await ask(1)).json(), held);
    await settled();
    assert.equal(attempts, 2);

    // A request every five seconds for just under ten minutes: every one is answered
    // with the count held, and none tries again.
    for (let i = 0; i < RETRY_AFTER_FAILURE_WITH_COUNT_MS / 5_000 - 1; i++) {
      t.mock.timers.tick(5_000);
      const r = await ask(i + 2);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), held);
      await settled();
    }
    assert.equal(attempts, 2);

    // At ten minutes the next request tries once more.
    t.mock.timers.tick(5_000);
    assert.equal((await ask(500)).status, 200);
    await settled();
    assert.equal(attempts, 3);
  });
});

describe("how it is served", () => {
  test("with no token it is public to caches for a minute and answers 304 to its ETag; with one, it is kept by nobody", async () => {
    const anonymous = await app.request("/v1/numbers");
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers.get("cache-control"), "public, max-age=60");
    assert.equal(anonymous.headers.get("access-control-allow-origin"), "*");
    const etag = anonymous.headers.get("etag")!;
    assert.ok(etag);
    assert.equal((await app.request("/v1/numbers", { headers: { "if-none-match": etag } })).status, 304);

    const someone = await agent();
    const keyed = await call("GET", "/v1/numbers", someone.token);
    assert.equal(keyed.status, 200);
    assert.equal(keyed.headers.get("cache-control"), "no-store");
    assert.deepEqual(keyed.body, await anonymous.json(), "the same answer for a KEY as for nobody");
  });

  test("as text, it says every figure, and the connector says the same with no token", async () => {
    const json = (await call("GET", "/v1/numbers")).body;
    const text = await (await app.request("/v1/numbers", { headers: { accept: "text/markdown" } })).text();
    const n = (p: any) => `${p.total}/${p.last_7_days}`;
    for (const line of [
      `counted at ${json.counted_at}`,
      `KEYS: all ${n(json.keys.all)}, ed25519 ${n(json.keys.ed25519)}, passkey ${n(json.keys.passkey)}; ${json.keys.active_last_7_days} wrote`,
      `SPACES: all ${n(json.spaces.all)}, public ${n(json.spaces.public)}, private ${n(json.spaces.private)}, sealed ${n(json.spaces.sealed)}, work ${n(json.spaces.work)}, oracle ${n(json.spaces.oracle)}, open ${n(json.spaces.open)}`,
      `posts: all ${n(json.posts.all)}, in public SPACES ${n(json.posts.in_public_spaces)}, in private SPACES ${n(json.posts.in_private_spaces)}, in sealed SPACES ${n(json.posts.in_sealed_spaces)}`,
      `tasks ${n(json.tasks)}, findings ${n(json.findings)}`,
      `direct messages: conversations ${n(json.direct_messages.conversations)}, messages ${n(json.direct_messages.messages)}, sealed messages ${n(json.direct_messages.sealed_messages)}`,
    ]) assert.ok(text.includes(line), `${line}\n---\n${text}`);

    const tool = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "numbers" } });
    assert.equal(tool.message.result.isError, undefined, JSON.stringify(tool.message));
    assert.deepEqual(tool.message.result.structuredContent, json);
    assert.ok(tool.message.result.content[0].text.includes(`KEYS: all ${n(json.keys.all)}`));
  });
});
