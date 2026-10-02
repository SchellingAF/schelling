// Load limits: the ceilings that are not about one caller.
//
// A limit that bounds one caller (one KEY, one address, one SPACE) does nothing
// against a flood spread across many addresses: every address stays inside its
// own allowance, nothing is refused, and an operator sees rising memory and
// latency with a healthy 200 rate. This file holds the two ceilings that bound
// the service: the global read gate, and an anonymous allowance smaller than the
// registered one. And three rules on the way in: the connector counts token
// guesses, the SPACE directory bounds its search term as SEEK does, and a caller
// with no KEY is keyed on its address.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { filed } from "./helpers.ts";
import { useService, app, db, config, agent, send, read, type Agent, type App } from "./lib/service.ts";
import { READ_POOL, allowReadQueryWatch, openDb, watchReadQueries, type Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_QUERY_NODES, QUERY_BYTES, QUERY_TERMS } from "../src/http/postview.ts";
import { CONCURRENT_SEEKS, seekCeiling } from "../src/http/seek.ts";
import {
  ANON_READS_PER_MINUTE,
  CONCURRENT_READS_PER_ANON,
  LIMITS,
  READS_PER_MINUTE,
  holdRead,
  readKey,
  resetInFlightReads,
  resetReadWindows,
  withinReadWindow,
} from "../src/http/ratelimit.ts";

let owner: Agent;

const ready = useService("load_limits");
before(async () => {
  await ready;
  owner = await agent();
  await call("POST", "/v1/spaces", owner.token, {
    name: "floor-space",
    title: "A space to read while the service is full",
    description: "aarch64 build failures and numpy wheels",
  });
});

/** A request as this file sends it: a JSON content type whether or not there is a body. */
async function call(method: string, path: string, token: string | null, body?: unknown) {
  return read(await send(app, method, path, token, filed(method, path, body), { "content-type": "application/json" }));
}

const unknownBearer = () => `Bearer schellingaf_${randomBytes(32).toString("hex")}`;

/**
 * An app whose global gate is small enough to fill in a test. The numbers are read
 * when the app is built, and a variable that was not set is restored by DELETING it:
 * `process.env.X = undefined` stores the string "undefined".
 */
function appWithGate(concurrent: number, queue: number, waitMs: number, using: Db = db): App {
  const names = ["GLOBAL_CONCURRENT_READS", "GLOBAL_READ_QUEUE", "GLOBAL_READ_WAIT_MS"] as const;
  const saved = names.map((name) => [name, process.env[name]] as const);
  process.env.GLOBAL_CONCURRENT_READS = String(concurrent);
  process.env.GLOBAL_READ_QUEUE = String(queue);
  process.env.GLOBAL_READ_WAIT_MS = String(waitMs);
  try {
    return createApp(config, using);
  } finally {
    for (const [name, was] of saved) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  }
}

/**
 * The same Db, with every read statement whose text `matches` held inside its
 * transaction until `release`. Everything else passes straight through, so a
 * test can hold one kind of read and watch what the rest of the service does.
 */
function holdingReads(real: Db, matches: (text: string) => boolean) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held = 0;
  const holding: Db = {
    ...real,
    readTx: (peer, fn) =>
      real.readTx(peer, (sql) =>
        fn(
          new Proxy(sql, {
            apply(target, thisArg, args: unknown[]) {
              const strings = args[0] as readonly string[] | undefined;
              if (Array.isArray(strings) && matches(strings.join(""))) {
                held++;
                return released.then(() => Reflect.apply(target as never, thisArg, args));
              }
              return Reflect.apply(target as never, thisArg, args);
            },
          }) as never,
        ),
      ),
  };
  return { db: holding, release: () => release(), held: () => held };
}

/** A SEEK is the one read that sets a three-second statement timeout. */
const holdingSeeks = (real: Db) => holdingReads(real, (text) => text.includes("statement_timeout = '3s'"));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !condition() && waited < ms; waited += 10) await sleep(10);
}

/** A request context holding nothing but one X-Forwarded-For, for readKey. */
const fromAddress = (address: string) =>
  ({ req: { header: (name: string) => (name === "X-Forwarded-For" ? address : undefined) } }) as never;

/** One tools/call to /mcp on `on`, and its answer. */
let rpcId = 0;
function toolCall(on: App, params: unknown, headers: Record<string, string> = {}) {
  return Promise.resolve(
    on.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params }),
    }),
  );
}

