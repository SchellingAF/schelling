// How long the server waits while a request arrives (src/http/receive.ts).
//
// Each test runs a small app on @hono/node-server's serve, with receiveOptions as its
// serverOptions and watchBodies on the server it returns, as src/server.ts runs the
// service, and reaches it on a raw socket, so a client can send part of a request and
// stop. The limits are scaled down: headers 1 s, a quiet body 1 s, a whole request 6 s.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { receiveLimits, type ReceiveLimits } from "../src/config.ts";
import { receiveOptions, watchBodies, CONNECTIONS_CHECKING_MS, type BodyWatch } from "../src/http/receive.ts";
import { withEnv } from "./lib/env.ts";

const SCALED = { HTTP_HEADERS_SECONDS: "1", HTTP_BODY_IDLE_SECONDS: "1", HTTP_REQUEST_SECONDS: "6" };
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the route that reads late waits before it reads, and what the slow routes wait
 * after the request arrived: past both the quiet limit and the whole-request limit. */
const READS_AFTER_MS = 3_000;
const ANSWERS_AFTER_MS = 7_000;

function testApp(): Hono {
  const app = new Hono();
  // As the service's routes do: a body that cannot be read is the client's, never a fault.
  const body = (c: { req: { text(): Promise<string> } }) => c.req.text().catch(() => null);
  app.get("/", (c) => c.text("ok"));
  app.post("/echo", async (c) => {
    const text = await body(c);
    return text === null ? c.text("unreadable", 400) : c.json({ bytes: Buffer.byteLength(text) });
  });
  app.post("/late", async (c) => {
    await later(READS_AFTER_MS);
    const text = await body(c);
    return text === null ? c.text("unreadable", 400) : c.json({ bytes: Buffer.byteLength(text) });
  });
  app.post("/slow", async (c) => {
    const text = await body(c);
    await later(ANSWERS_AFTER_MS);
    return c.json({ bytes: text === null ? -1 : Buffer.byteLength(text) });
  });
  app.get("/slow", async (c) => {
    await later(ANSWERS_AFTER_MS);
    return c.text("waited");
  });
  app.onError((error, c) => {
    console.error(error);
    return c.text("fault", 500);
  });
  return app;
}

/** The service's way: serve with the receive options, then the body watch on its server. */
async function running(limits: ReceiveLimits): Promise<{ server: Server; port: number; watch: BodyWatch }> {
  const app = testApp();
  return await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1", serverOptions: receiveOptions({ receive: limits }) }, () =>
      resolve({ server, port: (server.address() as AddressInfo).port, watch }),
    ) as Server;
    const watch = watchBodies(server, limits.bodyIdleSeconds * 1000);
  });
}

/** A raw connection: what it received, and when it closed. */
function raw(port: number) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  socket.setEncoding("latin1");
  socket.on("data", (chunk: string) => (received += chunk));
  socket.on("error", () => {});
  const closed = new Promise<number>((resolve) => socket.on("close", () => resolve(Date.now())));
  const opened = new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return { socket, closed, opened, received: () => received };
}

/** What a connection received once its JSON answer is in, or once it closed. */
async function answer(conn: ReturnType<typeof raw>): Promise<string> {
  let closed = false;
  void conn.closed.then(() => (closed = true));
  while (!closed && !conn.received().includes("}")) await later(20);
  return conn.received();
}

const head = (path: string, length: number) =>
  `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\nContent-Length: ${length}\r\n\r\n`;

async function get(port: number, path: string): Promise<string> {
  const conn = raw(port);
  await conn.opened;
  conn.socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  await conn.closed;
  return conn.received();
}

/** A request whose body stops after 5 of the 1,000 bytes it declares: how long until the
 * server closed the connection, and what it sent. */
async function stalled(port: number): Promise<{ ms: number; received: string }> {
  const conn = raw(port);
  await conn.opened;
  const started = Date.now();
  conn.socket.write(head("/echo", 1000) + "hello");
  const closedAt = await conn.closed;
  return { ms: closedAt - started, received: conn.received() };
}

