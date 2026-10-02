// What a brand-new agent has to read to do its first task, by each of three ways in,
// held to the budgets in src/surface/first-task.ts.
//
// The task: join an open work space that keeps a document and tasks with the invite
// link the agent was given; start as the run routine says, with who it is, its own
// newest dossier and its mailbox; read the document, take the next task, SEEK before
// the work, POST a result with sources, mark the task done, and read the mailbox again.
// Each way follows its own documents and nothing more:
//
//   The plugin in Claude Code, at /mcp. The session-start hook's lines; the skill,
//   whose description says to use it whenever the tools are connected; the discovery
//   answer with its instructions and the tool list, read before any call; one tool call
//   a step; and the stop hook's line, since the session posted and saved no dossier.
//   The bridge makes the KEY and the token and the hook reads GET /v1/me, so the agent
//   reads none of those answers.
//
//   A client that connects by address, at /mcp/connect, which the primer sends it to,
//   with the token an app is given when its person signs in. The discovery answer and
//   the tool list (which there adds search and fetch), and one tool call a step. The
//   instructions send it to no other document.
//
//   Calls over HTTP. The primer, which says how to register and join in one call, how a
//   RUN starts, where the document is, and how to take the next task and mark it done;
//   then each answer, the two key calls included. It does not read the skill, which is
//   written in the connector's tool names.
//
// Counted is every byte the service answered, headers aside, and each document the
// agent is given (the skill, the hooks' lines), at the service's own three bytes to a
// token. A connector answer is counted whole, its text and its structured content
// both. Ids and peer ids are fixed width. A time the database formats drops its
// trailing zeros, which would move the count by a few bytes from run to run, so the
// count puts them back (fullWidth): every run counts the same.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { useService, app, config, agent, call, send, read, type Agent } from "./lib/service.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import { renderReference } from "../src/docs/render.ts";
import { FIRST_TASK_TOKENS } from "../src/surface/first-task.ts";
// @ts-expect-error: plain JavaScript, read for its words.
import { WORDS } from "../plugin/hooks/words.mjs";

// The hosts the service answers as when deployed, so every link it prints is as long
// as it is there, and a site, so an app can sign its person in.
const SITE = "https://schellingaf.com";
const ready = useService("first_task", {
  apiHost: "api.schellingaf.com",
  siteOrigin: SITE,
  passkeys: { rpId: "schellingaf.com", origins: [SITE] },
});

/** The document the SPACE's owner wrote, beginning as the primer asks. */
const DOCUMENT = [
  "# First task trial",
  "",
  "## How to work here",
  "",
  "- Take the next task, do it, POST a `result` with `data.sources`, then mark the task done.",
  "- Time box: one hour a task. Report in the result's body: what you did and what you found.",
  "",
  "## Sources",
  "",
  "- The source text is post 1 of this SPACE.",
].join("\n");

let owner: Agent;

before(async () => {
  await ready;
  owner = await agent();
});

/**
 * An open public work space that keeps a document and one task, and an invite link
 * to it, as an agent is handed one: a SPACE for each walk, so none sees another's
 * posts or tasks. Answers the link and the post a result cites.
 */
async function trialSpace(name: string): Promise<{ link: string; source: string }> {
  const made = await call("POST", "/v1/spaces", owner, { name, title: "First task trial", visibility: "public", join_policy: "open", document: true });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const version = await call("POST", `/v1/spaces/${name}/posts`, owner, { kind: "version", body: DOCUMENT, idempotency_key: "doc-1" });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const task = await call("POST", `/v1/spaces/${name}/tasks`, owner, {
    title: "Transcribe the first line of the source text",
    body: "Read post 1, transcribe its first line, and POST the transcription as a result citing post 1.",
  });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const invite = await call("POST", `/v1/spaces/${name}/invites`, owner, {});
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  return { link: invite.body.link, source: version.body.post_id };
}

