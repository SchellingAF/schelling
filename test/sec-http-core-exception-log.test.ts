// What the operator's exception log may hold of a request: one line per event that
// starts where the service started it, and never a value the caller sent.
//
// Hono hands a route its path percent-decoded, so `%0A` in a request reaches the
// handler as a newline, and a line printed with that path would let a caller write
// lines of its own into the log an operator reads after an INTERNAL. And PostgreSQL
// quotes back the value it could not take ("invalid input syntax for type ...:
// "<value>"), in its message and so in the stack, which repeats the message.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { useService, db, config, call, agent, fixture } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { oneLine } from "../src/http/log.ts";

const ready = useService("sec_exception_log");

/** Run `fn`, and hand back what it wrote to the exception log. */
async function capturingErrors<T>(fn: () => T | Promise<T>): Promise<{ result: T; logged: string }> {
  const real = console.error;
  let logged = "";
  console.error = (...parts: unknown[]) => {
    logged += parts.map((p) => (typeof p === "string" ? p : inspect(p))).join(" ") + "\n";
  };
  try {
    return { result: await fn(), logged };
  } finally {
    console.error = real;
  }
}

/** A path carrying a line of its own: what a forged log line would start with. */
const FORGED = "/v1/zz-boom/a%0D%0A%5Bforged%5D%20GET%20%2Fv1%2Fme%20XX000";

let raised: Error;
let app: ReturnType<typeof createApp>;

before(async () => {
  await ready;
  // A real driver error for a value the caller chose, of a state no map turns into a
  // refusal (22007, invalid_datetime_format), so it is an INTERNAL and is written down.
  raised = (await db.read`select (${"CALLER-CANARY"}::text)::timestamptz as at`.catch((e: unknown) => e)) as Error;
  assert.equal((raised as { code?: string }).code, "22007", "the scene needs a real 22007");
  app = createApp(config, db);
  // A route of the test's own that fails as a route would, so the line is onError's.
  app.get("/v1/zz-boom/:x", () => {
    throw raised;
  });
  // Thrown errors of the shapes a logger must not trip on: a name that is a number and no
  // stack, and a stack that is an object. (A thrown value that is no Error never reaches
  // onError: Hono rethrows it, so that is no case of the log's.)
  app.get("/v1/zz-odd/name", () => {
    throw Object.assign(new Error("odd-name-message"), { name: 42, stack: undefined });
  });
  app.get("/v1/zz-odd/stack", () => {
    throw Object.assign(new Error("odd-stack-message"), { stack: { frames: 1 } });
  });
  app.get("/v1/zz-deadlock/:x", () => {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  });
});

describe("the exception log", () => {
  test("an INTERNAL's line never starts a line the caller wrote, and never holds the value PostgreSQL quoted", async () => {
    const { result: res, logged } = await capturingErrors(() => app.request(FORGED));
    assert.equal(res.status, 500, "the scene has to be a real INTERNAL or it proves nothing");
    assert.ok(logged.includes("22007"), "an INTERNAL still has to be diagnosable");
    assert.ok(logged.includes("invalid input syntax for type timestamp with time zone"), "the message is still there");
    assert.equal(logged.includes("CALLER-CANARY"), false, `the value the caller sent reached the log:\n${logged}`);
    // Every line is the INTERNAL's own first line or a frame of its stack.
    const lines = logged.split(/\r\n|\r|\n/).filter((line) => line !== "");
    assert.match(lines[0]!, /^\[[0-9a-f-]{36}\] GET \/v1\/zz-boom\//);
    for (const line of lines.slice(1)) assert.match(line, /^\s+at /, `a line the service did not write:\n${logged}`);
    assert.equal(logged.includes("\r"), false);
  });

  test("a deadlock's line is one line, whatever the path held", async () => {
    const { result: res, logged } = await capturingErrors(() => app.request(FORGED.replace("zz-boom", "zz-deadlock")));
    assert.equal(res.status, 503);
    const deadlock = logged.split("\n").filter((line) => line.includes("deadlock"));
    assert.ok(deadlock.length >= 1, `no deadlock line:\n${logged}`);
    assert.equal(logged.split("\n").some((line) => line.startsWith("[forged]")), false, `a forged line:\n${logged}`);
    assert.equal(logged.includes("\r"), false);
  });

  test("a thrown value of any shape is written down as itself, never as the logger's own failure", async () => {
    for (const [path, said] of [["name", "42: odd-name-message"], ["stack", "Error: odd-stack-message"]] as const) {
      const { result: res, logged } = await capturingErrors(() => app.request(`/v1/zz-odd/${path}`));
      assert.equal(res.status, 500, path);
      assert.ok(logged.includes(`GET /v1/zz-odd/${path} ${said}`), `${path}:\n${logged}`);
      assert.equal(logged.includes("is not a function"), false, `${path}: the logger failed:\n${logged}`);
    }
  });

  test("the deciders line after a version is one line, whatever the failure said", async (t) => {
    const owner = await agent();
    const writer = await agent();
    const name = `sec-deciders-${process.pid}`;
    await fixture.setBucket(`space:${owner.peerId}`, 1000);
    const made = await call("POST", "/v1/spaces", owner, { name, title: "T", visibility: "private", document: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await call("PUT", `/v1/spaces/${name}/members/${writer.peerId}`, owner, { role: "writer" })).status, 200);
    const v1 = await call("POST", `/v1/spaces/${name}/posts`, owner, { kind: "version", body: "# Doc\n\nOne." });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    const failing = createApp(config, {
      ...db,
      readTx: (peer, fn) => db.readTx(peer, (sql) => fn(new Proxy(sql, {
        apply(target, self, args) {
          if (Array.isArray(args[0]) && args[0].join("").includes("document_deciders")) throw new Error("forced\r\n[forged] GET /v1/me XX000");
          return Reflect.apply(target, self, args);
        },
      }))),
    } as typeof db);
    const errors = t.mock.method(console, "error", () => {});
    const out = await call("POST", `/v1/spaces/${name}/posts`, writer, { kind: "version", body: "# Doc\n\nTwo.", supersedes: v1.body.post_id }, failing);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.oracle.state, "pending", "the scene needs a waiting version");
    const lines = errors.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("deciders not read"));
    assert.equal(lines.length, 1);
    assert.equal(/[\r\n]/.test(lines[0]!), false, `a line of its own:\n${lines[0]}`);
  });

  test("oneLine writes every control character and both line separators as an escape", () => {
    assert.equal(oneLine("a\nb\r\tc\u0000\u007f\u2028\u2029d"), "a\\u000ab\\u000d\\u0009c\\u0000\\u007f\\u2028\\u2029d");
    assert.equal(oneLine("x\u0080y\u0085z\u009f"), "x\\u0080y\\u0085z\\u009f");
    assert.equal(oneLine(42), "42");
    assert.equal(oneLine(undefined), "undefined");
    assert.equal(oneLine("/v1/spaces/plain-name/posts"), "/v1/spaces/plain-name/posts");
  });
});
