// A POST of every kind but the coordination group's carries a title, since a headline
// shows it: refused with TITLE_REQUIRED, the kind its detail, before anything is spent,
// unsigned, signed and through the connector, and in a create's version. A sealed POST's
// title is in its ciphertext: the service takes it as it is, and the bridge checks it
// before sealing (test/sealed-spaces.test.ts and test/bridge.test.ts hold those).
//
// These send around the test helpers, which title every POST that names no title.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sign } from "node:crypto";
import { useService, app, fixture, send, read, agent, call, type Agent } from "./lib/service.ts";
import { TEST_CATEGORY } from "./helpers.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { ERRORS } from "../src/db/errors.ts";
import { KIND_GROUPS, KINDS } from "../src/surface/vocabulary.ts";

const ready = useService("titles", { apiHost: "api.titles.test", oracleReviewer: null });

let owner: Agent;
let name: string;
let spaceId: string;

/** A request sent as it is written, with no title added. */
async function raw(method: string, path: string, who: Agent | null, body?: unknown) {
  return read(await send(app, method, path, who?.token ?? null, body));
}

/** A tools/call at /mcp sent as it is written. */
async function rawTool(toolName: string, args: Record<string, unknown>, who: Agent) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${who.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
  });
  const text = await res.text();
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  return JSON.parse(data ? data.slice(5) : text).result;
}

const TITLED = KINDS.filter((k) => !(KIND_GROUPS.coordination as readonly string[]).includes(k) && k !== "version");

before(async () => {
  await ready;
  owner = await agent();
  name = `titles-${process.pid}`;
  const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Titles", document: true });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  spaceId = made.body.space_id;
});

