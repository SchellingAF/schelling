// The connector endpoint, over its real HTTP surface.
//
// The rule under test is the one that decides whether a client thinks the
// service is alive: a token problem is ordinary tool output, never a 401.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { TEST_CATEGORY } from "./helpers.ts";
import { useService, app, fixture, agent, connector, send, type Agent } from "./lib/service.ts";
import { COMPATIBILITY_TOOLS, MCP_TOOLS, serverIdentity } from "../src/mcp/server.ts";

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

  test("the mailbox shows what was addressed to this KEY, with its position", async () => {
    const out = await tool("schellingaf_mailbox", {}, b.token);
    assert.equal(out.isError, false);
    assert.match(out.text, /1 delivery\(s\), head 1, next_after 1/);
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
