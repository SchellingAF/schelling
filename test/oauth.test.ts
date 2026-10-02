// An app signs a person in, end to end, over the service's real routes: the 401
// that starts it, the two discovery documents, registering or publishing a
// document, the request the website shows a person, the code, the token, and the
// connector the token works at. Then every way it must refuse.
//
// The person is a KEY with its own token, which is exactly what the website holds
// for somebody signed in with a passkey: the website's page calls the same two
// routes this file calls.

import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes, type KeyObject } from "node:crypto";
import { withEnv } from "./lib/env.ts";
import { useService, app, db, fixture, config, testConfig, send, read, call, agent, HOST, type App } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { TOKEN_TTL_DEFAULT_SECONDS } from "../src/domain/protocol.ts";
import { sha256 } from "../src/domain/keys.ts";
import { newToken } from "../src/http/auth.ts";
import { cleanName, keysOf, resolveClient, useDocumentFetcherForTests } from "../src/oauth/clients.ts";
import { isMetadataDocumentId, redirectMatches, sameResource } from "../src/oauth/uris.ts";
import { FetchBusy, FetchRefused, fetchJsonDocument, refusedAddress, sharedFetch, type Fetched } from "../src/oauth/fetch.ts";
import { networkOfAddress } from "../src/http/ratelimit.ts";
import { OAUTH_REFUSALS } from "../src/surface/refusals.ts";
import { REPLAY_GRACE_SECONDS } from "../src/oauth/routes.ts";

const ORIGIN = `https://${HOST}`;
const SITE = "https://site.schellingaf.test";
const CONNECT = `${ORIGIN}/mcp/connect`;
/** The same service with no site, so no app can sign a person in. */
let bare: App;

const ready = useService("oauth", { siteOrigin: SITE, passkeys: { rpId: "site.schellingaf.test", origins: [SITE] } });
before(async () => {
  await ready;
  bare = createApp(testConfig(fixture.name), db);
});
after(() => {
  useDocumentFetcherForTests(null);
});

/** A request to a /v1 route as the website sends it: JSON, with the person's token. */
const v1 = async (method: string, path: string, token: string, body?: unknown) =>
  read(await send(app, method, path, token, body, { "content-type": "application/json" }));

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** The browser arriving at /oauth/authorize, and where it is sent. */
async function authorize(params: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await app.request(`/oauth/authorize?${new URLSearchParams(params)}`, { headers });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

const requestIdOf = (location: string) => new URL(location).searchParams.get("request")!;

async function token(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return read(await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  }));
}

/** One JSON-RPC call to a connector address, 2025 shape, with the answer parsed. */
async function rpc(path: string, method: string, params: unknown, bearer?: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const parsed = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).at(-1)!.slice(5))
    : text ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, body: parsed };
}

/** A stream on the connector for apps, following the mailbox, read as it arrives. */
async function openStream(bearer: string) {
  const res = await app.request("/mcp/connect", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "subscriptions/listen",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "listen:app",
      method: "subscriptions/listen",
      params: {
        notifications: { resourceSubscriptions: ["schellingaf://mailbox"] },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      },
    }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let reading: ReturnType<typeof reader.read> | null = null;
  const stream = {
    text: "",
    ended: false,
    /** Reads until the text holds the pattern, the stream ends, or five seconds pass,
     * so a stream that never ends fails its test rather than hanging the suite. */
    async until(pattern: RegExp) {
      const deadline = Date.now() + 5000;
      while (!pattern.test(stream.text) && !stream.ended) {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))));
        reading ??= reader.read();
        const next = await Promise.race([reading, late]);
        clearTimeout(timer);
        if (next === null) return;
        reading = null;
        if (next.done) stream.ended = true;
        else stream.text += decoder.decode(next.value, { stream: true });
      }
    },
    /** Hangs up, as a client that is finished does. */
    close: () => void reader.cancel().catch(() => {}),
  };
  return stream;
}

async function registerPublicApp(redirect = "http://localhost/callback", name = "Test App") {
  const out = await call("POST", "/oauth/register", null, { redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: name });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body.client_id as string;
}

/** The browser starting a request to connect, with a fresh PKCE pair: the fields every
 * such request carries, then whatever the test adds (state, scope, resource). */
async function startConnect(clientId: string, redirect: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const { verifier, challenge } = pkce();
  const started = await authorize({
    response_type: "code", client_id: clientId, redirect_uri: redirect,
    code_challenge: challenge, code_challenge_method: "S256", ...extra,
  }, headers);
  return { ...started, requestId: requestIdOf(started.location), verifier };
}

/** A request to connect, started and allowed by `person`: the code the app is sent
 * back with, its verifier, and the whole address it is sent back to. */
async function approvedCode(person: { token: string }, clientId: string, redirect: string, extra: Record<string, string> = {}) {
  const { requestId, verifier } = await startConnect(clientId, redirect, extra);
  const approved = await v1("POST", `/v1/authorizations/${requestId}/approve`, person.token);
  const back = new URL(approved.body.redirect_to);
  return { code: back.searchParams.get("code")!, verifier, requestId, back };
}

/** The whole way through for a registered public app, as far as a token. */
async function connectApp(person: { token: string }, scope = "read write") {
  const clientId = await registerPublicApp();
  const redirect = "http://localhost:43117/callback";
  const { code, verifier, back } = await approvedCode(person, clientId, redirect, { state: "xyz", scope, resource: CONNECT });
  const issued = await token({
    grant_type: "authorization_code", code, redirect_uri: redirect,
    client_id: clientId, code_verifier: verifier, resource: CONNECT,
  });
  return { clientId, verifier, redirect, back, code, issued };
}

