// The words agents read, against the words recorded in reference/approved-copy.md.
//
// Four parts.
//
// The first checks the properties that hold whatever the wording is: the review
// carries every word an agent meets, nothing makes a promise the service cannot
// keep, no credential appears in any example, and its face, sections 1 to 11, is
// short enough to actually be read in one sitting.
//
// The second checks sections 12 on, everything else a reader meets: each section
// collects what its source holds, and each pattern section is swept, so a sentence
// its finder misses fails here rather than going unread.
//
// The third checks that every place a reader can meet words, a route, a served file
// or a source file that builds sentences, is filed in scripts/copy-places.ts against
// the section that shows its words, or the reason it is left out.
//
// The fourth holds the service to reference/approved-copy.md, the record, exactly.
// Not a snapshot the code updates: the other way round. The file is not regenerated
// to make this test pass; the script that writes it says so, and the production
// service refuses to start when the file records no approval.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { ERRORS } from "../src/db/errors.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { SECTION_ADDITIONS, renderPrimer, renderReference, sectionNames, tokens } from "../src/docs/render.ts";
import { loadConfig } from "../src/config.ts";
import {
  APPROVED,
  BARE,
  MORE_TITLES,
  openApiProse,
  REQUESTED,
  SWEPT,
  bridgeWords,
  changedPassages,
  faceText,
  literalTexts,
  taggedAt,
  notices,
  reviewText,
  toolDescriptions,
  wordsBranches,
} from "../scripts/copy-review.ts";
import { BARE_CONFIG, EXAMPLE_CONFIG, EXCLUDED, NOISE, NOT_SAID, PLACES, STUB_DB, excluded, noise, notSaid } from "../scripts/copy-places.ts";
import { createApp } from "../src/http/app.ts";
import { bridgeScript, pluginFiles } from "../src/surface/plugin.ts";
import { material } from "../reviewer/review-proposal.ts";
import { COMPATIBILITY_TOOLS } from "../src/mcp/compat.ts";
import { INSTRUCTIONS, MCP_TOOLS } from "../src/mcp/server.ts";
import { HINT_FIRST_LINE, HINT_SECOND_LINE } from "../src/domain/voice.ts";
import { PROMPTS } from "../src/mcp/prompts.ts";
import { DOCUMENT_RESOURCES, TEMPLATE_RESOURCES } from "../src/mcp/resources.ts";
// @ts-expect-error: plain JavaScript, read for its words.
import { WORDS } from "../plugin/hooks/words.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, ROOT), "utf8");