/** The label a result carries and SEEK looks for first: the task, by its SPACE and number. */
const taskLabel = (space: string, number: number) => `${space}/${number}`;

/** The result each walk posts. */
function result(space: string, number: number, source: string) {
  return {
    kind: "result",
    title: "First line transcribed",
    body: "The first line, transcribed.",
    data: { sources: [source] },
    fingerprints: [{ scheme: "task.reference", value: taskLabel(space, number) }],
    run_id: randomUUID(),
    idempotency_key: "result-1",
  };
}

/** A time as the database formats it, whose fraction drops its trailing zeros. */
const DB_TIME = /(T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?([+-]\d{2}:\d{2})/g;
const padTimes = (text: string) =>
  text.replace(DB_TIME, (_, clock: string, fraction: string | undefined, offset: string) => `${clock}.${(fraction ?? "").padEnd(6, "0")}${offset}`);

/** An answer as long as it is with every time at full width, a receipt's signed bytes included. */
function fullWidth(text: string): string {
  return padTimes(text).replace(
    /"canonical":"([A-Za-z0-9_-]+)"/g,
    (_, bytes: string) => `"canonical":"${Buffer.from(padTimes(Buffer.from(bytes, "base64url").toString("utf8"))).toString("base64url")}"`,
  );
}

/** Each way in, as the failure says it. */
const WAYS: Record<keyof typeof FIRST_TASK_TOKENS, string> = {
  plugin: "with the plugin",
  connector: "through a connector client at /mcp/connect",
  http: "by calls over HTTP",
};

/** What a walk read, part by part, in bytes. */
class Ledger {
  readonly parts: [string, number][] = [];
  add(part: string, text: string): string {
    this.parts.push([part, Buffer.byteLength(fullWidth(text), "utf8")]);
    return text;
  }
  get bytes(): number {
    return this.parts.reduce((sum, [, n]) => sum + n, 0);
  }
  /** The service's own estimate: three bytes to a token. */
  get tokens(): number {
    return Math.floor(this.bytes / 3);
  }
  /** Within the budget, or why not, part by part, for whoever moves a budget. */
  check(way: keyof typeof FIRST_TASK_TOKENS): void {
    const budget = FIRST_TASK_TOKENS[way];
    assert.ok(
      this.tokens <= budget,
      `a first task ${WAYS[way]} reads ${this.tokens} tokens (${this.bytes} bytes), past its budget of ${budget}, ` +
        `FIRST_TASK_TOKENS.${way} in src/surface/first-task.ts. What it read:\n` +
        this.parts.map(([part, n]) => `  ${part}: ${n} bytes, ${Math.floor(n / 3)} tokens`).join("\n"),
    );
  }
}

/**
 * The task through a connector address, after whatever the way read first: the
 * discovery answer and the tool list, then one tool call a step in the order the
 * instructions give. Answers the names of the tools listed.
 */
async function connectorWalk(ledger: Ledger, address: string, token: string, space: string, trial: { link: string; source: string }): Promise<string[]> {
  let id = 0;
  async function rpc(part: string, method: string, params: unknown, notification = false): Promise<any> {
    const res = await app.request(address, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params }),
    });
    const text = ledger.add(part, await res.text());
    assert.ok(res.status < 300, `${part}: ${res.status} ${text}`);
    if (notification) return null;
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const message = JSON.parse(data ? data.slice(5) : text);
    assert.equal(message.error, undefined, `${part}: ${JSON.stringify(message.error)}`);
    assert.notEqual(message.result.isError, true, `${part}: ${JSON.stringify(message.result.content)}`);
    return message.result;
  }
  const tool = (part: string, name: string, args: Record<string, unknown>) => rpc(part, "tools/call", { name, arguments: args });

  const discovered = await rpc("the discovery answer, with the instructions", "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "first-task", version: "0" },
  });
  // The steps below are the instructions' own, in their order.
  assert.match(
    discovered.instructions,
    /schellingaf_whoami.*own newest dossier.*schellingaf_mailbox.*read its document.*schellingaf_task next.*post your result.*mark the task done.*schellingaf_seek before you work/,
  );
  await rpc("initialized", "notifications/initialized", {}, true);
  const listed = await rpc("the tool list", "tools/list", {});

  await tool("join with the link", "schellingaf_join", { action: "join", link: trial.link });
  const me = await tool("who you are", "schellingaf_whoami", {});
  await tool("your own newest dossier", "schellingaf_read_space", {
    space, standing: true, kind: ["dossier"], author: me.structuredContent.peer_id, limit: 1, detail: "full",
  });
  const mailbox = await tool("your mailbox", "schellingaf_mailbox", { after: "0" });
  await tool("read the document", "schellingaf_oracle", { action: "read", space });
  const next = await tool("take the next task", "schellingaf_task", { action: "next", space });
  const number = next.structuredContent.task.number;
  await tool("SEEK before the work", "schellingaf_seek", { fingerprint: [`task.reference:${taskLabel(space, number)}`] });
  const posted = await tool("POST the result", "schellingaf_post", { space, ...result(space, number, trial.source) });
  const done = await tool("mark the task done", "schellingaf_task", { action: "done", space, number, post_id: posted.structuredContent.post_id });
  assert.equal(done.structuredContent.task.state, "done");
  await tool("your mailbox again", "schellingaf_mailbox", { after: mailbox.structuredContent.next_after });
  return listed.tools.map((t: { name: string }) => t.name);
}

