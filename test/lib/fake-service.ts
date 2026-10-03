// A fake service on a free port of this machine, and the bridge run against it as a
// client runs it: what test/bridge-waits.test.ts holds the bridge to when the service
// answers late, wrongly or never. The fakes are the cases of scripts/bridge-waits.mjs.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, label, LABELS, fromHex, toHex } from "../../content/sealed.mjs";

/** The bridge under test: the source, or another copy named by BRIDGE_UNDER_TEST, which is
 *  how a test is shown failing on an older bridge. */
export const BRIDGE = process.env.BRIDGE_UNDER_TEST ?? new URL("../../content/bridge.mjs", import.meta.url).pathname;

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => unknown;

/** A KEY of its own in a folder of its own, and its peer id as the bridge computes it. */
export async function makeKey(): Promise<{ dir: string; file: string; peerId: string; publicKeyHex: string }> {
  const dir = mkdtempSync(join(tmpdir(), "bridge-waits-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const file = join(dir, "key.pem");
  writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const publicKeyHex = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const peerId: string = toHex(await sha256(label(LABELS.agent), fromHex(publicKeyHex, 32)!));
  return { dir, file, peerId, publicKeyHex };
}

export const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...headers });
  res.end(text);
};

/** Accepts the request and writes nothing, ever. */
export const never: Handler = () => {};

/** What a healthy service answers, so a case changes only the routes it names. */
export function healthy(peerId: string): Record<string, Handler> {
  return {
    "GET /v1/me": (_req, res) => json(res, 200, { peer_id: peerId, encryption_key: null }),
    "PUT /v1/me/encryption-key": (_req, res) => json(res, 200, {}),
    "GET /v1/spaces/*": (_req, res) => json(res, 200, { name: "fake-space", visibility: "public", space_id: "00000000-0000-4000-8000-000000000000" }),
    "GET /v1/capabilities": (_req, res) => json(res, 200, { protocol: {} }),
    "POST /v1/keys/challenge": (_req, res) => json(res, 503, { error: { code: "BUSY", message: "BUSY. Not in this case." } }),
    "POST /mcp": (_req, res, body) => {
      const m = JSON.parse(body);
      if (m.id === undefined || m.method === undefined) return void res.writeHead(202).end();
      if (m.method === "tools/list") {
        return json(res, 200, { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "schellingaf_post" }, { name: "schellingaf_read_space" }, { name: "schellingaf_join" }, { name: "schellingaf_whoami" }] } });
      }
      json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
    },
  };
}

export type Fake = {
  origin: string;
  /** Every request, as "METHOD /path", with " <rpc method>" after /mcp. */
  seen: string[];
  /** Every request's body, by "METHOD /path". */
  bodies: { route: string; body: string; headers: IncomingMessage["headers"] }[];
  /** Requests whose connection closed before the service answered, by "METHOD /path". */
  closed: string[];
  routes: Record<string, Handler>;
  close(): Promise<void>;
};

/** A service on a free port answering by `routes`, each "METHOD /path", and
 *  "GET /v1/spaces/*" for any one SPACE. */
export async function fakeService(routes: Record<string, Handler>): Promise<Fake> {
  const seen: string[] = [];
  const bodies: Fake["bodies"] = [];
  const closed: string[] = [];
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const body = Buffer.concat(parts).toString("utf8");
    let rpc = "";
    if (path === "/mcp") {
      try {
        rpc = ` ${JSON.parse(body).method}`;
      } catch {
        rpc = " (not JSON)";
      }
    }
    seen.push(`${req.method} ${path}${rpc}`);
    bodies.push({ route: `${req.method} ${path}`, body, headers: req.headers });
    res.on("close", () => {
      if (!res.writableEnded) closed.push(`${req.method} ${path}`);
    });
    const handler = routes[`${req.method} ${path}`] ?? routes[`${req.method} ${path.replace(/^(\/v1\/spaces)\/[^/]+$/, "$1/*")}`];
    if (!handler) return json(res, 404, { error: { code: "NOT_FOUND", message: "NOT_FOUND. Not in this fake." } });
    await handler(req, res, body);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, seen, bodies, closed, routes,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

/** Every line any bridge in this process wrote on stdout, for the check that none has an id
 *  a client cannot match. */
export const everyLine: string[] = [];

export type Running = {
  child: ChildProcessWithoutNullStreams;
  /** Each stdout line, parsed. */
  out: any[];
  err: () => string;
  send(message: unknown): void;
  /** The first message `match` accepts, waiting up to `ms`; null when none came. */
  waitFor(match: (m: any) => boolean, ms?: number): Promise<any>;
  /** The answer for an id, waiting up to `ms`; null when none came. */
  answerTo(id: unknown, ms?: number): Promise<any>;
  exited: Promise<number | null>;
  stop(): Promise<void>;
};

/** The bridge, started with these variables over a clean environment, and these arguments. */
export function runBridge(env: Record<string, string>, args: string[] = [], cwd?: string): Running {
  const child = spawn(process.execPath, [BRIDGE, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    ...(cwd ? { cwd } : {}),
  }) as ChildProcessWithoutNullStreams;
  const out: any[] = [];
  let err = "";
  let buffered = "";
  let wake: (() => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      everyLine.push(line);
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ unparsed: line });
      }
      for (const w of wake.splice(0)) w();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    err += d;
    for (const w of wake.splice(0)) w();
  });
  const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
  const waitFor = async (match: (m: any) => boolean, ms = 5000) => {
    const until = Date.now() + ms;
    for (;;) {
      const found = out.find(match);
      if (found) return found;
      const left = until - Date.now();
      if (left <= 0 || child.exitCode !== null) return out.find(match) ?? null;
      await new Promise<void>((ok) => {
        wake.push(ok);
        setTimeout(ok, Math.min(left, 50));
      });
    }
  };
  return {
    child, out, exited, waitFor,
    err: () => err,
    send: (message) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`),
    answerTo: (id, ms) => waitFor((m) => m.id === id && m.method === undefined, ms),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

/** Waits until `check` holds, asking every 20 ms, or `ms` passes; says whether it held. */
export async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  return check();
}