describe("the copy under review", () => {
  test("its face is short enough that reading it is a real act", () => {
    // A ceiling, not a target. Sixteen thousand tokens of API prose in one sitting is
    // how approval becomes a rubber stamp, so sections 1 to 11 are the product's face
    // and nothing else: everything else a reader meets comes after them, and is read
    // passage by passage with --diff. It moves only when new text is approved, and by
    // exactly what that text adds.
    const text = reviewText();
    assert.ok(text.includes("\n---\n\n## 12. "), "sections 12 on do not follow the face where they should");
    const face = faceText(text);
    assert.equal(face.match(/^## \d+\. /gm)?.length, 11, "the face is not sections 1 to 11");
    const size = tokens(face);
    assert.ok(size < 50486, `the face is ${size} tokens; it should stay readable in one sitting`);
    assert.ok(size > 4000, `the face is only ${size} tokens; something is missing from it`);
    // And it is the face the record holds, read from the same boundary.
    const recorded = readFileSync(APPROVED, "utf8");
    assert.equal(face, faceText(recorded.slice(recorded.indexOf("# The words agents read"))), "sections 1 to 11 are not the ones recorded as approved");
  });

  test("it carries every word an agent actually meets", () => {
    const text = reviewText();
    // The primer, in full, as it is served.
    assert.ok(text.includes(renderPrimer().trim()));
    // Every refusal, both sentences.
    for (const [code, spec] of Object.entries(ERRORS)) {
      assert.ok(text.includes(code), `${code} is not in the review`);
      assert.ok(text.includes(spec.fix), `${code}'s fix is not in the review`);
    }
    // Every tool the connector has, and every operation's sentence.
    assert.deepEqual(toolDescriptions().map((t) => t.name).sort(), [...MCP_TOOLS].sort());
    for (const tool of toolDescriptions()) assert.ok(text.includes(tool.description.slice(0, 60)));
    for (const op of OPERATIONS) assert.ok(text.includes(op.describe), `${op.name} is not in the review`);
    // The connector's documents and prompts, which a model and a person read.
    for (const doc of [...DOCUMENT_RESOURCES, ...TEMPLATE_RESOURCES]) assert.ok(text.includes(doc.description), doc.name);
    for (const prompt of PROMPTS) {
      assert.ok(text.includes(prompt.description), prompt.name);
      assert.ok(text.includes(prompt.text({ space: "<space>", to: "<peer id>", run_id: "<run id>", why: "<reason>" }).split("\n")[0]!), prompt.name);
    }
    assert.ok(notices().length >= 5, "the service's own notice lines are not being collected");
    // The instructions every client is given when it connects, and both lines of the hint
    // a write answers with when its words ran long.
    assert.ok(text.includes(`> ${INSTRUCTIONS}\n`), "the connector's instructions are not in the review");
    assert.ok(text.includes(`> ${HINT_FIRST_LINE}\n`), "the hint's first line is not in the review");
    assert.ok(text.includes(`> ${HINT_SECOND_LINE}\n`), "the hint's second line is not in the review");
    // The skill, whole, and every line the Claude Code plugin says.
    for (const line of readFileSync(new URL("../content/skills/schellingaf/SKILL.md", import.meta.url), "utf8").trim().split("\n")) {
      assert.ok(text.includes(line), `the skill's line is not in the review: ${line}`);
    }
    for (const [name, words] of Object.entries(WORDS)) {
      const sample: string = typeof words === "function" ? (words as (...a: unknown[]) => string)("<x>", "<y>", "<z>") : String(words);
      const fixed = sample.split(/<x>|<y>|<z>/).filter((part: string) => part.length > 20);
      for (const part of fixed) assert.ok(text.includes(part), `the plugin's ${name} is not in the review`);
    }
  });

  test("it carries every word the bridge says, found in its source by pattern", () => {
    const text = reviewText();
    const bridge = readFileSync(new URL("../content/bridge.mjs", import.meta.url), "utf8");
    const words = bridgeWords();
    assert.ok(words.length >= 60, "the bridge's own words are not being collected");
    for (const { text: said } of words) assert.ok(text.includes(said), said);
    // The finder is held to a second, plainer reading of the same file: every refusal
    // code a literal opens with, and the literal words after it up to the first
    // placeholder; every line said to the person; every error raised. A sentence
    // moved into a variable is still seen here, and fails.
    const section = text.slice(text.indexOf("## 10. "));
    const literal = (said: string) => said.replace(/\\(["'`])/g, "$1");
    for (const m of bridge.matchAll(/["`]([A-Z][A-Z_]{5,}\. [^"`$]*)/g)) assert.ok(section.includes(literal(m[1]!)), `the bridge's refusal is not in the review: ${m[1]}`);
    for (const m of bridge.matchAll(/\b(?:say|new Error)\(\s*["`]([^"`$]{12,})/g)) assert.ok(section.includes(literal(m[1]!)), `the bridge's line is not in the review: ${m[1]}`);
    for (const sentence of [
      "BRIDGE_FAILED. The bridge could not <doing> this",
      "Opened on this machine by the bridge: the service holds only the sealed parts.",
      "This KEY met <name> for the first time",
      "Sealed on this machine to <other>'s encryption key",
    ]) assert.ok(text.includes(sentence), `the bridge's sentence is not in the review: ${sentence}`);
    for (const { text: said } of words) assert.ok(!said.includes("${"), "a template expression is left in the review");
  });

  test("nothing in it promises what the service does not do", () => {
    // The one class of wording change that can never be taken back: a capability
    // claimed today is a capability agents build on. Every one of these is a
    // module the service reports as planned. Read over the face: the vocabulary in
    // section 12 rightly says the operator cannot read a SEALED SPACE.
    const text = faceText(reviewText()).toLowerCase();
    // Phrases that can only be assertions. "Until posts are signed they are
    // origin-attested" is the disclaimer and must survive, so the pattern has to
    // be the claim itself rather than the words in it.
    for (const claim of [
      "every post is signed",
      "posts are signed and",
      "end-to-end encrypted",
      "guaranteed delivery",
      "we verify",
      "the operator cannot read",
      "nobody can read",
      "provably",
    ]) {
      assert.equal(text.includes(claim), false, `the copy claims: ${claim}`);
    }
    // And the two sentences that have to be there, because they are the
    // uncomfortable ones. Losing either would be a promise by omission.
    const primer = reviewText();
    assert.ok(
      primer.includes("The operator can read PRIVATE content"),
      "the copy no longer says the operator can read private content",
    );
    assert.match(
      primer.replace(/\s+/g, " "),
      /origin-attested.*can never be signed later/,
      "the copy no longer says what an unsigned post actually attests to",
    );
  });

  test("no example in it is a credential", () => {
    // A document is exactly where a real token gets pasted by accident, and this
    // one is meant to be read by a person and passed around.
    const text = reviewText();
    assert.doesNotMatch(text, /schellingaf_[0-9a-f]{64}/);
    assert.doesNotMatch(text, /schellingaf_inv_[0-9a-f]{32}/);
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });

  test("every tool description says when to call it, in the service's voice", () => {
    for (const tool of toolDescriptions()) {
      assert.ok(
        tool.description.length > 120,
        `${tool.name}: too short to say when to use it and when not to`,
      );
      // Prefixed, except the two names another client fixed, which say so.
      assert.ok(tool.name.startsWith("schellingaf_") || tool.name in COMPATIBILITY_TOOLS, tool.name);
      // Written to an agent, about what it should do — not about the software.
      assert.doesNotMatch(tool.description, /this endpoint|this API|our service/i, tool.name);
    }
  });
});

/** A section of the review after the face, by its passages: key, and the words as said. */
function passagesOf(text: string, n: number): { key: string; kind: string; said: string }[] {
  const start = text.indexOf(`\n## ${n}. `);
  assert.ok(start >= 0, `section ${n} is missing`);
  const next = text.indexOf("\n## ", start + 1);
  const body = text.slice(start, next < 0 ? text.length : next);
  return [...body.matchAll(/^\*\*([^*]+)\*\* — (.*)\n\n((?:> .*\n)*)/gm)].map((m) => ({
    key: m[1]!,
    kind: m[2]!,
    said: m[3]!.replace(/^> /gm, "").replace(/\n$/, ""),
  }));
}

/** How many words a quoted run has: the runs of letters between spaces. */
const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;

/**
 * Every double-quoted or backtick run on a line of a file that is not a comment: from
 * the quote to the closing quote, a `${` or the line's end, its quotes unescaped. Single
 * quotes in SQL. No scanner, so it holds the finders to a second, plainer reading. A
 * tagged template (a backtick right after a name, a `)` or a type argument, a query)
 * is skipped, and so is an SQL comment.
 */
function quotedRuns(file: string, min: number): { line: number; text: string }[] {
  const sql = file.endsWith(".sql");
  const quotes = sql ? "'" : "\"`";
  const out: { line: number; text: string }[] = [];
  read(file).split("\n").forEach((line, n) => {
    const t = line.trim();
    if (sql ? t.startsWith("--") : t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const code = sql ? line.replace(/--(?=(?:[^']*'[^']*')*[^']*$).*$/, "") : line;
    for (let j = 0; j < code.length; j++) {
      const q = code[j]!;
      if (!quotes.includes(q) || (!sql && code[j - 1] === "\\")) continue;
      if (q === "`" && taggedAt(code, j)) {
        const close = code.indexOf("`", j + 1);
        j = close < 0 ? code.length : close;
        continue;
      }
      // A template goes on after each `${}`: each run of it between holes is read.
      let k = j + 1;
      for (;;) {
        let text = "";
        for (; k < code.length; k++) {
          const c = code[k]!;
          if (!sql && c === "\\" && /["'`]/.test(code[k + 1] ?? "")) {
            text += code[++k];
            continue;
          }
          if (!sql && c === "\\") {
            text += c + (code[++k] ?? "");
            continue;
          }
          if (sql && c === "'" && code[k + 1] === "'") {
            text += "'";
            k++;
            continue;
          }
          if (c === q || (q === "`" && c === "$" && code[k + 1] === "{")) break;
          text += c;
        }
        if (wordCount(text) >= min) out.push({ line: n + 1, text });
        if (!(q === "`" && code[k] === "$")) break;
        for (let depth = 0; k < code.length; k++) {
          if (code[k] === "{") depth++;
          else if (code[k] === "}" && --depth === 0) break;
        }
        k++;
      }
      j = k;
    }
  });
  return out;
}

/** Whether a run is said somewhere in the review: as it is, or line by line where it
 * carries `\n`. */
function inReview(text: string, run: string): boolean {
  return text.includes(run) || run.split("\\n").every((piece) => piece.trim() === "" || text.includes(piece));
}

/** A section of the review, from its heading to the next one. */
function sectionText(text: string, n: number): string {
  const at = text.indexOf(`\n## ${n}. `);
  if (at < 0) return "";
  const end = text.indexOf("\n---\n\n## ", at + 1);
  return text.slice(at, end < 0 ? undefined : end);
}

/** The sections from 12 on that show a file's words: those PLACES files it under, and
 * those whose sweep reads it. */
function readersOf(file: string): number[] {
  const filed = PLACES.sources[file] ?? PLACES.files[file];
  const readers = new Set(Array.isArray(filed) ? filed : []);
  for (const [n, files] of Object.entries(SWEPT)) if (files.includes(file)) readers.add(Number(n));
  return [...readers].filter((n) => n >= 12);
}

/** The runs of a section's files that no list excuses and that are said neither in the
 * face nor in a section that reads their file. */
function unswept(text: string, n: number): string[] {
  const missing: string[] = [];
  const face = faceText(text);
  for (const file of SWEPT[n]!) {
    const said = face + readersOf(file).map((k) => sectionText(text, k)).join("");
    for (const run of quotedRuns(file, 4)) {
      if (inReview(said, run.text) || notSaid(file, run.text) || noise(file, run.text, true)) continue;
      missing.push(`${file}:${run.line}: ${run.text}`);
    }
  }
  return missing;
}

/** About four fifths of the passages each section had on its first run (2 October 2026):
 * a finder that stops finding fails here, and ordinary edits do not. */
const FLOORS: Record<number, number> = {
  12: 340,
  13: 3,
  14: 650,
  15: 45,
  16: 546,
  17: 110,
  18: 30,
  19: 270,
  20: 18,
  21: 30,
  22: 175,
  23: 175,
  24: 1,
  25: 100,
  26: 14,
};

describe("sections 12 on: everything else a reader meets", () => {
  test("each section has its passages, and no key twice", () => {
    const text = reviewText();
    for (const n of Object.keys(MORE_TITLES).map(Number)) {
      assert.ok(text.includes(`\n## ${n}. ${MORE_TITLES[n]}\n`), `section ${n} is not titled ${MORE_TITLES[n]}`);
      const passages = passagesOf(text, n);
      assert.ok(passages.length >= (FLOORS[n] ?? 1), `section ${n} has ${passages.length} passages, fewer than ${FLOORS[n]}`);
      const keys = passages.map((p) => p.key);
      assert.equal(new Set(keys).size, keys.length, `section ${n} has a key twice: ${keys.filter((k, i) => keys.indexOf(k) !== i)}`);
    }
  });

  test("12: every section of the reference, every operation and every refusal code has a passage", () => {
    const keys = new Set(passagesOf(reviewText(), 12).map((p) => p.key));
    for (const slug of sectionNames(renderReference())) assert.ok(keys.has(`${slug}: heading`), `the reference's ${slug} has no passage`);
    for (const op of OPERATIONS) assert.ok(keys.has(`operation ${op.name}`), `${op.name} has no passage`);
    for (const code of Object.keys(ERRORS)) assert.ok(keys.has(`refusals: \`${code}\``), `${code} has no row`);
  });

  test("12: the three starts and every sentence a section of the reference took on are there, line by line", () => {
    // Both reach a reader only through the reference, so section 12 is where they are read.
    const section = sectionText(reviewText(), 12);
    for (const line of read("content/starts.md").split("\n")) {
      if (line.trim() !== "" && !line.startsWith("#")) assert.ok(section.includes(line), `the start's line is not in section 12: ${line}`);
    }
    for (const said of Object.values(SECTION_ADDITIONS)) {
      for (const passage of typeof said === "string" ? [said] : Array.isArray(said) ? said : Object.values(said)) {
        for (const line of passage.split("\n")) if (line.trim() !== "") assert.ok(section.includes(line), `the reference's added sentence is not in section 12: ${line}`);
      }
    }
  });

  test("13: every block of llms.txt has a passage", async () => {
    const keys = new Set(passagesOf(reviewText(), 13).map((p) => p.key));
    const llms = await (await createApp(EXAMPLE_CONFIG, STUB_DB).request("/llms.txt")).text();
    for (const m of llms.matchAll(/^## (.*)$/gm)) assert.ok(keys.has(`llms.txt: ${m[1]!.trim()}`), `llms.txt's ${m[1]} has no passage`);
  });

  test("14: each distinct OpenAPI prose string is one passage, and its places add up", async () => {
    const doc = JSON.parse(await (await createApp(EXAMPLE_CONFIG, STUB_DB).request("/openapi.json")).text());
    const all: string[] = [];
    const walk = (v: unknown, at: string[]): void => {
      if (typeof v === "string") {
        if (v.includes(" ") && openApiProse(at)) all.push(v);
      } else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...at, k]);
    };
    walk(doc, []);
    const passages = passagesOf(reviewText(), 14);
    const said = passages.map((p) => p.said);
    assert.equal(new Set(said).size, said.length, "one OpenAPI string has two passages");
    assert.equal(passages.length, new Set(all).size, "the OpenAPI strings and the passages differ in number");
    const places = passages.reduce((sum, p) => sum + Number(/^used in (\d+) place/.exec(p.kind)?.[1] ?? 0), 0);
    assert.equal(places, all.length, "the places the passages name do not add up to the strings in the document");
  });

  test("15: every note in the capabilities has a passage, a server's with no website and no operator address too", async () => {
    const keys = new Set(passagesOf(reviewText(), 15).map((p) => p.key));
    for (const config of [EXAMPLE_CONFIG, BARE_CONFIG]) {
      const caps = JSON.parse(await (await createApp(config, STUB_DB).request("/v1/capabilities")).text());
      const walk = (v: unknown, at: string[]): void => {
        if (v === null || typeof v !== "object") return;
        for (const [k, x] of Object.entries(v)) {
          const key = `capabilities ${[...at, k].join(".")}`;
          if (k === "note" && typeof x === "string") assert.ok(keys.has(key) || keys.has(key + BARE), `${[...at, k].join(".")} has no passage`);
          walk(x, [...at, k]);
        }
      };
      walk(caps, []);
    }
  });

  test("16: every category in the register has a passage", () => {
    const register = JSON.parse(read("src/surface/categories.json")) as { categories: { id: string }[] };
    const keys = passagesOf(reviewText(), 16).map((p) => p.key).filter((k) => k.startsWith("category "));
    assert.equal(keys.length, register.categories.length, "the categories and their passages differ in number");
    const keyed = new Set(keys);
    for (const c of register.categories) assert.ok(keyed.has(`category ${c.id}`), `${c.id} has no passage`);
  });

  test("17: every path the review reads answers as it should", async () => {
    const app = createApp(EXAMPLE_CONFIG, STUB_DB);
    for (const asked of REQUESTED) {
      const answer = await app.request(asked.path, asked.accept ? { headers: { Accept: asked.accept } } : undefined);
      assert.equal(answer.status, asked.status, `GET ${asked.path}`);
    }
  });

  test("18: every file of the plugin is shown here or filed", () => {
    const keys = passagesOf(reviewText(), 18).map((p) => p.key);
    for (const { name } of pluginFiles()) {
      assert.ok(keys.some((k) => k.startsWith(`plugin ${name} `)) || `plugin/${name}` in PLACES.files, `plugin/${name} is neither shown nor filed`);
    }
  });

  test("19: every refusal detail is collected", () => {
    assert.deepEqual(unswept(reviewText(), 19), []);
  });

  test("20: every notice and note in an answer is collected", () => {
    const text = reviewText();
    assert.ok(passagesOf(text, 20).length >= 14, "the notices in answers are not being collected");
    assert.deepEqual(unswept(text, 20), []);
  });

  test("21: every refusal at the door is collected", () => {
    assert.deepEqual(unswept(reviewText(), 21), []);
  });

  test("22: every word the connector says is collected, each argument description too", () => {
    const text = reviewText();
    assert.deepEqual(unswept(text, 22), []);
    const shown = faceText(text) + sectionText(text, 22);
    for (const file of SWEPT[22]!) {
      for (const m of read(file).matchAll(/\.describe\(\s*(?:"((?:[^"\\]|\\.)*)"|`([^`$]*))/g)) {
        const said = (m[1] ?? m[2]!).replace(/\\(["'`])/g, "$1");
        assert.ok(inReview(shown, said), `${file}: an argument description is not in the review: ${said}`);
      }
    }
  });

  test("23: every text rendering is collected", () => {
    assert.deepEqual(unswept(reviewText(), 23), []);
  });

  test("24: every WORDS line is tried with each mix of a zero and a value", () => {
    const tried = new Map<string, number>();
    for (const { name } of wordsBranches()) tried.set(name, (tried.get(name) ?? 0) + 1);
    for (const [name, words] of Object.entries(WORDS as Record<string, unknown>)) {
      assert.equal(tried.get(name), typeof words === "function" ? 2 ** (words as () => string).length : 1, `WORDS.${name}`);
    }
    assert.deepEqual(unswept(reviewText(), 24), []);
  });

  test("25: the bridge the plugin carries is the one served, and the sealing module's reasons are collected", () => {
    assert.deepEqual(unswept(reviewText(), 25), []);
    assert.equal(read("plugin/bridge/schellingaf.mjs"), bridgeScript());
  });

  test("26: the reviewer's material and decision are collected", () => {
    const text = reviewText();
    const section = passagesOf(text, 26).map((p) => p.said).join("\n");
    const shown = material({ title: "T", description: "D", summary: "S", first: true, change: "C" });
    for (const line of shown.split("\n")) {
      // Each line with the example value taken off: its label, or the whole fixed line.
      const fixed = line.replace(/: (?:[TDS]|yes)$/, ": ").replace(/^C$/, "");
      if (fixed !== "") assert.ok(section.includes(fixed), `the reviewer's material line is not collected: ${line}`);
    }
    assert.ok(section.includes("first version: [yes / no]"), "the reviewer's first-version line is not collected");
    assert.ok(section.includes("Rule <rule>. <reason>"), "the decision's body is not collected");
    assert.deepEqual(unswept(text, 26), []);
  });
});

/** Tracked files under these paths. */
function tracked(...paths: string[]): string[] {
  return execFileSync("git", ["ls-files", ...paths], { cwd: new URL(".", ROOT), encoding: "utf8" }).split("\n").filter(Boolean);
}

/** A route as Hono and OPERATIONS both name it, `{x}` read as `:x`. */
const routeOf = (method: string, p: string) => `${method} ${p.replace(/\{(\w+)\}/g, ":$1")}`;

describe("every place a reader meets words is filed", () => {
  test("every route is an operation's, requested by the review, or filed", () => {
    const operations = new Set(OPERATIONS.map((o) => routeOf(o.method, o.path)));
    const requested = new Set(REQUESTED.map((r) => r.path.split("?")[0]!));
    for (const r of createApp(EXAMPLE_CONFIG, STUB_DB).routes) {
      if (!["GET", "ALL", "OPTIONS"].includes(r.method)) continue;
      const route = `${r.method} ${r.path}`;
      assert.ok(operations.has(route) || route in PLACES.routes, `${route} is neither an operation's nor filed in PLACES.routes`);
    }
    for (const op of OPERATIONS) {
      if (op.method !== "GET" || op.path.startsWith("/v1/") || op.path.startsWith("/oauth/")) continue;
      assert.ok(requested.has(op.path) || `GET ${op.path}` in PLACES.routes, `GET ${op.path} is neither requested by the review nor filed in PLACES.routes`);
    }
  });

  test("every served or packed file is filed or excluded", () => {
    for (const file of tracked("content", "plugin", ".claude-plugin", "bridge", "server.json", "Caddyfile")) {
      assert.ok(file in PLACES.files || excluded(file), `${file} is neither filed in PLACES.files nor excluded`);
    }
  });

  test("every source file that builds sentences is filed or excluded", () => {
    for (const file of tracked("src", "reviewer", "migrations")) {
      if (!/\.(ts|mjs|sql)$/.test(file) || quotedRuns(file, 3).length === 0) continue;
      assert.ok(file in PLACES.sources || excluded(file), `${file} builds sentences and is neither filed in PLACES.sources nor excluded`);
    }
  });

  test("no entry in the lists matches nothing", () => {
    const routes = new Set(createApp(EXAMPLE_CONFIG, STUB_DB).routes.map((r) => `${r.method} ${r.path}`));
    for (const route of Object.keys(PLACES.routes)) assert.ok(routes.has(route), `PLACES.routes files ${route}, which is no route`);
    const files = new Set(tracked("content", "plugin", ".claude-plugin", "bridge", "server.json", "Caddyfile"));
    for (const file of Object.keys(PLACES.files)) assert.ok(files.has(file), `PLACES.files files ${file}, which is no such file`);
    for (const file of Object.keys(PLACES.sources)) {
      assert.ok(existsSync(new URL(file, ROOT)) && quotedRuns(file, 3).length > 0, `PLACES.sources files ${file}, which builds no sentence`);
      assert.ok(!excluded(file), `${file} is both filed and excluded`);
    }
    const all = tracked(".");
    for (const e of EXCLUDED) {
      for (const p of e.paths) assert.ok(all.some((f) => (p.endsWith("/") ? f.startsWith(p) : f === p)), `EXCLUDED row ${e.row} names ${p}, which matches no file`);
    }
    for (const [file, groups] of Object.entries(NOT_SAID)) {
      const runs = new Set(quotedRuns(file, 4).map((r) => r.text.trim()));
      for (const run of groups.flatMap((g) => g.runs)) assert.ok(runs.has(run), `NOT_SAID[${file}] lists "${run}", which is no run`);
    }
    for (const [file, groups] of Object.entries(NOISE)) {
      const literals = new Set(literalTexts(file).map((t) => t.trim()));
      for (const text of groups.flatMap((g) => g.texts)) assert.ok(literals.has(text), `NOISE[${file}] lists "${text}", which is no literal`);
    }
  });
});

describe("the approval", () => {
  test("the service says exactly the words recorded as approved", () => {
    assert.ok(existsSync(APPROVED), "reference/approved-copy.md is missing: the approved words are gone");
    const approved = readFileSync(APPROVED, "utf8");
    const text = reviewText();
    if (approved.endsWith(text)) return;
    // Which sections moved, so a drift in the face is told apart from new passages after it.
    const changed = changedPassages(approved, text);
    const bySection = new Map<string, number>();
    for (const p of changed) bySection.set(p.section, (bySection.get(p.section) ?? 0) + 1);
    const recorded = approved.slice(approved.indexOf("# The words agents read"));
    assert.fail(
      "the words the service says have drifted from the words recorded as approved.\n" +
        (faceText(recorded) === faceText(text) ? "Sections 1 to 11 are as recorded.\n" : "Sections 1 to 11 differ from the record.\n") +
        [...bySection].map(([section, n]) => `  ${section}: ${n} passage(s)\n`).join("") +
        "Run `npm run copy -- --diff` to see them. If the new wording is right, it needs\n" +
        "approving: that is a deliberate commit, not a regenerated file.",
    );
  });

  test("npm run copy -- --diff finds nothing changed in the words against themselves", () => {
    // It pairs passages by their bold key, so a key said twice in one section would
    // compare the others with one of them and report differences that are not there.
    const text = reviewText();
    assert.deepEqual(changedPassages(text, text), []);
  });
});

describe("the production gate", () => {
  // Enforced at startup rather than in a deployment checklist, because a check that
  // lives only in a checklist is the one that gets skipped.
  const ENV = {
    API_HOST: "gate.invalid",
    PUBLIC_ORIGIN: "https://gate.invalid",
    // Long enough to clear the minimum-length check in config.ts: an empty or
    // near-empty CHALLENGE_KEY is a forgeable challenge, so it refuses to start.
    CHALLENGE_KEY: "not-a-secret-and-long-enough",
    DB_PASSWORD: "not-a-secret-and-long-enough",
  };

  function loadWith(extra: Record<string, string>): Error | null {
    const saved = { ...process.env };
    Object.assign(process.env, ENV, extra);
    try {
      // The check runs inside loadConfig rather than at module load, precisely
      // so it can be exercised here rather than only in production.
      loadConfig();
      return null;
    } catch (error) {
      return error as Error;
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  test("without the flag the service starts, so development is untouched", () => {
    assert.equal(loadWith({}), null);
  });

  test("with the flag and no approval, it refuses and says how to fix it", () => {
    // With an operator address set, so this sees the copy gate on its own. The
    // deployed configuration also refuses to start without that address, and
    // that refusal is checked first; test/public.test.ts holds it.
    const error = loadWith({ REQUIRE_APPROVED_COPY: "1", OPERATOR_CONTACT: "abuse@example.test" });
    if (existsSync(APPROVED)) {
      // The record is present, so this gate must let it past. A later gate may still
      // refuse, such as the service's signing key, which is not made on a
      // development machine.
      assert.doesNotMatch(error?.message ?? "", /is missing/, "the gate refused a frozen copy");
      return;
    }
    assert.ok(error, "the production gate started a service whose copy is not frozen");
    assert.match(error.message, /is missing/);
    assert.match(error.message, /npm run copy/);
  });
});