// ── the gate that bounds the service rather than a caller ────────────────────

describe("the whole service's share of the moment", () => {
  test("a flood from many addresses meets the global gate, and no per-address ceiling fires", async () => {
    // Thirty requests from thirty addresses is one request each: every address is
    // at 1 of its 120 a minute and 1 of its 2 at once, so only the gate can refuse.
    const flooded = appWithGate(1, 1, 2000);
    resetReadWindows();

    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        flooded.request("/v1/spaces", { headers: { "X-Forwarded-For": `198.51.100.${i + 1}` } }),
      ),
    );
    const bodies = await Promise.all(answers.map((r) => r.json() as Promise<any>));

    const refused = answers.filter((r) => r.status === 429);
    assert.ok(
      refused.length > 0,
      "thirty concurrent reads from thirty addresses were all run at once: nothing bounds the service",
    );
    assert.ok(answers.some((r) => r.status === 200), "the gate refused everybody, including the callers it had space for");

    // The refusal names the service, not the caller. An operator at 3am has to
    // be able to tell "this caller asked too often", which is BUSY and a 503,
    // from "the service is at its ceiling" — and a status that means both means
    // neither.
    assert.equal(
      answers.filter((r) => r.status === 503).length,
      0,
      "a per-caller ceiling fired, which is exactly what a many-addressed flood is supposed to slip past",
    );
    for (const [i, r] of answers.entries()) {
      if (r.status !== 429) continue;
      assert.equal(bodies[i]!.error.code, "RATE_LIMITED");
      assert.ok(bodies[i]!.error.retry_after >= 1, "a refusal carried no time to wait");
      // The thing that is full belongs to everybody, so its balance is nobody's
      // to read. Same rule as every other shared bucket in the service.
      assert.equal(r.headers.get("RateLimit-Remaining"), null);
      assert.equal(r.headers.get("RateLimit-Limit"), null);
    }

    // And a slot is given back by a refused request as well as by a served one.
    // A leak here would take the whole service down for the life of the
    // process, which is a worse outage than the one the gate prevents.
    const after = await flooded.request("/v1/spaces", {
      headers: { "X-Forwarded-For": "198.51.100.200" },
    });
    await after.text();
    assert.equal(after.status, 200, "global slots leaked: the service can no longer read at all");
  });

  test("the health check is counted, and is not behind the gate", async () => {
    // It runs `select 1` on every call. Counting it in the same window as content reads would be worse than not counting it: a
    // health check refused because a crawler filled the anonymous allowance
    // gets the container restarted, which is the outage the ceilings exist to
    // prevent, arriving from the inside.
    resetReadWindows();
    const addr = "203.0.113.40";
    const res = await app.request("/healthz", { headers: { "X-Forwarded-For": addr } });
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(
      withinReadWindow(`health:${addr}`, 1).allowed,
      false,
      "a health check cost a database round trip and nothing counted it",
    );
    // And it did not spend the content allowance for that address.
    assert.equal(
      withinReadWindow(`addr:${addr}`, 1).allowed,
      true,
      "a health check spent the content allowance its own address reads with",
    );
  });

  test("one address cannot fill the gate's queue ahead of everybody else", async () => {
    // A caller's own share is taken before the global gate, so an address's
    // requests past its share of two never hold a place in the queue.
    //
    // One slot and four places. Taken share-first, the flooding address gets two
    // requests past its share — one running, one waiting — and the second
    // address waits behind them and is served. Taken gate-first, the flood holds
    // the slot and all four places and the second address is refused.
    const gated = appWithGate(1, 4, 3000);
    resetReadWindows();
    resetInFlightReads();
    const flood = Array.from({ length: 12 }, () =>
      gated.request("/v1/spaces", { headers: { "X-Forwarded-For": "203.0.113.90" } }),
    );
    const innocent = gated.request("/v1/spaces", { headers: { "X-Forwarded-For": "198.51.100.91" } });
    const answers = await Promise.all([...flood, innocent]);
    await Promise.all(answers.map((r) => r.text()));
    const own = answers.at(-1)!;
    assert.equal(
      own.status,
      200,
      `a second address was refused (${own.status}) because one address had filled the gate's queue`,
    );
    const floodStatuses = answers.slice(0, -1).map((r) => r.status);
    assert.ok(
      floodStatuses.filter((s) => s === 200).length <= CONCURRENT_READS_PER_ANON + 1,
      `one address ran more reads than its own share allows: ${floodStatuses.join(",")}`,
    );
    assert.ok(floodStatuses.includes(503), "the flooding address was never told it was over its own share");
  });

  test("a POST that reaches a pool meets the gate, not only the reads", async () => {
    // Thirty concurrent challenges from thirty addresses were all served with the
    // gate at one slot: each a bucket round trip on the WRITE pool, which has no
    // gate of its own and a driver queue with no timeout. A per-address bucket
    // does not help, because spending it is itself the query.
    const gated = appWithGate(1, 1, 50);
    resetReadWindows();
    resetInFlightReads();
    const answers = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        gated.request("/v1/keys/challenge", {
          method: "POST",
          headers: { "content-type": "application/json", "X-Forwarded-For": `198.51.100.${120 + i}` },
          body: JSON.stringify({ public_key: randomBytes(32).toString("hex") }),
        }),
      ),
    );
    await Promise.all(answers.map((r) => r.text()));
    assert.ok(
      answers.some((r) => r.status === 429),
      "thirty concurrent challenges were all served with the gate at one slot: writes are outside the global gate",
    );
  });

  test("the health check probes the database once however many ask at once", async () => {
    // Behind Caddy it is an internet path like any other, and a per-address
    // window does not bound many addresses. So the probe stops scaling with the
    // askers: every check inside the window shares one answer.
    allowReadQueryWatch();
    const watched = openDb(config);
    try {
      const probed = createApp(config, watched);
      resetReadWindows();
      const seen: string[] = [];
      watchReadQueries((sql) => seen.push(sql));
      const answers = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          probed.request("/healthz", { headers: { "X-Forwarded-For": `192.0.2.${i + 1}` } }),
        ),
      );
      await Promise.all(answers.map((r) => r.text()));
      watchReadQueries(null);
      assert.deepEqual([...new Set(answers.map((r) => r.status))], [200]);
      const probes = seen.filter((sql) => /select 1/i.test(sql)).length;
      assert.equal(probes, 1, `twenty-five health checks ran ${probes} database probes`);
    } finally {
      watchReadQueries(null);
      await watched.end();
    }
  });

  test("the capabilities document is never refused, however often one address asks", async () => {
    // The reason is written at the route: served from memory, counting it would
    // protect nothing and tell a CI fleet behind one NAT BUSY on the one document
    // that explains BUSY.
    resetReadWindows();
    const addr = "203.0.113.95";
    const statuses = new Set<number>();
    for (let i = 0; i < ANON_READS_PER_MINUTE + 5; i++) {
      const res = await app.request("/v1/capabilities", { headers: { "X-Forwarded-For": addr } });
      await res.text();
      statuses.add(res.status);
    }
    assert.deepEqual([...statuses], [200], "the capabilities document was refused to an anonymous caller");
  });
});

