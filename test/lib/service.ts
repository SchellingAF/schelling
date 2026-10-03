// The service a test file talks to, built once per file on the file's own
// database (../helpers.ts), and the requests nearly every test sends.
//
//   import { useService, app, db, fixture, call, agent, type Agent } from "./lib/service.ts";
//
//   useService("spaces");                          // the label names the cloned database
//   useService("keys", { passkeys: { rpId, origins } });    // any Config field, overridden
//
//   const a = await agent();                       // a new KEY: token, peerId, privateKey, publicKey
//   const out = await call("POST", "/v1/spaces", a, { name: "x", title: "T" });
//   out.status; out.body; out.headers              // body is the parsed JSON, null when empty
//
//   const k = await agent({ encryptionKey: true }); // also publishes the encryption key its
//                                                   // seed makes, as the bridge does: k.enc
//   const { status, message } = await connector("tools/call", { name, arguments: args }, a);
//
// useService registers a before hook that clones the database, opens the
// service's pools and builds the app, and an after hook that waits for that build,
// whether it passed or failed, and then closes them. The wait matters when no test
// is selected (a --test-name-pattern matching none): node:test then runs the after
// hook without waiting for the before hook, and pools opened after it would keep the
// file running. A file on its own setup opens through setUp() in ../helpers.ts for
// the same reason.
// `app`, `db`, `fixture` and `config` are live bindings that hook fills in: read
// them inside tests and hooks, never at the top level of a file. Tests and the
// hooks inside a describe run once the service is built. A file's own top-level
// before hook does not wait for it, because node:test starts every top-level
// before hook as soon as it is registered, so one that uses the service awaits
// the promise useService returns:
//
//   const ready = useService("permissions");
//   before(async () => { await ready; owner = await agent(); });
//
// Top-level after hooks run in turn, in the order they were registered. One
// service per file; node --test gives each file a process of its own.
//
// A second app on the same database is createApp({ ...config, readOnly: true }, db)
// or createApp(testConfig(fixture.name, {...}), db); call and connector take it as
// their last argument, agent as { on }. send and read are the two halves of call,
// for a file whose requests are shaped differently. passkey and passkeyAssertion,
// a software authenticator, are re-exported from ./passkey.ts, where a file with no
// service imports them.

