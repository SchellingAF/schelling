// Stopping the service: within a deadline, with every waiting read answered and the
// request log's last lines on disk.
//
// A platform sends SIGTERM and kills the process a grace period later. The stop in
// src/shutdown.ts ends the streams, answers the waiting reads, waits for the requests
// under way, stops the loops, flushes the request log and ends the pools; past
// SHUTDOWN_DEADLINE_SECONDS it exits 1 with one line saying what was still open. The
// last test runs the real process and stops it with SIGTERM.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { useService, config, agent, call } from "./lib/service.ts";
import { API_PASSWORD } from "./bootstrap.ts";
import { requestLog, type Head } from "../src/http/log.ts";
import { allowWaitsAgain, readWaiting, waitingNow } from "../src/http/wait.ts";
import { allowStreamsAgain } from "../src/mcp/listen.ts";
import { openDb } from "../src/db/sql.ts";
import { CHECKPOINT_LOG, CHECKPOINT_LOG_PREVIOUS, startCheckpoints } from "../src/db/checkpoints.ts";
import { developmentServiceKey } from "../src/domain/service.ts";
import { shutdown, shutdownDeadlineSeconds, type Stopping } from "../src/shutdown.ts";
import type { Env } from "../src/http/app.ts";
import { withEnv } from "./lib/env.ts";

useService("shutdown");

const dirs: string[] = [];
const scratch = (label: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `shutdown-${label}-`));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stop with nothing real behind it but what a test hands in, which records the
 *  exit it asks for and lets the suite carry on afterwards, as a new process would. */
async function stop(parts: Partial<Stopping> & Pick<Stopping, "server">): Promise<{ codes: number[]; lines: string[] }> {
  const codes: number[] = [];
  const lines: string[] = [];
  try {
    await shutdown({
      loops: [],
      db: { end: async () => {} },
      deadlineMs: 10_000,
      write: (line) => lines.push(line),
      exit: (code) => codes.push(code),
      ...parts,
    });
  } finally {
    allowStreamsAgain();
    allowWaitsAgain();
  }
  return { codes, lines };
}

/** A real server on a free port for `app`, and its port. */
async function listening(app: Hono<Env>): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  return await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve({ server, port: info.port }));
  });
}