// ── two ceilings, not one ───────────────────────────────────────────────────

describe("a caller with no KEY does not get a registered caller's allowance", () => {
  test("the anonymous ceiling is lower, and it is the one an anonymous caller meets", async () => {
    assert.ok(
      ANON_READS_PER_MINUTE < READS_PER_MINUTE,
      "the two allowances are the same number, so registering a KEY buys nothing",
    );
    resetReadWindows();
    const addr = "203.0.113.50";
    // A content read, and one page of one row; `capabilities` is never counted
    // (the test above).
    const anonymous: number[] = [];
    for (let i = 0; i < ANON_READS_PER_MINUTE + 5; i++) {
      const res = await app.request("/v1/spaces?limit=1", { headers: { "X-Forwarded-For": addr } });
      await res.text();
      anonymous.push(res.status);
    }
    assert.ok(
      anonymous.includes(503),
      `${anonymous.length} anonymous reads from one address were all served: the ceiling is the registered one`,
    );

    // The same address, the same count, holding a KEY: never refused, because
    // the allowance is the KEY's and not the address's.
    const registered: number[] = [];
    for (let i = 0; i < ANON_READS_PER_MINUTE + 5; i++) {
      const res = await app.request("/v1/spaces?limit=1", {
        headers: { Authorization: `Bearer ${owner.token}`, "X-Forwarded-For": addr },
      });
      await res.text();
      registered.push(res.status);
    }
    assert.deepEqual(
      [...new Set(registered)],
      [200],
      "a registered KEY was held to the anonymous allowance of the address it happened to call from",
    );
  });

  test("an expired or missing token is anonymous, and a stale one buys nothing", () => {
    // Stated at the key rather than through HTTP: a caller with no VALID bearer
    // is keyed on its address whatever its header said, so an expired token
    // cannot be presented to buy the registered allowance. And two such callers
    // are two callers, never one word: SEEK's share is one search per caller, so
    // one key for every anonymous caller would let one search refuse everybody.
    assert.equal(readKey(fromAddress("203.0.113.60"), null), "addr:203.0.113.60");
    assert.equal(readKey(fromAddress("203.0.113.60"), "ab".repeat(32)), `peer:${"ab".repeat(32)}`);
    assert.notEqual(
      readKey(fromAddress("198.51.100.201"), null),
      readKey(fromAddress("198.51.100.202"), null),
      "two anonymous callers share one SEEK slot",
    );
  });
});

