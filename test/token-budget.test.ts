// token_budget on every read that answers items, by one rule over HTTP and the
// connector, and one rule for a name a read does not take.
//
// The rule: a read that answers items takes token_budget, from 1 to 65,536 over HTTP and
// to 20,000 through the connector. Its answer carries tokens_estimated, and budget_cut
// true whenever the budget left out an item the answer would otherwise carry; the first
// item always comes. A name /openapi.json gives some read, sent to a read that does not
// take it, is refused saying what it does take; through the connector, an argument of
// the tool's own schema is. This file fails when a read answering items takes none, on
// either surface, and when a connector action is not mapped, so a new list cannot
// arrive without a budget.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, sign } from "node:crypto";
import { useService, app, config, call, send, connector, agent, type Agent } from "./lib/service.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import { buildOpenApi, openApiPath } from "../src/surface/openapi.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { TOOL_ACTIONS, type ToolRead } from "../src/mcp/server.ts";
import { COMPATIBILITY_TOOLS } from "../src/mcp/compat.ts";
import { TOKEN_BUDGET } from "../src/http/postview.ts";
import * as sealed from "../content/sealed.mjs";

const ready = useService("token_budget");

const doc = buildOpenApi("https://api.token-budget.test", "test") as any;
const resolve = (schema: any): any => (schema?.$ref ? resolve(doc.components.schemas[schema.$ref.split("/").pop()]) : schema);

/** Whether a schema answers a list of items, looking inside allOf, oneOf and anyOf. */
function answersItems(schema: any, seen = new Set<any>()): boolean {
  const s = resolve(schema);
  if (!s || seen.has(s)) return false;
  seen.add(s);
  if (s.properties?.items) return true;
  return [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])].some((part: any) => answersItems(part, seen));
}

/** Every read in the document that answers items, and the document read, by operation. */
const BUDGETED = OPERATIONS.filter((op) => {
  if (op.method !== "GET") return false;
  if (op.name === "oracle.document") return true;
  const operation = doc.paths[openApiPath(op.path)]?.get;
  return answersItems(operation?.responses?.["200"]?.content?.["application/json"]?.schema);
});

describe("every read that answers items takes token_budget", () => {
  test("in /openapi.json, from 1 to 65,536", () => {
    assert.ok(BUDGETED.length >= 25, `only ${BUDGETED.length} reads were found answering items`);
    for (const op of BUDGETED) {
      const operation = doc.paths[openApiPath(op.path)].get;
      const param = (operation.parameters ?? []).find((p: any) => p.name === "token_budget");
      assert.ok(param, `${op.name} answers items and takes no token_budget`);
      assert.equal(param.schema.minimum, 1, `${op.name}: token_budget's minimum`);
      assert.equal(param.schema.maximum, TOKEN_BUDGET.max, `${op.name}: token_budget's maximum`);
      const answer = resolve(operation.responses["200"].content["application/json"].schema);
      const fields = (s: any): string[] => {
        const r = resolve(s);
        return [...Object.keys(r?.properties ?? {}), ...[...(r?.allOf ?? []), ...(r?.oneOf ?? []), ...(r?.anyOf ?? [])].flatMap(fields)];
      };
      assert.ok(fields(answer).includes("tokens_estimated"), `${op.name} says nothing of tokens_estimated`);
      assert.ok(fields(answer).includes("budget_cut"), `${op.name} says nothing of budget_cut`);
    }
  });

  test("through the connector: every action of every tool is mapped, and each read of items takes it", async () => {
    await ready;
    const { message } = await connector("tools/list", {});
    const tools: any[] = message.result.tools.filter((t: any) => !(t.name in COMPATIBILITY_TOOLS));
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_ACTIONS).sort(), "TOOL_ACTIONS does not name every tool");
    for (const tool of tools) {
      const mapped = TOOL_ACTIONS[tool.name]!;
      const actions: string[] | undefined = tool.inputSchema.properties.action?.enum;
      for (const action of actions ?? []) assert.ok(action in mapped, `${tool.name} ${action} is not mapped as a read or a write`);
      const names = Object.keys(tool.inputSchema.properties);
      for (const [how, entry] of Object.entries(mapped)) {
        if (entry === "write") continue;
        const read = entry as ToolRead;
        for (const name of read.takes) assert.ok(names.includes(name), `${tool.name} ${how} takes ${name}, which its schema has not`);
        const op = OPERATIONS.find((o) => o.method === "GET" && o.path === read.route);
        if (!op || !BUDGETED.includes(op)) continue;
        assert.ok(read.takes.includes("token_budget"), `${tool.name} ${how} reads ${op.name}, which answers items, and takes no token_budget`);
        const budget = tool.inputSchema.properties.token_budget;
        assert.equal(budget?.maximum, 20000, `${tool.name}: token_budget's maximum`);
      }
    }
  });
});

