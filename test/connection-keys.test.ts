// Signing through an app connection, end to end over the service's real routes: the
// statement a person's KEY signs for a connection key, the approval that carries it,
// the vault that keeps the key's private half sealed under the code and then the token,
// the posts the connector signs with it, and every reader checking them. Then every
// way it must refuse, and every way the vault must end.
//
// The person is a passkey KEY with its own token, which is what the website holds for
// somebody signed in, or an Ed25519 KEY calling the same route. Every signature is
// real: passkeys from the software authenticator in test/lib/passkey.ts.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useService, app, db, fixture, call, send, read, agent, passkey, passkeyAssertion, requestsDuring, HOST, type Agent, type Passkey } from "./lib/service.ts";
import { filedTool } from "./helpers.ts";
import { sweep } from "./lib/sweep.ts";
import { canonicalBytes } from "../src/domain/jcs.ts";
import { ApiError } from "../src/db/errors.ts";
import { classifyBearer } from "../src/http/auth.ts";
import { TOKEN_TTL_DEFAULT_SECONDS } from "../src/domain/protocol.ts";
import { sha256 } from "../src/domain/keys.ts";
import { buildPostObject, signaturePreimageOf, uuidBytes } from "../src/domain/objects.ts";
import { verifyPost, verifyPostRun } from "../src/domain/verify.ts";
import { REPLAY_GRACE_SECONDS } from "../src/oauth/routes.ts";
import {
  connectionIdempotencyKey,
  NOT_AFTER_MIN_SECONDS,
  NOT_BEFORE_FUTURE_SECONDS,
  NOT_BEFORE_PAST_SECONDS,
  STATEMENT_SECONDS,
  checkConnectionKey,
  codeVaultData,
  connectionPublicKey,
  connectionSalt,
  delegationPreimage,
  delegationStatementBytes,
  openVault,
  readConnectionKeyBody,
  readDelegationStatement,
  sealVault,
  type DelegationStatement,
} from "../src/domain/connection-keys.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** What the connector tells an agent its post was signed with, through an app connection. */
const RECEIPT_WORDS = "signed with this app connection's key, which your KEY allowed and the service holds while it serves the connection: it shows the connection signed, not that the post was seen";
const SITE = "https://site.connection-keys.test";
const RP_ID = "site.connection-keys.test";
const CONNECT = `https://${HOST}/mcp/connect`;
const site = { rpId: RP_ID, origins: [SITE] };
const logDir = mkdtempSync(path.join(tmpdir(), "schellingaf-connection-keys-"));

useService("connection_keys", { siteOrigin: SITE, passkeys: { rpId: RP_ID, origins: [SITE] }, logDir });
after(() => rmSync(logDir, { recursive: true, force: true }));

// ── the people and the apps ──────────────────────────────────────────────────

type Person = (Passkey & { token: string; peerId: string; kind: "passkey" }) | (Agent & { kind: "ed25519" });

/** A passkey KEY, registered as the website registers one, with its sign-in token. */
async function passkeyPerson(signCount = 0): Promise<Person> {
  const pk = passkey();
  const ch = await call("POST", "/v1/passkeys/challenge", undefined, {});
  const out = await call("POST", "/v1/passkeys/verify", undefined, {
    challenge: ch.body.challenge,
    ...passkeyAssertion(pk, Buffer.from(ch.body.challenge, "hex"), { rpId: RP_ID, origin: SITE, signCount }),
    public_key: pk.spki.toString("base64url"),
    algorithm: -7,
  });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return { ...pk, token: out.body.token, peerId: out.body.peer_id, kind: "passkey" };
}

async function ed25519Person(): Promise<Person> {
  return { ...(await agent()), kind: "ed25519" };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function registerApp(): Promise<string> {
  const out = await call("POST", "/oauth/register", null, { redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none", client_name: "Signing App" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.client_id;
}

const REDIRECT = "http://localhost:43117/callback";

/** The person's browser arriving at /oauth/authorize for a fresh request to connect. */
async function startRequest(clientId: string, scope = "read write") {
  const { verifier, challenge } = pkce();
  const res = await app.request(`/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: "S256", scope, resource: CONNECT,
  })}`);
  const requestId = new URL(res.headers.get("location") ?? "").searchParams.get("request");
  assert.ok(requestId, `no request id in ${res.headers.get("location")}`);
  return { requestId, verifier };
}

/** The approval as the website sends it: JSON, with the person's own token. */
const approve = async (person: { token: string }, requestId: string, body?: unknown) =>
  read(await send(app, "POST", `/v1/authorizations/${requestId}/approve`, person.token, body ?? {}, { "content-type": "application/json" }));

async function trade(fields: Record<string, string>) {
  return read(await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }));
}

/** A statement's times as the website writes them: made now, lasting the token's lifetime and an hour. */
const timesFrom = (notBefore: number) => ({ notBefore, notAfter: notBefore + TOKEN_TTL_DEFAULT_SECONDS + 3600 });
const timesNow = () => timesFrom(Math.floor(Date.now() / 1000));

/** A connection key for a request, as the website makes it on Allow: a seed, the
 * statement, and the person's KEY's signature over it, one passkey prompt. */
function connectionKeyFor(
  person: Person,
  requestId: string,
  options: { seed?: Buffer | undefined; fields?: Partial<DelegationStatement>; signCount?: number; origin?: string } = {},
) {
  const seed = options.seed ?? randomBytes(32);
  const key = connectionPublicKey(seed).toString("hex");
  const statement = delegationStatementBytes({
    peerId: person.peerId, key, connection: requestId, ...timesNow(), ...options.fields,
  });
  const preimage = delegationPreimage(statement);
  const signature = person.kind === "ed25519"
    ? { alg: "ed25519", signature: sign(null, preimage, person.privateKey).toString("hex") }
    : {
        alg: "webauthn",
        ...passkeyAssertion(person, sha256(preimage), { rpId: RP_ID, origin: options.origin ?? SITE, signCount: options.signCount }),
      };
  return { body: { statement: statement.toString("base64url"), signature, seed: seed.toString("base64url") }, seed, key, statement };
}

/** The whole way through for one app, as far as its token, with a connection key unless told not to. */
async function connectApp(person: Person, options: { key?: boolean; seed?: Buffer; fields?: Partial<DelegationStatement> } = {}) {
  const clientId = await registerApp();
  const { requestId, verifier } = await startRequest(clientId);
  const made = options.key === false ? null : connectionKeyFor(person, requestId, { seed: options.seed, ...(options.fields ? { fields: options.fields } : {}) });
  const approved = await approve(person, requestId, made ? { connection_key: made.body } : undefined);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
  const issued = await trade({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: CONNECT });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { clientId, requestId, verifier, code, appToken: issued.body.access_token as string, made, kept: approved.body.connection_key as string };
}

/** One JSON-RPC call to a connector address, its answer parsed. */
async function rpc(at: string, name: string, args: unknown, bearer: string) {
  const res = await app.request(at, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: filedTool({ name, arguments: args }) }),
  });
  const text = await res.text();
  const parsed = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5))
    : text ? JSON.parse(text) : null;
  return { status: res.status, result: parsed?.result, body: parsed };
}

const postThrough = (appToken: string, args: Record<string, unknown>) => rpc("/mcp/connect", "schellingaf_post", args, appToken);

async function makeSpace(owner: { token: string }, options: Record<string, unknown> = {}) {
  const name = `ck-${randomUUID().slice(0, 8)}`;
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Connection keys", ...options });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const profile = await call("GET", `/v1/spaces/${name}`, owner.token);
  return { name, id: profile.body.space_id as string };
}

const vaultOf = async (appToken: string) =>
  (await fixture.owner<{ vault: Buffer; connection_key: Buffer; expires_at: Date }[]>`
    select vault, connection_key, expires_at from schellingaf.connection_vaults where token_hash = ${sha256(appToken)}`)[0];

const codeVaultOf = async (requestId: string) =>
  (await fixture.owner<{ connection_vault: Buffer | null }[]>`
    select connection_vault from schellingaf.oauth_requests where request_id = ${requestId}::uuid`)[0]?.connection_vault ?? null;

