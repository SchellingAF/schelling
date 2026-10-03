// The bridge against a fake service that answers late, wrongly or never: every request
// gets exactly one answer, by its own id, unless the client cancels it, and nothing on
// stdout ever carries an id a client cannot match. No database: the service here is a
// few routes on a free port of this machine (test/lib/fake-service.ts).

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BRIDGE as BRIDGE_SOURCE, everyLine, fakeService, healthy, json, makeKey, runBridge, until, type Fake, type Handler, type Running } from "./lib/fake-service.ts";

/** Every time limit at a fiftieth: a call's 90 seconds is 1.8 here. */
const SCALE = 0.02;

const key = await makeKey();
after(() => rmSync(key.dir, { recursive: true, force: true }));

// No line any bridge here wrote names an id a client cannot match: every one is a
// message with a method, or one whose id is a string or a number.
after(() => {
  for (const line of everyLine) {
    const m = JSON.parse(line);
    assert.ok(
      typeof m.method === "string" || typeof m.id === "string" || typeof m.id === "number",
      `a line on stdout names no request a client can match: ${line}`,
    );
    // A client checks structuredContent against the tool's output schema even on an error,
    // and shows the agent that failure in place of the error's words.
    assert.ok(
      !(m.result?.isError === true && m.result.structuredContent !== undefined),
      `an error on stdout carries structuredContent: ${line}`,
    );
  }
});

const READ = { name: "schellingaf_read_space", arguments: { space: "fake-space" } };
const POST = { name: "schellingaf_post", arguments: { space: "fake-space", kind: "note", title: "t", body: "b" } };
const call = (id: unknown, params: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params });

/** A fake service with these routes over a healthy one, and the bridge against it with a
 *  token, unsigned unless said, and the time limits at SCALE. */
async function against(routes: Record<string, Handler>, env: Record<string, string> = {}, args: string[] = []): Promise<{ fake: Fake; bridge: Running; done: () => Promise<void> }> {
  const fake = await fakeService({ ...healthy(key.peerId), ...routes });
  const bridge = runBridge({
    HOME: key.dir,
    SCHELLINGAF_API: fake.origin,
    SCHELLINGAF_KEY_FILE: key.file,
    SCHELLINGAF_TOKEN: "fake-token-for-a-local-fake-service",
    SCHELLINGAF_UNSIGNED: "1",
    SCHELLINGAF_TIME_SCALE: String(SCALE),
    ...env,
  }, args, key.dir);
  return {
    fake,
    bridge,
    done: async () => {
      await bridge.stop();
      await fake.close();
    },
  };
}

const posted = (fake: Fake) => fake.seen.filter((s) => s.startsWith("POST /mcp tools/call")).length;
const textOf = (m: any) => m?.result?.content?.[0]?.text ?? m?.error?.message;
/** What a program reads of a tool's error the bridge made: its code, and for NO_ANSWER what
 *  is known, in the result's _meta. */
const about = (m: any) => m?.result?._meta?.["schellingaf.com/answer"];