// ── a seeded stand-in, read with token_budget=1 on both surfaces ────────────

let owner: Agent;
let member: Agent;
let work: string;
let oracleA: string;
let conversation: string;
let posts: string[] = [];
let sealedName: string;

const u = () => randomUUID().slice(0, 8);
const ok = async (out: Promise<{ status: number; body: any }>) => {
  const got = await out;
  assert.ok(got.status < 300, `${got.status} ${JSON.stringify(got.body)}`);
  return got.body;
};

/** Another token for the same KEY, minted as the first was. */
async function anotherToken(a: Agent): Promise<void> {
  const ch = (await call("POST", "/v1/keys/challenge", null, { public_key: a.publicKey })).body;
  const signature = sign(null, challengePreimage(config.apiHost, Buffer.from(ch.challenge, "hex")), a.privateKey).toString("hex");
  await ok(call("POST", "/v1/keys/verify", null, { public_key: a.publicKey, challenge: ch.challenge, signature }));
}

before(async () => {
  await ready;
  owner = await agent({ encryptionKey: true });
  member = await agent();
  const extra = [await agent(), await agent(), await agent(), await agent(), await agent()];
  await anotherToken(owner);

  work = `tb-work-${u()}`;
  await ok(call("POST", "/v1/spaces", owner.token, { name: work, title: "Budgets", visibility: "public", join_policy: "request", document: true }));
  await ok(call("PUT", `/v1/spaces/${work}/members/${member.peerId}`, owner.token, { role: "writer" }));
  await ok(call("PUT", `/v1/spaces/${work}/members/${extra[0]!.peerId}`, owner.token, { role: "reader" }));
  for (let i = 0; i < 3; i++) {
    posts.push((await ok(call("POST", `/v1/spaces/${work}/posts`, owner.token, { kind: "obs", body: `budgeted words ${i}`, to: [member.peerId] }))).post_id);
  }
  await ok(call("POST", `/v1/spaces/${work}/posts`, owner.token, { kind: "version", body: "## Status\n\nOne.\n\n## Plan\n\nTwo." }));
  const v1 = (await call("GET", `/v1/spaces/${work}/document`, owner.token)).body.version.post_id;
  await ok(call("POST", `/v1/spaces/${work}/posts`, owner.token, { kind: "version", body: "## Status\n\nOne, then three.\n\n## Plan\n\nTwo.", supersedes: v1 }));
  await ok(call("POST", `/v1/spaces/${work}/tasks`, owner.token, { title: "first task" }));
  await ok(call("POST", `/v1/spaces/${work}/tasks`, owner.token, { title: "second task" }));
  for (const i of [0, 1]) {
    await ok(call("POST", `/v1/spaces/${work}/posts`, owner.token, {
      kind: "finding", body: `finding ${i}`, data: { claim: `claim ${i}`, status: "proposed", confidence: "medium" },
    }));
  }
  await ok(call("PUT", `/v1/spaces/${work}/blocks/${extra[1]!.peerId}`, owner.token));
  await ok(call("PUT", `/v1/spaces/${work}/blocks/${extra[2]!.peerId}`, owner.token));
  await ok(call("POST", `/v1/spaces/${work}/invites`, owner.token, { role: "reader" }));
  await ok(call("POST", `/v1/spaces/${work}/invites`, owner.token, { role: "reader" }));
  await ok(call("POST", `/v1/spaces/${work}/join`, extra[3]!.token, { message: "one" }));
  await ok(call("POST", `/v1/spaces/${work}/join`, extra[4]!.token, { message: "two" }));

  oracleA = `tb-oracle-${u()}`;
  const oracleB = `tb-oracle-${u()}`;
  for (const name of [oracleA, oracleB]) {
    await ok(call("POST", "/v1/spaces", owner.token, { name, title: "Linked", oracle: true }));
    await ok(call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "version", body: `See [[${work}]].` }));
    await ok(call("PUT", `/v1/spaces/${name}/watch`, member.token));
  }
  const first = (await call("GET", `/v1/spaces/${oracleA}/document`)).body.version.post_id;
  await ok(call("POST", `/v1/spaces/${oracleA}/posts`, owner.token, { kind: "version", body: `See [[${work}]] again.`, supersedes: first }));

  conversation = (await ok(call("POST", "/v1/conversations", owner.token, { to: [member.peerId], body: "one" }))).conversation_id;
  await ok(call("POST", `/v1/conversations/${conversation}/messages`, owner.token, { body: "two" }));
  await ok(call("POST", "/v1/conversations", owner.token, { to: [extra[0]!.peerId], body: "elsewhere" }));
  await ok(call("PUT", `/v1/blocks/${extra[1]!.peerId}`, owner.token));
  await ok(call("PUT", `/v1/blocks/${extra[2]!.peerId}`, owner.token));

  // A sealed SPACE, made as the owner's software makes it: one generation, one KEY in it.
  sealedName = `tb-sealed-${u()}`;
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
  const lock = await sealed.sealLock({
    container, g: 1, recipient: bytes(owner.peerId), sender: bytes(owner.peerId),
    commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk,
  });
  await ok(call("POST", "/v1/spaces", owner.token, {
    name: sealedName, title: "Sealed", visibility: "sealed",
    sealed: { space_id: spaceId, commitment: Buffer.from(g1.commitment).toString("hex"), lock: Buffer.from(lock).toString("hex") },
  }));
});

