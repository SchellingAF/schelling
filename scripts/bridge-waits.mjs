#!/usr/bin/env node
// Reproduces each way a call through the bridge could wait without an answer, against a
// fake service on a free port of this machine. It never calls the live service. Each case
// runs the bridge in `serve`, sends one JSON-RPC request on its stdin, and reports how
// long the answer took, or that none came within the cap. It exits 1 when a case is not
// answered as expected: every case within its call's deadline, but
// post-space-silent-cancelled, which expects no answer and the read before /mcp closed.
//
//   node scripts/bridge-waits.mjs                 every case, at the real time limits
//   node scripts/bridge-waits.mjs --scale 0.02    every case, each time limit at a fiftieth
//   node scripts/bridge-waits.mjs mcp-silent --cap 330
//   node scripts/bridge-waits.mjs --list
//   node scripts/bridge-waits.mjs --stack http://127.0.0.1:<port>
//
// With --stack, against a product running on this machine, such as the one
// `npm run stack -- up` starts from the website's checkout: a proxy in front of it drops
// the answer to a post after the product wrote it, and the post must be sent twice and
// held once; and `call schellingaf_whoami` must print who it reads as and exit 0. Only an
// address on this machine is taken.
//
// Not part of `npm test`: test/bridge-waits.test.ts holds the bridge to each case there.
//
// The case line-separator answers on today's bridge. Run it on the bridge before commit
// 2648144, which read its input with readline, to see the post of 2 October 2026 that was
// never answered: three Parse errors with id null, and nothing sent to the service.
//
//   git show 2648144^:content/bridge.mjs > /tmp/old/bridge.mjs
//   git show 2648144^:content/sealed.mjs > /tmp/old/sealed.mjs
//   node scripts/bridge-waits.mjs line-separator --bridge /tmp/old/bridge.mjs
//
// Options:
//   --scale <n>          SCHELLINGAF_TIME_SCALE for the bridge, 0.001 to 1; 1 unless given
//   --cap <seconds>      how long a case waits for the answer; the call's deadline at the
//                        scale, 90 seconds times it, plus 2, unless given
//   --bridge <file>      the bridge to run; content/bridge.mjs unless given
//   --json               one JSON line per case instead of the table

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as signBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const SCALE = Number(opt("--scale", "1"));
/** A call's deadline at the scale, as the bridge reads it: CALL_MS. */
const DEADLINE_MS = 90_000 * (SCALE >= 0.001 && SCALE <= 1 ? SCALE : 1);
/** When a case cancels: well before the read it waits on reaches its headers limit. */
const CANCEL_MS = Math.min(1000, DEADLINE_MS / 2);
const CAP_MS = opt("--cap") === undefined ? DEADLINE_MS + 2000 : Number(opt("--cap")) * 1000;
const BRIDGE = resolve(opt("--bridge", join(ROOT, "content", "bridge.mjs")));
const JSON_OUT = args.includes("--json");
const { sha256, label, LABELS, fromHex, toHex } = await import(join(ROOT, "content", "sealed.mjs"));

// ── a KEY of the case's own, and its peer id as the bridge computes it ─────────

async function makeKey(dir) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const file = join(dir, "key.pem");
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  const peerId = toHex(await sha256(label(LABELS.agent), fromHex(Buffer.from(pub).toString("hex"), 32)));
  return { file, peerId };
}

// ── the fake service ──────────────────────────────────────────────────────────

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
};
const never = () => {}; // accepts the request and writes nothing, ever

function readBody(req) {
  return new Promise((ok) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
  });
}

/** What a healthy service answers, so a case changes only the one route it names. */
function healthy(peerId) {
  return {
    "GET /v1/me": (req, res) => json(res, 200, { peer_id: peerId, encryption_key: null }),
    "PUT /v1/me/encryption-key": (req, res) => json(res, 200, {}),
    "GET /v1/spaces/*": (req, res) => json(res, 200, { name: "fake-space", visibility: "public", space_id: "00".repeat(16) }),
    "POST /v1/keys/challenge": (req, res) => json(res, 503, { error: { code: "BUSY", message: "BUSY. Not in this case." } }),
    "POST /mcp": async (req, res, body) => {
      const m = JSON.parse(body);
      if (m.method === "tools/list") return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "schellingaf_post" }, { name: "schellingaf_read_space" }] } });
      json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
    },
  };
}

function route(routes, req) {
  const path = req.url.split("?")[0];
  return routes[`${req.method} ${path}`] ?? routes[`${req.method} ${path.replace(/^(\/v1\/spaces)\/[^/]+$/, "$1/*")}`];
}

// ── the cases ────────────────────────────────────────────────────────────────

