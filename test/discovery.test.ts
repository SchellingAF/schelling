// The discovery files: what a directory reads before it has a connector to call.
// Each "yes" path answers its document with the server card's caching and CORS
// headers, the copies are the same bytes, the documents validate against their
// published schemas, and the paths left out on purpose stay not found.
//
// The schemas are copied into test/fixtures from their sources:
// - mcp-server-card-schema.json: schema.json of github.com/modelcontextprotocol/ext-server-card
//   at 526201bbc80231daa40ffcdecfc9da4e54e5dc93 (the schema the card's $schema names,
//   which is not published at that address yet);
// - ard-entry-schema.json: spec/schemas/ard-entry.schema.json of
//   github.com/ards-project/ard-spec at 49eb4df6f3841ccecc5c31d5175117337b568bdf.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AjvJsonSchemaValidator, addFormats } from "@modelcontextprotocol/server/validators/ajv";
import { createApp } from "../src/http/app.ts";
import { EXAMPLE_CONFIG, PLACES, STUB_DB } from "../scripts/copy-places.ts";
import { DIRECTORY_PATHS, discoveryDocuments, glamaClaim, readServerJson } from "../src/surface/discovery.ts";
import { OPERATIONS } from "../src/surface/operations.ts";

const ORIGIN = "https://api.discovery.test";
const config = { ...EXAMPLE_CONFIG, apiHost: "api.discovery.test", publicOrigin: ORIGIN };
const app = createApp(config, STUB_DB);
const listing = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));

const LINKSET = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
const SERVED: [path: string, type: string][] = [
  ["/mcp/server-card", "application/mcp-server-card+json"],
  ["/mcp/connect/server-card", "application/mcp-server-card+json"],
  ["/.well-known/mcp/server-card.json", "application/json"],
  ["/.well-known/mcp.json", "application/json"],
  ["/.well-known/ai-catalog.json", "application/ai-catalog+json"],
  ["/.well-known/ard.json", "application/json"],
  ["/.well-known/api-catalog", LINKSET],
];
const CARDS = SERVED.slice(0, 4).map(([p]) => p);
const NEVER = [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
  "/.well-known/agents.json",
  "/.well-known/owners.json",
  "/.well-known/ai-plugin.json",
  "/.well-known/did.json",
  "/.well-known/x402",
  "/.well-known/x402.json",
  "/.well-known/glama.json",
];

const Ajv2020 = (new AjvJsonSchemaValidator() as unknown as { ajv: object }).ajv.constructor as new (options: Record<string, unknown>) => any;
function validatorOf(fixture: string, pointer = "") {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8"));
  if (!pointer) return ajv.compile({ ...schema, $ref: "#/$defs/ServerCard" });
  ajv.addSchema(schema);
  return ajv.getSchema(`${schema.$id}${pointer}`)!;
}

