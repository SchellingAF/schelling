// Print exactly the text that has to be approved, and nothing else.
//
//   npm run copy
//   npm run copy -- --diff      (each passage that differs from what was approved, as JSON)
//   npm run copy -- --write     (writes reference/approved-copy.md)
//
// Reading every word of the API's prose in one sitting is how approval becomes a
// rubber stamp. So this collects only the product's face — the primer, every
// refusal an agent can meet, the connector's tool descriptions, the notice lines,
// each operation's sentence, and the documents, prompts, skill, plugin words and
// reviewer's rules an agent reads — and leaves out the generated reference tables,
// which are guarded mechanically against new promise words instead.
//
// Nothing here approves anything. `--write` records the CURRENT text as the
// candidate; the approval is a separate, deliberate commit that whoever approves
// the copy makes, and the guard in test/copy.test.ts compares what the service
// says against what was approved.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error: plain JavaScript, read for its words.
import { WORDS } from "../plugin/hooks/words.mjs";
import { ERRORS } from "../src/db/errors.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { renderPrimer, tokens } from "../src/docs/render.ts";
import { PROMPTS } from "../src/mcp/prompts.ts";
import { DOCUMENT_RESOURCES, TEMPLATE_RESOURCES } from "../src/mcp/resources.ts";

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
  throw new Error(`a string literal at offset ${start} of content/bridge.mjs does not end`);
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
function plainPart(part: string): string {
  const t = part.trim();
  if (/^["'`]/.test(t) && literalEnd(t, 0) === t.length) return plain(t.slice(1, -1).replace(/\\(["'`])/g, "$1"));
  return plainHole(t);
}

function plainHole(expr: string): string {
  const cond = conditionalAt(expr);
  if (cond) {
    const yes = plainPart(expr.slice(cond.q + 1, cond.colon));
    const no = plainPart(expr.slice(cond.colon + 1));
    return no === "" ? `[${yes}]` : `[${yes} / ${no}]`;
  }
  const fallback = /^(.*?)\s\?\?\s(.*)$/s.exec(expr);
  if (fallback) {
    const other = plainPart(fallback[2]!);
    const name = plainHole(fallback[1]!).slice(1, -1);
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
function plain(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && text[i + 1] === "{") {
      const end = holeEnd(text, i);
      out += plainHole(text.slice(i + 2, end));
      i = end;
    } else out += text[i];
  }
  return out;
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
];

/** The bridge's own words, read out of content/bridge.mjs the way the notices are read
 * out of the routes: every sentence it says to an agent through a tool, to the person
 * on stderr, or to the client, with the kind of saying it is. A sentence is the string
 * literal at the marker, and the other branch of a conditional that follows it. */
export function bridgeWords(): { kind: string; text: string }[] {
  const source = readFileSync(path.join(ROOT, "content", "bridge.mjs"), "utf8");
  const found: { at: number; end: number; kind: string; text: string }[] = [];
  const take = (at: number, kind: string): number => {
    let from = at;
    for (;;) {
      while (/\s/.test(source[from] ?? "")) from++;
      if (!/["'`]/.test(source[from] ?? "")) return from;
      const end = literalEnd(source, from);
      const text = source.slice(from + 1, end - 1).replace(/\\(["'`])/g, "$1");
      // A character class the fence builds (`[` + holes + `]`) is code that happens
      // to follow a marker, not a saying.
      if (text.trim() !== "" && !/^\[(<[^>]*>)*\]$/.test(plain(text))) found.push({ at: from, end, kind, text });
      from = end;
      // A conditional's other branch is a saying too.
      const rest = /^\s*:\s*/.exec(source.slice(from));
      if (!rest || !/["'`]/.test(source[from + rest[0].length] ?? "")) return from;
      from += rest[0].length;
    }
  };
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

export function reviewText(): string {
  const out: string[] = [];
  out.push("# The words agents read");
  out.push("");
  out.push(
    "This is the product's face: what an agent reads before it does anything, what it is told when it is refused, and the sentences the service says in its own voice. The generated reference tables are not here — they are guarded against new promise words instead of approved line by line.",
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

  out.push("---", "", "## 5. What the operations say about themselves", "");
  out.push(
    "One sentence each, shown in the reference, in the index and in `GET /v1/capabilities`.",
    "",
  );
  for (const op of OPERATIONS) out.push(`**${op.name}** — ${op.describe}`, "");

  out.push("---", "", "## 6. The connector's documents and prompts", "");
  out.push(
    "An app lists the documents by title and attaches one as context; a model reads the description to decide which. A prompt's title and description are what a person picks from a menu, and its message is what the agent then reads.",
    "",
  );
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
    WORDS.spaces("my-work, notes", 0, 3),
    WORDS.spaces("", 0, 2),
    WORDS.tokenSoon,
    WORDS.habits,
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
    const oldUnits = units(before.get(title) ?? "");
    const newUnits = units(body);
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

if (invokedDirectly) {
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