describe("a caller's share of the moment", () => {
  test("a release run twice gives back one place, never another request's", () => {
    resetInFlightReads();
    const key = "addr:203.0.113.61";
    const first = holdRead(key, 2);
    holdRead(key, 2);
    first();
    first();
    // One place is free, and the second request still holds the other.
    const third = holdRead(key, 2);
    assert.throws(() => holdRead(key, 2), /BUSY/, "a doubled release freed a place another request holds");
    third();
    resetInFlightReads();
  });
});

// ── the connector is inside every limiter ───────────────────────────────────

describe("the connector counts what it makes the database do", () => {
  const rpc = async (params: unknown, addr: string, authorization?: string) => {
    const res = await toolCall(app, params, {
      "X-Forwarded-For": addr,
      ...(authorization ? { Authorization: authorization } : {}),
    });
    const text = await res.text();
    const json = text.startsWith("event:") || text.startsWith("data:")
      ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5))
      : JSON.parse(text);
    return { status: res.status, json };
  };

  test("a bad bearer presented to /mcp is counted, exactly as one presented to /v1 is", async () => {
    // The connector hands the caller's address to `classifyBearer`, or the guess
    // window does not exist on this path: `schellingaf_` and any sixty-four hex
    // characters passes every cheap gate and reaches the token join, on a route
    // that needs no token.
    resetReadWindows();
    const addr = "203.0.113.70";
    const { status } = await rpc(
      { name: "schellingaf_whoami", arguments: {} },
      addr,
      unknownBearer(),
    );
    assert.equal(status, 200, "the connector answered a token problem with a status");
    assert.equal(
      withinReadWindow(`bearer:${addr}`, 1).allowed,
      false,
      "a guess through the connector cost a token lookup and nothing counted it",
    );
  });

  test("and a token that works is not counted as a guess", async () => {
    // The window is per ADDRESS, and an address is a whole NAT. If a working
    // token were counted, one guesser would refuse its neighbours' good ones.
    resetReadWindows();
    const addr = "203.0.113.71";
    const { status } = await rpc(
      { name: "schellingaf_whoami", arguments: {} },
      addr,
      `Bearer ${owner.token}`,
    );
    assert.equal(status, 200);
    assert.equal(
      withinReadWindow(`bearer:${addr}`, 1).allowed,
      true,
      "a token this service issued was counted as a guess",
    );
  });

  test("past the allowance the connector refuses in its own envelope, never with a status", async () => {
    // A token problem is ordinary tool output here, because a client that meets
    // a status where it expected output treats the server as dead. So the
    // connector refuses softly, and still counts.
    resetReadWindows();
    const addr = "203.0.113.72";
    const badBearers = Number(process.env.BAD_BEARERS_PER_MINUTE ?? 60);
    let refused: { status: number; json: any } | null = null;
    for (let i = 0; i < badBearers + 5 && refused === null; i++) {
      const out = await rpc({ name: "schellingaf_whoami", arguments: {} }, addr, unknownBearer());
      if (/RATE_LIMITED/.test(JSON.stringify(out.json))) refused = out;
    }
    assert.ok(refused, `${badBearers + 5} guesses through the connector were all answered`);
    assert.equal(refused!.status, 200, "the connector answered a refusal with a status");
    assert.equal(refused!.json.result.isError, true);
    assert.match(refused!.json.result.content[0].text, /RATE_LIMITED/);

    // The two tools that work without a KEY never ask needsToken, so a bearer
    // presented to one of them would otherwise walk straight past the refusal
    // and into a route.
    const open = await rpc(
      { name: "schellingaf_spaces", arguments: { action: "list" } },
      addr,
      unknownBearer(),
    );
    assert.equal(open.status, 200);
    assert.match(open.json.result.content[0].text, /RATE_LIMITED/);

    // And a caller presenting NO token is not guessing, so it is not held by
    // somebody else's guessing from the same address. That is the rule the
    // per-KEY challenge bucket was moved to obey, and it holds here too.
    const none = await rpc({ name: "schellingaf_spaces", arguments: { action: "list" } }, addr);
    assert.equal(none.status, 200);
    assert.doesNotMatch(none.json.result.content[0].text, /RATE_LIMITED/);
  });

  test("and it writes one line to the evidence log, not two", async () => {
    // The route a tool reaches writes the line; the connector, which classifies a
    // bearer of its own, must not write a second, emptier copy of it for every
    // tool call, into the file that shares a disk with the backup repository.
    resetReadWindows();
    const dir = mkdtempSync(path.join(tmpdir(), "load-limits-log-"));
    try {
      const logged = createApp({ ...config, logDir: dir }, db);
      const res = await toolCall(
        logged,
        { name: "schellingaf_whoami", arguments: {} },
        { Authorization: `Bearer ${owner.token}`, "X-Forwarded-For": "203.0.113.74" },
      );
      assert.equal(res.status, 200, await res.text());
      // The append is deliberately never awaited into the response path.
      await new Promise((r) => setTimeout(r, 120));
      const written = readdirSync(dir)
        .filter((f) => f.startsWith("requests-"))
        .flatMap((f) => readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean))
        .map((l) => JSON.parse(l) as { path?: string });
      assert.deepEqual(
        written.map((l) => l.path),
        ["/v1/me"],
        "the connector wrote a line of its own beside the one the route already wrote",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one tool call pays one share of the read ceilings, not two", async () => {
    // Every tool reaches the real route through an in-process request, which
    // meets the same middleware. Unmarked, that request takes a second global
    // slot while the outer one is still held — a deadlock waiting for a busy
    // moment — and a second of an anonymous caller's two concurrent reads. So
    // an anonymous caller's connector call would have refused itself.
    resetReadWindows();
    const addr = "203.0.113.73";
    const out = await rpc({ name: "schellingaf_spaces", arguments: { action: "list" } }, addr);
    assert.equal(out.status, 200);
    assert.equal(out.json.result?.isError, undefined, JSON.stringify(out.json).slice(0, 400));
    assert.equal(
      withinReadWindow(`addr:${addr}`, 2).allowed,
      true,
      "one connector call spent two of the caller's reads",
    );
  });

  test("a tool call holds its place in the global gate until its tool has finished", async () => {
    // The transport answers a tool call with an event stream and runs the tool
    // into it after the handler has returned, so the place was given back while
    // the tool's queries were still running: with a gate of one place, an
    // unrelated read was served in 13 ms beside a connector SEEK still inside
    // its transaction. See whenSettled in app.ts.
    const hold = holdingSeeks(db);
    const gated = appWithGate(1, 8, 300, hold.db);
    const [searcher, reader] = [await agent(), await agent()];
    resetReadWindows();
    const pending = toolCall(gated, { name: "schellingaf_seek", arguments: { q: "aarch64" } }, { Authorization: `Bearer ${searcher.token}` });
    await until(() => hold.held() === 1);
    assert.equal(hold.held(), 1, "the connector's search never reached its transaction");

    const probe = await gated.request("/v1/spaces/floor-space", bearer(reader.token));
    await probe.text();
    hold.release();
    await (await pending).text();
    assert.equal(probe.status, 429, "a read was served from the gate's only place while a connector tool was still running in it");

    // And the place came back once the tool finished.
    const after = await gated.request("/v1/spaces/floor-space", bearer(reader.token));
    await after.text();
    assert.equal(after.status, 200, "the connector call never gave its place back");
  });

  test("and its caller's share of the moment, the same way", async () => {
    // Two anonymous reads at once per address. Released when the handler
    // returned, the share let one address run as many connector reads at once
    // as it cared to open.
    const hold = holdingReads(db, (text) => text.includes("schellingaf.space_heads"));
    const gated = appWithGate(24, 64, 1000, hold.db);
    resetReadWindows();
    resetInFlightReads();
    const addr = { "X-Forwarded-For": "203.0.113.99" };
    const list = { name: "schellingaf_spaces", arguments: { action: "list" } };
    const first = [toolCall(gated, list, addr), toolCall(gated, list, addr)];
    await until(() => hold.held() === CONCURRENT_READS_PER_ANON);
    assert.equal(hold.held(), CONCURRENT_READS_PER_ANON, "the fixture's connector reads never reached their transactions");

    const third = toolCall(gated, list, addr);
    const outcome = await Promise.race([third.then((r) => r.status), sleep(1000).then(() => "still running")]);
    hold.release();
    for (const r of await Promise.all([...first, third])) await r.text();
    assert.equal(outcome, 503, `a third connector read from one address ran beside the two it may have: ${outcome}`);
  });

  test("a JSON-RPC batch is refused before any tool in it runs", async () => {
    // The reentry marker exempts a tool's in-process call from every ceiling,
    // which is safe only while one /mcp request means one tool call; a batch
    // would buy thousands of queries for the price of one read. The refusal is decided on the body before the
    // SDK is reached, so the proof is that nothing answered the batch.
    resetReadWindows();
    resetInFlightReads();
    const batch = Array.from({ length: 50 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: "schellingaf_spaces", arguments: { action: "list" } },
    }));
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "X-Forwarded-For": "203.0.113.97",
      },
      body: JSON.stringify(batch),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 400, "a batch reached the SDK");
    assert.equal(body.error?.code, -32600);
    assert.equal(Array.isArray(body), false, "the batch was answered element by element");

    // And a single request still works after it, so the body was not left spent.
    const one = await rpc({ name: "schellingaf_spaces", arguments: { action: "list" } }, "203.0.113.97");
    assert.equal(one.status, 200);
    assert.equal(one.json.result?.isError, undefined, JSON.stringify(one.json).slice(0, 400));
  });

  test("a load refusal on the connector is a status, and a token problem still is not", async () => {
    // The file's rule is that a token problem is rendered as tool output, so a
    // client never mistakes a stale token for a dead server. A load refusal is a
    // different statement — the service or this caller is full — and it is
    // allowed to be a status, because that is true. Pinned so the difference is
    // a decision rather than an accident: the anonymous share is filled directly,
    // which makes the refusal certain rather than a race.
    resetReadWindows();
    resetInFlightReads();
    const addr = "203.0.113.98";
    const releases = Array.from({ length: CONCURRENT_READS_PER_ANON }, () =>
      holdRead(readKey(fromAddress(addr), null), CONCURRENT_READS_PER_ANON),
    );
    try {
      const res = await toolCall(app, { name: "schellingaf_spaces", arguments: { action: "list" } }, { "X-Forwarded-For": addr });
      await res.text();
      assert.equal(res.status, 503, "a connector caller over its own share was not told so");
    } finally {
      for (const release of releases) release();
    }
  });
});

