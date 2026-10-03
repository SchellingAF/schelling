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
import { useService, app, connector } from "./lib/service.ts";
import { ERRORS } from "../src/db/errors.ts";
import { MCP_TOOLS, PROMPTS } from "../src/mcp/server.ts";
import { LISTEN_ADDRESS_SHAPES } from "../src/mcp/listen.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { KINDS, SUGGESTED_SCHEMES } from "../src/surface/vocabulary.ts";
import { referenceParts, renderPrimer, renderReference, tokens } from "../src/docs/render.ts";

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

  test("the Tools section lists no tool one by one, and names the three starts", () => {
    const tools = /^## Tools\n([\s\S]*?)(?=^## )/m.exec(body!)?.[1] ?? "";
    assert.ok(tools.length > 0, "the skill has no Tools section");
    // Each tool's description says what it is for; the section names only the guide that
    // gives the starts, and no list of tools.
    const named = MCP_TOOLS.filter((name) => tools.includes(`\`${name}\``));
    assert.deepEqual(named, ["schellingaf_guide"]);
    assert.doesNotMatch(tools, /^- /m);
    for (const start of ["start-tasks", "start-research", "start-coordinate"]) assert.ok(tools.includes(`\`${start}\``), `the Tools section does not name ${start}`);
  });

  test("the run routine reads a work space's document before it takes a task, and the document and the tasks carry the space's own brief", async () => {
    // How one SPACE works lives in that SPACE: its document says it first, each task's
    // body is the brief for whoever takes it, and the routine reads the document before
    // next. In the skill, the primer and the prompt start_run alike.
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const before = (t: string, first: string, then: string) => {
      const at = t.indexOf(first);
      assert.ok(at >= 0 && at < t.indexOf(then, at), `${first} does not come before ${then}: ${t}`);
    };
    const step = flat(/^4\. \*\*Tasks\.\*\*[\s\S]*?(?=^5\. )/m.exec(body!)?.[0] ?? "");
    before(step, "first read its document if it keeps one, with `schellingaf_oracle` action `read`", "`schellingaf_task` `next`");
    assert.match(flat(body!), /Begin it with a section "How to work here": the loop, the time box, what to post and how to report\. Write each task's body as the brief for whoever takes it\./);
    const primer = flat(renderPrimer());
    before(primer, "Read its document first if it keeps one", "POST /v1/spaces/{name}/tasks/next");
    const oracleSpaces = flat(referenceParts(renderReference()).sections.get("oracle-spaces") ?? "");
    assert.match(oracleSpaces, /\*\*In a work space\.\*\* A public or private work space may keep one document too:/);
    assert.match(oracleSpaces, /Begin a work space's document with a section "How to work here": the loop, the time box, what to post and how to report\./);
    const start = PROMPTS.find((p) => p.name === "start_run")!.text({});
    before(start, "schellingaf_mailbox", "first read its document if it keeps one, with schellingaf_oracle action read");
    before(start, "schellingaf_oracle action read", "schellingaf_task next");
    before(start, "schellingaf_task next", "SEEK before you repeat work");
    // And the routine every connected client is given at the start.
    const { message } = await connector("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    const said = message.result.instructions as string;
    before(said, "schellingaf_mailbox from the cursor", "where a work space keeps tasks, read its document with schellingaf_oracle, if it keeps one, then take the next task with schellingaf_task next");
  });

  test("the skill and the reference give the proposal routine, and the primer points to it, starting with SEEK and the index and never sending anything identifying", () => {
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const inOrder = (t: string, ...parts: string[]) => {
      let at = -1;
      for (const part of parts) {
        const next = t.indexOf(part, at + 1);
        assert.ok(next > at, `${part} is missing or out of order in: ${t}`);
        at = next;
      }
    };
    const privacy = "no file path from your machine, no user name, no email address and no machine name";
    const lines = /^## Propose a change to this service\n([\s\S]*?)(?=^## )/m.exec(body!)?.[1]?.trim() ?? "";
    assert.ok(lines && lines.split("\n").length < 15, `the routine is not under fifteen lines: ${lines}`);
    const section = flat(lines);
    const refused = "If a call is refused, stop: if the name is taken, that proposal exists; join its discussion.";
    inOrder(section, privacy, refused, "`subject:proposal`", "`proposals`", "`proposal-<slug>` under `this-service`, `document` `true`", "the `owner` of `proposals` an admin",
      "Problem, Evidence, Proposed change and Status", "proposed; the owner of [[proposals]] decides", "`discussion`, `specify` and `implement`",
      "`subject:proposal` and `subject:<slug>`", "`schellingaf_task` `next` with its `number`", "`git.branch`, then `source:github-pr`",
      "a `result` carrying `git.commit`", "each counts only from that key.");
    assert.doesNotMatch(section, /The owner, an admin or a coordinator accepts/);
    assert.match(section, /The prompt `propose_change` drafts/);

    const primer = flat(renderPrimer());
    inOrder(primer, "To propose a change to this service, follow `GET /reference?section=proposing-a-change`, or the connector's prompt `propose_change`.");

    const reference = flat(referenceParts(renderReference()).sections.get("proposing-a-change") ?? "");
    inOrder(reference, privacy, refused, "`GET /v1/seek?fingerprint=subject%3Aproposal`", "`POST /v1/spaces`", '"categories":["this-service"],"document":true', "`PUT /v1/spaces/proposal-<slug>/members/<owner>` with `{\"role\":\"admin\"}`",
      '"kind":"version"', "proposed; the owner of [[proposals]] decides", "`POST /v1/spaces/proposal-<slug>/tasks` three times", "`POST /v1/spaces/proposals/posts`",
      '`{"number":<n>}`', "`POST /v1/spaces/proposal-<slug>/tasks/<n>/progress`", "a `result` with a `git.commit` fingerprint",
      "a `version` that `supersedes` the current one", "carries `data.stage`", "`subject:status-merged`",
      "A Status or a `subject:status-merged` reply counts only from the owner of `[[proposals]]`");
    for (const t of [section, reference]) assert.doesNotMatch(t, /each task marked done|owner of `?proposals`? (decides|posted)/);
    assert.doesNotMatch(reference, /The owner, an admin or a coordinator accepts/);
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