describe("an app finds out how to sign in", () => {
  test("the connect address answers 401, naming the resource metadata and the scopes", async () => {
    const out = await rpc("/mcp/connect", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(out.status, 401);
    const challenge = out.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer /);
    assert.match(challenge, new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource/mcp/connect"`));
    assert.match(challenge, /scope="read write"/);
  });

  test("the resource metadata names this address and this service as its authorization server", async () => {
    const out = await call("GET", "/.well-known/oauth-protected-resource/mcp/connect");
    assert.equal(out.status, 200);
    assert.equal(out.body.resource, CONNECT);
    assert.deepEqual(out.body.authorization_servers, [ORIGIN]);
    assert.deepEqual(out.body.scopes_supported, ["read", "write"]);
  });

  test("the authorization server metadata offers a published document, PKCE S256 and the issuer mark", async () => {
    const out = await call("GET", "/.well-known/oauth-authorization-server");
    assert.equal(out.body.issuer, ORIGIN);
    assert.equal(out.body.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
    assert.equal(out.body.client_id_metadata_document_supported, true);
    assert.ok(out.body.token_endpoint_auth_methods_supported.includes("none"), "Claude needs none to choose a published document");
    assert.ok(out.body.token_endpoint_auth_methods_supported.includes("private_key_jwt"), "ChatGPT signs its token requests");
    assert.deepEqual(out.body.code_challenge_methods_supported, ["S256"]);
    assert.equal(out.body.authorization_response_iss_parameter_supported, true);
    assert.equal(out.body.scopes_supported.includes("offline_access"), false, "no refresh token is issued, so none is offered");
  });

  test("a server with no site configured says no app can sign in, and /mcp/connect is not there", async () => {
    assert.equal((await call("GET", "/.well-known/oauth-authorization-server", null, undefined, bare)).body.error.code, "OAUTH_UNAVAILABLE");
    assert.equal((await send(bare, "POST", "/mcp/connect")).status, 404);
    // Registering is refused in OAuth's words, which the API description lists.
    const registered = await call("POST", "/oauth/register", null, { redirect_uris: ["https://app.example/cb"] }, bare);
    assert.deepEqual([registered.status, registered.body.error], [404, "invalid_request"]);
    assert.ok(OAUTH_REFUSALS["oauth.register"]!.includes("invalid_request"));
    const caps = await call("GET", "/v1/capabilities", null, undefined, bare);
    assert.equal(caps.body.modules.oauth.status, "unavailable");
    assert.equal((await call("GET", "/v1/capabilities")).body.modules.oauth.status, "available");
  });
});

describe("the way through, for an app that registered itself", () => {
  let person: { token: string; peerId: string };

  before(async () => {
    person = await agent();
  });

  test("the browser is sent to the website's page with a random request id", async () => {
    const clientId = await registerPublicApp();
    const out = await startConnect(clientId, "http://localhost:5555/callback", { state: "s1" });
    assert.equal(out.status, 302);
    assert.match(out.location, new RegExp(`^${SITE}/me/connect\\?request=[0-9a-f-]{36}$`));
    assert.equal(out.requestId[14], "4", "a request id must be random, never time-ordered");
  });

  test("the website reads who is asking, where the person returns, and what the app may do", async () => {
    const clientId = await registerPublicApp("http://localhost/callback", "Claude Code");
    const { requestId } = await startConnect(clientId, "http://localhost:4000/callback", { scope: "read" });
    const read = await v1("GET", `/v1/authorizations/${requestId}`, person.token);
    assert.equal(read.status, 200);
    assert.equal(read.body.state, "pending");
    assert.equal(read.body.client.name, "Claude Code");
    assert.equal(read.body.client.kind, "registered");
    assert.equal(read.body.redirect.host, "localhost:4000");
    assert.equal(read.body.redirect.only_loopback, true);
    assert.deepEqual(read.body.scope, ["read"]);
    assert.equal(read.body.token_lifetime_days, 90);
  });

  test("allowing it sends the person back with a code, the state and the issuer, and the app trades it for a token", async () => {
    const { issued, back } = await connectApp(person);
    assert.equal(back.searchParams.get("state"), "xyz");
    assert.equal(back.searchParams.get("iss"), ORIGIN);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.token_type, "Bearer");
    assert.equal(issued.body.scope, "read write");
    assert.ok(issued.body.expires_in > 89 * 86400 && issued.body.expires_in <= 90 * 86400);
    assert.equal(issued.headers.get("cache-control"), "no-store");
    assert.equal("refresh_token" in issued.body, false);
  });

  test("the token works at /mcp/connect, as the person's own KEY, and nowhere else", async () => {
    const { issued } = await connectApp(person);
    const appToken = issued.body.access_token as string;
    const whoami = await rpc("/mcp/connect", "tools/call", { name: "schellingaf_whoami", arguments: {} }, appToken);
    assert.equal(whoami.status, 200);
    assert.match(whoami.body.result.content[0].text, new RegExp(`reading as ${person.peerId}`));
    const atMcp = await rpc("/mcp", "tools/call", { name: "schellingaf_whoami", arguments: {} }, appToken);
    assert.match(atMcp.body.result.content[0].text, /^TOKEN_INVALID/);
    assert.equal((await v1("GET", "/v1/me", appToken)).body.error.code, "TOKEN_INVALID");
    // And the KEY's own token is refused at /mcp/connect, which takes only tokens issued for it.
    const own = await rpc("/mcp/connect", "tools/list", {}, person.token);
    assert.equal(own.status, 401);
    assert.match(own.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });

  test("a replayed code also ends a stream its token holds open, and a connection that may only read may hold one", async () => {
    const { issued, code, redirect, clientId, verifier } = await connectApp(person, "read");
    const stream = await openStream(issued.body.access_token);
    try {
      await stream.until(/subscriptions\/acknowledged/);
      assert.match(stream.text, /"resourceSubscriptions":\["schellingaf:\/\/mailbox"\]/);

      // Past the grace a repeat is a replay.
      await fixture.owner`update schellingaf.oauth_requests set redeemed_at = now() - make_interval(secs => ${REPLAY_GRACE_SECONDS + 1})
                            where code_hash = ${sha256(code)}`;
      const again = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
      assert.equal(again.body.error, "invalid_grant");
      await stream.until(/"resultType":"complete"/);
      assert.match(stream.text, /"id":"listen:app"/, "the stream did not end with the answer that says listen again");
      await stream.until(/$^/);
      assert.equal(stream.ended, true, "the stream stayed open");
    } finally {
      stream.close();
    }
  });

  test("the same app trading its code again within moments is refused, and the token its first trade minted still works", async () => {
    const { issued, code, redirect, clientId, verifier } = await connectApp(person);
    const again = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "invalid_grant");
    const whoami = await rpc("/mcp/connect", "tools/call", { name: "schellingaf_whoami", arguments: {} }, issued.body.access_token);
    assert.match(whoami.body.result.content[0].text, new RegExp(`reading as ${person.peerId}`));
  });

  test("the wrong verifier, the wrong return address or another app's id gets nothing, and the code still works after", async () => {
    const clientId = await registerPublicApp();
    const other = await registerPublicApp();
    const redirect = "http://localhost:7000/callback";
    const { code, verifier } = await approvedCode(person, clientId, redirect);
    const base = { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier };
    assert.equal((await token({ ...base, code_verifier: pkce().verifier })).body.error, "invalid_grant");
    assert.equal((await token({ ...base, redirect_uri: "http://localhost:7000/other" })).body.error, "invalid_grant");
    assert.equal((await token({ ...base, client_id: other })).body.error, "invalid_grant");
    assert.equal((await token({ ...base, resource: `${ORIGIN}/mcp` })).body.error, "invalid_target");
    assert.equal((await token(base)).status, 200);
  });

  test("declining sends the person back with access_denied and no code", async () => {
    const clientId = await registerPublicApp();
    const { requestId } = await startConnect(clientId, "http://localhost:1/callback", { state: "keep-me" });
    const declined = await v1("POST", `/v1/authorizations/${requestId}/decline`, person.token);
    const back = new URL(declined.body.redirect_to);
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("state"), "keep-me");
    assert.equal(back.searchParams.get("code"), null);
    const twice = await v1("POST", `/v1/authorizations/${requestId}/approve`, person.token);
    assert.equal(twice.body.error.code, "AUTHORIZATION_DECIDED");
  });

  test("a request older than ten minutes cannot be allowed", async () => {
    const clientId = await registerPublicApp();
    const { requestId: id } = await startConnect(clientId, "http://localhost/callback");
    await fixture.owner`update schellingaf.oauth_requests set expires_at = now() - interval '1 second' where request_id = ${id}::uuid`;
    assert.equal((await v1("GET", `/v1/authorizations/${id}`, person.token)).body.state, "expired");
    assert.equal((await v1("POST", `/v1/authorizations/${id}/approve`, person.token)).body.error.code, "AUTHORIZATION_EXPIRED");
  });

  test("a connection that may only read is refused a writing tool, in the standard's words, and reads", async () => {
    const { issued } = await connectApp(person, "read");
    assert.equal(issued.body.scope, "read");
    const reader = issued.body.access_token as string;
    const write = await rpc("/mcp/connect", "tools/call", {
      name: "schellingaf_space_control", arguments: { action: "create", name: "never-made", title: "No" },
    }, reader);
    assert.equal(write.status, 403);
    assert.match(write.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
    const read = await rpc("/mcp/connect", "tools/call", { name: "schellingaf_whoami", arguments: {} }, reader);
    assert.equal(read.status, 200);
    assert.equal(read.body.result.isError, undefined);
    // A tool that both reads and writes is judged by the action a call names, so a
    // reading app keeps the oracle tool's reads and is refused its writes.
    for (const action of ["read", "history", "links", "watching"]) {
      const oracle = await rpc("/mcp/connect", "tools/call", { name: "schellingaf_oracle", arguments: { action, space: "no-such-space" } }, reader);
      assert.equal(oracle.status, 200, `schellingaf_oracle ${action} is a read`);
    }
    for (const action of ["propose", "fork", "watch"]) {
      const oracle = await rpc("/mcp/connect", "tools/call", { name: "schellingaf_oracle", arguments: { action, space: "no-such-space", text: "x", name: "never-made" } }, reader);
      assert.equal(oracle.status, 403, `schellingaf_oracle ${action} writes`);
    }
  });

  test("the person sees the app among their tokens, and revoking that one disconnects it alone", async () => {
    const { issued, clientId } = await connectApp(person);
    const listed = await v1("GET", "/v1/tokens", person.token);
    const mine = listed.body.items.find((t: any) => t.app?.client_id === clientId);
    assert.ok(mine, "the app's token is not in the KEY's list");
    assert.equal(mine.label, "Test App");
    assert.deepEqual(mine.app.scope, ["read", "write"]);
    assert.equal((await call("DELETE", `/v1/tokens/${mine.id}`, person)).status, 204);
    assert.equal((await rpc("/mcp/connect", "tools/list", {}, issued.body.access_token)).status, 401);
    assert.equal((await v1("GET", "/v1/me", person.token)).status, 200, "revoking the app's token revoked the person's own");
    const stranger = await agent();
    const theirs = await call("DELETE", `/v1/tokens/${mine.id}`, stranger);
    assert.equal(theirs.status, 404);
  });

  test("an app's token cannot read the requests the website answers", async () => {
    const { issued } = await connectApp(person);
    const clientId = await registerPublicApp();
    const { requestId } = await startConnect(clientId, "http://localhost/callback");
    const read = await v1("GET", `/v1/authorizations/${requestId}`, issued.body.access_token);
    assert.equal(read.status, 401);
  });

  test("a blocked KEY cannot allow an app", async () => {
    const blocked = await agent();
    const clientId = await registerPublicApp();
    const { requestId } = await startConnect(clientId, "http://localhost/callback");
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = decode(${blocked.peerId}, 'hex')`;
    const out = await v1("POST", `/v1/authorizations/${requestId}/approve`, blocked.token);
    assert.equal(out.body.error.code, "KEY_BLOCKED");
  });
});

describe("what the authorize address refuses, and where it sends the person", () => {
  test("an unknown app, and an address it did not register, go to the website's page and never back to the app", async () => {
    const unknown = await startConnect(`schellingaf_client_${"0".repeat(32)}`, "https://evil.example/cb");
    assert.equal(unknown.location, `${SITE}/me/connect?error=unknown_app`);
    const clientId = await registerPublicApp("https://app.example/cb");
    const wrong = await startConnect(clientId, "https://app.example/cb/../elsewhere");
    assert.equal(wrong.location, `${SITE}/me/connect?error=wrong_return_address`);
    const twice = await app.request(`/oauth/authorize?client_id=${clientId}&client_id=${clientId}&redirect_uri=https://app.example/cb`);
    assert.equal(twice.headers.get("location"), `${SITE}/me/connect?error=malformed`);
  });

  test("a request with no PKCE, another scope or another resource goes to the website's page, never back to the app", async () => {
    // Sent back to the app, these would make this address a redirect anybody could
    // use: register an app returning to any website, then link here with a request
    // that is certain to fail.
    const clientId = await registerPublicApp("https://app.example/cb");
    const common = { response_type: "code", client_id: clientId, redirect_uri: "https://app.example/cb", state: "st" };
    for (const params of [
      { ...common },
      { ...common, code_challenge: pkce().challenge, code_challenge_method: "plain" },
      { ...common, code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "admin" },
      { ...common, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp` },
      { ...common, response_type: "token", code_challenge: pkce().challenge, code_challenge_method: "S256" },
      { ...common, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s".repeat(2049) },
    ] as Record<string, string>[]) {
      const out = await authorize(params);
      assert.equal(out.status, 302);
      assert.equal(out.location, `${SITE}/me/connect?error=malformed`, JSON.stringify(params).slice(0, 200));
    }
  });

  test("a read-only service sends the person to the website's page too", async () => {
    const clientId = await registerPublicApp("https://app.example/cb");
    const readOnly = createApp({ ...config, readOnly: true }, db);
    const res = await readOnly.request(`/oauth/authorize?${new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: "https://app.example/cb",
      code_challenge: pkce().challenge, code_challenge_method: "S256",
    })}`);
    assert.equal(res.headers.get("location"), `${SITE}/me/connect?error=unavailable`);
  });
});

describe("a refused sign-in leaves its reason in the request log", () => {
  /** The lines the request log wrote for one app's refusals, once they are on disk. */
  async function logged(directory: string, count: number) {
    const file = path.join(directory, `requests-${new Date().toISOString().slice(0, 10)}.jsonl`);
    for (let i = 0; i < 100; i++) {
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      if (lines.length >= count) return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the request log did not get its lines");
  }

  test("the code and a short reason are written, with no secret, code or address beyond a host", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "schellingaf-oauth-log-"));
    try {
      const logging = createApp({ ...config, logDir: directory }, db);
      const clientId = await registerPublicApp("https://app.example/cb");
      const secretPath = "/cb/secret-path-never-logged";
      const wrong = await logging.request(`/oauth/authorize?${new URLSearchParams({
        response_type: "code", client_id: clientId, redirect_uri: `https://elsewhere.example${secretPath}?code=abc`,
        code_challenge: pkce().challenge, code_challenge_method: "S256",
      })}`);
      assert.equal(wrong.headers.get("location"), `${SITE}/me/connect?error=wrong_return_address`);
      const secret = "a-client-secret-that-must-not-be-logged";
      const refused = await logging.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId, client_secret: secret,
          code: "c".repeat(43), redirect_uri: "https://app.example/cb", code_verifier: "v".repeat(43),
        }).toString(),
      });
      assert.equal(refused.status, 400);

      const lines = await logged(directory, 2);
      const byPath = Object.fromEntries(lines.map((l) => [l.path as string, l]));
      assert.deepEqual(byPath["/oauth/authorize"]!.refusal, {
        code: "wrong_return_address",
        why: "redirect_uri on elsewhere.example is not one the app declared",
      });
      assert.deepEqual(byPath["/oauth/token"]!.refusal, { code: "invalid_grant", why: "no live code for this app" });
      const text = lines.map((l) => JSON.stringify(l)).join("\n");
      for (const never of [secretPath, "code=abc", secret, "c".repeat(43), "v".repeat(43)]) {
        assert.ok(!text.includes(never), `the log holds ${never}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a minute writes at most 120 refusals, and the rest are not counted as the log's size limit", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "schellingaf-oauth-log-"));
    try {
      const logging = createApp({ ...config, logDir: directory }, db);
      const clientId = await registerPublicApp("https://app.example/cb");
      // Keep the 121 requests inside one minute, the unit the cap is counted in.
      if (Date.now() % 60_000 > 50_000) await new Promise((resolve) => setTimeout(resolve, 11_000));
      for (let i = 0; i < 121; i++) {
        const refused = await logging.request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", client_id: clientId,
            code: "c".repeat(43), redirect_uri: "https://app.example/cb", code_verifier: "v".repeat(43),
          }).toString(),
        });
        assert.equal(refused.status, 400);
      }
      const lines = await logged(directory, 120);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await logged(directory, 120);
      assert.equal(after.filter((l) => l.refusal !== undefined).length, 120);
      assert.ok(after.every((l) => l.over_ceiling === undefined), "a refusal past the cap is counted as the ceiling");
      assert.ok(lines.length >= 120);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("registering an app", () => {
  const register = (body: unknown) =>
    call("POST", "/oauth/register", null, body);

  test("an address an app may not be sent back to is refused", async () => {
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "https://app.example/cb#frag", "data:text/html,x", "https://user:pw@app.example/cb",
      // The operating systems' own short schemes, which search the disk, install
      // software or open settings, and a scheme no publisher's domain names.
      "search-ms:query=x&crumb=location:%5C%5Cevil.example%5Cshare", "ms-msdt:/id PCWDiagnostic", "itms-services://?action=download-manifest",
      "myapp:/callback", "x-apple.systempreferences:com.apple.preference"]) {
      const out = await register({ redirect_uris: [bad], token_endpoint_auth_method: "none" });
      assert.equal(out.status, 400, bad);
      assert.equal(out.body.error, "invalid_redirect_uri", bad);
    }
    for (const good of ["com.example.app:/oauth/callback", "cursor://anysphere.cursor-retrieval/oauth/callback", "vscode://vscode.github-authentication/did-authenticate"]) {
      assert.equal((await register({ redirect_uris: [good], token_endpoint_auth_method: "none" })).status, 201, good);
    }
  });

  test("an app's name loses every character that changes how the text around it reads", async () => {
    const hidden = [0x202e, 0x2066, 0x200b, 0x200f, 0xfeff, 0x2028].map((point) => String.fromCodePoint(point)).join("");
    const out = await register({
      redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none", client_name: `Real${hidden}App`,
    });
    assert.equal(out.status, 201);
    assert.equal(out.body.client_name, "Real App");
    assert.equal(cleanName(`Claude${String.fromCodePoint(0x202e)}edoC`), "ClaudeedoC");
  });

  test("the network an address belongs to is its /24 or its /48", () => {
    assert.equal(networkOfAddress("203.0.113.7"), "203.0.113.0/24");
    assert.equal(networkOfAddress("2001:db8:1:2::/64"), "2001:db8:1::/48");
    assert.equal(networkOfAddress("unattributable"), "unattributable");
  });

  test("an app that asks for a secret is given one, and must send it", async () => {
    const out = await register({ redirect_uris: ["https://app.example/cb"], client_name: "Confidential" });
    assert.equal(out.status, 201);
    assert.equal(out.body.token_endpoint_auth_method, "client_secret_basic");
    assert.match(out.body.client_secret, /^schellingaf_secret_[0-9a-f]{64}$/);
    const person = await agent();
    const { code, verifier } = await approvedCode(person, out.body.client_id, "https://app.example/cb");
    const fields = { grant_type: "authorization_code", code, redirect_uri: "https://app.example/cb", code_verifier: verifier };
    const basic = (secret: string) => ({ Authorization: `Basic ${Buffer.from(`${out.body.client_id}:${secret}`).toString("base64")}` });
    const wrong = await token(fields, basic("schellingaf_secret_nope"));
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, "invalid_client");
    assert.equal((await token(fields, basic(out.body.client_secret))).status, 200);
  });
});