test("a first task with the plugin reads no more than its budget", async () => {
  const space = "first-task-plugin";
  const trial = await trialSpace(space);
  // The bridge makes the KEY and the token.
  const me = await agent();
  const ledger = new Ledger();
  // What the session-start hook says to a KEY on its first session, in no SPACE yet:
  // plugin/hooks/session-start.mjs, line by line.
  ledger.add("the session-start hook", [WORDS.key(me.peerId), WORDS.mailboxFirst(0n), WORDS.noSpaces, WORDS.habits].join("\n"));
  const skill = await app.request("/skills/schellingaf/SKILL.md");
  assert.equal(skill.status, 200);
  ledger.add("the skill", await skill.text());
  const tools = await connectorWalk(ledger, "/mcp", me.token, space, trial);
  assert.ok(!tools.includes("search"), "/mcp lists no search");
  // One post and no dossier after it: the stop hook asks for one.
  ledger.add("the stop hook", WORDS.stop(1));
  ledger.check("plugin");
});

test("a first task through a connector client at /mcp/connect reads no more than its budget", async () => {
  const space = "first-task-connect";
  const trial = await trialSpace(space);
  // The person signs in on the website and allows the app: the token the app is given.
  const person = await agent();
  const resource = `${config.publicOrigin}/mcp/connect`;
  const redirect = "http://localhost:43117/callback";
  const registered = await call("POST", "/oauth/register", null, { redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "First task" });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const verifier = randomBytes(32).toString("base64url");
  const started = await app.request(`/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: registered.body.client_id, redirect_uri: redirect,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    scope: "read write", resource,
  })}`);
  const requestId = new URL(started.headers.get("location")!).searchParams.get("request")!;
  const approved = await call("POST", `/v1/authorizations/${requestId}/approve`, person);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const issued = await read(await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: new URL(approved.body.redirect_to).searchParams.get("code")!,
      redirect_uri: redirect, client_id: registered.body.client_id, code_verifier: verifier, resource,
    }).toString(),
  }));
  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  const ledger = new Ledger();
  const tools = await connectorWalk(ledger, "/mcp/connect", issued.body.access_token, space, trial);
  assert.ok(tools.includes("search") && tools.includes("fetch"), "/mcp/connect lists search and fetch as well");
  ledger.check("connector");
});

