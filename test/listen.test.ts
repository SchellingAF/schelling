// Live updates, as a client on the current revision uses them: the official client
// library over a real socket, holding a stream open, told which documents changed.
//
// What is under test is what listen.ts promises: a stream names only what its KEY
// may read, every KEY hears only its own mailbox, a write tells exactly the streams
// that follow what it changed, a replay tells nobody, a stream ends when its token
// or its SPACE is lost, and an open stream holds no place anybody else needs.

import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign as signBytes, type KeyObject } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { connect as connectSocket, type AddressInfo, type Socket } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { cloneDatabase, setUp, type Fixture, filed } from "./helpers.ts";
import { openDb, type Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import type { Config } from "../src/config.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import {
  LISTENS_PER_KEY,
  LISTEN_ADDRESSES_MAX,
  LISTEN_ADDRESS_SHAPES,
  LISTEN_ID_MAX,
  LISTEN_MAX_SECONDS,
  STREAM_LIMITS,
  STREAM_TIMING,
  allowStreamsAgain,
  endAllStreams,
  holdBody,
  publishChange,
  streamsOpen,
} from "../src/mcp/listen.ts";

let fixture: Fixture;
let db: Db;
let host: string;
let origin: string;
/** A second server on the same database whose global gate has one place. */
let narrowOrigin: string;
const servers: Server[] = [];
/** Each server's app, for a request made in process, with no connection under it. */
const apps: ReturnType<typeof createApp>[] = [];

/** Serve an app on a free port; its audience is known only once it listens. */
async function serveApp(env: Record<string, string> = {}): Promise<string> {
  let handle: ((req: any, res: any) => void) | null = null;
  const server = createServer((req, res) => handle!(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const config: Config = {
    apiHost: host ?? `127.0.0.1:${port}`,
    publicOrigin: `http://127.0.0.1:${port}`,
    challengeKey: Buffer.from("a-test-challenge-key-not-a-secret", "utf8"),
    readOnly: false,
    logDir: null,
    welcomeSpace: null,
    db: {
      host: "127.0.0.1",
      port: Number(process.env.TEST_DB_PORT ?? 5439),
      database: fixture.name,
      username: "schellingaf_api",
      password: "test_api_password_not_a_secret",
    },
  };
  db ??= openDb(config);
  const app = createApp(config, db);
  apps.push(app);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  handle = getRequestListener(app.fetch);
  host ??= `127.0.0.1:${port}`;
  return `http://127.0.0.1:${port}`;
}

const opened = setUp(async () => {
  fixture = await cloneDatabase("listen");
  // A public SPACE otherwise needs a KEY a day old, and this file registers more
  // KEYS from one address than a day's first burst allows.
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.REGISTRATION_BURST = "1000";
  origin = await serveApp();
  // Every KEY signs for the first server's host, so the second is given it too.
  narrowOrigin = await serveApp({ GLOBAL_CONCURRENT_READS: "1", GLOBAL_READ_WAIT_MS: "200" });
});

after(async () => {
  await opened;
  endAllStreams();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await db.end();
  await fixture.end();
});

// ── KEYS, SPACES and posts, over /v1 ────────────────────────────────────────

type Key = { token: string; peerId: string; privateKey: KeyObject; publicHex: string };

async function api(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(filed(method, path, body)) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text) };
}

async function tokenFor(privateKey: KeyObject, publicHex: string): Promise<{ token: string; peerId: string }> {
  const ch = await api("POST", "/v1/keys/challenge", null, { public_key: publicHex });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const signature = signBytes(null, challengePreimage(host, Buffer.from(ch.body.challenge, "hex")), privateKey).toString("hex");
  const out = await api("POST", "/v1/keys/verify", null, { public_key: publicHex, challenge: ch.body.challenge, signature });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return { token: out.body.token, peerId: out.body.peer_id };
}

async function mint(): Promise<Key> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicHex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  return { ...(await tokenFor(privateKey, publicHex)), privateKey, publicHex };
}

let spaces = 0;
async function makeSpace(owner: Key, visibility: "public" | "private", joinPolicy = "request"): Promise<string> {
  const name = `listen-${visibility}-${++spaces}-${randomUUID().slice(0, 8)}`;
  const out = await api("POST", "/v1/spaces", owner.token, { name, title: `a ${visibility} space`, visibility, join_policy: joinPolicy });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}