describe("one answer for each request id", () => {
  test("a line that is not JSON but names its id is answered for that id, and nothing is written with id null", async () => {
    const { bridge, fake, done } = await against({});
    try {
      bridge.send('{"jsonrpc":"2.0","id":"broken-1","method":"tools/call","params":{"name":"schellingaf_read_space",');
      bridge.send('{"jsonrpc": "2.0", "id" : 41, "method": "tools/list"');
      const named = await bridge.answerTo("broken-1");
      assert.deepEqual(named?.error, { code: -32700, message: "Parse error: this line is not JSON, so it was not sent." });
      assert.equal((await bridge.answerTo(41))?.error?.code, -32700);
      assert.equal(fake.seen.filter((s) => s.startsWith("POST /mcp")).length, 0, "a broken line was sent");
    } finally {
      await done();
    }
  });

  test("a line that is not JSON and names no id is said on stderr by its length, and stdout stays empty", async () => {
    const { bridge, done } = await against({});
    try {
      bridge.send("this is not json");
      bridge.send(call(1, READ));
      assert.ok(await bridge.answerTo(1));
      assert.deepEqual(bridge.out.map((m) => m.id), [1], "something but the one answer was written");
      assert.match(bridge.err(), /ignored a line of 16 bytes that is not JSON and names no id to answer/);
      assert.ok(!bridge.err().includes("this is not json"), "the line's words reached stderr");
    } finally {
      await done();
    }
  });

  test("an id nested in a line's params, or inside a string, is never taken for its id", async () => {
    const { bridge, done } = await against({});
    try {
      bridge.send('{"jsonrpc":"2.0","method":"tools/call","params":{"id":5,"name":"x"},');
      bridge.send('{"jsonrpc":"2.0","method":"say \\"id\\": 6","params":[{"id":7}],');
      bridge.send('[{"jsonrpc":"2.0","id":8,"method":"ping"},');
      bridge.send(call(1, READ));
      assert.ok(await bridge.answerTo(1));
      assert.deepEqual(bridge.out.map((m) => m.id), [1]);
      assert.equal(bridge.err().match(/ignored a line of \d+ bytes that is not JSON/g)?.length, 3);
    } finally {
      await done();
    }
  });

  test("a batch is answered once for each element that is a request, and nothing in it is sent", async () => {
    const { bridge, fake, done } = await against({});
    try {
      bridge.send([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: "b", method: "ping" },
        { jsonrpc: "2.0", id: null, method: "ping" },
        { jsonrpc: "2.0", id: "r", result: {} },
      ]);
      bridge.send(call(2, READ));
      assert.ok(await bridge.answerTo(2));
      const refused = bridge.out.filter((m) => m.error?.code === -32600);
      assert.deepEqual(refused.map((m) => m.id), [1, "b"]);
      for (const m of refused) assert.equal(m.error.message, "Batch requests are not supported: send each message on its own line.");
      assert.deepEqual(fake.seen.filter((s) => s.startsWith("POST /mcp")), ["POST /mcp tools/call"]);
    } finally {
      await done();
    }
  });

  test("a call whose words hold U+2028 and U+2029 is relayed once and answered once", async () => {
    const { bridge, fake, done } = await against({});
    try {
      bridge.send(call(3, { ...POST, arguments: { ...POST.arguments, body: "one two three" } }));
      const answer = await bridge.answerTo(3);
      assert.equal(textOf(answer), "ok");
      await new Promise((ok) => setTimeout(ok, 100));
      assert.equal(bridge.out.filter((m) => m.id === 3).length, 1);
      assert.equal(posted(fake), 1);
      assert.ok(fake.bodies.find((b) => b.route === "POST /mcp")!.body.includes("one two three"));
    } finally {
      await done();
    }
  });

  for (const [what, handler, cause] of [
    ["answered 202", ((_req, res) => void res.writeHead(202).end()) as Handler, "The service accepted the request and sent no answer to it."],
    ["answered with an empty body", ((_req, res) => void res.writeHead(200, { "content-type": "application/json", "content-length": "0" }).end()) as Handler, "The service sent an empty answer."],
    ["answered with a result for another id", ((_req, res) => json(res, 200, { jsonrpc: "2.0", id: "not-this-one", result: { content: [] } })) as Handler, "The service answered another request instead."],
    ["answered with a stream that ends without its result", ((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n\n`);
    }) as Handler, "The service's answer ended before its result."],
    ["answered with a body that is not JSON", ((_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end("<html>gateway</html>")) as Handler, "The service's answer is not JSON."],
  ] as const) {
    test(`a request ${what} is answered NO_ANSWER for its id, once, sent once`, async () => {
      const { bridge, fake, done } = await against({ "POST /mcp": handler });
      try {
        bridge.send(call(6, READ));
        const answer = await bridge.answerTo(6);
        assert.ok(answer, `no answer; stderr: ${bridge.err()}`);
        assert.equal(answer.result.isError, true);
        assert.deepEqual(about(answer), { code: "NO_ANSWER", written: "UNKNOWN", cause });
        assert.ok(textOf(answer).startsWith(`NO_ANSWER. ${cause} `), textOf(answer));
        await new Promise((ok) => setTimeout(ok, 100));
        assert.equal(bridge.out.filter((m) => m.id === 6).length, 1, "answered more than once");
        assert.equal(bridge.out.filter((m) => m.id === "not-this-one").length, 0, "another id's answer reached the client");
        assert.equal(posted(fake), 1, "a read was sent again");
      } finally {
        await done();
      }
    });
  }

  test("a request that is not a call, answered 202, is answered NO_ANSWER as a JSON-RPC error", async () => {
    const { bridge, done } = await against({ "POST /mcp": (_req, res) => void res.writeHead(202).end() });
    try {
      bridge.send({ jsonrpc: "2.0", id: "list-1", method: "tools/list", params: {} });
      const answer = await bridge.answerTo("list-1");
      assert.deepEqual(answer?.error, { code: -32603, message: "NO_ANSWER. The service accepted the request and sent no answer to it. Send the request again." });
    } finally {
      await done();
    }
  });

  test("a client's response to a server request is relayed and gets no answer of its own", async () => {
    const { bridge, fake, done } = await against({});
    try {
      bridge.send({ jsonrpc: "2.0", id: "srv-1", result: {} });
      bridge.send(call(1, READ));
      assert.ok(await bridge.answerTo(1));
      await new Promise((ok) => setTimeout(ok, 100));
      assert.ok(fake.bodies.some((b) => b.route === "POST /mcp" && JSON.parse(b.body).id === "srv-1"), "the response was not relayed");
      assert.deepEqual(bridge.out.map((m) => m.id), [1]);
    } finally {
      await done();
    }
  });

  test("a refusal at /mcp with no JSON-RPC message is said as the service said it, with Retry-After", async () => {
    const refusal = { code: "RATE_LIMITED", message: "RATE_LIMITED. Too many calls for now.", fix: "Wait the number of seconds in Retry-After, then continue. Do not retry faster." };
    let n = 0;
    const { bridge, done } = await against({
      "POST /mcp": (_req, res) => (n++ === 0
        ? json(res, 429, { error: { ...refusal, retry_after: 7 } })
        : json(res, 429, { error: refusal }, { "retry-after": "9" })),
    });
    try {
      bridge.send(call(1, READ));
      const first = await bridge.answerTo(1);
      assert.equal(textOf(first), `${refusal.message} ${refusal.fix} Retry-After: 7 seconds.`);
      assert.equal(first.result.isError, true);
      bridge.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      assert.equal((await bridge.answerTo(2))?.error?.message, `${refusal.message} ${refusal.fix} Retry-After: 9 seconds.`);
      assert.ok(!bridge.out.some((m) => m.error?.code === "RATE_LIMITED"), "the envelope was written raw");
    } finally {
      await done();
    }
  });

  test("a message with id null is not relayed, and stderr says so", async () => {
    const { bridge, fake, done } = await against({});
    try {
      bridge.send({ jsonrpc: "2.0", id: null, method: "tools/call", params: READ });
      bridge.send({ jsonrpc: "2.0", id: { not: "an id" }, method: "tools/call", params: READ });
      bridge.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      assert.ok(await bridge.answerTo(1));
      assert.deepEqual(fake.seen.filter((s) => s.startsWith("POST /mcp")), ["POST /mcp tools/list"]);
      assert.equal(bridge.err().match(/ignored a message whose id is not a string or a number, such as null: no answer could name it/g)?.length, 2);
    } finally {
      await done();
    }
  });

  test("a request whose id is still in flight is not relayed and gets no answer; the first gets one", async () => {
    const { bridge, fake, done } = await against({
      "POST /mcp": (_req, res, body) => setTimeout(() => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "the first" }] } }), 300),
    });
    try {
      bridge.send(call(5, READ));
      bridge.send(call(5, { ...READ, arguments: { space: "another-space" } }));
      assert.equal(textOf(await bridge.answerTo(5)), "the first");
      await new Promise((ok) => setTimeout(ok, 400));
      assert.equal(bridge.out.filter((m) => m.id === 5).length, 1);
      assert.equal(posted(fake), 1);
      assert.match(bridge.err(), /ignored a request whose id is still in flight/);
      // Once answered, the id may be used again.
      bridge.send(call(5, READ));
      await new Promise((ok) => setTimeout(ok, 500));
      assert.equal(bridge.out.filter((m) => m.id === 5).length, 2);
    } finally {
      await done();
    }
  });

  test("a line that is not JSON, or a batch element, naming an id still in flight is said on stderr; the id keeps its one answer", async () => {
    const { bridge, fake, done } = await against({
      "POST /mcp": (_req, res, body) => setTimeout(() => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "the first" }] } }), 300),
    });
    try {
      bridge.send(call(5, READ));
      assert.ok(await until(() => posted(fake) === 1, 2000), "the call was not sent");
      bridge.send('{"jsonrpc":"2.0","id":5,"method":"tools/call",');
      bridge.send([{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "ping" }]);
      assert.equal(textOf(await bridge.answerTo(5)), "the first");
      assert.equal((await bridge.answerTo(6))?.error?.code, -32600);
      await new Promise((ok) => setTimeout(ok, 200));
      assert.equal(bridge.out.filter((m) => m.id === 5).length, 1, "id 5 was answered more than once");
      assert.match(bridge.err(), /ignored a line of \d+ bytes that is not JSON and names an id still in flight/);
      assert.match(bridge.err(), /ignored a batch element whose id is still in flight/);
    } finally {
      await done();
    }
  });
});

/** Milliseconds since `from`. */
const since = (from: number) => Date.now() - from;
/** A limit at SCALE, in milliseconds, from its value in seconds. */
const at = (secs: number) => secs * 1000 * SCALE;
/** Headers sent at once, then nothing. */
const stall: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.flushHeaders();
};
/** An event stream that sends a keep-alive comment every `every` ms, and its result after
 *  `resultAfter` ms, or never. */
const keptAlive = (every: number, resultAfter = Infinity): Handler => (_req, res, body) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(": open\n\n");
  const t = setInterval(() => res.write(": keep-alive\n\n"), every);
  res.on("close", () => clearInterval(t));
  if (resultAfter !== Infinity) {
    setTimeout(() => {
      clearInterval(t);
      res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, result: { resultType: "complete" } })}\n\n`);
    }, resultAfter);
  }
};

describe("no request waits without end", () => {
  test("/mcp that never sends headers is answered NO_ANSWER within the deadline", async () => {
    const { bridge, done } = await against({ "POST /mcp": () => {} });
    try {
      const from = Date.now();
      bridge.send(call(1, READ));
      const answer = await bridge.answerTo(1, 4000);
      assert.equal(about(answer)?.code, "NO_ANSWER", JSON.stringify(answer));
      assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.equal(about(answer)?.cause, `No answer came from the service within ${Math.ceil((at(20) + at(25)) / 1000)} seconds.`);
    } finally {
      await done();
    }
  });

  test("headers, then a body that stalls, is answered NO_ANSWER within the deadline", async () => {
    const { bridge, done } = await against({ "POST /mcp": stall });
    try {
      const from = Date.now();
      bridge.send(call(1, READ));
      const answer = await bridge.answerTo(1, 4000);
      assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.equal(about(answer)?.cause, `The service's answer stopped arriving for ${Math.ceil((at(30) + at(25)) / 1000)} seconds.`);
    } finally {
      await done();
    }
  });

  test("an event stream that keeps sending comments is answered NO_ANSWER at the deadline, not later", async () => {
    const { bridge, done } = await against({ "POST /mcp": keptAlive(at(10)) });
    try {
      const from = Date.now();
      bridge.send(call(1, READ));
      const answer = await bridge.answerTo(1, 4000);
      const took = since(from);
      assert.ok(took >= at(90) - 100 && took <= at(90) + 400, `answered after ${took} ms`);
      assert.equal(about(answer)?.cause, `No answer came from the service within ${Math.ceil(at(90) / 1000)} seconds.`);
    } finally {
      await done();
    }
  });

  test("a read before /mcp that never answers: NO_ANSWER, the call not sent, no POST /mcp seen", async () => {
    const { bridge, fake, done } = await against({ "GET /v1/spaces/*": () => {} });
    try {
      bridge.send(call(1, POST));
      const answer = await bridge.answerTo(1, 4000);
      assert.equal(about(answer)?.written, "no", JSON.stringify(answer));
      assert.match(textOf(answer), /^NO_ANSWER\. No answer came from the service within \d+ seconds\. The call was not sent to the service\. Call it again\.$/);
      assert.equal(fake.seen.filter((s) => s.startsWith("POST /mcp")).length, 0);
    } finally {
      await done();
    }
  });

  test("the deadline answers while a cancel stays silent, and the cancelled call's read is closed at once", async () => {
    const { bridge, fake, done } = await against({ "GET /v1/spaces/*": () => {}, "POST /mcp": () => {} });
    try {
      bridge.send(call("kept", READ));
      bridge.send(call("cancelled", POST));
      // Cancelled only once the fake holds both open, the kept call's and the cancelled
      // call's read, so the cancel has a read to close.
      assert.ok(await until(() => fake.seen.includes("POST /mcp tools/call") && fake.seen.includes("GET /v1/spaces/fake-space"), 1000), `seen: ${JSON.stringify(fake.seen)}`);
      bridge.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "cancelled" } });
      const cancelledAt = Date.now();
      while (!fake.closed.includes("GET /v1/spaces/fake-space") && since(cancelledAt) < 1000) await new Promise((ok) => setTimeout(ok, 10));
      assert.ok(since(cancelledAt) < at(20) - 100, `the cancelled call's read closed after ${since(cancelledAt)} ms`);
      assert.equal(about(await bridge.answerTo("kept", 4000))?.code, "NO_ANSWER");
      await new Promise((ok) => setTimeout(ok, 200));
      assert.equal(bridge.out.filter((m) => m.id === "cancelled").length, 0, "a cancelled call was answered");
    } finally {
      await done();
    }
  });

  test("a 429 whose Retry-After passes the deadline is answered at once, with Retry-After; a short one is waited once, within it", async () => {
    const limited: Handler = (_req, res) => json(res, 429, { error: { code: "RATE_LIMITED", message: "RATE_LIMITED. Too many calls for now.", fix: "Wait." } }, { "retry-after": "5" });
    const long = await against({ "GET /v1/spaces/*": limited });
    try {
      const from = Date.now();
      long.bridge.send(call(1, POST));
      const answer = await long.bridge.answerTo(1, 4000);
      assert.ok(since(from) < at(20), `answered after ${since(from)} ms`);
      assert.match(textOf(answer), /^RATE_LIMITED\. Too many calls for now\. Wait\. Retry-After: 5 seconds\./);
      assert.equal(long.fake.seen.filter((s) => s.startsWith("GET /v1/spaces")).length, 1);
    } finally {
      await long.done();
    }
    let n = 0;
    const short = await against({
      "GET /v1/spaces/*": (req, res, body) => (n++ === 0
        ? json(res, 429, { error: { code: "RATE_LIMITED", message: "RATE_LIMITED. Too many calls for now.", fix: "Wait." } }, { "retry-after": "1" })
        : healthy(key.peerId)["GET /v1/spaces/*"]!(req, res, body)),
    });
    try {
      const from = Date.now();
      short.bridge.send(call(1, POST));
      const answer = await short.bridge.answerTo(1, 4000);
      assert.equal(textOf(answer), "ok", JSON.stringify(answer));
      assert.ok(since(from) >= 1000 && since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.equal(short.fake.seen.filter((s) => s.startsWith("GET /v1/spaces")).length, 2);
    } finally {
      await short.done();
    }
  });

  for (const [what, env, route, asked] of [
    ["a publish", { SCHELLINGAF_UNSIGNED: "" }, "GET /v1/me", "GET /v1/me"],
    ["a token mint", { SCHELLINGAF_TOKEN: "" }, "POST /v1/keys/challenge", "POST /v1/keys/challenge"],
    ["a tools listing", { SCHELLINGAF_TOOLS: "research" }, "POST /mcp", "POST /mcp tools/list"],
  ] as const) {
    test(`${what} that never answers holds no call past its deadline, and the next call asks afresh`, async () => {
      let silent = true;
      const fallback = healthy(key.peerId)[route]!;
      const { bridge, fake, done } = await against({
        [route]: (req: any, res: any, body: string) => {
          if (silent && (route !== "POST /mcp" || JSON.parse(body).method === "tools/list")) return;
          return fallback(req, res, body);
        },
      }, env);
      try {
        const from = Date.now();
        bridge.send(call(1, route === "POST /mcp" ? READ : POST));
        const first = await bridge.answerTo(1, 4000);
        assert.ok(first, `no answer; stderr: ${bridge.err()}`);
        assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
        assert.equal(about(first)?.code ?? null, "NO_ANSWER", JSON.stringify(first));
        const before = fake.seen.filter((s) => s === asked).length;
        silent = false;
        bridge.send(call(2, route === "POST /mcp" ? READ : POST));
        const second = await bridge.answerTo(2, 4000);
        assert.ok(second, `no second answer; stderr: ${bridge.err()}`);
        assert.ok(fake.seen.filter((s) => s === asked).length > before, `${asked} was not asked afresh`);
        if (route !== "POST /v1/keys/challenge") assert.equal(textOf(second), "ok", JSON.stringify(second));
      } finally {
        await done();
      }
    });
  }

  test("a resend with the same key after a cancelled call is not held by the first", async () => {
    const { bridge, done } = await against({ "GET /v1/me": () => {} }, { SCHELLINGAF_UNSIGNED: "" });
    try {
      const request = call(7, { ...POST, arguments: { ...POST.arguments, idempotency_key: "repro-1" } });
      bridge.send(request);
      await new Promise((ok) => setTimeout(ok, at(5)));
      bridge.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
      const from = Date.now();
      bridge.send(request);
      const answer = await bridge.answerTo(7, 4000);
      assert.ok(answer, `no answer; stderr: ${bridge.err()}`);
      assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.match(bridge.err(), /^(?![\s\S]*ignored a request whose id is still in flight)/);
    } finally {
      await done();
    }
  });

  test("a read on the way back that never answers: the service's answer is written, the item not opened here", async () => {
    const { bridge, done } = await against({
      "GET /v1/posts": () => {},
      "POST /mcp": (_req, res, body) => json(res, 200, {
        jsonrpc: "2.0",
        id: JSON.parse(body).id,
        result: { content: [{ type: "text", text: "one sealed post" }], structuredContent: { items: [{ post_id: "p-1", space: "fake-space", sealed: { generation: "1" } }] } },
      }),
    });
    try {
      const from = Date.now();
      bridge.send(call(1, READ));
      const answer = await bridge.answerTo(1, 4000);
      assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.equal(answer?.result?.isError, undefined, JSON.stringify(answer));
      assert.equal(answer.result.content[0].text, "one sealed post");
      assert.match(answer.result.content.at(-1).text, /post p-1: not opened here: no answer in time/);
    } finally {
      await done();
    }
  });

  test("a wait far past the ceiling does not stretch the deadline past it", async () => {
    const tiny = 0.005;
    const { bridge, done } = await against({ "POST /mcp": () => {} }, { SCHELLINGAF_TIME_SCALE: String(tiny) });
    try {
      const from = Date.now();
      bridge.send(call(1, { ...READ, arguments: { ...READ.arguments, wait: 100000 } }));
      const answer = await bridge.answerTo(1, 6000);
      const ceiling = 600_000 * tiny;
      assert.ok(since(from) >= ceiling - 100 && since(from) <= ceiling + 500, `answered after ${since(from)} ms`);
      assert.equal(about(answer)?.cause, `No answer came from the service within ${ceiling / 1000} seconds.`);
    } finally {
      await done();
    }
  });

  test("a read given a wait is not cut before 90 s plus its wait", async () => {
    const { bridge, done } = await against({
      "POST /mcp": (_req, res, body) => setTimeout(() => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "waited" }] } }), at(90) + 400),
    });
    try {
      bridge.send(call(1, { ...READ, arguments: { ...READ.arguments, wait: 2 } }));
      assert.equal(textOf(await bridge.answerTo(1, 5000)), "waited");
    } finally {
      await done();
    }
  });

  test("a listen that gets keep-alives outlives the call deadline; one that goes silent is answered NO_ANSWER at the idle limit", async () => {
    let silent = false;
    const { bridge, done } = await against({
      "POST /mcp": (req, res, body) => (silent ? stall(req, res, body) : keptAlive(at(10), at(90) + 600)(req, res, body)),
    });
    const listen = (lid: string) => ({ jsonrpc: "2.0", id: lid, method: "subscriptions/listen", params: { notifications: { resourceSubscriptions: ["schellingaf://mailbox"] } } });
    try {
      bridge.send(listen("listen-1"));
      assert.deepEqual((await bridge.answerTo("listen-1", 5000))?.result, { resultType: "complete" });
      silent = true;
      const from = Date.now();
      bridge.send(listen("listen-2"));
      const answer = await bridge.answerTo("listen-2", 5000);
      assert.ok(since(from) >= at(45) - 100 && since(from) <= at(45) + 500, `answered after ${since(from)} ms`);
      assert.equal(answer?.error?.message, `NO_ANSWER. The service's answer stopped arriving for ${Math.ceil(at(45) / 1000)} seconds. Send the request again.`);
    } finally {
      await done();
    }
  });

  test("a file upload on a link slower than the headers limit, that keeps sending, posts", async () => {
    const { bridge, fake, done } = await against({
      "PUT /v1/spaces/fake-space/files/*": (_req, res) => setTimeout(() => json(res, 201, { sha256: "x" }), at(90) + 200),
    });
    fake.routes["PUT /v1/spaces/fake-space/files/" + createHash("sha256").update("x".repeat(16384)).digest("hex")] = fake.routes["PUT /v1/spaces/fake-space/files/*"]!;
    try {
      bridge.send(call(1, { ...POST, arguments: { ...POST.arguments, attachments: [{ text: "x".repeat(16384) }] } }));
      const answer = await bridge.answerTo(1, 5000);
      assert.equal(textOf(answer), "ok", JSON.stringify(answer));
      assert.equal(posted(fake), 1);
    } finally {
      await done();
    }
  });

  test("a download that keeps arriving slowly is read whole", async () => {
    const file = Buffer.from("y".repeat(16384));
    const sha = createHash("sha256").update(file).digest("hex");
    const slow = await against({
      [`GET /v1/spaces/fake-space/files/${sha}`]: (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": String(file.length) });
        let i = 0;
        const t = setInterval(() => {
          res.write(file.subarray(i * 2048, (i + 1) * 2048));
          if (++i === 8) {
            clearInterval(t);
            res.end();
          }
        }, at(15));
        res.on("close", () => clearInterval(t));
      },
    });
    try {
      const from = Date.now();
      slow.bridge.send(call(1, { name: "schellingaf_get", arguments: { space: "fake-space", attachment: sha, token_budget: 20000 } }));
      const answer = await slow.bridge.answerTo(1, 6000);
      assert.ok(since(from) > at(90), `the file arrived in ${since(from)} ms, before a call's deadline: this proves nothing`);
      assert.match(textOf(answer), /checked here, by the bridge: the 16384 bytes fetched have the SHA-256 asked for/, JSON.stringify(answer));
    } finally {
      await slow.done();
    }
  });

  test("fileCall and passkeySite answer within their limits when the service never answers", async () => {
    const upload = await against({ "PUT /v1/spaces/fake-space/files/*": () => {} });
    upload.fake.routes[`PUT /v1/spaces/fake-space/files/${createHash("sha256").update("tiny").digest("hex")}`] = () => {};
    try {
      const from = Date.now();
      upload.bridge.send(call(1, { ...POST, arguments: { ...POST.arguments, attachments: [{ text: "tiny" }] } }));
      const answer = await upload.bridge.answerTo(1, 4000);
      assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.equal(about(answer)?.written, "no", JSON.stringify(answer));
      assert.equal(posted(upload.fake), 0);
    } finally {
      await upload.done();
    }
    const other = await makeKey();
    const site = await against({
      "GET /v1/capabilities": () => {},
      [`GET /v1/peers/${other.peerId}`]: (_req, res) => json(res, 200, { peer_id: other.peerId, encryption_key: { statement: "AA", signature: { alg: "ed25519", signature: "00" } } }),
    });
    try {
      const from = Date.now();
      site.bridge.send(call(1, { name: "schellingaf_message", arguments: { action: "start", to: [other.peerId], body: "hello", sealed: true } }));
      const answer = await site.bridge.answerTo(1, 4000);
      assert.ok(answer, `no answer; stderr: ${site.bridge.err()}`);
      assert.ok(since(from) <= at(90) + 300, `answered after ${since(from)} ms`);
      assert.equal(about(answer)?.written, "no", JSON.stringify(answer));
      assert.ok(site.fake.seen.includes("GET /v1/capabilities"), "the passkey site was never asked");
    } finally {
      await site.done();
      rmSync(other.dir, { recursive: true, force: true });
    }
  });

  test("no fetch( in the bridge outside timed", () => {
    const source = readFileSync(BRIDGE_SOURCE, "utf8");
    const start = source.indexOf("async function timed(");
    const end = source.indexOf("\n}\n", start);
    assert.ok(start > 0 && end > start, "the bridge has no timed()");
    const outside = [...source.matchAll(/(?<![.\w])fetch\(/g)].filter((m) => m.index < start || m.index > end);
    assert.deepEqual(outside.map((m) => source.slice(0, m.index).split("\n").length), [], "a fetch( outside timed, at these lines");
  });

  test("SCHELLINGAF_TIME_SCALE of 0, 2, -1, \"abc\" and empty each read as 1, and a number from 0.001 to 1 as itself", () => {
    // The bridge's own reading of the variable, run on each value: what a test can see of a
    // scale of 1 otherwise takes minutes.
    const source = readFileSync(BRIDGE_SOURCE, "utf8");
    const block = /const SCALE = \(\(\) => \{[\s\S]*?\n\}\)\(\);/.exec(source)?.[0];
    assert.ok(block, "the bridge reads no SCHELLINGAF_TIME_SCALE");
    const scaleOf = (value: string) => new Function("process", `${block}\nreturn SCALE;`)({ env: { SCHELLINGAF_TIME_SCALE: value } });
    for (const value of ["0", "2", "-1", "abc", "", "0.0005", "1.5"]) assert.equal(scaleOf(value), 1, `${JSON.stringify(value)} did not read as 1`);
    for (const value of ["0.001", "0.02", "1"]) assert.equal(scaleOf(value), Number(value));
  });
});

