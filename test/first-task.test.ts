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
import { FIRST_TASK_TOKENS, TOOL_LIST_TOKENS } from "../src/surface/first-task.ts";
import { TOOLSETS } from "../src/mcp/server.ts";
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
  start_tasks: "by the tasks start over HTTP",
  start_research: "by the research start over HTTP",
  start_coordinate: "by the coordinate start over HTTP",
  toolset_tasks: "with the tasks toolset at /mcp?tools=tasks",
  toolset_research: "with the research toolset at /mcp?tools=research",
  toolset_coordinate: "with the coordinate toolset at /mcp?tools=coordinate",
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
/** One JSON-RPC message to a connector address, its answer counted whole, and a tool call. */
function rpcOf(ledger: Ledger, address: string, token: string) {
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
  /** The discovery answer and the tool list, as a client reads them before any call. */
  async function discover(): Promise<{ instructions: string; tools: string[] }> {
    const discovered = await rpc("the discovery answer, with the instructions", "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "first-task", version: "0" },
    });
    await rpc("initialized", "notifications/initialized", {}, true);
    const listed = await rpc("the tool list", "tools/list", {});
    return { instructions: discovered.instructions, tools: listed.tools.map((t: { name: string }) => t.name) };
  }
  return { rpc, tool, discover };
}

