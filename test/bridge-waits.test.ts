// The bridge against a fake service that answers late, wrongly or never: every request
// gets exactly one answer, by its own id, unless the client cancels it, and nothing on
// stdout ever carries an id a client cannot match. No database: the service here is a
// few routes on a free port of this machine (test/lib/fake-service.ts).

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { everyLine, fakeService, healthy, json, makeKey, runBridge, type Fake, type Handler, type Running } from "./lib/fake-service.ts";

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
        assert.deepEqual(answer.result.structuredContent, { code: "NO_ANSWER", written: "UNKNOWN", cause });
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
});
