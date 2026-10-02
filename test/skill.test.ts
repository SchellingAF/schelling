// The agent skill: a file an agent loads by its description and follows, so every
// rule of the format it is loaded by, and every name it tells an agent to use, is
// checked here against the service that has to answer to it.
//
// The format is the Agent Skills specification (agentskills.io/specification): a
// SKILL.md in a folder of the same name, YAML front matter with a name and a
// description, and a body kept short because it is loaded whole into context.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useService, app } from "./lib/service.ts";
import { ERRORS } from "../src/db/errors.ts";
import { MCP_TOOLS, PROMPTS } from "../src/mcp/server.ts";
import { LISTEN_ADDRESS_SHAPES } from "../src/mcp/listen.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { KINDS, SUGGESTED_SCHEMES } from "../src/surface/vocabulary.ts";
import { tokens } from "../src/docs/render.ts";

const FILE = new URL("../content/skills/schellingaf/SKILL.md", import.meta.url);
const text = readFileSync(FILE, "utf8");
const [, frontText, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];

/** The front matter, read by the rules of the small YAML subset a skill uses: plain
 * scalars, and one level of mapping under metadata. Anything else fails. */
function frontMatter(source: string): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  let inside: Record<string, string> | null = null;
  for (const line of source.split("\n")) {
    const nested = /^  ([a-z_]+): (.+)$/.exec(line);
    if (nested && inside) {
      inside[nested[1]!] = nested[2]!;
      continue;
    }
    const top = /^([a-z-]+):(?: (.+))?$/.exec(line);
    assert.ok(top, `front matter line not understood: ${line}`);
    if (top[2] === undefined) {
      inside = {};
      out[top[1]!] = inside;
    } else {
      inside = null;
      // A plain scalar may not hold ": " or start with a character YAML reads as
      // structure; a quoted one would be read differently by a strict parser.
      assert.doesNotMatch(top[2], /: |^[\[{&*!|>'"%@`#]/, `${top[1]} needs no quoting and must not need it`);
      out[top[1]!] = top[2];
    }
  }
  return out;
}

useService("skill", { apiHost: "api.skill.test" });

describe("the agent skill", () => {
  test("its front matter is what the format requires: a name that is its folder's, and a description that says when to use it", () => {
    assert.ok(frontText && body, "SKILL.md does not open with front matter between two --- lines");
    const front = frontMatter(frontText!);
    assert.deepEqual(Object.keys(front).sort(), ["compatibility", "description", "metadata", "name"]);
    const name = front.name as string;
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
    assert.equal(name, new URL(".", FILE).pathname.split("/").filter(Boolean).at(-1), "name differs from its folder");
    const description = front.description as string;
    assert.ok(description.length >= 1 && description.length <= 1024, `description is ${description.length} characters`);
    // Loaded by its description alone, so it says both what and when.
    assert.match(description, /Use it when/);
    assert.ok((front.compatibility as string).length <= 500);
    assert.equal(typeof front.metadata, "object");
  });

  test("it is short enough to load whole: under 500 lines and 5,000 tokens", () => {
    assert.ok(body!.split("\n").length < 500);
    assert.ok(tokens(text) < 5000, `${tokens(text)} tokens`);
  });

  test("every tool, prompt, kind, scheme, address, route and refusal it names is one the service has", () => {
    const tools = new Set(text.match(/schellingaf_[a-z_]+/g) ?? []);
    for (const tool of tools) assert.ok(MCP_TOOLS.includes(tool), `${tool} is not a connector tool`);
    assert.ok(tools.size >= 8, "the skill names fewer tools than an agent needs");

    for (const [, first, second] of text.matchAll(/prompts? `([a-z_]+)`(?: and `([a-z_]+)`)?/g)) {
      for (const prompt of [first, second]) {
        if (prompt !== undefined) assert.ok(PROMPTS.some((p) => p.name === prompt), `${prompt} is not a prompt`);
      }
    }

    const kinds = ["result", "fail", "warn", "workaround", "decision", "obs", "dossier", "handoff", "hold", "go", "veto", "stop"];
    for (const kind of kinds) {
      assert.ok(text.includes(`\`${kind}\``), `the skill no longer names ${kind}`);
      assert.ok(KINDS.includes(kind), `${kind} is not a kind`);
    }

    for (const [, scheme] of text.matchAll(/`([a-z0-9]+\.[a-z0-9.]+):</g)) {
      assert.ok((SUGGESTED_SCHEMES as readonly string[]).includes(scheme!), `${scheme} is not a suggested scheme`);
    }

    const shapes = LISTEN_ADDRESS_SHAPES.map((s) => s.replace("{name}", "<name>").replace("{id}", "<id>"));
    for (const [address] of text.matchAll(/schellingaf:\/\/[a-z<>/]+/g)) {
      assert.ok(shapes.includes(address), `${address} is not an address a stream follows`);
    }

    for (const [, path] of text.matchAll(/`GET (?:https:\/\/api\.schellingaf\.com)?(\/[^`\s]*)`/g)) {
      assert.ok(OPERATIONS.some((o) => o.method === "GET" && o.path === path), `GET ${path} is not an operation`);
    }
    assert.ok(text.includes("https://api.schellingaf.com/bridge.mjs"));

    for (const [, code] of text.matchAll(/`([A-Z][A-Z_]{3,})`/g)) {
      assert.ok(ERRORS[code!], `${code} is not a refusal the service gives`);
    }
  });

  test("the service serves it as the file it is, and a second read is 304", async () => {
    const res = await app.request("/skills/schellingaf/SKILL.md");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await res.text(), text);
    const again = await app.request("/skills/schellingaf/SKILL.md", { headers: { "If-None-Match": res.headers.get("etag")! } });
    assert.equal(again.status, 304);
  });
});
