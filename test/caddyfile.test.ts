// The proxy records nothing of the website's requests: an invite link carries its code
// in the website's address, so a log of those addresses is a log of credentials. Why it
// takes two lines of configuration, and what was measured, is the comment above the
// website's block in the Caddyfile; this holds the two lines there. It also holds that
// the API's block adds no header the service sets itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CADDYFILE = readFileSync(new URL("../Caddyfile", import.meta.url), "utf8");

/** A block's body, from the line that opens it to the brace that closes it. */
function block(opening: RegExp): string {
  const start = CADDYFILE.search(opening);
  assert.ok(start >= 0, `no block matching ${opening}`);
  // The block opens with the last brace on its first line: a site's address may
  // carry placeholders in braces of its own.
  const lineEnd = CADDYFILE.indexOf("\n", start);
  let depth = 0;
  for (let i = CADDYFILE.lastIndexOf("{", lineEnd); i < CADDYFILE.length; i++) {
    if (CADDYFILE[i] === "{") depth++;
    if (CADDYFILE[i] === "}" && --depth === 0) return CADDYFILE.slice(start, i + 1);
  }
  throw new Error(`the block matching ${opening} never closes`);
}

test("the website's requests go to a logger that writes nowhere", () => {
  const site = block(/^\{\$SITE_HOST\}, www\.\{\$SITE_HOST\} \{/m);
  assert.match(site, /\n\tlog site \{\n\t\toutput discard\n\t\}/);
});

test("the default log leaves the website's logger out, its errors included", () => {
  const global = block(/^\{\n/m);
  assert.match(global, /log default \{[^}]*exclude http\.log\.access\.site http\.log\.error\.site/);
});

test("the API keeps its own access log", () => {
  const api = block(/^\{\$API_HOST\} \{/m);
  assert.match(api, /\n\tlog \{\n\t\toutput stdout/);
});

test("the API's security headers are the service's own, and the proxy adds none", () => {
  // The service sets Strict-Transport-Security and X-Content-Type-Options on every
  // answer (test/proxy.test.ts), so they hold behind any proxy. A second copy here
  // would be a second value to keep equal.
  const api = block(/^\{\$API_HOST\} \{/m);
  assert.doesNotMatch(api, /^\s*header\s+Strict-Transport-Security/im);
  assert.doesNotMatch(api, /^\s*header\s+X-Content-Type-Options/im);
  assert.match(api, /\n\theader -Server\n/);
});