function runVerifier(input: unknown) {
  return spawnSync(process.execPath, [path.join(ROOT, "content", "verify-post.mjs"), "--rp-id", RP_ID, "--origin", SITE], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
}

const refusedAs = (error: unknown, detail?: RegExp) => {
  assert.ok(error instanceof ApiError, String(error));
  assert.equal(error.code, "INVALID_REQUEST");
  if (detail) assert.match(error.detail ?? "", detail);
  return true;
};

// ── the statement and the vault, with no service ───────────────────────────────

describe("the delegation statement", () => {
  const good: DelegationStatement = {
    peerId: "ab".repeat(32), key: "cd".repeat(32), connection: randomUUID(), notBefore: 1_900_000_000, notAfter: 1_907_779_600,
  };
  /** Canonical bytes of a value, so each case below is refused for its own fault alone. */
  const bytesOf = (o: unknown) => canonicalBytes(o);
  const raw = (overrides: Record<string, unknown> = {}) => ({
    connection: good.connection, key: good.key, not_after: good.notAfter, not_before: good.notBefore, peer_id: good.peerId, v: 1, ...overrides,
  });

  test("is canonical JSON of exactly six fields, and reads back as it was built", () => {
    const bytes = delegationStatementBytes(good);
    assert.equal(bytes.toString("utf8"), JSON.stringify(raw()), "the members are written in sorted order with no space");
    assert.deepEqual(readDelegationStatement(bytes), good);
    assert.deepEqual(delegationPreimage(bytes), Buffer.concat([Buffer.from("agent-state:connection-key:v1", "utf8"), Buffer.from([0]), bytes]));
  });

  test("refuses every statement that is not exactly its shape, naming the rule", () => {
    const cases: [string, Buffer, RegExp][] = [
      ["not UTF-8", Buffer.from([0xff, 0xfe]), /is not UTF-8/],
      ["not JSON", Buffer.from("{", "utf8"), /is not JSON/],
      ["whitespace", Buffer.from(JSON.stringify(raw(), null, 1), "utf8"), /not RFC 8785 canonical/],
      ["unsorted", Buffer.from(`{"v":1,${JSON.stringify(raw()).slice(1, -7)}}`, "utf8"), /not RFC 8785 canonical/],
      ["a list", bytesOf([raw()]), /is not a JSON object/],
      ["a field more", bytesOf(raw({ z: 1 })), /has exactly connection, key, not_after, not_before, peer_id and v/],
      ["a field fewer", bytesOf((({ v: _, ...rest }) => rest)(raw())), /has exactly/],
      ["version 2", bytesOf(raw({ v: 2 })), /\.v is 1/],
      ["peer id in capitals", bytesOf(raw({ peer_id: "AB".repeat(32) })), /peer_id is 64 lowercase hex/],
      ["peer id short", bytesOf(raw({ peer_id: "ab" })), /peer_id is 64 lowercase hex/],
      ["key a number", bytesOf(raw({ key: 7 })), /key is 64 lowercase hex/],
      ["connection in capitals", bytesOf(raw({ connection: good.connection.toUpperCase() })), /connection is a uuid in lowercase/],
      ["connection not a uuid", bytesOf(raw({ connection: "request-1" })), /connection is a uuid/],
      ["a client_id, which links KEYS that share an app", bytesOf(raw({ client_id: "https://app.example/client.json" })), /has exactly connection, key, not_after, not_before, peer_id and v/],
      ["not_after a fraction", bytesOf(raw({ not_after: 1_907_779_600.5 })), /not_after is whole seconds/],
      ["not_after negative", bytesOf(raw({ not_after: -1 })), /not_after is whole seconds/],
      ["not_after text", bytesOf(raw({ not_after: "1907779600" })), /not_after is whole seconds/],
      ["not_after before not_before", bytesOf(raw({ not_after: good.notBefore - 1 })), /not_after is whole seconds since 1970, after not_before/],
      ["not_before missing", bytesOf((({ not_before: _, ...rest }) => rest)(raw())), /has exactly/],
      ["not_before a fraction", bytesOf(raw({ not_before: 1.5 })), /not_before is whole seconds/],
      ["not_before zero", bytesOf(raw({ not_before: 0 })), /not_before is whole seconds/],
      ["too long", bytesOf(raw({ x: "x".repeat(600) })), /at most 512 bytes/],
    ];
    for (const [what, bytes, detail] of cases) {
      assert.throws(() => readDelegationStatement(bytes), (e) => refusedAs(e, detail), what);
    }
  });
});

describe("an approval's connection_key, checked before anything is kept", () => {
  const requestId = randomUUID();
  /** The approving KEY, an Ed25519 key pair made once for these checks. */
  const edPair = generateKeyPairSync("ed25519");

  /** An Ed25519 KEY's signer and its peer id, and a statement signed by it. */
  function edCase(fields: Partial<DelegationStatement> = {}, signWith?: (preimage: Buffer) => Buffer) {
    const { privateKey, publicKey } = edPair;
    const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
    const peerId = createHash("sha256").update(Buffer.from("agent-state:agent:v1", "utf8")).update(Buffer.from([0])).update(raw).digest();
    const seed = randomBytes(32);
    const statement = delegationStatementBytes({
      peerId: peerId.toString("hex"), key: connectionPublicKey(seed).toString("hex"), connection: requestId, ...timesNow(), ...fields,
    });
    const signature = (signWith ?? ((p) => sign(null, p, privateKey)))(delegationPreimage(statement));
    return {
      peerId,
      signer: { keyType: "ed25519" as const, publicKey: raw },
      body: { statement, envelope: { alg: "ed25519" as const, signature: signature.toString("hex") }, seed },
    };
  }

  const check = (c: ReturnType<typeof edCase>, overrides: Partial<Parameters<typeof checkConnectionKey>[0]> = {}) =>
    checkConnectionKey({ body: c.body, approver: c.peerId, signer: c.signer, request: { id: requestId }, passkeys: site, nowMs: Date.now(), ...overrides });

  test("one that holds is answered with what is kept", () => {
    const c = edCase();
    const out = check(c);
    assert.equal(out.statement.connection, requestId);
    assert.deepEqual(out.publicKey, connectionPublicKey(c.body.seed));
    assert.equal(out.signCount, null, "an Ed25519 KEY has no counter");
    assert.equal(out.statement.notAfter - out.statement.notBefore, STATEMENT_SECONDS);
  });

  test("each check refuses, in the order the statement is read", () => {
    const other = randomBytes(32);
    const cases: [string, () => unknown, RegExp][] = [
      ["another KEY's peer id", () => check(edCase({ peerId: "ab".repeat(32) })), /peer_id is not the peer id of the KEY allowing the app/],
      ["another request", () => check(edCase({ connection: randomUUID() })), /connection is not this request to connect/],
      ["a key that is not the seed's", () => check(edCase({ key: connectionPublicKey(other).toString("hex") })), /key is not the public key of connection_key.seed/],
      ["not_before over an hour ago", () => check(edCase(timesFrom(Math.floor(Date.now() / 1000) - NOT_BEFORE_PAST_SECONDS - 60))), /not_before is now/],
      ["not_before past the clock's slack", () => check(edCase(timesFrom(Math.floor(Date.now() / 1000) + NOT_BEFORE_FUTURE_SECONDS + 60))), /not_before is now/],
      ["not_after a second long", () => check(edCase({ notAfter: Math.floor(Date.now() / 1000) + STATEMENT_SECONDS + 1 })), /not_after is not_before, the token lifetime and one hour/],
      ["not_after short of the token", () => check(edCase(timesFrom(Math.floor(Date.now() / 1000) + NOT_AFTER_MIN_SECONDS - STATEMENT_SECONDS - 60))), /falls before a token minted now would expire/],
      ["a signer that is another KEY", () => check(edCase(), { signer: { keyType: "ed25519", publicKey: randomBytes(32) } }), /the KEY that signs does not hash to statement.peer_id/],
      ["a signature over other bytes", () => check(edCase({}, (p) => sign(null, Buffer.concat([p, Buffer.from("x")]), edPair.privateKey))), /connection_key.signature: the signature does not verify against this KEY/],
    ];
    for (const [what, run, detail] of cases) assert.throws(run, (e) => refusedAs(e, detail), what);
  });

  test("a passkey's signature is checked as at sign-in, its counter answered for the caller to move", () => {
    const pk = passkey();
    const peerId = createHash("sha256").update(Buffer.from("agent-state:passkey:v1", "utf8")).update(Buffer.from([0])).update(pk.spki).digest();
    const seed = randomBytes(32);
    const statement = delegationStatementBytes({
      peerId: peerId.toString("hex"), key: connectionPublicKey(seed).toString("hex"), connection: requestId, ...timesNow(),
    });
    const prompt = (extra: Partial<Parameters<typeof passkeyAssertion>[2]> = {}) =>
      ({ alg: "webauthn" as const, ...passkeyAssertion(pk, sha256(delegationPreimage(statement)), { rpId: RP_ID, origin: SITE, signCount: 7, ...extra }) });
    const run = (envelope: any, passkeys: typeof site | null = site) =>
      checkConnectionKey({ body: { statement, envelope, seed }, approver: peerId, signer: { keyType: "passkey", spki: pk.spki, algorithm: -7 }, request: { id: requestId }, passkeys, nowMs: Date.now() });
    assert.equal(run(prompt()).signCount, 7);
    assert.throws(() => run(prompt({ origin: "https://elsewhere.test" })), (e) => refusedAs(e, /connection_key.signature: client_data_json.origin is not an origin this service accepts/));
    assert.throws(() => run({ ...prompt(), client_data_json: Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "x", origin: SITE })).toString("base64url") }), (e) => refusedAs(e, /challenge is not the challenge sent/));
    assert.throws(() => run({ alg: "ed25519", signature: "00".repeat(64) }), (e) => refusedAs(e, /this KEY is a passkey, so alg is webauthn/));
    assert.throws(() => run(prompt(), null), (e) => e instanceof ApiError && e.code === "PASSKEYS_UNAVAILABLE");
  });

  test("the body is read strictly before any of it is checked", () => {
    const seed = randomBytes(32).toString("base64url");
    const statement = delegationStatementBytes({ peerId: "ab".repeat(32), key: "cd".repeat(32), connection: requestId, notBefore: 1, notAfter: 2 }).toString("base64url");
    const envelope = { alg: "ed25519", signature: "00".repeat(64) };
    const cases: [string, unknown, RegExp][] = [
      ["not an object", "x", /connection_key is an object of statement, signature and seed/],
      ["a field more", { statement, signature: envelope, seed, note: 1 }, /connection_key.note is not a field/],
      ["a statement that is not base64url", { statement: "a+b", signature: envelope, seed }, /connection_key.statement is the statement/],
      ["no signature", { statement, seed }, /connection_key.signature is the envelope/],
      ["an alg nobody signs with", { statement, signature: { alg: "rsa", signature: "00" }, seed }, /connection_key.signature: alg is ed25519 or webauthn/],
      ["a passkey field beside ed25519", { statement, signature: { ...envelope, credential_id: "AAAAAAAAAAAAAAAAAAAAAA" }, seed }, /credential_id belongs to a passkey signature/],
      ["an envelope field more", { statement, signature: { ...envelope, x: 1 }, seed }, /connection_key.signature.x is not a field of a ed25519 envelope/],
      ["a seed of 31 bytes", { statement, signature: envelope, seed: randomBytes(31).toString("base64url") }, /connection_key.seed is the connection key/],
      ["a padded seed", { statement, signature: envelope, seed: randomBytes(32).toString("base64") }, /connection_key.seed/],
    ];
    for (const [what, value, detail] of cases) assert.throws(() => readConnectionKeyBody(value), (e) => refusedAs(e, detail), what);
    const read = readConnectionKeyBody({ statement, signature: envelope, seed });
    assert.equal(read.seed.length, 32);
  });
});

describe("the vault", () => {
  test("opens with the secret and the additional data it was sealed with, and nothing else", () => {
    const seed = randomBytes(32);
    const secret = `schellingaf_${randomBytes(32).toString("hex")}`;
    const aad = sha256(secret);
    const vault = sealVault(secret, seed, aad);
    assert.equal(vault.length, 60);
    assert.deepEqual(openVault(secret, vault, aad), seed);
    assert.notDeepEqual(sealVault(secret, seed, aad), vault, "a fresh nonce every time");
    assert.equal(openVault(`${secret}0`, vault, aad), null, "another secret");
    assert.equal(openVault(secret, vault, sha256("other")), null, "other additional data");
    const flipped = Buffer.from(vault);
    flipped[20] = flipped[20]! ^ 1;
    assert.equal(openVault(secret, flipped, aad), null, "a changed byte");
    assert.equal(openVault(secret, vault.subarray(1), aad), null, "a vault of another length");
    assert.equal(vault.includes(seed), false, "the seed is not in the vault as it is");
    const requestId = randomUUID();
    assert.deepEqual(codeVaultData(requestId), uuidBytes(requestId));
  });

  test("the salt of a post with an idempotency key is the same each time, and the SPACE's and the key's own", () => {
    const seed = randomBytes(32);
    const space = randomUUID();
    assert.deepEqual(connectionSalt(seed, space, "k1"), connectionSalt(seed, space, "k1"));
    assert.notDeepEqual(connectionSalt(seed, space, "k1"), connectionSalt(seed, space, "k2"));
    assert.notDeepEqual(connectionSalt(seed, space, "k1"), connectionSalt(seed, randomUUID(), "k1"));
    assert.notDeepEqual(connectionSalt(seed, space, "k1"), connectionSalt(randomBytes(32), space, "k1"));
  });
});

// ── allowing an app ────────────────────────────────────────────────────────────