describe("a POST needs a title, but for ack, hold, go, veto and stop", () => {
  test("capabilities lists the kinds that post without one", async () => {
    const caps = (await call("GET", "/v1/capabilities")).body;
    assert.deepEqual(caps.kinds_without_title, ["ack", "hold", "go", "veto", "stop"]);
  });

  test("every other kind is refused untitled, unsigned, in the words the refusal holds, and spends nothing", async () => {
    const fresh = await agent();
    assert.equal((await call("PUT", `/v1/spaces/${name}/members/${fresh.peerId}`, owner.token, { role: "writer" })).status, 200);
    // A finding's own fields are checked first, so this one carries them.
    const data = (kind: string) => (kind === "finding" ? { data: { claim: "Row 4 reads TA", status: "proposed", confidence: "low" } } : {});
    for (const kind of [...TITLED, "version"]) {
      for (const title of [undefined, null, "   "]) {
        const out = await raw("POST", `/v1/spaces/${name}/posts`, fresh, { kind, body: "No title.", ...data(kind), ...(title === undefined ? {} : { title }) });
        assert.equal(out.status, 400, `${kind} ${JSON.stringify(title)}: ${JSON.stringify(out.body)}`);
        assert.equal(out.body.error.code, "TITLE_REQUIRED");
        assert.equal(out.body.error.detail, kind);
        assert.equal(out.body.error.message, "TITLE_REQUIRED. This kind of POST needs a title.");
        assert.equal(out.body.error.fix, "Send title: the result and the figure that decides it, not the topic, in about 120 bytes. Only ack, hold, go, veto and stop post without one. Nothing was posted.");
      }
    }
    const [spent] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets where key = ${`peer:${fresh.peerId}`}`;
    assert.equal(spent!.n, 0, "a refusal spent the write allowance");
    // An empty title is no string a title may be, as before.
    const empty = await raw("POST", `/v1/spaces/${name}/posts`, fresh, { kind: "obs", title: "", body: "No title." });
    assert.deepEqual([empty.body.error.code, empty.body.error.detail], ["INVALID_REQUEST", "title"]);
    const [posts] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.posts where author_id = ${Buffer.from(fresh.peerId, "hex")}`;
    assert.equal(posts!.n, 0);
    // And a titled one is taken, and spends.
    assert.equal((await raw("POST", `/v1/spaces/${name}/posts`, fresh, { kind: "obs", title: "Seen", body: "Seen." })).status, 201);
    const [after] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets where key = ${`peer:${fresh.peerId}`}`;
    assert.equal(after!.n, 1);
  });

  test("ack, hold, go, veto and stop post without one", async () => {
    const target = await raw("POST", `/v1/spaces/${name}/posts`, owner, { kind: "question", title: "Ship it?", body: "Ship it?" });
    assert.equal(target.status, 201, JSON.stringify(target.body));
    for (const kind of KIND_GROUPS.coordination) {
      const out = await raw("POST", `/v1/spaces/${name}/posts`, owner, { kind, body: `${kind}.`, reply_to: target.body.post_id });
      assert.equal(out.status, 201, `${kind}: ${JSON.stringify(out.body)}`);
    }
  });

  test("a signed POST is held to the title its author signed", async () => {
    const fields = {
      spaceId, author: owner.peerId, kind: "result", body: "Signed.", to: [], replyTo: null, supersedes: null, retracts: null,
      fingerprints: [], data: null, budget: null, runId: null,
    };
    const signedBody = (title: string | null, idempotencyKey: string) => {
      const built = buildPostObject({ ...fields, title, idempotencyKey });
      return { alg: "ed25519", canonical: built.canonical.toString("base64url"), signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex") };
    };
    const refused = await raw("POST", `/v1/spaces/${name}/posts`, owner, signedBody(null, "signed-untitled"));
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual([refused.body.error.code, refused.body.error.detail], ["TITLE_REQUIRED", "result"]);
    const taken = await raw("POST", `/v1/spaces/${name}/posts`, owner, signedBody("Signed: 1 of 1", "signed-titled"));
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    const ack = buildPostObject({ ...fields, kind: "ack", title: null, idempotencyKey: "signed-ack", replyTo: taken.body.post_id });
    const acked = await raw("POST", `/v1/spaces/${name}/posts`, owner, {
      alg: "ed25519", canonical: ack.canonical.toString("base64url"), signature: sign(null, signaturePreimageOf(ack.objectId), owner.privateKey).toString("hex"),
    });
    assert.equal(acked.status, 201, JSON.stringify(acked.body));
  });

  test("a retry of a POST posted untitled before titles were required answers TITLE_REQUIRED, not its replay", async () => {
    // Written as append_post wrote one before: it holds no rule on titles, the API does.
    const key = "before-titles";
    await fixture.owner`
      select schellingaf.append_post(p_space_name => ${name}, p_author => ${Buffer.from(owner.peerId, "hex")}, p_kind => 'obs',
        p_title => null::text, p_body => 'from before', p_data => null::jsonb, p_budget => null::jsonb, p_to => '{}'::bytea[],
        p_run_id => null::uuid, p_reply_to => null::uuid, p_supersedes => null::uuid, p_retracts => null::uuid,
        p_fingerprints => '[]'::jsonb, p_idempotency_key => ${key})`;
    const retry = await raw("POST", `/v1/spaces/${name}/posts`, owner, { kind: "obs", body: "from before", idempotency_key: key });
    assert.equal(retry.status, 400, JSON.stringify(retry.body));
    assert.equal(retry.body.error.code, "TITLE_REQUIRED");
  });

  test("through the connector, schellingaf_post is refused untitled, and propose without summary before the document is read", async () => {
    const posted = await rawTool("schellingaf_post", { space: name, kind: "result", body: "No title." }, owner);
    assert.equal(posted.isError, true);
    assert.match(posted.content[0].text, /^TITLE_REQUIRED\. This kind of POST needs a title\. \(result\) Send title:/);
    const proposed = await rawTool("schellingaf_oracle", { action: "propose", space: name, text: "## Status\n\nOn track." }, owner);
    assert.equal(proposed.isError, true);
    assert.equal(proposed.content[0].text, "TITLE_REQUIRED. The propose action needs summary: what you changed, in one line.");
    const titled = await rawTool("schellingaf_oracle", { action: "propose", space: name, text: "## Status\n\nOn track.", summary: "On track" }, owner);
    assert.equal(titled.isError, undefined, JSON.stringify(titled));
  });

  test("a create's version needs one too, and nothing is made without it", async () => {
    const made = `titles-create-${process.pid}`;
    const out = await raw("POST", "/v1/spaces", owner, { name: made, title: "Made", document: true, categories: [TEST_CATEGORY], version: { body: "## Status\n\nNew." } });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.deepEqual([out.body.error.code, out.body.error.detail], ["TITLE_REQUIRED", "version"]);
    assert.equal((await call("GET", `/v1/spaces/${made}`, owner.token)).status, 404);
  });
});

describe("the bridge says what the service says", () => {
  test("its kinds without a title and its refusal are the service's", () => {
    const bridge = readFileSync(new URL("../content/bridge.mjs", import.meta.url), "utf8");
    const kinds = /const KINDS_WITHOUT_TITLE = (\[[^\]]*\]);/.exec(bridge);
    assert.ok(kinds, "the bridge names its kinds without a title");
    assert.deepEqual(JSON.parse(kinds[1]!), KIND_GROUPS.coordination);
    const words = /new Refusal\("(TITLE_REQUIRED\.[^"]*)"\)/.exec(bridge);
    assert.ok(words);
    assert.equal(words[1], `${ERRORS.TITLE_REQUIRED!.message} ${ERRORS.TITLE_REQUIRED!.fix}`);
  });
});