describe("an app identified by a document it publishes", () => {
  const DOC = "https://apps.example/claude/client.json";
  const SIGNED = "https://apps.example/chatgpt/client.json";
  const JWKS = "https://apps.example/oauth/jwks.json";
  const SLOW_KEY = "https://apps.example/slow-key/client.json";
  const UNCACHED = "https://apps.example/never-asked/client.json";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as object), kid: "k1", use: "sig", alg: "RS256" };
  // A key whose checking a publisher made expensive: any exponent but 65537 is refused.
  const oddExponent = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 3 });
  const ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
  /** A compact JWT, signed with `key` as RS256 signs. */
  const jwt = (key: KeyObject, header: Record<string, unknown>, claims: Record<string, unknown>) => {
    const head = Buffer.from(JSON.stringify(header)).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${signBytes("sha256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
  };
  let fetched: string[] = [];
  /** Forget every document and key set kept, and fetch as this describe does. */
  const forgetDocuments = () => useDocumentFetcherForTests(stub);

  before(() => useDocumentFetcherForTests(stub));

  async function stub(address: string): Promise<Fetched> {
    fetched.push(address);
    const documents: Record<string, unknown> = {
      [DOC]: { client_id: DOC, client_name: "Claude", redirect_uris: ["https://apps.example/api/mcp/auth_callback"], token_endpoint_auth_method: "none" },
      [SIGNED]: {
        client_id: SIGNED, client_name: "ChatGPT", redirect_uris: ["https://apps.example/connector/oauth/1"],
        grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_signing_alg: "RS256", jwks_uri: JWKS,
      },
      [JWKS]: { keys: [jwk] },
      [SLOW_KEY]: {
        client_id: SLOW_KEY, client_name: "Slow", redirect_uris: ["https://apps.example/slow-key/cb"], token_endpoint_auth_method: "private_key_jwt",
        jwks: { keys: [{ ...(oddExponent.publicKey.export({ format: "jwk" }) as object), kid: "slow", alg: "RS256" }] },
      },
      [UNCACHED]: { client_id: UNCACHED, client_name: "Never", redirect_uris: ["https://apps.example/never/cb"], token_endpoint_auth_method: "none" },
    };
    const body = documents[address];
    return body === undefined
      ? { status: 404, contentType: "text/plain", cacheControl: null, body: "" }
      : { status: 200, contentType: "application/json", cacheControl: "max-age=600", body: JSON.stringify(body) };
  }

  test("with no registration: its document is fetched once, and the way through is the same", async () => {
    fetched = [];
    const person = await agent();
    const redirect = "https://apps.example/api/mcp/auth_callback";
    const { requestId, verifier } = await startConnect(DOC, redirect);
    const read = await v1("GET", `/v1/authorizations/${requestId}`, person.token);
    assert.equal(read.body.client.kind, "metadata_document");
    assert.equal(read.body.client.publisher, "apps.example");
    const approved = await v1("POST", `/v1/authorizations/${requestId}/approve`, person.token);
    const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
    const issued = await token({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: DOC, code_verifier: verifier });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.deepEqual(fetched, [DOC], "the document was fetched more than once");
  });

  test("an app that signs its token requests is given a token for a good assertion and nothing for a bad one", async () => {
    const person = await agent();
    const redirect = "https://apps.example/connector/oauth/1";
    const tokenEndpoint = `${ORIGIN}/oauth/token`;
    const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1", typ: "JWT" }) =>
      jwt(privateKey, header, claims);
    const now = Math.floor(Date.now() / 1000);
    const good = (jti: string) => ({ iss: SIGNED, sub: SIGNED, aud: tokenEndpoint, exp: now + 120, iat: now, jti });

    const flow = () => approvedCode(person, SIGNED, redirect);
    const fields = (code: string, verifier: string, assertion: string) => ({
      grant_type: "authorization_code", code, redirect_uri: redirect, client_id: SIGNED, code_verifier: verifier,
      client_assertion_type: ASSERTION, client_assertion: assertion,
    });

    const first = await flow();
    const assertion = sign(good("one"));
    assert.equal((await token(fields(first.code, first.verifier, assertion))).status, 200);

    const second = await flow();
    assert.equal((await token(fields(second.code, second.verifier, assertion))).body.error, "invalid_client", "an assertion was used twice");
    assert.equal((await token(fields(second.code, second.verifier, sign({ ...good("two"), aud: `${ORIGIN}/elsewhere` })))).body.error, "invalid_client");
    assert.equal((await token(fields(second.code, second.verifier, sign({ ...good("three"), iss: DOC })))).body.error, "invalid_client");
    assert.equal((await token(fields(second.code, second.verifier, sign({ ...good("four"), exp: now - 600 })))).body.error, "invalid_client");
    assert.equal((await token(fields(second.code, second.verifier, sign(good("five"), { alg: "none", kid: "k1" })))).body.error, "invalid_client");
    const noAssertion = { grant_type: "authorization_code", code: second.code, redirect_uri: redirect, client_id: SIGNED, code_verifier: second.verifier };
    assert.equal((await token(noAssertion)).body.error, "invalid_client");
    assert.equal((await token(fields(second.code, second.verifier, sign(good("six"))))).status, 200);
  });

  test("a key made expensive to check signs nothing, however well it signs", async () => {
    const person = await agent();
    const redirect = "https://apps.example/slow-key/cb";
    const { code, verifier } = await approvedCode(person, SLOW_KEY, redirect);
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt(oddExponent.privateKey, { alg: "RS256", kid: "slow" },
      { iss: SLOW_KEY, sub: SLOW_KEY, aud: `${ORIGIN}/oauth/token`, exp: now + 60, jti: "slow-1" });
    const out = await token({
      grant_type: "authorization_code", code, redirect_uri: redirect, client_id: SLOW_KEY, code_verifier: verifier,
      client_assertion_type: ASSERTION, client_assertion: assertion,
    });
    assert.equal(out.status, 401);
    assert.equal(out.body.error, "invalid_client");
  });

  test("a token request that holds no code for its app fetches nothing and checks no signature", async () => {
    fetched = [];
    const out = await token({
      grant_type: "authorization_code", code: randomBytes(32).toString("base64url"), redirect_uri: "https://apps.example/never/cb",
      client_id: UNCACHED, code_verifier: pkce().verifier,
      client_assertion_type: ASSERTION, client_assertion: "a.b.c",
    });
    assert.equal(out.body.error, "invalid_grant");
    assert.deepEqual(fetched, [], "a document was fetched for a request that held no code");
  });

  test("one document is fetched once however many ask, and a caller or the service past its fetches is told to wait, not remembered as broken", async () => {
    const releases: (() => void)[] = [];
    let calls = 0;
    const slow = (address: string) => new Promise<Fetched>((resolve) => {
      calls++;
      releases.push(() => resolve({ status: 404, contentType: "text/plain", cacheControl: null, body: address }));
    });
    const steps: string[] = [];
    const place = { stepOut: () => steps.push("out"), stepIn: async () => { steps.push("in"); } };

    const first = sharedFetch("https://slow.example/a", slow, { caller: "203.0.113.1", place });
    const again = sharedFetch("https://slow.example/a", slow, { caller: "203.0.113.2" });
    assert.equal(calls, 1, "the same document was fetched twice at once");
    const second = sharedFetch("https://slow.example/b", slow, { caller: "203.0.113.1" });
    await assert.rejects(sharedFetch("https://slow.example/c", slow, { caller: "203.0.113.1" }), FetchBusy);

    // Held for that caller, a real app's document is busy, and not kept as a failure:
    // asked again once the fetches end, it is fetched and it is an app.
    const busy = await resolveClient(db, UNCACHED, { caller: "203.0.113.1" });
    assert.deepEqual(busy, { why: "busy", busy: true });
    for (const release of releases) release();
    await Promise.all([first, again, second]);
    assert.deepEqual(steps, ["out", "in"], "the request did not give up its place while its fetch ran");
    const later = await resolveClient(db, UNCACHED, { caller: "203.0.113.1" });
    assert.ok("client" in later, JSON.stringify(later));

    // A network runs four at most, whichever of its addresses asks.
    const network = Array.from({ length: 4 }, (_, i) => sharedFetch(`https://slow.example/net/${i}`, slow, { caller: `2001:db8:9:${i}::/64`, network: "2001:db8:9::/48" }));
    await assert.rejects(sharedFetch("https://slow.example/net/5", slow, { caller: "2001:db8:9:5::/64", network: "2001:db8:9::/48" }), FetchBusy);
    for (const release of releases) release();
    await Promise.all(network);

    // And the service sixty-four, from sixteen networks at the least.
    const many = Array.from({ length: 64 }, (_, i) => sharedFetch(`https://slow.example/many/${i}`, slow, { caller: `caller-${i}`, network: `network-${i}` }));
    await assert.rejects(sharedFetch("https://slow.example/one-more", slow, { caller: "caller-last", network: "network-last" }), FetchBusy);
    for (const release of releases) release();
    await Promise.all(many);
  });

  test("a code used before, or past its five minutes, is settled without fetching the app's document", async () => {
    const person = await agent();
    const redirect = "https://apps.example/api/mcp/auth_callback";
    const { code, verifier } = await approvedCode(person, DOC, redirect);
    const fields = { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: DOC, code_verifier: verifier };
    const issued = await token(fields);
    assert.equal(issued.status, 200);

    // Forgotten, so a request that reached the app's document would fetch it; and
    // past the grace, so the repeat is a replay.
    forgetDocuments();
    fetched = [];
    await fixture.owner`update schellingaf.oauth_requests set redeemed_at = now() - make_interval(secs => ${REPLAY_GRACE_SECONDS + 1})
                          where code_hash = ${sha256(code)}`;
    const again = await token(fields);
    assert.equal(again.body.error, "invalid_grant");
    assert.deepEqual(fetched, [], "a used code caused a fetch");
    assert.equal((await rpc("/mcp/connect", "tools/list", {}, issued.body.access_token)).status, 401, "a used code did not revoke what it minted");

    const late = await approvedCode(person, DOC, redirect);
    await fixture.owner`update schellingaf.oauth_requests set code_expires_at = now() - interval '1 second' where request_id = ${late.requestId}::uuid`;
    forgetDocuments();
    fetched = [];
    const expired = await token({ ...fields, code: late.code, code_verifier: late.verifier });
    assert.equal(expired.body.error, "invalid_grant");
    assert.deepEqual(fetched, [], "an expired code caused a fetch");
  });

  test("two uses of one code at once: the later one revokes what the first minted, and ends the stream it holds open", async () => {
    const person = await agent();
    const redirect = "https://apps.example/api/mcp/auth_callback";
    const { code, verifier } = await approvedCode(person, DOC, redirect, { resource: CONNECT });

    // The later use is held where it fetches the app's document: past the read that
    // found the code unused, and before it tries to redeem it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let arrived!: () => void;
    const atFetch = new Promise<void>((resolve) => (arrived = resolve));
    useDocumentFetcherForTests(async (address) => {
      arrived();
      await held;
      return stub(address);
    });
    let stream: Awaited<ReturnType<typeof openStream>> | undefined;
    try {
      const later = token({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: DOC, code_verifier: verifier });
      await atFetch;

      // Meanwhile the first use redeems the code, as the service does, and opens a
      // stream with the token it was given.
      const first = newToken();
      const [row] = await db.write<{ result: { outcome: string } }[]>`
        select schellingaf.oauth_redeem(${sha256(code)}, ${DOC}, ${redirect}, ${first.hash},
                                        ${TOKEN_TTL_DEFAULT_SECONDS}, ${"an app"}) as result`;
      assert.equal(row!.result.outcome, "issued");
      stream = await openStream(first.token);
      await stream.until(/subscriptions\/acknowledged/);

      release();
      const out = await later;
      assert.equal(out.body.error, "invalid_grant");
      await stream.until(/"resultType":"complete"/);
      await stream.until(/$^/);
      assert.equal(stream.ended, true, "a stream held open by the token the first use minted outlived its revocation");
      assert.equal((await rpc("/mcp/connect", "tools/list", {}, first.token)).status, 401, "the first use's token still works");
    } finally {
      release();
      stream?.close();
      forgetDocuments();
    }
  });
});