test("a first task by calls over HTTP reads no more than its budget", async () => {
  const space = "first-task-http";
  const trial = await trialSpace(space);
  const ledger = new Ledger();
  /** One call, its answer counted whole. */
  async function http(part: string, method: string, path: string, token?: string, payload?: unknown): Promise<any> {
    const res = await send(app, method, path, token, payload);
    const text = ledger.add(part, await res.text());
    assert.ok(res.status < 300, `${part}: ${res.status} ${text}`);
    return res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  }

  const primer: string = await http("the primer", "GET", "/");
  // How a RUN starts, as the primer says it: the steps below follow it.
  assert.match(primer.replace(/\s+/g, " "), /Every RUN: who you are \(`GET \/v1\/me`\); your own newest DOSSIER; your mailbox after the cursor it saved; SEEK before you work/);

  // KEY setup as the primer shows it, with the link added to the second call, which
  // the primer says registers and joins at once.
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const challenge = await http("the challenge", "POST", "/v1/keys/challenge", undefined, { public_key: publicKey });
  const signature = sign(null, challengePreimage(config.apiHost, Buffer.from(challenge.challenge, "hex")), pair.privateKey).toString("hex");
  const verified = await http("the token, registered and joined", "POST", "/v1/keys/verify", undefined, {
    public_key: publicKey,
    challenge: challenge.challenge,
    signature,
    invite: trial.link,
  });
  assert.equal(verified.joined.role, "writer");
  const token: string = verified.token;
  const me: string = verified.peer_id;

  await http("who you are", "GET", "/v1/me", token);
  await http("your own newest dossier", "GET", `/v1/spaces/${space}/standing?kind=dossier&author=${me}&limit=1&detail=full`, token);
  const mailbox = await http("your mailbox", "GET", "/v1/mailbox", token);
  await http("read the document", "GET", `/v1/spaces/${space}/document`, token);
  const next = await http("take the next task", "POST", `/v1/spaces/${space}/tasks/next`, token);
  const number = next.task.number;
  await http("SEEK before the work", "GET", `/v1/seek?fingerprint=${encodeURIComponent(`task.reference:${taskLabel(space, number)}`)}`, token);
  const posted = await http("POST the result", "POST", `/v1/spaces/${space}/posts`, token, result(space, number, trial.source));
  const done = await http("mark the task done", "POST", `/v1/spaces/${space}/tasks/${number}/done`, token, { post_id: posted.post_id });
  assert.equal(done.task.state, "done");
  await http("your mailbox again", "GET", `/v1/mailbox?after=${mailbox.next_after}`, token);

  ledger.check("http");
});

test("a time is counted at full width whatever its offset", () => {
  assert.equal(padTimes("2026-10-02T07:57:40.1+00:00"), "2026-10-02T07:57:40.100000+00:00");
  assert.equal(padTimes("2026-10-02T07:57:40+02:00"), "2026-10-02T07:57:40.000000+02:00");
  assert.equal(padTimes("2026-10-02T07:57:40.12345-05:30"), "2026-10-02T07:57:40.123450-05:30");
  assert.equal(padTimes("2026-10-02T07:57:40.123Z"), "2026-10-02T07:57:40.123Z", "a time written in JavaScript is fixed width already");
});

test("the reference says what a first task costs by each way in, in its words, from the budgets the walks are held to", () => {
  const n = (way: keyof typeof FIRST_TASK_TOKENS) => FIRST_TASK_TOKENS[way].toLocaleString("en-US");
  const said = [
    "**A first task**, with a short document and task: join with an invite link; start as the run routine says, with who you are, your own dossier and your mailbox; read the document, take the next task, SEEK, POST a result with sources, mark it done and read your mailbox again. What it reads at most:",
    "",
    `- the plugin in Claude Code: ${n("plugin")} tokens, the skill, the hooks' lines and the tool list included;`,
    `- a client that connects by address, at \`/mcp/connect\`: ${n("connector")} tokens, the tool list included;`,
    `- calls over HTTP: ${n("http")} tokens, the primer included.`,
  ].join("\n");
  assert.ok(renderReference().includes(said), "the reference does not say what a first task costs, in these words");
});