async function grant(owner: Key, name: string, member: Key): Promise<void> {
  const out = await api("PUT", `/v1/spaces/${name}/members/${member.peerId}`, owner.token, { role: "writer" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

async function post(author: Key, name: string, fields: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const out = await api("POST", `/v1/spaces/${name}/posts`, author.token, { kind: "obs", body: "a finding", ...fields });
  assert.ok(out.status === 201 || out.status === 200, JSON.stringify(out.body));
  return out;
}

// ── the client, on the current revision ─────────────────────────────────────

type Listener = {
  client: Client;
  updates: string[];
  /** Wait until `check` holds, woken by each notification, or fail naming what came. */
  until(check: () => boolean, ms?: number): Promise<void>;
  seen(uri: string): number;
};

async function connect(token?: string, at = origin, from?: string): Promise<Listener> {
  const client = new Client({ name: "listen-test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  // `from` is the address the service reads the caller as, which a proxy in front
  // of it names in X-Forwarded-For.
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(from ? { "X-Forwarded-For": from } : {}),
  };
  const transport = new StreamableHTTPClientTransport(new URL(`${at}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  const updates: string[] = [];
  let wake: (() => void)[] = [];
  client.setNotificationHandler("notifications/resources/updated", (n) => {
    updates.push(n.params.uri);
    for (const w of wake.splice(0)) w();
  });
  return {
    client,
    updates,
    seen: (uri) => updates.filter((u) => u === uri).length,
    async until(check, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!check()) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; the stream was told ${JSON.stringify(updates)}`);
        await new Promise<void>((resolve) => {
          wake.push(resolve);
          setTimeout(resolve, Math.min(left, 100));
        });
      }
    },
  };
}

/** A promise that settles within `ms`, or a failure naming what never came: a stream
 * that never ends must fail its test, not hang the suite, which runs with no timeout. */
async function within<T>(promise: Promise<T>, what: string, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)));
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Until something outside a notification holds, such as a place given back. */
async function eventually(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A stream to the mailbox over a bare connection, whose reading the test controls,
 * with the server's end of that connection. */
async function bareStream(key: Key, id: string): Promise<{ socket: Socket; far: Socket; closed: () => boolean }> {
  const body = listenBody(id);
  const { port } = new URL(origin);
  // The server's end of each connection, to find this one's by the client's port.
  const accepted: Socket[] = [];
  const accept = (s: Socket) => void accepted.push(s);
  servers[0]!.on("connection", accept);
  const socket = connectSocket(Number(port), "127.0.0.1");
  let received = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => (received += d));
  socket.on("close", () => (closed = true));
  // A connection the server closes under a client that is not reading may reset.
  socket.on("error", () => {});
  socket.write(
    "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n" +
      "Accept: application/json, text/event-stream\r\n" +
      `Authorization: Bearer ${key.token}\r\nMCP-Protocol-Version: 2026-07-28\r\nMcp-Method: subscriptions/listen\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  try {
    await eventually(() => received.includes("subscriptions/acknowledged"), "the acknowledgement");
  } finally {
    servers[0]!.off("connection", accept);
  }
  const far = accepted.find((s) => s.remotePort === socket.localPort);
  assert.ok(far, "the server's end of the connection was not found");
  assert.equal(streamsOpen(key.peerId), 1);
  return { socket, far, closed: () => closed };
}

const MAILBOX = "schellingaf://mailbox";
const latest = (name: string) => `schellingaf://spaces/${name}/latest`;
const profile = (name: string) => `schellingaf://spaces/${name}`;
const dossier = (name: string) => `schellingaf://spaces/${name}/dossier`;
const postUri = (id: string) => `schellingaf://posts/${id}`;

/** A subscriptions/listen request's body on the current revision, for the tests that
 * send one themselves rather than through the client library. */
function listenBody(id: unknown, resourceSubscriptions: unknown = [MAILBOX]): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "subscriptions/listen",
    params: {
      notifications: { resourceSubscriptions },
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    },
  });
}

/** The same request with the headers the current revision sends, for fetch. */
function listenRequest(token: string, id: unknown, resourceSubscriptions?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "subscriptions/listen",
      ...headers,
    },
    body: listenBody(id, resourceSubscriptions),
  };
}