describe("allowing an app with a connection key", () => {
  test("without one, the app connects as before: no key, no vault, and its posts go unsigned", async () => {
    const person = await passkeyPerson();
    const { appToken, requestId, kept } = await connectApp(person, { key: false });
    assert.equal(kept, "none", "the answer says no key was kept");
    const [keys] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.connection_keys where request_id = ${requestId}::uuid`;
    assert.equal(keys!.n, 0);
    assert.equal(await vaultOf(appToken), undefined);
    const s = await makeSpace(person);
    const out = await postThrough(appToken, { space: s.name, kind: "obs", body: "unsigned, as before" });
    assert.equal(out.result.isError, undefined, JSON.stringify(out.body));
    assert.equal(out.result.structuredContent.signed, false);
    const strict = await makeSpace(person, { signed_only: true });
    const refused = await postThrough(appToken, { space: strict.name, kind: "obs", body: "refused" });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /^SIGNATURE_REQUIRED/);
  });

  test("with one, the key and its statement are kept, and its seed only sealed under the code, then under the token", async () => {
    const person = await passkeyPerson();
    const clientId = await registerApp();
    const { requestId, verifier } = await startRequest(clientId);
    const made = connectionKeyFor(person, requestId);
    const approved = await approve(person, requestId, { connection_key: made.body });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.decision, "approved");

    const [kept] = await fixture.owner<{ public_key: Buffer; peer_id: Buffer; statement: Buffer; signature: any; not_before: Date; not_after: Date }[]>`
      select public_key, peer_id, statement, signature, not_before, not_after from schellingaf.connection_keys where request_id = ${requestId}::uuid`;
    assert.equal(kept!.public_key.toString("hex"), made.key);
    assert.equal(kept!.peer_id.toString("hex"), person.peerId);
    assert.deepEqual(kept!.statement, made.statement, "the statement is kept byte for byte");
    assert.deepEqual(kept!.signature, made.body.signature);
    assert.equal(kept!.not_after.getTime(), readDelegationStatement(made.statement).notAfter * 1000);
    assert.equal(kept!.not_before.getTime(), readDelegationStatement(made.statement).notBefore * 1000);
    assert.equal(approved.body.connection_key, "kept", "the answer says the key was kept");

    const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
    const sealedUnderCode = await codeVaultOf(requestId);
    assert.ok(sealedUnderCode, "the code's vault is kept beside the code's hash");
    assert.deepEqual(openVault(code, sealedUnderCode, codeVaultData(requestId)), made.seed, "the code opens it");

    const issued = await trade({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const appToken = issued.body.access_token as string;
    assert.equal(await codeVaultOf(requestId), null, "the code's copy is deleted once it is traded");
    const vault = await vaultOf(appToken);
    assert.ok(vault, "the token's vault is kept beside the token's hash");
    assert.equal(vault.connection_key.toString("hex"), made.key);
    assert.deepEqual(openVault(appToken, vault.vault, sha256(appToken)), made.seed, "the token opens it");
    assert.equal(openVault(code, vault.vault, sha256(appToken)), null, "the code no longer does");
    const [token] = await fixture.owner<{ expires_at: Date }[]>`select expires_at from schellingaf.tokens where token_hash = ${sha256(appToken)}`;
    assert.equal(vault.expires_at.getTime(), token!.expires_at.getTime(), "the vault ends when its token does");
  });

  test("an Ed25519 KEY approving through the API signs its statement with ed25519", async () => {
    const person = await ed25519Person();
    const { appToken, made } = await connectApp(person);
    assert.equal((await vaultOf(appToken))?.connection_key.toString("hex"), made!.key);
  });

  test("a statement that does not hold is refused, the request stays open, and the person may still allow it", async () => {
    const person = await passkeyPerson();
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const refuse = async (body: unknown, detail: RegExp) => {
      const out = await approve(person, requestId, body);
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "INVALID_REQUEST");
      assert.match(out.body.error.detail ?? "", detail);
    };
    await refuse({ connection_key: connectionKeyFor(person, randomUUID()).body }, /connection is not this request/);
    await refuse({ connection_key: connectionKeyFor(person, requestId, { origin: "https://elsewhere.test" }).body }, /origin is not an origin this service accepts/);
    await refuse({ connection_key: connectionKeyFor(person, requestId).body, keep: true }, /keep is not a field of an approval/);
    const other = await passkeyPerson();
    await refuse({ connection_key: connectionKeyFor(other, requestId).body }, /peer_id is not the peer id of the KEY allowing the app/);
    const [kept] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.connection_keys where request_id = ${requestId}::uuid`;
    assert.equal(kept!.n, 0, "nothing was kept");
    assert.equal(await codeVaultOf(requestId), null);
    const read = await call("GET", `/v1/authorizations/${requestId}`, person.token);
    assert.equal(read.body.state, "pending");
    assert.equal((await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId).body })).status, 200);
  });

  test("a passkey whose counter counts and did not move is refused, as a copied authenticator is at sign-in", async () => {
    const person = await passkeyPerson(10);
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const out = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { signCount: 3 }).body });
    assert.equal(out.body.error?.code, "INVALID_REQUEST");
    assert.match(out.body.error.detail, /the signature counter of this passkey did not advance/);
    const moved = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { signCount: 11 }).body });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const [counter] = await fixture.owner<{ sign_count: string }[]>`
      select sign_count::text from schellingaf.passkeys where credential_id = ${person.kind === "passkey" ? person.credentialId : Buffer.alloc(0)}`;
    assert.equal(counter!.sign_count, "11");
  });

  test("one connection key is never another connection's, and a decided request takes none", async () => {
    const person = await passkeyPerson();
    const seed = randomBytes(32);
    const first = await connectApp(person, { seed });
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const again = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { seed }).body });
    assert.equal(again.body.error?.code, "INVALID_REQUEST");
    assert.match(again.body.error.detail ?? "", /the key of another connection already/);
    const decided = await approve(person, first.requestId, { connection_key: connectionKeyFor(person, first.requestId).body });
    assert.equal(decided.body.error?.code, "AUTHORIZATION_DECIDED");
  });

  test("one key sent for several requests at once is kept for one, and every other is refused, never an INTERNAL", async () => {
    const person = await ed25519Person();
    const seed = randomBytes(32);
    const requests = await Promise.all(Array.from({ length: 8 }, async () => (await startRequest(await registerApp())).requestId));
    const answers = await Promise.all(requests.map((requestId) => approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { seed }).body })));
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 400, 400, 400, 400, 400, 400, 400], JSON.stringify(answers.map((a) => a.body)));
    for (const refused of answers.filter((a) => a.status === 400)) {
      assert.equal(refused.body.error.code, "INVALID_REQUEST");
      assert.match(refused.body.error.detail, /the key of another connection already/);
    }
    const [n] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.connection_keys where public_key = ${connectionPublicKey(seed)}`;
    assert.equal(n!.n, 1);
  });

  test("a statement made more than a minute ahead of the service's clock is refused", async () => {
    const person = await passkeyPerson();
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const ahead = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { fields: timesFrom(Math.floor(Date.now() / 1000) + 90) }).body });
    assert.equal(ahead.body.error?.code, "INVALID_REQUEST");
    assert.match(ahead.body.error.detail ?? "", /not_before is now/);
    const behind = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { fields: timesFrom(Math.floor(Date.now() / 1000) - 50 * 60) }).body });
    assert.equal(behind.status, 200, "within the hour behind is still taken");
  });

  test("a KEY's own key is never a connection key, so the service never holds a KEY's seed", async () => {
    const person = await ed25519Person();
    if (person.kind !== "ed25519") throw new Error("an Ed25519 KEY");
    const ownSeed = Buffer.from(person.privateKey.export({ format: "jwk" }).d!, "base64url");
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const out = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { seed: ownSeed }).body });
    assert.equal(out.body.error?.code, "INVALID_REQUEST");
    assert.match(out.body.error.detail ?? "", /is a KEY of its own/);
    assert.equal(await codeVaultOf(requestId), null);
  });

  test("a connection key is a record nothing changes, and nothing deletes while anything names it or can sign with it", async () => {
    const person = await passkeyPerson();
    const { made, appToken, requestId } = await connectApp(person);
    const key = Buffer.from(made!.key, "hex");
    const gone = async () => (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.connection_keys where public_key = ${key}`)[0]!.n === 0;
    await assert.rejects(fixture.owner`update schellingaf.connection_keys set created_at = created_at where public_key = ${key}`, /IMMUTABLE_RECORD/);
    // Its request is still kept, and its token holds its vault.
    await assert.rejects(fixture.owner`delete from schellingaf.connection_keys where public_key = ${key}`, /IMMUTABLE_RECORD/);
    await fixture.owner`delete from schellingaf.oauth_requests where request_id = ${requestId}::uuid`;
    await assert.rejects(fixture.owner`delete from schellingaf.connection_keys where public_key = ${key}`, /IMMUTABLE_RECORD/, "a vault still names it");
    // A post it signed names it for good.
    const s = await makeSpace(person);
    assert.equal((await postThrough(appToken, { space: s.name, kind: "obs", body: "named for good" })).result.structuredContent.signed, true);
    assert.equal((await send(app, "DELETE", `/v1/tokens/${sha256(appToken).toString("hex")}`, person.token)).status, 204);
    await assert.rejects(fixture.owner`delete from schellingaf.connection_keys where public_key = ${key}`, /IMMUTABLE_RECORD/, "a post names it");
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.equal(await gone(), false, "the prune deleted a key a post names");
  });

  test("the hourly prune deletes a key no post names, once its request is gone and no vault holds it", async () => {
    const person = await passkeyPerson();
    const gone = async (key: string) => (await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.connection_keys where public_key = ${Buffer.from(key, "hex")}`)[0]!.n === 0;
    const age = (requestId: string) => fixture.owner`update schellingaf.oauth_requests set created_at = now() - interval '2 days' where request_id = ${requestId}::uuid`;

    // Allowed, and the code never traded.
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const untraded = connectionKeyFor(person, requestId);
    assert.equal((await approve(person, requestId, { connection_key: untraded.body })).status, 200);
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.equal(await gone(untraded.key), false, "a request still kept could still mint the token");
    await age(requestId);
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.equal(await gone(untraded.key), true);

    // Traded, its request gone, and its token revoked before it signed anything.
    const traded = await connectApp(person);
    await age(traded.requestId);
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.equal(await gone(traded.made!.key), false, "a vault still holds it");
    assert.equal((await send(app, "DELETE", `/v1/tokens/${sha256(traded.appToken).toString("hex")}`, person.token)).status, 204);
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.equal(await gone(traded.made!.key), true);
    // And the KEY that allowed it may allow another app with a new key at once.
    assert.equal((await connectApp(person)).kept, "kept");
  });
});

// ── posting through the connection ────────────────────────────────────────────

describe("a post through an app connection with a key", () => {
  let person: Person;
  let connection: Awaited<ReturnType<typeof connectApp>>;
  let space: { name: string; id: string };

  before(async () => {
    person = await passkeyPerson();
    connection = await connectApp(person);
    space = await makeSpace(person);
  });

  test("is signed with the connection key, and every reader verifies it, the statement and the author's passkey with it", async () => {
    const out = await postThrough(connection.appToken, {
      space: space.name, kind: "result", title: "Signed through the app", body: "The connection signed this.",
      fingerprints: [{ scheme: "git.commit", value: "abc1234" }], idempotency_key: "first",
    });
    assert.equal(out.result.isError, undefined, JSON.stringify(out.body));
    assert.equal(out.result.structuredContent.signed, true);
    assert.ok(out.result.content[0].text.split("\n").includes(RECEIPT_WORDS), out.result.content[0].text);
    assert.equal(out.result.structuredContent.signed_by, "connection");

    const one = await call("GET", `/v1/posts/${out.result.structuredContent.post_id}`, person.token);
    const sig = one.body.proof.signature;
    assert.equal(sig.alg, "connection");
    assert.equal(sig.connection_key, connection.made!.key);
    assert.match(sig.signature, /^[0-9a-f]{128}$/);
    assert.equal(sig.delegation.statement, connection.made!.body.statement);
    assert.deepEqual(sig.delegation.signature, connection.made!.body.signature);
    assert.equal(sig.public_key, person.kind === "passkey" ? person.spki.toString("base64url") : null);
    assert.equal(sig.key_algorithm, "ES256");
    const object = JSON.parse(Buffer.from(one.body.proof.canonical, "base64url").toString("utf8"));
    // The agent's own key stays its own: the object carries one drawn from it under the
    // connection's seed, the same for a retry.
    assert.notEqual(object.idempotency_key, "first");
    assert.equal(object.idempotency_key, connectionIdempotencyKey(connection.made!.seed, space.id, "first"));

    assert.deepEqual(verifyPost(one.body, site), []);
    const checked = runVerifier(one.body);
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /the connection key's signature verifies/);
    assert.match(checked.stdout, /the ES256 passkey signature verifies/);
    assert.match(checked.stdout, /note signed through an app connection: the author's KEY allowed this connection key for one request from not_before until not_after/);

    // The connector's own reading of it says the same, with its proof when asked for it,
    // and without it from what the post itself says.
    const read = await rpc("/mcp/connect", "schellingaf_get", { post_id: one.body.post_id, proof: true }, connection.appToken);
    assert.match(read.result.content[0].text, /signed through an app connection its author's KEY allowed \(connection\)/);
    const slim = await rpc("/mcp/connect", "schellingaf_get", { post_id: one.body.post_id }, connection.appToken);
    assert.equal(slim.result.structuredContent.proof, undefined);
    assert.match(slim.result.content[0].text, /signed through an app connection its author's KEY allowed, object_id /);
  });

  test("a SPACE that takes signed posts only takes it", async () => {
    const strict = await makeSpace(person, { signed_only: true });
    const out = await postThrough(connection.appToken, { space: strict.name, kind: "obs", body: "into a signed-only SPACE" });
    assert.equal(out.result.isError, undefined, JSON.stringify(out.body));
    assert.equal(out.result.structuredContent.signed, true);
  });

  test("the agent's idempotency key is never published: the object's is drawn from it, per SPACE, and a new post's is fresh", async () => {
    const other = await makeSpace(person);
    const key = `private-${randomUUID()}`;
    const a = await postThrough(connection.appToken, { space: space.name, kind: "obs", body: "one", idempotency_key: key });
    const b = await postThrough(connection.appToken, { space: other.name, kind: "obs", body: "one", idempotency_key: key });
    const objectOf = async (out: any) => {
      const one = await call("GET", `/v1/posts/${out.result.structuredContent.post_id}`, person.token);
      return JSON.parse(Buffer.from(one.body.proof.canonical, "base64url").toString("utf8")) as Record<string, string>;
    };
    const [x, y] = [await objectOf(a), await objectOf(b)];
    assert.match(x.idempotency_key!, /^[0-9a-f]{64}$/);
    assert.notEqual(x.idempotency_key, y.idempotency_key, "two SPACES, two keys: one cannot be matched to the other");
    for (const object of [x, y]) assert.equal(JSON.stringify(object).includes(key), false, "the agent's key is in the object");
    const proofs = await Promise.all([a, b].map((out) => call("GET", `/v1/posts/${out.result.structuredContent.post_id}`, person.token)));
    for (const proof of proofs) assert.deepEqual(verifyPost(proof.body, site), []);
    // With no key given, the object carries a fresh uuid, as before.
    const none = await postThrough(connection.appToken, { space: space.name, kind: "obs", body: "no key" });
    assert.match((await objectOf(none)).idempotency_key!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("a retry with the same idempotency key is the same bytes and replays, data, budget and run_id included", async () => {
    const args = {
      space: space.name, kind: "result", body: "Retried", data: { x_attempt: 1 }, run_id: randomUUID(),
      budget: { observed_at: "2026-10-02T10:00:00Z", output_tokens: { remaining: "4000", unit: "token", estimated: true } },
      idempotency_key: `retry-${randomUUID()}`,
    };
    const first = await postThrough(connection.appToken, args);
    assert.equal(first.result.isError, undefined, JSON.stringify(first.body));
    const second = await postThrough(connection.appToken, args);
    assert.equal(second.result.isError, undefined, JSON.stringify(second.body));
    assert.equal(second.result.structuredContent.replayed, true);
    assert.equal(second.result.structuredContent.post_id, first.result.structuredContent.post_id);
    const one = await call("GET", `/v1/posts/${first.result.structuredContent.post_id}`, person.token);
    assert.deepEqual(one.body.data, { x_attempt: 1 });
    assert.equal(typeof one.body.proof.private, "string", "a member is shown the private part");
    assert.deepEqual(verifyPost(one.body, site), []);
    assert.equal(runVerifier(one.body).status, 0);
    // The same key with other words is a different post.
    const conflict = await postThrough(connection.appToken, { ...args, body: "Other words" });
    assert.match(conflict.result.content[0].text, /^IDEMPOTENCY_CONFLICT/);
  });

  test("a post with no idempotency key is a new post each time, and a sealed one or one the agent signed is not signed here", async () => {
    const a = await postThrough(connection.appToken, { space: space.name, kind: "obs", body: "twice" });
    const b = await postThrough(connection.appToken, { space: space.name, kind: "obs", body: "twice" });
    assert.notEqual(a.result.structuredContent.post_id, b.result.structuredContent.post_id);
    assert.equal(b.result.structuredContent.signed, true);
    // Asked to seal: refused before anything is sent, as before.
    const sealed = await postThrough(connection.appToken, { space: space.name, kind: "obs", body: "x", sealed: true });
    assert.match(sealed.result.content[0].text, /^SEALED_NEEDS_BRIDGE/);
    // Fields of a signed post the agent made itself go as they are, and the route judges them.
    const own = await postThrough(connection.appToken, { space: space.name, kind: "obs", alg: "ed25519", signature: "00".repeat(64) });
    assert.match(own.result.content[0].text, /^INVALID_REQUEST.*alg belongs to a signed post/);
  });

  test("an export of the SPACE verifies whole, as the service's own mirror verifier reads it", async () => {
    const res = await send(app, "GET", `/v1/spaces/${space.name}/posts`, person.token, undefined, { accept: "application/x-ndjson" });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const posts = lines.filter((l) => l.cursor === undefined);
    assert.ok(posts.some((p) => p.proof.signature?.alg === "connection"));
    assert.deepEqual(verifyPostRun(posts, site, null), []);
  });

  test("posts: each item is signed with the connection key but one replying by key, task rides beside, and a resend replays", async () => {
    const work = await makeSpace(person);
    assert.equal((await call("POST", `/v1/spaces/${work.name}/tasks`, person.token, { title: "Check it", body: "Say what failed." })).status, 201);
    const taken = await call("POST", `/v1/spaces/${work.name}/tasks/next`, person.token, {});
    const number = taken.body.task.number as number;
    const callKey = `batch-${randomUUID()}`;
    const args = {
      space: work.name, idempotency_key: callKey,
      posts: [
        { key: "a", kind: "result", title: "Result", body: "It holds.", task: { number } },
        { kind: "obs", title: "A note", body: "Beside it." },
        { kind: "obs", title: "A reply", body: "To the result.", reply_to: "a" },
      ],
    };
    const out = await postThrough(connection.appToken, args);
    assert.equal(out.result.isError, undefined, JSON.stringify(out.body));
    const items = out.result.structuredContent.posts;
    assert.deepEqual(items.map((p: any) => p.signed), [true, true, false]);
    assert.ok(["done", "accepted"].includes(items[0].task.state), JSON.stringify(items[0]));
    const text = out.result.content[0].text.split("\n");
    assert.ok(text.includes(`posts[2]: ${items[2].post_id} at seq ${items[2].seq}, unsigned`), text.join("\n"));
    assert.ok(text.some((line: string) => line.startsWith("posts[0] (a): ") && line.includes("signed with this app connection's key; task")), text.join("\n"));
    // Each signed item's key is drawn from the call's and its own, or its place.
    for (const [i, expected] of [[0, `${callKey}:a`], [1, `${callKey}:1`]] as const) {
      const one = await call("GET", `/v1/posts/${items[i].post_id}`, person.token);
      assert.equal(one.body.proof.signature.alg, "connection");
      assert.equal(JSON.parse(Buffer.from(one.body.proof.canonical, "base64url").toString("utf8")).idempotency_key, connectionIdempotencyKey(connection.made!.seed, work.id, expected));
      assert.deepEqual(verifyPost(one.body, site), []);
    }
    assert.equal((await call("GET", `/v1/posts/${items[2].post_id}`, person.token)).body.reply_to, items[0].post_id);
    const again = await postThrough(connection.appToken, args);
    assert.equal(again.result.isError, undefined, JSON.stringify(again.body));
    assert.equal(again.result.structuredContent.replayed, true);
    assert.deepEqual(again.result.structuredContent.posts.map((p: any) => p.post_id), items.map((p: any) => p.post_id));
  });

  test("a single POST's task rides beside what the connection signs, and no hint is read there", async () => {
    const work = await makeSpace(person);
    assert.equal((await call("POST", `/v1/spaces/${work.name}/tasks`, person.token, { title: "Check it", body: "Say what failed." })).status, 201);
    const number = (await call("POST", `/v1/spaces/${work.name}/tasks/next`, person.token, {})).body.task.number as number;
    const reference = [{ scheme: "task.reference", value: `${work.name}/${number}` }];
    // No task: it lands, and at /mcp/connect nothing is said of the task, which it never
    // drops, and the task list is not read.
    let progress!: Awaited<ReturnType<typeof postThrough>>;
    const reads = await requestsDuring((method, path) => method === "GET" && path === `/v1/spaces/${work.name}/tasks`, async () => {
      progress = await postThrough(connection.appToken, { space: work.name, kind: "obs", title: "Halfway", body: "Half.", fingerprints: reference });
    });
    assert.equal(reads, 0, "a hint was read at /mcp/connect");
    assert.equal(progress.result.isError, undefined, JSON.stringify(progress.body));
    assert.ok(!progress.result.content[0].text.includes("is still yours"), progress.result.content[0].text);
    const out = await postThrough(connection.appToken, { space: work.name, kind: "result", title: "Done", body: "Done.", fingerprints: reference, task: { number } });
    assert.equal(out.result.isError, undefined, JSON.stringify(out.body));
    assert.equal(out.result.structuredContent.signed, true);
    assert.ok(["done", "accepted"].includes(out.result.structuredContent.task.state), JSON.stringify(out.result.structuredContent));
  });

  // expect_sha256 and upload true (migrations/0146_exact_uploads.sql) through a connection
  // that signs: the signed body is rebuilt from named fields, so both are carried beside it.
  test("expect_sha256 through a signing connection is checked, with files, with attachments empty or left out, and on a posts item", async () => {
    const work = await makeSpace(person);
    const sha = (b: string) => createHash("sha256").update(b).digest("hex");
    const text = `exact through the app ${randomUUID()}\n`;
    const file = { name: "f.txt", media_type: "text/plain", text };
    const ok = await postThrough(connection.appToken, { space: work.name, kind: "obs", body: "x", attachments: [file], expect_sha256: [sha(text)] });
    assert.equal(ok.result.isError, undefined, JSON.stringify(ok.body));
    assert.equal(ok.result.structuredContent.signed, true);
    assert.equal(ok.result.structuredContent.expect_sha256, "matched");
    assert.ok(ok.result.content[0].text.split("\n").includes("expect_sha256: matched"));
    const typed = { ...file, text: text.replace("exact", "exacT") };
    const wrong = await postThrough(connection.appToken, { space: work.name, kind: "obs", body: "x", attachments: [typed], expect_sha256: [sha(text)] });
    assert.equal(wrong.result.isError, true);
    assert.match(wrong.result.content[0].text, /^ATTACHMENT_MISMATCH\. /);
    // No files: refused when it names one, whether attachments is empty or left out.
    for (const attachments of [undefined, []]) {
      const out = await postThrough(connection.appToken, { space: work.name, kind: "obs", body: "x", expect_sha256: [sha(text)], ...(attachments ? { attachments } : {}) });
      assert.match(out.result.content[0].text, /^ATTACHMENT_MISMATCH\. .*\(expect_sha256 names 1 file; attachments has 0\)/);
    }
    // Naming none: the route checks it beside the signed body, and says so.
    const empty = await postThrough(connection.appToken, { space: work.name, kind: "obs", body: "x", attachments: [], expect_sha256: [] });
    assert.equal(empty.result.isError, undefined, JSON.stringify(empty.body));
    assert.equal(empty.result.structuredContent.signed, true);
    assert.equal(empty.result.structuredContent.expect_sha256, "matched");
    // A posts item sends no files.
    const batch = await postThrough(connection.appToken, { space: work.name, posts: [{ kind: "obs", title: "x", body: "x", expect_sha256: [sha(text)] }] });
    assert.match(batch.result.content[0].text, /^ATTACHMENT_MISMATCH\. .*\(posts\[0\]: expect_sha256 names 1 file; attachments has 0\)/);
    const items = await postThrough(connection.appToken, { space: work.name, posts: [{ kind: "obs", title: "x", body: "x", expect_sha256: [] }] });
    assert.equal(items.result.isError, undefined, JSON.stringify(items.body));
    assert.equal(items.result.structuredContent.posts[0].signed, true);
    assert.equal(items.result.structuredContent.posts[0].expect_sha256, "matched");
  });

  test("upload true with every file held posts at once, signed by the app connection where allowed", async () => {
    const work = await makeSpace(person);
    const sha = (b: string) => createHash("sha256").update(b).digest("hex");
    const held = `held already ${randomUUID()}\n`;
    const put = (authorization: string, content: string) => app.request(`/v1/spaces/${work.name}/files/${sha(content)}`, {
      method: "PUT", headers: { authorization, "content-length": String(Buffer.byteLength(content)) }, body: content,
    });
    assert.equal((await put(`Bearer ${person.token}`, held)).status, 201);
    const once = await postThrough(connection.appToken, {
      space: work.name, kind: "obs", body: "x", upload: true, expect_sha256: [sha(held)],
      attachments: [{ sha256: sha(held), name: "h.txt", media_type: "text/plain" }],
    });
    assert.equal(once.result.isError, undefined, JSON.stringify(once.body));
    assert.equal(once.result.structuredContent.signed, true);
    assert.equal(once.result.structuredContent.expect_sha256, "matched");
    // A file not held: a command, bound to the app's token, then the same call posts, signed.
    const missing = `on the agent's machine ${randomUUID()}\n`;
    const args = {
      space: work.name, kind: "obs", body: "y", upload: true, idempotency_key: `up-${randomUUID()}`,
      attachments: [{ sha256: sha(missing), name: "m.txt", media_type: "text/plain" }],
    };
    const asked = await postThrough(connection.appToken, args);
    assert.equal(asked.result.isError, undefined, JSON.stringify(asked.body));
    const authorization = asked.result.structuredContent.uploads[0].authorization as string;
    const [grant] = await fixture.owner<{ token_hash: Buffer }[]>`
      select token_hash from schellingaf.file_upload_grants where grant_hash = ${sha256(authorization.slice("Bearer ".length))}`;
    assert.deepEqual(grant!.token_hash, sha256(connection.appToken));
    assert.equal((await put(authorization, missing)).status, 201);
    const posted = await postThrough(connection.appToken, args);
    assert.equal(posted.result.isError, undefined, JSON.stringify(posted.body));
    assert.equal(posted.result.structuredContent.signed, true);
    assert.equal(posted.result.structuredContent.attachments[0].sha256, sha(missing));
  });

  test("an app allowed only to read asks for no upload authorization", async () => {
    const clientId = await registerApp();
    const { requestId, verifier } = await startRequest(clientId, "read");
    const approved = await approve(person, requestId);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
    const issued = await trade({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: CONNECT });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const before = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.file_upload_grants where token_hash = ${sha256(issued.body.access_token)}`;
    const out = await postThrough(issued.body.access_token, {
      space: space.name, kind: "obs", body: "x", upload: true,
      attachments: [{ sha256: "ab".repeat(32), name: "r.txt", media_type: "text/plain" }],
    });
    assert.equal(out.status, 403, JSON.stringify(out.body));
    const after = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.file_upload_grants where token_hash = ${sha256(issued.body.access_token)}`;
    assert.equal(after[0]!.n, before[0]!.n);
  });

  test("the tool takes no alg but ed25519 from an agent, so connection cannot be named through it", async () => {
    const out = await postThrough(connection.appToken, { space: space.name, kind: "obs", alg: "connection", canonical: "e30", signature: "00".repeat(64) });
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0].text, /^INVALID_REQUEST/);
  });
});