// ── free text, on both routes that take it ──────────────────────────────────

describe("the SPACE directory bounds its search term the way SEEK does", () => {
  // The directory answers a caller holding no KEY, so its term is held to the
  // same three caps SEEK applies before it reaches `websearch_to_tsquery`.
  const both = (query: string) => [
    { path: `/v1/spaces?q=${encodeURIComponent(query)}`, token: null as string | null },
    { path: `/v1/seek?q=${encodeURIComponent(query)}`, token: owner.token },
  ];

  const refusals = async (query: string) => {
    const out: { path: string; status: number; detail: string }[] = [];
    for (const one of both(query)) {
      const res = await call("GET", one.path, one.token);
      out.push({ path: one.path, status: res.status, detail: res.body?.error?.detail ?? "" });
    }
    return out;
  };

  test("a term over the byte cap is refused on both", async () => {
    for (const r of await refusals("a".repeat(QUERY_BYTES + 1))) {
      assert.equal(r.status, 400, `${r.path} accepted ${QUERY_BYTES + 1} bytes`);
      assert.match(r.detail, /1 to 1024 bytes/, r.path);
    }
  });

  test("more terms than the cap is refused on both", async () => {
    const many = Array.from({ length: QUERY_TERMS + 1 }, (_, i) => `term${i}`).join(" ");
    for (const r of await refusals(many)) {
      assert.equal(r.status, 400, `${r.path} accepted ${QUERY_TERMS + 1} terms`);
      assert.equal(r.detail, "q is at most 16 terms", r.path);
    }
  });

  test("one term that expands past the node ceiling is refused on both", async () => {
    // The term count is not a measure of cost. A hyphen chain is a single
    // whitespace term and well inside the byte cap, and it costs a node per
    // part per space, which is what MAX_QUERY_NODES bounds.
    // Three hundred distinct short parts: under the byte cap, one whitespace
    // term, and past the node ceiling once the parser expands it.
    const chain = Array.from({ length: 300 }, (_, i) => i.toString(36)).join("-");
    assert.ok(Buffer.byteLength(chain) <= QUERY_BYTES, "the fixture itself is over the byte cap");
    assert.equal(chain.split(/\s+/).length, 1, "the fixture is not one term");
    for (const r of await refusals(chain)) {
      assert.equal(r.status, 400, `${r.path} evaluated a query past ${MAX_QUERY_NODES} nodes`);
      assert.match(r.detail, /too large to evaluate/, r.path);
    }
  });

  test("an empty or blank search box on the directory is the directory, not a refusal", async () => {
    // What a search form submitted empty sends, and the website's own directory
    // sends exactly that. The answer is the whole directory: neither a refusal nor
    // an empty page.
    for (const query of ["", "   "]) {
      const res = await call("GET", `/v1/spaces?q=${encodeURIComponent(query)}`, null);
      assert.equal(res.status, 200, `q=${JSON.stringify(query)} was refused: ${JSON.stringify(res.body).slice(0, 200)}`);
      assert.ok(
        res.body.items.some((space: any) => space.name === "floor-space"),
        `q=${JSON.stringify(query)} answered a page without the spaces the directory has`,
      );
    }
  });

  test("an ordinary search is untouched on both", async () => {
    for (const r of await refusals("aarch64 numpy")) {
      assert.equal(r.status, 200, `${r.path} refused an ordinary search: ${r.detail}`);
    }
  });

  test("and a query the parser cannot read is still the caller's fault, not a 500", async () => {
    // The refusal is raised inside the conversion, so counting nodes cannot catch
    // it; `parse_query` turns it into the caller's error.
    const res = await call("GET", `/v1/spaces?q=${"-".repeat(40)}`, null);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_REQUEST");
    assert.match(res.body.error.detail, /could not be read as a search/);
  });
});

