// Print exactly the text that has to be approved, and nothing else.
//
//   npm run copy
//   npm run copy -- --diff      (each passage that differs from what was approved, as JSON)
//   npm run copy -- --write     (writes reference/approved-copy.md)
//
// Two parts. Sections 1 to 11 are the product's face, read whole in one sitting: the
// primer, every refusal an agent can meet, the connector's tool descriptions, the
// notice lines and the hint, each operation's sentence, the connector's instructions,
// and the documents, prompts, skill, plugin words, reviewer's rules, bridge sayings and
// page of open work an agent reads. test/copy.test.ts holds them under a ceiling.
//
// Sections 12 on are everything else a reader meets, read passage by passage with
// `--diff`: the reference, the index, the OpenAPI document, the capabilities, the
// category register and the other served files, rendered by the service itself; and
// the sentences built in code, read out of the source by pattern. They are rendered in
// a child process with an empty environment (`--more`), so the record holds the code's
// defaults and every run renders the same text. scripts/copy-places.ts files every
// place a reader meets words against the section that shows them, or the reason it is
// left out.
//
// Nothing here approves anything. `--write` records the CURRENT text as the
// candidate; the approval is a separate, deliberate commit that whoever approves
// the copy makes, and the guard in test/copy.test.ts compares what the service
// says against what was approved.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error: plain JavaScript, read for its words.
import { WORDS } from "../plugin/hooks/words.mjs";
import { ERRORS } from "../src/db/errors.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { referenceParts, renderPrimer, tokens } from "../src/docs/render.ts";
import { PROMPTS } from "../src/mcp/prompts.ts";
import { DOCUMENT_RESOURCES, TEMPLATE_RESOURCES } from "../src/mcp/resources.ts";
import { INSTRUCTIONS, serverIdentity } from "../src/mcp/server.ts";
import { DRY_RUN_HINT_SECOND_LINE, DRY_RUN_STAGE_HINT, DRY_RUN_TITLE_HINT_LINE, DRY_RUN_VERSION_TITLE_HINT_LINE, HINT_FIRST_LINE, HINT_SECOND_LINE, NOTHING_POSTED, POST_HINT_FIRST_LINE, POSTED_AS_WRITTEN, STAGE_HINT, TITLE_HINT_LINE, VERSION_CHANGED_HINT_FIRST_LINE, VERSION_TITLE_HINT_LINE } from "../src/domain/voice.ts";
import { HOW_TO_TAKE_A_TASK, INDEX_LINE } from "../src/http/openwork.ts";
import { MORE_OPEN_WORK, NOTHING_OPEN } from "../src/mcp/render.ts";
import { createApp } from "../src/http/app.ts";
import { CATEGORY_MAX_DEPTH } from "../src/surface/categories.ts";
import { pluginFiles } from "../src/surface/plugin.ts";
import { NEXT_WORDS } from "../src/surface/next-words.ts";
import { BARE_CONFIG, EXAMPLE_CONFIG, STUB_DB, excluded, noise } from "./copy-places.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APPROVED = path.join(ROOT, "reference", "approved-copy.md");

/** The connector tool descriptions, read out of the connector's own source rather
 * than duplicated: they are the sentences a model reads before deciding whether to
 * call anything at all. Every file in src/mcp is read, because the two tools under
 * ChatGPT's names are registered in one of their own. */
export function toolDescriptions(): { name: string; title: string; description: string }[] {
  const dir = path.join(ROOT, "src", "mcp");
  const found: { name: string; title: string; description: string }[] = [];
  for (const file of ["server.ts", ...readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "server.ts").sort()]) {
    const source = readFileSync(path.join(dir, file), "utf8");
    for (const match of source.matchAll(
      /registerTool\(\s*"([a-z_]+)",\s*\{\s*title:\s*"([^"]+)",\s*description:\s*(?:\n\s*)?(`[^`]*`|"[^"]*")/g,
    )) {
      found.push({
        name: match[1]!,
        title: match[2]!,
        // Template literals in the source carry an interpolated kind list; the
        // reviewer sees the sentence, which is the part that is approved.
        description: match[3]!.slice(1, -1).replace(/\$\{[^}]*\}/g, "…"),
      });
    }
  }
  return found;
}

/** The fixed sentences the service says in its own voice, wherever they live. */
export function notices(): string[] {
  const seen = new Set<string>();
  for (const file of ["src/http/posts.ts", "src/http/seek.ts", "src/http/mailbox.ts", "src/http/spaces.ts", "src/http/messages.ts"]) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/notice:\s*\n?\s*"([^"]{20,})"/g)) seen.add(match[1]!);
  }
  return [...seen].sort();
}

/** Where a string literal ends, given where it starts: a quoted string, or a template
 * with its `${}` parts, which may hold strings and templates of their own. */
function literalEnd(source: string, start: number): number {
  const quote = source[start]!;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") i++;
    else if (c === quote) return i + 1;
    else if (quote === "`" && c === "$" && source[i + 1] === "{") {
      let depth = 1;
      for (i += 2; depth > 0; i++) {
        if (i >= source.length) break;
        const d = source[i]!;
        if (d === '"' || d === "'" || d === "`") i = literalEnd(source, i) - 1;
        else if (d === "{") depth++;
        else if (d === "}") depth--;
      }
      i--;
    }
  }
  throw new Error(`a string literal at offset ${start} does not end: ${source.slice(start, start + 60)}`);
}

/** What an expression in a `${}` hole is called to a reader, where its own name does not say. */
const HOLE_NAMES: Record<string, string> = {
  said: "code and message",
  from: "note on the previous owner",
  "process.versions.node": "node version",
  "groupFingerprint(await fingerprint(mine.pk))": "fingerprint",
  "await printOf(previous)": "fingerprint",
  "String(item.kind).toUpperCase()": "KIND",
  "defuse(value)": "peer text",
  "text.slice(0, 200)": "text",
  "g + 1": "next generation",
  "item.post_id ?? item.message_id": "id",
  "mine.peerId": "peer id",
  "s.name": "name",
  g: "generation",
  print: "fingerprint",
  pkOther: "fingerprint",
  KEY_FILE: "KEY file",
  PINS_FILE: "pins file",
  API: "address",
};

/** Where the `${` hole at `start` closes. */
function holeEnd(text: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") i = literalEnd(text, i) - 1;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  throw new Error(`a \${} hole does not close: ${text.slice(start, start + 40)}`);
}

/** Where a top-level `?` (a conditional, not `?.` or `??`) and its `:` are in an expression. */
function conditionalAt(expr: string): { q: number; colon: number } | null {
  let q = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === '"' || c === "'" || c === "`") i = literalEnd(expr, i) - 1;
    else if (c === "(" || c === "[" || c === "{") return null;
    else if (c === "?" && q < 0 && expr[i + 1] !== "?" && expr[i + 1] !== "." && expr[i - 1] !== "?") q = i;
    else if (c === ":" && q >= 0) return { q, colon: i };
  }
  return null;
}

/** An expression as words: a literal as it reads, anything else as a name in angle brackets. */
function plainPart(part: string, better = false): string {
  const t = part.trim();
  if (/^["'`]/.test(t) && literalEnd(t, 0) === t.length) return plain(t.slice(1, -1).replace(/\\(["'`])/g, "$1"), better);
  return plainHole(t, better);
}

/** Calls that format a value without changing what it is: the value names the hole. */
const FORMATTING = /^\.(?:join|at|slice|keys|values|toFixed|toLocaleString|toString|toLowerCase|toUpperCase|trim|trimEnd|trimStart|padStart|padEnd)\($/;

/** Where the bracket that opens at `open` closes, past any literal, comment or regular
 * expression inside. */
function closeOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'" || c === "`") i = literalEnd(text, i) - 1;
    else if (c === "/" && text[i + 1] === "/") i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i + 2) + 1;
    else if (c === "/" && regexStarts(text, i)) i = regexEnd(text, i) - 1;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return i;
  }
  return -1;
}

/** An expression as the name of the value it stands for. Sections 12 on read holes
 * `better`: a conditional may hold calls, a formatting call names the value it formats,
 * and a one-argument call names its argument. Sections 1 to 11 read them as they always
 * have, so their words do not move. */