describe("alg connection from anywhere but the connector, for its own connection", () => {
  test("is refused from /v1, from the connector at /mcp, and from another connection's token", async () => {
    const person = await passkeyPerson();
    const a = await connectApp(person);
    const b = await connectApp(person);
    const s = await makeSpace(person);
    // A post signed with a's key, correctly, by somebody who holds a's seed.
    const built = buildPostObject({
      spaceId: s.id, author: person.peerId, idempotencyKey: `forged-${randomUUID()}`, kind: "obs", title: "A signed POST in a test", body: "forged",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    const body = {
      canonical: built.canonical.toString("base64url"), alg: "connection",
      signature: sign(null, signaturePreimageOf(built.objectId), createEd25519Key(a.made!.seed)).toString("hex"),
      connection_key: a.made!.key,
    };
    const direct = await call("POST", `/v1/spaces/${s.name}/posts`, person.token, body);
    assert.equal(direct.body.error?.code, "POST_SIGNATURE_INVALID");
    assert.match(direct.body.error.detail, /alg connection is signed by the connector alone/);

    // As the connector's own call for b's token, naming a's key: the key is not b's.
    const bearer = await classifyBearer(db, `Bearer ${b.appToken}`, "127.0.0.1", CONNECT);
    assert.equal(bearer.state, "valid");
    const forged = await read(await app.request(`/v1/spaces/${s.name}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${b.appToken}` },
      body: JSON.stringify(body),
    }, { schellingafReentry: { bearer, addr: "127.0.0.1", connectionKey: Buffer.from(a.made!.key, "hex") } }));
    assert.equal(forged.body.error?.code, "POST_SIGNATURE_INVALID");
    assert.match(forged.body.error.detail, /not the one the connection of this token holds/);
    // And for b's token naming b's key while carrying a's: the marker must name the key sent.
    const mismatched = await read(await app.request(`/v1/spaces/${s.name}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${b.appToken}` },
      body: JSON.stringify(body),
    }, { schellingafReentry: { bearer, addr: "127.0.0.1", connectionKey: Buffer.from(b.made!.key, "hex") } }));
    assert.equal(mismatched.body.error?.code, "POST_SIGNATURE_INVALID");
    const [n] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.posts where space_id = ${s.id}::uuid`;
    assert.equal(n!.n, 0, "nothing was written");

    // A KEY's own token at /mcp holds no vault: its posts go as they always did.
    const own = await rpc("/mcp", "schellingaf_post", { space: s.name, kind: "obs", body: "from /mcp" }, person.token);
    assert.equal(own.result.structuredContent.signed, false);
  });

  test("the database refuses a key that is not the author's, a statement that ran out, and a key on any other alg", async () => {
    const person = await passkeyPerson();
    const other = await passkeyPerson();
    const s = await makeSpace(person);
    const seed = randomBytes(32);
    const key = connectionPublicKey(seed);
    const insertKey = async (peer: string, notAfter: string) => fixture.owner`
      insert into schellingaf.connection_keys (public_key, peer_id, request_id, not_before, not_after, statement, signature)
      values (${key}, ${Buffer.from(peer, "hex")}, ${randomUUID()}::uuid, now() - interval '1 hour', ${notAfter}::timestamptz,
              ${Buffer.alloc(64, 1)}, ${fixture.owner.json({ alg: "ed25519", signature: "00".repeat(64) })})`;
    const append = async (alg: string, connectionKey: Buffer | null) => {
      const built = buildPostObject({
        spaceId: s.id, author: person.peerId, idempotencyKey: `sql-${randomUUID()}`, kind: "obs", title: "A signed POST in a test", body: "x",
        to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
      });
      return fixture.owner`
        select schellingaf.append_post(p_space_name => ${s.name}, p_author => ${Buffer.from(person.peerId, "hex")}, p_kind => 'obs',
          p_title => null::text, p_body => 'x', p_data => null::jsonb, p_budget => null::jsonb, p_to => '{}'::bytea[],
          p_run_id => null::uuid, p_reply_to => null::uuid, p_supersedes => null::uuid, p_retracts => null::uuid,
          p_fingerprints => '[]'::jsonb, p_idempotency_key => ${JSON.parse(built.canonical.toString()).idempotency_key},
          p_canonical => ${built.canonical}, p_alg => ${alg},
          p_signature => ${sign(null, signaturePreimageOf(built.objectId), createEd25519Key(seed))},
          p_connection_key => ${connectionKey}::bytea)`;
    };
    await insertKey(other.peerId, "2100-01-01T00:00:00Z");
    await assert.rejects(append("connection", key), /POST_SIGNATURE_INVALID/, "another KEY's connection key");
    await assert.rejects(append("ed25519", key), /OBJECT_MISMATCH/, "a key named beside another alg");
    await assert.rejects(append("connection", null), /OBJECT_MISMATCH/, "alg connection naming no key");
    const seed2 = randomBytes(32);
    const key2 = connectionPublicKey(seed2);
    await fixture.owner`
      insert into schellingaf.connection_keys (public_key, peer_id, request_id, not_before, not_after, statement, signature)
      values (${key2}, ${Buffer.from(person.peerId, "hex")}, ${randomUUID()}::uuid, now() - interval '1 hour', now() - interval '1 second',
              ${Buffer.alloc(64, 1)}, ${fixture.owner.json({ alg: "ed25519", signature: "00".repeat(64) })})`;
    await assert.rejects(append("connection", key2), /POST_SIGNATURE_INVALID/, "a statement that ran out");
  });
});

/** An Ed25519 private key from a 32-byte seed, as a connection key is made. */
function createEd25519Key(seed: Buffer) {
  return createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
}

// ── the vault ends ─────────────────────────────────────────────────────────────

describe("a connection's vault ends with its token", () => {
  test("revoking the token by its id, or every token of the KEY, deletes the vault, and the posts it signed still verify", async () => {
    const person = await passkeyPerson();
    const one = await connectApp(person);
    const s = await makeSpace(person);
    const posted = await postThrough(one.appToken, { space: s.name, kind: "obs", body: "before the revocation" });
    assert.equal(posted.result.structuredContent.signed, true);
    assert.ok(await vaultOf(one.appToken));
    const revoked = await send(app, "DELETE", `/v1/tokens/${sha256(one.appToken).toString("hex")}`, person.token);
    assert.equal(revoked.status, 204);
    assert.equal(await vaultOf(one.appToken), undefined, "revoking the token left its vault");
    const after = await postThrough(one.appToken, { space: s.name, kind: "obs", body: "after" });
    assert.equal(after.status, 401, "a revoked connection posts nothing");
    const old = await call("GET", `/v1/posts/${posted.result.structuredContent.post_id}`, person.token);
    assert.equal(old.body.proof.signature.alg, "connection");
    assert.deepEqual(verifyPost(old.body, site), [], "a post signed before the revocation still verifies");

    const two = await connectApp(person);
    const three = await connectApp(person);
    assert.ok(await vaultOf(two.appToken));
    assert.equal((await send(app, "DELETE", "/v1/tokens", person.token)).status, 204);
    assert.equal(await vaultOf(two.appToken), undefined);
    assert.equal(await vaultOf(three.appToken), undefined);
  });

  test("a code traded again after the grace revokes its token, and the vault with it", async () => {
    const person = await passkeyPerson();
    const c = await connectApp(person);
    assert.ok(await vaultOf(c.appToken));
    await fixture.owner`update schellingaf.oauth_requests set redeemed_at = now() - make_interval(secs => ${REPLAY_GRACE_SECONDS + 1})
                          where request_id = ${c.requestId}::uuid`;
    const again = await trade({ grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, client_id: c.clientId, code_verifier: c.verifier });
    assert.equal(again.body.error, "invalid_grant");
    assert.equal(await vaultOf(c.appToken), undefined);
    assert.equal(await codeVaultOf(c.requestId), null);
  });

  test("the hourly prune deletes the vault of a token that expired, and of a code that expired untraded", async () => {
    const person = await passkeyPerson();
    const c = await connectApp(person);
    await fixture.owner`update schellingaf.tokens set expires_at = now() - interval '1 second' where token_hash = ${sha256(c.appToken)}`;
    await fixture.owner`update schellingaf.connection_vaults set expires_at = now() - interval '1 second' where token_hash = ${sha256(c.appToken)}`;
    await fixture.owner`select schellingaf.prune_tokens()`;
    assert.equal(await vaultOf(c.appToken), undefined);

    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    assert.equal((await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId).body })).status, 200);
    assert.ok(await codeVaultOf(requestId));
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.ok(await codeVaultOf(requestId), "a code still live keeps its vault");
    await fixture.owner`update schellingaf.oauth_requests set code_expires_at = now() - interval '1 second' where request_id = ${requestId}::uuid`;
    await fixture.owner`select schellingaf.prune_oauth()`;
    assert.equal(await codeVaultOf(requestId), null);
  });
});

// ── nothing at rest opens a vault ──────────────────────────────────────────────

describe("the connection key's seed is kept nowhere it can be read", () => {
  test("a canary in its place appears in no column of any table, and in no line of the request log, at any step", async () => {
    const canary = Buffer.from("CANARY-connection-seed-87654321!", "utf8");
    assert.equal(canary.length, 32);
    const forms = [canary.toString("utf8"), canary.toString("hex"), canary.toString("base64url"), canary.toString("base64")];
    const nowhere = async (step: string) => {
      for (const form of forms) assert.deepEqual(await sweep(fixture.owner, form), [], `${step}: the seed is at rest as ${form}`);
    };
    const person = await passkeyPerson();
    const clientId = await registerApp();
    const { requestId, verifier } = await startRequest(clientId);
    const made = connectionKeyFor(person, requestId, { seed: canary });
    const approved = await approve(person, requestId, { connection_key: made.body });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    // The search finds what is kept: the statement, and the connection key in it.
    assert.ok((await sweep(fixture.owner, made.key)).includes("connection_keys.statement"), "the sweep finds nothing, so it proves nothing");
    await nowhere("approved");
    const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
    const issued = await trade({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
    const appToken = issued.body.access_token as string;
    await nowhere("traded");
    const s = await makeSpace(person);
    const posted = await postThrough(appToken, { space: s.name, kind: "obs", body: "signed by the canary", data: { x_n: 1 }, idempotency_key: "canary" });
    assert.equal(posted.result.structuredContent.signed, true, JSON.stringify(posted.body));
    await nowhere("posted");
    assert.equal((await send(app, "DELETE", `/v1/tokens/${sha256(appToken).toString("hex")}`, person.token)).status, 204);
    await nowhere("revoked");

    await new Promise((r) => setTimeout(r, 100));
    const logged = readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n");
    assert.ok(logged.length > 0, "the request log wrote nothing to check");
    for (const form of forms) assert.equal(logged.includes(form), false, `the request log holds the seed as ${form}`);
  });
});

// ── two verifiers, one verdict ─────────────────────────────────────────────────

describe("GET /verify-post.mjs and the mirror verifier name each fault of a connection proof alike", () => {
  test("every way a proof can be altered is a fault in both, in the same words", async () => {
    const passkeyAuthor = await passkeyPerson();
    const edAuthor = await ed25519Person();
    const read = async (person: Person) => {
      const c = await connectApp(person);
      const s = await makeSpace(person);
      const posted = await postThrough(c.appToken, { space: s.name, kind: "obs", body: "a post to alter" });
      assert.equal(posted.result.structuredContent.signed, true, JSON.stringify(posted.body));
      return (await call("GET", `/v1/posts/${posted.result.structuredContent.post_id}`, person.token)).body;
    };
    const pk = await read(passkeyAuthor);
    const ed = await read(edAuthor);
    const at = (p: any) => `post ${p.seq}`;
    const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
    const flip = (h: string) => `${h[0] === "0" ? "1" : "0"}${h.slice(1)}`;
    const altered = (base: any, change: (post: any, sig: any) => void) => {
      const post = structuredClone(base);
      change(post, post.proof.signature);
      return post;
    };
    const statementOf = (sig: any) => JSON.parse(Buffer.from(sig.delegation.statement, "base64url").toString("utf8"));
    const reStated = (sig: any, change: (s: any) => void) => {
      const s = statementOf(sig);
      change(s);
      sig.delegation.statement = b64(JSON.stringify(Object.fromEntries(Object.entries(s).sort(([x], [y]) => (x < y ? -1 : 1)))));
    };
    const both = (post: any) => {
      const out = runVerifier(post);
      assert.ok(out.status === 0 || out.status === 1, `${out.status}: ${out.stderr}`);
      assert.equal(out.stderr, "", "the download threw");
      const fails = out.stdout.split("\n").filter((l) => l.startsWith("FAIL ")).map((l) => l.slice(5)).sort();
      return { status: out.status, fails, mirror: verifyPost(post, site).sort() };
    };
    for (const clean of [pk, ed]) {
      const verdict = both(clean);
      assert.equal(verdict.status, 0, verdict.fails.join("\n"));
      assert.deepEqual(verdict.mirror, []);
    }

    const cases: [string, any, string][] = [
      ["connection signature", altered(pk, (_, s) => { s.signature = flip(s.signature); }), `${at(pk)}: the connection signature does not verify`],
      ["connection key", altered(pk, (_, s) => { s.connection_key = connectionPublicKey(randomBytes(32)).toString("hex"); }), `${at(pk)}: the connection's statement names another connection key`],
      ["statement not canonical", altered(pk, (_, s) => { s.delegation.statement = b64(JSON.stringify(statementOf(s), null, 1)); }), `${at(pk)}: the connection's statement is not one a KEY signs for a connection key`],
      ["statement not base64url", altered(pk, (_, s) => { s.delegation.statement = "not+base64"; }), `${at(pk)}: the connection's statement is not one a KEY signs for a connection key`],
      ["no delegation", altered(pk, (_, s) => { delete s.delegation; }), `${at(pk)}: the connection's statement is not one a KEY signs for a connection key`],
      ["statement of another KEY", altered(pk, (_, s) => reStated(s, (x) => { x.peer_id = "ab".repeat(32); })), `${at(pk)}: the connection's statement is not the author's`],
      ["statement changed", altered(pk, (_, s) => reStated(s, (x) => { x.connection = randomUUID(); })), `${at(pk)}: the statement's passkey signature does not hold: client_data_json.challenge is not the challenge sent`],
      ["dated after it ran out", altered(pk, (p) => { p.posted_at = "2100-01-01T00:00:00.000Z"; }), `${at(pk)}: the post is dated after the connection's statement ran out`],
      ["dated before it was made", altered(pk, (p) => { p.posted_at = "2000-01-01T00:00:00.000Z"; }), `${at(pk)}: the post is dated before the connection's statement was made`],
      ["unknown statement alg", altered(pk, (_, s) => { s.delegation.signature = { ...s.delegation.signature, alg: "rsa" }; }), `${at(pk)}: the connection's statement is signed with an unknown alg`],
      ["passkey of another KEY", altered(pk, (_, s) => { s.public_key = passkey().spki.toString("base64url"); }), `${at(pk)}: the passkey is not the author's KEY`],
      ["passkey algorithm", altered(pk, (_, s) => { s.key_algorithm = "EdDSA"; }), `${at(pk)}: the passkey key is not a key of its algorithm`],
      ["passkey origin", altered(pk, (_, s) => {
        const c = JSON.parse(Buffer.from(s.delegation.signature.client_data_json, "base64url").toString("utf8"));
        c.origin = "https://elsewhere.test";
        s.delegation.signature.client_data_json = b64(JSON.stringify(c));
      }), `${at(pk)}: the statement's passkey signature does not hold: client_data_json.origin is not an origin this service accepts`],
      ["ed25519 statement signature", altered(ed, (_, s) => { s.delegation.signature.signature = flip(s.delegation.signature.signature); }), `${at(ed)}: the statement's Ed25519 signature does not verify`],
      ["ed25519 key of another KEY", altered(ed, (_, s) => { s.public_key = createPublicKey(createEd25519Key(randomBytes(32))).export({ format: "der", type: "spki" }).subarray(-32).toString("hex"); }), `${at(ed)}: the signing key is not the author's KEY`],
    ];
    for (const [what, post, expected] of cases) {
      const verdict = both(post);
      assert.equal(verdict.status, 1, `${what}: the download found nothing wrong`);
      assert.ok(verdict.mirror.includes(expected), `${what}: the mirror said ${JSON.stringify(verdict.mirror)}`);
      // The mirror stops at the first thing a passkey assertion gets wrong, as the service
      // does when it accepts one; the download names each.
      const named = verdict.fails.filter((f) => f.startsWith("post "));
      assert.deepEqual(verdict.mirror.filter((f) => !named.includes(f)), [], `${what}: the download leaves out the mirror's`);
      const extra = named.filter((f) => !verdict.mirror.includes(f));
      assert.ok(extra.every((f) => / the statement's passkey signature does not hold: /.test(f)), `${what}: the download names more: ${extra.join("\n")}`);
    }
  });
});