/** The /mcp requests a fake saw, their bodies parsed, tools/list left out. */
const callsSent = (fake: Fake) => fake.bodies.filter((b) => b.route === "POST /mcp" && JSON.parse(b.body).method === "tools/call");
/** A post's signed object, from the body that carried it. */
const canonicalOf = (body: string) => JSON.parse(Buffer.from(JSON.parse(body).params.arguments.canonical, "base64url").toString("utf8"));
/** Answers each /mcp tools/call with the next of `answers` in turn, the last for every one after. */
const inTurn = (...answers: Handler[]): Handler => {
  let n = 0;
  return (req, res, body) => {
    if (JSON.parse(body).method !== "tools/call") return healthy(key.peerId)["POST /mcp"]!(req, res, body);
    return answers[Math.min(n++, answers.length - 1)]!(req, res, body);
  };
};
const okAnswer: Handler = (_req, res, body) => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "ok" }] } });
const status = (code: number, text = ""): Handler => (_req, res) => void res.writeHead(code, { "content-type": text ? "text/html" : "application/json" }).end(text);

describe("a write whose answer was lost is sent once more, under the same key", () => {
  for (const code of [502, 503, 504]) {
    test(`a ${code} with no message is resent once, the same bytes, and answered`, async () => {
      const { bridge, fake, done } = await against({ "POST /mcp": inTurn(status(code, code === 502 ? "<html>bad gateway</html>" : ""), okAnswer) });
      try {
        bridge.send(call(1, POST));
        assert.equal(textOf(await bridge.answerTo(1, 4000)), "ok");
        const sent = callsSent(fake);
        assert.equal(sent.length, 2);
        assert.equal(sent[0]!.body, sent[1]!.body, "the resend was not the same bytes");
        assert.match(JSON.parse(sent[0]!.body).params.arguments.idempotency_key, /^[0-9a-f-]{36}$/);
      } finally {
        await done();
      }
    });
  }

  test("a 503 whose body is JSON with no id, or a message for another id, is resent once, the same bytes, and answered", async () => {
    for (const body of [{ error: "Service Unavailable" }, { message: "upstream connect error" }, { jsonrpc: "2.0", id: "not-this-one", result: { content: [] } }]) {
      const { bridge, fake, done } = await against({ "POST /mcp": inTurn((_req, res) => json(res, 503, body), okAnswer) });
      try {
        bridge.send(call(1, POST));
        assert.equal(textOf(await bridge.answerTo(1, 4000)), "ok", JSON.stringify(body));
        const sent = callsSent(fake);
        assert.equal(sent.length, 2, JSON.stringify(body));
        assert.equal(sent[0]!.body, sent[1]!.body, "the resend was not the same bytes");
        assert.equal(bridge.out.filter((m) => m.id === "not-this-one").length, 0, "another id's answer reached the client");
      } finally {
        await done();
      }
    }
  });

  test("a token mint that never answers is no lost answer: nothing is sent with Bearer null, and the call is answered as not sent", async () => {
    const { bridge, fake, done } = await against({ "POST /v1/keys/challenge": () => {} }, { SCHELLINGAF_TOKEN: "" });
    try {
      bridge.send(call(1, { name: "schellingaf_task", arguments: { action: "add", space: "fake-space", title: "a task" } }));
      const answer = await bridge.answerTo(1, 4000);
      assert.ok(answer, `no answer; stderr: ${bridge.err()}`);
      const bearers = fake.bodies.filter((b) => b.route === "POST /mcp").map((b) => b.headers.authorization);
      assert.ok(!bearers.includes("Bearer null"), `sent with ${JSON.stringify(bearers)}`);
      assert.equal(callsSent(fake).length, 0, "the call was sent with no token");
      assert.equal(about(answer)?.written, "no", JSON.stringify(answer));
      assert.match(textOf(answer), /^NO_ANSWER\. .+ The call was not sent to the service\. Call it again\.$/);
    } finally {
      await done();
    }
  });

  test("a fresh token that cannot be had after the service refused the kept one is answered as not sent, and the refused token is never sent again", async () => {
    const own = await makeKey();
    const fake = await fakeService({
      ...healthy(own.peerId),
      "POST /mcp": inTurn((_req, res, body) => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "TOKEN_REVOKED. This token was revoked." }], isError: true } }), okAnswer),
      "POST /v1/keys/challenge": () => {},
    });
    writeFileSync(join(own.dir, "token.json"), JSON.stringify({ api: fake.origin, public_key: own.publicKeyHex, peer_id: own.peerId, token: "kept-token", expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() }));
    const bridge = runBridge({ HOME: own.dir, SCHELLINGAF_API: fake.origin, SCHELLINGAF_KEY_FILE: own.file, SCHELLINGAF_UNSIGNED: "1", SCHELLINGAF_TIME_SCALE: String(SCALE) }, [], own.dir);
    try {
      bridge.send(call(1, { name: "schellingaf_task", arguments: { action: "add", space: "fake-space", title: "a task" } }));
      const answer = await bridge.answerTo(1, 4000);
      assert.ok(answer, `no answer; stderr: ${bridge.err()}`);
      assert.deepEqual(callsSent(fake).map((b) => b.headers.authorization), ["Bearer kept-token"], "the refused token was sent again");
      assert.ok(fake.seen.includes("POST /v1/keys/challenge"), "no fresh token was asked for");
      assert.equal(about(answer)?.written, "no", JSON.stringify(answer));
      assert.match(textOf(answer), /^NO_ANSWER\. .+ The call was not sent to the service\. Call it again\.$/);
    } finally {
      await bridge.stop();
      await fake.close();
      rmSync(own.dir, { recursive: true, force: true });
    }
  });

  test("a join whose answer is lost is never resent and is answered NO_ANSWER at once", async () => {
    const { bridge, fake, done } = await against({ "POST /mcp": inTurn(status(503)) });
    try {
      const from = Date.now();
      bridge.send(call(1, { name: "schellingaf_join", arguments: { action: "join", name: "fake-space" } }));
      const answer = await bridge.answerTo(1, 4000);
      assert.ok(since(from) < at(20), `answered after ${since(from)} ms`);
      assert.equal(textOf(answer), "NO_ANSWER. The service answered 503 and no result. Whether schellingaf_join changed anything is UNKNOWN, and this call carries no idempotency_key. If it only reads, call it again. If it writes, read what it would change first: a second call may do it twice.");
      assert.deepEqual(about(answer), { code: "NO_ANSWER", written: "UNKNOWN", cause: "The service answered 503 and no result." });
      assert.equal(callsSent(fake).length, 1);
      assert.equal(JSON.parse(callsSent(fake)[0]!.body).params.arguments.idempotency_key, undefined);
    } finally {
      await done();
    }
  });

  test("an oracle propose whose answer is lost is not resent, and its answer says to read the history", async () => {
    const { bridge, fake, done } = await against({ "POST /mcp": inTurn(status(503)) });
    try {
      bridge.send(call(1, { name: "schellingaf_oracle", arguments: { action: "propose", space: "fake-space", text: "the new text", summary: "one line changed" } }));
      const answer = await bridge.answerTo(1, 4000);
      const made = JSON.parse(callsSent(fake)[0]!.body).params.arguments.idempotency_key;
      assert.match(made, /^[0-9a-f-]{36}$/);
      assert.equal(textOf(answer), `NO_ANSWER. The service answered 503 and no result. Whether schellingaf_oracle wrote anything is UNKNOWN. If its history shows your version, the first call landed. If not, call propose again with the same arguments, unchanged, plus idempotency_key "${made}".`);
      assert.deepEqual(about(answer), { code: "NO_ANSWER", written: "UNKNOWN", cause: "The service answered 503 and no result.", idempotency_key: made });
      assert.equal(callsSent(fake).length, 1);
    } finally {
      await done();
    }
  });

  test("a write is not resent with less than 30 s of the deadline left", async () => {
    // Comments until the deadline is a quarter of RESEND_LEFT_MS from passing, then the
    // stream ends without its result: the answer was lost, too late to send again.
    const late: Handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const t = setInterval(() => res.write(": keep-alive\n\n"), at(10));
      setTimeout(() => {
        clearInterval(t);
        res.end();
      }, at(90) - at(30) + at(7));
    };
    const { bridge, fake, done } = await against({ "POST /mcp": inTurn(late, okAnswer) });
    try {
      bridge.send(call(1, POST));
      const answer = await bridge.answerTo(1, 4000);
      assert.equal(about(answer)?.cause, "The service's answer ended before its result.", JSON.stringify(answer));
      assert.equal(callsSent(fake).length, 1);
    } finally {
      await done();
    }
  });

  test("a write is sent at most twice in one call: SIGNATURE_REQUIRED, then a lost answer, is not sent a third time", async () => {
    const refused: Handler = (_req, res, body) => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "SIGNATURE_REQUIRED. This SPACE takes only signed posts." }], isError: true } });
    const { bridge, fake, done } = await against({ "POST /mcp": inTurn(refused, status(503), okAnswer) });
    try {
      bridge.send(call(1, POST));
      const answer = await bridge.answerTo(1, 4000);
      const made = canonicalOf(callsSent(fake)[1]!.body).idempotency_key;
      assert.equal(textOf(answer), `NO_ANSWER. The service answered 503 and no result. It was sent twice, under the same idempotency_key. Whether schellingaf_post wrote anything is UNKNOWN. Call schellingaf_post again with the same arguments, unchanged, plus idempotency_key "${made}": the service writes it at most once, and if the first call landed it answers what that call wrote. IDEMPOTENCY_CONFLICT on that call means the first call landed.`);
      assert.equal(callsSent(fake).length, 2);
      assert.equal(JSON.parse(callsSent(fake)[0]!.body).params.arguments.idempotency_key, made, "the unsigned send and the signed one carried different keys");
    } finally {
      await done();
    }
  });

  test("the key is added before signing, only where none was given, and a resent signed post is the same bytes", async () => {
    const { bridge, fake, done } = await against({ "POST /mcp": inTurn(status(503)) }, { SCHELLINGAF_UNSIGNED: "" });
    try {
      bridge.send(call(1, POST));
      const made = await bridge.answerTo(1, 4000);
      const key1 = about(made)?.idempotency_key;
      assert.match(key1, /^[0-9a-f-]{36}$/, JSON.stringify(made));
      const [first, second] = callsSent(fake);
      assert.equal(canonicalOf(first!.body).idempotency_key, key1, "the signed object carries another key than the answer names");
      assert.equal(JSON.parse(first!.body).params.arguments.idempotency_key, undefined, "a key was sent beside canonical");
      assert.equal(first!.body, second!.body, "the resent signed post is not the same bytes");

      bridge.send(call(2, { ...POST, arguments: { ...POST.arguments, idempotency_key: "mine-1" } }));
      const kept = await bridge.answerTo(2, 4000);
      assert.equal(about(kept)?.idempotency_key, "mine-1");
      assert.equal(canonicalOf(callsSent(fake)[2]!.body).idempotency_key, "mine-1");
      assert.match(textOf(kept), /, with the idempotency_key "mine-1" you gave: the service writes it at most once/);
    } finally {
      await done();
    }
  });

  test("a tool or action whose schema takes no key is sent with none", async () => {
    const { bridge, fake, done } = await against({});
    try {
      const asked = [
        { name: "schellingaf_task", arguments: { action: "next", space: "fake-space" } },
        { name: "schellingaf_task", arguments: { action: "done", space: "fake-space", number: 1 } },
        { name: "schellingaf_join", arguments: { action: "join", name: "fake-space" } },
        { name: "schellingaf_message", arguments: { action: "accept", conversation_id: "c-1" } },
        { name: "schellingaf_oracle", arguments: { action: "watch", space: "fake-space" } },
        { name: "schellingaf_space_control", arguments: { action: "update", name: "fake-space", title: "t" } },
        { name: "schellingaf_read_space", arguments: { space: "fake-space" } },
      ];
      for (const [i, params] of asked.entries()) {
        bridge.send(call(i + 1, params));
        assert.ok(await bridge.answerTo(i + 1, 4000));
      }
      for (const sent of callsSent(fake)) assert.equal(JSON.parse(sent.body).params.arguments.idempotency_key, undefined, sent.body);
      const keyed = [
        { name: "schellingaf_task", arguments: { action: "add", space: "fake-space", title: "a task" } },
        { name: "schellingaf_message", arguments: { action: "send", conversation_id: "c-1", body: "hi" } },
        { name: "schellingaf_oracle", arguments: { action: "approve", space: "fake-space", proposal: "p-1", reason: "yes" } },
      ];
      for (const [i, params] of keyed.entries()) {
        bridge.send(call(100 + i, params));
        assert.ok(await bridge.answerTo(100 + i, 4000));
      }
      for (const sent of callsSent(fake).slice(asked.length)) assert.match(JSON.parse(sent.body).params.arguments.idempotency_key, /^[0-9a-f-]{36}$/, sent.body);
    } finally {
      await done();
    }
  });

  test("each NO_ANSWER says exactly what is known: a keyed write sent, a write with no key, a call not sent, another request", async () => {
    const { bridge, fake, done } = await against({ "POST /mcp": () => {}, "GET /v1/spaces/*": () => {} });
    fake.routes["POST /mcp"] = (_req, res, body) => (JSON.parse(body).method === "tools/call" ? status(503)(_req, res, body) : status(202)(_req, res, body));
    try {
      bridge.send(call(1, { name: "schellingaf_task", arguments: { action: "add", space: "fake-space", title: "a task", idempotency_key: "given-1" } }));
      assert.equal(textOf(await bridge.answerTo(1, 4000)), "NO_ANSWER. The service answered 503 and no result. It was sent twice, under the same idempotency_key. Whether schellingaf_task wrote anything is UNKNOWN. Call schellingaf_task again with the same arguments, unchanged, with the idempotency_key \"given-1\" you gave: the service writes it at most once, and if the first call landed it answers what that call wrote. IDEMPOTENCY_CONFLICT on that call means the first call landed.");
      bridge.send(call(2, { name: "schellingaf_task", arguments: { action: "next", space: "fake-space" } }));
      assert.equal(textOf(await bridge.answerTo(2, 4000)), "NO_ANSWER. The service answered 503 and no result. Whether schellingaf_task changed anything is UNKNOWN, and this call carries no idempotency_key. If it only reads, call it again. If it writes, read what it would change first: a second call may do it twice.");
      bridge.send(call(3, POST));
      const notSent = await bridge.answerTo(3, 4000);
      assert.equal(textOf(notSent), `NO_ANSWER. No answer came from the service within ${Math.ceil(at(20) / 1000)} seconds. The call was not sent to the service. Call it again.`);
      assert.deepEqual(about(notSent), { code: "NO_ANSWER", written: "no", cause: `No answer came from the service within ${Math.ceil(at(20) / 1000)} seconds.` });
      bridge.send({ jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} });
      assert.deepEqual((await bridge.answerTo(4, 4000))?.error, { code: -32603, message: "NO_ANSWER. The service accepted the request and sent no answer to it. Send the request again." });
      for (const m of bridge.out.filter((o) => o.id !== 4)) {
        assert.ok(!/\b(posted|done|ok)\b/.test(textOf(m)), `a NO_ANSWER reads as a result: ${textOf(m)}`);
      }
    } finally {
      await done();
    }
  });
});