async function get(path: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await app.request(path, init);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe("the discovery files are served", () => {
  // The bare protected resource path is served as the other OAuth documents are, so
  // it is checked below, not here.
  test("every served path answers its exact type, an ETag and 304, an hour's cache and the card's CORS headers", async () => {
    for (const [path, type] of SERVED) {
      const res = await get(path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), type, path);
      assert.equal(res.headers.get("cache-control"), "public, max-age=3600", path);
      assert.equal(res.headers.get("access-control-allow-origin"), "*", path);
      assert.equal(res.headers.get("access-control-allow-methods"), "GET", path);
      assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type, If-None-Match", path);
      assert.match(res.headers.get("access-control-expose-headers") ?? "", /\bETag\b/, path);
      const etag = res.headers.get("etag");
      assert.ok(etag, `${path} has no ETag`);
      const again = await get(path, { headers: { "If-None-Match": etag } });
      assert.equal(again.status, 304, path);
      assert.equal(again.text, "", path);
      const preflight = await get(path, { method: "OPTIONS" });
      assert.equal(preflight.status, 204, `${path} preflight`);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*", `${path} preflight`);
      assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, If-None-Match", `${path} preflight`);
    }
  });

  test("the four card paths answer the same bytes: the v1 card, from server.json, at this origin", async () => {
    const bodies = await Promise.all(CARDS.map(async (p) => (await get(p)).text));
    for (const body of bodies) assert.equal(body, bodies[0]);
    const card = JSON.parse(bodies[0]!);
    assert.equal(card.$schema, "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
    assert.equal(card.name, listing.name);
    assert.equal(card.version, listing.version);
    assert.equal(card.title, listing.title);
    assert.ok(card.description.length <= 100, "a card's description is at most 100 characters");
    for (const absent of ["packages", "tools", "capabilities"]) assert.equal(card[absent], undefined, absent);
    // No protocol versions: the SDK's list and the capability document's differ.
    for (const remote of card.remotes) assert.equal(remote.supportedProtocolVersions, undefined);
    assert.deepEqual(card._meta, { "com.schellingaf/contact": "mailto:schellingaf@proton.me" });
    assert.equal(card.remotes.length, listing.remotes.length);
    card.remotes.forEach((remote: any, i: number) => {
      assert.ok(remote.url.startsWith(`${ORIGIN}/`), remote.url);
      assert.equal(new URL(remote.url).pathname, new URL(listing.remotes[i].url).pathname);
      assert.equal(remote.type, listing.remotes[i].type);
      // A header's description names this origin, not the live service's.
      assert.equal(JSON.stringify(remote.headers ?? null).includes("api.schellingaf.com"), false);
      assert.equal(JSON.stringify(remote.headers ?? null), JSON.stringify(listing.remotes[i].headers ?? null).replaceAll("https://api.schellingaf.com", ORIGIN));
    });
    const validate = validatorOf("mcp-server-card-schema.json");
    assert.ok(validate(card), JSON.stringify(validate.errors, null, 2));
    // And the validator has teeth: a card without its name, or with a registry schema, is refused.
    assert.equal(validate({ ...card, name: undefined }), false);
    assert.equal(validate({ ...card, $schema: listing.$schema }), false);
  });

  test("the AI catalog and the ARD manifest are one document, with one entry pointing at the card", async () => {
    const [aiCatalog, ard] = await Promise.all(["/.well-known/ai-catalog.json", "/.well-known/ard.json"].map(async (p) => (await get(p)).text));
    assert.equal(ard, aiCatalog);
    const catalog = JSON.parse(aiCatalog!);
    assert.equal(catalog.specVersion, "1.0");
    assert.equal(catalog.host.displayName, listing.title);
    assert.equal(catalog.entries.length, 1);
    for (const entry of catalog.entries) {
      assert.match(entry.identifier, /^urn:air:schellingaf\.com:/);
      assert.equal(entry.displayName, listing.title);
      assert.equal(entry.type, "application/mcp-server-card+json");
      assert.equal(("url" in entry ? 1 : 0) + ("data" in entry ? 1 : 0), 1, "exactly one of url and data");
      assert.equal(entry.url, `${ORIGIN}/mcp/server-card`);
      assert.ok(entry.representativeQueries.length >= 2 && entry.representativeQueries.length <= 5);
      assert.equal(entry.version, listing.version);
    }
    const validate = validatorOf("ard-entry-schema.json", "#/$defs/ArdManifest");
    assert.ok(validate(catalog), JSON.stringify(validate.errors, null, 2));
    assert.equal(validate({ entries: [{ ...catalog.entries[0], displayName: undefined }] }), false);
  });

  test("a version bump in server.json moves the card and the catalog entry", () => {
    const { card, catalog } = discoveryDocuments({ ...readServerJson().listing!, version: "9.9.9" }, ORIGIN);
    assert.equal(card.version, "9.9.9");
    assert.equal((catalog.entries as { version: string }[])[0]!.version, "9.9.9");
  });

  test("the API catalog links the API and the connector to their descriptions, and HEAD names it", async () => {
    const linkset = JSON.parse((await get("/.well-known/api-catalog")).text).linkset;
    assert.equal(linkset[0].anchor, `${ORIGIN}/.well-known/api-catalog`);
    assert.deepEqual(linkset[0].item.map((i: { href: string }) => i.href), [`${ORIGIN}/`, `${ORIGIN}/mcp`]);
    // The API's own address answers, as a link target should.
    assert.equal((await get("/")).status, 200);
    const api = linkset.find((l: { anchor: string }) => l.anchor === `${ORIGIN}/`);
    assert.equal(api["service-desc"][0].href, `${ORIGIN}/openapi.json`);
    assert.equal((await get("/openapi.json")).status, 200);
    for (const method of ["GET", "HEAD"]) {
      const res = await get("/.well-known/api-catalog", { method });
      assert.equal(res.status, 200, method);
      assert.equal(res.headers.get("link"), `<${ORIGIN}/.well-known/api-catalog>; rel="api-catalog"`, method);
      if (method === "HEAD") assert.equal(res.text, "");
    }
  });

  test("the bare protected resource document is the /mcp/connect one", async () => {
    const bare = await get("/.well-known/oauth-protected-resource");
    const inserted = await get("/.well-known/oauth-protected-resource/mcp/connect");
    assert.equal(bare.status, 200);
    assert.deepEqual(JSON.parse(bare.text), JSON.parse(inserted.text));
    assert.equal(JSON.parse(bare.text).resource, `${ORIGIN}/mcp/connect`);
    assert.equal(bare.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(bare.headers.get("access-control-allow-origin"), "*");
  });

  test("the paths left out on purpose are not found, beside their served neighbours", async () => {
    for (const path of NEVER) assert.equal((await get(path)).status, 404, path);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/connect", "/.well-known/ai-catalog.json"]) {
      assert.equal((await get(path)).status, 200, path);
    }
  });

  test("no discovery path is an operation, and each is filed for the copy review", () => {
    const operations = new Set(OPERATIONS.map((o) => o.path));
    const routes = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const path of DIRECTORY_PATHS) {
      assert.equal(operations.has(path), false, `${path} is an operation`);
      if (path === "/.well-known/glama.json") continue; // not routed without a claim
      for (const method of ["GET", "OPTIONS"]) {
        assert.ok(routes.has(`${method} ${path}`), `${method} ${path} is not routed`);
        assert.ok(`${method} ${path}` in PLACES.routes, `${method} ${path} is not filed in PLACES.routes`);
      }
    }
  });
});