// ── what the first security review asked ──────────────────────────────────────

describe("the statement names no app", () => {
  test("two KEYS connected through one app registration publish statements that share nothing but the shape", async () => {
    const clientId = await registerApp();
    const statements: Record<string, unknown>[] = [];
    for (const person of [await passkeyPerson(), await passkeyPerson()]) {
      const { requestId } = await startRequest(clientId);
      const made = connectionKeyFor(person, requestId);
      assert.equal((await approve(person, requestId, { connection_key: made.body })).status, 200);
      statements.push(JSON.parse(made.statement.toString("utf8")));
    }
    for (const statement of statements) assert.deepEqual(Object.keys(statement).sort(), ["connection", "key", "not_after", "not_before", "peer_id", "v"]);
    assert.equal(JSON.stringify(statements).includes(clientId), false, "a statement names the app the two KEYS share");
  });

  test("a statement that names its app is refused, signed or not", async () => {
    const person = await passkeyPerson();
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const seed = randomBytes(32);
    const statement = Buffer.from(JSON.stringify({
      client_id: clientId, connection: requestId, key: connectionPublicKey(seed).toString("hex"),
      not_after: timesNow().notAfter, not_before: timesNow().notBefore, peer_id: person.peerId, v: 1,
    }), "utf8");
    if (person.kind !== "passkey") throw new Error("a passkey KEY");
    const signature = { alg: "webauthn", ...passkeyAssertion(person, sha256(delegationPreimage(statement)), { rpId: RP_ID, origin: SITE }) };
    const out = await approve(person, requestId, { connection_key: { statement: statement.toString("base64url"), signature, seed: seed.toString("base64url") } });
    assert.equal(out.body.error?.code, "INVALID_REQUEST");
    assert.match(out.body.error.detail ?? "", /has exactly connection, key, not_after, not_before, peer_id and v/);
  });
});