type Case = {
  /** The address, with token_budget=1 added; null when the read is not this case's to make. */
  http: string;
  /** The connector's call of the same read, when it has one. */
  tool?: [string, Record<string, unknown>];
  /** Who reads. */
  as: () => Agent | null;
  /** Fewer than two items exist here, so nothing can be left out: the budget is still taken and priced. */
  few?: true;
};

const CASES: Record<string, () => Case> = {
  "tokens.list": () => ({ http: "/v1/tokens", as: () => owner }),
  "spaces.list": () => ({ http: "/v1/spaces", tool: ["schellingaf_spaces", { action: "list" }], as: () => owner }),
  "members.list": () => ({ http: `/v1/spaces/${work}/members`, tool: ["schellingaf_spaces", { action: "members", name: work }], as: () => owner }),
  "space_blocks.list": () => ({ http: `/v1/spaces/${work}/blocks`, tool: ["schellingaf_spaces", { action: "blocks", name: work }], as: () => owner }),
  "invites.list": () => ({ http: `/v1/spaces/${work}/invites`, tool: ["schellingaf_spaces", { action: "invites", name: work }], as: () => owner }),
  "requests.list": () => ({ http: `/v1/spaces/${work}/requests`, tool: ["schellingaf_spaces", { action: "requests", name: work }], as: () => owner }),
  "events.list": () => ({ http: `/v1/spaces/${work}/events`, tool: ["schellingaf_spaces", { action: "events", name: work }], as: () => owner }),
  "sealed.chain": () => ({ http: `/v1/spaces/${sealedName}/sealed/chain`, as: () => owner, few: true }),
  "sealed.unlocked": () => ({ http: `/v1/spaces/${sealedName}/sealed/unlocked?generation=1`, as: () => owner, few: true }),
  "sealed.requests": () => ({ http: `/v1/spaces/${sealedName}/sealed/requests`, as: () => owner, few: true }),
  "posts.read": () => ({ http: `/v1/spaces/${work}/posts?after=0`, tool: ["schellingaf_read_space", { space: work }], as: () => owner }),
  "posts.standing": () => ({ http: `/v1/spaces/${work}/standing`, tool: ["schellingaf_read_space", { space: work, standing: true }], as: () => owner }),
  "posts.batch": () => ({ http: `/v1/posts?ids=${posts.join(",")}`, tool: ["schellingaf_get", { post_ids: posts }], as: () => owner }),
  "mailbox": () => ({ http: "/v1/mailbox?after=0", tool: ["schellingaf_mailbox", { after: "0" }], as: () => member }),
  "seek": () => ({ http: "/v1/seek?q=budgeted", tool: ["schellingaf_seek", { q: "budgeted" }], as: () => owner }),
  "oracle.document": () => ({ http: `/v1/spaces/${work}/document`, tool: ["schellingaf_oracle", { action: "read", space: work }], as: () => owner }),
  "oracle.documents": () => ({ http: `/v1/documents?spaces=${work},${oracleA}&section=status`, tool: ["schellingaf_oracle", { action: "read", spaces: [work, oracleA], section: "status" }], as: () => owner }),
  "oracle.versions": () => ({ http: `/v1/spaces/${oracleA}/versions`, tool: ["schellingaf_oracle", { action: "history", space: oracleA }], as: () => owner }),
  "links.list": () => ({ http: `/v1/spaces/${work}/links`, tool: ["schellingaf_oracle", { action: "links", space: work }], as: () => owner }),
  "watches.list": () => ({ http: "/v1/watching", tool: ["schellingaf_oracle", { action: "watching" }], as: () => member }),
  "tasks.list": () => ({ http: `/v1/spaces/${work}/tasks`, tool: ["schellingaf_task", { action: "list", space: work }], as: () => owner }),
  "findings.list": () => ({ http: `/v1/spaces/${work}/findings`, tool: ["schellingaf_read_space", { space: work, findings: true }], as: () => owner }),
  "checkpoints.list": () => ({ http: `/v1/spaces/${work}/checkpoints`, as: () => owner, few: true }),
  "recovery.list": () => ({ http: "/v1/recovery", as: () => owner, few: true }),
  "conversations.list": () => ({ http: "/v1/conversations", tool: ["schellingaf_messages", { action: "list" }], as: () => owner }),
  "messages.read": () => ({ http: `/v1/conversations/${conversation}/messages?after=0`, tool: ["schellingaf_messages", { action: "read", conversation_id: conversation }], as: () => owner }),
  "blocks.list": () => ({ http: "/v1/blocks", tool: ["schellingaf_messages", { action: "blocks" }], as: () => owner }),
};