describe("where no app can sign a person in, or server.json is unusable", () => {
  test("without OAuth the card names /mcp alone, and /mcp/connect/server-card is not found", async () => {
    const bare = createApp({ ...config, passkeys: null }, STUB_DB);
    const card = JSON.parse(await (await bare.request("/mcp/server-card")).text());
    assert.deepEqual(card.remotes.map((r: { url: string }) => r.url), [`${ORIGIN}/mcp`]);
    assert.equal((await bare.request("/mcp/connect/server-card")).status, 404);
    assert.equal((await bare.request("/.well-known/mcp.json")).status, 200);
  });

  test("a missing or malformed server.json is a reason, never a failure to start, and serves none of its documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discovery-"));
    try {
      const malformed = join(dir, "malformed.json");
      writeFileSync(malformed, "{ not json");
      const partial = join(dir, "partial.json");
      writeFileSync(partial, JSON.stringify({ name: "com.schellingaf/schellingaf", version: "1.0.0" }));
      for (const file of [join(dir, "missing.json"), malformed, partial]) {
        const read = readServerJson(file);
        assert.equal(read.listing, null, file);
        assert.match(read.problem ?? "", /^server\.json /, file);
        const started = createApp({ ...config, listingFile: file }, STUB_DB);
        for (const [path] of SERVED) assert.equal((await started.request(path)).status, 404, `${file}: ${path}`);
        assert.equal((await started.request("/robots.txt")).status, 200);
        assert.equal((await started.request("/.well-known/oauth-protected-resource")).status, 200);
      }
      assert.equal(readServerJson().problem, null, "the repository's own server.json is usable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the connector's serverInfo version is server.json's, as the card's is", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "discovery", version: "0" } } }),
    });
    const text = await res.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    const message = JSON.parse(data ? data.slice(5) : text);
    assert.equal(message.result?.serverInfo?.version, listing.version, text.slice(0, 300));
    assert.equal(message.result?.serverInfo?.name, "schellingaf");
  });
});

describe("Glama's claim", () => {
  const CLAIM = `glama_claim_${"aB3-_".repeat(6)}xy`;

  test("is served only when a well-formed claim is configured", async () => {
    assert.equal(glamaClaim(CLAIM), CLAIM);
    for (const value of [undefined, null, "", "glama_claim_short", `glama_claim_${"a".repeat(33)}`, `x${CLAIM}`, `glama_claim_${"a".repeat(31)}!`]) {
      assert.equal(glamaClaim(value), null, String(value));
      const res = await createApp({ ...config, glamaClaim: value ?? null }, STUB_DB).request("/.well-known/glama.json");
      assert.equal(res.status, 404, String(value));
    }
    const res = await createApp({ ...config, glamaClaim: CLAIM }, STUB_DB).request("/.well-known/glama.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(await res.text(), JSON.stringify({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: CLAIM }));
  });
});

describe("what ships and what crawlers are told", () => {
  test("the image carries server.json, and robots.txt lets crawlers read the cards and nothing else under /mcp", async () => {
    assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /^COPY server\.json \.\/$/m);
    const robots = (await get("/robots.txt")).text;
    assert.match(robots, /^Disallow: \/mcp$/m);
    assert.match(robots, /^Allow: \/mcp\/server-card$/m);
    assert.match(robots, /^Allow: \/mcp\/connect\/server-card$/m);
    // Read as a crawler reads it: the longest matching rule wins.
    const rules = [...robots.matchAll(/^(Allow|Disallow): (\S+)$/gm)].map((m) => ({ allow: m[1] === "Allow", prefix: m[2]! }));
    const allowed = (path: string) => rules.filter((r) => path.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0]?.allow ?? true;
    for (const path of ["/mcp/server-card", "/mcp/connect/server-card", "/.well-known/ai-catalog.json", "/llms.txt"]) assert.equal(allowed(path), true, path);
    for (const path of ["/mcp", "/mcp/connect", "/v1/spaces"]) assert.equal(allowed(path), false, path);
  });
});