import { before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { cloneDatabase, filed, filedTool, type Fixture } from "../helpers.ts";
import { API_PASSWORD, PORT } from "../bootstrap.ts";
import { openDb, type Db } from "../../src/db/sql.ts";
import { createApp } from "../../src/http/app.ts";
import type { Config } from "../../src/config.ts";
import { challengePreimage } from "../../src/domain/protocol.ts";
import * as sealed from "../../content/sealed.mjs";

export { passkey, passkeyAssertion, type Passkey, type PasskeyAlgorithm, type Prompt } from "./passkey.ts";

export type App = ReturnType<typeof createApp>;

/** An encryption key pair, as content/sealed.mjs makes one. */
export type EncryptionKey = { sk: Uint8Array; pk: Uint8Array };

/**
 * A registered KEY: its token, its peer id, and its key pair (the public half as
 * hex), and its published encryption key when agent() was asked for one.
 */
export type Agent = { token: string; peerId: string; privateKey: KeyObject; publicKey: string; enc?: EncryptionKey };

/** Who a request comes from: an Agent (or anything with a token), a bare token, or nobody. */
export type Caller = { token: string } | string | null | undefined;

export type Reply = { status: number; body: any; headers: Headers };

/** The host a test service answers as, unless the file names another. */
export const HOST = "api.schellingaf.test";

/** The configuration a test service starts from. `publicOrigin` follows `apiHost` unless given. */
export function testConfig(database: string, overrides: Partial<Config> = {}): Config {
  const apiHost = overrides.apiHost ?? HOST;
  return {
    apiHost,
    publicOrigin: `https://${apiHost}`,
    challengeKey: Buffer.from("a-test-challenge-key-not-a-secret", "utf8"),
    readOnly: false,
    logDir: null,
    welcomeSpace: null,
    db: { host: "127.0.0.1", port: PORT, database, username: "schellingaf_api", password: API_PASSWORD },
    ...overrides,
  };
}

export let fixture: Fixture;
export let config: Config;
export let db: Db;
export let app: App;

let used = false;

/** Registers this file's service: built before its tests, closed after them. Settles when it is built. */
export function useService(label: string, overrides: Partial<Config> = {}): Promise<void> {
  assert.equal(used, false, "useService builds one service per test file");
  used = true;
  const built = Promise.withResolvers<void>();
  // The hook reports a failure; a file that awaits the promise meets it too.
  built.promise.catch(() => {});
  before(async () => {
    try {
      fixture = await cloneDatabase(label);
      config = testConfig(fixture.name, overrides);
      db = openDb(config);
      app = createApp(config, db);
      built.resolve();
    } catch (error) {
      built.reject(error);
      throw error;
    }
  });
  // With no test selected (a --test-name-pattern matching none of the file's) node:test
  // starts the before hook and runs this one without waiting for it, and the pools the
  // before hook then opened kept the file running until it was killed. So this waits
  // for the service to be built, or to have failed, and closes what was opened.
  after(async () => {
    await built.promise.catch(() => {});
    await db?.end();
    await fixture?.end();
  });
  return built.promise;
}

function bearerOf(who: Caller): string | null {
  return typeof who === "string" ? who || null : who ? who.token : null;
}

function requireApp(on: App): App {
  if (on === undefined) {
    throw new Error("no service yet: a top-level before hook awaits the promise useService returns");
  }
  return on;
}

/**
 * One request to `on`: a bearer when `who` is given, and the payload as a JSON
 * body with its content type when there is one. `headers` go last, so they
 * replace either.
 */
export async function send(
  on: App,
  method: string,
  path: string,
  who?: Caller,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const token = bearerOf(who);
  return requireApp(on).request(path, {
    method,
    headers: {
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

/** The answer read whole: its status, its headers, and its body parsed as JSON (null when empty). */
export async function read(res: Response): Promise<Reply> {
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
}

/** A request as tests send it: the body passes through filed(), so a new SPACE has a category. */
export async function call(method: string, path: string, who?: Caller, payload?: unknown, on: App = app): Promise<Reply> {
  return read(await send(on, method, path, who, filed(method, path, payload)));
}

/**
 * A new KEY, registered through /v1/keys/challenge and /v1/keys/verify as an
 * agent does it. `on` registers it with a second app; `encryptionKey` also
 * publishes the encryption key the KEY's own seed makes, as the bridge does on
 * its first run.
 */
export async function agent(options: { on?: App; encryptionKey?: boolean } = {}): Promise<Agent> {
  const on = options.on ?? app;
  const pair = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const ch = (await call("POST", "/v1/keys/challenge", null, { public_key: publicKey }, on)).body;
  const signature = sign(null, challengePreimage(config.apiHost, Buffer.from(ch.challenge, "hex")), pair.privateKey).toString("hex");
  const out = await call("POST", "/v1/keys/verify", null, { public_key: publicKey, challenge: ch.challenge, signature }, on);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const registered: Agent = { token: out.body.token, peerId: ch.peer_id, privateKey: pair.privateKey, publicKey };
  if (options.encryptionKey) registered.enc = await publishEncryptionKey(registered, on);
  return registered;
}

async function publishEncryptionKey(a: Agent, on: App): Promise<EncryptionKey> {
  const peerId = new Uint8Array(Buffer.from(a.peerId, "hex"));
  const seed = Buffer.from(a.privateKey.export({ format: "jwk" }).d!, "base64url");
  const enc = await sealed.encryptionKey(new Uint8Array(seed), peerId);
  const statement = sealed.statementBytes(peerId, enc.pk);
  const signature = sign(null, Buffer.from(sealed.signedBytes(sealed.LABELS.encryptionKey, statement)), a.privateKey).toString("hex");
  const put = await call("PUT", "/v1/me/encryption-key", a.token, { statement: sealed.toB64u(statement), alg: "ed25519", signature }, on);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  return enc;
}

/**
 * How many requests the app answered while `during` ran whose method and path match, its
 * own in-process ones included: how a test sees a tool make a read, or make none.
 */
export async function requestsDuring(match: (method: string, path: string) => boolean, during: () => Promise<unknown>): Promise<number> {
  const original = app.request;
  let seen = 0;
  app.request = ((input: string | Request | URL, init?: RequestInit, ...rest: unknown[]) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const url = input instanceof Request ? input.url : String(input);
    if (match(method.toUpperCase(), new URL(url, "http://localhost").pathname)) seen++;
    return (original as (...args: unknown[]) => unknown).call(app, input, init, ...rest);
  }) as typeof app.request;
  try {
    await during();
  } finally {
    app.request = original;
  }
  return seen;
}

let rpcId = 0;

/**
 * One JSON-RPC request to the connector at /mcp, in process, as a client sends
 * it, and the message that answers it. A streamable-HTTP server may answer as an
 * event stream; the message is then its data line.
 */
export async function connector(method: string, params: unknown, who?: Caller, on: App = app): Promise<{ status: number; message: any }> {
  const token = bearerOf(who);
  const res = await requireApp(on).request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: method === "tools/call" ? filedTool(params) : params }),
  });
  const text = await res.text();
  const message = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").find((line) => line.startsWith("data:"))!.slice(5))
    : JSON.parse(text);
  return { status: res.status, message };
}
