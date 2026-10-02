// A read that waits for something new, and what it holds while it waits.
//
// The gate here has ONE place, so a waiting read that kept its place would block
// every other request on the service, and the test that reads beside a waiter
// would hang instead of passing.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { filed } from "./helpers.ts";
import { useService, app, agent, connector, send, read, type Agent } from "./lib/service.ts";
import { waitingNow } from "../src/http/wait.ts";

const savedGate = process.env.GLOBAL_CONCURRENT_READS;
before(() => {
  process.env.GLOBAL_CONCURRENT_READS = "1";
});
useService("wait");
after(() => {
  if (savedGate === undefined) delete process.env.GLOBAL_CONCURRENT_READS;
  else process.env.GLOBAL_CONCURRENT_READS = savedGate;
});

/** A request as this file sends it: a JSON content type always, a body only when
 * there is one. */
async function http(method: string, path: string, token?: string, body?: unknown) {
  const payload = body === undefined ? undefined : filed(method, path, body);
  return read(await send(app, method, path, token, payload, { "content-type": "application/json" }));
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a read that waits", () => {
  let owner: Agent;
  let reader: Agent;

  before(async () => {
    owner = await agent();
    reader = await agent();
    assert.equal((await http("POST", "/v1/spaces", owner.token, { name: "waiting-space", title: "Waiting" })).status, 201);
    assert.equal((await http("PUT", `/v1/spaces/waiting-space/members/${reader.peerId}`, owner.token, { role: "writer" })).status, 200);
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "obs", body: "the first" });
  });

  test("answers at once when something is already past the cursor", async () => {
    const started = Date.now();
    const out = await http("GET", "/v1/spaces/waiting-space/posts?after=0&wait=20", reader.token);
    assert.equal(out.status, 200);
    assert.equal(out.body.items.length, 1);
    assert.ok(Date.now() - started < 2000, "it waited although there was a post to answer with");
  });

  test("holds with nothing new, and answers as soon as a post lands, holding no place in the gate", async () => {
    const pending = http("GET", "/v1/spaces/waiting-space/posts?after=1&wait=20", reader.token);
    await later(150);
    assert.equal(waitingNow(), 1);
    // The gate has one place. This read is served only if the waiter gave its up.
    const beside = await http("GET", "/v1/spaces/waiting-space", owner.token);
    assert.equal(beside.status, 200);
    const started = Date.now();
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "result", body: "the second" });
    const out = await pending;
    assert.equal(out.status, 200);
    assert.deepEqual(out.body.items.map((i: any) => i.seq), ["2"]);
    assert.ok(Date.now() - started < 2000, "the post landed and the waiter did not answer");
    assert.equal(waitingNow(), 0);
  });

  test("runs out and answers the ordinary empty page, with the head", async () => {
    const started = Date.now();
    const out = await http("GET", "/v1/spaces/waiting-space/posts?after=2&wait=1", reader.token);
    assert.equal(out.status, 200);
    assert.equal(out.body.items.length, 0);
    assert.equal(out.body.head_seq, "2");
    assert.equal(out.body.next_after, "2");
    assert.ok(Date.now() - started >= 900, "it answered before its wait was up");
  });

  test("a post its filter does not match does not end the wait", async () => {
    const pending = http("GET", "/v1/spaces/waiting-space/posts?after=2&kind=dossier&wait=20", reader.token);
    await later(150);
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "obs", body: "not a dossier" });
    await later(300);
    assert.equal(waitingNow(), 1, "a post of another kind ended the wait");
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "dossier", body: "the state" });
    const out = await pending;
    assert.deepEqual(out.body.items.map((i: any) => i.kind), ["dossier"]);
  });

  test("is refused where waiting makes no sense, and to a caller with no KEY", async () => {
    assert.equal((await http("GET", "/v1/spaces/waiting-space/posts?wait=5")).body.error.code, "TOKEN_MISSING");
    const desc = await http("GET", "/v1/spaces/waiting-space/posts?order=desc&wait=5", reader.token);
    assert.equal(desc.body.error.code, "INVALID_REQUEST");
    assert.match(desc.body.error.detail, /order asc/);
    assert.equal((await http("GET", "/v1/spaces/waiting-space/posts?wait=26", reader.token)).body.error.code, "INVALID_REQUEST");
    assert.equal((await http("GET", "/v1/spaces/waiting-space/posts?wait=soon", reader.token)).body.error.code, "INVALID_REQUEST");
  });

  test("a KEY may keep two reads waiting, and a third is told the service is busy", async () => {
    const head = (await http("GET", "/v1/spaces/waiting-space/posts?order=desc&limit=1", reader.token)).body.head_seq;
    const first = http("GET", `/v1/spaces/waiting-space/posts?after=${head}&wait=20`, reader.token);
    const mailboxHead = (await http("GET", "/v1/me", reader.token)).body.mailbox_head;
    const second = http("GET", `/v1/mailbox?after=${mailboxHead}&wait=20`, reader.token);
    await later(150);
    const third = await http("GET", `/v1/spaces/waiting-space/posts?after=${head}&wait=20`, reader.token);
    assert.equal(third.status, 503);
    assert.equal(third.body.error.code, "BUSY");
    // One post addressed to the KEY ends both waits, rather than their running out.
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "question", body: "for both waits", to: [reader.peerId] });
    const ended = await Promise.all([first, second]);
    assert.deepEqual(ended.map((out) => [out.status, out.body.items.length]), [[200, 1], [200, 1]]);
  });

  test("a wait ends when its client leaves, and gives its place back", async () => {
    const head = (await http("GET", "/v1/spaces/waiting-space/posts?order=desc&limit=1", reader.token)).body.head_seq;
    const left = new AbortController();
    const pending = app.request(`/v1/spaces/waiting-space/posts?after=${head}&wait=20`, {
      headers: { authorization: `Bearer ${reader.token}` },
      signal: left.signal,
    });
    await later(150);
    assert.equal(waitingNow(), 1);
    const started = Date.now();
    left.abort();
    await (await pending).text();
    assert.ok(Date.now() - started < 2000, "the wait went on after its client left");
    assert.equal(waitingNow(), 0);
  });

  test("the mailbox waits for a delivery, and a post addressed to the KEY ends it", async () => {
    const head = (await http("GET", "/v1/me", reader.token)).body.mailbox_head;
    const pending = http("GET", `/v1/mailbox?after=${head}&wait=20`, reader.token);
    await later(150);
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "question", body: "for you", to: [reader.peerId] });
    const out = await pending;
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.items.length, 1);
  });

  test("the connector tool waits too, and says what it read", async () => {
    const head = (await http("GET", "/v1/spaces/waiting-space/posts?order=desc&limit=1", reader.token)).body.head_seq;
    const pending = connector("tools/call", { name: "schellingaf_read_space", arguments: { space: "waiting-space", after: head, wait: 20 } }, reader);
    await later(200);
    await http("POST", "/v1/spaces/waiting-space/posts", owner.token, { kind: "result", body: "through the connector" });
    const { message } = await pending;
    assert.match(message.result.content[0].text, /through the connector/);
  });
});
