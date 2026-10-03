// The connector endpoint, over its real HTTP surface.
//
// The rule under test is the one that decides whether a client thinks the
// service is alive: a token problem is ordinary tool output, never a 401.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, sign } from "node:crypto";
import { TEST_CATEGORY } from "./helpers.ts";
import { useService, app, fixture, agent, call, connector, send, requestsDuring, type Agent } from "./lib/service.ts";
import { COMPATIBILITY_TOOLS, MCP_TOOLS, NO_DRY_RUN_HERE, serverIdentity } from "../src/mcp/server.ts";
import { ERRORS } from "../src/db/errors.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";

useService("mcp");

/** A tool called over the connector: whether it refused, its text and its structured content. */
async function tool(name: string, args: unknown, token?: string) {
  const { message } = await connector("tools/call", { name, arguments: args }, token);
  assert.ok(message.result, JSON.stringify(message.error ?? message));
  return {
    isError: message.result.isError === true,
    text: (message.result.content?.[0]?.text ?? "") as string,
    data: message.result.structuredContent as any,
  };
}

/** A tools/call as connector() sends it, answered with the response's headers too. */
async function toolWithHeaders(name: string, args: unknown, who: Agent) {
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
  const res = await send(app, "POST", "/mcp", who, call, { accept: "application/json, text/event-stream" });
  const text = await res.text();
  // A streamable-HTTP server may answer as an event stream; take the data line.
  const data = text.split("\n").find((line) => line.startsWith("data:"));
  return { headers: res.headers, text, message: JSON.parse(data ? data.slice(5) : text) };
}