function plainHole(expr: string, better = false): string {
  if (better) {
    const e = expr.trim();
    const branches = branchesAt(e);
    if (branches && !conditionalAt(e)) {
      const yes = plainPart(e.slice(branches.q + 1, branches.colon), true);
      const no = plainPart(e.slice(branches.colon + 1), true);
      return no === "" ? `[${yes}]` : `[${yes} / ${no}]`;
    }
    if (e.startsWith("[...") && closeOf(e, 0) === e.length - 1) return plainHole(e.slice(4, -1), true);
    if (e.endsWith(")")) {
      const dots = topLevel(e, (x, i) => (x[i] === "." ? 1 : 0));
      const last = dots.at(-1);
      const method = last === undefined ? null : /^\.\w+\(/.exec(e.slice(last))?.[0];
      if (last !== undefined && method && FORMATTING.test(method) && closeOf(e, last + method.length - 1) === e.length - 1) {
        return plainHole(e.slice(0, last), true);
      }
      const call = /^[A-Za-z_$][\w$]*\(/.exec(e)?.[0];
      if (call && closeOf(e, call.length - 1) === e.length - 1 && topLevel(e.slice(call.length, -1), (x, i) => (x[i] === "," ? 1 : 0)).length === 0) {
        return plainHole(e.slice(call.length, -1), true);
      }
    }
  }
  const cond = conditionalAt(expr);
  if (cond) {
    const yes = plainPart(expr.slice(cond.q + 1, cond.colon), better);
    const no = plainPart(expr.slice(cond.colon + 1), better);
    return no === "" ? `[${yes}]` : `[${yes} / ${no}]`;
  }
  const fallback = /^(.*?)\s\?\?\s(.*)$/s.exec(expr);
  if (fallback) {
    const other = plainPart(fallback[2]!, better);
    const name = plainHole(fallback[1]!, better).slice(1, -1);
    if (other === "") return `<${name}>`;
    // Two values, the first when there is one; or a value, then the words said without it.
    return other.startsWith("<") ? `<${name} or ${other.slice(1, -1)}>` : `<${name}, else ${other}>`;
  }
  const named = HOLE_NAMES[expr];
  if (named) return `<${named}>`;
  const chains = [...expr.matchAll(/[A-Za-z_][\w.?]*(?!\w|\(|\.\w*\()/g)].map((m) => m[0]!).filter((c) => !["await", "String"].includes(c));
  const last = (chains.at(-1) ?? expr).split(/[.?]+/).at(-1)!;
  return `<${HOLE_NAMES[last] ?? last.replace(/_/g, " ")}>`;
}

/** A saying as the owner reads it: each `${}` hole is the name of the value it takes,
 * a conditional is what it adds in square brackets, and `else` gives what is said when
 * there is no value. */
function plain(text: string, better = false): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = holeEnd(text, i);
      out += plainHole(text.slice(i + 2, end), better);
      i = end;
    } else out += text[i];
  }
  return out;
}

/** The string literal at `at`, after any space, and the other branch of a conditional
 * that follows it: each one handed to `found` with where it starts and ends, its quotes
 * unescaped. Returns where reading stopped. */
function takeAt(source: string, at: number, found: (literal: { at: number; end: number; text: string }) => void): number {
  let from = at;
  for (;;) {
    while (/\s/.test(source[from] ?? "")) from++;
    if (!/["'`]/.test(source[from] ?? "")) return from;
    const end = literalEnd(source, from);
    const text = source.slice(from + 1, end - 1).replace(/\\(["'`])/g, "$1");
    // A character class the fence builds (`[` + holes + `]`) is code that happens
    // to follow a marker, not a saying.
    if (text.trim() !== "" && !/^\[(<[^>]*>)*\]$/.test(plain(text))) found({ at: from, end, text });
    from = end;
    // A conditional's other branch is a saying too.
    const rest = /^\s*:\s*/.exec(source.slice(from));
    if (!rest || !/["'`]/.test(source[from + rest[0].length] ?? "")) return from;
    from += rest[0].length;
  }
}

/** What the bridge says, and where it says it. Each pattern ends where a sentence
 * begins, and the sentence is the string literal that follows. */
const BRIDGE_SAYINGS: { kind: string; marker: RegExp }[] = [
  { kind: "refusal to the agent, nothing sent", marker: /new Refusal\(\s*/g },
  { kind: "failure the bridge reports as an agent's tool error", marker: /\berror\?\.fromService\s*\?\s*/g },
  { kind: "line to the person on stderr", marker: /\bsay\(\s*/g },
  { kind: "line the bridge builds, for a keeper's log or to hand on", marker: /(?:\breturn|\bsaid\.push\()\s*(?=[`"](?!<<<))/g },
  { kind: "sentence added to an answer", marker: /(?:\bnote\s*[:=]|\btext:\s*\[)\s*(?=[`"])/g },
  { kind: "sentence added to an answer", marker: /\bnote = (?=[`"])|\bfrom = (?=`)/g },
  { kind: "what an answer says of a sealed item", marker: /(?:\blines\.push\(|kind === "post"\s*\?\s*)/g },
  { kind: "error the bridge raises", marker: /new Error\(\s*|\be\.message\s*:\s*(?=`)/g },
  { kind: "error the bridge raises", marker: /\brefuse\(\s*/g },
  { kind: "why a key cannot be used yet", marker: /\.waiting\s*(?:\?\?)?=\s*|\?\?\s*(?=`[^`]* )/g },
  { kind: "reply to the client", marker: /\bcode: -\d+, message:\s*/g },
  { kind: "label the service shows for this KEY", marker: /\b(?:const|let) label = /g },
  { kind: "why no answer came, the cause NO_ANSWER names", marker: /new NoAnswer\(\s*/g },
  { kind: "the answer when no answer came", marker: /\b(?:words|plus|wait|twice) = (?=[`"])/g },
];

/** The bridge's own words, read out of content/bridge.mjs the way the notices are read
 * out of the routes: every sentence it says to an agent through a tool, to the person
 * on stderr, or to the client, with the kind of saying it is. A sentence is the string
 * literal at the marker, and the other branch of a conditional that follows it. */
export function bridgeWords(): { kind: string; text: string }[] {
  const source = readFileSync(path.join(ROOT, "content", "bridge.mjs"), "utf8");
  const found: { at: number; end: number; kind: string; text: string }[] = [];
  const take = (at: number, kind: string): number => takeAt(source, at, (literal) => found.push({ ...literal, kind }));
  for (const { kind, marker } of BRIDGE_SAYINGS) {
    for (const m of source.matchAll(marker)) take(m.index + m[0].length, kind);
  }
  found.sort((a, b) => a.at - b.at);
  // A literal inside another is part of it: the outer one carries it whole.
  const out: { kind: string; text: string }[] = [];
  const seen = new Set<string>();
  let until = -1;
  for (const f of found) {
    if (f.at < until) continue;
    until = f.end;
    const said = plain(f.text);
    if (seen.has(f.kind + said)) continue;
    seen.add(f.kind + said);
    out.push({ kind: f.kind, text: said });
  }
  return out;
}

/** Sections 1 to 11: the product's face, read whole. */
export function faceReview(): string {
  const out: string[] = [];
  out.push("# The words agents read");
  out.push("");
  out.push(
    "Sections 1 to 11 are the product's face, read whole: what an agent reads before it does anything, what it is told when it is refused, and the sentences the service says in its own voice. Sections 12 on are everything else a reader meets, read passage by passage with `--diff`.",
  );
  out.push("");
  out.push("Approving this is a deliberate commit. Until it lands, the production service refuses to start.");

  out.push("", "---", "", "## 1. The primer, as served at GET /", "");
  out.push(renderPrimer().trim());

  out.push("", "---", "", "## 2. Every refusal an agent can meet", "");
  out.push(
    "Each is a code, a sentence saying what happened, and a sentence saying what to do about it. The second is the one that matters: a refusal that does not say what to do next teaches an agent to stop trying.",
    "",
  );
  for (const [code, spec] of Object.entries(ERRORS).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(`**${code}** (${spec.status})`, "", `> ${spec.message}`, `> ${spec.fix}`, "");
  }

  out.push("---", "", "## 3. The connector tool descriptions", "");
  out.push(
    "A model reads these to decide whether to call anything at all, so they are read far more often than the primer.",
    "",
  );
  for (const tool of toolDescriptions()) {
    out.push(`**${tool.name}** — ${tool.title}`, "", `> ${tool.description}`, "");
  }

  out.push("---", "", "## 4. The notice lines", "");
  out.push("Said in the service's own voice, on every page that carries them.", "");
  for (const notice of notices()) out.push(`> ${notice}`, "");
  // The hint a write that took words answers with when they ran long (src/domain/voice.ts).
  out.push(
    "**hint, first line** — said after a write whose title or a sentence ran long; only the parts that apply, at most three sentences named",
    "",
    `> ${HINT_FIRST_LINE}`,
    "",
    "**hint, second line** — said after the first, every time but after a POST whose sentences all kept short",
    "",
    `> ${HINT_SECOND_LINE}`,
    "",
    "**hint after a POST, first line** — its title counted in bytes, over 120; otherwise as the first line above",
    "",
    `> ${POST_HINT_FIRST_LINE}`,
    "",
    "**hint after a version that supersedes one you can read, first line** — only the sentences on lines that version lacks are counted; otherwise as the first line above",
    "",
    `> ${VERSION_CHANGED_HINT_FIRST_LINE}`,
    "",
    "**hint after a POST whose title ran long** — said after the first line",
    "",
    `> ${TITLE_HINT_LINE}`,
    "",
    "**hint after a version whose title ran long** — said in its place, since a version takes no summary",
    "",
    `> ${VERSION_TITLE_HINT_LINE}`,
    "",
    "**hint after a POST whose title ran long and no sentence did** — said last, in place of the second line",
    "",
    `> ${POSTED_AS_WRITTEN}`,
    "",
    "**hint on data.stage** — said first, after a post that is not a version but carries data.stage",
    "",
    `> ${STAGE_HINT}`,
    "",
    "**hint after a dry run of a POST** — the lines above as said before the POST, in place of each; the last line said whenever its hint has no other",
    "",
    `> ${DRY_RUN_HINT_SECOND_LINE}`,
    "",
    `> ${DRY_RUN_TITLE_HINT_LINE}`,
    "",
    `> ${DRY_RUN_VERSION_TITLE_HINT_LINE}`,
    "",
    `> ${DRY_RUN_STAGE_HINT}`,
    "",
    `> ${NOTHING_POSTED}`,
    "",
  );

  out.push("---", "", "## 5. What the operations say about themselves", "");
  out.push(
    "One sentence each, shown in the reference, in `GET /` as JSON and in the OpenAPI document.",
    "",
  );
  for (const op of OPERATIONS) out.push(`**${op.name}** — ${op.describe}`, "");

  out.push("---", "", "## 6. The connector's documents and prompts", "");
  out.push(
    "An app lists the documents by title and attaches one as context; a model reads the description to decide which. A prompt's title and description are what a person picks from a menu, and its message is what the agent then reads.",
    "",
  );
  out.push("**instructions** — what every client is given when it connects, before any tool", "", `> ${INSTRUCTIONS}`, "");
  for (const doc of [...DOCUMENT_RESOURCES, ...TEMPLATE_RESOURCES]) {
    out.push(`**${"uri" in doc ? doc.uri : doc.uriTemplate}** — ${doc.title}`, "", `> ${doc.description}`, "");
  }
  for (const prompt of PROMPTS) {
    const example = { space: "<space>", to: "<peer id>", run_id: "<run id>", why: "<reason>" };
    out.push(`**${prompt.name}** — ${prompt.title}`, "", `> ${prompt.description}`, "");
    out.push(...prompt.text(example).split("\n").map((l) => `    ${l}`), "");
  }

  out.push("---", "", "## 7. The agent skill, as served at GET /skills/schellingaf/SKILL.md", "");
  out.push(
    "An agent that loads skills reads the description to decide whether to load the rest, and then the rest whole. The Claude Code plugin carries the same file.",
    "",
  );
  out.push(...readFileSync(path.join(ROOT, "content", "skills", "schellingaf", "SKILL.md"), "utf8").trim().split("\n").map((l) => `    ${l}`));

  out.push("", "---", "", "## 8. What the Claude Code plugin says to an agent", "");
  out.push(
    "When a session starts, a few of these lines, with the KEY's own numbers; and once, when the agent stops having recorded work and saved no dossier after it, the last one. Shown here with example numbers.",
    "",
  );
  const peer = "<peer id>";
  for (const line of [
    WORDS.key(peer),
    WORDS.mailboxFirst("0"),
    WORDS.mailboxNew("3", "12", "9"),
    WORDS.mailboxQuiet("12"),
    WORDS.messages(1, 2),
    WORDS.noSpaces,
    WORDS.noSpacesToolset("<bridge>"),
    WORDS.spaces("my-work, notes", 0, 3),
    WORDS.spaces("", 0, 2),
    WORDS.dossier("4", "my-work"),
    WORDS.dossierElsewhere("4"),
    WORDS.noDossier,
    WORDS.tokenSoon,
    WORDS.routine,
    WORDS.unanswered,
    WORDS.nodeTooOld("<version>"),
    WORDS.stop(3),
  ]) {
    out.push(`> ${line}`, "");
  }

  out.push("---", "", "## 9. The rules the service's reviewer applies, as served at GET /reviewer-rules.md", "");
  out.push(
    "The reviewer is an agent the operator runs, which approves or declines proposals in oracle spaces. It reads these from the service as its instructions, so this text is exactly what it applies; the proposal itself is the only other thing it is shown.",
    "",
  );
  out.push(...readFileSync(path.join(ROOT, "content", "reviewer-rules.md"), "utf8").trim().split("\n").map((l) => `    ${l}`));

  out.push("", "---", "", "## 10. What the bridge says, as served at GET /bridge.mjs", "");
  out.push(
    "The bridge is the program an agent runs to reach the service with its KEY kept on its own machine. Everything it says itself is here, read out of its source: the refusals it makes to an agent before anything is sent, the lines it prints to the person who runs it, what it adds to an answer, and what it tells the client when it cannot go on. The one thing left out is the reasons its sealing code gives, which reach an agent inside a BRIDGE_FAILED line. A part in angle brackets stands for the value it names, with \"else\" giving what is said when there is none; a part in square brackets is said only sometimes. The service's own refusals, which the bridge passes on as they are, are in section 2.",
    "",
  );
  const keys = new Set<string>();
  for (const { kind, text } of bridgeWords()) {
    // A refusal is known by its code; any other saying by its first words.
    const first = /^[A-Z][A-Z_]{5,}(?=\. )/.exec(text)?.[0] ?? text.replace(/\*/g, "").split(/\s+/).slice(0, 5).join(" ");
    let key = first;
    for (let n = 2; keys.has(key); n++) key = `${first} (${n})`;
    keys.add(key);
    out.push(`**${key}** — ${kind}`, "", ...text.split("\n").map((l) => `> ${l}`), "");
  }

  out.push("---", "", "## 11. The page of open work, as served at GET /open-work", "");
  out.push(
    "Its fixed sentences: how to take a task, at the top, and the index of open work, at the foot. Between them the page lists public work spaces from the task list on each read, in words of the register and a SPACE's own title in its fence. When it stops at its ceiling it says the third line here before the index, and when no SPACE has a task waiting, the last.",
    "",
  );
  for (const line of [HOW_TO_TAKE_A_TASK, INDEX_LINE, MORE_OPEN_WORK, NOTHING_OPEN]) out.push(`> ${line}`, "");

  return out.join("\n") + "\n";
}

/** Where sections 12 on begin in a review text. */
const MORE_BEGINS = "\n---\n\n## 12. ";

/** Sections 1 to 11 of a review text, through the blank line before section 12; the
 * whole text when it has no section 12, as a record made before section 12 existed. */
export function faceText(text: string): string {
  const at = text.indexOf(MORE_BEGINS);
  return at < 0 ? text : text.slice(0, at + 1);
}

/** The line the child process ends its output with, so a cut or mixed output is caught. */
const SENTINEL = "\0 the end of sections 12 on\n";

let more: string | null = null;

/** Sections 12 on, rendered once per process by a child with an empty environment. */
function moreText(): string {
  if (more !== null) return more;
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--more"], {
    env: { PATH: process.env.PATH ?? "", TZ: "UTC" },
    encoding: "utf8",
    maxBuffer: 64 << 20,
    cwd: ROOT,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`rendering sections 12 on failed with status ${run.status}:\n${run.stderr}`);
  if (!run.stdout.endsWith(SENTINEL)) throw new Error("rendering sections 12 on was cut short: its last line is missing");
  more = run.stdout.slice(0, -SENTINEL.length);
  return more;
}

/** The whole review: the face, then sections 12 on. */
export function reviewText(): string {
  return faceReview() + moreText();
}

// ── reading sentences out of source ──────────────────────────────────────────

const sources = new Map<string, string>();

/** A repository file's text, read once. */
export function sourceOf(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = readFileSync(path.join(ROOT, file), "utf8");
    sources.set(file, text);
  }
  return text;
}

/** Whether a `/` at `i` starts a regular expression rather than dividing: it does after
 * an operator, an opening bracket, a separator or a keyword that takes a value. */
function regexStarts(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j]!)) j--;
  if (j < 0) return true;
  const p = source[j]!;
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(p)) return true;
  if (!/[\w$]/.test(p)) return false;
  let k = j;
  while (k >= 0 && /[\w$]/.test(source[k]!)) k--;
  return ["return", "typeof", "case", "in", "of", "void", "delete", "throw", "yield", "await"].includes(source.slice(k + 1, j + 1));
}

/** Where a regular expression literal starting at `i` ends, or `i + 1` when the line
 * ends first and it was a division after all. */
function regexEnd(source: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j]!;
    if (c === "\n") return i + 1;
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let k = j + 1;
      while (/[a-z]/.test(source[k] ?? "")) k++;
      return k;
    }
  }
  return i + 1;
}

type Span = { at: number; end: number };

/** Whether the backtick at `i` opens a tagged template, a query and not words: right
 * after a name or `)`, or after a type argument closed right after a name, as in
 * sql<{ n: number }[]>`…`. */
export function taggedAt(source: string, i: number): boolean {
  const p = source[i - 1] ?? "";
  if (/[\w$)]/.test(p)) return true;
  if (p !== ">") return false;
  let depth = 0;
  for (let j = i - 1; j >= 0 && i - j < 400; j--) {
    if (source[j] === ">" && source[j - 1] !== "=") depth++;
    else if (source[j] === "<" && --depth === 0) return /[\w$]/.test(source[j - 1] ?? "");
  }
  return false;
}

/** The code of a source file, read once: its string literals, outermost only, and what
 * is comment or literal rather than code. A tagged template (taggedAt) is a query and
 * not words, and is not a literal here. */
const scans = new Map<string, { literals: Span[]; notCode: Uint8Array }>();

function scan(file: string): { literals: Span[]; notCode: Uint8Array } {
  const known = scans.get(file);
  if (known) return known;
  const source = sourceOf(file);
  const literals: Span[] = [];
  const notCode = new Uint8Array(source.length);
  // The code between two offsets; a template's `${}` holes are code too, so a marker
  // inside one is read. Only the outermost literals are the file's literals.
  const code = (from: number, to: number, outermost: boolean) => {
    for (let i = from; i < to; i++) {
      const c = source[i]!;
      let end = -1;
      if (c === "/" && source[i + 1] === "/") end = (source.indexOf("\n", i) + 1 || source.length + 1) - 1;
      else if (c === "/" && source[i + 1] === "*") end = source.indexOf("*/", i + 2) + 2;
      else if (c === "/" && regexStarts(source, i)) end = regexEnd(source, i);
      else if (c === '"' || c === "'" || c === "`") {
        end = literalEnd(source, i);
        if (outermost && !(c === "`" && taggedAt(source, i))) literals.push({ at: i, end });
      }
      if (end > i + 1) {
        notCode.fill(1, i, end);
        if (c === "`") {
          for (let j = i + 1; j < end - 1; j++) {
            if (source[j] === "\\") j++;
            else if (source[j] === "$" && source[j + 1] === "{") {
              const close = holeEnd(source, j);
              notCode.fill(0, j + 2, close);
              code(j + 2, close, false);
              j = close;
            }
          }
        }
        i = end - 1;
      }
    }
  };
  code(0, source.length, true);
  const out = { literals, notCode };
  scans.set(file, out);
  return out;
}

/** A literal's words: its quotes unescaped, as take() reads them, and its holes named. */
function literalWords(raw: string): string {
  return plain(raw.replace(/\\(["'`])/g, "$1"), true);
}

/** Whether a text says anything: a letter outside the parts that stand for a value. */
function hasWords(text: string): boolean {
  return /[A-Za-z]/.test(text.replace(/<[^<>]*>/g, ""));
}

/** Where an expression that starts at `at` ends: at a `,` `;` or closing bracket at its
 * own depth. */
function expressionEnd(source: string, at: number): number {
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") i = literalEnd(source, i) - 1;
    else if (c === "/" && source[i + 1] === "/") i = source.indexOf("\n", i);
    else if (c === "/" && source[i + 1] === "*") i = source.indexOf("*/", i + 2) + 1;
    else if (c === "/" && regexStarts(source, i)) i = regexEnd(source, i) - 1;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return i;
    if (i < 0) return source.length;
  }
  return source.length;
}

/** The parts of an expression between a top-level operator, outside brackets and literals. */
function topLevel(expr: string, at: (expr: string, i: number) => number): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === '"' || c === "'" || c === "`") i = literalEnd(expr, i) - 1;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      const width = at(expr, i);
      if (width > 0) {
        found.push(i);
        i += width - 1;
      }
    }
  }
  return found;
}

/** A top-level conditional's `?` and its own `:`, brackets and literals allowed anywhere. */
function branchesAt(expr: string): { q: number; colon: number } | null {
  const marks = topLevel(expr, (e, i) => {
    if (e[i] === "?" && e[i + 1] !== "?" && e[i + 1] !== "." && e[i - 1] !== "?") return 1;
    if (e[i] === ":") return 1;
    return 0;
  });
  let q = -1;
  let open = 0;
  for (const i of marks) {
    if (expr[i] === "?") {
      if (q < 0) q = i;
      open++;
    } else if (q >= 0 && --open === 0) return { q, colon: i };
  }
  return null;
}

/** What an expression says: each branch of a conditional; a `+` chain of literals and
 * values, each value named as a hole is; a literal alone; or else every literal in it. */
function sayingsOf(expr: string): string[] {
  let e = expr.trim();
  while (e.startsWith("(") && expressionEnd(e, 1) === e.length - 1) e = e.slice(1, -1).trim();
  if (e === "") return [];
  const cond = branchesAt(e);
  if (cond) return [...sayingsOf(e.slice(0, cond.q).includes("?") ? "" : e.slice(cond.q + 1, cond.colon)), ...sayingsOf(e.slice(cond.colon + 1))];
  const plus = topLevel(e, (x, i) => (x[i] === "+" && x[i + 1] !== "+" && x[i + 1] !== "=" && x[i - 1] !== "+" ? 1 : 0));
  const isLiteral = (p: string) => /^["'`]/.test(p) && literalEnd(p, 0) === p.length;
  if (plus.length > 0) {
    const parts = [0, ...plus.map((i) => i + 1)].map((from, n) => e.slice(from, plus[n] ?? e.length).trim());
    if (parts.some(isLiteral)) return [parts.map((p) => (isLiteral(p) ? literalWords(p.slice(1, -1)) : plainHole(p, true))).join("")];
  }
  if (isLiteral(e)) return [literalWords(e.slice(1, -1))];
  // Anything else, a call's arguments say: each literal in them that reads as words.
  const inner: string[] = [];
  for (let i = 0; i < e.length; i++) {
    if (e[i] === '"' || e[i] === "'" || e[i] === "`") {
      const end = literalEnd(e, i);
      const text = literalWords(e.slice(i + 1, end - 1));
      if (!(e[i] === "`" && taggedAt(e, i)) && readsAsWords(text)) inner.push(text);
      i = end - 1;
    }
  }
  return inner;
}

/** A sentence read out of the source, with where it was said. */
export type Saying = { file: string; at: number; kind: string; text: string };

/**
 * What is said at each match of `marker` in a file, outside comments and literals. A
 * marker followed by a literal is read as take() reads it, unless a `+` chain follows;
 * one followed by an expression is read to its end: each branch of a conditional is a
 * saying, so is a `+` chain of literals and names, and otherwise each literal in it.
 */
export function sayingsAt(file: string, marker: RegExp, kind: string, within?: Span): Saying[] {
  const source = sourceOf(file);
  const { notCode } = scan(file);
  const out: Saying[] = [];
  for (const m of source.matchAll(marker)) {
    if (notCode[m.index] === 1) continue;
    if (within && (m.index < within.at || m.index >= within.end)) continue;
    let at = m.index + m[0].length;
    while (/\s/.test(source[at] ?? "")) at++;
    const end = expressionEnd(source, at);
    const expr = source.slice(at, end);
    const chained = /^["'`]/.test(expr) && topLevel(expr, (x, i) => (x[i] === "+" && x[i + 1] !== "+" ? 1 : 0)).length > 0;
    const texts: string[] = [];
    if (/^["'`]/.test(expr) && !chained) takeAt(source, at, (literal) => texts.push(plain(literal.text, true)));
    else texts.push(...sayingsOf(expr));
    for (const text of texts) if (hasWords(text)) out.push({ file, at, kind, text });
  }
  return out;
}

/** A MIME type or a path, which is code even when it has a space. */
const NOT_WORDS = /^(?:[a-z]+\/[a-z0-9.+-]+(?:;\s*[a-z-]+=[\w-]+)*|\.{0,2}\/\S*)$/i;

/** A saying with each part that stands for a value made one mark, so the name of a
 * value adds no space and no word. */
function withoutHoles(text: string): string {
  let bare = text;
  while (/<[^<>]*>/.test(bare)) bare = bare.replace(/<[^<>]*>/g, "\u0001");
  return bare.trim();
}

/** Whether a literal, its holes named, reads as words: a space and two or more words of
 * letters outside its holes, and not a MIME type or a path. */
function readsAsWords(text: string): boolean {
  const bare = withoutHoles(text);
  return /\s/.test(bare) && (bare.match(/[A-Za-z]+/g) ?? []).length >= 2 && !NOT_WORDS.test(bare);
}

/**
 * Every literal in a file, or between two offsets of it, that reads as words: outermost
 * only, outside comments and tagged templates, whose holes named it has a space and two
 * or more words of letters outside its holes, and is not a MIME type or a path. NOISE
 * leaves out what is plainly not said to a reader.
 */
export function wordLiterals(file: string, from = 0, to = Number.MAX_SAFE_INTEGER, kindOf: (before: string) => string = () => ""): Saying[] {
  const source = sourceOf(file);
  const out: Saying[] = [];
  for (const { at, end } of scan(file).literals) {
    if (at < from || end > to) continue;
    const text = literalWords(source.slice(at + 1, end - 1));
    if (!readsAsWords(text) || noise(file, text)) continue;
    out.push({ file, at, kind: kindOf(source.slice(Math.max(0, at - 300), at)), text });
  }
  return out;
}

/** Every outermost literal in a file, as its words read: what a NOISE entry must match. */
export function literalTexts(file: string): string[] {
  const source = sourceOf(file);
  return scan(file).literals.map(({ at, end }) => literalWords(source.slice(at + 1, end - 1)));
}

/** Where a function's body, or a call's arguments, end: from `anchor` to the bracket that
 * closes the first `(` after it, and through the body `{…}` when one follows. */
export function spanOf(file: string, anchor: string): Span {
  const source = sourceOf(file);
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`${file} no longer has ${anchor}`);
  const open = source.indexOf("(", at);
  let end = closeOf(source, open) + 1;
  const body = /^\s*(?::[^{;=]*)?\{/.exec(source.slice(end));
  if (body) end = closeOf(source, end + body[0].length - 1) + 1;
  return { at, end };
}

/** A key's first words, at most 80 characters of them: no `*`, which would end the
 * bold that holds it, and no comma or colon left at the end. */
function firstWords(text: string, n = 6): string {
  return text.replace(/\*/g, "").split(/\s+/).filter(Boolean).slice(0, n).join(" ").slice(0, 80).replace(/[,;:]+$/, "");
}

/** The `//` comment a script opens with, after any `#!` line, its marks taken off. */
function headComment(text: string): string {
  const lines = text.split("\n");
  const head: string[] = [];
  for (const line of lines.slice(lines[0]!.startsWith("#!") ? 1 : 0)) {
    if (!line.startsWith("//")) break;
    head.push(line.replace(/^\/\/ ?/, ""));
  }
  return head.join("\n").trim();
}

/** A paragraph's key words. One that opens a ``` fence is keyed by the first comment
 * inside it, which is prose, or else by its first line of code: never by the fence. */
function paragraphWords(p: string): string {
  const lines = p.split("\n");
  if (!lines[0]!.startsWith("```")) return firstWords(p);
  const code = lines.slice(1).filter((l) => !l.startsWith("```"));
  const comment = code.find((l) => /^\s*(?:#|\/\/)\s*\S/.test(l));
  return firstWords((comment ?? code.find((l) => l.trim() !== "") ?? "code").replace(/^\s*(?:#|\/\/)\s*/, ""));
}

/** The files of a folder, by repository path, sorted. */
function filesIn(dir: string, ext: RegExp): string[] {
  return readdirSync(path.join(ROOT, dir))
    .filter((f) => ext.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);
}

// ── sections 12 on ───────────────────────────────────────────────────────────

/** The paths sections 12 to 18 request, and the status each must answer. */
export const REQUESTED: { path: string; status: number; accept?: string }[] = [
  { path: "/reference", status: 200 },
  { path: "/llms.txt", status: 200 },
  { path: "/openapi.json", status: 200 },
  { path: "/v1/capabilities", status: 200 },
  { path: "/", status: 200, accept: "application/json" },
  { path: `/v1/categories?depth=${CATEGORY_MAX_DEPTH}&detail=full`, status: 200 },
  { path: "/sealed.md", status: 200 },
  { path: "/sign-post.mjs", status: 200 },
  { path: "/verify-post.mjs", status: 200 },
  { path: "/robots.txt", status: 200 },
  { path: "/no-such-path", status: 404 },
  { path: "/plugins/marketplace.json", status: 200 },
  { path: "/.well-known/oauth-protected-resource/mcp/connect", status: 200 },
];

/** Whether an OpenAPI string, at this path, is prose a reader reads: a description, a
 * summary or a title, or the name of a tag or of the contact, which a viewer shows as a
 * heading. The rest are values, such as a default or an example. */
export function openApiProse(at: string[]): boolean {
  const key = at.at(-1) ?? "";
  return ["description", "summary", "title"].includes(key) || (key === "name" && (at[0] === "tags" || at[0] === "info"));
}

/** What a key says after it when the passage is what a server with no website and no
 * operator address says instead. */
export const BARE = ", with no website and no operator address";

/** Where a refusal's detail is said, in every file under src/ but the connector's. */
const DETAIL_MARKERS: { files: RegExp; marker: RegExp; kind: string }[] = [
  { files: /./, marker: /\bdetail:\s*/g, kind: "detail" },
  { files: /^src\/domain\/|^src\/http\/app\.ts$|^src\/surface\/vocabulary\.ts$/, marker: /\b(?:refuse|invalid)\(\s*/g, kind: "detail" },
  { files: /^src\/http\/sealed\.ts$/, marker: /\bonlyFields\(input,\s*\[[^\]]*\],\s*/g, kind: "what a field is not part of" },
  // Reasons built away from the `detail:` that sends them, which the sweep found: an
  // invite link's, the parts of a finding's or a budget's refusal, and the detail an
  // object of the wrong shape is refused with.
  { files: /./, marker: /\brefused:\s*/g, kind: "detail" },
  { files: /^src\/domain\/validate\.ts$/, marker: /\bwrong\.push\(\s*|\bconst (?:detail|all|metrics)\s*=\s*|\basObject\([^,()]*,\s*/g, kind: "detail" },
];

/** The section titles of sections 12 on. A title renamed later turns every passage of
 * its section into one removed and one added. */
export const MORE_TITLES: Record<number, string> = {
  12: "The reference, as served at GET /reference",
  13: "The index, as served at GET /llms.txt",
  14: "The OpenAPI document, as served at GET /openapi.json",
  15: "The capabilities and the primer's JSON",
  16: "The category register, as served at GET /v1/categories",
  17: "Served files",
  18: "The listings and the service's name",
  19: "Refusal details",
  20: "Notices, guidance and health reasons in answers",
  21: "Refusals at the door: app sign-in and plain HTTP",
  22: "The connector's other words",
  23: "Text renderings and the page of open work",
  24: "Every branch of the plugin's hook lines",
  25: "The bridge's other words and the sealing module's reasons",
  26: "The reviewer service's own words",
};

/** The source files whose sentences the pattern sections read, by section. */
export const SWEPT: Record<number, string[]> = {
  // vocabulary.ts: the name rule's details, which PUT /v1/me/name refuses with.
  19: [...filesIn("src/http", /\.ts$/), ...filesIn("src/domain", /\.ts$/), "src/db/errors.ts", "src/surface/vocabulary.ts", ...filesIn("migrations", /\.sql$/)].filter((f) => !excluded(f)),
  20: [...filesIn("src/http", /\.ts$/), "src/surface/next-words.ts"].filter((f) => !excluded(f)),
  21: ["src/oauth/routes.ts", "src/oauth/uris.ts"],
  22: ["src/mcp/server.ts", "src/mcp/compat.ts", "src/mcp/listen.ts", "src/mcp/prompts.ts", "src/mcp/resources.ts"],
  23: ["src/mcp/render.ts", "src/http/markdown.ts"],
  24: ["plugin/hooks/words.mjs"],
  25: ["content/bridge.mjs", "content/sealed.mjs"],
  26: ["reviewer/review-proposal.ts"],
};

/** A JSON value's string leaves, in document order, with their paths. */
function leaves(value: unknown, at: string[] = [], out: { at: string[]; text: string }[] = []): { at: string[]; text: string }[] {
  if (typeof value === "string") out.push({ at, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => leaves(v, [...at, String(i)], out));
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) leaves(v, [...at, k], out);
  return out;
}

/** A document's paragraphs, a blank line apart, except inside a ``` fence. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  let lines: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (line.trim() === "" && !fenced) {
      if (lines.length) out.push(lines.join("\n"));
      lines = [];
    } else lines.push(line);
  }
  if (lines.length) out.push(lines.join("\n"));
  return out;
}

/** One OpenAPI string's place: the operation and the rest of its pointer, or the pointer. */
function openApiPlace(doc: { paths: Record<string, Record<string, { operationId?: string; parameters?: { name?: string }[] }>> }, at: string[]): { where: string; head: string } {
  if (at[0] === "paths" && at.length > 3) {
    const op = doc.paths[at[1]!]?.[at[2]!];
    if (op?.operationId) {
      const rest = at.slice(3).map((part, i, all) => (all[i - 1] === "parameters" && i === 1 ? (op.parameters?.[Number(part)]?.name ?? part) : part));
      return { where: [op.operationId, ...rest].join("/"), head: op.operationId };
    }
  }
  if (at[0] === "components" && at.length > 2) return { where: at.join("/"), head: at.slice(0, 3).join("/") };
  return { where: at.join("/"), head: at[0] ?? "" };
}

/** A WORDS function's parameter names, read from its source. */
function parameterNames(fn: (...args: unknown[]) => string): string[] {
  const head = /^\(?([^)=]*)\)?\s*=>/.exec(fn.toString())?.[1] ?? "";
  return head.split(",").map((p) => p.trim()).filter(Boolean);
}

/** Every WORDS function called with each mix of a zero and a some value for its
 * parameters, and every fixed line as it is. A some value reads as its name. */
export function wordsBranches(): { name: string; args: string[]; line: string }[] {
  const out: { name: string; args: string[]; line: string }[] = [];
  for (const [name, words] of Object.entries(WORDS as Record<string, unknown>)) {
    if (typeof words !== "function") {
      out.push({ name, args: [], line: String(words) });
      continue;
    }
    const params = parameterNames(words as (...args: unknown[]) => string);
    for (let mix = 0; mix < 2 ** params.length; mix++) {
      const args = params.map((p, i): unknown => ((mix >> (params.length - 1 - i)) & 1 ? { valueOf: (): number => 1, toString: (): string => `<${p}>` } : 0));
      out.push({
        name,
        args: args.map((a) => String(a)),
        line: (words as (...args: unknown[]) => string)(...args),
      });
    }
  }
  return out;
}

/** Sections 12 on, rendered from the service itself and read out of its source. */
async function renderMore(): Promise<string> {
  const app = createApp(EXAMPLE_CONFIG, STUB_DB);
  const get = async (p: string): Promise<string> => {
    const asked = REQUESTED.find((r) => r.path === p);
    if (!asked) throw new Error(`${p} is not in REQUESTED`);
    const answer = await app.request(p, asked.accept ? { headers: { Accept: asked.accept } } : undefined);
    if (answer.status !== asked.status) throw new Error(`GET ${p} answered ${answer.status}, not ${asked.status}`);
    return answer.text();
  };
  const face = faceReview();
  // The face's whole lines, and each whole sentence of them: a saying is in the face
  // when each of its lines is one, or is made of them. Words inside a longer sentence
  // are not said on their own there.
  const FACE = new Set<string>();
  const sentencesOf = (line: string) => line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const line of face.split("\n")) {
    const l = line.replace(/^> ?/, "").trim();
    if (l === "") continue;
    // A line as it stands, and what it says after a bold key (`**name** — `, as
    // section 5 has) or a bullet's mark.
    for (const said of new Set([l, l.replace(/^\*\*[^*]+\*\* — /, ""), l.replace(/^[-*] /, "")])) {
      FACE.add(said);
      for (const s of sentencesOf(said)) FACE.add(s);
    }
  }
  const inFace = (text: string) =>
    text.split("\n").every((line) => {
      const l = line.trim();
      return l === "" || FACE.has(l) || sentencesOf(l).every((s) => FACE.has(s));
    });

  const out: string[] = [];
  let keys = new Set<string>();
  const section = (n: number) => {
    out.push("---", "", `## ${n}. ${MORE_TITLES[n]}`, "");
    keys = new Set<string>();
  };
  const put = (key: string, kind: string, text: string) => {
    const first = key.replace(/\*/g, "").replace(/\s+/g, " ").trim();
    let unique = first;
    for (let n = 2; keys.has(unique); n++) unique = `${first} (${n})`;
    keys.add(unique);
    out.push(`**${unique}** — ${kind.replace(/\s+/g, " ").trim()}`, "", ...text.split("\n").map((l) => `> ${l}`), "");
  };
  /** A document's parts as the reference is cut: each paragraph, and each table row. */
  const documentParts = (prefix: string, part: string) => {
    const [heading, ...rest] = part.trimEnd().split("\n");
    put(`${prefix}: heading`, "heading", heading!);
    for (const p of paragraphs(rest.join("\n"))) {
      const lines = p.split("\n");
      if (lines.every((l) => l.startsWith("|"))) {
        put(`${prefix}: table head`, "a table's head", lines.slice(0, 2).join("\n"));
        for (const row of lines.slice(2)) put(`${prefix}: ${row.split("|")[1]?.trim() || "(empty)"}`, "a table row", row);
      } else put(`${prefix}: ${paragraphWords(p)}`, "paragraph", p);
    }
  };
  /** Sayings not in the face, each once, keyed by `keyOf`; or every one, `all`. */
  const sayings = (list: Saying[], keyOf: (s: Saying) => string, kindOf: (s: Saying) => string = (s) => s.kind, all = false) => {
    const seen = new Set<string>();
    for (const s of list) {
      const key = keyOf(s);
      if ((!all && inFace(s.text)) || seen.has(`${key}\n${s.text}`)) continue;
      seen.add(`${key}\n${s.text}`);
      put(key, kindOf(s), s.text);
    }
  };
  const base = (file: string) => path.basename(file);

  // 12. The reference, cut where the service cuts it.
  section(12);
  const reference = await get("/reference");
  put("opening", "the text before the first section", reference.slice(0, reference.search(/^## /m)).trim());
  const cut = referenceParts(reference);
  for (const [slug, part] of cut.sections) {
    if (slug === "operations") {
      put(`${slug}: heading`, "heading", part.slice(0, part.search(/^### /m)).trim());
      for (const [name, block] of cut.operations) put(`operation ${name}`, "an operation's block", block.trim());
    } else documentParts(slug, part);
  }

  // 13. The index, by its blocks.
  section(13);
  const llms = await get("/llms.txt");
  const blocks = llms.trim().split(/^(?=## )/m);
  put("llms.txt: head", "the text before the first block", blocks[0]!.trim());
  for (const block of blocks.slice(1)) put(`llms.txt: ${block.slice(3, block.indexOf("\n")).trim()}`, "a block", block.trim());

  // 14. The OpenAPI document: each distinct string once, at its first place.
  section(14);
  const openapi = JSON.parse(await get("/openapi.json"));
  const strings = new Map<string, { where: string; heads: Set<string>; n: number }>();
  for (const leaf of leaves(openapi)) {
    if (!leaf.text.includes(" ") || !openApiProse(leaf.at)) continue;
    const place = openApiPlace(openapi, leaf.at);
    const known = strings.get(leaf.text);
    if (known) {
      known.n++;
      known.heads.add(place.head);
    } else strings.set(leaf.text, { where: place.where, heads: new Set([place.head]), n: 1 });
  }
  for (const [text, { where, heads, n }] of strings) {
    put(where, `used in ${n} ${n === 1 ? "place" : "places"}: ${[...heads].sort().join(", ")}`, text);
  }

  // 15. The capabilities, and what GET / says as JSON besides section 5's sentences.
  section(15);
  const capabilities = leaves(JSON.parse(await get("/v1/capabilities")));
  for (const leaf of capabilities) {
    if (leaf.text.includes(" ")) put(`capabilities ${leaf.at.join(".")}`, "GET /v1/capabilities", leaf.text);
  }
  // What a server with no website and no operator address says instead: the code
  // that is published, run by anyone, says it.
  const bare = await createApp(BARE_CONFIG, STUB_DB).request("/v1/capabilities");
  if (bare.status !== 200) throw new Error(`GET /v1/capabilities with no website answered ${bare.status}`);
  const first = new Set(capabilities.map((l) => `${l.at.join(".")}\n${l.text}`));
  for (const leaf of leaves(await bare.json())) {
    if (leaf.text.includes(" ") && !first.has(`${leaf.at.join(".")}\n${leaf.text}`)) {
      put(`capabilities ${leaf.at.join(".")}${BARE}`, "GET /v1/capabilities on a server with no website and no operator address", leaf.text);
    }
  }
  for (const leaf of leaves(JSON.parse(await get("/")))) {
    if (leaf.text.includes(" ") && !inFace(leaf.text)) put(`GET / ${leaf.at.join(".")}`, "GET / with Accept: application/json", leaf.text);
  }

  // 16. The category register, whole.
  section(16);
  type Category = Record<string, unknown> & { id: string; label: string; parent: string | null; status: string; examples: string[]; aliases: string[] };
  const register = JSON.parse(await get(`/v1/categories?depth=${CATEGORY_MAX_DEPTH}&detail=full`)) as { rules: Record<string, unknown>; categories: Category[] };
  for (const [name, rule] of Object.entries(register.rules)) if (typeof rule === "string") put(`rules.${name}`, "a filing rule", rule);
  for (const c of register.categories) {
    // A field with nothing in it has no line.
    const fields: [string, unknown][] = [
      ["label", c.label],
      ["type", c.type],
      ["description", c.description],
      ["elsewhere", c.elsewhere],
      ["examples", c.examples.join("; ")],
      ["aliases", c.aliases.join("; ")],
      ["status", c.status === "active" ? null : c.status],
      ["replaced_by", c.replaced_by],
    ];
    const lines = fields.filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => `${k}: ${v}`);
    put(`category ${c.id}`, c.parent ? `under ${c.parent}` : "a main category", lines.join("\n"));
  }

  // 17. Served files.
  section(17);
  const sealed = await get("/sealed.md");
  put("sealed.md: opening", "the text before the first section", sealed.slice(0, sealed.search(/^## /m)).trim());
  for (const [slug, part] of referenceParts(sealed).sections) documentParts(`sealed.md: ${slug}`, part);
  // The two helpers: the comment they open with, and what they print as they run.
  for (const file of ["sign-post.mjs", "verify-post.mjs"]) {
    const served = await get(`/${file}`);
    if (served !== sourceOf(`content/${file}`)) throw new Error(`GET /${file} is not content/${file}`);
    put(`${file}: header comment`, "the comment the file opens with, which anyone fetching it reads", headComment(served));
    sayings(wordLiterals(`content/${file}`, 0, undefined, () => "said by the helper as it runs"), (s) => `${file}: ${firstWords(s.text)}`, undefined, true);
  }
  put("robots.txt", "the whole file", (await get("/robots.txt")).trim());
  const unknown = JSON.parse(await get("/no-such-path")) as { error: { message: string; fix: string } };
  put("unknown path", "the answer to a path no operation has", `${unknown.error.message}\n${unknown.error.fix}`);

  // 18. The listings, the package and the service's name.
  section(18);
  // Commands are code, not listing text: a hook's command, and a package's scripts.
  const isCode = (file: string, at: string[]) => (file.endsWith("hooks.json") && at.at(-1) === "command") || (file === "bridge/package.json" && at[0] === "scripts");
  const listing = (file: string, value: unknown) => {
    for (const leaf of leaves(value)) if (leaf.text.includes(" ") && !isCode(file, leaf.at)) put(`${file} ${leaf.at.join(".")}`, "listing text", leaf.text);
    const keywords = (v: unknown, at: string[]): void => {
      if (Array.isArray(v)) v.forEach((x, i) => keywords(x, [...at, String(i)]));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "keywords" && Array.isArray(x)) put(`${file} ${[...at, k].join(".")}`, "keywords", x.join(", "));
          else keywords(x, [...at, k]);
        }
      }
    };
    keywords(value, []);
  };
  listing("GET /plugins/marketplace.json", JSON.parse(await get("/plugins/marketplace.json")));
  for (const name of [".claude-plugin/plugin.json", "hooks/hooks.json"]) {
    const file = pluginFiles().find((f) => f.name === name);
    if (!file) throw new Error(`the plugin has no ${name}`);
    listing(`plugin ${name}`, JSON.parse(file.bytes.toString("utf8")));
  }
  for (const file of [".claude-plugin/marketplace.json", "bridge/package.json", "server.json"]) listing(file, JSON.parse(sourceOf(file)));
  for (const p of paragraphs(sourceOf("bridge/README.md"))) put(`bridge/README.md: ${paragraphWords(p)}`, "a paragraph of the package's README", p);
  for (const leaf of leaves(serverIdentity("https://schellingaf.com"))) {
    if (leaf.text.includes(" ")) put(`MCP initialize ${leaf.at.join(".")}`, "the connector's name, as an app shows it", leaf.text);
  }
  const resource = JSON.parse(await get("/.well-known/oauth-protected-resource/mcp/connect")) as { resource_name: string };
  put("GET /.well-known/oauth-protected-resource/mcp/connect resource_name", "the connector's name, as an app signing in shows it", resource.resource_name);

  // 19. Refusal details: the sentence naming the field or the rule.
  section(19);
  const codeBefore = (s: Saying): string => {
    const source = sourceOf(s.file);
    const before = source.slice(0, s.at);
    // A helper that refuses gives its own code, wherever it is defined.
    const helper = /\b(refuse|invalid)\(\s*$/.exec(before)?.[1];
    const own = helper ? new RegExp(`(?:function ${helper}\\(|const ${helper} = )[^]*?ApiError\\(\\s*"([A-Z_]+)"`).exec(source)?.[1] : undefined;
    if (own) return own;
    const codes = [...before.matchAll(/ApiError\(\s*"([A-Z_]+)"|RAISE EXCEPTION '([A-Z_]+)'|\bcode:\s*"([A-Z][A-Z_]{3,})"/g)];
    const last = codes.at(-1);
    return last ? (last[1] ?? last[2] ?? last[3]!) : "detail";
  };
  const details: Saying[] = [];
  const typed = (dir: string): string[] => {
    const all: string[] = [];
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) all.push(...typed(file));
      else if (entry.name.endsWith(".ts")) all.push(file);
    }
    return all;
  };
  for (const file of typed("src").filter((f) => !f.startsWith("src/mcp/") && !excluded(f))) {
    for (const { files, marker, kind } of DETAIL_MARKERS) if (files.test(file)) details.push(...sayingsAt(file, marker, kind));
  }
  const errors = sourceOf("src/db/errors.ts");
  details.push(
    ...wordLiterals("src/db/errors.ts", errors.indexOf("const CALLER_INPUT_SQLSTATES"), errors.indexOf("export function fromDatabaseError"), () => "detail").map((s) => ({ ...s, kind: "detail for a database error" })),
  );
  // Each key names its file, so a repeat is numbered within one file and a saying
  // added to another file moves no number.
  sayings(details, (s) => `${s.kind === "detail for a database error" ? "INVALID_REQUEST" : codeBefore(s)}: ${firstWords(s.text)}, ${s.file}`, (s) => s.kind);
  const sqlDetails = new Map<string, string>();
  for (const file of filesIn("migrations", /\.sql$/)) {
    const sql = sourceOf(file);
    for (const m of sql.matchAll(/USING DETAIL = '((?:[^']|'')*)'/g)) {
      const text = m[1]!.replace(/''/g, "'");
      const raise = [...sql.slice(0, m.index).matchAll(/RAISE EXCEPTION '([A-Z_]+)'/g)].at(-1)?.[1] ?? "detail";
      if (!sqlDetails.has(text)) sqlDetails.set(text, `${raise}\n${file}`);
    }
  }
  for (const [text, at] of sqlDetails) {
    const [code, file] = at.split("\n");
    if (hasWords(text) && !inFace(text)) put(`${code}: ${firstWords(text)}, ${file}`, "detail the database gives", text);
  }

  // 20. Notices, guidance and health reasons inside answers.
  section(20);
  const guidance: Saying[] = [];
  for (const file of SWEPT[20]!) {
    guidance.push(...sayingsAt(file, /\bnotice:\s*/g, "notice"), ...sayingsAt(file, /\b[A-Z_]*NOTICE\s*=\s*/g, "notice"));
  }
  guidance.push(
    ...sayingsAt("src/http/seek.ts", /\bnotes\.push\(\s*/g, "note on a SEEK answer"),
    ...sayingsAt("src/http/seek.ts", /\b[A-Z_]*_NOTE\s*=\s*/g, "note on a SEEK answer"),
    ...sayingsAt("src/http/categories.ts", /\bnext:\s*/g, "what to do next, on a categories answer"),
    ...sayingsAt("src/http/app.ts", /\breason:\s*/g, "why GET /healthz answers 503", spanOf("src/http/app.ts", 'app.get("/healthz"')),
  );
  sayings(guidance, (s) => `${base(s.file)}: ${firstWords(s.text)}`);
  // Why next hands out its job: one sentence a case, which next_job() fills with numbers.
  for (const [key, text] of Object.entries(NEXT_WORDS.why)) put(`next why: ${key}`, "why next hands out this job; the database fills in each {number}", text);
  // What calls a task review, task numbers as a sentence says them, and the upkeep briefs:
  // the title and body of a task the service hands out, filled with numbers only.
  for (const [key, text] of Object.entries(NEXT_WORDS.signals)) put(`next signal: ${key}`, "what calls a task review, in its why and its brief", text);
  for (const [key, text] of Object.entries(NEXT_WORDS.tasks)) put(`next task numbers: ${key}`, "task numbers inside a signal", text);
  put("next count at its cap", "a count of findings and results at 100", NEXT_WORDS.count_cap);
  for (const [key, brief] of Object.entries(NEXT_WORDS.upkeep)) {
    put(`upkeep ${key}: title`, "an upkeep task's title, the service's own", brief.title);
    put(`upkeep ${key}: body`, "an upkeep task's body, the service's fixed brief", brief.body);
  }
  // A sentence a database function puts in its answer, found by the sweep: a field of a
  // jsonb_build_object whose value is words.
  for (const file of filesIn("migrations", /\.sql$/)) {
    const sql = sourceOf(file).replace(/--.*$/gm, "");
    for (const m of sql.matchAll(/jsonb_build_object\(/g)) {
      const args = sql.slice(m.index + m[0].length, sql.indexOf(";", m.index));
      for (const pair of args.matchAll(/'([a-z_]+)',\s*'((?:[^']|'')*)'/g)) {
        const text = pair[2]!.replace(/''/g, "'");
        if (/\s/.test(text) && (text.match(/[A-Za-z]+/g) ?? []).length >= 2 && !inFace(text)) put(`${base(file)}: ${firstWords(text)}`, `${pair[1]} in a database function's answer`, text);
      }
    }
  }

  // 21. Refusals before any operation: an app's sign-in, and plain HTTP.
  section(21);
  const door: Saying[] = [];
  // Each oauthError's description, known by the OAuth error it is sent with.
  const routes = sourceOf("src/oauth/routes.ts");
  for (const s of sayingsAt("src/oauth/routes.ts", /\boauthError\(c,\s*\d+,\s*[^,]+,\s*/g, "OAuth refusal")) {
    const error = /\boauthError\(c,\s*\d+,\s*"([a-z_]+)",\s*$/.exec(routes.slice(Math.max(0, s.at - 200), s.at))?.[1];
    door.push({ ...s, kind: error ?? "OAuth refusal" });
  }
  door.push(
    ...sayingsAt("src/oauth/routes.ts", /\bc\.text\(\s*/g, "plain-text answer"),
    ...sayingsAt("src/oauth/routes.ts", /\berror_description:\s*/g, "error_description"),
    ...sayingsAt("src/http/app.ts", /\berror_description:\s*/g, "error_description"),
    ...sayingsAt("src/oauth/uris.ts", /\breason:\s*/g, "why a redirect address is refused", spanOf("src/oauth/uris.ts", "function checkRedirectUri")),
    // Found by the sweep: the connector's refusal of a batch, before any tool is reached.
    ...sayingsAt("src/http/app.ts", /\bcode: -\d+, message:\s*/g, "JSON-RPC refusal at /mcp"),
  );
  for (const fn of ["function readRedirectUris", "function registerClient"]) {
    const span = spanOf("src/oauth/clients.ts", fn);
    door.push(...wordLiterals("src/oauth/clients.ts", span.at, span.end, () => "why a registration is refused"));
  }
  const oauthCode = (s: Saying) => /^[a-z_]+$/.test(s.kind) && s.kind !== "error_description";
  sayings(door, (s) => (oauthCode(s) ? `${s.kind}: ${firstWords(s.text)}, ${s.file}` : `${base(s.file)}: ${firstWords(s.text)}`), (s) => (oauthCode(s) ? "OAuth refusal" : s.kind));
  const caddy = /respond\s+"((?:[^"\\]|\\.)*)"/.exec(sourceOf("Caddyfile"));
  if (!caddy) throw new Error("the Caddyfile no longer answers plain HTTP with a sentence");
  const plainHttp = caddy[1]!.replace(/\{\$API_HOST\}/g, "<host>").replace(/\\(["\\])/g, "$1");
  put(`Caddyfile: ${firstWords(plainHttp)}`, "the proxy's answer to a plain-HTTP request", plainHttp);

  // 22. The connector's other words: argument descriptions, refusals, result sentences.
  section(22);
  const connectorKind = (before: string): string => {
    const last = [...before.matchAll(/\.describe\(\s*|\bdescription:\s*|\bcomplain\(\s*|\brefused:\s*|\brefuse\(\s*|\binvalid\(\s*|[;{}]/g)].at(-1)?.[0] ?? "";
    if (last.startsWith(".describe")) return "argument description";
    if (last.startsWith("description")) return "description";
    if (/^(complain|refused|refuse|invalid)/.test(last)) return "refusal";
    return "result sentence";
  };
  const connector: Saying[] = [];
  for (const file of SWEPT[22]!) connector.push(...wordLiterals(file, 0, undefined, connectorKind));
  // A post an app signs is made canonical on the way, and what cannot be is refused
  // to the agent in the canonical form's own words (src/mcp/server.ts, the signing
  // through a connection key).
  connector.push(...sayingsAt("src/domain/jcs.ts", /\bnew TypeError\(\s*/g, "refusal of a post an app signs"));
  sayings(connector, (s) => `${base(s.file)}: ${firstWords(s.text)}`);

  // 23. Text renderings of every read, the page of open work's among them.
  section(23);
  sayings(
    SWEPT[23]!.flatMap((file) => wordLiterals(file, 0, undefined, () => "text rendering")),
    (s) => `${base(s.file)}: ${firstWords(s.text)}`,
  );

  // 24. Every branch of the plugin's hook lines that section 8 does not show.
  section(24);
  const eight = face.slice(face.indexOf("## 8. "), face.indexOf("## 9. "));
  const shown = new Set<string>();
  for (const { name, args, line } of wordsBranches()) {
    const parts = line.split(/<[A-Za-z]+>|\b0\b/).filter((part) => part.trim() !== "");
    if (parts.every((part) => eight.includes(part)) || shown.has(line)) continue;
    shown.add(line);
    put(`WORDS.${name} [${args.join(", ")}]`, "a branch section 8 does not show", line);
  }

  // 25. The bridge's other words, and the reasons the sealing module refuses.
  section(25);
  for (const file of SWEPT[25]!) put(`${base(file)}: header comment`, "the comment the file opens with, which anyone fetching it reads", headComment(sourceOf(file)));
  sayings(wordLiterals("content/bridge.mjs", 0, undefined, () => "said by the bridge"), (s) => `bridge.mjs: ${firstWords(s.text)}`);
  sayings(sayingsAt("content/sealed.mjs", /\brefuse\(\s*/g, "why the sealing module refuses"), (s) => `sealed.mjs: ${firstWords(s.text)}`);

  // 26. The reviewer service's own words.
  section(26);
  const reviewer = "reviewer/review-proposal.ts";
  const said: Saying[] = [];
  for (const fn of ["material", "publishable"]) {
    const span = spanOf(reviewer, `export function ${fn}(`);
    const source = sourceOf(reviewer);
    for (const { at, end } of scan(reviewer).literals) {
      if (at < span.at || end > span.end) continue;
      const text = literalWords(source.slice(at + 1, end - 1));
      if (text.trim() === "" || noise(reviewer, text)) continue;
      said.push({ file: fn, at, kind: fn === "material" ? "the material the model is shown" : "a decision's reason, as published", text });
    }
  }
  said.push(...sayingsAt(reviewer, /\bbody:\s*/g, "the body of the decision post", spanOf(reviewer, "export async function reviewProposal(")).map((s) => ({ ...s, file: "reviewProposal" })));
  // Every one, the face's words included: a wrapper's labels are short enough to be in
  // it by chance, and the material is read whole.
  sayings(said, (s) => `${s.file}: ${firstWords(s.text)}`, undefined, true);

  return out.join("\n") + "\n";
}

/** A passage of the review that differs from what was approved: what an approval page
 * shows, old beside new, with how much it adds. */
export type Passage = {
  section: string;
  key: string | null;
  kind: "added" | "removed" | "changed";
  old: string | null;
  new: string | null;
  tokens: number;
};

/** The review text by its numbered sections, and what comes before them. */
function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let title = "Preamble";
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^## (\d+\. .*)$/.exec(line);
    if (m) {
      out.set(title, lines.join("\n"));
      title = m[1]!;
      lines = [];
    } else lines.push(line);
  }
  out.set(title, lines.join("\n"));
  return out;
}

type Unit = { key: string | null; text: string };

/** A section's passages: a bold-keyed item with what follows it, or a paragraph. */
function units(body: string): Unit[] {
  const out: Unit[] = [];
  for (const p of body.split(/\n\s*\n/).map((x) => x.replace(/^\n+|\n+$/g, ""))) {
    if (p.trim() === "" || p.trim() === "---") continue;
    const m = /^\*\*([^*]+)\*\*/.exec(p);
    const last = out.at(-1);
    if (m) out.push({ key: m[1]!, text: p });
    else if (last && last.key !== null && (p.startsWith(">") || p.startsWith("    "))) last.text += "\n\n" + p;
    else out.push({ key: null, text: p });
  }
  return out;
}

/** How alike two passages are, 0 to 1: shared word pairs over all word pairs. */
function alike(a: string, b: string): number {
  const pairs = (t: string) => {
    const w = t.split(/\s+/);
    return new Set(w.slice(1).map((x, i) => `${w[i]} ${x}`));
  };
  const x = pairs(a);
  const y = pairs(b);
  if (x.size + y.size === 0) return 1;
  let shared = 0;
  for (const p of x) if (y.has(p)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** Every passage of the review that differs from the approved text: keyed passages by
 * key, the rest by the most alike, in the order the current text has them. */
export function changedPassages(approvedText: string, current: string): Passage[] {
  const start = approvedText.indexOf("# The words agents read");
  const before = sections(start < 0 ? approvedText : approvedText.slice(start));
  const out: Passage[] = [];
  const passage = (section: string, a: Unit | null, b: Unit | null): Passage => ({
    section,
    key: (b ?? a)!.key,
    kind: a === null ? "added" : b === null ? "removed" : "changed",
    old: a?.text ?? null,
    new: b?.text ?? null,
    tokens: tokens(b?.text ?? "") - tokens(a?.text ?? ""),
  });
  for (const [title, body] of sections(current)) {
    let oldUnits = units(before.get(title) ?? "");
    let newUnits = units(body);
    // A passage that went and one that came with the same quoted words: its key or
    // its kind moved, and its words did not, so the pair is no change to read.
    const quoted = (u: Unit) => (u.key === null ? "" : u.text.split("\n").filter((l) => l.startsWith(">")).join("\n"));
    const same = (a: Unit, b: Unit) => a.key === b.key && a.text === b.text;
    const went = oldUnits.filter((o) => o.key !== null && !newUnits.some((n) => same(o, n)));
    const moved = new Set<Unit>();
    for (const n of newUnits) {
      if (n.key === null || quoted(n) === "" || oldUnits.some((o) => same(o, n))) continue;
      const o = went.find((w) => !moved.has(w) && quoted(w) === quoted(n));
      if (o) moved.add(o).add(n);
    }
    oldUnits = oldUnits.filter((u) => !moved.has(u));
    newUnits = newUnits.filter((u) => !moved.has(u));
    const oldKeyed = new Map(oldUnits.filter((u) => u.key !== null).map((u) => [u.key!, u]));
    const newKeys = new Set(newUnits.filter((u) => u.key !== null).map((u) => u.key!));
    const oldPlain = oldUnits.filter((u) => u.key === null && !newUnits.some((n) => n.key === null && n.text === u.text));
    for (const u of newUnits) {
      if (u.key !== null) {
        const was = oldKeyed.get(u.key) ?? null;
        if (was === null || was.text !== u.text) out.push(passage(title, was, u));
      } else if (!oldUnits.some((o) => o.key === null && o.text === u.text)) {
        // The most alike unmatched old paragraph, if it is alike enough to be the same one.
        let best: Unit | null = null;
        let score = 0.35;
        for (const o of oldPlain) {
          const s = alike(o.text, u.text);
          if (s > score) [best, score] = [o, s];
        }
        if (best) oldPlain.splice(oldPlain.indexOf(best), 1);
        out.push(passage(title, best, u));
      }
    }
    for (const o of oldPlain) out.push(passage(title, o, null));
    for (const [key, o] of oldKeyed) if (!newKeys.has(key)) out.push(passage(title, o, null));
  }
  // A section the current text no longer has at all: every passage of it went.
  const now = sections(current);
  for (const [title, body] of before) {
    if (!now.has(title)) for (const u of units(body)) out.push(passage(title, u, null));
  }
  return out;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly && process.argv.includes("--more")) {
  // The child reviewText() starts: sections 12 on, then the line that says they ended.
  process.stdout.write((await renderMore()) + SENTINEL);
} else if (invokedDirectly) {
  const text = reviewText();
  if (process.argv.includes("--diff")) {
    const changed = changedPassages(existsSync(APPROVED) ? readFileSync(APPROVED, "utf8") : "", text);
    process.stdout.write(JSON.stringify(changed, null, 1) + "\n");
    process.stderr.write(`${changed.length} passages differ, ${changed.reduce((n, p) => n + p.tokens, 0)} tokens between them\n`);
  } else if (process.argv.includes("--write")) {
    const header = [
      "<!--",
      "  The words the service says to agents, frozen.",
      "",
      "  test/copy.test.ts renders what the running service says and diffs it against this",
      "  file, failing on any difference in either direction. This file is the source and the",
      "  code follows it; regenerating it to make a test pass defeats the point.",
      "",
      "  Written by scripts/copy-review.ts. Regenerate deliberately: npm run copy -- --write",
      "-->",
      "",
    ].join("\n");
    writeFileSync(APPROVED, header + text);
    process.stdout.write(`wrote ${path.relative(ROOT, APPROVED)} (${tokens(text)} tokens)\n`);
  } else {
    process.stdout.write(text);
    if (existsSync(APPROVED)) {
      const approved = readFileSync(APPROVED, "utf8");
      const same = approved.endsWith(text);
      process.stderr.write(
        same
          ? "\n— matches reference/approved-copy.md\n"
          : "\n— DIFFERS from reference/approved-copy.md; run npm run copy -- --write only when this text is approved\n",
      );
    }
  }
}