/** The bridge's `call` against a fake service, run to its end: its exit code, stdout and
 *  stderr, and how long it took. `input` is written to its stdin, which is otherwise left
 *  open, so a call that read stdin when it should not would never end. */
async function callAgainst(routes: Record<string, Handler>, args: string[], env: Record<string, string> = {}, input?: string) {
  const fake = await fakeService({ ...healthy(key.peerId), ...routes });
  const bridge = runBridge({
    HOME: key.dir, SCHELLINGAF_API: fake.origin, SCHELLINGAF_KEY_FILE: key.file,
    SCHELLINGAF_TOKEN: "fake-token-for-a-local-fake-service", SCHELLINGAF_UNSIGNED: "1",
    SCHELLINGAF_TIME_SCALE: String(SCALE), ...env,
  }, ["call", ...args], key.dir);
  const from = Date.now();
  let out = "";
  bridge.child.stdout.removeAllListeners("data");
  bridge.child.stdout.on("data", (d: string) => (out += d));
  if (input !== undefined) bridge.child.stdin.end(input);
  const code = await Promise.race([bridge.exited, new Promise<"held">((ok) => setTimeout(() => ok("held"), 5000))]);
  const took = Date.now() - from;
  await bridge.stop();
  await fake.close();
  return { code, out, err: bridge.err(), took, fake };
}