describe("the connector endpoint", () => {
  test("it initializes without a token at all", async () => {
    const { status, message } = await connector("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(status, 200);
    assert.equal(message.result.serverInfo.name, "schellingaf");
    assert.equal(message.result.serverInfo.title, "Schelling Add Forward");
  });

  test("it names its mark and its page from the site, and neither without one", () => {
    const identity = serverIdentity("https://schellingaf.com");
    assert.equal(identity.websiteUrl, "https://schellingaf.com/api");
    assert.deepEqual(identity.icons?.map((icon) => icon.src), [
      "https://schellingaf.com/logo/schelling-icon-512.png",
      "https://schellingaf.com/logo/favicon.svg",
    ]);
    assert.deepEqual(serverIdentity(null), { title: "Schelling Add Forward" });
  });

  test("it answers with the same Vary and request id as every /v1 read", async () => {
    // The connector returns exactly the private, per-caller content /v1 does, so
    // it says so with `Vary`, or a cache an operator or a client later puts in the
    // path would be free to key an answer wrongly, and it carries `X-Request-Id`,
    // the one handle an agent is told to quote when a call fails. This handler
    // returns the MCP transport's own Response, and Hono drops the headers a
    // middleware prepared when a handler does that, so both are set on that
    // Response: the middleware alone would not show here.
    const me = await agent();
    const connected = await toolWithHeaders("schellingaf_whoami", {}, me);
    const direct = await send(app, "GET", "/v1/me", me);
    await direct.text();

    assert.match(connected.text, new RegExp(me.peerId), "the connector answered something else entirely");
    assert.equal(connected.headers.get("vary"), "Accept, Authorization");
    assert.equal(connected.headers.get("vary"), direct.headers.get("vary"));
    assert.match(
      connected.headers.get("x-request-id") ?? "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "an MCP refusal gives an operator no request id to quote",
    );
    assert.notEqual(
      connected.headers.get("x-request-id"),
      direct.headers.get("x-request-id"),
      "two requests shared one id",
    );
    // And the transport's own caching header is left as it was: no-transform is
    // what stops a proxy buffering the event stream.
    assert.match(connected.headers.get("cache-control") ?? "", /no-transform/);
  });

  test("the tool list is the same with a bad token as with none", async () => {
    const anonymous = await connector("tools/list", {});
    const rubbish = await connector("tools/list", {}, "schellingaf_" + "0".repeat(64));

    assert.equal(anonymous.status, 200);
    assert.equal(rubbish.status, 200, "a bad token must never make the server look dead");
    const names = (list: any) => list.message.result.tools.map((t: any) => t.name).sort();
    // The list is exactly what the operation table declares, less ChatGPT's two
    // names, which only /mcp/connect lists, and it is the same whatever the token
    // says: a client caches this for an hour, so a token problem must never change
    // the shape of the service.
    assert.deepEqual(names(anonymous), MCP_TOOLS.filter((name) => !(name in COMPATIBILITY_TOOLS)).sort());
    assert.deepEqual(names(rubbish), names(anonymous));
  });

  test("the guide works with no token, because it is what tells you how to get one", async () => {
    const { message } = await connector("tools/call", { name: "schellingaf_guide", arguments: {} });
    assert.equal(message.result.isError, undefined);
    assert.match(message.result.content[0].text, /## KEY setup/);
  });

  test("a tool needing a token says which code and what to do, and still answers 200", async () => {
    const { status, message } = await connector("tools/call", { name: "schellingaf_whoami", arguments: {} });
    assert.equal(status, 200, "never 401 from the connector endpoint");
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /TOKEN_MISSING/);
    assert.match(message.result.content[0].text, /POST \/v1\/keys\/challenge/);
  });

  test("with a token, whoami reports as the KEY and says who it read as", async () => {
    const me = await agent();
    const { message } = await connector("tools/call", { name: "schellingaf_whoami", arguments: {} }, me);

    assert.equal(message.result.isError, undefined);
    const text = message.result.content[0].text as string;
    assert.match(text, new RegExp(`^reading as ${me.peerId}`));
    assert.match(text, /you are in no SPACE yet/);
    assert.equal(message.result.structuredContent.peer_id, me.peerId);
    assert.equal(message.result.structuredContent.mailbox_head, "0");
  });

  test("an expired token is reported as expired, not as invalid or as silence", async () => {
    const me = await agent();
    await fixture.owner`
      update schellingaf.tokens set expires_at = now() - interval '1 day'
       where peer_id = ${Buffer.from(me.peerId, "hex")}`;
    const { status, message } = await connector("tools/call", { name: "schellingaf_whoami", arguments: {} }, me);
    assert.equal(status, 200);
    assert.match(message.result.content[0].text, /TOKEN_EXPIRED/);
  });
});

// The whole product, driven through the tools alone: no curl, no command line.
describe("the loop, over the connector only", () => {
  let a: Agent;
  let b: Agent;

  before(async () => {
    a = await agent();
    b = await agent();
  });

  test("a new KEY is told it is in no SPACE rather than shown an empty list", async () => {
    const out = await tool("schellingaf_whoami", {}, b.token);
    assert.equal(out.isError, false);
    assert.match(out.text, /reading as /);
    assert.match(out.text, /you are in no SPACE yet/);
  });

  test("SEEK from a KEY in no SPACE explains itself instead of looking broken", async () => {
    const out = await tool("schellingaf_seek", { q: "aarch64" }, b.token);
    assert.equal(out.isError, false);
    assert.match(out.text, /you belong to no SPACE/);
  });

  test("a SPACE is created, a link is made, and whoever holds it is said to be able to use it", async () => {
    const made = await tool(
      "schellingaf_space_control",
      { action: "create", name: "tool-space", title: "Driven by tools", join_policy: "invite", categories: [TEST_CATEGORY] },
      a.token,
    );
    assert.equal(made.isError, false, made.text);
    assert.equal(made.data.name, "tool-space");

    const code = await tool(
      "schellingaf_space_control",
      { action: "invite", name: "tool-space", role: "writer", max_uses: 2 },
      a.token,
    );
    assert.match(code.text, /Whoever holds this link or its code can use it/);
    assert.match(code.data.code, /^schellingaf_inv_[0-9a-f]{32}$/);

    const joined = await tool(
      "schellingaf_join",
      { action: "join", name: "tool-space", code: code.data.code },
      b.token,
    );
    assert.equal(joined.isError, false, joined.text);
    assert.equal(joined.data.role, "writer");
  });

  test("a missing argument is answered as guidance, not as a crash", async () => {
    const out = await tool("schellingaf_space_control", { action: "create", name: "x" }, a.token);
    assert.equal(out.isError, true);
    assert.match(out.text, /needs title/);
  });

  test("a POST is written, found by fingerprint, and opened in full", async () => {
    const posted = await tool(
      "schellingaf_post",
      {
        space: "tool-space",
        kind: "result",
        title: "Pinning numpy fixes the wheel",
        body: "aarch64 builds once numpy is pinned to 1.26.4.",
        fingerprints: [{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }],
        to: [b.peerId],
      },
      a.token,
    );
    assert.equal(posted.isError, false, posted.text);
    assert.match(posted.text, /posted .* at seq 1 in "tool-space"/);

    const found = await tool(
      "schellingaf_seek",
      { fingerprint: ["git.commit:b75e527ac4f1e0c2d8a3"] },
      b.token,
    );
    assert.equal(found.data.items.length, 1);
    assert.match(found.text, /matched by fingerprint/);
    // Everything A wrote is fenced; the service's own lines are not.
    assert.match(found.text, /<<<peer title>>>\nPinning numpy fixes the wheel\n<<<end title>>>/);

    const opened = await tool("schellingaf_get", { post_id: found.data.items[0].post_id }, b.token);
    assert.match(opened.text, /<<<peer body>>>\naarch64 builds once numpy is pinned/);
    assert.match(opened.text, /<<<peer fingerprints>>>\ngit\.commit:b75e527ac4f1e0c2d8a3/);
  });

  test("one POST opened through the connector comes without its proof unless asked; over HTTP it carries it unless proof=false", async () => {
    const page = await tool("schellingaf_read_space", { space: "tool-space", detail: "ids" }, b.token);
    const id = page.data.items[0].post_id;
    const slim = await tool("schellingaf_get", { post_id: id }, b.token);
    assert.equal(slim.isError, false, slim.text);
    assert.equal(slim.data.proof, undefined);
    assert.equal(typeof slim.data.body, "string");
    const proved = await tool("schellingaf_get", { post_id: id, proof: true }, b.token);
    assert.equal(typeof proved.data.proof.canonical, "string");
    const http = await call("GET", `/v1/posts/${id}`, b.token);
    assert.equal(typeof http.body.proof.canonical, "string");
    const without = await call("GET", `/v1/posts/${id}?proof=false`, b.token);
    assert.equal(without.body.proof, undefined);
    assert.deepEqual({ ...http.body, proof: undefined }, { ...without.body, proof: undefined });
    assert.equal((await call("GET", `/v1/posts/${id}?proof=maybe`, b.token)).status, 400);
  });

  test("the mailbox shows what was addressed to this KEY, with its position", async () => {
    const out = await tool("schellingaf_mailbox", {}, b.token);
    assert.equal(out.isError, false);
    assert.match(out.text, /1 delivery\(s\) in "tool-space", head 1, next_after 1/);
    assert.match(out.text, /\(1\) to/);
  });

  test("reading newest-first answers the resume question in one tool call", async () => {
    await tool(
      "schellingaf_post",
      {
        space: "tool-space",
        kind: "dossier",
        title: "Where I stopped",
        body: "Next: rebuild the runner image.",
      },
      a.token,
    );
    const out = await tool(
      "schellingaf_read_space",
      { space: "tool-space", order: "desc", kind: ["dossier"], limit: 1, detail: "full" },
      b.token,
    );
    assert.equal(out.data.items.length, 1);
    assert.match(out.text, /<<<peer title>>>\nWhere I stopped/);
    assert.match(out.text, /not a gap-free stream/);
  });

  test("a refusal arrives as its code and its fix, and the call still succeeds", async () => {
    const stranger = await agent();
    const out = await tool("schellingaf_read_space", { space: "tool-space" }, stranger.token);
    assert.equal(out.isError, true);
    assert.match(out.text, /READ_DENIED/);
    assert.match(out.text, /join policy and contacts/);
  });

  test("a refusal quotes the id of the /mcp request that carried it", async () => {
    // The route the tool reaches runs in process under the /mcp request's own
    // id, and the refusal quotes it, so an agent told to report the request id
    // has one that finds something.
    const stranger = await agent();
    const { headers, message } = await toolWithHeaders("schellingaf_read_space", { space: "tool-space" }, stranger);
    const header = headers.get("x-request-id");
    assert.ok(header, "the /mcp answer carried no request id");
    assert.equal(message.result.isError, true);
    assert.match(message.result.content[0].text, /READ_DENIED/);
    assert.ok(
      message.result.content[0].text.includes(`Request id ${header}.`),
      `the refusal did not quote the /mcp request's id ${header}: ${message.result.content[0].text}`,
    );
  });

  test("looking a SPACE up needs no token at all", async () => {
    const found = await tool("schellingaf_spaces", { action: "list", q: "Driven" });
    assert.equal(found.isError, false);
    assert.match(found.text, /reading as anonymous/);
    assert.match(found.text, /tool-space/);

    const profile = await tool("schellingaf_spaces", { action: "get", name: "tool-space" });
    assert.match(profile.text, /contacts /);
    assert.match(profile.text, /your access: none, read false, post false/);
  });

  test("leaving gives up a membership, and the next read is refused", async () => {
    const left = await tool("schellingaf_join", { action: "leave", name: "tool-space" }, b.token);
    assert.equal(left.isError, false, left.text);
    const after = await tool("schellingaf_read_space", { space: "tool-space" }, b.token);
    assert.equal(after.isError, true);
    assert.match(after.text, /READ_DENIED/);
  });

  test("every tool a token cannot use names the token state, and none of them is a 401", async () => {
    const expired = "schellingaf_" + "1".repeat(64);
    for (const [name, args] of [
      ["schellingaf_seek", { q: "x" }],
      ["schellingaf_read_space", { space: "tool-space" }],
      ["schellingaf_get", { post_id: "00000000-0000-0000-0000-000000000000" }],
      ["schellingaf_mailbox", {}],
      ["schellingaf_post", { space: "tool-space", kind: "obs", body: "x" }],
      ["schellingaf_space_control", { action: "create", name: "y", title: "Y" }],
      ["schellingaf_join", { action: "join", name: "tool-space" }],
      ["schellingaf_spaces", { action: "members", name: "tool-space" }],
    ] as const) {
      const { status, message } = await connector("tools/call", { name, arguments: args }, expired);
      assert.equal(status, 200, `${name} answered ${status}; a client reads that as a dead server`);
      assert.equal(message.result.isError, true, name);
      assert.match(message.result.content[0].text, /TOKEN_INVALID/, name);
    }
  });
});

// The other door, driven entirely through the connector.
describe("asking, deciding and the history, over the connector only", () => {
  let owner: Agent;
  let asker: Agent;

  before(async () => {
    owner = await agent();
    asker = await agent();
    await tool(
      "schellingaf_space_control",
      { action: "create", name: "door-space", title: "Doors", join_policy: "request", categories: [TEST_CATEGORY] },
      owner.token,
    );
  });

  test("asking without a code carries the message and says a decision may wait", async () => {
    const out = await tool(
      "schellingaf_join",
      { action: "join", name: "door-space", message: "I have the failing runner image." },
      asker.token,
    );
    assert.equal(out.isError, false, out.text);
    assert.equal(out.data.state, "pending");
    assert.match(out.text, /may not arrive before this RUN ends/);
  });

  test("approving works through the tool, and the decision reaches the asker", async () => {
    const list = await tool(
      "schellingaf_spaces",
      { action: "requests", name: "door-space" },
      owner.token,
    );
    const id = list.data.items.find((r: any) => r.requester === asker.peerId).request_id;

    const decided = await tool(
      "schellingaf_space_control",
      { action: "approve", request_id: id, role: "writer" },
      owner.token,
    );
    assert.equal(decided.isError, false, decided.text);
    assert.equal(decided.data.state, "approved");

    const mail = await tool("schellingaf_mailbox", {}, asker.token);
    assert.match(mail.text, /decision/);
    // The asker's own answer, with the role it was given, and never the line that tells
    // a governor how to decide: the asker decides nothing here.
    assert.match(mail.text, /your request [0-9a-f-]+ to join "door-space": approved, as writer/);
    assert.doesNotMatch(mail.text.split("(1) decision")[1] ?? "", /Approve by SPACE policy/);
  });

  test("the history reads back through the same tool", async () => {
    const out = await tool(
      "schellingaf_spaces",
      { action: "events", name: "door-space" },
      asker.token,
    );
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /\(1\) space\.created by /);
    assert.match(out.text, /member\.granted/);
    assert.match(out.text, /never rewritten/);
  });

  test("withdrawing an ask needs its id, and says so when it is missing", async () => {
    const shy = await agent();
    const asked = await tool(
      "schellingaf_join",
      { action: "join", name: "door-space", message: "never mind" },
      shy.token,
    );
    const missing = await tool("schellingaf_join", { action: "withdraw" }, shy.token);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /needs request_id/);

    const out = await tool(
      "schellingaf_join",
      { action: "withdraw", request_id: asked.data.request_id },
      shy.token,
    );
    assert.equal(out.isError, false, out.text);
    assert.equal(out.data.state, "withdrawn");
  });
});

