// Upload authorizations: POST /v1/spaces/{name}/uploads asks for one per file a KEY may not
// attach yet, and the file PUT takes it in place of a token, once, for that file and SPACE
// alone (migrations/0146_exact_uploads.sql, src/http/files.ts, src/http/auth.ts). And the
// connector's upload true, which hands an agent a curl command and posts once every file is
// held. A real socket serves the service here, so the command an agent is given runs as given.

import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { useService, app, fixture, call, agent, connector, type Agent } from "./lib/service.ts";
import type { Config } from "../src/config.ts";
import { ATTACHMENT_LIMITS } from "../src/surface/vocabulary.ts";
import { ERRORS } from "../src/db/errors.ts";
import { prune } from "../src/db/prune.ts";
import { db } from "./lib/service.ts";
import { SECRET_NAMES, PEM_LOOK, PEM_PRIVATE } from "../src/domain/secret-files.ts";
import * as sealed from "../content/sealed.mjs";

const overrides: Partial<Config> = {};
let server: Server;
let origin: string;
before(async () => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
  process.env.GLOBAL_READ_WAIT_MS = "60000";
  // The service on a real socket, so a printed curl command reaches it; publicOrigin is its
  // address, read when the service is built below.
  server = createServer((req, res) => getRequestListener(app.fetch)(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  overrides.publicOrigin = origin;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
const ready = useService("uploads", overrides);

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const hexOf = (peer: string) => Buffer.from(peer, "hex");

let n = 0;
async function space(owner: Agent, extra: Record<string, unknown> = {}): Promise<string> {
  const name = `uploads-${process.pid}-${n++}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Uploads", visibility: "public", ...extra });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return name;
}
async function member(owner: Agent, name: string, who: Agent, role: string) {
  const out = await call("PUT", `/v1/spaces/${name}/members/${who.peerId}`, owner.token, { role });
  assert.equal(out.status, 200, JSON.stringify(out.body));
}

type Raw = { status: number; text: string; body: any; headers: Headers };
async function raw(res: Response): Promise<Raw> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, text, body, headers: res.headers };
}

/** An upload as curl sends it: the raw bytes with their length, under `authorization`. */
async function put(authorization: string | null, name: string, content: Uint8Array | string, address?: string, headers: Record<string, string> = {}): Promise<Raw> {
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return raw(await app.request(`/v1/spaces/${name}/files/${address ?? sha(body)}`, {
    method: "PUT",
    headers: { "content-length": String(body.length), ...(authorization ? { authorization } : {}), ...headers },
    body,
  }));
}

/** Authorizations asked for, as a KEY asks over HTTPS. */
const ask = (who: Agent, name: string, hashes: unknown) => call("POST", `/v1/spaces/${name}/uploads`, who.token, { sha256: hashes });

/** One authorization for one file, and its Authorization header. */
async function grantFor(who: Agent, name: string, content: string | Uint8Array): Promise<string> {
  const out = await ask(who, name, [sha(content)]);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.uploads[0].authorization as string;
}

/** A shell command run to its end without blocking this process, which serves the service it calls. */
function shell(command: string, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

const secretOf = (authorization: string) => authorization.slice("Bearer ".length);
const grants = async (who: Agent) =>
  fixture.owner<{ grant_hash: Buffer; token_hash: Buffer; used_at: Date | null; uploaded: boolean }[]>`
    select grant_hash, token_hash, used_at, uploaded from schellingaf.file_upload_grants where peer_id = ${hexOf(who.peerId)}`;

async function tool(name: string, args: unknown, token: string) {
  const { message } = await connector("tools/call", { name, arguments: args }, token);
  assert.ok(message.result, JSON.stringify(message.error ?? message));
  return { isError: message.result.isError === true, text: (message.result.content?.[0]?.text ?? "") as string, data: message.result.structuredContent as any };
}

let owner: Agent;
before(async () => {
  await ready;
  owner = await agent();
});
beforeEach(async () => {
  if (owner) await fixture.setBucket(`peer:${owner.peerId}`, 60);
});

describe("asking for upload authorizations", () => {
  test("POST /uploads answers an authorization for a file not held and held true, with none, for one the caller may attach", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const shown = `shown ${n++}\n`;
    const absent = `absent ${n++}\n`;
    assert.equal((await put(`Bearer ${owner.token}`, name, shown)).status, 201);
    const posted = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: "x", attachments: [{ sha256: sha(shown), name: "s.txt", media_type: "text/plain" }] });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const out = await ask(writer, name, [sha(shown), sha(absent)]);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.deepEqual(Object.keys(out.body), ["space", "expires_at", "uploads"]);
    assert.equal(out.body.space, name);
    const lapse = Date.parse(out.body.expires_at) - Date.now();
    assert.ok(lapse > 14 * 60_000 && lapse <= 15 * 60_000, `${lapse}`);
    assert.deepEqual(out.body.uploads[0], { sha256: sha(shown), held: true });
    const made = out.body.uploads[1];
    assert.deepEqual(Object.keys(made), ["sha256", "held", "method", "url", "authorization"]);
    assert.equal(made.held, false);
    assert.equal(made.method, "PUT");
    assert.equal(made.url, `${origin}/v1/spaces/${name}/files/${sha(absent)}`);
    assert.match(made.authorization, /^Bearer schellingaf_upload_[0-9a-f]{64}$/);
    // Kept as its hash alone, bound to the token that asked: no column holds the secret.
    const rows = await fixture.owner<Record<string, unknown>[]>`
      select * from schellingaf.file_upload_grants where peer_id = ${hexOf(writer.peerId)}`;
    assert.equal(rows.length, 1);
    const secret = secretOf(made.authorization);
    assert.deepEqual(rows[0]!.grant_hash, createHash("sha256").update(secret).digest());
    assert.deepEqual(rows[0]!.token_hash, createHash("sha256").update(writer.token).digest());
    const dump = JSON.stringify(rows, (_k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v));
    assert.ok(!dump.includes(secret) && !dump.includes(secret.slice(-64)), "the secret is never kept");
    // Every file held: none made, and nothing spent.
    await fixture.setBucket(`peer:${writer.peerId}`, 0);
    const held = await ask(writer, name, [sha(shown)]);
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.deepEqual(held.body, { space: name, expires_at: null, uploads: [{ sha256: sha(shown), held: true }] });
  });

  test("an authorization never outlives the token that asked for it", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    await fixture.owner`update schellingaf.tokens set expires_at = now() + interval '5 minutes' where peer_id = ${hexOf(writer.peerId)}`;
    const [token] = await fixture.owner<{ expires_at: Date }[]>`select expires_at from schellingaf.tokens where peer_id = ${hexOf(writer.peerId)}`;
    const out = await ask(writer, name, [sha(`short ${n++}`)]);
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(Date.parse(out.body.expires_at), token!.expires_at.getTime());
    const [row] = await fixture.owner<{ expires_at: Date }[]>`select expires_at from schellingaf.file_upload_grants where peer_id = ${hexOf(writer.peerId)}`;
    assert.equal(row!.expires_at.getTime(), token!.expires_at.getTime());
  });

  test("a malformed list is refused before anything is read", async () => {
    const name = await space(owner);
    const h = sha("x");
    for (const bad of [[], "x", [h, h], [h.toUpperCase()], [1], Array.from({ length: 5 }, (_, i) => sha(String(i)))]) {
      const out = await ask(owner, name, bad);
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.detail, "sha256 is a list of 1 to 4 distinct sha256s, each 64 lowercase hex characters");
    }
    const extra = await call("POST", `/v1/spaces/${name}/uploads`, owner.token, { sha256: [h], name: "x" });
    assert.equal(extra.body.error.detail, "name is not a field here: send sha256 alone");
  });

  test("no authorization in a sealed SPACE, for a reader, for a no-role KEY in an open work space, or past peerWrites", async () => {
    const keeper = await agent({ encryptionKey: true });
    const sealedName = `uploads-sealed-${process.pid}-${n++}`;
    const spaceId = randomUUID();
    const container = sealed.spaceContainer(spaceId);
    const g1 = await sealed.newGeneration(container, 1);
    const me = new Uint8Array(hexOf(keeper.peerId));
    const lock = await sealed.sealLock({
      container, g: 1, recipient: me, sender: me, commitment: g1.commitment, secret: g1.secret, pkR: keeper.enc!.pk, skS: keeper.enc!.sk,
    });
    const made = await call("POST", "/v1/spaces", keeper.token, {
      name: sealedName, title: "Sealed", visibility: "sealed",
      sealed: { space_id: spaceId, commitment: Buffer.from(g1.commitment).toString("hex"), lock: Buffer.from(lock).toString("hex") },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal((await ask(keeper, sealedName, [sha("s")])).body.error.code, "SEALED_NO_FILES");
    assert.equal((await grants(keeper)).length, 0);
    const name = await space(owner, { join_policy: "open" });
    const reader = await agent();
    await member(owner, name, reader, "reader");
    assert.equal((await ask(reader, name, [sha("r")])).body.error.code, "WRITE_DENIED");
    const stranger = await agent();
    assert.equal((await ask(stranger, name, [sha("r")])).body.error.code, "WRITE_DENIED");
    const writer = await agent();
    await member(owner, name, writer, "writer");
    await fixture.setBucket(`peer:${writer.peerId}`, 0);
    const limited = await ask(writer, name, [sha(`limited ${n++}`)]);
    assert.equal(limited.status, 429, JSON.stringify(limited.body));
    assert.equal(limited.body.error.code, "RATE_LIMITED");
    assert.equal((await grants(writer)).length, 0, "a refused ask keeps no authorization");
    for (const who of [reader, stranger]) assert.equal((await grants(who)).length, 0);
  });
});

describe("uploading with an authorization", () => {
  test("an authorization uploads its file once: 201 with today's body, then UPLOAD_EXPIRED; after 15 minutes UPLOAD_EXPIRED", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const content = `exact bytes ${n++}\n`;
    const authorization = await grantFor(writer, name, content);
    const first = await put(authorization, name, content);
    assert.equal(first.status, 201, first.text);
    assert.deepEqual(Object.keys(first.body), ["space", "sha256", "bytes", "pending_until"]);
    assert.equal(first.body.sha256, sha(content));
    const again = await put(authorization, name, content);
    assert.equal(again.status, 401, again.text);
    assert.equal(again.body.error.code, "UPLOAD_EXPIRED");
    assert.equal(again.body.error.message, ERRORS.UPLOAD_EXPIRED!.message);
    // The upload is the writer's own: it attaches by sha256, and asks for nothing more.
    assert.deepEqual((await ask(writer, name, [sha(content)])).body.uploads, [{ sha256: sha(content), held: true }]);
    const posted = await call("POST", `/v1/spaces/${name}/posts`, writer.token, { kind: "obs", body: "x", attachments: [{ sha256: sha(content), name: "e.txt", media_type: "text/plain" }] });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    // Fifteen minutes on.
    const later = `later ${n++}\n`;
    const old = await grantFor(writer, name, later);
    await fixture.owner`update schellingaf.file_upload_grants set expires_at = now() - interval '1 second' where grant_hash = ${createHash("sha256").update(secretOf(old)).digest()}`;
    assert.equal((await put(old, name, later)).body.error.code, "UPLOAD_EXPIRED");
  });

  test("an authorization for another sha256 or SPACE is refused before the body is read and stores nothing", async () => {
    const name = await space(owner);
    const other = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    await member(owner, other, writer, "writer");
    const content = `this file ${n++}\n`;
    const authorization = await grantFor(writer, name, content);
    const words = "this authorization uploads another file or to another SPACE: ask for one for this sha256 here";
    const wrongFile = await put(authorization, name, "another file\n");
    assert.equal(wrongFile.status, 400);
    assert.equal(wrongFile.body.error.detail, words);
    assert.equal(wrongFile.headers.get("connection"), "close");
    const wrongSpace = await put(authorization, other, content);
    assert.equal(wrongSpace.body.error.detail, words);
    const [kept] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.file_uploads where uploader_id = ${hexOf(writer.peerId)}`;
    assert.equal(kept!.n, 0);
    // Refused before its body: still usable.
    assert.equal((await put(authorization, name, content)).status, 201);
  });

  test("a refusal before the body leaves the authorization usable; a body whose hash differs uses it up", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const content = `checked ${n++}\n`;
    const authorization = await grantFor(writer, name, content);
    // Content-Length missing, an encoding, too large: each refused before the body is read.
    const chunked = await raw(await app.request(`/v1/spaces/${name}/files/${sha(content)}`, {
      method: "PUT", headers: { authorization, "transfer-encoding": "chunked" }, body: content,
    }));
    assert.equal(chunked.status, 400, chunked.text);
    assert.equal((await put(authorization, name, content, undefined, { "content-encoding": "gzip" })).status, 400);
    const big = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1, 0x61);
    const large = await put(authorization, name, big, sha(content));
    assert.equal(large.status, 413, large.text);
    assert.equal((await put(authorization, name, content, "not-a-hash")).status, 400);
    assert.equal((await grants(writer))[0]!.used_at, null, "nothing spent it");
    assert.equal((await put(authorization, name, content)).status, 201);

    // A wrong body: refused, and the authorization is gone, the right body included.
    const next = `next ${n++}\n`;
    const once = await grantFor(writer, name, next);
    const wrong = await put(once, name, "not the file\n", sha(next));
    assert.equal(wrong.status, 400, wrong.text);
    assert.match(wrong.body.error.detail, /^the SHA-256 of the body is [0-9a-f]{64}, not the sha256 in the address$/);
    const right = await put(once, name, next);
    assert.equal(right.body.error.code, "UPLOAD_EXPIRED");
    // Another is asked for, and works.
    assert.equal((await put(await grantFor(writer, name, next), name, next)).status, 201);
  });

  test("an authorization presented at another SPACE's name answers one refusal, whatever that SPACE is, and stays unused", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const content = `bound to its SPACE ${n++}\n`;
    const authorization = await grantFor(writer, name, content);
    // A private SPACE where the KEY writes, one where it has no role, a sealed one, none.
    const writes = await space(owner, { visibility: "private" });
    await member(owner, writes, writer, "writer");
    const stranger = await space(owner, { visibility: "private" });
    const keeper = await agent({ encryptionKey: true });
    const sealedName = `uploads-sealed-${process.pid}-${n++}`;
    const spaceId = randomUUID();
    const container = sealed.spaceContainer(spaceId);
    const g1 = await sealed.newGeneration(container, 1);
    const me = new Uint8Array(hexOf(keeper.peerId));
    const lock = await sealed.sealLock({ container, g: 1, recipient: me, sender: me, commitment: g1.commitment, secret: g1.secret, pkR: keeper.enc!.pk, skS: keeper.enc!.sk });
    const made = await call("POST", "/v1/spaces", keeper.token, {
      name: sealedName, title: "Sealed", visibility: "sealed",
      sealed: { space_id: spaceId, commitment: Buffer.from(g1.commitment).toString("hex"), lock: Buffer.from(lock).toString("hex") },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    await member(keeper, sealedName, writer, "writer").catch(() => {});
    const answers = [];
    for (const other of [writes, stranger, sealedName, `nowhere-${process.pid}-${n++}`]) {
      const out = await put(authorization, other, content);
      assert.equal(out.status, 400, `${other}: ${out.text}`);
      assert.equal(out.headers.get("connection"), "close");
      const { request_id: _id, ...rest } = out.body.error;
      answers.push(JSON.stringify(rest));
    }
    assert.equal(new Set(answers).size, 1, answers.join("\n"));
    assert.equal(JSON.parse(answers[0]!).detail, "this authorization uploads another file or to another SPACE: ask for one for this sha256 here");
    assert.equal((await grants(writer))[0]!.used_at, null, "still unused");
    assert.equal((await put(authorization, name, content)).status, 201);
  });

  test("an authorization never carries a private key", async () => {
    const name = await space(owner);
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA ${n++}\n-----END OPENSSH PRIVATE KEY-----\n`;
    const out = await put(await grantFor(owner, name, pem), name, pem);
    assert.equal(out.status, 400, out.text);
    assert.equal(out.body.error.detail, `the file holds a PEM private key line in its first ${PEM_LOOK} bytes, and an upload authorization takes no private key`);
    // A KEY's own token uploads it as before.
    assert.equal((await put(`Bearer ${owner.token}`, name, pem)).status, 201);
  });

  test("an authorization is TOKEN_INVALID on GET of the file, on a post, at /v1/me and at /mcp", async () => {
    const name = await space(owner);
    const content = `bearer ${n++}\n`;
    const authorization = await grantFor(owner, name, content);
    assert.equal((await put(authorization, name, content)).status, 201);
    const fresh = await grantFor(owner, name, `unused ${n++}\n`);
    const at = (method: string, path: string, body?: unknown) =>
      Promise.resolve(app.request(path, { method, headers: { authorization: fresh, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).then(raw);
    for (const [method, path, body] of [
      ["GET", `/v1/spaces/${name}/files/${sha(content)}`],
      ["HEAD", `/v1/spaces/${name}/files/${sha(content)}`],
      ["POST", `/v1/spaces/${name}/posts`, { kind: "obs", title: "x", body: "x" }],
      ["GET", "/v1/me"],
      ["PUT", "/v1/me/name", { name: "taken" }],
      ["PUT", `/v1/posts/00000000-0000-4000-8000-000000000000/hidden`],
      ["PUT", `/v1/blocks/${owner.peerId}`],
      ["PUT", `/v1/spaces/${name}/sealed/keepers`, {}],
      ["PUT", `/v1/spaces/${name}/members/${owner.peerId}`, { role: "writer" }],
      ["POST", `/v1/spaces/${name}/uploads`, { sha256: [sha(content)] }],
    ] as [string, string, unknown?][]) {
      const out = await at(method, path, body);
      assert.equal(out.status, 401, `${method} ${path}: ${out.text}`);
      if (method !== "HEAD") assert.equal(out.body.error.code, "TOKEN_INVALID", `${method} ${path}`);
    }
    const mcp = await tool("schellingaf_whoami", {}, secretOf(fresh));
    assert.match(mcp.text, /TOKEN_INVALID/);
    const connect = await app.request("/mcp/connect", {
      method: "POST",
      headers: { authorization: fresh, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.ok(connect.status === 401 || connect.status === 404, `/mcp/connect answered ${connect.status}`);
    // Still unused, and still its one file's.
    assert.equal((await grants(owner)).filter((g) => g.used_at === null).length >= 1, true);
  });

  test("an authorization dies with its token revoked or expired (UPLOAD_EXPIRED), its KEY blocked (KEY_BLOCKED), its membership removed (WRITE_DENIED)", async () => {
    const name = await space(owner);
    const fresh = async (role = "writer") => {
      const who = await agent();
      await member(owner, name, who, role);
      const content = `dies ${n++}\n`;
      return { who, content, authorization: await grantFor(who, name, content) };
    };
    const revoked = await fresh();
    await fixture.owner`update schellingaf.tokens set revoked_at = now() where peer_id = ${hexOf(revoked.who.peerId)}`;
    assert.equal((await put(revoked.authorization, name, revoked.content)).body.error.code, "UPLOAD_EXPIRED");
    const expired = await fresh();
    await fixture.owner`update schellingaf.tokens set expires_at = now() - interval '1 second' where peer_id = ${hexOf(expired.who.peerId)}`;
    assert.equal((await put(expired.authorization, name, expired.content)).body.error.code, "UPLOAD_EXPIRED");
    const blocked = await fresh();
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = ${hexOf(blocked.who.peerId)}`;
    assert.equal((await put(blocked.authorization, name, blocked.content)).body.error.code, "KEY_BLOCKED");
    const removed = await fresh();
    assert.equal((await call("DELETE", `/v1/spaces/${name}/members/${removed.who.peerId}`, owner.token)).status, 200);
    assert.equal((await put(removed.authorization, name, removed.content)).body.error.code, "WRITE_DENIED");
    const demoted = await fresh();
    await member(owner, name, demoted.who, "reader");
    assert.equal((await put(demoted.authorization, name, demoted.content)).body.error.code, "WRITE_DENIED");
    const stopped = await fresh();
    assert.equal((await call("PUT", `/v1/spaces/${name}/blocks/${stopped.who.peerId}`, owner.token)).status, 200);
    assert.equal((await put(stopped.authorization, name, stopped.content)).body.error.code, "WRITE_BLOCKED");
    // And the SPACE withheld after the authorization was made.
    const closed = await fresh();
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select s.space_id, 'malware', 'a test' from schellingaf.spaces s where s.name = ${name}`;
    assert.equal((await put(closed.authorization, name, closed.content)).body.error.code, "SPACE_CLOSED");
    await fixture.owner`update schellingaf.withheld_spaces set released_at = now() where space_id = (select space_id from schellingaf.spaces where name = ${name})`;
    // None stored a byte.
    const [kept] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.file_uploads u join schellingaf.spaces s on s.space_id = u.space_id
       where s.name = ${name}`;
    assert.equal(kept!.n, 0);
  });

  test("the token revoked while the body is in flight: UPLOAD_EXPIRED, and nothing stored", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const content = Buffer.from(`in flight ${n++}\n`.repeat(50));
    const authorization = await grantFor(writer, name, content);
    let reading!: () => void;
    const started = new Promise<void>((resolve) => (reading = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls++;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(content.subarray(0, 10)));
          reading();
          return;
        }
        await held;
        controller.enqueue(new Uint8Array(content.subarray(10)));
        controller.close();
      },
    });
    const pending = Promise.resolve(app.request(`/v1/spaces/${name}/files/${sha(content)}`, {
      method: "PUT", headers: { authorization, "content-length": String(content.length) }, body, duplex: "half",
    } as RequestInit)).then(raw);
    await started;
    await fixture.owner`update schellingaf.tokens set revoked_at = now() where peer_id = ${hexOf(writer.peerId)}`;
    release();
    const out = await pending;
    assert.equal(out.body?.error?.code, "UPLOAD_EXPIRED", out.text);
    const [kept] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.file_uploads where uploader_id = ${hexOf(writer.peerId)}`;
    assert.equal(kept!.n, 0);
  });

  test("an upload by authorization charges the KEY's daily bytes as a token upload does", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const key = `files:${writer.peerId}`;
    const content = "x".repeat(1000);
    assert.equal((await put(await grantFor(writer, name, content), name, content)).status, 201);
    const [after] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
    assert.ok(Math.abs(after!.tokens - (2 * 1024 * 1024 - 1000)) < 1, `${after!.tokens}`);
    // And refused past them, with the authorization left usable.
    await fixture.setBucket(key, 10);
    const more = "y".repeat(100);
    const authorization = await grantFor(writer, name, more);
    assert.equal((await put(authorization, name, more)).body.error.code, "RATE_LIMITED");
    await fixture.owner`delete from schellingaf.rate_buckets where key = ${key}`;
    assert.equal((await put(authorization, name, more)).status, 201);
  });

  test("an unknown authorization counts in the guess window", async () => {
    const name = await space(owner);
    const from = (i: number) => Promise.resolve(app.request(`/v1/spaces/${name}/files/${sha("g")}`, {
      method: "PUT",
      headers: { authorization: `Bearer schellingaf_upload_${sha(`guess ${i}`)}`, "content-length": "1", "x-forwarded-for": "203.0.113.231" },
      body: "g",
    })).then(raw);
    const first = await from(0);
    assert.equal(first.status, 401);
    assert.equal(first.body.error.code, "TOKEN_INVALID");
    let refused: Raw | null = null;
    for (let i = 1; i < 80 && refused === null; i++) {
      const out = await from(i);
      if (out.status === 429) refused = out;
    }
    assert.ok(refused, "an address that keeps guessing authorizations is never held");
    assert.equal(refused.body.error.code, "RATE_LIMITED");
  });

  test("two uploads at once with one authorization: one 201, one UPLOAD_EXPIRED", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    await fixture.setBucket(`peer:${writer.peerId}`, 60);
    const content = `raced ${n++}\n`;
    const authorization = await grantFor(writer, name, content);
    const both = await Promise.all([put(authorization, name, content), put(authorization, name, content)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 401], JSON.stringify(both.map((r) => r.body)));
    assert.equal(both.find((r) => r.status === 401)!.body.error.code, "UPLOAD_EXPIRED");
  });

  test("bytes the operator erased: the upload answers 201, the next ask says uploaded, with none, and the POST answers ATTACHMENT_NOT_FOUND", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const content = `erased ${n++}\n`;
    assert.equal((await put(`Bearer ${owner.token}`, name, content)).status, 201);
    const posted = await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: "x", attachments: [{ sha256: sha(content), name: "e.txt", media_type: "text/plain" }] });
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${posted.body.post_id}::uuid`;
    await fixture.owner`
      update schellingaf.space_files set content = null
       where sha256 = decode(${sha(content)}, 'hex') and space_id = (select space_id from schellingaf.spaces where name = ${name})`;
    assert.equal((await put(await grantFor(writer, name, content), name, content)).status, 201);
    const asked = await ask(writer, name, [sha(content)]);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.deepEqual(asked.body.uploads, [{ sha256: sha(content), held: false, uploaded: true }]);
    // Through the connector the call then posts, and is refused as a POST is.
    const out = await tool("schellingaf_post", { space: name, kind: "obs", body: "x", upload: true, attachments: [{ sha256: sha(content), name: "e.txt", media_type: "text/plain" }] }, writer.token);
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /^ATTACHMENT_NOT_FOUND\. /);
  });

  test("a hide or a withhold racing an attach by hash on two connections leaves the SPACE's total equal to the shown files", async () => {
    const name = await space(owner);
    const uploader = await agent();
    const writer = await agent();
    await member(owner, name, uploader, "writer");
    await member(owner, name, writer, "writer");
    for (let round = 0; round < 8; round++) {
      await fixture.setBucket(`peer:${owner.peerId}`, 60);
      await fixture.setBucket(`peer:${writer.peerId}`, 60);
      await fixture.setBucket(`peer:${uploader.peerId}`, 60);
      const content = Buffer.alloc(300 + round, 0x70 + round);
      assert.equal((await put(`Bearer ${uploader.token}`, name, content)).status, 201);
      const first = await call("POST", `/v1/spaces/${name}/posts`, uploader.token, { kind: "obs", body: "x", attachments: [{ sha256: sha(content), name: "r.bin", media_type: "application/octet-stream" }] });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      // Even rounds the owner hides the post; odd ones the operator withholds it.
      const takeAway = round % 2 === 0
        ? call("PUT", `/v1/posts/${first.body.post_id}/hidden`, owner.token).then((r) => r.status)
        : fixture.owner`
            insert into schellingaf.withheld (post_id, space_id, reason, note)
            select p.post_id, p.space_id, 'malware', 'a test' from schellingaf.posts p where p.post_id = ${first.body.post_id}::uuid`.then(() => 200);
      const [hid, cited] = await Promise.all([
        takeAway,
        call("POST", `/v1/spaces/${name}/posts`, writer.token, { kind: "obs", body: "y", attachments: [{ sha256: sha(content), name: "r.bin", media_type: "application/octet-stream" }] }),
      ]);
      assert.equal(hid, 200);
      assert.ok(cited.status === 201 || cited.body.error.code === "ATTACHMENT_NOT_FOUND", JSON.stringify(cited.body));
      const [t] = await fixture.owner<{ b: string; shown: string }[]>`
        select coalesce((select attached_bytes from schellingaf.space_file_totals where space_id = s.space_id), 0)::text as b,
               coalesce((select sum(f.bytes) from schellingaf.space_files f
                          where f.space_id = s.space_id and schellingaf.file_shown(f.space_id, f.sha256, null)), 0)::text as shown
          from schellingaf.spaces s where s.name = ${name}`;
      assert.equal(t!.b, t!.shown, `round ${round}`);
    }
  });

  test("the api role with no caller reads zero rows of file_upload_grants", async () => {
    await assert.rejects(fixture.api`select 1 from schellingaf.file_upload_grants`, /permission denied/);
  });

  test("the prune keeps a used authorization for the pending window and removes it after", async () => {
    const name = await space(owner);
    const content = `pruned ${n++}\n`;
    const authorization = await grantFor(owner, name, content);
    assert.equal((await put(authorization, name, content)).status, 201);
    const hash = createHash("sha256").update(secretOf(authorization)).digest();
    await prune(db);
    const [kept] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.file_upload_grants where grant_hash = ${hash}`;
    assert.equal(kept!.n, 1);
    await fixture.owner`update schellingaf.file_upload_grants set expires_at = now() - interval '25 hours' where grant_hash = ${hash}`;
    await prune(db);
    const [gone] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.file_upload_grants where grant_hash = ${hash}`;
    assert.equal(gone!.n, 0);
  });
});