describe("a post signed through a connection never reads as signed by its author's KEY", () => {
  test("every listing says signed_by connection, and every rendering says it was signed through the app connection", async () => {
    const person = await passkeyPerson();
    const c = await connectApp(person);
    const s = await makeSpace(person, { document: true });
    const posted = await postThrough(c.appToken, { space: s.name, kind: "result", body: "zirconium telltale through the app", idempotency_key: "listed" });
    assert.equal(posted.result.structuredContent.signed_by, "connection", "the receipt says how it was signed");
    assert.ok(posted.result.content[0].text.split("\n").includes(RECEIPT_WORDS), posted.result.content[0].text);
    const again = await postThrough(c.appToken, { space: s.name, kind: "result", body: "zirconium telltale through the app", idempotency_key: "listed" });
    assert.equal(again.result.structuredContent.replayed, true);
    assert.equal(again.result.structuredContent.signed_by, "connection", "a replay's receipt says it too");

    // The API, at every detail but ids, without a proof.
    for (const detail of ["snippets", "full"]) {
      const page = await call("GET", `/v1/spaces/${s.name}/posts?detail=${detail}`, person.token);
      assert.equal(page.body.items[0].signed, true);
      assert.equal(page.body.items[0].signed_by, "connection", `detail ${detail}`);
    }
    const found = await call("GET", `/v1/seek?q=zirconium&space=${s.name}`, person.token);
    assert.equal(found.body.items[0]?.signed_by, "connection", JSON.stringify(found.body));

    // The connector's readings, none of which carries a proof.
    const KEY_WORDS = /signed by its author's KEY/;
    const APP_WORDS = /signed through an app connection its author's KEY allowed/;
    const headline = (await rpc("/mcp/connect", "schellingaf_read_space", { space: s.name }, c.appToken)).result.content[0].text;
    assert.match(headline, /^\[1\] RESULT [0-9a-f]{8}, open [\d,]+, signed_by_connection$/m, headline);
    for (const [tool, args] of [
      ["schellingaf_read_space", { space: s.name, detail: "snippets" }],
      ["schellingaf_seek", { q: "zirconium", space: s.name }],
    ] as const) {
      const text = (await rpc("/mcp/connect", tool, args, c.appToken)).result.content[0].text;
      assert.match(text, APP_WORDS, tool);
      assert.doesNotMatch(text, KEY_WORDS, tool);
    }

    // A document's version, and its history.
    const version = await postThrough(c.appToken, { space: s.name, kind: "version", body: "# Notes\n\nSigned through the app." });
    assert.equal(version.result.isError, undefined, JSON.stringify(version.body));
    const document = await call("GET", `/v1/spaces/${s.name}/document`, person.token);
    assert.equal(document.body.version.signed_by, "connection");
    const history = await call("GET", `/v1/spaces/${s.name}/versions`, person.token);
    assert.equal(history.body.items[0].signed_by, "connection");
    const read = (await rpc("/mcp/connect", "schellingaf_oracle", { action: "read", space: s.name }, c.appToken)).result.content[0].text;
    assert.match(read, APP_WORDS);
    assert.doesNotMatch(read, KEY_WORDS);

    // A post its author signed with its own KEY says so, and carries no signed_by.
    const own = await ed25519Person();
    const theirs = await makeSpace(own);
    const viaBridgeShape = buildPostObject({
      spaceId: theirs.id, author: own.peerId, idempotencyKey: "own", kind: "obs", title: "A signed POST in a test", body: "signed by the KEY",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    if (own.kind !== "ed25519") throw new Error("an Ed25519 KEY");
    const ownPost = await call("POST", `/v1/spaces/${theirs.name}/posts`, own.token, {
      alg: "ed25519", canonical: viaBridgeShape.canonical.toString("base64url"),
      signature: sign(null, signaturePreimageOf(viaBridgeShape.objectId), own.privateKey).toString("hex"),
    });
    assert.equal(ownPost.status, 201, JSON.stringify(ownPost.body));
    assert.equal("signed_by" in ownPost.body, false);
    const ownPage = await call("GET", `/v1/spaces/${theirs.name}/posts?detail=snippets`, own.token);
    assert.equal(ownPage.body.items[0].signed, true);
    assert.equal("signed_by" in ownPage.body.items[0], false);
    const ownHeadline = (await call("GET", `/v1/spaces/${theirs.name}/posts`, own.token)).body.items[0];
    assert.deepEqual(ownHeadline.flags, ["signed"]);
    const ownText = (await rpc("/mcp", "schellingaf_read_space", { space: theirs.name, detail: "snippets" }, own.token)).result.content[0].text;
    assert.match(ownText, KEY_WORDS);
  });
});

describe("a decided request is the deciding KEY's alone", () => {
  test("anyone with the id reads a pending request; once decided, only the KEY that decided it does", async () => {
    const person = await passkeyPerson();
    const stranger = await passkeyPerson();
    for (const decision of ["approve", "decline"]) {
      const clientId = await registerApp();
      const { requestId } = await startRequest(clientId);
      assert.equal((await call("GET", `/v1/authorizations/${requestId}`, stranger.token)).body.state, "pending");
      const decided = await read(await send(app, "POST", `/v1/authorizations/${requestId}/${decision}`, person.token, {}, { "content-type": "application/json" }));
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      const own = await call("GET", `/v1/authorizations/${requestId}`, person.token);
      assert.equal(own.body.state, decision === "approve" ? "approved" : "declined");
      const other = await call("GET", `/v1/authorizations/${requestId}`, stranger.token);
      assert.equal(other.status, 404);
      assert.equal(other.body.error.code, "AUTHORIZATION_NOT_FOUND", "a decided request answers anybody else as one that does not exist");
    }
  });
});

describe("an app that may only read is given no key", () => {
  test("the route and the database both refuse one, and the app connects unsigned without it", async () => {
    const person = await passkeyPerson();
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId, "read");
    const refused = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId).body });
    assert.equal(refused.body.error?.code, "INVALID_REQUEST");
    assert.match(refused.body.error.detail ?? "", /allowed to write, and this one may only read/);
    // The database's own check, under the request's lock.
    const made = connectionKeyFor(person, requestId);
    await assert.rejects(fixture.owner`
      select schellingaf.oauth_decide(${requestId}::uuid, ${Buffer.from(person.peerId, "hex")}, true, ${randomBytes(32)}, ${randomBytes(16)},
        ${Buffer.from(made.key, "hex")}, ${made.statement}, ${fixture.owner.json(made.body.signature)},
        ${sealVault("a code", made.seed, codeVaultData(requestId))})`, /INVALID_REQUEST/);
    assert.equal((await approve(person, requestId)).status, 200, "without a key it connects as before");
    assert.equal(await codeVaultOf(requestId), null);
  });
});