describe("receiving a request", { concurrency: true, timeout: 20_000 }, () => {
  let limits: ReceiveLimits;
  let server: Server;
  let port: number;
  const errors: unknown[][] = [];
  const consoleError = console.error;

  before(async () => {
    limits = await withEnv(SCALED, () => receiveLimits());
    ({ server, port } = await running(limits));
    console.error = (...args: unknown[]) => void errors.push(args);
  });
  after(async () => {
    console.error = consoleError;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("the server stops waiting for a body that sends nothing for its idle limit", async () => {
    const { ms, received } = await stalled(port);
    const idle = limits.bodyIdleSeconds * 1000;
    assert.ok(ms >= idle - 100, `closed after ${ms} ms, before the idle limit of ${idle} ms`);
    assert.ok(ms <= idle + 1500, `closed after ${ms} ms, past the idle limit of ${idle} ms and its check`);
    assert.equal(received, "", "the connection closes without an answer");
    // The route's read ends as when a client goes away: answered, never logged as a fault.
    await later(200);
    assert.deepEqual(errors, [], "nothing is logged as a fault");
  });

  test("the server stops waiting for headers after its headers limit", async () => {
    const conn = raw(port);
    await conn.opened;
    const started = Date.now();
    conn.socket.write("POST /ec");
    const ms = (await conn.closed) - started;
    const limit = limits.headersSeconds * 1000;
    assert.ok(ms <= limit + CONNECTIONS_CHECKING_MS + 500, `closed after ${ms} ms, past the headers limit of ${limit} ms and its check`);
    assert.ok(conn.received() === "" || conn.received().startsWith("HTTP/1.1 408"), `answered ${JSON.stringify(conn.received())}`);
  });

  test("a body that keeps arriving slowly is read whole", async () => {
    const conn = raw(port);
    await conn.opened;
    const chunk = "x".repeat(8 * 1024);
    conn.socket.write(head("/echo", chunk.length * 8));
    for (let i = 0; i < 8; i++) {
      await later(500);
      conn.socket.write(chunk);
    }
    const answered = await answer(conn);
    conn.socket.destroy();
    assert.match(answered, /^HTTP\/1\.1 200/);
    assert.match(answered, /\{"bytes":65536\}/);
  });

  test("a route that reads its body late still gets it", async () => {
    const conn = raw(port);
    await conn.opened;
    const bytes = 256 * 1024;
    conn.socket.write(head("/late", bytes) + "y".repeat(bytes));
    const answered = await answer(conn);
    conn.socket.destroy();
    assert.match(answered, /^HTTP\/1\.1 200/);
    assert.match(answered, new RegExp(`\\{"bytes":${bytes}\\}`));
  });

  test("the server answers the next request after it stops waiting for one", async () => {
    await stalled(port);
    const answered = await get(port, "/");
    assert.match(answered, /^HTTP\/1\.1 200/);
    assert.match(answered, /ok$/);
  });

  test("an answer that takes longer than every receive limit is still sent", async () => {
    const slowGet = get(port, "/slow");
    const conn = raw(port);
    await conn.opened;
    conn.socket.write(head("/slow", 5).replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n") + "hello");
    await conn.closed;
    assert.match(conn.received(), /^HTTP\/1\.1 200/);
    assert.match(conn.received(), /\{"bytes":5\}/);
    const answered = await slowGet;
    assert.match(answered, /^HTTP\/1\.1 200/);
    assert.match(answered, /waited$/);
  });
});

describe("the body watch", () => {
  test("closing the server stops its body watch", async () => {
    const limits = await withEnv(SCALED, () => receiveLimits());
    const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
    const before = timers();
    const { server, watch } = await running(limits);
    assert.equal(timers(), before, "the watch holds no timer that keeps the process open");
    assert.equal(watch.running, true);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(watch.running, false, "the watch stops when the server closes");
    assert.equal(watch.watching, 0);
  });

  test("the limits are read once, in whole seconds, and the headers limit is never past the request limit", async () => {
    assert.deepEqual(
      await withEnv({ HTTP_HEADERS_SECONDS: undefined, HTTP_BODY_IDLE_SECONDS: undefined, HTTP_REQUEST_SECONDS: undefined }, () => receiveLimits()),
      { headersSeconds: 10, bodyIdleSeconds: 20, requestSeconds: 120 },
    );
    assert.deepEqual(
      await withEnv({ HTTP_HEADERS_SECONDS: "30", HTTP_BODY_IDLE_SECONDS: "0", HTTP_REQUEST_SECONDS: "20" }, () => receiveLimits()),
      { headersSeconds: 20, bodyIdleSeconds: 20, requestSeconds: 20 },
    );
    assert.deepEqual(
      await withEnv({ HTTP_HEADERS_SECONDS: "2.5", HTTP_BODY_IDLE_SECONDS: "20s", HTTP_REQUEST_SECONDS: "Infinity" }, () => receiveLimits()),
      { headersSeconds: 10, bodyIdleSeconds: 20, requestSeconds: 120 },
    );
    assert.deepEqual(receiveOptions({ receive: { headersSeconds: 10, bodyIdleSeconds: 20, requestSeconds: 120 } }), {
      headersTimeout: 10_000,
      requestTimeout: 120_000,
      connectionsCheckingInterval: 2_000,
    });
  });

  test("src/server.ts passes the receive options and watches bodies", () => {
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const call = source.indexOf("serve(");
    assert.ok(call >= 0, "src/server.ts calls serve(");
    const options = source.slice(call, source.indexOf(")", source.indexOf("})", call)) + 1);
    assert.match(options, /serverOptions:\s*receiveOptions\(config\)/, "serve( is passed receiveOptions(config)");
    const watch = source.indexOf("watchBodies(server", call);
    assert.ok(watch > call, "watchBodies(server, ...) follows serve(");
    assert.match(source.slice(watch), /^watchBodies\(server,\s*config\.receive!?\.bodyIdleSeconds \* 1000\)/);
  });
});