describe("what the service keeps of an app's documents and keys", () => {
  const answers = new Map<string, number>();
  const asked: string[] = [];
  const doc = (address: string) => JSON.stringify({
    client_id: address, client_name: "Kept", redirect_uris: ["https://apps.example/kept/cb"], token_endpoint_auth_method: "none",
  });

  before(() => {
    useDocumentFetcherForTests(async (address) => {
      asked.push(address);
      const status = answers.get(address) ?? 200;
      if (status !== 200) return { status, contentType: "text/plain", cacheControl: null, body: "" };
      return { status, contentType: "application/json", cacheControl: "max-age=300", body: doc(address) };
    });
  });
  after(() => {
    mock.timers.reset();
    useDocumentFetcherForTests(null);
  });

  test("a document its publisher withdrew is forgotten when the service sees it gone, and one that merely failed to answer stands in", async () => {
    const GONE = "https://apps.example/withdrawn/client.json";
    const DOWN = "https://apps.example/server-down/client.json";
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      assert.ok("client" in await resolveClient(db, GONE));
      assert.ok("client" in await resolveClient(db, DOWN));
      mock.timers.tick(301_000);
      answers.set(GONE, 404);
      answers.set(DOWN, 503);
      assert.ok("why" in await resolveClient(db, GONE), "a withdrawn document was still used");
      assert.ok("client" in await resolveClient(db, DOWN), "a server's error made a good document useless");
      mock.timers.tick(86_400_000);
      assert.ok("why" in await resolveClient(db, DOWN), "a document that failed for a day was still used");
    } finally {
      mock.timers.reset();
    }
  });

  test("a flood of failing addresses cannot push a good document out", async () => {
    const GOOD = "https://apps.example/still-good/client.json";
    assert.ok("client" in await resolveClient(db, GOOD));
    for (let i = 0; i < 1100; i++) {
      const bad = `https://apps.example/fails/${i}/client.json`;
      answers.set(bad, 404);
      await resolveClient(db, bad);
    }
    asked.length = 0;
    assert.ok("client" in await resolveClient(db, GOOD));
    assert.deepEqual(asked, [], "the good document had been pushed out and was fetched again");
  });

  test("a key set that could not be fetched is not asked for again for a minute", async () => {
    const SET = "https://apps.example/keys-down/jwks.json";
    answers.set(SET, 503);
    const client = {
      id: "https://apps.example/keys-down/client.json", kind: "metadata_document" as const, name: "Keys",
      redirectUris: ["https://apps.example/keys-down/cb"], authMethod: "private_key_jwt" as const, secretHash: null,
      jwksUri: SET, jwks: null, signingAlg: null,
    };
    asked.length = 0;
    assert.deepEqual(await keysOf(client), []);
    assert.deepEqual(await keysOf(client), []);
    assert.deepEqual(await keysOf(client, true), []);
    assert.deepEqual(asked, [SET], "a failing key set was fetched on every request");
  });
});