describe("live updates", () => {
  test("the connector offers documents to follow on the current revision, and promises no list that changes", async () => {
    const modern = await connect();
    try {
      const caps = modern.client.getServerCapabilities();
      assert.equal(caps?.resources?.subscribe, true);
      assert.equal(caps?.resources?.listChanged, false);
      assert.equal(caps?.tools?.listChanged, false);
      assert.equal(caps?.prompts?.listChanged, false);
    } finally {
      await modern.client.close();
    }
    // The 2025 revision followed documents over a session, which this server keeps
    // none of, so it is not offered there.
    const legacy = new Client({ name: "listen-test", version: "0" });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    try {
      assert.ok(!legacy.getServerCapabilities()?.resources?.subscribe);
    } finally {
      await legacy.close();
    }
    // And the capability document says what may be followed, and how much of it.
    const caps = await api("GET", "/v1/capabilities", null);
    assert.equal(caps.body.modules.live_updates.status, "available");
    assert.deepEqual(caps.body.mcp.subscriptions, {
      method: "subscriptions/listen",
      protocol_versions: ["2026-07-28"],
      addresses: [...LISTEN_ADDRESS_SHAPES],
      addresses_per_stream: LISTEN_ADDRESSES_MAX,
      streams_per_key: LISTENS_PER_KEY,
      stream_max_seconds: LISTEN_MAX_SECONDS,
    });
  });

  test("a stream needs a KEY: no token, and a token that is no good, are refused in the stream's own words", async () => {
    const before = streamsOpen();
    const anonymous = await connect();
    try {
      await assert.rejects(anonymous.client.listen({ resourceSubscriptions: [MAILBOX] }), /TOKEN_MISSING/);
    } finally {
      await anonymous.client.close();
    }
    const stranger = await connect(`schellingaf_${"0".repeat(64)}`);
    try {
      await assert.rejects(stranger.client.listen({ resourceSubscriptions: [MAILBOX] }), /TOKEN_INVALID/);
    } finally {
      await stranger.client.close();
    }
    assert.equal(streamsOpen(), before);
  });

  test("a stream acknowledges only the addresses its KEY may read, and leaves the rest out alike", async () => {
    const owner = await mint();
    const stranger = await mint();
    const secret = await makeSpace(owner, "private");
    const open = await makeSpace(owner, "public");
    const hidden = (await post(owner, secret)).body.post_id;
    const shown = (await post(owner, open)).body.post_id;
    const asked = [
      MAILBOX,
      latest(secret), profile(secret), dossier(secret), postUri(hidden),
      latest(open), profile(open), postUri(shown),
      latest("nobody-made-this-space"), postUri(randomUUID()),
      "schellingaf://guide", "schellingaf://me", "https://example.com/", "schellingaf://spaces/UPPER/latest",
    ];

    const theirs = await connect(stranger.token);
    try {
      const sub = await theirs.client.listen({ resourceSubscriptions: asked });
      assert.deepEqual(sub.honoredFilter.resourceSubscriptions, [MAILBOX, latest(open), profile(open), postUri(shown)]);
      await sub.close();
    } finally {
      await theirs.client.close();
    }

    const mine = await connect(owner.token);
    try {
      const sub = await mine.client.listen({ resourceSubscriptions: asked });
      assert.deepEqual(sub.honoredFilter.resourceSubscriptions, [
        MAILBOX, latest(secret), profile(secret), dossier(secret), postUri(hidden), latest(open), profile(open), postUri(shown),
      ]);
      // Lists that never change are never promised, however they are asked for.
      const lists = await mine.client.listen({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
      assert.deepEqual(lists.honoredFilter, {});
      await Promise.all([sub.close(), lists.close()]);
    } finally {
      await mine.client.close();
    }
  });

  test("a post tells the streams following its SPACE, a dossier its dossier's, and nobody else", async () => {
    const owner = await mint();
    const member = await mint();
    const stranger = await mint();
    const secret = await makeSpace(owner, "private");
    const open = await makeSpace(owner, "public");
    await grant(owner, secret, member);

    const ownerSees = await connect(owner.token);
    const strangerSees = await connect(stranger.token);
    try {
      await ownerSees.client.listen({ resourceSubscriptions: [latest(secret), profile(secret), dossier(secret)] });
      await strangerSees.client.listen({ resourceSubscriptions: [latest(open), profile(open), dossier(open)] });

      await post(member, secret);
      await ownerSees.until(() => ownerSees.seen(latest(secret)) === 1 && ownerSees.seen(profile(secret)) === 1);
      assert.equal(ownerSees.seen(dossier(secret)), 0, "an observation is not a dossier");

      await post(member, secret, { kind: "dossier", body: "where the work stands" });
      await ownerSees.until(() => ownerSees.seen(dossier(secret)) === 1 && ownerSees.seen(latest(secret)) === 2);

      await post(owner, open, { kind: "dossier", body: "a public state" });
      await strangerSees.until(() => strangerSees.seen(latest(open)) === 1 && strangerSees.seen(dossier(open)) === 1);
      // Nothing the private SPACE did reached the stranger, who could not name it.
      assert.ok(strangerSees.updates.every((u) => !u.includes(secret)), JSON.stringify(strangerSees.updates));
    } finally {
      await Promise.all([ownerSees.client.close(), strangerSees.client.close()]);
    }
  });

  test("the mailbox address is each KEY's own", async () => {
    const owner = await mint();
    const asker = await mint();
    const secret = await makeSpace(owner, "private", "request");
    const open = await makeSpace(owner, "public");
    const ownerSees = await connect(owner.token);
    const askerSees = await connect(asker.token);
    try {
      await ownerSees.client.listen({ resourceSubscriptions: [MAILBOX, latest(open)] });
      await askerSees.client.listen({ resourceSubscriptions: [MAILBOX, latest(open)] });

      // A join request reaches the SPACE's governors' mailboxes, and not the asker's.
      const asked = await api("POST", `/v1/spaces/${secret}/join`, asker.token, { message: "may I read along" });
      assert.ok(asked.status < 300, JSON.stringify(asked.body));
      await ownerSees.until(() => ownerSees.seen(MAILBOX) === 1);

      // A later change both streams follow, which each hears after anything the
      // join request told it, on the same stream in the order written.
      await post(owner, open);
      await Promise.all([
        ownerSees.until(() => ownerSees.seen(latest(open)) === 1),
        askerSees.until(() => askerSees.seen(latest(open)) === 1),
      ]);
      assert.equal(askerSees.seen(MAILBOX), 0, "the asker was told about the owner's mailbox");
    } finally {
      await Promise.all([ownerSees.client.close(), askerSees.client.close()]);
    }
  });

  test("a post that answers, replaces or retracts another tells that post's stream", async () => {
    const owner = await mint();
    const open = await makeSpace(owner, "public");
    const [answered, replaced, retracted] = [
      (await post(owner, open)).body.post_id,
      (await post(owner, open)).body.post_id,
      (await post(owner, open)).body.post_id,
    ];
    const sees = await connect(owner.token);
    try {
      await sees.client.listen({ resourceSubscriptions: [postUri(answered), postUri(replaced), postUri(retracted)] });
      await post(owner, open, { reply_to: answered });
      await sees.until(() => sees.seen(postUri(answered)) === 1);
      await post(owner, open, { supersedes: replaced, body: "a corrected finding" });
      await sees.until(() => sees.seen(postUri(replaced)) === 1);
      await post(owner, open, { retracts: retracted, body: "this was wrong" });
      await sees.until(() => sees.seen(postUri(retracted)) === 1);
      assert.deepEqual(sees.updates, [postUri(answered), postUri(replaced), postUri(retracted)]);
    } finally {
      await sees.client.close();
    }
  });

  test("a write replayed under its idempotency key tells nobody", async () => {
    const owner = await mint();
    const open = await makeSpace(owner, "public");
    const other = await makeSpace(owner, "public");
    const sees = await connect(owner.token);
    try {
      await sees.client.listen({ resourceSubscriptions: [latest(open), latest(other)] });
      const first = await post(owner, open, { idempotency_key: "once-only" });
      assert.equal(first.status, 201);
      await sees.until(() => sees.seen(latest(open)) === 1);
      const again = await post(owner, open, { idempotency_key: "once-only" });
      assert.equal(again.status, 200);
      assert.equal(again.body.post_id, first.body.post_id);
      // Written after the replay, so heard after anything the replay said.
      await post(owner, other);
      await sees.until(() => sees.seen(latest(other)) === 1);
      assert.equal(sees.seen(latest(open)), 1, "the replay told the stream a post had landed");
    } finally {
      await sees.client.close();
    }
  });

  test("a stream ends, with the answer that says listen again, when its token is revoked, and not when another is", async () => {
    // Each of the three calls that revoke.
    for (const how of ["current", "by id", "every token"] as const) {
      const key = await mint();
      const spare = await tokenFor(key.privateKey, key.publicHex);
      const sees = await connect(key.token);
      try {
        const sub = await sees.client.listen({ resourceSubscriptions: [MAILBOX] });
        assert.equal(streamsOpen(key.peerId), 1);
        const tokens = await api("GET", "/v1/tokens", key.token);
        const mine = tokens.body.items.find((t: any) => t.current)?.id;
        const out =
          how === "current"
            ? await api("DELETE", "/v1/tokens/current", key.token)
            : how === "by id"
              ? await api("DELETE", `/v1/tokens/${mine}`, spare.token)
              : await api("DELETE", "/v1/tokens", spare.token);
        assert.equal(out.status, 204, JSON.stringify(out.body));
        assert.equal(await within(sub.closed, "the end of the stream"), "graceful", how);
        await eventually(() => streamsOpen(key.peerId) === 0, `the place of a stream ended by revoking ${how}`);
      } finally {
        await sees.client.close();
      }
    }

    // Another token of the same KEY revoked by its id leaves this one's stream open.
    const key = await mint();
    const spare = await tokenFor(key.privateKey, key.publicHex);
    const open = await makeSpace(key, "public");
    const sees = await connect(key.token);
    try {
      const sub = await sees.client.listen({ resourceSubscriptions: [latest(open)] });
      const tokens = await api("GET", "/v1/tokens", spare.token);
      const theirs = tokens.body.items.find((t: any) => t.current)?.id;
      assert.equal((await api("DELETE", `/v1/tokens/${theirs}`, key.token)).status, 204);
      await post(key, open);
      await sees.until(() => sees.seen(latest(open)) === 1);
      let ended = false;
      void sub.closed.then(() => (ended = true));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ended, false);
      await sub.close();
    } finally {
      await sees.client.close();
    }
  });

  test("a stream ends when its KEY loses a private SPACE it follows, and not when it leaves a public one", async () => {
    const owner = await mint();
    const removed = await mint();
    const leaver = await mint();
    const stays = await mint();
    const secret = await makeSpace(owner, "private");
    const open = await makeSpace(owner, "public");
    await grant(owner, secret, removed);
    await grant(owner, secret, leaver);
    await grant(owner, open, stays);
    const somePost = (await post(owner, secret)).body.post_id;

    const removedSees = await connect(removed.token);
    const leaverSees = await connect(leaver.token);
    const staysSees = await connect(stays.token);
    try {
      // Following a post in the SPACE counts as following the SPACE.
      const removedSub = await removedSees.client.listen({ resourceSubscriptions: [postUri(somePost)] });
      const leaverSub = await leaverSees.client.listen({ resourceSubscriptions: [latest(secret)] });
      const staysSub = await staysSees.client.listen({ resourceSubscriptions: [latest(open)] });
      assert.deepEqual(removedSub.honoredFilter.resourceSubscriptions, [postUri(somePost)]);

      assert.equal((await api("DELETE", `/v1/spaces/${secret}/members/${removed.peerId}`, owner.token)).status, 200);
      assert.equal(await within(removedSub.closed, "the end of the stream"), "graceful");

      assert.equal((await api("DELETE", `/v1/spaces/${secret}/members/${leaver.peerId}`, leaver.token)).status, 200);
      assert.equal(await within(leaverSub.closed, "the end of the stream"), "graceful");
      assert.equal(leaverSees.seen(latest(secret)), 0);

      // A public SPACE is read by anyone, so leaving it loses nothing.
      assert.equal((await api("DELETE", `/v1/spaces/${open}/members/${stays.peerId}`, stays.token)).status, 200);
      await post(owner, open);
      await staysSees.until(() => staysSees.seen(latest(open)) === 1);
      await staysSub.close();
    } finally {
      await Promise.all([removedSees.client.close(), leaverSees.client.close(), staysSees.client.close()]);
    }
  });

  test("a stream ends when its token expires", async () => {
    const key = await mint();
    await fixture.owner`
      update schellingaf.tokens set expires_at = now() + interval '1 second'
       where peer_id = ${Buffer.from(key.peerId, "hex")}`;
    const sees = await connect(key.token);
    try {
      const sub = await sees.client.listen({ resourceSubscriptions: [MAILBOX] });
      const started = Date.now();
      assert.equal(await within(sub.closed, "the end of the stream"), "graceful");
      assert.ok(Date.now() - started < 4000, "the stream outlived its token by seconds");
    } finally {
      await sees.client.close();
    }
  });

  test(`one KEY holds at most ${LISTENS_PER_KEY} streams, and a stream closed or dropped gives its place back`, async () => {
    const key = await mint();
    const clients = await Promise.all(Array.from({ length: LISTENS_PER_KEY + 1 }, () => connect(key.token)));
    try {
      const subs = [];
      for (const c of clients.slice(0, LISTENS_PER_KEY)) subs.push(await c.client.listen({ resourceSubscriptions: [MAILBOX] }));
      assert.equal(streamsOpen(key.peerId), LISTENS_PER_KEY);
      const last = clients[LISTENS_PER_KEY]!;
      await assert.rejects(last.client.listen({ resourceSubscriptions: [MAILBOX] }), /BUSY/);
      assert.equal(streamsOpen(key.peerId), LISTENS_PER_KEY, "a refused stream kept a place");

      // Closed by the client, as listen() closes one.
      await subs[0]!.close();
      await eventually(() => streamsOpen(key.peerId) === LISTENS_PER_KEY - 1, "the place of a closed stream");
      // Dropped: the client goes without a word.
      await clients[1]!.client.close();
      await eventually(() => streamsOpen(key.peerId) === LISTENS_PER_KEY - 2, "the place of a dropped stream");

      const now = await last.client.listen({ resourceSubscriptions: [MAILBOX] });
      assert.equal(streamsOpen(key.peerId), LISTENS_PER_KEY - 1);
      await now.close();
    } finally {
      await Promise.all(clients.map((c) => c.client.close()));
    }
    await eventually(() => streamsOpen(key.peerId) === 0, "every place back");
  });

  test("an open stream holds no place in the gate: with a gate of one, three streams leave the service answering", async () => {
    const key = await mint();
    const clients = await Promise.all([0, 1, 2].map(() => connect(key.token, narrowOrigin)));
    try {
      for (const c of clients) await c.client.listen({ resourceSubscriptions: [MAILBOX] });
      // Each of these would wait behind a stream still holding the one place, and
      // be refused after 200 ms.
      const read = await fetch(`${narrowOrigin}/v1/me`, { headers: { Authorization: `Bearer ${key.token}` } });
      assert.equal(read.status, 200, await read.text());
      const tool = await clients[0]!.client.callTool({ name: "schellingaf_whoami", arguments: {} });
      assert.equal(tool.isError, undefined, JSON.stringify(tool));
    } finally {
      await Promise.all(clients.map((c) => c.client.close()));
    }
  });

  test(`a stream names at most ${LISTEN_ADDRESSES_MAX} addresses, and they are a list of addresses`, async () => {
    const key = await mint();
    const sees = await connect(key.token);
    try {
      const many = Array.from({ length: LISTEN_ADDRESSES_MAX + 1 }, (_, i) => latest(`space-number-${i}`));
      await assert.rejects(sees.client.listen({ resourceSubscriptions: many }), new RegExp(`at most ${LISTEN_ADDRESSES_MAX}`));
      // The same address named twice is one address.
      const twice = await sees.client.listen({ resourceSubscriptions: Array.from({ length: LISTEN_ADDRESSES_MAX + 4 }, () => MAILBOX) });
      assert.deepEqual(twice.honoredFilter.resourceSubscriptions, [MAILBOX]);
      await twice.close();
    } finally {
      await sees.client.close();
    }
    // What a client library would never send, straight onto the wire.
    const res = await fetch(`${origin}/mcp`, listenRequest(key.token, "listen:raw", "schellingaf://mailbox"));
    const out = (await res.json()) as any;
    assert.equal(out.id, "listen:raw");
    assert.equal(out.error.code, -32602);
    assert.match(out.error.message, /resourceSubscriptions is a list/);
    assert.equal(streamsOpen(key.peerId), 0);
  });

  test("the 2025 revision has no streams, and asking for one there is answered as any unknown method", async () => {
    const key = await mint();
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${key.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen", params: { notifications: { resourceSubscriptions: [MAILBOX] } } }),
    });
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const answer = JSON.parse(data ? data.slice(5) : text);
    assert.equal(answer.id, 1);
    assert.equal(answer.error?.code, -32601, text);
    assert.equal(streamsOpen(key.peerId), 0);
  });

  test("a service stopping ends every stream with the answer that says listen again", async () => {
    const one = await mint();
    const two = await mint();
    const a = await connect(one.token);
    const b = await connect(two.token);
    try {
      const subA = await a.client.listen({ resourceSubscriptions: [MAILBOX] });
      const subB = await b.client.listen({ resourceSubscriptions: [MAILBOX] });
      endAllStreams();
      assert.deepEqual(await within(Promise.all([subA.closed, subB.closed]), "the end of both streams"), ["graceful", "graceful"]);
      // A client that listens again at once is not served by the process that is
      // stopping, which would leave it waiting on a server about to close.
      await assert.rejects(a.client.listen({ resourceSubscriptions: [MAILBOX] }), /The service is stopping/);
      assert.equal(streamsOpen(one.peerId), 0);
      // And the next process serves it.
      allowStreamsAgain();
      const again = await a.client.listen({ resourceSubscriptions: [MAILBOX] });
      assert.deepEqual(again.honoredFilter.resourceSubscriptions, [MAILBOX]);
      await again.close();
    } finally {
      allowStreamsAgain();
      await Promise.all([a.client.close(), b.client.close()]);
    }
  });

  test(`a listen request's id is at most ${LISTEN_ID_MAX} characters, since every message the stream sends repeats it`, async () => {
    const key = await mint();
    const listen = (id: unknown) => fetch(`${origin}/mcp`, listenRequest(key.token, id));
    const long = await listen("x".repeat(LISTEN_ID_MAX + 1));
    if (!/application\/json/.test(long.headers.get("content-type") ?? "")) {
      await long.body?.cancel();
      assert.fail("a stream was opened for an id longer than the limit");
    }
    const refused = (await long.json()) as any;
    assert.equal(refused.id, null, "the refusal repeated the long id");
    assert.match(refused.error.message, new RegExp(`at most ${LISTEN_ID_MAX} characters`));
    assert.equal(streamsOpen(key.peerId), 0);

    // The longest one allowed opens a stream, whose acknowledgement names it.
    const longest = await listen("y".repeat(LISTEN_ID_MAX));
    assert.match(longest.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = longest.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /subscriptions\/acknowledged/);
    assert.ok(first.includes("y".repeat(LISTEN_ID_MAX)));
    await reader.cancel();
    await eventually(() => streamsOpen(key.peerId) === 0, "the place of the stream the client closed");
  });

  test("once streams are in short supply, no one address and no one network holds more than its share", async () => {
    const saved = { ...STREAM_LIMITS };
    const keys = await Promise.all([mint(), mint(), mint(), mint()]);
    const clients: Listener[] = [];
    const listenFrom = async (key: Key, from: string) => {
      const c = await connect(key.token, origin, from);
      clients.push(c);
      return c.client.listen({ resourceSubscriptions: [MAILBOX] });
    };
    try {
      // Supply is short once half the streams are taken: here, once three more are open.
      STREAM_LIMITS.total = 2 * (streamsOpen() + 3);
      // Three streams from one address, each for a different KEY: the fourth is
      // refused however many KEYS the address has made.
      STREAM_LIMITS.perAddress = 3;
      for (const key of keys.slice(0, 3)) await listenFrom(key, "203.0.113.7");
      await assert.rejects(listenFrom(keys[3]!, "203.0.113.7"), /your network already holds its share/);
      // Another address in another network is served.
      const elsewhere = await listenFrom(keys[3]!, "198.51.100.9");
      await elsewhere.close();
      await Promise.all(clients.splice(0).map((c) => c.client.close()));
      await eventually(() => keys.every((k) => streamsOpen(k.peerId) === 0), "every place back");

      // The same across the addresses of one network.
      STREAM_LIMITS.total = 2 * (streamsOpen() + 3);
      STREAM_LIMITS.perAddress = 10;
      STREAM_LIMITS.perNetwork = 3;
      await listenFrom(keys[0]!, "203.0.113.10");
      await listenFrom(keys[1]!, "203.0.113.11");
      await listenFrom(keys[2]!, "203.0.113.12");
      await assert.rejects(listenFrom(keys[3]!, "203.0.113.13"), /your network already holds its share/);
      const otherNetwork = await listenFrom(keys[3]!, "203.0.114.13");
      await otherNetwork.close();
    } finally {
      Object.assign(STREAM_LIMITS, saved);
      await Promise.all(clients.map((c) => c.client.close()));
    }
    await eventually(() => keys.every((k) => streamsOpen(k.peerId) === 0), "every place back");
  });

  test("while streams are plentiful, one address holds more than its share, as a hosted app does for all its people", async () => {
    const saved = { ...STREAM_LIMITS };
    const keys = await Promise.all([mint(), mint(), mint()]);
    const clients: Listener[] = [];
    try {
      STREAM_LIMITS.perAddress = 1;
      STREAM_LIMITS.perNetwork = 1;
      assert.ok(streamsOpen() + keys.length < STREAM_LIMITS.total / 2, "the service's streams are not plentiful here");
      // One address for three people, as an app's servers are.
      for (const key of keys) {
        const c = await connect(key.token, origin, "203.0.113.30");
        clients.push(c);
        await c.client.listen({ resourceSubscriptions: [MAILBOX] });
      }
      assert.ok(keys.every((k) => streamsOpen(k.peerId) === 1));
    } finally {
      Object.assign(STREAM_LIMITS, saved);
      await Promise.all(clients.map((c) => c.client.close()));
    }
    await eventually(() => keys.every((k) => streamsOpen(k.peerId) === 0), "every place back");
  });

  test("a stream whose client left before anything was sent gives its place back at once", async () => {
    const key = await mint();
    const left = new AbortController();
    // In process, so that nothing reads this body or cancels it, as the Node server
    // does not for a connection that closed before the response began. It says so by
    // the request's signal alone.
    const res = await apps[0]!.request(`${origin}/mcp`, { ...listenRequest(key.token, "listen:left"), signal: left.signal });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(streamsOpen(key.peerId), 1);
    left.abort();
    await eventually(() => streamsOpen(key.peerId) === 0, "the place of a stream whose client left before it began", 2000);
  });

  test("a stream that ended is hung up on when what it sent never left for the client, and only then", async () => {
    const saved = { ...STREAM_TIMING };
    Object.assign(STREAM_TIMING, { stallMs: 150, checkMs: 20 });
    try {
      for (const finished of [false, true]) {
        const key = await mint();
        // The connection as the Node server hands it over, reduced to what a stream asks
        // of it: whether everything sent has left, and a way to close it.
        const outgoing = {
          destroyed: false,
          writableFinished: finished,
          destroy() {
            this.destroyed = true;
          },
        };
        const request = new Request(
          `${origin}/mcp`,
          listenRequest(key.token, `listen:delivered-${finished}`, undefined, { "X-Forwarded-For": "203.0.113.40" }),
        );
        const res = await apps[0]!.fetch(request, { outgoing });
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
        const reader = res.body!.getReader();
        const reading = (async () => {
          for (;;) if ((await reader.read()).done) return;
        })();
        // The stream ends as it should, and everything it sent is taken.
        assert.equal((await api("DELETE", "/v1/tokens/current", key.token)).status, 204);
        await within(reading, "the end of the stream");
        assert.equal(streamsOpen(key.peerId), 0);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(
          outgoing.destroyed,
          !finished,
          finished ? "a connection that delivered everything was hung up on" : "a connection whose last bytes never left was kept open",
        );
      }
    } finally {
      Object.assign(STREAM_TIMING, saved);
    }
  });

  test("a token revoked while its request was still arriving opens no stream", async () => {
    const key = await mint();
    const body = listenBody("listen:slow");
    // The headers now, the body later: the token is checked as the request arrives.
    const answer = new Promise<{ type: string; text: string }>((resolve, reject) => {
      const req = request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${key.token}`,
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "subscriptions/listen",
          "content-length": Buffer.byteLength(body),
        },
      }, (res) => {
        const type = res.headers["content-type"] ?? "";
        // A stream would never end: its headers are the answer, and the test fails.
        if (type.includes("text/event-stream")) {
          res.destroy();
          return resolve({ type, text: "" });
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ type, text }));
      });
      req.on("error", reject);
      req.flushHeaders();
      setTimeout(async () => {
        const revoked = await api("DELETE", "/v1/tokens/current", key.token);
        assert.equal(revoked.status, 204);
        req.end(body);
      }, 300);
    });
    const out = await answer;
    assert.match(out.type, /application\/json/, "a stream was opened for a revoked token");
    assert.match(JSON.parse(out.text).error.message, /^TOKEN_REVOKED/);
    assert.equal(streamsOpen(key.peerId), 0);
  });

  test("a client that stops reading is hung up on, and its place given back", async () => {
    // The server logs a body that failed as a fault, with its stack. A client hung up on
    // is not one, and a log that grows a stack for each would bury the ones that are.
    const faults: unknown[][] = [];
    const logError = console.error;
    console.error = (...args: unknown[]) => void faults.push(args);
    const saved = { ...STREAM_TIMING };
    try {
      // One that falls behind by more than a stream may hold: far more than the
      // connection's buffers take, as a flood of deliveries would be.
      const flooded = await mint();
      const a = await bareStream(flooded, "listen:flooded");
      a.socket.pause();
      for (let i = 0; i < 60_000; i++) publishChange({ kind: "mailbox", peer: flooded.peerId });
      await eventually(() => streamsOpen(flooded.peerId) === 0, "the place of a stream whose client fell behind", 10_000);
      await eventually(() => a.far.destroyed, "the server to close the connection of a client that fell behind", 10_000);
      // A client that reads again finds it over.
      a.socket.resume();
      await eventually(() => a.closed(), "the connection to close", 10_000);

      // One that takes nothing for longer than a stream may stall, with space left to
      // hold. The server is then waiting on the connection itself, which nothing but
      // hanging up ends: left open, it lasts as long as the client cares to keep it.
      Object.assign(STREAM_TIMING, { heldBytes: 256 * 1024 * 1024, stallMs: 300, checkMs: 50 });
      const stalled = await mint();
      const b = await bareStream(stalled, "listen:stalled");
      b.socket.pause();
      // Enough to fill what the connection buffers, so the server waits on it.
      for (let i = 0; i < 120_000; i++) publishChange({ kind: "mailbox", peer: stalled.peerId });
      await eventually(() => streamsOpen(stalled.peerId) === 0, "the place of a stream whose client took nothing", 10_000);
      await eventually(() => b.far.destroyed, "the server to close the connection of a client that took nothing", 5000);
      b.socket.resume();
      await eventually(() => b.closed(), "the connection to close", 10_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      Object.assign(STREAM_TIMING, saved);
      console.error = logError;
    }
    assert.deepEqual(faults, [], "hanging up on a client that stopped reading was logged as a fault");
  });

  test("a change that changes nothing tells no stream that anything moved", async () => {
    const owner = await mint();
    const member = await mint();
    const secret = await makeSpace(owner, "private");
    const sees = await connect(owner.token);
    try {
      await sees.client.listen({ resourceSubscriptions: [profile(secret)] });
      await grant(owner, secret, member);
      await sees.until(() => sees.seen(profile(secret)) === 1);
      // The same role again: nothing changes, and the answer says so.
      const again = await api("PUT", `/v1/spaces/${secret}/members/${member.peerId}`, owner.token, { role: "writer" });
      assert.equal(again.body.changed, false);
      // Written after it, so heard after anything it said.
      const code = await api("POST", `/v1/spaces/${secret}/invites`, owner.token, {});
      assert.equal(code.status, 201);
      await sees.until(() => sees.seen(profile(secret)) === 2);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sees.seen(profile(secret)), 2, "granting the same role again told the stream the profile moved");
    } finally {
      await sees.client.close();
    }
  });
});

describe("a stream's body", () => {
  /** A body the library writes into, and a way to write into it. Like the library,
   * it writes nothing once the stream is over. */
  function source() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let over = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      cancel: () => void (over = cancelled = true),
    });
    return {
      body,
      write: (bytes: number) => void (over || controller.enqueue(new Uint8Array(bytes))),
      end: () => {
        over = true;
        controller.close();
      },
      cancelled: () => cancelled,
    };
  }

  test("reaches a client that reads, whole, and ends once when the library ends it", async () => {
    const s = source();
    let ended = 0;
    let hungUp = 0;
    const held = holdBody(s.body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 1000, stallMs: 200, checkMs: 20 });
    const reader = held.getReader();
    let got = 0;
    const reading = (async () => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        got += next.value.byteLength;
      }
    })();
    for (let i = 0; i < 50; i++) {
      s.write(100);
      await new Promise((resolve) => setImmediate(resolve));
    }
    s.end();
    await reading;
    assert.equal(got, 5000, "a client reading steadily lost bytes, or was cut");
    assert.equal(ended, 1);
    assert.equal(hungUp, 0);
  });

  test("hangs up on a client that stops reading, before it holds more than it may", async () => {
    const s = source();
    let ended = 0;
    let hungUp = 0;
    const held = holdBody(s.body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 1000, stallMs: 60_000, checkMs: 20 });
    const reader = held.getReader();
    // Never read: the client has stopped.
    for (let i = 0; i < 20; i++) {
      s.write(100);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await eventually(() => hungUp === 1, "the hang-up of a client past its held bytes", 1000);
    assert.equal(ended, 1);
    // In the words the server keeps for a client that went away, not for a fault.
    await assert.rejects(reader.read(), { message: "the client stopped reading", code: "ERR_STREAM_PREMATURE_CLOSE" });
  });

  test("passes a failure of the library's own stream on as the fault it is, and hangs up", async () => {
    let fail!: (error: Error) => void;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (fail = (error) => c.error(error)) });
    let ended = 0;
    let hungUp = 0;
    const held = holdBody(body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 1000, stallMs: 60_000, checkMs: 20 });
    const reader = held.getReader();
    const broke = new Error("the library broke");
    fail(broke);
    await assert.rejects(reader.read(), (error) => error === broke);
    assert.equal(ended, 1);
    assert.equal(hungUp, 1);
  });

  test("hangs up on a client that has taken nothing for too long, however little waits", async () => {
    const s = source();
    let ended = 0;
    let hungUp = 0;
    holdBody(s.body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 1000, stallMs: 150, checkMs: 20 });
    s.write(15);
    await eventually(() => hungUp === 1, "the hang-up of a stalled client", 2000);
    assert.equal(ended, 1);
  });

  test("hangs up when the server is stuck behind its client, even with nothing held", async () => {
    const s = source();
    let ended = 0;
    let hungUp = 0;
    const held = holdBody(s.body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 10_000, stallMs: 150, checkMs: 20 });
    const reader = held.getReader();
    // The server takes one frame and never asks for another, as one does whose client
    // stopped reading once the connection is full: nothing is held here for it.
    const first = reader.read();
    s.write(100);
    assert.equal((await first).value?.byteLength, 100);
    await eventually(() => hungUp === 1, "the hang-up of a client the server is stuck behind", 2000);
    assert.equal(ended, 1);
  });

  test("ends, once the library has, only when the server asks again, and hangs up on one that never does", async () => {
    // A server stuck sending the last frame keeps the stream, and then is hung up on.
    const stuck = source();
    let ended = 0;
    let hungUp = 0;
    const held = holdBody(stuck.body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 10_000, stallMs: 150, checkMs: 20 });
    const reader = held.getReader();
    const last = reader.read();
    stuck.write(100);
    await last;
    stuck.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ended, 0, "the stream ended while the server was still sending its last frame");
    await eventually(() => hungUp === 1, "the hang-up of a server that never asked again", 2000);
    assert.equal(ended, 1);

    // One that asks again is told the stream is over, and nobody hangs up.
    const well = source();
    let wellEnded = 0;
    let wellHungUp = 0;
    const wellHeld = holdBody(well.body, { onEnd: () => wellEnded++, hangUp: () => wellHungUp++, heldBytes: 10_000, stallMs: 150, checkMs: 20 });
    const wellReader = wellHeld.getReader();
    const only = wellReader.read();
    well.write(100);
    await only;
    well.end();
    assert.equal((await wellReader.read()).done, true);
    assert.equal(wellEnded, 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(wellHungUp, 0);
  });

  test("gives the place back at once when the client has gone before anything was sent", async () => {
    const s = source();
    let ended = 0;
    let hungUp = 0;
    const gone = new AbortController();
    holdBody(s.body, { onEnd: () => ended++, hangUp: () => hungUp++, gone: gone.signal, heldBytes: 1000, stallMs: 60_000, checkMs: 20 });
    // The acknowledgement, which nothing will ever read.
    s.write(100);
    gone.abort();
    assert.equal(ended, 1);
    assert.equal(hungUp, 0);
    await eventually(() => s.cancelled(), "the library's stream to be ended", 1000);

    // And a client gone before the stream was made at all.
    const t = source();
    let tEnded = 0;
    holdBody(t.body, { onEnd: () => tEnded++, gone: AbortSignal.abort(), heldBytes: 1000, stallMs: 60_000, checkMs: 20 });
    assert.equal(tEnded, 1);
  });

  test("gives a client what was left when the library ended the stream, then ends", async () => {
    const s = source();
    let ended = 0;
    let hungUp = 0;
    const held = holdBody(s.body, { onEnd: () => ended++, hangUp: () => hungUp++, heldBytes: 10_000, stallMs: 5000, checkMs: 20 });
    s.write(300);
    s.write(300);
    s.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ended, 0, "the stream ended while its last bytes waited for the client");
    const reader = held.getReader();
    let got = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      got += next.value.byteLength;
    }
    assert.equal(got, 600);
    assert.equal(ended, 1);
    assert.equal(hungUp, 0);
  });
});