describe("upload true at the connector", () => {
  test("schellingaf_post with upload true answers a command per missing file and posts nothing; running the command with curl and sending the same call posts", async () => {
    const name = await space(owner);
    const writer = await agent();
    await member(owner, name, writer, "writer");
    const dir = mkdtempSync(join(tmpdir(), "schellingaf-uploads-"));
    try {
      const tsv = Buffer.from(`box\tvalue\n1093\t7\n${"row\t1\n".repeat(2000)}${n++}\n`);
      const shown = `already here ${n++}\n`;
      writeFileSync(join(dir, "transcription.tsv"), tsv);
      assert.equal((await put(`Bearer ${owner.token}`, name, shown)).status, 201);
      assert.equal((await call("POST", `/v1/spaces/${name}/posts`, owner.token, { kind: "obs", body: "x", attachments: [{ sha256: sha(shown), name: "s.txt", media_type: "text/plain" }] })).status, 201);
      const args = {
        space: name, kind: "result", title: "Exact bytes, 2 files", body: "Both files, exact.",
        attachments: [
          { sha256: sha(shown), name: "s.txt", media_type: "text/plain" },
          { sha256: sha(tsv), name: "transcription.tsv", media_type: "text/tab-separated-values" },
        ],
        expect_sha256: [sha(shown), sha(tsv)],
        upload: true,
        idempotency_key: `upload-${n++}`,
      };
      const before = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.posts where author_id = ${hexOf(writer.peerId)}`;
      const asked = await tool("schellingaf_post", args, writer.token);
      assert.equal(asked.isError, false, asked.text);
      const lines = asked.text.split("\n");
      assert.equal(lines[0], `reading as ${writer.peerId}`);
      assert.equal(lines[1], "Not posted: 1 file to upload first. Run each command where the file is, with its path for FILE. Then send this call again unchanged within 24 hours: it attaches each uploaded file by sha256.");
      assert.equal(lines[2], 'attachments[1] "transcription.tsv":');
      assert.match(lines[3]!, new RegExp(`^curl -sS -T FILE -H 'Authorization: Bearer schellingaf_upload_[0-9a-f]{64}' ${origin}/v1/spaces/${name}/files/${sha(tsv)}$`));
      assert.match(lines[4]!, /^Each command uploads that one file once, until \d\d:\d\d:\d\dZ, and answers 201 with its sha256 and bytes\. A wrong file uses it up: call again for a new one\. The authorization is a credential: keep it out of posts\.$/);
      assert.equal(lines.length, 5);
      assert.deepEqual(asked.data.uploads.map((u: any) => u.held), [true, false]);
      const after = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.posts where author_id = ${hexOf(writer.peerId)}`;
      assert.equal(after[0]!.n, before[0]!.n, "nothing posted");

      // The command as given, FILE replaced by the path, run where the file is.
      const command = lines[3]!.replace(" FILE ", " transcription.tsv ");
      const ran = await shell(command, dir);
      assert.equal(ran.code, 0, ran.err);
      const answer = JSON.parse(ran.out);
      assert.equal(answer.sha256, sha(tsv));
      assert.equal(answer.bytes, tsv.length);
      // Run again: the authorization is used.
      const twice = await shell(command, dir);
      assert.equal(JSON.parse(twice.out).error.code, "UPLOAD_EXPIRED");

      const posted = await tool("schellingaf_post", args, writer.token);
      assert.equal(posted.isError, false, posted.text);
      assert.match(posted.text, /\nexpect_sha256: matched(\n|$)/);
      assert.deepEqual(posted.data.attachments.map((a: any) => a.sha256), [sha(shown), sha(tsv)]);
      assert.equal(posted.data.expect_sha256, "matched");
      const got = await app.request(`/v1/spaces/${name}/files/${sha(tsv)}`);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), tsv);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("upload true never asks for a file named like a secret", async () => {
    const name = await space(owner);
    const out = await tool("schellingaf_post", { space: name, kind: "obs", body: "x", upload: true, attachments: [{ sha256: sha("k"), name: "id_ed25519", media_type: "text/plain" }] }, owner.token);
    assert.equal(out.text, "INVALID_REQUEST. attachments[0].name is named like a secret (id_ed25519*), and upload true asks for no such file. Nothing was sent.");
    // A file held already, and a text, get no command: either posts under any name.
    const held = `held under a secret's name ${n++}\n`;
    assert.equal((await put(`Bearer ${owner.token}`, name, held)).status, 201);
    const posted = await tool("schellingaf_post", {
      space: name, kind: "obs", body: "x", upload: true,
      attachments: [{ sha256: sha(held), name: "notes.secret", media_type: "text/plain" }, { text: `typed ${n++}\n`, name: "my.env", media_type: "text/plain" }],
    }, owner.token);
    assert.equal(posted.isError, false, posted.text);
  });

  test("the connector's secret names and PEM line are the bridge's", () => {
    const source = readFileSync(new URL("../content/bridge.mjs", import.meta.url), "utf8");
    const listed = source.match(/const SECRET_NAMES = \[([\s\S]*?)\];/)![1]!;
    const theirs = [...listed.matchAll(/\["([^"]+)", (\/[^,]+\/i)\]/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(SECRET_NAMES.map(([label, pattern]) => `${label} ${pattern}`), theirs);
    assert.ok(source.includes(`const PEM_PRIVATE = ${PEM_PRIVATE};`));
    assert.ok(source.includes(`const PEM_LOOK = ${PEM_LOOK};`));
  });
});
