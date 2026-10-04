// The OpenAPI description, held to the service it describes.
//
// Three kinds of check. The document is valid OpenAPI 3.1, by the specification's
// own schema, and every schema in it is valid JSON Schema 2020-12. It names every
// operation the service routes, at its method and path, with its parameters. And
// it tells the truth: one scenario calls every operation for real, as a client
// would, and every request sent and every answer received is checked against what
// the document says, so a field it promises and the service leaves out, a status
// it never lists or a parameter it does not know fails here.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator, addFormats } from "@modelcontextprotocol/server/validators/ajv";
import { app, db, fixture, useService } from "./lib/service.ts";
import { titled } from "./helpers.ts";
import { challengePreimage } from "../src/domain/protocol.ts";
import { developmentServiceKey } from "../src/domain/service.ts";
import { makeCheckpoints } from "../src/db/checkpoints.ts";
import { buildPostObject, signaturePreimageOf } from "../src/domain/objects.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { openApiPath } from "../src/surface/openapi.ts";
import * as sealedModule from "../content/sealed.mjs";
import { PUBLISHED_FILE, publishedOpenApi } from "../scripts/openapi.ts";

const HOST = "api.openapi.test";
const ORIGIN = `https://${HOST}`;
const SITE = "https://site.openapi.test";
const RP_ID = "site.openapi.test";
const serviceKey = developmentServiceKey();

let document: any;

type Exchange = {
  op: string;
  method: string;
  path: string;
  query: Record<string, string[]>;
  requestType: string | null;
  request: unknown;
  status: number;
  type: string;
  body: unknown;
};
const exchanges: Exchange[] = [];

async function call(
  op: string,
  params: Record<string, string> = {},
  opts: {
    query?: Record<string, string | string[]>;
    json?: unknown;
    form?: Record<string, string>;
    /** A file's bytes, sent raw with their length, as an upload is. */
    raw?: Buffer;
    token?: string;
    accept?: string;
  } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const operation = OPERATIONS.find((o) => o.name === op);
  assert.ok(operation, `no operation named ${op}`);
  const path = operation.path.replace(/:([a-z_][a-z0-9_]*)/g, (_, k: string) => {
    assert.ok(params[k] !== undefined, `${op} needs ${k}`);
    return encodeURIComponent(params[k]!);
  });
  const query: Record<string, string[]> = {};
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    query[k] = [v].flat();
    for (const one of query[k]!) search.append(k, one);
  }
  const url = path + (search.size > 0 ? `?${search}` : "");
  const headers: Record<string, string> = { accept: opts.accept ?? "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | Buffer | undefined;
  let requestType: string | null = null;
  if (opts.raw !== undefined) {
    requestType = "application/octet-stream";
    headers["content-length"] = String(opts.raw.length);
    body = opts.raw;
  } else if (opts.json !== undefined) {
    requestType = "application/json";
    headers["content-type"] = requestType;
    if (op === "posts.append") opts.json = titled(opts.json);
    body = JSON.stringify(opts.json);
  } else if (opts.form !== undefined) {
    requestType = "application/x-www-form-urlencoded";
    headers["content-type"] = requestType;
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await app.request(url, { method: operation.method, headers, ...(body === undefined ? {} : { body }) });
  const text = await res.text();
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const parsed = text === "" ? null : type === "application/json" ? JSON.parse(text) : text;
  exchanges.push({
    op, method: operation.method, path: operation.path, query, requestType,
    request: opts.json ?? opts.form ?? (opts.raw === undefined ? null : opts.raw.toString("latin1")), status: res.status, type, body: parsed,
  });
  return { status: res.status, body: parsed, headers: res.headers };
}

function ok(out: { status: number; body: any }, expected = 200) {
  assert.equal(out.status, expected, JSON.stringify(out.body));
  return out.body;
}

type Agent = { token: string; peerId: string; privateKey: KeyObject; publicHex: string };

async function agent(): Promise<Agent> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicHex = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("hex");
  const ch = ok(await call("keys.challenge", {}, { json: { public_key: publicHex } }));
  const signature = sign(null, challengePreimage(HOST, Buffer.from(ch.challenge, "hex")), privateKey).toString("hex");
  const out = ok(await call("keys.verify", {}, { json: { public_key: publicHex, challenge: ch.challenge, signature, label: "openapi test" } }));
  return { token: out.token, peerId: out.peer_id, privateKey, publicHex };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** A passkey's answer to a prompt, as the website hands it on. */
function assertion(privateKey: KeyObject, credentialId: Buffer, challengeHex: string) {
  const clientData = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge: Buffer.from(challengeHex, "hex").toString("base64url"),
    origin: SITE,
    crossOrigin: false,
  }));
  const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), Buffer.alloc(4)]);
  const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), { key: privateKey, dsaEncoding: "der" });
  return {
    credential_id: credentialId.toString("base64url"),
    client_data_json: clientData.toString("base64url"),
    authenticator_data: authData.toString("base64url"),
    signature: signature.toString("base64url"),
  };
}

const unique = () => randomUUID().slice(0, 8);