describe("the addresses a code may go to, and those a fetch may reach", () => {
  test("loopback matches whatever port the program opened, and nothing else is loose", () => {
    assert.equal(redirectMatches(["http://localhost/callback"], "http://localhost:51234/callback"), true);
    assert.equal(redirectMatches(["http://127.0.0.1/callback"], "http://127.0.0.1:9/callback"), true);
    assert.equal(redirectMatches(["http://localhost/callback"], "http://localhost:51234/other"), false);
    assert.equal(redirectMatches(["https://app.example/cb"], "https://app.example:444/cb"), false);
    assert.equal(redirectMatches(["https://app.example/cb"], "https://app.example/cb?x=1"), false);
  });

  test("a published document's id is https with a path, and nothing that could be two addresses for one app", () => {
    assert.equal(isMetadataDocumentId("https://claude.ai/oauth/claude-code-client-metadata"), true);
    for (const bad of ["http://app.example/client.json", "https://app.example", "https://app.example/", "https://app.example/a/../b",
      "https://app.example/client.json?x=1", "https://app.example/client.json#f", "https://u:p@app.example/client.json"]) {
      assert.equal(isMetadataDocumentId(bad), false, bad);
    }
    assert.equal(sameResource(`${CONNECT}/`, CONNECT), true);
    assert.equal(sameResource(`https://API.schellingaf.test/mcp/connect`, CONNECT), true);
    assert.equal(sameResource(`${ORIGIN}/mcp`, CONNECT), false);
  });

  test("no fetch reaches this machine, a private network or a reserved range", async () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "not-an-address"]) {
      assert.equal(refusedAddress(address), true, address);
    }
    for (const address of ["8.8.8.8", "160.79.104.10", "2606:4700:4700::1111"]) assert.equal(refusedAddress(address), false, address);
    await assert.rejects(fetchJsonDocument("http://apps.example/client.json"), FetchRefused);
    await assert.rejects(fetchJsonDocument("https://127.0.0.1/client.json"), FetchRefused);
    await assert.rejects(fetchJsonDocument("https://[::1]/client.json"), FetchRefused);
    await assert.rejects(fetchJsonDocument("https://localhost/client.json"), FetchRefused);
    await assert.rejects(fetchJsonDocument("https://docs.localhost/client.json"), FetchRefused);
  });
});