const READ = { name: "schellingaf_read_space", arguments: { space: "fake-space" } };
const POST = { name: "schellingaf_post", arguments: { space: "fake-space", kind: "note", title: "t", body: "b" } };

const CASES = {
  "mcp-silent": {
    what: "/mcp accepts the request and never answers (no headers)",
    call: READ,
    routes: { "POST /mcp": never },
  },
  "mcp-headers-then-stall": {
    what: "/mcp sends 200 and JSON headers, then no body",
    call: READ,
    routes: { "POST /mcp": (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.flushHeaders(); } },
  },
  "mcp-sse-keepalive": {
    what: "/mcp opens an event stream, sends a comment every 5 s, never the result",
    call: READ,
    routes: {
      "POST /mcp": (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": open\n\n");
        const t = setInterval(() => res.write(": keep-alive\n\n"), 5000);
        res.on("close", () => clearInterval(t));
      },
    },
  },
  "mcp-sse-ends-without-result": {
    what: "/mcp streams one progress notification and ends the stream with no result",
    call: READ,
    routes: {
      "POST /mcp": (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}\n\n`);
      },
    },
  },
  "mcp-202": {
    what: "/mcp answers 202 Accepted to a request",
    call: READ,
    routes: { "POST /mcp": (req, res) => { res.writeHead(202); res.end(); } },
  },
  "mcp-empty-200": {
    what: "/mcp answers 200 with an empty JSON body",
    call: READ,
    routes: { "POST /mcp": (req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": 0 }); res.end(); } },
  },
  "mcp-wrong-id": {
    what: "/mcp answers a result for another id",
    call: READ,
    routes: { "POST /mcp": (req, res) => json(res, 200, { jsonrpc: "2.0", id: "not-this-one", result: { content: [] } }) },
  },
  "mcp-close-after-receive": {
    what: "/mcp reads the request and closes the connection (control: answered at once)",
    call: READ,
    routes: { "POST /mcp": (req, res) => req.socket.destroy() },
  },
  "mcp-close-after-headers": {
    what: "/mcp sends headers and part of the body, then closes (control: answered at once)",
    call: READ,
    routes: {
      "POST /mcp": (req, res) => {
        res.writeHead(200, { "content-type": "application/json", "content-length": 1000 });
        res.write('{"jsonrpc":"2.0",');
        setTimeout(() => req.socket.destroy(), 200);
      },
    },
  },
  "post-space-silent": {
    what: "a post: GET /v1/spaces/{name}, asked before /mcp, never answers",
    call: POST,
    env: { SCHELLINGAF_UNSIGNED: "1" },
    routes: { "GET /v1/spaces/*": never },
  },
  "post-space-silent-cancelled": {
    what: "the same, and the client cancels before the read times out: no answer, and the read before /mcp is closed",
    call: POST,
    cancelAfterMs: CANCEL_MS,
    waitsOn: "GET /v1/spaces/",
    env: { SCHELLINGAF_UNSIGNED: "1" },
    routes: { "GET /v1/spaces/*": never },
  },
  "post-space-429": {
    what: "a post: GET /v1/spaces/{name} answers 429, retry-after 1, every time",
    call: POST,
    env: { SCHELLINGAF_UNSIGNED: "1" },
    routes: { "GET /v1/spaces/*": (req, res) => json(res, 429, { error: { code: "RATE_LIMITED", message: "RATE_LIMITED. Slow down." } }, { "retry-after": "1" }) },
  },
  "post-publish-silent": {
    what: "a signed post waits on the start's publish: GET /v1/me never answers",
    call: POST,
    routes: { "GET /v1/me": never },
  },
  "post-publish-silent-again": {
    what: "the same post sent again with the same idempotency key after the first was cancelled",
    call: { ...POST, arguments: { ...POST.arguments, idempotency_key: "repro-1" } },
    cancelAfterMs: CANCEL_MS,
    resend: true,
    routes: { "GET /v1/me": never },
  },
  "mint-silent": {
    what: "no token yet: POST /v1/keys/challenge never answers, so every call waits on the one mint",
    call: READ,
    noToken: true,
    routes: { "POST /v1/keys/challenge": never },
  },
  "toolset-list-silent": {
    what: "SCHELLINGAF_TOOLS set: the bridge's own tools/list never answers, so every call waits on it",
    call: READ,
    env: { SCHELLINGAF_TOOLS: "research" },
    routes: { "POST /mcp": (req, res, body) => (JSON.parse(body).method === "tools/list" ? undefined : json(res, 200, { jsonrpc: "2.0", id: JSON.parse(body).id, result: { content: [] } })) },
  },
  "line-separator": {
    what: "a call whose words hold U+2028 and U+2029, as JSON carries them unescaped",
    call: { ...POST, arguments: { ...POST.arguments, body: "one two three" } },
    env: { SCHELLINGAF_UNSIGNED: "1" },
    routes: {},
  },
};

// ── running one case ─────────────────────────────────────────────────────────

async function runCase(name, c) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-waits-"));
  const key = await makeKey(dir);
  const routes = { ...healthy(key.peerId), ...c.routes };
  const seen = [];
  const closed = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    res.on("close", () => {
      if (!res.writableEnded) closed.push(`${req.method} ${req.url.split("?")[0]}`);
    });
    seen.push(`${req.method} ${req.url.split("?")[0]}${req.url.startsWith("/mcp") ? ` ${JSON.parse(body).method}` : ""}`);
    const handler = route(routes, req);
    if (!handler) return json(res, 404, { error: { code: "NOT_FOUND", message: "NOT_FOUND." } });
    await handler(req, res, body);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const env = {
    PATH: process.env.PATH, HOME: dir,
    SCHELLINGAF_API: origin,
    SCHELLINGAF_KEY_FILE: key.file,
    SCHELLINGAF_TIME_SCALE: String(SCALE),
    ...(c.noToken ? {} : { SCHELLINGAF_TOKEN: "fake-token-for-a-local-fake-service" }),
    ...(c.env ?? {}),
  };
  const child = spawn(process.execPath, [BRIDGE], { env, cwd: dir });
  const out = [];
  const err = [];
  let buffered = "";
  const started = Date.now();
  const id = 7;
  const answer = new Promise((ok) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        out.push(line);
        try {
          const m = JSON.parse(line);
          if (m.id === id) ok({ ms: Date.now() - started, message: m });
        } catch {}
      }
    });
    child.on("exit", () => ok(null));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => err.push(d));

  const request = { jsonrpc: "2.0", id, method: "tools/call", params: c.call };
  // JSON.stringify leaves U+2028 and U+2029 unescaped, as an MCP client's writer does.
  child.stdin.write(JSON.stringify(request) + "\n");
  if (c.cancelAfterMs) {
    // Cancelled once the service has the read it waits on, or after cancelAfterMs.
    const cancel = () => {
      clearInterval(watch);
      clearTimeout(latest);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }) + "\n");
      if (c.resend) child.stdin.write(JSON.stringify(request) + "\n");
    };
    const watch = setInterval(() => {
      if (seen.some((r) => r.startsWith(c.waitsOn ?? "never"))) cancel();
    }, 5);
    const latest = setTimeout(cancel, c.cancelAfterMs);
  }
  const capped = new Promise((ok) => setTimeout(() => ok("cap"), CAP_MS));
  const got = await Promise.race([answer, capped]);

  child.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });

  const result = got === "cap" || got === null
    ? { case: name, answered: false, seconds: CAP_MS / 1000, held: `more than ${CAP_MS / 1000} s` }
    : { case: name, answered: true, seconds: Math.round(got.ms / 100) / 10, said: (got.message.error?.message ?? got.message.result?.content?.[0]?.text ?? "").slice(0, 160) };
  // As expected: answered within the call's deadline, or, cancelled, not answered and the
  // read it waited on closed.
  result.expected = c.cancelAfterMs && !c.resend
    ? !result.answered && closed.some((r) => r.startsWith("GET /v1/spaces/"))
    : result.answered && result.seconds * 1000 <= DEADLINE_MS + 500;
  result.what = c.what;
  result.requests = seen;
  result.stdout = out.filter((l) => !l.includes(`"id":${id}`)).map((l) => l.slice(0, 160));
  result.stderr = err.join("").trim().split("\n").filter(Boolean).slice(0, 4);
  return result;
}

// ── against a running product ───────────────────────────────────────────────

/** A post whose answer a proxy drops after the product wrote it: sent twice by the bridge,
 *  under one idempotency key, and held once. Answers whether it was. */
async function stackCase(origin) {
  const url = new URL(origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error(`--stack takes a product on this machine, not ${origin}`);
  const dir = mkdtempSync(join(tmpdir(), "bridge-waits-stack-"));
  const key = await makeKey(dir);
  // A token minted straight from the product: the bridge goes through the proxy, whose
  // address no challenge names.
  const post = async (path, body, bearer) => {
    const res = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const privateKey = createPrivateKey(readFileSync(key.file));
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const challenge = (await post("/v1/keys/challenge", { public_key: publicKey })).body;
  const preimage = Buffer.concat([Buffer.from("agent-state:token-challenge:v1"), Buffer.from([0]), Buffer.from(challenge.audience), Buffer.from([0]), Buffer.from(challenge.challenge, "hex")]);
  const verified = (await post("/v1/keys/verify", { public_key: publicKey, challenge: challenge.challenge, signature: signBytes(null, preimage, privateKey).toString("hex"), label: "bridge-waits" })).body;
  const token = verified.token;

  // The proxy: every request passed on, but the first post's answer read whole and dropped.
  const space = `bridge-waits-${process.pid}`;
  let posts = 0;
  const proxy = createServer(async (req, res) => {
    const body = await readBody(req);
    const ahead = await fetch(`${origin}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k))),
      ...(["GET", "HEAD"].includes(req.method) ? {} : { body }),
    });
    const answer = Buffer.from(await ahead.arrayBuffer());
    let rpc = null;
    try {
      rpc = req.url.startsWith("/mcp") ? JSON.parse(body) : null;
    } catch {}
    if (rpc?.method === "tools/call" && rpc.params?.name === "schellingaf_post" && rpc.params?.arguments?.space === space && ++posts === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(ahead.status, { "content-type": ahead.headers.get("content-type") ?? "application/json" });
    res.end(answer);
  });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  const child = spawn(process.execPath, [BRIDGE], {
    env: { PATH: process.env.PATH, HOME: dir, SCHELLINGAF_API: `http://127.0.0.1:${proxy.address().port}`, SCHELLINGAF_KEY_FILE: key.file, SCHELLINGAF_TOKEN: token },
    cwd: dir,
  });
  let buffered = "";
  const answers = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const m = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      answers.get(m.id)?.(m);
    }
  });
  let next = 0;
  const ask = (params) => new Promise((ok) => {
    const id = ++next;
    answers.set(id, ok);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }) + "\n");
  });
  try {
    const made = await ask({ name: "schellingaf_space_control", arguments: { action: "create", name: space, title: "a post whose answer is dropped once", categories: ["general"] } });
    if (made.result?.isError) throw new Error(`could not make ${space}: ${made.result.content[0].text}`);
    const posted = await ask({ name: "schellingaf_post", arguments: { space, kind: "obs", title: "its answer was dropped once", body: "held once" } });
    const read = await fetch(`${origin}/v1/spaces/${space}/posts`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
    const held = read.items?.length ?? 0;
    const ok = !posted.result?.isError && posts === 2 && held === 1;
    console.log(`stack-resend                   ${ok ? "as expected" : "NOT AS EXPECTED"}: sent ${posts} times, held ${held} times`);
    console.log(`  said: ${(posted.result?.content?.[0]?.text ?? posted.error?.message ?? "").slice(0, 160)}`);
    // One tool from a shell, through the same proxy.
    const called = await new Promise((ok) => {
      const one = spawn(process.execPath, [BRIDGE, "call", "schellingaf_whoami"], { env: { PATH: process.env.PATH, HOME: dir, SCHELLINGAF_API: `http://127.0.0.1:${proxy.address().port}`, SCHELLINGAF_KEY_FILE: key.file, SCHELLINGAF_TOKEN: token }, cwd: dir });
      let out = "";
      one.stdout.on("data", (d) => (out += d));
      one.on("exit", (code) => ok({ code, out }));
    });
    const callOk = called.code === 0 && called.out.startsWith(`reading as ${key.peerId}`);
    console.log(`stack-call                     ${callOk ? "as expected" : "NOT AS EXPECTED"}: exit ${called.code}, ${called.out.split("\n")[0].slice(0, 100)}`);
    return ok && callOk;
  } finally {
    child.kill("SIGKILL");
    proxy.closeAllConnections();
    proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

if (opt("--stack") !== undefined) process.exit((await stackCase(opt("--stack"))) ? 0 : 1);

if (args.includes("--list")) {
  for (const [name, c] of Object.entries(CASES)) console.log(`${name.padEnd(30)} ${c.what}`);
  process.exit(0);
}
const named = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--cap", "--bridge", "--scale", "--stack"].includes(args[i - 1])));
const chosen = named.length ? named : Object.keys(CASES);
for (const n of chosen) if (!CASES[n]) throw new Error(`no case ${n}: --list names them`);
const results = await Promise.all(chosen.map((n) => runCase(n, CASES[n])));
for (const r of results) {
  if (JSON_OUT) {
    console.log(JSON.stringify(r));
    continue;
  }
  console.log(`${r.case.padEnd(30)} ${r.answered ? `answered in ${r.seconds} s` : `NO ANSWER, held ${r.held}`}${r.expected ? "" : "  NOT AS EXPECTED"}`);
  console.log(`  ${r.what}`);
  if (r.said) console.log(`  said: ${r.said}`);
  console.log(`  requests: ${r.requests.join(", ") || "none"}`);
  if (r.stdout.length) console.log(`  other stdout: ${r.stdout.join(" | ")}`);
  if (r.stderr.length) console.log(`  stderr: ${r.stderr.join(" | ")}`);
}
if (results.some((r) => !r.expected)) process.exit(1);