describe("a connection key is never a KEY", () => {
  test("an Ed25519 KEY or an EdDSA passkey with a connection key's public key is refused, and a passkey's key is never a connection key", async () => {
    const person = await passkeyPerson();
    const c = await connectApp(person);
    const seed = c.made!.seed;
    const key = Buffer.from(c.made!.key, "hex");
    const privateKey = createEd25519Key(seed);

    // As an Ed25519 KEY, by the ordinary challenge.
    const ch = await call("POST", "/v1/keys/challenge", null, { public_key: c.made!.key });
    const { challengePreimage } = await import("../src/domain/protocol.ts");
    const asKey = await call("POST", "/v1/keys/verify", null, {
      public_key: c.made!.key, challenge: ch.body.challenge,
      signature: sign(null, challengePreimage(HOST, Buffer.from(ch.body.challenge, "hex")), privateKey).toString("hex"),
    });
    assert.equal(asKey.body.error?.code, "INVALID_REQUEST", JSON.stringify(asKey.body));
    assert.match(asKey.body.error.detail ?? "", /is the key of an app connection, which is never a KEY/);

    // As an EdDSA passkey.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]);
    const asPasskey: Passkey = { credentialId: randomBytes(32), spki, algorithm: -8, privateKey };
    const pch = await call("POST", "/v1/passkeys/challenge", undefined, {});
    const passkeyOut = await call("POST", "/v1/passkeys/verify", undefined, {
      challenge: pch.body.challenge,
      ...passkeyAssertion(asPasskey, Buffer.from(pch.body.challenge, "hex"), { rpId: RP_ID, origin: SITE }),
      public_key: spki.toString("base64url"),
      algorithm: -8,
    });
    assert.equal(passkeyOut.body.error?.code, "INVALID_REQUEST", JSON.stringify(passkeyOut.body));
    const [n] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.peers where public_key = ${key}`;
    assert.equal(n!.n, 0);

    // And the other way: an EdDSA passkey's own key offered as a connection key.
    const edPasskey = passkey(-8);
    const epch = await call("POST", "/v1/passkeys/challenge", undefined, {});
    const registered = await call("POST", "/v1/passkeys/verify", undefined, {
      challenge: epch.body.challenge,
      ...passkeyAssertion(edPasskey, Buffer.from(epch.body.challenge, "hex"), { rpId: RP_ID, origin: SITE }),
      public_key: edPasskey.spki.toString("base64url"),
      algorithm: -8,
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const passkeySeed = Buffer.from(edPasskey.privateKey.export({ format: "jwk" }).d!, "base64url");
    const clientId = await registerApp();
    const { requestId } = await startRequest(clientId);
    const offered = await approve(person, requestId, { connection_key: connectionKeyFor(person, requestId, { seed: passkeySeed }).body });
    assert.equal(offered.body.error?.code, "INVALID_REQUEST");
    assert.match(offered.body.error.detail ?? "", /is a KEY of its own/);
  });
});

describe("a post is never given a time outside its statement's", () => {
  test("the time is the service's clock after the SPACE lock, and a statement that runs out while the post waits refuses it", async () => {
    const person = await passkeyPerson();
    const s = await makeSpace(person);
    const seed = randomBytes(32);
    const key = connectionPublicKey(seed);
    const built = buildPostObject({
      spaceId: s.id, author: person.peerId, idempotencyKey: `late-${randomUUID()}`, kind: "obs", title: null, body: "late",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    await assert.rejects(fixture.owner.begin(async (sql) => {
      // not_after a moment after the transaction began, which is what now() says all
      // through it; the clock has passed it by the time the post is written.
      await sql`
        insert into schellingaf.connection_keys (public_key, peer_id, request_id, not_before, not_after, statement, signature)
        values (${key}, ${Buffer.from(person.peerId, "hex")}, ${randomUUID()}::uuid, now() - interval '1 hour', now() + interval '200 milliseconds',
                ${Buffer.alloc(64, 1)}, ${sql.json({ alg: "ed25519", signature: "00".repeat(64) })})`;
      await sql`select pg_sleep(0.4)`;
      await sql`
        select schellingaf.append_post(p_space_name => ${s.name}, p_author => ${Buffer.from(person.peerId, "hex")}, p_kind => 'obs',
          p_title => null::text, p_body => 'late', p_data => null::jsonb, p_budget => null::jsonb, p_to => '{}'::bytea[],
          p_run_id => null::uuid, p_reply_to => null::uuid, p_supersedes => null::uuid, p_retracts => null::uuid,
          p_fingerprints => '[]'::jsonb, p_idempotency_key => ${JSON.parse(built.canonical.toString()).idempotency_key},
          p_canonical => ${built.canonical}, p_alg => 'connection',
          p_signature => ${sign(null, signaturePreimageOf(built.objectId), createEd25519Key(seed))},
          p_connection_key => ${key}::bytea)`;
    }), /POST_SIGNATURE_INVALID/);
    const [n] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.posts where space_id = ${s.id}::uuid`;
    assert.equal(n!.n, 0);
  });

  test("nor a time before its statement was made", async () => {
    const person = await passkeyPerson();
    const s = await makeSpace(person);
    const seed = randomBytes(32);
    const key = connectionPublicKey(seed);
    await fixture.owner`
      insert into schellingaf.connection_keys (public_key, peer_id, request_id, not_before, not_after, statement, signature)
      values (${key}, ${Buffer.from(person.peerId, "hex")}, ${randomUUID()}::uuid, now() + interval '10 minutes', now() + interval '91 days',
              ${Buffer.alloc(64, 1)}, ${fixture.owner.json({ alg: "ed25519", signature: "00".repeat(64) })})`;
    const built = buildPostObject({
      spaceId: s.id, author: person.peerId, idempotencyKey: `early-${randomUUID()}`, kind: "obs", title: null, body: "early",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    await assert.rejects(fixture.owner`
      select schellingaf.append_post(p_space_name => ${s.name}, p_author => ${Buffer.from(person.peerId, "hex")}, p_kind => 'obs',
        p_title => null::text, p_body => 'early', p_data => null::jsonb, p_budget => null::jsonb, p_to => '{}'::bytea[],
        p_run_id => null::uuid, p_reply_to => null::uuid, p_supersedes => null::uuid, p_retracts => null::uuid,
        p_fingerprints => '[]'::jsonb, p_idempotency_key => ${JSON.parse(built.canonical.toString()).idempotency_key},
        p_canonical => ${built.canonical}, p_alg => 'connection',
        p_signature => ${sign(null, signaturePreimageOf(built.objectId), createEd25519Key(seed))},
        p_connection_key => ${key}::bytea)`, /POST_SIGNATURE_INVALID/);
  });

  test("the connector does not sign while a statement made a little ahead of the clock is not yet in force", async () => {
    const person = await passkeyPerson();
    const s = await makeSpace(person);
    const c = await connectApp(person, { fields: timesFrom(Math.floor(Date.now() / 1000) + 30) });
    assert.equal(c.kept, "kept");
    const out = await postThrough(c.appToken, { space: s.name, kind: "obs", body: "before the statement holds" });
    assert.equal(out.result.structuredContent.signed, false, JSON.stringify(out.body));
  });
});

describe("a seed is used and left as it was", () => {
  test("making the key from a seed zeroes only its own copy, never the caller's", () => {
    const seed = randomBytes(32);
    const kept = Buffer.from(seed);
    connectionPublicKey(seed);
    connectionSalt(seed, randomUUID(), "k");
    assert.deepEqual(seed, kept);
    const a = connectionPublicKey(seed);
    assert.deepEqual(connectionPublicKey(seed), a, "the same seed makes the same key every time");
  });
});

describe("a vault opens only while its token is live", () => {
  test("the connector does not sign with a vault whose token has expired, and the route refuses a key whose token expired mid-call", async () => {
    const person = await passkeyPerson();
    const s = await makeSpace(person);
    const c = await connectApp(person);
    await fixture.owner`update schellingaf.connection_vaults set expires_at = now() - interval '1 second' where token_hash = ${sha256(c.appToken)}`;
    const unsigned = await postThrough(c.appToken, { space: s.name, kind: "obs", body: "the vault has run out" });
    assert.equal(unsigned.result.structuredContent.signed, false, JSON.stringify(unsigned.body));

    const d = await connectApp(person);
    const bearer = await classifyBearer(db, `Bearer ${d.appToken}`, "127.0.0.1", CONNECT);
    assert.equal(bearer.state, "valid");
    await fixture.owner`update schellingaf.tokens set expires_at = now() - interval '1 second' where token_hash = ${sha256(d.appToken)}`;
    const built = buildPostObject({
      spaceId: s.id, author: person.peerId, idempotencyKey: `expired-${randomUUID()}`, kind: "obs", title: "A signed POST in a test", body: "expired",
      to: [], replyTo: null, supersedes: null, retracts: null, fingerprints: [], data: null, budget: null, runId: null,
    });
    const out = await read(await app.request(`/v1/spaces/${s.name}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${d.appToken}` },
      body: JSON.stringify({
        canonical: built.canonical.toString("base64url"), alg: "connection", connection_key: d.made!.key,
        signature: sign(null, signaturePreimageOf(built.objectId), createEd25519Key(d.made!.seed)).toString("hex"),
      }),
    }, { schellingafReentry: { bearer, addr: "127.0.0.1", connectionKey: Buffer.from(d.made!.key, "hex") } }));
    assert.equal(out.body.error?.code, "POST_SIGNATURE_INVALID");
    assert.match(out.body.error.detail, /not the one the connection of this token holds/);
  });
});