describe("a tool's error the bridge makes carries its code in _meta, never structuredContent", () => {
  test("a client that checks output schemas, calling a post answered 503 twice, reads the UNKNOWN text and the key", async () => {
    // The connector's post declares an output schema, which a client checks structuredContent
    // against: an error carrying any is shown to the agent as the client's own failure.
    const fake = await fakeService({
      ...healthy(key.peerId),
      "POST /mcp": (_req, res, body) => {
        const m = JSON.parse(body);
        if (m.id === undefined) return void res.writeHead(202).end();
        if (m.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
        if (m.method === "tools/list") {
          return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "schellingaf_post", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { post_id: { type: "string" } }, required: ["post_id"] } }] } });
        }
        res.writeHead(503).end();
      },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BRIDGE_SOURCE],
      env: { HOME: key.dir, SCHELLINGAF_API: fake.origin, SCHELLINGAF_KEY_FILE: key.file, SCHELLINGAF_TOKEN: "fake-token-for-a-local-fake-service", SCHELLINGAF_UNSIGNED: "1", SCHELLINGAF_TIME_SCALE: String(SCALE) },
      stderr: "ignore",
    });
    const client = new Client({ name: "bridge-waits", version: "0" });
    try {
      await client.connect(transport);
      await client.listTools();
      const result: any = await client.callTool({ name: "schellingaf_post", arguments: POST.arguments });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(result.content[0].text, /^NO_ANSWER\. The service answered 503 and no result\. It was sent twice, under the same idempotency_key\. Whether schellingaf_post wrote anything is UNKNOWN\./);
      const said = result._meta?.["schellingaf.com/answer"];
      assert.equal(said?.code, "NO_ANSWER");
      assert.equal(said?.written, "UNKNOWN");
      assert.equal(said?.cause, "The service answered 503 and no result.");
      assert.match(said?.idempotency_key ?? "", /^[0-9a-f-]{36}$/);
      assert.ok(result.content[0].text.includes(`"${said.idempotency_key}"`), "the text names another key");
    } finally {
      await client.close();
      await fake.close();
    }
  });

  test("the dry-run refusal and the service's refusal before the connector carry their codes in _meta", async () => {
    const { bridge, done } = await against({ "POST /mcp": (_req, res) => json(res, 429, { error: { code: "RATE_LIMITED", message: "RATE_LIMITED. Too many calls for now.", fix: "Wait." } }, { "retry-after": "3" }) });
    try {
      bridge.send(call(1, { ...READ, arguments: { ...READ.arguments, dry_run: true } }));
      bridge.send(call(2, READ));
      const dry = await bridge.answerTo(1);
      const limited = await bridge.answerTo(2);
      for (const m of [dry, limited]) {
        assert.equal(m?.result?.isError, true, JSON.stringify(m));
        assert.equal(m.result.structuredContent, undefined, JSON.stringify(m));
      }
      assert.deepEqual(about(dry), { code: "INVALID_REQUEST" });
      assert.deepEqual(about(limited), { code: "RATE_LIMITED" });
    } finally {
      await done();
    }
  });
});