describe("where things go, over the connector", () => {
  let a: Agent;

  before(async () => {
    a = await agent();
  });

  test("the categories action needs no token: the outline, one category, and a name looked up", async () => {
    const outline = await tool("schellingaf_spaces", { action: "categories" });
    assert.equal(outline.isError, false, outline.text);
    assert.match(outline.text, /- Artificial intelligence — artificial-intelligence/);
    assert.match(outline.text, / {2}- Agents — agents/);
    assert.match(outline.text, /A public SPACE is filed under 1 to 3 categories; a private or sealed one may have none\./);
    const one = await tool("schellingaf_spaces", { action: "categories", category: "coding-agents" });
    assert.match(one.text, /Coding agents — coding-agents, in Artificial intelligence › Agents/);
    assert.match(one.text, /below it:/);
    assert.match(one.text, /limit a list with category=coding-agents/);
    const branch = await tool("schellingaf_spaces", { action: "categories", category: "agents", depth: 2 });
    assert.match(branch.text, /Claude Code — claude-code/);
    const looked = await tool("schellingaf_spaces", { action: "categories", q: "Windsurf" });
    assert.match(looked.text, /Devin Desktop — devin-desktop/);
    assert.match(looked.text, /matched by alias/);
    const unknown = await tool("schellingaf_spaces", { action: "categories", category: "claude-kode" });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /CATEGORY_NOT_FOUND/);
  });

  test("a create names its categories, and without them is told where to find them", async () => {
    // A public SPACE and an oracle space need them; nothing is created without.
    for (const fields of [{ visibility: "public" }, { oracle: true }]) {
      const bare = await tool("schellingaf_space_control", { action: "create", name: "tool-unfiled", title: "Unfiled", ...fields }, a.token);
      assert.equal(bare.isError, true, JSON.stringify(fields));
      assert.match(bare.text, /INVALID_CATEGORY/);
      assert.match(bare.text, /schellingaf_spaces action categories/);
    }
    // A private one may have none.
    const unfiled = await tool("schellingaf_space_control", { action: "create", name: "tool-private-unfiled", title: "Unfiled" }, a.token);
    assert.equal(unfiled.isError, false, unfiled.text);
    assert.doesNotMatch(unfiled.text, /filed under/);
    const seen = await tool("schellingaf_spaces", { action: "get", name: "tool-private-unfiled" }, a.token);
    assert.equal(seen.isError, false, seen.text);
    assert.doesNotMatch(seen.text, /filed under/);
    const wrong = await tool("schellingaf_space_control", { action: "create", name: "tool-unfiled", title: "Unfiled", categories: ["not-a-category"] }, a.token);
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /INVALID_CATEGORY/);
    const made = await tool("schellingaf_space_control", { action: "create", name: "tool-filed", title: "Filed", categories: ["coding-agents"] }, a.token);
    assert.equal(made.isError, false, made.text);
    assert.match(made.text, /filed under Coding agents \(coding-agents\)/);
    const moved = await tool("schellingaf_space_control", { action: "update", name: "tool-filed", categories: ["python", "coding-agents"] }, a.token);
    assert.equal(moved.isError, false, moved.text);
  });

  test("a list and a SEEK keep to a category, and a SEEK refuses one with a space", async () => {
    const listed = await tool("schellingaf_spaces", { action: "list", category: "python" });
    assert.deepEqual(listed.data.items.map((s: any) => s.name), ["tool-filed"]);
    assert.match(listed.text, /filed under Python \(python\) \(main\), Coding agents \(coding-agents\)/);
    await tool("schellingaf_post", { space: "tool-filed", kind: "obs", body: "quokka wheels build on the runner" }, a.token);
    // Its own private space, which its owner's SEEK keeps to the category like any other.
    const kept = await tool("schellingaf_seek", { q: "quokka", category: "coding-agents" }, a.token);
    assert.equal(kept.isError, false, kept.text);
    assert.equal(kept.data.items.length, 1);
    assert.match(kept.text, /kept to Coding agents \(coding-agents\)/);
    assert.match(kept.text, /hits are filed under: Python \(python\) 1, Coding agents \(coding-agents\) 1|hits are filed under: Coding agents \(coding-agents\) 1, Python \(python\) 1/);
    const outside = await tool("schellingaf_seek", { q: "quokka", category: "coding-agents" });
    assert.equal(outside.data.items.length, 0, "a private space reached a caller with no token");
    const both = await tool("schellingaf_seek", { q: "quokka", category: "coding-agents", space: "tool-filed" }, a.token);
    assert.equal(both.isError, true);
    assert.match(both.text, /category or space, not both/);
  });

  test("no tool carries an enum of more than fifty values: an id is looked up, never listed", async () => {
    const { message } = await connector("tools/list", {}, a);
    const walk = (schema: unknown, where: string) => {
      if (!schema || typeof schema !== "object") return;
      const e = (schema as { enum?: unknown[] }).enum;
      if (Array.isArray(e)) assert.ok(e.length <= 50, `${where} lists ${e.length} values`);
      for (const [k, v] of Object.entries(schema as object)) walk(v, `${where}.${k}`);
    };
    for (const t of message.result.tools) walk(t.inputSchema, t.name);
  });
});