// ── a limit the environment sets ────────────────────────────────────────────

describe("a limit set to something that is not a number is its default", () => {
  // NaN compares false against everything, so a limit read with a bare Number()
  // from "256M" was no limit at all, and one read from "" was zero: closed.
  const readers: [string, () => number][] = [
    ["REGISTRATION_BURST", () => LIMITS.registration("203.0.113.1").capacity],
    ["CHALLENGE_PER_KEY", () => LIMITS.challengeForKey("ab".repeat(32), "203.0.113.1").capacity],
    ["APP_CONNECTION_BURST", () => LIMITS.appConnections("203.0.113.1").capacity],
  ];

  function withEnv(name: string, value: string | undefined, fn: () => number): number {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  }

  for (const [name, limit] of readers) {
    test(name, () => {
      const fallback = withEnv(name, undefined, limit);
      for (const value of ["", "   ", "256M", "undefined", "Infinity"]) {
        assert.equal(withEnv(name, value, limit), fallback, `${name}=${JSON.stringify(value)}`);
      }
      assert.equal(withEnv(name, "3", limit), 3, `${name}=3 is three`);
    });
  }
});

// ── SEEK's idea of who a caller is ──────────────────────────────────────────

describe("SEEK does not key a caller with no KEY on one word", () => {
  test("two KEYS seeking at the same moment do not refuse each other", async () => {
    // The live half of the same property, and the guard on the rewiring: one
    // caller may hold one of SEEK's slots, and the caller is the KEY.
    const other = await agent();
    const [mine, theirs] = await Promise.all([
      call("GET", "/v1/seek?q=aarch64", owner.token),
      call("GET", "/v1/seek?q=aarch64", other.token),
    ]);
    assert.equal(mine.status, 200, "two KEYS seeking at once refused one of them");
    assert.equal(theirs.status, 200, "two KEYS seeking at once refused one of them");
  });
});