// Last in the file: these lower allowances the tests above share.
describe("what a request to connect costs, per address and across the service", () => {
  /** Run `fn` with these settings, and the bucket `key` starting full and left full. */
  async function withAllowance(settings: Record<string, string>, key: string, fn: () => Promise<void>) {
    await fixture.owner`delete from schellingaf.rate_buckets where key = ${key}`;
    try {
      await withEnv(settings, fn);
    } finally {
      await fixture.owner`delete from schellingaf.rate_buckets where key = ${key}`;
    }
  }
  /** Where the browser is sent when it asks to connect from `address`. */
  const from = async (address: string, clientId: string, redirect: string) =>
    (await startConnect(clientId, redirect, {}, { "X-Forwarded-For": address })).location;

  test("an address past its allowance is sent to try later before its app is looked up or fetched", async () => {
    const address = "203.0.113.77";
    await withAllowance({ APP_CONNECTION_BURST: "1" }, `app-connect:${address}`, async () => {
      const redirect = "https://apps.example/never/cb";
      assert.equal(await from(address, `schellingaf_client_${"1".repeat(32)}`, redirect), `${SITE}/me/connect?error=unknown_app`);
      let asked = 0;
      useDocumentFetcherForTests(async () => {
        asked++;
        return { status: 404, contentType: "text/plain", cacheControl: null, body: "" };
      });
      assert.equal(await from(address, "https://apps.example/flood/1/client.json", redirect), `${SITE}/me/connect?error=busy`);
      assert.equal(asked, 0, "a document was fetched for an address past its allowance");
      useDocumentFetcherForTests(null);
    });
  });

  test("a network past its allowance is sent to try later, from whichever of its addresses", async () => {
    await withAllowance({ APP_CONNECTION_NETWORK_BURST: "1" }, "app-connect-net:2001:db8:5::/48", async () => {
      const clientId = await registerPublicApp("https://app.example/cb");
      const ask = (address: string) => from(address, clientId, "https://app.example/cb");
      assert.match(await ask("2001:db8:5:1::1"), /\/me\/connect\?request=/);
      assert.equal(await ask("2001:db8:5:2::1"), `${SITE}/me/connect?error=busy`, "another /64 of the same /48 was let through");
      assert.match(await ask("2001:db8:6:1::1"), /\/me\/connect\?request=/, "another network was refused");
    });
  });

  test("an address past its registrations is refused before the database is asked", async () => {
    const address = "203.0.113.150";
    await withAllowance({ APP_REGISTRATION_BURST: "1", APP_REGISTRATIONS_PER_HOUR: "1" }, `app-register:${address}`, async () => {
      const register = async () => read(await send(app, "POST", "/oauth/register", null,
        { redirect_uris: ["https://app.example/cb"], token_endpoint_auth_method: "none" }, { "X-Forwarded-For": address }));
      assert.equal((await register()).status, 201);
      const byDatabase = await register();
      assert.equal(byDatabase.status, 429);
      assert.match(byDatabase.body.error_description, /Too many apps registered from here/);
      const inMemory = await register();
      assert.equal(inMemory.status, 429);
      assert.equal(inMemory.body.error, "temporarily_unavailable");
      assert.match(inMemory.body.error_description, /Too many requests from here/, "the third call was not refused in memory");
      assert.equal(inMemory.headers.get("access-control-allow-origin"), "*");
    });
  });

  test("the service past its allowance sends every person to try later, from however many addresses", async () => {
    await withAllowance({ APP_CONNECTIONS_PER_DAY: "24" }, "service:app-connections", async () => {
      const clientId = await registerPublicApp("https://app.example/cb");
      const ask = (address: string) => from(address, clientId, "https://app.example/cb");
      assert.match(await ask("198.51.100.201"), /\/me\/connect\?request=/);
      assert.equal(await ask("198.51.100.202"), `${SITE}/me/connect?error=busy`);
    });
  });
});