// Attachments through the connector: schellingaf_post uploads a file given as text in
// process, through the upload route, and schellingaf_get reads a file back by its SPACE or
// through the POST that attaches it.
describe("files, over the connector", () => {
  const sha = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
  /** Whether a SPACE holds these bytes at all, pending or attached. */
  const held = async (hash: string) =>
    (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.space_files where sha256 = ${Buffer.from(hash, "hex")}`)[0]!.n;
  /** An upload over HTTP, as an agent with curl sends it. */
  const upload = async (who: Agent, space: string, content: Buffer) =>
    app.request(`/v1/spaces/${space}/files/${sha(content)}`, {
      method: "PUT",
      headers: { "content-length": String(content.length), authorization: `Bearer ${who.token}` },
      body: content,
    });
  let owner: Agent;
  let space: string;
  let other: string;
  let n = 0;

  before(async () => {
    owner = await agent();
    space = `files-tool-${process.pid}`;
    other = `files-other-${process.pid}`;
    for (const name of [space, other]) {
      const made = await tool("schellingaf_space_control", { action: "create", name, title: "Files through the connector" }, owner.token);
      assert.equal(made.isError, false, made.text);
    }
  });

  test("a post's text files are uploaded in process, attached in the order given, and each hash joins its fingerprints", async () => {
    const solve = "print('solved')\n";
    const cipher = "QEB NRFZH YOLTK CLU\n";
    const posted = await tool("schellingaf_post", {
      space, kind: "result", body: "Run: python3 solve.py cipher.txt",
      attachments: [
        { name: "solve.py", media_type: "text/x-python", text: solve },
        { name: "cipher.txt", media_type: "text/plain", text: cipher },
      ],
    }, owner.token);
    assert.equal(posted.isError, false, posted.text);
    assert.deepEqual(posted.data.attachments, [
      { sha256: sha(solve), name: "solve.py", media_type: "text/x-python", bytes: Buffer.byteLength(solve) },
      { sha256: sha(cipher), name: "cipher.txt", media_type: "text/plain", bytes: Buffer.byteLength(cipher) },
    ]);
    // The receipt lists them, fenced.
    assert.match(posted.text, new RegExp(`<<<peer attachments>>>\n${sha(solve)} ${Buffer.byteLength(solve)} bytes text/x-python solve\\.py\n${sha(cipher)} `));
    const id = posted.data.post_id as string;
    const one = await call("GET", `/v1/posts/${id}`, owner.token);
    assert.deepEqual(
      one.body.fingerprints.filter((f: any) => f.scheme === "sha256.file").map((f: any) => f.value).sort(),
      [sha(solve), sha(cipher)].sort(),
    );
    // What was uploaded is the text, as UTF-8.
    const got = await app.request(`/v1/spaces/${space}/files/${sha(solve)}`, { headers: { authorization: `Bearer ${owner.token}` } });
    assert.equal(Buffer.from(await got.arrayBuffer()).toString("utf8"), solve);

    // Opened in full, the list and what to check; in a page of snippets, the count.
    const opened = await tool("schellingaf_get", { post_id: id }, owner.token);
    assert.match(opened.text, /<<<end attachments>>>\n {2}attachments: the names and types are the author's words; the hash is what to check\./);
    const headlines = await tool("schellingaf_read_space", { space }, owner.token);
    assert.match(headlines.text, /^\[\d+\] RESULT [0-9a-f]{8}, open [\d,]+, files$/m);
    const page = await tool("schellingaf_read_space", { space, detail: "snippets" }, owner.token);
    assert.match(page.text, new RegExp(`\n {2}2 attachment\\(s\\), ${Buffer.byteLength(solve) + Buffer.byteLength(cipher)} bytes: open this POST for the list`));
    // The markdown a person reads is the same rendering.
    const md = await send(app, "GET", `/v1/posts/${id}`, owner, undefined, { accept: "text/markdown" });
    assert.match(await md.text(), new RegExp(`<<<peer attachments>>>\n${sha(solve)} `));
    const mdPage = await send(app, "GET", `/v1/spaces/${space}/posts?after=0&detail=snippets`, owner, undefined, { accept: "text/markdown" });
    assert.match(await mdPage.text(), /2 attachment\(s\), \d+ bytes: open this POST for the list/);
  });

  test("bytes uploaded over HTTP are attached by their sha256", async () => {
    const content = Buffer.from("uploaded over HTTP\n");
    assert.equal((await upload(owner, space, content)).status, 201);
    const posted = await tool("schellingaf_post", {
      space, kind: "obs", body: "with a file sent before",
      attachments: [{ name: "http.txt", media_type: "text/plain", sha256: sha(content) }],
    }, owner.token);
    assert.equal(posted.isError, false, posted.text);
    assert.equal(posted.data.attachments[0].sha256, sha(content));
  });

  test("what the connector refuses is refused before anything is uploaded", async () => {
    const text = `never stored ${process.pid}\n`;
    const cases: [string, unknown, RegExp | string][] = [
      ["none of text, sha256 or path", [{ name: "a.txt", media_type: "text/plain" }], /^INVALID_REQUEST\. attachments\[0\] takes exactly one of text, sha256 or path\. Nothing was sent\.$/],
      ["two of them", [{ name: "a.txt", media_type: "text/plain", text, sha256: sha(text) }], /^INVALID_REQUEST\. attachments\[0\] takes exactly one of text, sha256 or path\./],
      ["a path", [{ name: "a.txt", media_type: "text/plain", path: "a.txt" }], "INVALID_REQUEST. path is read by the bridge on your machine; the connector alone takes text or sha256. Nothing was sent."],
      ["a lone surrogate", [{ name: "a.txt", media_type: "text/plain", text: `${text}\ud800` }], /^INVALID_REQUEST\. .*\(attachments\[0\]\.text\)/],
      ["no name", [{ media_type: "text/plain", text }], /^INVALID_REQUEST\. .*\(attachments\[0\]\.name/],
      ["a name twice", [{ name: "a.txt", media_type: "text/plain", text }, { name: "a.txt", media_type: "text/plain", text: `${text}2` }], /\(attachments\[1\]\.name is named twice\)/],
      // A name that turns its own letters round, shown to a reader as another name.
      ["a name with a direction override", [{ name: `a${String.fromCharCode(0x202e)}txt.sh`, media_type: "text/plain", text }], /^INVALID_REQUEST\. .*\(attachments\[0\]\.name: no control or format character/],
      ["five", Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, media_type: "text/plain", text: `${text}${i}` })), /^INVALID_REQUEST\. .*attachments/],
    ];
    for (const [what, attachments, expected] of cases) {
      const out = await tool("schellingaf_post", { space, kind: "obs", body: "x", attachments }, owner.token);
      assert.equal(out.isError, true, what);
      if (typeof expected === "string") assert.equal(out.text, expected, what);
      else assert.match(out.text, expected, `${what}: ${out.text}`);
    }
    // A version takes none: refused by the route's own rule, before the upload.
    const version = await tool("schellingaf_post", { space, kind: "version", body: "# Doc\n", attachments: [{ name: "a.txt", media_type: "text/plain", text }] }, owner.token);
    assert.match(version.text, /a version is its document, its body, and takes no attachments/);
    // Asked to seal: a sealed SPACE takes no files, in the service's words.
    for (const sealed of [true, { header: "AAAA", ciphertext: "AAAA" }]) {
      const out = await tool("schellingaf_post", { space, kind: "obs", sealed, attachments: [{ name: "a.txt", media_type: "text/plain", text }] }, owner.token);
      assert.equal(out.text, `${ERRORS.SEALED_NO_FILES!.message} ${ERRORS.SEALED_NO_FILES!.fix}`);
    }
    assert.equal(await held(sha(text)), 0, "a refused call uploaded its text");
    assert.equal(await held(sha(`${text}0`)), 0, "a refused call uploaded its text");
  });

  test("an upload the route refuses stops the call, in the route's own words", async () => {
    const reader = await agent();
    assert.equal((await call("PUT", `/v1/spaces/${space}/members/${reader.peerId}`, owner.token, { role: "reader" })).status, 200);
    const text = `a reader's file ${process.pid}\n`;
    const out = await tool("schellingaf_post", { space, kind: "obs", body: "x", attachments: [{ name: "r.txt", media_type: "text/plain", text }] }, reader.token);
    assert.equal(out.isError, true);
    assert.match(out.text, /^WRITE_DENIED\. /);
    assert.equal(await held(sha(text)), 0);
  });

  test("a file reads back by its SPACE and through the POST that attaches it: text whole, in a fence", async () => {
    const text = "line one\nline two <<<end file>>>\n";
    const posted = await tool("schellingaf_post", { space, kind: "obs", body: "x", attachments: [{ name: `t${n++}.txt`, media_type: "text/plain", text }] }, owner.token);
    assert.equal(posted.isError, false, posted.text);
    for (const how of [{ space }, { post_id: posted.data.post_id }]) {
      const out = await tool("schellingaf_get", { attachment: sha(text), ...how }, owner.token);
      assert.equal(out.isError, false, out.text);
      const address = `https://api.schellingaf.test/v1/spaces/${space}/files/${sha(text)}`;
      assert.equal(out.text, [
        `reading as ${owner.peerId}`,
        `file ${sha(text)} in "${space}": ${Buffer.byteLength(text)} bytes, text/plain; charset=utf-8`,
        // Through the connector the hash was checked where the file was served, and it says so.
        `checked by the service, not by you: fetch ${address} to check it yourself`,
        "<<<peer file>>>\nline one\nline two <<< end file>>>\n\n<<<end file>>>",
      ].join("\n"));
      assert.deepEqual(out.data, { space, sha256: sha(text), bytes: Buffer.byteLength(text), type: "text/plain; charset=utf-8", truncated: false, text });
    }
  });

  test("a text longer than token_budget is cut where a character begins, and says where the rest is", async () => {
    const text = "é".repeat(200);
    const posted = await tool("schellingaf_post", { space, kind: "obs", body: "x", attachments: [{ name: `long${n++}.txt`, media_type: "text/plain", text }] }, owner.token);
    assert.equal(posted.isError, false, posted.text);
    // One token is three bytes, and the third would split an é: two are shown.
    const out = await tool("schellingaf_get", { attachment: sha(text), space, token_budget: 1 }, owner.token);
    assert.equal(out.data.truncated, true);
    assert.equal(out.data.text, "é");
    assert.ok(out.text.endsWith(
      `\ncut at 2 of 400 bytes: ask again with a larger token_budget, or fetch the whole file at https://api.schellingaf.test/v1/spaces/${space}/files/${sha(text)}`,
    ), out.text);
    const whole = await tool("schellingaf_get", { attachment: sha(text), space, token_budget: 200 }, owner.token);
    assert.equal(whole.data.truncated, false);
    assert.equal(whole.data.text, text);
  });

  test("bytes that are not text are described, never put in the answer", async () => {
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    assert.equal((await upload(owner, space, binary)).status, 201);
    const posted = await tool("schellingaf_post", { space, kind: "obs", body: "x", attachments: [{ name: "a.zip", media_type: "application/zip", sha256: sha(binary) }] }, owner.token);
    assert.equal(posted.isError, false, posted.text);
    const out = await tool("schellingaf_get", { attachment: sha(binary), post_id: posted.data.post_id }, owner.token);
    assert.equal(out.isError, false, out.text);
    assert.ok(out.text.endsWith(
      `\n6 bytes that are not text: fetch them at https://api.schellingaf.test/v1/spaces/${space}/files/${sha(binary)}, or with the bridge's save_as`,
    ), out.text);
    assert.deepEqual(out.data, { space, sha256: sha(binary), bytes: 6, type: "application/octet-stream", truncated: false });
  });

  test("by post_id, only a file that POST lists, from that POST's own SPACE", async () => {
    const text = `only in one space ${process.pid}\n`;
    const there = await tool("schellingaf_post", { space, kind: "obs", body: "x", attachments: [{ name: `o${n++}.txt`, media_type: "text/plain", text }] }, owner.token);
    assert.equal(there.isError, false, there.text);
    const elsewhere = await tool("schellingaf_post", { space: other, kind: "obs", body: "no files" }, owner.token);
    const sameSpace = await tool("schellingaf_post", { space, kind: "obs", body: "no files either" }, owner.token);
    const words = `${ERRORS.FILE_NOT_FOUND!.message} ${ERRORS.FILE_NOT_FOUND!.fix}`;
    for (const post of [elsewhere, sameSpace]) {
      const out = await tool("schellingaf_get", { attachment: sha(text), post_id: post.data.post_id }, owner.token);
      assert.equal(out.isError, true);
      assert.equal(out.text, words);
    }
    // And named by the other SPACE, the route answers that it holds no such file.
    const across = await tool("schellingaf_get", { attachment: sha(text), space: other }, owner.token);
    assert.match(across.text, /^FILE_NOT_FOUND\. /);
    // A stranger reads nothing of a private SPACE's file.
    const stranger = await agent();
    const theirs = await tool("schellingaf_get", { attachment: sha(text), space }, stranger.token);
    assert.match(theirs.text, /^FILE_NOT_FOUND\. /);
  });

  test("a file's read takes one of space and post_id, nothing that opens posts, and no save_as", async () => {
    const hash = sha("anything");
    const refused: [Record<string, unknown>, RegExp | string][] = [
      [{ attachment: hash }, /^INVALID_REQUEST\. attachment takes one of space, the SPACE that holds the file, or post_id, the POST that attaches it\.$/],
      [{ attachment: hash, space, post_id: "00000000-0000-0000-0000-000000000000" }, /^INVALID_REQUEST\. attachment takes one of space/],
      [{ attachment: hash, space, post_ids: ["00000000-0000-0000-0000-000000000000"] }, /^INVALID_REQUEST\. attachment reads one file, and takes no post_ids\.$/],
      [{ attachment: hash, space, proof: true, finding: true }, /^INVALID_REQUEST\. attachment reads one file, and takes no proof, finding\.$/],
      [{ space }, /^INVALID_REQUEST\. space names the SPACE whose file to read: give attachment, the file's sha256, with it\.$/],
      [{ attachment: hash, space, save_as: "out.bin" }, "INVALID_REQUEST. save_as is written by the bridge on your machine; the connector alone returns text."],
    ];
    for (const [args, expected] of refused) {
      const out = await tool("schellingaf_get", args, owner.token);
      assert.equal(out.isError, true, JSON.stringify(args));
      if (typeof expected === "string") assert.equal(out.text, expected);
      else assert.match(out.text, expected, JSON.stringify(args));
    }
  });
});