describe("a stop", () => {
  test("goes in order: the server, each loop, the pools, and only then the exit", async () => {
    const order: string[] = [];
    const { codes } = await stop({
      server: { close: (done) => (order.push("server closed"), done()) },
      loops: [
        { name: "a search index upkeep pass", stop: async () => (await later(30), void order.push("upkeep stopped")) },
        { name: "a checkpoint pass", stop: async () => (await later(30), void order.push("checkpoints stopped")) },
      ],
      db: { end: async () => void order.push("pools ended") },
      exit: (code) => order.push(`exit ${code}`),
    });
    assert.deepEqual(codes, []);
    assert.deepEqual(order, ["server closed", "upkeep stopped", "checkpoints stopped", "pools ended", "exit 0"]);
  });

  test("appends the request log's queued lines before it exits", async () => {
    // A line of five megabytes is several write() calls, which no microtask outruns:
    // a stop that did not wait for it would exit with the line half written or not.
    const dir = scratch("flush");
    const app = new Hono<Env>();
    app.use("*", requestLog(dir));
    const heads: Head[] = Array.from({ length: 50_000 }, (_, i) => ({ stream: "mailbox", peer: "ab".repeat(32), mailbox_seq: String(i) }));
    app.post("*", (c) => {
      c.set("requestId", "00000000-0000-4000-8000-000000000000");
      c.get("heads").push(...heads);
      return c.text("ok");
    });
    await app.request("/v1/messages", { method: "POST" });
    let onDisk = "";
    const exits: number[] = [];
    await stop({
      server: { close: (done) => done() },
      exit: (code) => {
        exits.push(code);
        onDisk = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("");
      },
    });
    assert.deepEqual(exits, [0]);
    const written = onDisk.split("\n").filter(Boolean);
    assert.equal(written.length, 1, "the queued line was not on disk when the process exited");
    assert.equal(JSON.parse(written[0]!).heads.length, heads.length);
  });

  test("appends the request log's queued lines when a step fails, and when the deadline passes", async () => {
    // The same five-megabyte line, queued just before a stop that cannot finish: one
    // whose loop fails, and one whose loop never ends and whose deadline is a
    // millisecond away. Each exits 1, and each with the line on disk.
    const ends: { label: string; parts: Partial<Stopping> }[] = [
      { label: "failed", parts: { loops: [{ name: "a pass that fails", stop: async () => { throw new Error("the pass failed"); } }] } },
      { label: "deadline", parts: { loops: [{ name: "a pass that never ends", stop: () => new Promise<void>(() => {}) }], deadlineMs: 1 } },
    ];
    for (const { label, parts } of ends) {
      const dir = scratch(`flush-${label}`);
      const app = new Hono<Env>();
      app.use("*", requestLog(dir));
      const heads: Head[] = Array.from({ length: 50_000 }, (_, i) => ({ stream: "mailbox", peer: "ab".repeat(32), mailbox_seq: String(i) }));
      app.post("*", (c) => {
        c.set("requestId", "00000000-0000-4000-8000-000000000000");
        c.get("heads").push(...heads);
        return c.text("ok");
      });
      await app.request("/v1/messages", { method: "POST" });
      let onDisk = "";
      const lines: string[] = [];
      let exited!: (code: number) => void;
      const exit = new Promise<number>((resolve) => (exited = resolve));
      // Not awaited: a stop whose loop never ends never resolves, as in a process
      // the deadline ends.
      void shutdown({
        server: { close: (done) => done() },
        db: { end: async () => {} },
        deadlineMs: 10_000,
        ...parts,
        write: (line) => lines.push(line),
        exit: (code) => {
          onDisk = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("");
          exited(code);
        },
      } as Stopping);
      try {
        await exit;
      } finally {
        allowStreamsAgain();
        allowWaitsAgain();
      }
      assert.equal(await exit, 1, label);
      assert.match(lines[0] ?? "", label === "failed" ? /^shutdown: failed: the pass failed\n$/ : /^shutdown: not finished after 0\.001 s, with a pass that never ends/, label);
      const written = onDisk.split("\n").filter(Boolean);
      assert.equal(written.length, 1, `${label}: the queued line was not on disk when the process exited`);
      assert.equal(JSON.parse(written[0]!).heads.length, heads.length, label);
    }
  });

  test("answers a waiting read at once, rather than when its wait runs out", async () => {
    const app = new Hono<Env>();
    app.get("/poll", async (c) =>
      c.json(
        await readWaiting({
          stream: "shutdown:poll",
          caller: "a-caller",
          seconds: 20,
          read: async () => ({ items: [] as string[] }),
          found: (page) => page.items.length > 0,
        }),
      ),
    );
    const { server, port } = await listening(app);
    const poll = fetch(`http://127.0.0.1:${port}/poll`);
    for (let i = 0; i < 100 && waitingNow() === 0; i++) await later(20);
    assert.equal(waitingNow(), 1);
    const started = Date.now();
    const stopped = stop({ server });
    const answer = await poll;
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { items: [] });
    // Loose, for a loaded machine: the wait it cut short was twenty seconds.
    assert.ok(Date.now() - started < 10_000, `the waiting read answered after ${Date.now() - started} ms`);
    assert.deepEqual((await stopped).codes, [0]);
    // And its connection, answered, was not kept open for a next request.
    assert.ok(Date.now() - started < 2_500, `the stop took ${Date.now() - started} ms after the read was answered`);
    assert.equal(waitingNow(), 0);
  });

  test("past its deadline exits 1, saying what was still open", async () => {
    const app = new Hono<Env>();
    let held = () => {};
    app.get("/hold", () => new Promise<Response>((resolve) => (held = () => resolve(new Response("late")))));
    const { server, port } = await listening(app);
    const client = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/hold`, { signal: client.signal }).catch(() => null);
    await later(100);
    const lines: string[] = [];
    let exited!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (exited = resolve));
    const codes: number[] = [];
    const started = Date.now();
    const stopped = stop({
      server,
      deadlineMs: 300,
      write: (line) => lines.push(line),
      exit: (code) => {
        codes.push(code);
        exited(code);
      },
    });
    assert.equal(await exit, 1);
    assert.ok(Date.now() - started < 5_000, `the deadline of 300 ms fired after ${Date.now() - started} ms`);
    assert.deepEqual(lines, ["shutdown: not finished after 0.3 s, with 1 connection(s) still open; exiting.\n"]);
    // The connection ends after all, and the stop that ran out of time exits no second time.
    held();
    client.abort();
    await request;
    await stopped;
    assert.deepEqual(codes, [1]);
  });

  test("waits for a checkpoint pass under way, so ending the pools fails nothing", async () => {
    // The first pass starts at once, and compacts the log first: a log of a chain
    // written twice is rewritten to one line, with the old log kept beside it. Once the
    // stop has resolved, that pass has finished.
    const logDir = scratch("checkpoints");
    const entry = JSON.stringify({ space_id: randomUUID(), stream: "posts", last: "1", ending_hash: "00".repeat(32), checkpoint_id: "00".repeat(32) });
    writeFileSync(path.join(logDir, CHECKPOINT_LOG), `${entry}\n${entry}\n`);
    const own = openDb(config);
    const written: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const worker = startCheckpoints(own, developmentServiceKey(), logDir);
      await worker.stop();
      assert.ok(existsSync(path.join(logDir, CHECKPOINT_LOG_PREVIOUS)), "the stop resolved before the pass under way had finished");
      assert.equal(readFileSync(path.join(logDir, CHECKPOINT_LOG), "utf8"), `${entry}\n`);
      await own.end();
      await later(100);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(written.filter((line) => line.startsWith("checkpoint")), []);
  });

  test("SHUTDOWN_DEADLINE_SECONDS is 20 unless it is a positive number, and at most what a timer can wait", async () => {
    // Past 2^31 - 1 milliseconds Node fires a timer at once, which would end every stop
    // the moment it began.
    const longest = (2 ** 31 - 1) / 1000;
    for (const [value, seconds] of [[undefined, 20], ["", 20], ["5", 5], ["0.5", 0.5], ["0", 20], ["-1", 20], ["soon", 20], ["3000000", longest]] as const) {
      assert.equal(await withEnv({ SHUTDOWN_DEADLINE_SECONDS: value }, () => shutdownDeadlineSeconds()), seconds, String(value));
    }
  });
});

describe("the service stopped with SIGTERM", () => {
  test("answers its waiting read, writes the request log's lines, and exits 0", async () => {
    const reader = await agent();
    assert.equal((await call("POST", "/v1/spaces", reader, { name: "stopping-space", title: "Stopping" })).status, 201);
    const logDir = scratch("process");
    const child = spawn(process.execPath, ["src/server.ts"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PORT: "0",
        API_HOST: config.apiHost,
        PUBLIC_ORIGIN: config.publicOrigin,
        CHALLENGE_KEY: config.challengeKey.toString("utf8"),
        DB_HOST: config.db.host,
        DB_PORT: String(config.db.port),
        DB_NAME: config.db.database,
        DB_USER: config.db.username,
        DB_PASSWORD: API_PASSWORD,
        LOG_DIR: logDir,
        CHECKPOINT_EVERY_SECONDS: "5",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      for (let i = 0; i < 300 && !/listening on (\d+)/.test(stdout); i++) await later(50);
      const port = /listening on (\d+)/.exec(stdout)?.[1];
      assert.ok(port, `the service did not start: ${stderr}`);
      const base = `http://127.0.0.1:${port}`;
      const headers = { authorization: `Bearer ${reader.token}` };

      // A read by a KEY, which the request log writes, and a read that waits.
      assert.equal((await fetch(`${base}/v1/spaces/stopping-space`, { headers })).status, 200);
      const poll = fetch(`${base}/v1/spaces/stopping-space/posts?after=0&wait=20`, { headers });
      await later(300);
      const started = Date.now();
      child.kill("SIGTERM");
      const answer = await poll;
      assert.equal(answer.status, 200, await answer.clone().text());
      assert.deepEqual(((await answer.json()) as { items: unknown[] }).items, []);
      assert.equal(await exited, 0, stderr);
      assert.ok(Date.now() - started < 10_000, `the service took ${Date.now() - started} ms to stop`);
      const lines = readdirSync(logDir)
        .filter((f) => f.startsWith("requests-"))
        .flatMap((f) => readFileSync(path.join(logDir, f), "utf8").split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { path: string });
      assert.deepEqual(lines.map((l) => l.path), ["/v1/spaces/:name", "/v1/spaces/:name/posts"]);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