/** Every operation, called as a client calls it, answers recorded. */
async function scenario() {
  // ── documents, which need nothing ─────────────────────────────────────────
  ok(await call("guide", {}, { accept: "text/markdown" }));
  ok(await call("reference", {}, { accept: "text/markdown" }));
  ok(await call("llms"));
  ok(await call("tools.sign_post"));
  ok(await call("tools.verify_post"));
  ok(await call("tools.bridge"));
  ok(await call("tools.sealed"));
  ok(await call("sealed.spec"));
  ok(await call("robots"));
  ok(await call("health"));
  ok(await call("capabilities"));
  ok(await call("numbers"));
  ok(await call("numbers", {}, { accept: "text/markdown" }));
  ok(await call("open_work", {}, { accept: "text/markdown" }));
  ok(await call("open_work.list"));
  ok(await call("open_work.list", {}, { accept: "text/markdown" }));
  ok(await call("recovery.list"));
  for (const op of OPERATIONS.filter((o) => o.name === "openapi" || o.name === "skill" || o.name.startsWith("plugins."))) {
    ok(await call(op.name));
  }

  // ── KEYS, and a passkey that is one ────────────────────────────────────────
  const owner = await agent();
  const other = await agent();
  const member = await agent();
  const invited = await agent();
  const asker = await agent();
  const declined = await agent();
  const withdrawn = await agent();

  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = randomBytes(32);
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  let ch = ok(await call("passkeys.challenge", {}, { json: {} }));
  const registered = ok(await call("passkeys.verify", {}, {
    json: { challenge: ch.challenge, ...assertion(pair.privateKey, credentialId, ch.challenge), public_key: spki.toString("base64url"), algorithm: -7 },
  }));
  ch = ok(await call("passkeys.challenge", {}, { json: {} }));
  const signedIn = ok(await call("passkeys.verify", {}, { json: { challenge: ch.challenge, ...assertion(pair.privateKey, credentialId, ch.challenge) } }));
  assert.equal(signedIn.peer_id, registered.peer_id);

  // An encryption key, as the bridge publishes one: made from the KEY's own seed,
  // in a statement the KEY signs (content/sealed.md, section 1).
  const seed = Buffer.from(owner.privateKey.export({ format: "jwk" }).d!, "base64url");
  const encryption = await sealedModule.encryptionKey(new Uint8Array(seed), new Uint8Array(Buffer.from(owner.peerId, "hex")));
  const statement = Buffer.from(sealedModule.statementBytes(new Uint8Array(Buffer.from(owner.peerId, "hex")), encryption.pk));
  const statementSignature = sign(null, Buffer.from(sealedModule.signedBytes(sealedModule.LABELS.encryptionKey, new Uint8Array(statement))), owner.privateKey).toString("hex");
  ok(await call("me.encryption_key", {}, { token: owner.token, json: { statement: statement.toString("base64url"), alg: "ed25519", signature: statementSignature } }));

  // A name, so the reads below answer a named author.
  ok(await call("me.set_name", {}, { token: owner.token, json: { name: "OpenAPI-Scenario" } }));
  ok(await call("me", {}, { token: owner.token }));
  ok(await call("tokens.list", {}, { token: owner.token }));

  // ── SPACES, members, codes and asks ────────────────────────────────────────
  const secret = `oa-private-${unique()}`;
  const open = `oa-public-${unique()}`;
  ok(await call("categories.list"));
  ok(await call("categories.list", {}, { query: { under: "agents", depth: "2", detail: "full", counts: "true" } }));
  ok(await call("categories.list", {}, { query: { q: "Windsurf" }, accept: "text/markdown" }));
  ok(await call("categories.list", {}, { query: { q: "zzqx" } }));
  ok(await call("categories.get", { id: "coding-agents" }, { query: { counts: "true" } }));
  ok(await call("categories.get", { id: "roo-code" }));
  ok(await call("spaces.create", {}, { token: owner.token, json: { name: secret, title: "A private space", description: "Where the work is kept.", join_policy: "request", categories: ["coding-agents", "python"] } }), 201);
  ok(await call("spaces.create", {}, { token: owner.token, json: { name: open, title: "A public space", visibility: "public", join_policy: "invite", signed_only: false, categories: ["general"] } }), 201);
  ok(await call("spaces.list", {}, { query: { q: "space", limit: "10" } }));
  ok(await call("spaces.list", {}, { query: { category: "agents" } }));
  ok(await call("spaces.list", {}, { token: owner.token, query: { join_policy: "request" }, accept: "text/markdown" }));
  ok(await call("spaces.get", { name: secret }, { token: owner.token }));
  ok(await call("spaces.get", { name: open }));
  ok(await call("spaces.update", { name: secret }, { token: owner.token, json: { description: "Where the work is kept, and why." } }));
  ok(await call("spaces.update", { name: secret }, { token: owner.token, json: { categories: ["python", "coding-agents"] } }));

  ok(await call("members.set", { name: secret, peer: member.peerId }, { token: owner.token, json: { role: "writer", tags: ["builder"] } }));
  ok(await call("members.set", { name: open, peer: member.peerId }, { token: owner.token, json: { role: "writer" } }));
  ok(await call("members.list", { name: secret }, { token: owner.token, query: { limit: "50" } }));

  const code = ok(await call("invites.create", { name: secret }, { token: owner.token, json: { role: "reader", max_uses: 1, expires_in_seconds: 86400, label: "for a friend" } }), 201);
  const spare = ok(await call("invites.create", { name: secret }, { token: owner.token, json: {} }), 201);
  ok(await call("invites.list", { name: secret }, { token: owner.token }));
  ok(await call("invites.revoke", { id: spare.invite_id }, { token: owner.token }));
  ok(await call("join", { name: secret }, { token: invited.token, json: { code: code.code } }));

  // Links: looked at, used as a link, and taken back with whoever they let in; and a
  // seat offered to a KEY, accepted once and declined once.
  const linked = ok(await call("invites.create", { name: secret }, { token: owner.token, json: { max_uses: null, expires_in_seconds: null } }), 201);
  ok(await call("invites.look", {}, { token: other.token, json: { link: linked.link } }));
  const viaLink = await agent();
  ok(await call("join.link", {}, { token: viaLink.token, json: { link: linked.link } }));
  ok(await call("invites.remove", { id: linked.invite_id }, { token: owner.token }));
  const seat = await agent();
  const heir = await agent();
  const refuser = await agent();
  // An offer reaches a KEY that knows its maker: here, members already.
  ok(await call("members.set", { name: secret, peer: seat.peerId }, { token: owner.token, json: { role: "writer" } }));
  ok(await call("members.set", { name: secret, peer: heir.peerId }, { token: owner.token, json: { role: "reader" } }));
  ok(await call("members.set", { name: secret, peer: refuser.peerId }, { token: owner.token, json: { role: "reader" } }));
  const offer = ok(await call("hand_over.create", { name: secret }, { token: seat.token, json: { to: heir.peerId, expires_in_seconds: 3600 } }), 201);
  ok(await call("hand_over.accept", { id: offer.offer_id }, { token: heir.token }));
  const offer2 = ok(await call("hand_over.create", { name: secret }, { token: heir.token, json: { to: refuser.peerId } }), 201);
  ok(await call("hand_over.decline", { id: offer2.offer_id }, { token: refuser.token }));
  ok(await call("hand_over.create", { name: secret }, { token: heir.token, json: {} }), 201);

  const ask = ok(await call("join", { name: secret }, { token: asker.token, json: { message: "I build the runner image." } }), 202);
  const ask2 = ok(await call("join", { name: secret }, { token: declined.token, json: { message: "Let me in." } }), 202);
  const ask3 = ok(await call("join", { name: secret }, { token: withdrawn.token, json: {} }), 202);
  ok(await call("requests.list", { name: secret }, { token: owner.token, query: { state: "pending" } }));
  ok(await call("requests.approve", { id: ask.request_id }, { token: owner.token, json: { role: "reader" } }));
  ok(await call("requests.decline", { id: ask2.request_id }, { token: owner.token }));
  ok(await call("requests.withdraw", { id: ask3.request_id }, { token: withdrawn.token }));
  ok(await call("members.revoke", { name: secret, peer: invited.peerId }, { token: owner.token }));
  ok(await call("events.list", { name: secret }, { token: owner.token, query: { limit: "100" } }));
  ok(await call("events.list", { name: secret }, { token: owner.token, query: { limit: "700" }, accept: "application/x-ndjson" }));

  // ── posts ───────────────────────────────────────────────────────────────────
  const first = ok(await call("posts.append", { name: open }, {
    token: owner.token,
    json: {
      kind: "result", title: "Build passes", body: "Reproduced on linux, twice.", to: [member.peerId],
      fingerprints: [{ scheme: "git.commit", value: "b75e527ac4f1e0c2d8a3" }],
      data: { x_platform: "linux" }, idempotency_key: `k-${unique()}`, run_id: randomUUID(),
      budget: { observed_at: "2026-09-10T12:00:00Z", output_tokens: { remaining: "40000", unit: "tokens", estimated: true } },
    },
  }), 201);
  ok(await call("posts.append", { name: open }, { token: member.token, json: { kind: "obs", body: "Confirmed on arm64.", reply_to: first.post_id } }), 201);
  const profile = ok(await call("spaces.get", { name: open }));
  const built = buildPostObject({
    spaceId: profile.space_id, author: owner.peerId, idempotencyKey: `k-${unique()}`, kind: "dossier",
    title: "Where the work stands", body: "Next: rebuild the runner image.", to: [], replyTo: null, supersedes: null,
    retracts: null, fingerprints: [], data: null, budget: null, runId: null,
  });
  ok(await call("posts.append", { name: open }, {
    token: owner.token,
    json: {
      alg: "ed25519", canonical: built.canonical.toString("base64url"),
      ...(built.private ? { private: built.private.toString("base64url") } : {}),
      signature: sign(null, signaturePreimageOf(built.objectId), owner.privateKey).toString("hex"),
    },
  }), 201);
  ok(await call("posts.append", { name: open }, { token: owner.token, json: { kind: "warn", body: "The first finding was wrong.", supersedes: first.post_id } }), 201);
  ok(await call("posts.append", { name: secret }, { token: member.token, json: { kind: "obs", body: "A private note." } }), 201);
  // A file uploaded, attached and fetched.
  const solver = Buffer.from("print('solved')\n");
  const solverHash = sha256(solver).toString("hex");
  ok(await call("files.put", { name: open, sha256: solverHash }, { token: owner.token, raw: solver }), 201);
  ok(await call("posts.append", { name: open }, {
    token: owner.token, json: { kind: "result", body: "Run: python3 solve.py", attachments: [{ sha256: solverHash, name: "solve.py", media_type: "text/x-python" }] },
  }), 201);
  ok(await call("files.get", { name: open, sha256: solverHash }));
  await makeCheckpoints(db, serviceKey, { minAgeSeconds: 0 });

  const named = ok(await call("posts.read", { name: open }, { query: { after: "0", limit: "50", detail: "full" } }));
  assert.equal(named.author_names[owner.peerId], "openapi-scenario", "a named author, read");
  ok(await call("posts.read", { name: open }, { query: { after: "0" } }));
  ok(await call("posts.read", { name: open }, { token: owner.token, query: { order: "desc", kind: "dossier", limit: "1", detail: "full", proof: "true" } }));
  ok(await call("posts.read", { name: open }, { query: { detail: "snippets", token_budget: "2000", reply_to: first.post_id } }));
  ok(await call("posts.read", { name: open }, { token: owner.token, query: { detail: "ids" }, accept: "text/markdown" }));
  ok(await call("posts.read", { name: open }, { token: owner.token, accept: "application/x-ndjson" }));
  // An export takes a larger limit than a page does.
  ok(await call("posts.read", { name: open }, { token: owner.token, query: { limit: "800" }, accept: "application/x-ndjson" }));
  ok(await call("posts.read", { name: secret }, { token: owner.token, query: { after: "0", wait: "1" } }));
  ok(await call("posts.batch", {}, { query: { ids: first.post_id, detail: "snippets" } }));
  ok(await call("posts.get", { id: first.post_id }));

  // An open work space: a KEY with no role posts, its owner hides the post and shows it
  // again, and blocks the KEY from posting and lets it again.
  const anyone = `oa-open-${unique()}`;
  ok(await call("spaces.create", {}, { token: owner.token, json: { name: anyone, title: "Anyone posts", visibility: "public", join_policy: "open", categories: ["general"] } }), 201);
  ok(await call("join", { name: anyone }, { token: other.token, json: {} }));
  const strangers = ok(await call("posts.append", { name: anyone }, { token: other.token, json: { kind: "obs", body: "A stranger's word." } }), 201);
  assert.equal(strangers.no_role, true);
  ok(await call("posts.hide", { id: strangers.post_id }, { token: owner.token }));
  ok(await call("posts.get", { id: strangers.post_id }));
  ok(await call("posts.unhide", { id: strangers.post_id }, { token: owner.token }));
  ok(await call("space_blocks.set", { name: anyone, peer: other.peerId }, { token: owner.token }));
  ok(await call("space_blocks.list", { name: anyone }, { token: owner.token, accept: "text/markdown" }));
  ok(await call("space_blocks.list", { name: anyone }, { token: owner.token }));
  ok(await call("space_blocks.remove", { name: anyone, peer: other.peerId }, { token: owner.token }));
  ok(await call("posts.proof", { name: open, seq: "1" }));
  ok(await call("checkpoints.list", { name: open }, { query: { stream: "posts", limit: "10" } }));
  ok(await call("checkpoints.list", { name: secret }, { token: owner.token, query: { stream: "events", order: "desc" } }));

  // ── a work space's tasks: its settings, added, taken, done, checked, given back ──
  ok(await call("spaces.update", { name: open }, { token: owner.token, json: { task_confirmations: 1, task_claim_hours: 2 } }));
  const task = ok(await call("tasks.add", { name: open }, { token: owner.token, json: { title: "Transcribe page 3", body: "Type it out.", tag: "transcription" } }), 201);
  ok(await call("tasks.add", { name: open }, { token: owner.token, json: { title: "Check page 3", after: [task.task.task_id] } }), 201);
  // A batch, short and whole, and a replay; and one task's whole answer. From a writer of
  // its own, whose allowance the rest of the scenario does not need.
  const batcher = await agent();
  ok(await call("members.set", { name: open, peer: batcher.peerId }, { token: owner.token, json: { role: "writer" } }));
  const tasks = { tasks: [{ key: "t1", title: "Transcribe page 4", body: "Type it out." }, { title: "Check page 4", after: ["t1", 1, "2"] }], idempotency_key: "batch-1" };
  ok(await call("tasks.add", { name: open }, { token: batcher.token, json: tasks }), 201);
  ok(await call("tasks.add", { name: open }, { token: batcher.token, json: tasks }), 200);
  ok(await call("tasks.add", { name: open }, { token: batcher.token, query: { detail: "full" }, json: { tasks: [{ key: "t5", title: "Transcribe page 5" }] } }), 201);
  ok(await call("tasks.add", { name: open }, { token: batcher.token, query: { detail: "full" }, json: { title: "Transcribe page 6" } }), 201);
  ok(await call("tasks.next", { name: open }, { token: member.token, json: { tag: "transcription" } }));
  const working = ok(await call("posts.append", { name: open }, { token: member.token, json: { kind: "progress", body: "Lines 1 to 3 typed." } }), 201);
  ok(await call("tasks.progress", { name: open, number: "1" }, { token: member.token, json: { post_id: working.post_id } }));
  // Its owner changes it while it is held: the holder's renewal says so, and done names the revision.
  ok(await call("tasks.change", { name: open, number: "1" }, { token: owner.token, query: { detail: "full" }, json: { revision: 1, reason: "Both sides of the page.", body: "Type out both sides.", tag: null } }));
  ok(await call("tasks.get", { name: open, number: "1" }, { query: { history: "true" } }));
  ok(await call("tasks.next", { name: open }, { token: member.token, json: { number: 1 } }));
  const transcribed = ok(await call("posts.append", { name: open }, { token: member.token, json: { kind: "result", body: "Page 3, typed out." } }), 201);
  ok(await call("posts.append", { name: open }, { token: batcher.token, query: { receipt: "full" }, json: { kind: "obs", body: "Its receipt, whole." } }), 201);
  ok(await call("tasks.done", { name: open, number: "1" }, { token: member.token, json: { post_id: transcribed.post_id, revision: 2 } }));
  ok(await call("tasks.next", { name: open }, { token: owner.token, json: { verify: true } }));
  ok(await call("tasks.reject", { name: open, number: "1" }, { token: owner.token, json: { reason: "Line 4 is missing." } }));
  ok(await call("tasks.next", { name: open }, { token: member.token }));
  ok(await call("tasks.release", { name: open, number: "1" }, { token: member.token }));
  ok(await call("tasks.next", { name: open }, { token: member.token, json: {} }));
  // A result a reject set aside is not sent again (migrations/0140_task_attempts.sql): a new one.
  const retyped = ok(await call("posts.append", { name: open }, { token: member.token, json: { kind: "result", body: "Page 3, typed out, line 4 too." } }), 201);
  ok(await call("tasks.done", { name: open, number: "1" }, { token: member.token, json: { post_id: retyped.post_id, revision: 2 } }));
  ok(await call("tasks.confirm", { name: open, number: "1" }, { token: owner.token, json: { reason: "Matches the image." } }));
  ok(await call("tasks.next", { name: open }, { token: member.token, json: {} }));
  ok(await call("tasks.list", { name: open }));
  ok(await call("tasks.list", { name: open }, { accept: "text/markdown" }));
  ok(await call("tasks.list", { name: open }, { token: owner.token, query: { state: "accepted", tag: "transcription", limit: "10" } }));
  ok(await call("tasks.list", { name: open }, { query: { detail: "compact" } }));
  // A task retired with a replacement, whole; one nobody took deleted by the KEY that added it,
  // and read by its number as the tombstone it leaves.
  ok(await call("tasks.retire", { name: open, number: "5" }, { token: owner.token, query: { detail: "full" }, json: { reason: "Page 5 is in the batch already.", tasks: [{ key: "r5", title: "Check page 5" }] } }));
  ok(await call("tasks.delete", { name: open, number: "6" }, { token: batcher.token, json: { reason: "Added twice." } }));
  ok(await call("tasks.get", { name: open, number: "6" }));
  ok(await call("tasks.list", { name: open }, { query: { state: "retired" } }));

  // ── findings: a claim with what it rests on, listed, kept to a label and opened ──
  const evidence = ok(await call("posts.append", { name: open }, {
    token: owner.token,
    json: { kind: "obs", body: "Image 37 transcribed.", fingerprints: [{ scheme: "subject", value: "wenmi.image:037" }] },
  }), 201);
  const claimed = ok(await call("posts.append", { name: open }, {
    token: owner.token,
    json: {
      kind: "finding", body: "Rows 4 to 9 of the codebook.", fingerprints: [{ scheme: "subject", value: "wenmi.image:037" }],
      data: { claim: "Telegram 37 uses the 1931 codebook", status: "supported", confidence: "medium", sources: [evidence.post_id] },
    },
  }), 201);
  // A member's warn citing it: the finding reads contested, with the warn's cause.
  ok(await call("posts.append", { name: open }, {
    token: member.token,
    json: { kind: "warn", title: "Row 9 is not in the 1931 codebook", body: "See the scan.", data: { sources: [claimed.seq] } },
  }), 201);
  ok(await call("findings.list", { name: open }));
  ok(await call("seek", {}, { query: { q: "codebook", space: open, detail: "snippets" } }));
  ok(await call("posts.read", { name: open }, { query: { detail: "snippets" } }));
  ok(await call("findings.list", { name: open }, { accept: "text/markdown" }));
  ok(await call("findings.list", { name: open }, {
    token: owner.token,
    query: { status: "supported", fingerprint: "subject:wenmi.image:037", since: "2026-01-01T00:00:00Z", limit: "10" },
  }));
  ok(await call("findings.list", { name: open }, { query: { before: "1" } }));
  ok(await call("findings.get", { id: claimed.post_id }));
  ok(await call("findings.get", { id: evidence.post_id }, { token: owner.token, accept: "text/markdown" }));

  // ── an oracle space: its document, a proposal, a decision, and the rest ─────
  const oracleName = `oa-oracle-${unique()}`;
  ok(await call("spaces.create", {}, { token: owner.token, json: { name: oracleName, title: "Runner images", oracle: true, categories: ["general"] } }), 201);
  const v1 = ok(await call("posts.append", { name: oracleName }, {
    token: owner.token,
    json: { kind: "version", body: `The lead, see [[${open}]].\n\n## Images\n\nUse the slim one. [[${open}/1]]`, title: "First version" },
  }), 201);
  const proposal = ok(await call("posts.append", { name: oracleName }, {
    token: other.token,
    json: { kind: "version", body: "The lead.\n\n## Images\n\nUse the slim one; arm64 needs the full one.", supersedes: v1.post_id, title: "arm64" },
  }), 201);
  ok(await call("posts.append", { name: oracleName }, { token: owner.token, json: { kind: "go", body: "Reproduced.", reply_to: proposal.post_id } }), 201);
  ok(await call("oracle.reviewer_rules"));
  ok(await call("oracle.document", { name: oracleName }));
  ok(await call("oracle.document", { name: oracleName }, { query: { section: "images" }, accept: "text/markdown" }));
  ok(await call("oracle.document", { name: oracleName }, { query: { version: v1.seq } }));
  ok(await call("oracle.versions", { name: oracleName }, { query: { limit: "10" } }));
  ok(await call("oracle.versions", { name: oracleName }, { query: { state: "replaced" }, accept: "text/markdown" }));
  ok(await call("links.list", { name: open }));
  ok(await call("links.list", { name: open }, { query: { post: "1" } }));
  ok(await call("watches.set", { name: oracleName }, { token: member.token }));
  ok(await call("watches.list", {}, { token: member.token }));
  ok(await call("watches.remove", { name: oracleName }, { token: member.token }));
  ok(await call("oracle.fork", { name: oracleName }, { token: other.token, json: { name: `${oracleName}-fork` } }), 201);
  ok(await call("posts.standing", { name: open }, { query: { kind: "dossier", limit: "1", detail: "full" } }));
  ok(await call("posts.standing", { name: open }, { accept: "text/markdown" }));
  const recent = ok(await call("spaces.list", {}, { query: { oracle: "true", order: "recent", limit: "1" } }));
  ok(await call("spaces.list", {}, { query: { order: "recent", before: recent.next_before } }));
  ok(await call("seek", {}, { query: { q: "slim", oracle: "true" } }));

  // ── a ready SPACE in one call: a member, the document's first version and tasks ──
  // By a KEY of its own: the create spends five writes, which the owner's scenario needs.
  const readier = await agent();
  ok(await call("spaces.create", {}, { token: readier.token, json: {
    name: `oa-ready-${unique()}`, title: "Ready", members: [{ peer_id: other.peerId, role: "writer", tags: ["checker"] }],
    version: { title: "Version 1", body: "# Ready\n\nThe first text.", fingerprints: [{ scheme: "subject", value: "ready" }] },
    tasks: [{ key: "a", title: "First" }, { key: "b", title: "Second", tag: "check", after: ["a"] }],
  } }), 201);

  // ── a work space's document, with a section whose cited post was replaced ────
  const workName = `oa-workdoc-${unique()}`;
  ok(await call("spaces.create", {}, { token: owner.token, json: { name: workName, title: "Telegrams", document: true } }), 201);
  const cited = ok(await call("posts.append", { name: workName }, { token: owner.token, json: { kind: "obs", body: "Image 37." } }), 201);
  ok(await call("posts.append", { name: workName }, {
    token: owner.token,
    json: { kind: "version", body: `The lead.\n\n## Images\n\nPer [[${workName}/${cited.seq}]].`, data: { sources: [cited.post_id] } },
  }), 201);
  ok(await call("posts.append", { name: workName }, { token: owner.token, json: { kind: "obs", body: "Image 37, again.", supersedes: cited.post_id } }), 201);
  ok(await call("oracle.document", { name: workName }, { token: owner.token }));
  ok(await call("oracle.document", { name: workName }, { token: owner.token, query: { section: "images" } }));
  ok(await call("oracle.versions", { name: workName }, { token: owner.token }));
  ok(await call("spaces.get", { name: workName }, { token: owner.token }));
  ok(await call("spaces.get", { name: workName }, { token: other.token }));
  ok(await call("spaces.update", { name: workName }, { token: owner.token, json: { document: true } }));
  // ── a work space whose document takes 2 confirmations: a proposal, one confirmation,
  // next's version job, and the confirmation that decides, each answer checked by its schema.
  // By KEYS of their own, so the owner's scenario keeps its writes.
  const [confOwner, cw1, cw2, cw3] = await Promise.all([agent(), agent(), agent(), agent()]);
  const confName = `oa-confirm-${unique()}`;
  ok(await call("spaces.create", {}, { token: confOwner.token, json: { name: confName, title: "Confirmed", document: true, document_confirmations: 2 } }), 201);
  for (const k of [cw1, cw2, cw3]) ok(await call("members.set", { name: confName, peer: k.peerId }, { token: confOwner.token, json: { role: "writer" } }));
  const confV1 = ok(await call("posts.append", { name: confName }, { token: confOwner.token, json: { kind: "version", body: "# Confirmed\n\nOne." } }), 201);
  const waiting = ok(await call("posts.append", { name: confName }, {
    token: cw1.token, json: { kind: "version", body: "# Confirmed\n\nTwo.", supersedes: confV1.post_id },
  }), 201);
  assert.equal(waiting.oracle.state, "pending");
  assert.ok(waiting.oracle.deciders?.keys, JSON.stringify(waiting.oracle));
  assert.deepEqual(waiting.oracle.waits_for.confirmations, { given: [], required: 2 });
  const confirmation = ok(await call("posts.append", { name: confName }, { token: cw2.token, json: { kind: "go", body: "It holds.", reply_to: waiting.post_id } }), 201);
  assert.equal(confirmation.oracle.confirmed, waiting.post_id);
  const versionJob = ok(await call("tasks.next", { name: confName }, { token: cw3.token, json: {} }));
  assert.equal(versionJob.job, "check");
  assert.equal(versionJob.version?.post_id, waiting.post_id, JSON.stringify(versionJob));
  const nth = ok(await call("posts.append", { name: confName }, { token: cw3.token, json: { kind: "go", body: "It holds too.", reply_to: waiting.post_id } }), 201);
  assert.equal(nth.oracle.by, "confirmations");
  ok(await call("oracle.document", { name: confName }, { token: cw1.token }));
  ok(await call("oracle.versions", { name: confName }, { token: cw1.token }));

  // One section of many documents, a missing SPACE among them, and what a budget leaves out.
  ok(await call("oracle.documents", {}, { token: owner.token, query: { spaces: `${oracleName},${workName},${workName}-none`, section: "images" } }));
  ok(await call("oracle.documents", {}, { query: { spaces: `${oracleName},${open}`, section: "images", token_budget: "1" }, accept: "text/markdown" }));
  ok(await call("oracle.document", { name: oracleName }, { query: { token_budget: "1" } }));
  ok(await call("oracle.versions", { name: oracleName }, { query: { token_budget: "1" } }));
  ok(await call("spaces.list", {}, { query: { token_budget: "1" } }));
  ok(await call("members.list", { name: workName }, { token: owner.token, query: { token_budget: "1" } }));

  ok(await call("peers.get", { peer: other.peerId }, { token: owner.token }));
  ok(await call("mailbox", {}, { token: member.token, query: { after: "0", detail: "snippets" } }));
  ok(await call("mailbox", {}, { token: owner.token, query: { reason: "request", limit: "10" } }));
  ok(await call("seek", {}, { query: { q: "linux build" } }));
  ok(await call("seek", {}, { query: { q: "space", category: "agents" } }));
  ok(await call("seek", {}, { token: owner.token, query: { fingerprint: "git.commit:b75e527ac4f1e0c2d8a3", space: open, detail: "ids" } }));
  ok(await call("seek", {}, { query: { fingerprint: ["git.commit:b75e527ac4f1e0c2d8a3", "package.version:runner@1.2.0"] } }));

  // ── direct messages ─────────────────────────────────────────────────────────
  // The owner has written more than one burst by here. A full bucket keeps the write
  // limit, which its own tests prove, out of what this scenario proves.
  await fixture.setBucket(`peer:${owner.peerId}`, 60);
  const pairConversation = ok(await call("conversations.start", {}, { token: owner.token, json: { to: [member.peerId], body: "Can you take the runner?", about: open, idempotency_key: `k-${unique()}` } }), 201);
  const group = ok(await call("conversations.start", {}, { token: owner.token, json: { to: [member.peerId, other.peerId], body: "All three of us." } }), 201);
  const stranger = ok(await call("conversations.start", {}, { token: declined.token, json: { to: [withdrawn.peerId], body: "Hello from a stranger." } }), 201);
  ok(await call("conversations.list", {}, { token: member.token, query: { limit: "20" } }));
  ok(await call("conversations.list", {}, { token: withdrawn.token, query: { state: "requested" } }));
  ok(await call("conversations.get", { id: pairConversation.conversation_id }, { token: member.token }));
  ok(await call("conversations.accept", { id: group.conversation_id }, { token: other.token }));
  const reply = ok(await call("messages.send", { id: pairConversation.conversation_id }, { token: member.token, json: { body: "Yes, tonight.", idempotency_key: `k-${unique()}` } }), 201);
  ok(await call("messages.read", { id: pairConversation.conversation_id }, { token: owner.token, query: { after: "0", limit: "20" } }));
  // A sealed pair beside it: the two share a SPACE, so they know each other. Everything
  // sealed here is sealed as the bridge seals it (content/sealed.md).
  const memberSeed = Buffer.from(member.privateKey.export({ format: "jwk" }).d!, "base64url");
  const memberKey = await sealedModule.encryptionKey(new Uint8Array(memberSeed), new Uint8Array(Buffer.from(member.peerId, "hex")));
  const memberStatement = sealedModule.statementBytes(new Uint8Array(Buffer.from(member.peerId, "hex")), memberKey.pk);
  ok(await call("me.encryption_key", {}, { token: member.token, json: {
    statement: sealedModule.toB64u(memberStatement), alg: "ed25519",
    signature: sign(null, Buffer.from(sealedModule.signedBytes(sealedModule.LABELS.encryptionKey, memberStatement)), member.privateKey).toString("hex"),
  } }));
  const pairBytes = [owner.peerId, member.peerId].map((p) => new Uint8Array(Buffer.from(p, "hex")));
  const container = sealedModule.pairContainer(pairBytes[0]!, pairBytes[1]!);
  const secretOfPair = sealedModule.randomBytes(32);
  const pairCommitment = await sealedModule.commitment(container, 1, secretOfPair);
  const lockFor = async (peer: string, pk: Uint8Array) => Buffer.from(await sealedModule.sealLock({
    container, g: 1, recipient: new Uint8Array(Buffer.from(peer, "hex")), sender: new Uint8Array(Buffer.from(owner.peerId, "hex")),
    commitment: pairCommitment, secret: secretOfPair, pkR: pk, skS: encryption.sk,
  })).toString("hex");
  const sealedPair = ok(await call("conversations.start", {}, { token: owner.token, json: {
    to: [member.peerId],
    sealed: {
      commitment: Buffer.from(pairCommitment).toString("hex"),
      locks: { [owner.peerId]: await lockFor(owner.peerId, encryption.pk), [member.peerId]: await lockFor(member.peerId, memberKey.pk) },
      ...(await sealedModule.sealMessage({ secret: secretOfPair, author: owner.peerId, pair: [owner.peerId, member.peerId], body: "Sealed, for us two." })),
    },
  } }), 201);
  ok(await call("conversations.get", { id: sealedPair.conversation_id }, { token: member.token }));
  ok(await call("messages.send", { id: sealedPair.conversation_id }, { token: member.token, json: {
    sealed: await sealedModule.sealMessage({ secret: secretOfPair, author: member.peerId, pair: [owner.peerId, member.peerId], body: "Sealed back." }),
  } }), 201);
  ok(await call("messages.read", { id: sealedPair.conversation_id }, { token: owner.token, query: { after: "0" } }));

  // A sealed SPACE, kept by its owner as a keeper's software keeps it (content/sealed.md).
  const b = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
  const h = (u: Uint8Array) => Buffer.from(u).toString("hex");
  const sealedName = `oa-sealed-${unique()}`;
  const sealedId = randomUUID();
  const spaceBox = sealedModule.spaceContainer(sealedId);
  const firstKey = await sealedModule.newGeneration(spaceBox, 1);
  const lockIn = (g: number, gen: { secret: Uint8Array; commitment: Uint8Array }, peer: string, pk: Uint8Array) =>
    sealedModule.sealLock({ container: spaceBox, g, recipient: b(peer), sender: b(owner.peerId), commitment: gen.commitment, secret: gen.secret, pkR: pk, skS: encryption.sk }).then(h);
  ok(await call("spaces.create", {}, { token: owner.token, json: {
    name: sealedName, title: "Sealed", visibility: "sealed", categories: ["general"],
    sealed: { space_id: sealedId, commitment: h(firstKey.commitment), lock: await lockIn(1, firstKey, owner.peerId, encryption.pk) },
  } }), 201);
  const keeperList = sealedModule.keeperListBytes({ spaceId: sealedId, revision: 1, keepers: [], admission: "stamped", stampers: [owner.peerId], changeEvery: 3600 });
  ok(await call("sealed.keepers", { name: sealedName }, { token: owner.token, json: {
    list: sealedModule.toB64u(keeperList), alg: "ed25519",
    signature: sign(null, Buffer.from(sealedModule.signedBytes(sealedModule.LABELS.keepers, keeperList)), owner.privateKey).toString("hex"),
  } }));
  const stamp = sealedModule.stampBytes({ issuer: owner.peerId, peerId: member.peerId });
  ok(await call("sealed.stamp", { name: sealedName }, { token: member.token, json: {
    stamp: sealedModule.toB64u(stamp), alg: "ed25519",
    signature: sign(null, Buffer.from(sealedModule.signedBytes(sealedModule.LABELS.stamp, stamp)), owner.privateKey).toString("hex"),
  } }));
  const sealedAsk = ok(await call("join", { name: sealedName }, { token: member.token, json: {} }), 202);
  ok(await call("sealed.requests", { name: sealedName }, { token: owner.token }));
  ok(await call("requests.approve", { id: sealedAsk.request_id }, { token: owner.token, json: { role: "writer" } }));
  ok(await call("sealed.unlocked", { name: sealedName }, { token: owner.token }));
  ok(await call("sealed.locks", { name: sealedName }, { token: owner.token, json: {
    generation: "1", commitment: h(firstKey.commitment), locks: { [member.peerId]: await lockIn(1, firstKey, member.peerId, memberKey.pk) },
  } }));
  ok(await call("sealed.status", { name: sealedName }, { token: member.token }));
  ok(await call("posts.append", { name: sealedName }, { token: member.token, json: {
    sealed: await sealedModule.sealPost({ secret: firstKey.secret, generation: 1, author: member.peerId, spaceId: sealedId, kind: "obs", content: { body: "Sealed, for the SPACE." } }),
    idempotency_key: `k-${unique()}`,
  } }), 201);
  // A change staged and abandoned, as a keeper that lost its new secret abandons one.
  const lost = await sealedModule.newGeneration(spaceBox, 2, firstKey.secret);
  ok(await call("sealed.stage", { name: sealedName }, { token: owner.token, json: {
    generation: "2", commitment: h(lost.commitment), back: h(lost.back!),
  } }), 201);
  ok(await call("sealed.abandon", { name: sealedName, generation: "2" }, { token: owner.token }));
  const second = await sealedModule.newGeneration(spaceBox, 2, firstKey.secret);
  ok(await call("sealed.stage", { name: sealedName }, { token: owner.token, json: {
    generation: "2", commitment: h(second.commitment), back: h(second.back!),
  } }), 201);
  ok(await call("sealed.locks", { name: sealedName }, { token: owner.token, json: {
    generation: "2", commitment: h(second.commitment), locks: { [owner.peerId]: await lockIn(2, second, owner.peerId, encryption.pk), [member.peerId]: await lockIn(2, second, member.peerId, memberKey.pk) },
  } }));
  ok(await call("sealed.activate", { name: sealedName, generation: "2" }, { token: owner.token }));
  ok(await call("sealed.chain", { name: sealedName }, { token: member.token }));
  ok(await call("posts.read", { name: sealedName }, { token: member.token, query: { after: "0", detail: "full" } }));
  ok(await call("conversations.mark_read", { id: pairConversation.conversation_id }, { token: owner.token, json: { seq: reply.seq } }));
  ok(await call("conversations.leave", { id: group.conversation_id }, { token: other.token }));
  ok(await call("conversations.decline", { id: stranger.conversation_id }, { token: withdrawn.token }));
  ok(await call("conversations.clear", { id: pairConversation.conversation_id }, { token: owner.token }));
  ok(await call("blocks.set", { peer: declined.peerId }, { token: withdrawn.token }));
  ok(await call("blocks.list", {}, { token: withdrawn.token }));
  ok(await call("blocks.remove", { peer: declined.peerId }, { token: withdrawn.token }));
  ok(await call("messages.set_retention", {}, { token: owner.token, json: { days: 30 } }));

  // ── an app signs a person in ────────────────────────────────────────────────
  ok(await call("oauth.resource"));
  ok(await call("oauth.metadata"));
  const registeredApp = ok(await call("oauth.register", {}, {
    json: { redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none", client_name: "An OpenAPI test", grant_types: ["authorization_code"], response_types: ["code"] },
  }), 201);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeQuery = {
    response_type: "code", client_id: registeredApp.client_id, redirect_uri: "http://localhost:43117/callback",
    code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "read write", resource: `${ORIGIN}/mcp/connect`,
  };
  const sent = await call("oauth.authorize", {}, { query: authorizeQuery, accept: "text/html" });
  assert.equal(sent.status, 302);
  const requestId = new URL(sent.headers.get("location")!).searchParams.get("request")!;
  ok(await call("authorizations.get", { id: requestId }, { token: owner.token }));
  const approved = ok(await call("authorizations.approve", { id: requestId }, { token: owner.token }));
  const back = new URL(approved.redirect_to);
  const issued = ok(await call("oauth.token", {}, {
    form: {
      grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: "http://localhost:43117/callback",
      client_id: registeredApp.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp/connect`,
    },
  }));
  const sentAgain = await call("oauth.authorize", {}, { query: authorizeQuery, accept: "text/html" });
  ok(await call("authorizations.decline", { id: new URL(sentAgain.headers.get("location")!).searchParams.get("request")! }, { token: owner.token }));

  // ── tokens revoked, one, the current, and all ───────────────────────────────
  const listed = ok(await call("tokens.list", {}, { token: owner.token }));
  const appToken = listed.items.find((t: any) => t.app !== null);
  assert.ok(appToken, "the app's token is not listed");
  assert.ok(issued.access_token);
  ok(await call("tokens.revoke_one", { id: appToken.id }, { token: owner.token }), 204);
  ok(await call("tokens.revoke", {}, { token: signedIn.token }), 204);
  ok(await call("tokens.revoke_all", {}, { token: asker.token }), 204);

  // ── refusals, which every operation answers in one shape ────────────────────
  assert.equal((await call("posts.read", { name: secret }, { token: other.token })).status, 403);
  assert.equal((await call("spaces.get", { name: "no-such-space-here" })).status, 404);
  assert.equal((await call("me", {})).status, 401);
  assert.equal((await call("spaces.create", {}, { token: owner.token, json: { name: "UPPER", title: "x", categories: ["general"] } })).status, 400);
}

// Set before the app is built: the scenario makes public SPACES with KEYS minted
// moments earlier.
before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
const ready = useService("openapi", {
  apiHost: HOST,
  siteOrigin: SITE,
  passkeys: { rpId: RP_ID, origins: [SITE] },
  contact: "operator@openapi.test",
  serviceKey,
});

before(async () => {
  await ready;
  await scenario();
  const res = await app.request("/openapi.json");
  document = res.status === 200 ? await res.json() : null;
});

// ── validators ──────────────────────────────────────────────────────────────

/** The 2020-12 engine the SDK bundles, which OpenAPI 3.1's schema dialect needs. */
// Reached through the provider's engine, which the SDK documents as its 2020-12
// engine and types as private; if that ever moves, this line fails, loudly.
const Ajv2020 = (new AjvJsonSchemaValidator() as unknown as { ajv: object }).ajv.constructor as new (options: Record<string, unknown>) => any;
const DOCUMENT_ID = "https://api.openapi.test/openapi.json";

/**
 * A validator for the whole document by the specification's own schema, vendored
 * in test/fixtures from https://spec.openapis.org/oas/3.1/schema/2022-10-07 (the
 * OpenAPI Initiative's, Apache License 2.0). Its four `$dynamicRef: "#meta"` are
 * made the static reference they resolve to when no dialect extends them, which is
 * this schema's own `$defs/schema`, because the bundled engine resolves a dynamic
 * reference inside `$defs` to the document's root. Schema Objects are checked
 * separately and strictly, below.
 */
function documentValidator() {
  const text = readFileSync(new URL("./fixtures/openapi-3.1-schema.json", import.meta.url), "utf8")
    .replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"');
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addFormat("media-range", true);
  return ajv.compile(JSON.parse(text));
}

/** Every Schema Object in the document, where it sits. */
function schemasIn(doc: any): { at: string; schema: any }[] {
  const out: { at: string; schema: any }[] = [];
  for (const [name, schema] of Object.entries(doc.components.schemas)) out.push({ at: `components.schemas.${name}`, schema });
  for (const [name, h] of Object.entries<any>(doc.components.headers)) out.push({ at: `components.headers.${name}`, schema: h.schema });
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const [method, operation] of Object.entries<any>(item)) {
      const at = `${method.toUpperCase()} ${path}`;
      for (const p of operation.parameters ?? []) out.push({ at: `${at} parameter ${p.name}`, schema: p.schema });
      for (const [type, media] of Object.entries<any>(operation.requestBody?.content ?? {})) out.push({ at: `${at} request ${type}`, schema: media.schema });
      for (const [status, response] of Object.entries<any>(operation.responses)) {
        for (const [type, media] of Object.entries<any>(response.content ?? {})) out.push({ at: `${at} ${status} ${type}`, schema: media.schema });
        // A header described once in components is a reference here, its schema counted above.
        for (const [header, h] of Object.entries<any>(response.headers ?? {})) if (!h.$ref) out.push({ at: `${at} ${status} header ${header}`, schema: h.schema });
      }
    }
  }
  return out;
}

/** Instance validation against a schema from the document, its references resolved
 * within it. */
function instanceValidator(doc: any) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  ajv.addSchema({ $id: DOCUMENT_ID, components: doc.components });
  const rewrite = (value: any): any =>
    Array.isArray(value)
      ? value.map(rewrite)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `${DOCUMENT_ID}${v}` : rewrite(v)]))
        : value;
  const cache = new Map<any, any>();
  return (schema: any, instance: unknown): string | null => {
    let validate = cache.get(schema);
    if (!validate) {
      validate = ajv.compile(rewrite(schema));
      cache.set(schema, validate);
    }
    return validate(instance) ? null : ajv.errorsText(validate.errors, { separator: "\n  " });
  };
}

/** A query value as a client reading the document would send it: text, a number
 * where the schema says one, and a list where the parameter repeats. */
function queryValue(schema: any, values: string[]): unknown {
  const one = (s: any, value: string): unknown =>
    (s?.type === "integer" || s?.type === "number") && /^-?[0-9]+(\.[0-9]+)?$/.test(value)
      ? Number(value)
      : s?.type === "boolean" && (value === "true" || value === "false")
        ? value === "true"
        : value;
  return schema?.type === "array" ? values.map((value) => one(schema.items, value)) : one(schema, values[0]!);
}

const operationOf = (op: string) => {
  const operation = OPERATIONS.find((o) => o.name === op)!;
  return document.paths[openApiPath(operation.path)]?.[operation.method.toLowerCase()];
};

describe("the OpenAPI description", () => {
  test("the scenario called every operation the service has, and each answered", () => {
    const answered = new Set(exchanges.filter((e) => e.status < 400).map((e) => e.op));
    const missing = OPERATIONS.map((o) => o.name).filter((name) => !answered.has(name));
    assert.deepEqual(missing, [], `never called with success: ${missing.join(", ")}`);
  });

  test("the service serves it, as JSON with an ETag any page may read, and a second read is 304", async () => {
    assert.ok(document, "GET /openapi.json did not answer 200");
    const res = await app.request("/openapi.json");
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const etag = res.headers.get("etag");
    assert.ok(etag);
    const again = await app.request("/openapi.json", { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304);
    assert.equal(document.servers[0].url, ORIGIN);
    assert.equal(document.openapi, "3.1.0");
    // Where abuse reports and a blocked agent's operator write, as the capability
    // document says too.
    assert.deepEqual(document.info.contact, { name: "The operator", email: "operator@openapi.test" });
  });

  test("it is valid OpenAPI 3.1, by the specification's own schema", () => {
    const validate = documentValidator();
    const valid = validate(document);
    assert.ok(valid, JSON.stringify(validate.errors?.slice(0, 5), null, 2));
    // And the validator has teeth: the same document with one response left
    // undescribed, or one path parameter optional, is refused.
    const broken = structuredClone(document);
    delete broken.paths["/v1/me"].get.responses["200"].description;
    assert.equal(validate(broken), false);
    const loose = structuredClone(document);
    loose.paths["/v1/spaces/{name}"].get.parameters[0].required = false;
    assert.equal(validate(loose), false);
  });

  test("it declares who decides a document, what a waiting version waits for, and document_confirmations", () => {
    // migrations/0138_document_decision.sql: each new field where an answer or a body carries it.
    const schemas = document.components.schemas;
    const answer = (op: string, status = "200") => operationOf(op).responses[status].content["application/json"].schema;
    const body = (op: string) => operationOf(op).requestBody.content["application/json"].schema;
    const props = (schema: any): Record<string, any> =>
      schema.$ref ? props(schemas[schema.$ref.split("/").at(-1)]) : schema.allOf ? Object.assign({}, ...schema.allOf.map(props)) : schema.properties ?? {};
    const nullableOf = (schema: any) => schema.anyOf?.find((s: any) => s.type !== "null") ?? schema;
    const confirmations = (schema: any) => {
      assert.equal(schema?.type, "integer", JSON.stringify(schema));
      assert.equal(schema.maximum, 5);
    };
    // The setting: on create and update, their answers, and the profile.
    confirmations(props(body("spaces.create")).document_confirmations);
    confirmations(props(body("spaces.update")).document_confirmations);
    confirmations(props(answer("spaces.create", "201")).document_confirmations);
    confirmations(props(answer("spaces.update")).document_confirmations);
    confirmations(props(schemas.Space).document_confirmations);
    // deciders, short and full, on the document and the versions list.
    const deciders = (schema: any) => {
      assert.deepEqual(schema?.required, ["roles", "you"], JSON.stringify(schema));
      assert.ok(["roles", "you", "keys", "more"].every((k) => k in schema.properties), JSON.stringify(schema));
    };
    deciders(props(schemas.Document).deciders);
    assert.ok(schemas.Document.required.includes("deciders"));
    deciders(props(answer("oracle.versions")).deciders);
    // waits_for on a versions item, the document's version and the receipt's oracle.
    const waits = (schema: any) => {
      assert.deepEqual(schema?.required, ["decision"], JSON.stringify(schema));
      assert.deepEqual(schema.properties.confirmations.required, ["given", "required"]);
    };
    waits(props(schemas.Version).waits_for);
    waits(props(nullableOf(props(schemas.Document).version)).waits_for);
    const oracle = props(schemas.PostReceipt).oracle.properties;
    waits(oracle.waits_for);
    deciders(oracle.deciders);
    for (const field of ["confirmed", "by", "confirmations"]) assert.ok(field in oracle, field);
    // A decision made by confirmations, wherever a read shows a decision.
    for (const decision of [props(nullableOf(props(schemas.Document).version)).decided_by, props(schemas.Version).decision]) {
      const fields = props(nullableOf(decision));
      assert.equal(fields.by.const, "confirmations");
      assert.equal(fields.confirmed_by.type, "array");
    }
    // next: task nullable, and a version to check.
    const next = props(answer("tasks.next"));
    assert.ok(next.task.anyOf.some((s: any) => s.type === "null"));
    waits(next.version.properties.waits_for);
    // The two new codes on the refusals of POST posts.
    for (const code of ["PROPOSAL_SELF_CONFIRM", "PROPOSAL_ALREADY_CONFIRMED"]) {
      assert.ok(operationOf("posts.append")["x-refusals"].includes(code), code);
      assert.match(operationOf("posts.append").responses["4XX"].description, new RegExp(code));
    }
  });

  test("it is served without indentation, because an agent that reads it pays for every byte", async () => {
    const text = await (await app.request("/openapi.json")).text();
    assert.equal(text, JSON.stringify(JSON.parse(text)));
  });

  test("one operation's part is valid OpenAPI 3.1 alone: that operation, every schema it reaches, and nothing else", async () => {
    const validate = documentValidator();
    const whole = await (await app.request("/openapi.json")).text();
    for (const op of OPERATIONS) {
      const res = await app.request(`/openapi.json?operation=${op.name}`);
      assert.equal(res.status, 200, op.name);
      const text = await res.text();
      const part = JSON.parse(text);
      assert.ok(validate(part), `${op.name}: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
      const paths = Object.values(part.paths) as Record<string, any>[];
      assert.equal(paths.length, 1, op.name);
      assert.deepEqual(Object.keys(paths[0]!), [op.method.toLowerCase()], op.name);
      assert.equal(paths[0]![op.method.toLowerCase()]["x-schellingaf-operation"], op.name);
      // Every reference resolves inside the part, and it keeps no schema, response or
      // header nothing reaches.
      const referenced = new Set([...text.matchAll(/"\$ref":"#\/components\/([^"]+)"/g)].map((m) => m[1]));
      const kept = ["schemas", "responses", "headers"].flatMap((kind) => Object.keys(part.components[kind] ?? {}).map((entry) => `${kind}/${entry}`));
      assert.deepEqual(kept.sort(), [...referenced].sort(), op.name);
      assert.deepEqual(part.components.securitySchemes, document.components.securitySchemes, op.name);
      assert.ok(text.length < whole.length / 10, `${op.name} is ${text.length} bytes of the whole ${whole.length}`);
    }
  });

  test("a part has its own ETag and answers 304 to it, either spelling of a name finds it, and any other name is refused", async () => {
    const res = await app.request("/openapi.json?operation=posts.append");
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.notEqual(etag, (await app.request("/openapi.json")).headers.get("etag"));
    assert.equal((await app.request("/openapi.json?operation=posts.append", { headers: { "If-None-Match": etag } })).status, 304);
    const text = await res.text();
    assert.equal(await (await app.request("/openapi.json?operation=posts_append")).text(), text);
    const unknown = await app.request("/openapi.json?operation=posts.delete");
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as any).error.code, "INVALID_REQUEST");
  });

  test("every schema in it is valid JSON Schema 2020-12, with no keyword misspelled", () => {
    const strict = new Ajv2020({ strict: true, allErrors: true });
    addFormats(strict);
    // References are checked by the instance validator; here each schema stands
    // alone, so a reference is taken as satisfied.
    const alone = (value: any): any =>
      Array.isArray(value)
        ? value.map(alone)
        : value && typeof value === "object"
          ? typeof value.$ref === "string" ? true : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, alone(v)]))
          : value;
    const failures: string[] = [];
    for (const { at, schema } of schemasIn(document)) {
      try {
        strict.compile(alone(schema));
      } catch (error) {
        failures.push(`${at}: ${(error as Error).message}`);
      }
    }
    assert.deepEqual(failures, []);
    // Every reference names a schema, a response or a header that exists.
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/([a-z]+)\/([^"]+)"/g)];
    assert.ok(refs.length > 0);
    for (const [, kind, name] of refs) {
      assert.ok(document.components[kind!]?.[name!], `${kind}/${name} is referred to and never defined`);
    }
  });

  test("it names every operation the service routes, at its method and path, and nothing else", () => {
    const ids = new Set<string>();
    for (const op of OPERATIONS) {
      const operation = operationOf(op.name);
      assert.ok(operation, `${op.method} ${op.path} (${op.name}) is not described`);
      assert.equal(operation["x-schellingaf-operation"], op.name);
      // Tools that turn an API into an agent's tools take only these characters.
      assert.match(operation.operationId, /^[a-zA-Z0-9_-]{1,64}$/);
      assert.ok(!ids.has(operation.operationId), `operationId ${operation.operationId} twice`);
      ids.add(operation.operationId);
      const named = [...op.path.matchAll(/:([a-z_][a-z0-9_]*)/g)].map((m) => m[1]).sort();
      const declared = (operation.parameters ?? []).filter((p: any) => p.in === "path").map((p: any) => p.name).sort();
      assert.deepEqual(declared, named, `${op.name}'s path parameters`);
      const expected = op.auth === "none" ? [] : op.auth === "bearer" ? [{ bearer: [] }] : [{}, { bearer: [] }];
      assert.deepEqual(operation.security, expected, `${op.name} says it takes a token differently from the service`);
      assert.equal(operation.description, op.describe);
      assert.ok(operation.responses["4XX"] && operation.responses["5XX"], `${op.name} says nothing about refusals`);
      assert.equal(operation.responses.default, undefined);
    }
    let described = 0;
    for (const item of Object.values<any>(document.paths)) described += Object.keys(item).length;
    assert.equal(described, OPERATIONS.length, "the document describes an operation the service does not route");
  });

  test("every request the scenario sent is one the document allows, and every answer is one it promises", () => {
    const check = instanceValidator(document);
    const failures: string[] = [];
    for (const e of exchanges) {
      const operation = operationOf(e.op);
      const at = `${e.op} ${e.status}`;
      // Every query parameter sent is one the document names, and when the service
      // took it, a value its schema accepts: a limit the service honoured is one the
      // document allows, and a repeated parameter is one it says repeats.
      const described = new Map<string, any>(
        (operation.parameters ?? []).filter((p: any) => p.in === "query").map((p: any) => [p.name, p]),
      );
      for (const [key, values] of Object.entries(e.query)) {
        const parameter = described.get(key);
        if (!parameter) {
          failures.push(`${at}: query parameter ${key} is not described`);
          continue;
        }
        if (e.status >= 400) continue;
        if (values.length > 1 && !(parameter.schema.type === "array" && parameter.explode === true)) {
          failures.push(`${at}: query parameter ${key} was sent ${values.length} times, and the document says it is sent once`);
          continue;
        }
        const why = check(parameter.schema, queryValue(parameter.schema, values));
        if (why) failures.push(`${at}: query parameter ${key}=${values.join(",")} does not match its schema:\n  ${why}`);
      }
      // The body sent is one its schema accepts, when the service took it: the
      // scenario sends a few it must refuse.
      if (e.requestType !== null && e.status < 400) {
        const media = operation.requestBody?.content?.[e.requestType];
        if (!media) failures.push(`${at}: a ${e.requestType} body is not described`);
        else {
          const why = check(media.schema, e.request);
          if (why) failures.push(`${at}: the request does not match its schema:\n  ${why}`);
        }
      }
      // The answer is one the document lists, in a type it names, of the shape it says.
      const response = operation.responses[String(e.status)] ?? operation.responses[`${String(e.status)[0]}XX`];
      if (!response) {
        failures.push(`${at}: status ${e.status} is not described`);
        continue;
      }
      if (e.body === null) continue;
      const media = response.content?.[e.type];
      if (!media) {
        failures.push(`${at}: ${e.type} is not described for this status`);
        continue;
      }
      if (e.type === "application/json") {
        const why = check(media.schema, e.body);
        if (why) failures.push(`${at}: the answer does not match its schema:\n  ${why}`);
      }
    }
    assert.deepEqual(failures, []);
  });
});

describe("the committed description", () => {
  // reference/openapi.json is what anyone reading the repository works from, and
  // nothing regenerates it on their behalf. An operation added, a parameter renamed
  // or a schema changed without `npm run openapi -- --write` fails here.
  test("is the document this code builds", () => {
    const committed = readFileSync(PUBLISHED_FILE, "utf8");
    assert.equal(
      committed,
      publishedOpenApi(),
      "reference/openapi.json is out of date. Run: npm run openapi -- --write",
    );
  });
});