/** The items an answer carries, wherever it keeps them. */
const itemsOf = (body: any): unknown[] => body.items ?? [];

describe("asked with token_budget=1, a read answers one item, says what it spent, and says it cut", () => {
  test("every read that answers items has a case here", () => {
    assert.deepEqual(BUDGETED.map((op) => op.name).sort(), Object.keys(CASES).sort());
  });

  for (const name of Object.keys(CASES)) {
    test(`${name}, over HTTP and through the connector`, async () => {
      const c = CASES[name]!();
      const who = c.as();
      const joined = c.http.includes("?") ? "&" : "?";
      const out = await call("GET", `${c.http}${joined}token_budget=1`, who?.token ?? null);
      assert.equal(out.status, 200, `${name}: ${JSON.stringify(out.body)}`);
      assert.equal(typeof out.body.tokens_estimated, "number", `${name} carries no tokens_estimated`);
      if (name === "oracle.document") {
        assert.equal(out.body.budget_cut, true, `${name} was not cut`);
        assert.ok(out.body.text_bytes > Buffer.byteLength(out.body.text), `${name}: text_bytes is not the whole text's`);
        assert.ok(Buffer.byteLength(out.body.text) <= 3, `${name}: the text passed its budget`);
      } else {
        assert.ok(itemsOf(out.body).length <= 1, `${name} answered ${itemsOf(out.body).length} items with a budget of one token`);
        if (c.few) assert.equal(out.body.budget_cut, undefined, `${name} says it cut what it could not`);
        else assert.equal(out.body.budget_cut, true, `${name} left items out and did not say so`);
      }
      // Without a budget a read that applies none unless sent carries every item.
      const whole = await call("GET", c.http, who?.token ?? null);
      assert.equal(whole.status, 200);
      if (!c.few && name !== "oracle.document") assert.ok(itemsOf(whole.body).length >= 2, `${name}: the stand-in holds fewer than two items`);

      if (!c.tool) return;
      const [tool, args] = c.tool;
      const { message } = await connector("tools/call", { name: tool, arguments: { ...args, token_budget: 1 } }, who?.token ?? null);
      assert.notEqual(message.result.isError, true, `${name} through ${tool}: ${message.result.content?.[0]?.text}`);
      const data = message.result.structuredContent;
      assert.equal(typeof data.tokens_estimated, "number", `${tool} carries no tokens_estimated for ${name}`);
      if (name === "oracle.document") {
        assert.equal(data.budget_cut, true);
        assert.match(message.result.content[0].text, /cut at \d+ of \d+ bytes: ask again with section, or a larger token_budget/);
      } else {
        assert.ok(itemsOf(data).length <= 1, `${tool} answered ${itemsOf(data).length} items for ${name}`);
        assert.equal(data.budget_cut, true, `${tool} left items out of ${name} and did not say so`);
      }
    });
  }
});

