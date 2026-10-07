// A connector tool reaches its own route and no other, whatever its arguments say.
//
// A tool builds the address of the route it calls from its arguments, each part
// encoded, but encoding leaves "." and "..", which an address's parser takes as a step
// in the path: a SPACE named ".." would turn `/v1/spaces/../blocks/<peer>` into
// `/v1/blocks/<peer>`, a direct-message block, and through /mcp/connect an app's token
// would reach routes its tools never name. No name or id is either, so the in-process
// call refuses such an address before any route is asked.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { useService, app, agent, call, connector, read, send, requestsDuring, HOST } from "./lib/service.ts";
import { filedTool } from "./helpers.ts";

const SITE = "https://site.sec-mcp-bridge-paths.test";
useService("sec_mcp_bridge_paths", { siteOrigin: SITE, passkeys: { rpId: "site.sec-mcp-bridge-paths.test", origins: [SITE] } });

/** A tool called at /mcp, as the KEY `token`: whether it refused, and its text. */
async function tool(name: string, args: unknown, token: string) {
  const { message } = await connector("tools/call", { name, arguments: args }, token);
  assert.ok(message.result, JSON.stringify(message.error ?? message));
  return { isError: message.result.isError === true, text: String(message.result.content?.[0]?.text ?? "") };
}

/** A token an app was given at /mcp/connect, by the whole flow a person allows. */
async function appToken(person: { token: string }, scope = "read write"): Promise<string> {
  const registered = await call("POST", "/oauth/register", null, {
    redirect_uris: ["http://localhost/callback"], token_endpoint_auth_method: "none", client_name: "Paths App",
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const clientId = registered.body.client_id as string;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "http://localhost:43117/callback";
  const resource = `https://${HOST}/mcp/connect`;
  const started = await app.request(`/oauth/authorize?${new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: "S256", scope, resource,
  })}`);
  const requestId = new URL(started.headers.get("location") ?? "").searchParams.get("request")!;
  const approved = await read(await send(app, "POST", `/v1/authorizations/${requestId}/approve`, person.token, {}, { "content-type": "application/json" }));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const code = new URL(approved.body.redirect_to).searchParams.get("code")!;
  const issued = await read(await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource }).toString(),
  }));
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return issued.body.access_token as string;
}

/** A tool called at /mcp/connect with an app's token. */
async function connectTool(name: string, args: unknown, bearer: string) {
  const res = await app.request("/mcp/connect", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: filedTool({ name, arguments: args }) }),
  });
  const text = await res.text();
  const data = text.split("\n").filter((line) => line.startsWith("data:")).at(-1);
  const message = JSON.parse(data ? data.slice(5) : text);
  assert.ok(message.result, JSON.stringify(message));
  return { isError: message.result.isError === true, text: String(message.result.content?.[0]?.text ?? "") };
}

/** How many in-process requests reached a path outside /v1/spaces while `during` ran. */
const outsideSpaces = (paths: string[], during: () => Promise<unknown>) =>
  requestsDuring((_, path) => paths.includes(path), during);

describe("a connector tool reaches its own route alone", () => {
  test("a SPACE named .. cannot turn a SPACE's block into a direct-message block", async () => {
    const me = await agent();
    const other = await agent();
    let out!: Awaited<ReturnType<typeof tool>>;
    const reached = await outsideSpaces([`/v1/blocks/${other.peerId}`], async () => {
      out = await tool("schellingaf_space_control", { action: "block", name: "..", peer_id: other.peerId }, me.token);
    });
    assert.equal(reached, 0, `the tool reached PUT /v1/blocks/<peer>:\n${out.text}`);
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /^INVALID_REQUEST\./);
    // And nothing was blocked behind the agent's back.
    const blocks = await call("GET", "/v1/blocks", me.token);
    assert.equal(blocks.status, 200);
    assert.deepEqual(blocks.body.items, []);
  });

  test("a SPACE named .. or . reads no other route, for a read either", async () => {
    const me = await agent();
    for (const [args, path] of [
      [{ action: "blocks", name: ".." }, "/v1/blocks"],
      [{ action: "get", name: "." }, "/v1/spaces/"],
    ] as const) {
      let out!: Awaited<ReturnType<typeof tool>>;
      const reached = await outsideSpaces([path], async () => {
        out = await tool("schellingaf_spaces", args, me.token);
      });
      assert.equal(reached, 0, `schellingaf_spaces ${JSON.stringify(args)} reached ${path}:\n${out.text}`);
      assert.equal(out.isError, true, out.text);
      assert.match(out.text, /^INVALID_REQUEST\./);
    }
  });

  test("an app's token at /mcp/connect reaches no route its tool does not name", async () => {
    const person = await agent();
    const bearer = await appToken(person);
    let out!: Awaited<ReturnType<typeof connectTool>>;
    const reached = await outsideSpaces(["/v1/posts", "/v1/tasks"], async () => {
      out = await connectTool("schellingaf_read_space", { space: ".." }, bearer);
      assert.equal(out.isError, true, out.text);
      out = await connectTool("schellingaf_task", { action: "list", space: ".." }, bearer);
    });
    assert.equal(reached, 0, `an app's token reached a route outside its tool's:\n${out.text}`);
    assert.equal(out.isError, true, out.text);
    assert.match(out.text, /^INVALID_REQUEST\./);
  });

  test("an honest name still reaches its route, and a missing SPACE is still SPACE_NOT_FOUND", async () => {
    const me = await agent();
    const out = await tool("schellingaf_spaces", { action: "get", name: "no-such-space-here" }, me.token);
    assert.equal(out.isError, true);
    assert.match(out.text, /^SPACE_NOT_FOUND\./);
    const made = await call("POST", "/v1/spaces", me.token, { name: "paths-honest", title: "Honest", visibility: "private" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const profile = await tool("schellingaf_spaces", { action: "get", name: "paths-honest" }, me.token);
    assert.equal(profile.isError, false, profile.text);
    assert.match(profile.text, /"paths-honest"/);
  });
});