describe("the oracle tool's writes through an app connection", () => {
  test("a signed-only oracle space takes a proposal and a decision made with schellingaf_oracle, both signed with the connections' keys", async () => {
    const owner = await passkeyPerson();
    const proposer = await passkeyPerson();
    const name = `ck-oracle-${randomUUID().slice(0, 8)}`;
    const made = await call("POST", "/v1/spaces", owner.token, { name, title: "Signed only", oracle: true, signed_only: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const owners = await connectApp(owner);
    const proposers = await connectApp(proposer);
    const unsigned = await connectApp(proposer, { key: false });

    // The owner's first version, current at once; then a proposal, and its decision.
    const first = await rpc("/mcp/connect", "schellingaf_oracle", { action: "propose", space: name, text: "# Notes\n\nFirst.", wait: 0 }, owners.appToken);
    assert.equal(first.result.isError, undefined, JSON.stringify(first.body));
    assert.equal(first.result.structuredContent.signed_by, "connection");
    assert.equal(first.result.structuredContent.oracle.state, "current");

    const refused = await rpc("/mcp/connect", "schellingaf_oracle", { action: "propose", space: name, text: "# Notes\n\nUnsigned.", wait: 0 }, unsigned.appToken);
    assert.match(refused.result.content[0].text, /^SIGNATURE_REQUIRED/, "a connection with no key is refused here, as before");

    const proposal = await rpc("/mcp/connect", "schellingaf_oracle", { action: "propose", space: name, text: "# Notes\n\nSecond, proposed.", summary: "a second line", wait: 0 }, proposers.appToken);
    assert.equal(proposal.result.isError, undefined, JSON.stringify(proposal.body));
    assert.equal(proposal.result.structuredContent.signed, true);
    assert.equal(proposal.result.structuredContent.signed_by, "connection");
    assert.equal(proposal.result.structuredContent.oracle.state, "pending");

    const decided = await rpc("/mcp/connect", "schellingaf_oracle", { action: "approve", space: name, proposal: proposal.result.structuredContent.post_id, reason: "It reads better." }, owners.appToken);
    assert.equal(decided.result.isError, undefined, JSON.stringify(decided.body));
    assert.equal(decided.result.structuredContent.signed_by, "connection");
    assert.equal(decided.result.structuredContent.oracle.decided, "approved");

    const document = await call("GET", `/v1/spaces/${name}/document`);
    assert.equal(document.body.version.post_id, proposal.result.structuredContent.post_id);
    assert.equal(document.body.version.signed_by, "connection");
    // Each verifies against its author's own statement.
    for (const [post, author] of [[proposal, proposer], [decided, owner]] as const) {
      const one = await call("GET", `/v1/posts/${post.result.structuredContent.post_id}`);
      assert.equal(one.body.author, author.peerId);
      assert.equal(one.body.proof.signature.alg, "connection");
      assert.deepEqual(verifyPost(one.body, site), []);
    }

    // A decline is signed the same way.
    const another = await rpc("/mcp/connect", "schellingaf_oracle", { action: "propose", space: name, text: "# Notes\n\nThird.", wait: 0 }, proposers.appToken);
    const declined = await rpc("/mcp/connect", "schellingaf_oracle", { action: "decline", space: name, proposal: another.result.structuredContent.post_id, reason: "Not yet." }, owners.appToken);
    assert.equal(declined.result.structuredContent.signed_by, "connection", JSON.stringify(declined.body));
    assert.equal(declined.result.structuredContent.oracle.decided, "declined");
  });

  test("a signed-only work space that keeps a document takes a version proposed with schellingaf_oracle, one section at a time", async () => {
    const person = await passkeyPerson();
    const s = await makeSpace(person, { document: true, signed_only: true });
    const c = await connectApp(person);
    const first = await rpc("/mcp/connect", "schellingaf_oracle", { action: "propose", space: s.name, text: "# Brief\n\nStart.\n\n## Findings\n\nNone yet.", wait: 0 }, c.appToken);
    assert.equal(first.result.isError, undefined, JSON.stringify(first.body));
    assert.equal(first.result.structuredContent.signed_by, "connection");
    const read = await call("GET", `/v1/spaces/${s.name}/document`, person.token);
    const section = read.body.sections.find((x: any) => x.heading === "Findings")?.id;
    assert.ok(section, JSON.stringify(read.body.sections));
    const second = await rpc("/mcp/connect", "schellingaf_oracle", { action: "propose", space: s.name, section, text: "## Findings\n\nOne.", wait: 0 }, c.appToken);
    assert.equal(second.result.isError, undefined, JSON.stringify(second.body));
    assert.equal(second.result.structuredContent.signed_by, "connection");
    const now = await call("GET", `/v1/spaces/${s.name}/document`, person.token);
    assert.match(now.body.text, /One\./);
    assert.equal(now.body.version.signed_by, "connection");
  });
});