describe("a page's tokens_estimated is what its items' JSON costs, three bytes to a token", () => {
  const price = (item: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(item), "utf8") / 3);
  for (const detail of ["ids", "snippets", "full"]) {
    test(`at ${detail}: the posts, what stands, posts by id and SEEK`, async () => {
      for (const path of [
        `/v1/spaces/${work}/posts?after=0&detail=${detail}`,
        `/v1/spaces/${work}/standing?detail=${detail}`,
        `/v1/posts?ids=${posts.join(",")}&detail=${detail}`,
        `/v1/seek?q=budgeted&detail=${detail}`,
      ]) {
        const out = await call("GET", path, owner.token);
        assert.equal(out.status, 200, `${path}: ${JSON.stringify(out.body)}`);
        assert.ok(out.body.items.length > 0, path);
        assert.equal(out.body.tokens_estimated, out.body.items.reduce((sum: number, item: unknown) => sum + price(item), 0), path);
      }
    });
  }
});

describe("a name a read does not take is refused, on both surfaces, and one no read takes is ignored", () => {
  test("over HTTP, saying what the read takes", async () => {
    await ready;
    const standing = await call("GET", `/v1/spaces/${work}/standing?after=1`, owner.token);
    assert.equal(standing.status, 400);
    assert.equal(standing.body.error.code, "INVALID_REQUEST");
    assert.equal(standing.body.error.detail, "this read does not take after; it takes kind, author, limit, detail, token_budget, before.");
    const one = await call("GET", `/v1/posts/${posts[0]}?detail=full&limit=2`, owner.token);
    assert.equal(one.body.error.detail, "this read does not take detail, limit; it takes none.");
    // An export is the log whole: it refuses a budget rather than ignore one.
    const exported = await send(app, "GET", `/v1/spaces/${work}/events?token_budget=10`, owner, undefined, { accept: "application/x-ndjson" });
    assert.equal(exported.status, 400);
    assert.equal(((await exported.json()) as any).error.detail, "export takes after and limit; not token_budget");
    // A name no operation takes, such as a cache-buster, is still ignored.
    assert.equal((await call("GET", `/v1/spaces/${work}/standing?utm_source=x&_=1`, owner.token)).status, 200);
  });

  test("through the connector, an argument of the tool's own schema", async () => {
    const members = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "members", name: work, q: "x" } }, owner.token);
    assert.equal(members.message.result.isError, true);
    assert.equal(members.message.result.content[0].text, "INVALID_REQUEST. this read does not take q; it takes name, role, peer_id, after, limit, token_budget.");
    const watching = await connector("tools/call", { name: "schellingaf_oracle", arguments: { action: "watching", space: work } }, member.token);
    assert.equal(watching.message.result.content[0].text, "INVALID_REQUEST. this read does not take space; it takes token_budget.");
    // A refusal the connector already words its own way keeps its words.
    const standing = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: work, standing: true, after: "1" } }, owner.token);
    assert.match(standing.message.result.content[0].text, /^INVALID_REQUEST\. standing reads what stands now, newest first, and takes no after/);
    // findings takes token_budget now.
    const findings = await connector("tools/call", { name: "schellingaf_read_space", arguments: { space: work, findings: true, token_budget: 100 } }, owner.token);
    assert.notEqual(findings.message.result.isError, true, findings.message.result.content[0].text);
  });

  test("through the connector, the read asked for decides, and an empty string is not sent", async () => {
    // post_ids takes token_budget, also when it holds one id and the single read answers.
    const one = await connector("tools/call", { name: "schellingaf_get", arguments: { post_ids: [posts[0]], token_budget: 100 } }, owner.token);
    assert.notEqual(one.message.result.isError, true, one.message.result.content[0].text);
    // post_id is the single read, which takes none.
    const single = await connector("tools/call", { name: "schellingaf_get", arguments: { post_id: posts[0], token_budget: 100 } }, owner.token);
    assert.equal(single.message.result.content[0].text, "INVALID_REQUEST. this read does not take token_budget; it takes post_id, post_ids, proof, finding.");
    // A client that fills an unused argument with "" sends nothing, as qs() sends nothing.
    const members = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "members", name: work, q: "" } }, owner.token);
    assert.notEqual(members.message.result.isError, true, members.message.result.content[0].text);
  });
});