describe("the receipt, over the connector", () => {
  test("a post answers the slim receipt unless receipt is true, and receipt never reaches the post", async () => {
    const a = await agent();
    const name = `receipts-${process.pid}`;
    const made = await call("POST", "/v1/spaces", a.token, { name, title: "Receipts", visibility: "private" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const slim = await tool("schellingaf_post", { space: name, kind: "obs", body: "slim" }, a.token);
    assert.equal(slim.isError, false, slim.text);
    assert.deepEqual(Object.keys(slim.data.receipt).sort(), ["service_epoch", "signature", "signer_key_id", "v"]);
    assert.match(slim.text, /the service signed a receipt for it/);
    const whole = await tool("schellingaf_post", { space: name, kind: "obs", body: "whole", receipt: true }, a.token);
    assert.equal(whole.isError, false, whole.text);
    assert.deepEqual(Object.keys(whole.data.receipt).sort(), ["canonical", "signature", "signer_key_id"]);
    // A post the agent signed takes no field beside its signed ones: receipt went as a query.
    const built = buildPostObject({
      spaceId: made.body.space_id, author: a.peerId, idempotencyKey: `signed-${process.pid}`, kind: "obs",
      title: "A signed POST in a test", body: "signed here", to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [],
      data: null, budget: null, runId: null,
    });
    const signed = await tool("schellingaf_post", {
      space: name, alg: "ed25519", canonical: built.canonical.toString("base64url"),
      signature: sign(null, signaturePreimageOf(built.objectId), a.privateKey).toString("hex"), receipt: true,
    }, a.token);
    assert.equal(signed.isError, false, signed.text);
    assert.equal(typeof signed.data.receipt.canonical, "string");
  });
});

describe("task and posts, over the connector", () => {
  /** A work space `who` owns, with one task it holds: its name and the task's number. */
  async function heldTask(who: Agent, label: string, options: Record<string, unknown> = {}) {
    const name = `ct-${label}-${process.pid}`;
    const made = await call("POST", "/v1/spaces", who.token, { name, title: "Tasks through the connector", visibility: "private", ...options });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const added = await call("POST", `/v1/spaces/${name}/tasks`, who.token, { title: "Check the build", body: "Run it and say what failed." });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const taken = await call("POST", `/v1/spaces/${name}/tasks/next`, who.token, {});
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    return { name, number: taken.body.task.number as number };
  }
  const headOf = async (name: string, who: Agent) => (await call("GET", `/v1/spaces/${name}/posts?limit=1&order=desc`, who.token)).body.items[0]?.seq ?? null;
  const reference = (name: string, number: number) => [{ scheme: "task.reference", value: `${name}/${number}` }];
  const STILL_YOURS = (number: number) =>
    `task ${number} is still yours. If this POST is its result, mark it done with schellingaf_task action done: a bridge before 0.1.6 drops task.`;

  test("a POST with task marks the task done in the same call, and its text says where the task stands", async () => {
    const a = await agent();
    const { name, number } = await heldTask(a, "close");
    const out = await tool("schellingaf_post", { space: name, kind: "result", title: "Built", body: "It builds.", fingerprints: reference(name, number), task: { number } }, a.token);
    assert.equal(out.isError, false, out.text);
    assert.equal(out.data.task.number, number);
    assert.ok(["done", "accepted"].includes(out.data.task.state), JSON.stringify(out.data.task));
    assert.ok(out.text.split("\n").includes(`task ${number} is now ${out.data.task.state}`), out.text);
    assert.ok(!out.text.includes("is still yours"), out.text);
    const listed = await call("GET", `/v1/spaces/${name}/tasks?before=${number + 1}&limit=1`, a.token);
    assert.equal(listed.body.items[0].state, out.data.task.state);
  });

  test("posts writes each POST in order in one call, a later one replying to an earlier one by key, and a resend replays them", async () => {
    const a = await agent();
    const { name } = await heldTask(a, "batch");
    const args = {
      space: name, idempotency_key: `batch-${process.pid}`,
      posts: [{ key: "a", kind: "obs", title: "First", body: "one" }, { kind: "obs", title: "Second", body: "two", reply_to: "a" }],
    };
    const out = await tool("schellingaf_post", args, a.token);
    assert.equal(out.isError, false, out.text);
    const [first, second] = out.data.posts;
    assert.equal(BigInt(second.seq), BigInt(first.seq) + 1n);
    assert.equal((await call("GET", `/v1/posts/${second.post_id}`, a.token)).body.reply_to, first.post_id);
    const lines = out.text.split("\n");
    assert.equal(lines[1], `posted 2 POSTS in "${name}", seq ${first.seq} to ${second.seq}`);
    assert.ok(lines.includes(`posts[0] (a): ${first.post_id} at seq ${first.seq}, unsigned`), out.text);
    const again = await tool("schellingaf_post", args, a.token);
    assert.equal(again.isError, false, again.text);
    assert.equal(again.data.replayed, true);
    assert.deepEqual(again.data.posts.map((p: any) => p.post_id), [first.post_id, second.post_id]);
    assert.match(again.text, /already posted: this idempotency_key replayed 2 POSTS/);
  });

  test("a dry run in an item or a task, an item to seal and an item with files are refused before anything is sent", async () => {
    const a = await agent();
    const { name, number } = await heldTask(a, "refused");
    const head = await headOf(name, a);
    const item = { kind: "obs", title: "An item", body: "words" };
    for (const [args, says] of [
      [{ space: name, posts: [item, { ...item, dry_run: true }] }, NO_DRY_RUN_HERE],
      [{ space: name, posts: [{ ...item, task: { number, dryRun: true } }] }, NO_DRY_RUN_HERE],
      [{ space: name, ...item, task: { number, dry_run: true } }, NO_DRY_RUN_HERE],
      [{ space: name, posts: [item, { ...item, sealed: true }] }, "SEALED_NEEDS_BRIDGE."],
      [{ space: name, posts: [item, { ...item, key: "b", attachments: [{ name: "a.txt", media_type: "text/plain", text: "x" }] }] }, "(posts[1] (b): a POST with attachments is sent alone, not in posts)"],
    ] as const) {
      const out = await tool("schellingaf_post", args, a.token);
      assert.equal(out.isError, true, JSON.stringify(args));
      assert.ok(out.text.includes(says), out.text);
    }
    assert.equal(await headOf(name, a), head, "something was posted");
    const task = await call("GET", `/v1/spaces/${name}/tasks?before=${number + 1}&limit=1`, a.token);
    assert.equal(task.body.items[0].state, "claimed");
  });

  test("an object with no kind, as a bridge before 0.1.6 signs what it kept of posts, is refused with what to do", async () => {
    const a = await agent();
    const { name } = await heldTask(a, "nokind");
    const spaceId = (await call("GET", `/v1/spaces/${name}`, a.token)).body.space_id;
    const object = { v: 1, space_id: spaceId, author_id: a.peerId, idempotency_key: "old-bridge" };
    const out = await tool("schellingaf_post", {
      space: name, alg: "ed25519", canonical: Buffer.from(JSON.stringify(object)).toString("base64url"), signature: "00".repeat(64),
    }, a.token);
    assert.equal(out.isError, true);
    assert.match(out.text, /^INVALID_REQUEST\. .*\(canonical names no kind: a bridge before 0\.1\.6 drops posts and signs the rest\. Update it, or send each POST alone\)/);
    assert.equal(await headOf(name, a), null);
  });

  test("a POST naming by fingerprint a task its author still holds, sent with no task, says the task is still theirs; nobody else is told", async () => {
    const a = await agent();
    const { name, number } = await heldTask(a, "hint", { visibility: "public", join_policy: "open" });
    // The task list's reads while a call runs: the hint's one read, or none.
    const taskReads = (during: () => Promise<unknown>) => requestsDuring((method, path) => method === "GET" && path === `/v1/spaces/${name}/tasks`, during);
    let progress!: Awaited<ReturnType<typeof tool>>;
    assert.equal(await taskReads(async () => {
      progress = await tool("schellingaf_post", { space: name, kind: "obs", title: "Half done", body: "Halfway.", fingerprints: reference(name, number) }, a.token);
    }), 1, "the hint reads the task once");
    assert.equal(progress.isError, false, progress.text);
    assert.ok(progress.text.split("\n").includes(STILL_YOURS(number)), progress.text);
    // With no fingerprint naming a task, nothing is read.
    assert.equal(await taskReads(() => tool("schellingaf_post", { space: name, kind: "obs", title: "Aside", body: "Aside." }, a.token)), 0);
    // A KEY that does not hold it, posting in the same open SPACE: no line. Whether it holds
    // the task is known only from the task, so its one read is made, and says nothing.
    const b = await agent();
    let other!: Awaited<ReturnType<typeof tool>>;
    assert.equal(await taskReads(async () => {
      other = await tool("schellingaf_post", { space: name, kind: "obs", title: "Seen it", body: "Me too.", fingerprints: reference(name, number) }, b.token);
    }), 1);
    assert.equal(other.isError, false, other.text);
    assert.ok(!other.text.includes("is still yours"), other.text);
    // Once the task is done, no line either.
    const done = await call("POST", `/v1/spaces/${name}/tasks/${number}/done`, a.token, { post_id: progress.data.post_id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const after = await tool("schellingaf_post", { space: name, kind: "obs", title: "Done", body: "Done.", fingerprints: reference(name, number) }, a.token);
    assert.ok(!after.text.includes("is still yours"), after.text);
  });
});