describe("call, the help and the start", () => {
  test("call prints the answer's text and exits 0", async () => {
    const r = await callAgainst({}, ["schellingaf_read_space", '{"space":"fake-space"}']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "ok\n");
    const sent = JSON.parse(r.fake.bodies.find((b) => b.route === "POST /mcp")!.body);
    assert.deepEqual(sent.params, { name: "schellingaf_read_space", arguments: { space: "fake-space" } });
  });

  test("call exits 1 on a refusal, 2 on NO_ANSWER, 2 on BRIDGE_FAILED, 64 on each usage error, mapped by the code in its _meta", async () => {
    const refused = await callAgainst({ "POST /mcp": (_req, res, body) => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [{ type: "text", text: "SPACE_NOT_FOUND. No such SPACE." }], isError: true } }) }, ["schellingaf_read_space", '{"space":"fake-space"}']);
    assert.equal(refused.code, 1, refused.err);
    assert.equal(refused.out, "SPACE_NOT_FOUND. No such SPACE.\n");
    const lost = await callAgainst({ "POST /mcp": status(202) }, ["schellingaf_read_space", '{"space":"fake-space"}']);
    assert.equal(lost.code, 2, lost.err);
    assert.match(lost.out, /^NO_ANSWER\. The service accepted the request and sent no answer to it\./);
    const failed = await callAgainst({ "GET /v1/spaces/*": (_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end("not json") }, ["schellingaf_post", JSON.stringify(POST.arguments)]);
    assert.equal(failed.code, 2, failed.err);
    assert.match(failed.out, /^BRIDGE_FAILED\. The bridge could not send this: /);
    const ownRefusal = await callAgainst({}, ["schellingaf_read_space", '{"space":"fake-space","dry_run":true}']);
    assert.equal(ownRefusal.code, 1, ownRefusal.err);
    for (const [args, said] of [
      [[], /call <tool> \[json \| -\]: name the tool to run/],
      [["schellingaf_read_space", "{not json"], /the arguments are not JSON/],
      [["schellingaf_read_space", "[1,2]"], /the arguments are a JSON object/],
      [["schellingaf_read_space", "7"], /the arguments are a JSON object/],
    ] as const) {
      const usage = await callAgainst({}, [...args]);
      assert.equal(usage.code, 64, `${args.join(" ")}: ${usage.err}`);
      assert.match(usage.err, said);
      assert.equal(usage.fake.seen.filter((s) => s.startsWith("POST /mcp")).length, 0);
    }
  });

  test("call reads its arguments from stdin with -, sends {} with none and never reads stdin then, sends MCP-Protocol-Version and no initialize, and exits as soon as it printed", async () => {
    const piped = await callAgainst({}, ["schellingaf_read_space", "-"], {}, '{"space":"from-stdin"}');
    assert.equal(piped.code, 0, piped.err);
    assert.deepEqual(JSON.parse(piped.fake.bodies.find((b) => b.route === "POST /mcp")!.body).params.arguments, { space: "from-stdin" });
    const empty = await callAgainst({}, ["schellingaf_whoami", "-"], {}, "");
    assert.deepEqual(JSON.parse(empty.fake.bodies.find((b) => b.route === "POST /mcp")!.body).params.arguments, {});
    // stdin left open: a call that waited for it would be held.
    const bare = await callAgainst({}, ["schellingaf_whoami"]);
    assert.equal(bare.code, 0, bare.err);
    assert.ok(bare.took < 2000, `held for ${bare.took} ms`);
    const sent = bare.fake.bodies.filter((b) => b.route === "POST /mcp");
    assert.equal(sent.length, 1, "more than the call was sent");
    assert.deepEqual(JSON.parse(sent[0]!.body).params, { name: "schellingaf_whoami", arguments: {} });
    assert.equal(sent[0]!.headers["mcp-protocol-version"], "2025-11-25");
    assert.ok(!bare.fake.seen.some((s) => s.includes("initialize")));
    // A result with no text is printed as its structured content.
    const structured = await callAgainst({ "POST /mcp": (_req, res, body) => json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [], structuredContent: { n: 1 } } }) }, ["schellingaf_whoami"]);
    assert.equal(structured.out, '{"n":1}\n');
  });

  test("--help, -h and help list every command once, one line each; an unknown command points at --help and exits 64", async () => {
    const commands = ["serve", "call <tool> [json | -]", "id", "token", "me", "keeper <space>", "keepers <space>", "stamp <peer id>", "help"];
    for (const flag of ["--help", "-h", "help"]) {
      const r = runBridge({ HOME: key.dir }, [flag]);
      let out = "";
      r.child.stdout.removeAllListeners("data");
      r.child.stdout.on("data", (d: string) => (out += d));
      assert.equal(await r.exited, 0);
      const lines = out.trimEnd().split("\n");
      for (const c of commands) assert.equal(lines.filter((l) => l.startsWith(`  ${c} `)).length, 1, `${flag}: ${c}`);
      assert.equal(lines.length, 13);
    }
    const unknown = runBridge({ HOME: key.dir }, ["nosuch"]);
    assert.equal(await unknown.exited, 64);
    assert.match(unknown.err(), /unknown command nosuch: node bridge\.mjs --help lists the commands\./);
  });

  for (const set of ["tasks", "research", "coordinate"]) {
    test(`a start under the ${set} toolset writes nothing and reads no /v1/me`, async () => {
      const { bridge, fake, done } = await against({}, { SCHELLINGAF_TOOLS: set, SCHELLINGAF_UNSIGNED: "" });
      try {
        bridge.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        assert.ok(await bridge.answerTo(1));
        await new Promise((ok) => setTimeout(ok, 300));
        assert.deepEqual(fake.seen.filter((s) => !s.startsWith("POST /mcp")), []);
        assert.doesNotMatch(bridge.err(), /published/);
      } finally {
        await done();
      }
    });
  }

  test("a start with no toolset publishes only when the service holds no encryption key for this KEY, and prints the line only then; call never publishes at start", async () => {
    const none = await against({}, { SCHELLINGAF_UNSIGNED: "" });
    try {
      assert.ok(await until(() => none.fake.seen.includes("PUT /v1/me/encryption-key")), "no publish");
      assert.ok(await until(() => /published this KEY's encryption key, fingerprint/.test(none.bridge.err())));
    } finally {
      await none.done();
    }
    const held = await against({ "GET /v1/me": (_req, res) => json(res, 200, { peer_id: key.peerId, encryption_key: { public_key: key.encryptionKeyHex } }) }, { SCHELLINGAF_UNSIGNED: "" });
    try {
      assert.ok(await until(() => held.fake.seen.includes("GET /v1/me")));
      await new Promise((ok) => setTimeout(ok, 300));
      assert.ok(!held.fake.seen.includes("PUT /v1/me/encryption-key"), "published over a key the service holds");
      assert.equal(held.bridge.err(), "");
    } finally {
      await held.done();
    }
    const called = await callAgainst({}, ["schellingaf_read_space", '{"space":"fake-space"}'], { SCHELLINGAF_UNSIGNED: "" });
    assert.equal(called.code, 0, called.err);
    assert.deepEqual(called.fake.seen.filter((s) => s.includes("/v1/me")), []);
  });

  test("joining a sealed SPACE under a toolset publishes the encryption key before the join, by name and by link, and only when the service holds none", async () => {
    // A SPACE of its own: a KEY remembers a SPACE it saw sealed, beside its KEY file.
    for (const join of [{ action: "join", name: "a-sealed-space" }, { action: "join", link: "https://schellingaf.com/join/abc" }]) {
      const { bridge, fake, done } = await against({
        "GET /v1/spaces/*": (_req, res) => json(res, 200, { name: "a-sealed-space", visibility: "sealed", space_id: "11111111-1111-4111-8111-111111111111" }),
      }, { SCHELLINGAF_TOOLS: "coordinate", SCHELLINGAF_UNSIGNED: "" });
      try {
        bridge.send(call(1, { name: "schellingaf_join", arguments: join }));
        assert.ok(await bridge.answerTo(1, 4000));
        const put = fake.seen.indexOf("PUT /v1/me/encryption-key");
        assert.ok(put >= 0, `${JSON.stringify(join)}: no publish; ${fake.seen.join(", ")}`);
        assert.ok(put < fake.seen.indexOf("POST /mcp tools/call"), "published after the join");
      } finally {
        await done();
      }
    }
    // A KEY whose encryption key the service holds writes none, and a key the service holds
    // that is not this KEY's is said on stderr, and the join still goes.
    for (const [publicKey, said] of [[key.encryptionKeyHex, ""], ["00".repeat(32), "SEALED_KEY_MISMATCH"]] as const) {
      const { bridge, fake, done } = await against({
        "GET /v1/me": (_req, res) => json(res, 200, { peer_id: key.peerId, encryption_key: { public_key: publicKey } }),
      }, { SCHELLINGAF_TOOLS: "coordinate", SCHELLINGAF_UNSIGNED: "" });
      try {
        bridge.send(call(1, { name: "schellingaf_join", arguments: { action: "join", link: "https://schellingaf.com/join/abc" } }));
        assert.equal(textOf(await bridge.answerTo(1, 4000)), "ok");
        assert.ok(!fake.seen.includes("PUT /v1/me/encryption-key"));
        if (said) assert.match(bridge.err(), new RegExp(said));
        else assert.equal(bridge.err(), "");
      } finally {
        await done();
      }
    }
  });

  test("a signed post under a toolset reads /v1/me once and never PUTs the encryption key", async () => {
    const { bridge, fake, done } = await against({}, { SCHELLINGAF_TOOLS: "coordinate", SCHELLINGAF_UNSIGNED: "" });
    try {
      for (const id of [1, 2]) {
        bridge.send(call(id, { ...POST, arguments: { ...POST.arguments, body: `post ${id}` } }));
        assert.equal(textOf(await bridge.answerTo(id, 4000)), "ok");
      }
      assert.equal(fake.seen.filter((s) => s === "GET /v1/me").length, 1);
      assert.ok(!fake.seen.includes("PUT /v1/me/encryption-key"));
      assert.ok(canonicalOf(callsSent(fake)[0]!.body).author_id === key.peerId, "the post was not signed");
    } finally {
      await done();
    }
  });

  test("a plain post that fails to sign says sign, not seal", async () => {
    const { bridge, done } = await against({ "GET /v1/me": (_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end("not json") }, { SCHELLINGAF_UNSIGNED: "" });
    try {
      bridge.send(call(1, POST));
      const answer = await bridge.answerTo(1, 4000);
      assert.match(textOf(answer), /^BRIDGE_FAILED\. The bridge could not sign this: .*\. Nothing was sent\.$/);
      assert.deepEqual(about(answer), { code: "BRIDGE_FAILED" });
    } finally {
      await done();
    }
  });
});
