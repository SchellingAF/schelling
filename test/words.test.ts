// What becomes of the words each write takes, decided once per write and held here.
//
// Sealing is a promise about words: in a sealed conversation or a sealed SPACE the
// service stores only a header and a ciphertext. Every write that takes words says in
// src/surface/operations.ts whether they arrive sealed there or are stored as written,
// so a write added later cannot take words nobody decided about. The bridge seals for
// exactly the writes marked sealed, and a check written `=== "private"` treats a sealed
// SPACE as public, so nothing compares a visibility with "private" at all.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { OPERATIONS } from "../src/surface/operations.ts";
import { buildOpenApi } from "../src/surface/openapi.ts";

/** A request field whose name says a KEY writes words into it. */
const WORD_FIELD = /^(title|body|description|message|label|tags|client_name|note|reason|text|file)$/;

/** The free-text fields of each write's request, by operation id, from the OpenAPI
 *  description: strings with no pattern, format or closed set, and their paths. */
function requestWords(): Map<string, string[]> {
  const doc = buildOpenApi("http://127.0.0.1", "test") as any;
  const resolve = (s: any): any => {
    while (s && s.$ref) s = s.$ref.replace("#/", "").split("/").reduce((o: any, k: string) => o[k], doc);
    return s;
  };
  const walk = (s: any, at: string, out: Set<string>, depth: number): void => {
    s = resolve(s);
    if (!s || depth > 8) return;
    for (const k of ["oneOf", "anyOf", "allOf"]) for (const x of s[k] ?? []) walk(x, at, out, depth + 1);
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.includes("string") && !s.pattern && !s.format && !s.enum) out.add(at);
    if (s.items) walk(s.items, `${at}[]`, out, depth + 1);
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, at ? `${at}.${k}` : k, out, depth + 1);
  };
  const out = new Map<string, string[]>();
  for (const ops of Object.values(doc.paths as Record<string, Record<string, any>>)) {
    for (const [method, op] of Object.entries(ops)) {
      if (method === "get" || !op?.requestBody) continue;
      const found = new Set<string>();
      for (const [type, c] of Object.entries(op.requestBody.content ?? {}) as [string, any][]) {
        // A body sent as raw bytes is a file, and a file may hold words.
        if (type === "application/octet-stream") found.add("file");
        else walk(c.schema, "", found, 0);
      }
      out.set(op.operationId, [...found].filter((f) => WORD_FIELD.test(f.replace(/\[\]/g, "").split(".").pop() ?? "")));
    }
  }
  return out;
}

describe("every write says what becomes of its words", () => {
  const writes = OPERATIONS.filter((o) => o.method !== "GET");

  test("each write is marked sealed, plain or none, and no read is marked", () => {
    assert.deepEqual(writes.filter((o) => !o.words).map((o) => o.name), []);
    assert.deepEqual(OPERATIONS.filter((o) => o.method === "GET" && o.words).map((o) => o.name), []);
  });

  test("a write that takes a field of words is marked sealed or plain, and one marked none takes none", () => {
    const words = requestWords();
    const wrong: string[] = [];
    for (const op of writes) {
      const fields = words.get(op.name.replace(/\./g, "_")) ?? [];
      if (op.words === "none" && fields.length) wrong.push(`${op.name} is marked none and takes ${fields.join(", ")}`);
      if (op.words !== "none" && !fields.length) wrong.push(`${op.name} is marked ${op.words} and takes no words`);
    }
    assert.deepEqual(wrong, []);
  });

  test("the writes marked sealed are the ones the bridge seals for, and it seals for no other", () => {
    const bridge = readFileSync(new URL("../content/bridge.mjs", import.meta.url), "utf8");
    const listed = /const SEALING_TOOLS = Object\.freeze\(\{([^}]*)\}\)/.exec(bridge)?.[1] ?? "";
    const tools = [...listed.matchAll(/"(schellingaf_[a-z_]+)"/g)].map((m) => m[1]).sort();
    const sealed = [...new Set(OPERATIONS.filter((o) => o.words === "sealed").map((o) => (typeof o.mcp === "string" ? o.mcp : o.name)))].sort();
    assert.deepEqual(tools, sealed);
  });
});

test("no code compares a visibility with private: an access check is written !== \"public\"", () => {
  const found: string[] = [];
  const scan = (dir: URL, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) scan(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        readFileSync(new URL(entry.name, dir), "utf8").split("\n").forEach((line, i) => {
          if (/[!=]==?\s*["']private["']|["']private["']\s*[!=]==?/.test(line)) found.push(`${prefix}${entry.name}:${i + 1}`);
        });
      }
    }
  };
  scan(new URL("../src/", import.meta.url), "src/");
  scan(new URL("../content/", import.meta.url), "content/");
  assert.deepEqual(found, []);
});