async function connectorWalk(ledger: Ledger, address: string, token: string, space: string, trial: { link: string; source: string }, own = space): Promise<string[]> {
  const { tool, discover } = rpcOf(ledger, address, token);
  const discovered = await discover();
  // The steps below are the instructions' own, in their order.
  assert.match(
    discovered.instructions,
    /schellingaf_whoami.*own newest dossier.*schellingaf_mailbox.*read its document.*schellingaf_task next.*post your result.*mark the task done.*schellingaf_seek before you work/,
  );

  await tool("join with the link", "schellingaf_join", { action: "join", link: trial.link });
  const me = await tool("who you are", "schellingaf_whoami", {});
  await tool("your own newest dossier", "schellingaf_read_space", {
    space: own, standing: true, kind: ["dossier"], author: me.structuredContent.peer_id, limit: 1, detail: "full",
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
  return discovered.tools;
}

test("a first task with the plugin reads no more than its budget", async () => {
  const space = "first-task-plugin";
  const trial = await trialSpace(space);
  // The bridge makes the KEY and the token.
  const me = await agent();
  const ledger = new Ledger();
  // What the session-start hook says to a KEY on its first session, in no SPACE yet:
  // plugin/hooks/session-start.mjs, line by line.
  ledger.add("the session-start hook", [WORDS.key(me.peerId), WORDS.mailboxFirst(0n), WORDS.noSpaces, WORDS.routine].join("\n"));
  const skill = await app.request("/skills/schellingaf/SKILL.md");
  assert.equal(skill.status, 200);
  ledger.add("the skill", await skill.text());
  const tools = await connectorWalk(ledger, "/mcp", me.token, space, trial);
  assert.ok(!tools.includes("search"), "/mcp lists no search");
  // One post and no dossier after it: the stop hook asks for one.
  ledger.add("the stop hook", WORDS.stop(1));
  ledger.check("plugin");
});

/** The person signs in on the website and allows an app: the token the app is given
 *  for /mcp/connect. */
async function appToken(): Promise<string> {
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
  return issued.body.access_token;
}

test("a first task through a connector client at /mcp/connect reads no more than its budget", async () => {
  const space = "first-task-connect";
  const trial = await trialSpace(space);
  // The person signs in on the website and allows the app: the token the app is given.
  const accessToken = await appToken();

  const ledger = new Ledger();
  const tools = await connectorWalk(ledger, "/mcp/connect", accessToken, space, trial);
  assert.ok(tools.includes("search") && tools.includes("fetch"), "/mcp/connect lists search and fetch as well");
  ledger.check("connector");
});

/** One call over HTTP, its answer counted whole. */
function httpOf(ledger: Ledger) {
  return async function http(part: string, method: string, path: string, token?: string, payload?: unknown): Promise<any> {
    const res = await send(app, method, path, token, payload);
    const text = ledger.add(part, await res.text());
    assert.ok(res.status < 300, `${part}: ${res.status} ${text}`);
    return res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  };
}

test("a first task by calls over HTTP reads no more than its budget", async () => {
  const space = "first-task-http";
  const trial = await trialSpace(space);
  const ledger = new Ledger();
  const http = httpOf(ledger);

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
    `- calls over HTTP: ${n("http")} tokens, the primer included;`,
    `- a start over HTTP, with a KEY held already: start-tasks ${n("start_tasks")}, start-research ${n("start_research")} and start-coordinate ${n("start_coordinate")} tokens, the start included;`,
    `- a toolset at \`/mcp?tools=\`, with a KEY's token: tasks ${n("toolset_tasks")}, research ${n("toolset_research")} and coordinate ${n("toolset_coordinate")} tokens, the tool list included.`,
    "",
    `What a model reads of the tool list, each tool's name, description and input schema as compact JSON: ${TOOL_LIST_TOKENS.mcp.toLocaleString("en-US")} tokens at \`/mcp\`, ${TOOL_LIST_TOKENS.connect.toLocaleString("en-US")} at \`/mcp/connect\`, and ${TOOL_LIST_TOKENS.tasks.toLocaleString("en-US")}, ${TOOL_LIST_TOKENS.research.toLocaleString("en-US")} and ${TOOL_LIST_TOKENS.coordinate.toLocaleString("en-US")} for the sets \`tasks\`, \`research\` and \`coordinate\`.`,
  ].join("\n");
  assert.ok(renderReference().includes(said), "the reference does not say what a first task costs, in these words");
});

// The starts, and the toolsets that match them. A start is for an agent holding a KEY
// and its token already, so the KEY, and the private work space of its own the tasks and
// research starts keep its dossier in, are made before the count begins; each walk reads
// its start section, then makes its calls in order, up to the step before the dossier. A
// toolset walk is the same steps through the set's tools, after the discovery answer and
// the set's tool list; no hook, skill or stop line.

/** A KEY that holds its token and its own private work space already, where the starts
 *  keep its dossier: made before a walk counts, as the KEY is. */
async function keyWithOwnSpace(name: string): Promise<{ key: Agent; own: string }> {
  const key = await agent();
  const own = `${name}-own`;
  const made = await call("POST", "/v1/spaces", key, { name: own, title: "My work" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { key, own };
}

/** The document a coordinator writes first, beginning as the oracle-spaces section asks. */
const FIRST_VERSION = DOCUMENT;

/** A public work space anyone may post in, seeded with two posts and a finding resting
 *  on them, filed under the category the research walk looks up. */
async function researchSpace(name: string): Promise<{ sources: string[]; finding: string }> {
  const made = await call("POST", "/v1/spaces", owner, { name, title: "The 1931 codebook", visibility: "public", join_policy: "open", categories: ["humanities"] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sources: string[] = [];
  for (const body of ["Telegram 37, transcribed: twelve groups of five figures.", "The 1931 codebook, rows 1 to 40, transcribed."]) {
    const out = await call("POST", `/v1/spaces/${name}/posts`, owner, { kind: "result", body, fingerprints: [{ scheme: "subject", value: "codebook:1931" }] });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    sources.push(out.body.post_id);
  }
  const finding = await call("POST", `/v1/spaces/${name}/posts`, owner, {
    kind: "finding",
    body: "Rows 4 to 9 of the codebook give telegram 37's first three groups.",
    data: { claim: "Telegram 37 uses the 1931 codebook", status: "proposed", confidence: "medium", sources },
    fingerprints: [{ scheme: "subject", value: "codebook:1931" }],
  });
  assert.equal(finding.status, 201, JSON.stringify(finding.body));
  return { sources, finding: finding.body.post_id };
}

/** The finding each research walk posts. */
function newFinding(sources: string[]) {
  return {
    kind: "finding",
    title: "Telegram 37's fourth group",
    body: "Row 12 of the codebook gives the fourth group as well.",
    data: { claim: "Telegram 37's fourth group is in row 12 of the 1931 codebook", status: "proposed", confidence: "medium", sources },
    fingerprints: [{ scheme: "subject", value: "codebook:1931" }],
    run_id: randomUUID(),
    idempotency_key: "finding-1",
  };
}

/** A second KEY joins with the coordinator's link and proposes a version; not counted. */
async function proposeAsAnother(space: string, link: string, current: string): Promise<string> {
  const other = await agent();
  const joined = await call("POST", "/v1/join", other, { link });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const proposed = await call("POST", `/v1/spaces/${space}/posts`, other, {
    kind: "version", body: `${FIRST_VERSION}\n- Post 2 is the codebook.`, supersedes: current,
  });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  assert.deepEqual(proposed.body.oracle, { state: "pending" });
  return proposed.body.post_id;
}

test("a first task by the tasks start over HTTP reads no more than its budget", async () => {
  const space = "first-start-tasks";
  const trial = await trialSpace(space);
  const { key, own } = await keyWithOwnSpace(space);
  const ledger = new Ledger();
  const http = httpOf(ledger);
  const start: string = await http("the start", "GET", "/reference?section=start-tasks");
  assert.match(start, /^## Start: tasks\n/);

  const joined = await http("join with the link", "POST", "/v1/join", key.token, { link: trial.link });
  assert.equal(joined.start, "start-tasks");
  const me = await http("who you are", "GET", "/v1/me", key.token);
  await http("your own newest dossier", "GET", `/v1/spaces/${own}/standing?kind=dossier&author=${me.peer_id}&limit=1&detail=full`, key.token);
  const mailbox = await http("your mailbox", "GET", "/v1/mailbox?after=0", key.token);
  await http("read the document", "GET", `/v1/spaces/${space}/document`, key.token);
  const next = await http("take the next task", "POST", `/v1/spaces/${space}/tasks/next`, key.token);
  const number = next.task.number;
  await http("SEEK before the work", "GET", `/v1/seek?fingerprint=${encodeURIComponent(`task.reference:${taskLabel(space, number)}`)}`, key.token);
  const posted = await http("POST the result", "POST", `/v1/spaces/${space}/posts`, key.token, result(space, number, trial.source));
  const done = await http("mark the task done", "POST", `/v1/spaces/${space}/tasks/${number}/done`, key.token, { post_id: posted.post_id });
  assert.equal(done.task.state, "done");
  await http("your mailbox again", "GET", `/v1/mailbox?after=${mailbox.next_after}`, key.token);
  ledger.check("start_tasks");
});

test("a first task by the research start over HTTP reads no more than its budget", async () => {
  const space = "first-start-research";
  const seeded = await researchSpace(space);
  const { key, own } = await keyWithOwnSpace(space);
  const ledger = new Ledger();
  const http = httpOf(ledger);
  const start: string = await http("the start", "GET", "/reference?section=start-research");
  assert.match(start, /^## Start: research\n/);

  const me = await http("who you are", "GET", "/v1/me", key.token);
  await http("your own newest dossier", "GET", `/v1/spaces/${own}/standing?kind=dossier&author=${me.peer_id}&limit=1&detail=full`, key.token);
  const mailbox = await http("your mailbox", "GET", "/v1/mailbox?after=0", key.token);
  const categories = await http("the subject's category", "GET", "/v1/categories?q=humanities", key.token);
  assert.ok(JSON.stringify(categories).includes("\"humanities\""));
  await http("SEEK", "GET", `/v1/seek?q=${encodeURIComponent("1931 codebook")}`, key.token);
  await http("open the hits", "GET", `/v1/posts?ids=${seeded.sources.join(",")}`, key.token);
  await http("the SPACE's findings", "GET", `/v1/spaces/${space}/findings`, key.token);
  await http("what a finding rests on", "GET", `/v1/posts/${seeded.finding}/finding`, key.token);
  const posted = await http("POST what you establish", "POST", `/v1/spaces/${space}/posts`, key.token, newFinding(seeded.sources));
  assert.equal(posted.kind ?? "finding", "finding");
  await http("your mailbox again", "GET", `/v1/mailbox?after=${mailbox.next_after}`, key.token);
  ledger.check("start_research");
});

test("a first task by the coordinate start over HTTP reads no more than its budget", async () => {
  const space = "first-start-coordinate";
  const key = await agent();
  const ledger = new Ledger();
  const http = httpOf(ledger);
  const start: string = await http("the start", "GET", "/reference?section=start-coordinate");
  assert.match(start, /^## Start: coordinate\n/);

  await http("who you are", "GET", "/v1/me", key.token);
  await http("your mailbox", "GET", "/v1/mailbox?after=0", key.token);
  await http("a category", "GET", "/v1/categories?q=humanities", key.token);
  await http("the SPACE", "POST", "/v1/spaces", key.token, {
    name: space, title: "The 1931 codebook", description: "Transcribing the 1931 codebook.", visibility: "public", categories: ["humanities"], document: true,
  });
  const first = await http("the document's first version", "POST", `/v1/spaces/${space}/posts`, key.token, { kind: "version", title: "First task trial", body: FIRST_VERSION });
  for (const title of ["Transcribe rows 1 to 20", "Transcribe rows 21 to 40"]) {
    await http(`the task: ${title}`, "POST", `/v1/spaces/${space}/tasks`, key.token, { title, body: "POST the rows as a result citing the scan.", tag: "transcribe" });
  }
  const invite = await http("a link for the agents", "POST", `/v1/spaces/${space}/invites`, key.token, { role: "writer" });
  const proposal = await proposeAsAnother(space, invite.link, first.post_id);
  const pending = await http("versions proposed to you", "GET", `/v1/spaces/${space}/versions?state=pending`, key.token);
  assert.ok(JSON.stringify(pending).includes(proposal));
  await http("decide it", "POST", `/v1/spaces/${space}/posts`, key.token, { kind: "go", reply_to: proposal, body: "It names the codebook's post." });
  await http("how the tasks move", "GET", `/v1/spaces/${space}/tasks`, key.token);
  ledger.check("start_coordinate");
});

test("a first task with the tasks toolset reads no more than its budget", async () => {
  const space = "first-toolset-tasks";
  const trial = await trialSpace(space);
  const { key, own } = await keyWithOwnSpace(space);
  const ledger = new Ledger();
  const tools = await connectorWalk(ledger, "/mcp?tools=tasks", key.token, space, trial, own);
  assert.deepEqual([...tools].sort(), [...TOOLSETS.tasks].sort());
  ledger.check("toolset_tasks");
});

test("a first task with the research toolset reads no more than its budget", async () => {
  const space = "first-toolset-research";
  const seeded = await researchSpace(space);
  const { key, own } = await keyWithOwnSpace(space);
  const ledger = new Ledger();
  const { tool, discover } = rpcOf(ledger, "/mcp?tools=research", key.token);
  const { tools } = await discover();
  assert.deepEqual([...tools].sort(), [...TOOLSETS.research].sort());

  const me = await tool("who you are", "schellingaf_whoami", {});
  await tool("your own newest dossier", "schellingaf_read_space", {
    space: own, standing: true, kind: ["dossier"], author: me.structuredContent.peer_id, limit: 1, detail: "full",
  });
  const mailbox = await tool("your mailbox", "schellingaf_mailbox", { after: "0" });
  await tool("the subject's category", "schellingaf_spaces", { action: "categories", q: "humanities" });
  await tool("SEEK", "schellingaf_seek", { q: "1931 codebook" });
  await tool("open the hits", "schellingaf_get", { post_ids: seeded.sources });
  await tool("the SPACE's findings", "schellingaf_read_space", { space, findings: true });
  await tool("what a finding rests on", "schellingaf_get", { post_id: seeded.finding, finding: true });
  await tool("POST what you establish", "schellingaf_post", { space, ...newFinding(seeded.sources) });
  await tool("your mailbox again", "schellingaf_mailbox", { after: mailbox.structuredContent.next_after });
  ledger.check("toolset_research");
});

test("a first task with the coordinate toolset reads no more than its budget", async () => {
  const space = "first-toolset-coordinate";
  const key = await agent();
  const ledger = new Ledger();
  const { tool, discover } = rpcOf(ledger, "/mcp?tools=coordinate", key.token);
  const { tools } = await discover();
  assert.deepEqual([...tools].sort(), [...TOOLSETS.coordinate].sort());

  await tool("who you are", "schellingaf_whoami", {});
  await tool("your mailbox", "schellingaf_mailbox", { after: "0" });
  await tool("a category", "schellingaf_spaces", { action: "categories", q: "humanities" });
  await tool("the SPACE", "schellingaf_space_control", {
    action: "create", name: space, title: "The 1931 codebook", description: "Transcribing the 1931 codebook.", visibility: "public", categories: ["humanities"], document: true,
  });
  const first = await tool("the document's first version", "schellingaf_oracle", { action: "propose", space, text: FIRST_VERSION });
  for (const title of ["Transcribe rows 1 to 20", "Transcribe rows 21 to 40"]) {
    await tool(`the task: ${title}`, "schellingaf_task", { action: "add", space, title, body: "POST the rows as a result citing the scan.", tag: "transcribe" });
  }
  const invite = await tool("a link for the agents", "schellingaf_space_control", { action: "invite", name: space, role: "writer" });
  const proposal = await proposeAsAnother(space, invite.structuredContent.link, first.structuredContent.post_id);
  const pending = await tool("versions proposed to you", "schellingaf_oracle", { action: "history", space, state: "pending" });
  assert.ok(JSON.stringify(pending).includes(proposal));
  await tool("decide it", "schellingaf_oracle", { action: "approve", space, proposal, reason: "It names the codebook's post." });
  await tool("how the tasks move", "schellingaf_task", { action: "list", space });
  ledger.check("toolset_coordinate");
});

test("the tool list a model reads stays within TOOL_LIST_TOKENS at each address and set", async () => {
  const tokens = { key: (await agent()).token, app: await appToken() };
  for (const [where, address] of [
    ["mcp", "/mcp"], ["connect", "/mcp/connect"], ["tasks", "/mcp?tools=tasks"], ["research", "/mcp?tools=research"], ["coordinate", "/mcp?tools=coordinate"],
  ] as const) {
    const ledger = new Ledger();
    const { rpc } = rpcOf(ledger, address, where === "connect" ? tokens.app : tokens.key);
    const listed = await rpc("the tool list", "tools/list", {});
    // What a client hands its model of each tool: the name, the description and the
    // input schema, as compact JSON.
    const bytes = listed.tools.reduce(
      (sum: number, t: any) => sum + Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }), "utf8"),
      0,
    );
    const read = Math.floor(bytes / 3);
    assert.ok(read <= TOOL_LIST_TOKENS[where], `the tool list at ${address} is ${read} tokens (${bytes} bytes), past TOOL_LIST_TOKENS.${where} in src/surface/first-task.ts`);
  }
});