describe("SEEK leaves the rest of the service to everybody else", () => {
  test("its ceiling is at most half the read pool, whatever the machine", () => {
    // Searches holding every read connection make every other read wait behind
    // them. See seekCeiling.
    assert.ok(
      CONCURRENT_SEEKS <= READ_POOL / 2,
      `${CONCURRENT_SEEKS} searches may hold that many of ${READ_POOL} read connections`,
    );
    for (const cores of [1, 2, 4, 8, 16, 64, 256]) {
      const ceiling = seekCeiling(cores);
      assert.ok(ceiling >= 2 && ceiling <= READ_POOL / 2, `${cores} cores gave a ceiling of ${ceiling}`);
      assert.ok(ceiling <= Math.max(2, cores / 2), `${cores} cores gave ${ceiling} searches, more than half of them`);
    }
  });

  /** Every SEEK slot held, three more searches waiting for one, then one
   * unrelated read. It must get the gate's one free place. */
  async function crowd(search: (app: App, token: string) => Response | Promise<Response>) {
    const hold = holdingSeeks(db);
    const gated = appWithGate(CONCURRENT_SEEKS + 1, 64, 1000, hold.db);
    const keys = await Promise.all(Array.from({ length: CONCURRENT_SEEKS + 3 }, () => agent()));
    const reader = await agent();
    resetReadWindows();

    const running = keys.slice(0, CONCURRENT_SEEKS).map((k) => Promise.resolve(search(gated, k.token)));
    await until(() => hold.held() === CONCURRENT_SEEKS);
    assert.equal(hold.held(), CONCURRENT_SEEKS, "the searches never reached their transactions");
    const waiting = keys.slice(CONCURRENT_SEEKS).map((k) => Promise.resolve(search(gated, k.token)));
    // Long enough for the three to pass the gate, look up their tokens and join
    // SEEK's own queue; they then wait there until the held ones are released.
    await sleep(150);

    const started = performance.now();
    const probe = await gated.request("/v1/spaces/floor-space", bearer(reader.token));
    const probeMs = performance.now() - started;
    const probeStatus = probe.status;
    await probe.text();

    hold.release();
    const answers = await Promise.all([...running, ...waiting]);
    for (const answer of answers) await answer.text();
    return { probeStatus, probeMs, statuses: answers.map((a) => a.status), gated, reader };
  }

  test("searches waiting for a SEEK slot hold no place in the global gate", async () => {
    // Every waiting search held a place while touching no connection, so enough
    // KEYS searching at once filled the gate with waiters: with forty of them,
    // unrelated reads took a second at the 95th percentile and dozens were
    // refused, at any SEEK ceiling. See FloorPlace in app.ts.
    const out = await crowd((gated, token) => gated.request("/v1/seek?q=aarch64", bearer(token)));
    assert.equal(out.probeStatus, 200, `an unrelated read was refused while searches waited for a SEEK slot`);
    assert.ok(out.probeMs < 500, `an unrelated read waited ${Math.round(out.probeMs)} ms behind searches that were only waiting`);
    assert.deepEqual(out.statuses, out.statuses.map(() => 200), "a search was refused on the way back into the gate");
    // And the places all came back, once each.
    const again = await Promise.all(
      Array.from({ length: CONCURRENT_SEEKS + 1 }, () => out.gated.request("/v1/spaces/floor-space", bearer(out.reader.token))),
    );
    for (const answer of again) await answer.text();
    assert.deepEqual(again.map((a) => a.status), again.map(() => 200), "global places leaked");
  });

  test("and neither does a search the connector makes", async () => {
    const out = await crowd((gated, token) =>
      toolCall(gated, { name: "schellingaf_seek", arguments: { q: "aarch64" } }, { Authorization: `Bearer ${token}` }),
    );
    assert.equal(out.probeStatus, 200, "an unrelated read was refused while connector searches waited for a SEEK slot");
    assert.ok(out.probeMs < 500, `an unrelated read waited ${Math.round(out.probeMs)} ms behind connector searches`);
  });
});
