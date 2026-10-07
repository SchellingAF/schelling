// What src/ sends to the database, read from the source: every tagged template, the
// connection each one runs on, and where each value it binds comes from. The guards in
// test/sec-db-access-sql.test.ts hold the row-level policies and the definer functions to
// what the service really sends: a statement that reads a policied table outside readTx,
// or hands a definer an actor the request chose, fails the suite where it is written.
//
// A reader of this codebase's TypeScript, not of TypeScript. It tells strings, comments,
// regular expressions and template literals apart well enough to find every template and
// to match brackets, and it follows a name through the bindings this code uses: a
// parameter, a const, a destructuring, an import, a function's return, a property of an
// object literal. Whatever it cannot follow is `unknown`, which every guard refuses, so a
// change it cannot read fails the suite and asks to be read by a person, never passes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** A template literal: its backticks' positions, its tag as written, and its `${}` parts. */
export type Template = { start: number; end: number; tag: string; tagStart: number; exprs: { start: number; end: number }[] };

/**
 * One file: its text; the same text with every string, comment, regular expression and
 * template's own text blanked, where brackets match (`code`); for each position of `code`,
 * the bracket matching it (`match`) and the innermost bracket open around it (`around`);
 * its templates; and the extents of its import and export statements and of its comments.
 */
export type Source = {
  file: string;
  src: string;
  code: string;
  match: Int32Array;
  around: Int32Array;
  templates: Template[];
  imports: { start: number; end: number }[];
  comments: { start: number; end: number }[];
};

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof",
]);
const PUNCTUATION_BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);

/** A file read: its templates, and its code with everything that is not code blanked. */
export function lex(src: string, file = "<source>"): Source {
  const templates: Template[] = [];
  const comments: { start: number; end: number }[] = [];
  const code = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " ";
  };
  type Frame = { kind: "code"; depth: number } | { kind: "template"; t: Template; exprStart: number; textFrom: number };
  const stack: Frame[] = [{ kind: "code", depth: 0 }];
  let lastSignificant = "";
  let lastWord = "";
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1]!;
    const ch = src[i]!;
    if (top.kind === "template") {
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") {
        blank(top.textFrom, i + 1);
        top.t.end = i + 1;
        templates.push(top.t);
        stack.pop();
        i++;
        lastSignificant = "`";
        lastWord = "";
        continue;
      }
      if (ch === "$" && src[i + 1] === "{") {
        blank(top.textFrom, i + 2);
        top.exprStart = i + 2;
        stack.push({ kind: "code", depth: 0 });
        i += 2;
        lastSignificant = "{";
        lastWord = "";
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const newline = src.indexOf("\n", i);
      const end = newline < 0 ? src.length : newline;
      blank(i, end);
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(i, end);
      comments.push({ start: i, end });
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
      lastSignificant = ch;
      lastWord = "";
      continue;
    }
    if (ch === "`") {
      const { tag, tagStart } = tagBefore(code, i);
      stack.push({ kind: "template", t: { start: i, end: -1, tag, tagStart, exprs: [] }, exprStart: -1, textFrom: i });
      i++;
      continue;
    }
    if (ch === "/" && (PUNCTUATION_BEFORE_REGEX.has(lastSignificant) || KEYWORDS_BEFORE_REGEX.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const c = src[j]!;
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      blank(i, j);
      i = j;
      lastSignificant = "/";
      lastWord = "";
      continue;
    }
    if (ch === "{") top.depth++;
    if (ch === "}") {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop();
        const outer = stack[stack.length - 1] as Extract<Frame, { kind: "template" }>;
        outer.t.exprs.push({ start: outer.exprStart, end: i });
        outer.textFrom = i;
        i++;
        continue;
      }
      top.depth--;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j]!)) j++;
      lastWord = src.slice(i, j);
      lastSignificant = "a";
      i = j;
      continue;
    }
    lastSignificant = ch;
    lastWord = "";
    i++;
  }
  if (stack.length !== 1) throw new Error(`${file}: the reader ended inside a ${stack[stack.length - 1]!.kind}; teach test/lib/sql-sites.ts this file`);
  const text = code.join("");
  const { match, around } = brackets(text, file);
  const imports: { start: number; end: number }[] = [];
  for (const m of src.matchAll(/^[ \t]*(?:import|export)\s[^;]*?\bfrom\s*["'][^"']+["'];?|^[ \t]*export\s*\{[^}]*\};?/gm)) {
    imports.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return { file, src, code: text, match, around, templates, imports, comments };
}

/** Every bracket's partner, and every position's innermost open bracket. */
function brackets(code: string, file: string): { match: Int32Array; around: Int32Array } {
  const match = new Int32Array(code.length).fill(-1);
  const around = new Int32Array(code.length).fill(-1);
  const stack: number[] = [];
  const PAIR: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let k = 0; k < code.length; k++) {
    const c = code[k]!;
    if (c === "(" || c === "[" || c === "{") {
      around[k] = stack.length ? stack[stack.length - 1]! : -1;
      stack.push(k);
    } else if (c === ")" || c === "]" || c === "}") {
      const open = stack.pop();
      if (open === undefined || code[open] !== PAIR[c]) throw new Error(`${file}: unmatched ${c} at ${k}; teach test/lib/sql-sites.ts this file`);
      match[open] = k;
      match[k] = open;
      around[k] = stack.length ? stack[stack.length - 1]! : -1;
    } else around[k] = stack.length ? stack[stack.length - 1]! : -1;
  }
  if (stack.length) throw new Error(`${file}: unclosed bracket at ${stack[0]}; teach test/lib/sql-sites.ts this file`);
  return { match, around };
}

/** The tag before a backtick: `sql`, `db.write`, `tx` (generics such as `<Row[]>` skipped). */
function tagBefore(code: string[], at: number): { tag: string; tagStart: number } {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (code[j] === ">") {
    let depth = 0;
    for (; j >= 0; j--) {
      if (code[j] === ">") depth++;
      else if (code[j] === "<" && --depth === 0) { j--; break; }
    }
    while (j >= 0 && /\s/.test(code[j]!)) j--;
  }
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$.]/.test(code[k]!)) k--;
  return { tag: code.slice(k + 1, j + 1).join(""), tagStart: k + 1 };
}

/** The bracket closing the one at `at` in a short text (a parameter, an expression), or -1. */
export function closeIn(text: string, at: number): number {
  const open = text[at]!;
  const close = ({ "(": ")", "[": "]", "{": "}" } as Record<string, string>)[open];
  if (!close) return -1;
  let depth = 0;
  for (let k = at; k < text.length; k++) {
    if (text[k] === open) depth++;
    else if (text[k] === close && --depth === 0) return k;
  }
  return -1;
}

/**
 * `text` split at its top-level commas. A `<` written against a name, as a type argument
 * is (`Map<string, number>`, `Context<Env, "/v1">`), opens a bracket too, and its `>` closes
 * it: a comparison is written with spaces around it.
 */
export function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angles = 0;
  let current = "";
  for (let k = 0; k < text.length; k++) {
    const c = text[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "<" && k > 0 && /[\w$]/.test(text[k - 1]!)) angles++;
    else if (c === ">" && angles > 0 && text[k - 1] !== "=") angles--;
    if (c === "," && depth === 0 && angles === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  return parts;
}

/** The SQL a template holds, each `${}` as `\u0000n\u0000`, and the source of each `${}`. */
export function sqlOf(s: Source, t: Template): { text: string; exprs: { text: string; at: number }[] } {
  let text = "";
  let from = t.start + 1;
  const exprs: { text: string; at: number }[] = [];
  for (const e of t.exprs) {
    text += s.src.slice(from, e.start - 2) + `\u0000${exprs.length}\u0000`;
    exprs.push({ text: s.src.slice(e.start, e.end), at: e.start });
    from = e.end + 1;
  }
  text += s.src.slice(from, t.end - 1);
  return { text, exprs };
}

/** SQL with its quoted literals emptied, its comments removed and its parts left out: what it names itself. */
export function ownWords(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\u0000\d+\u0000/g, " ");
}

/** A statement's parts, in order: a quoted literal, a comment, a quoted name, or the rest. */
const SQL_PART = /'(?:[^']|'')*'?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"]|"")*"?|[^'"\-/]+|[\s\S]/g;

/** Where a FROM or USING list ends, at its own depth. */
const LIST_END = /^(?:where|group|having|window|order|limit|offset|fetch|for|union|intersect|except|returning|select|values|set|do|on\s+conflict)(?![\w$])/;

/**
 * A statement as the api role's search path (pg_catalog, schellingaf, pg_temp) reads it,
 * written so the guards read it too: outside its quoted literals and comments in lower
 * case, a quoted lower-case name unquoted, and `schellingaf.` before each of `relations`
 * it names without the schema, where FROM, JOIN, UPDATE, INTO, USING or TABLE names one or
 * a FROM or USING list's comma does, and before each of `functions` it calls without the
 * schema. A name the statement's own WITH defines is that query's. So `FROM Memberships m`
 * reads as `from schellingaf.memberships m`.
 */
export function qualified(sql: string, relations: ReadonlySet<string>, functions: ReadonlySet<string>): string {
  // The same text twice, of one length: as the guards read it, and with its literals and
  // comments blanked, where its words are found.
  let text = "";
  let blank = "";
  for (const [part] of sql.matchAll(SQL_PART)) {
    if (part.startsWith("'")) {
      text += part;
      blank += part.replace(/[\s\S]/g, (c, k: number) => (k === 0 || (k === part.length - 1 && c === "'") ? c : " "));
    } else if (part.startsWith("--") || part.startsWith("/*")) {
      text += part;
      blank += part.replace(/[^\n]/g, " ");
    } else {
      const name = part.match(/^"([a-z_][a-z0-9_$]*)"$/);
      const read = name ? name[1]! : part.startsWith('"') ? part : part.toLowerCase();
      text += read;
      blank += read;
    }
  }
  const ctes = new Set([...blank.matchAll(/(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_][a-z0-9_$]*)\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/g)].map((m) => m[1]!));
  const at = new Set<number>();
  const relation = (name: string, pos: number) => {
    if (relations.has(name) && !ctes.has(name)) at.add(pos);
  };
  const distinct = (pos: number) => /\bdistinct\s+$/.test(blank.slice(0, pos));
  for (const m of blank.matchAll(/(?<![\w$.])(from|join|update|into|using|table)\s+(?:only\s+)?([a-z_][a-z0-9_$]*)(?![\w$])(?!\s*\.)/g)) {
    const name = m[2]!;
    const pos = m.index! + m[0].length - name.length;
    // A function in FROM is a call; INTO's relation may be followed by its columns.
    if ((m[1] !== "into" && /^\s*\(/.test(blank.slice(pos + name.length))) || (m[1] === "from" && distinct(m.index!))) continue;
    relation(name, pos);
  }
  // Each item of a FROM or USING list after its first.
  for (const m of blank.matchAll(/(?<![\w$.])(from|using)(?![\w$])/g)) {
    if (m[1] === "from" && distinct(m.index!)) continue;
    let depth = 0;
    for (let k = m.index! + m[0].length; k < blank.length; k++) {
      const c = blank[k]!;
      if (c === "(") depth++;
      else if (c === ")") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && c === ";") break;
      else if (depth === 0 && /[a-z]/.test(c) && !/[\w$.]/.test(blank[k - 1] ?? "") && LIST_END.test(blank.slice(k))) break;
      else if (depth === 0 && c === ",") {
        const item = blank.slice(k + 1).match(/^\s*(?:lateral\s+|only\s+)?([a-z_][a-z0-9_$]*)(?![\w$])(?!\s*[.(])/);
        if (item) relation(item[1]!, k + 1 + item[0].length - item[1]!.length);
      }
    }
  }
  for (const m of blank.matchAll(/(?<![\w$.])([a-z_][a-z0-9_$]*)\s*\(/g)) {
    if (functions.has(m[1]!)) at.add(m.index!);
  }
  let out = "";
  let from = 0;
  for (const pos of [...at].sort((a, b) => a - b)) {
    out += text.slice(from, pos) + "schellingaf.";
    from = pos;
  }
  return out + text.slice(from);
}

export function lineOf(s: Source, at: number): number {
  let line = 1;
  for (let k = 0; k < at && k < s.src.length; k++) if (s.src.charCodeAt(k) === 10) line++;
  return line;
}

export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

// ── bindings ────────────────────────────────────────────────────────────────

/** A function: arrow, declaration or method, with its parameters and the extent of its body. */
export type Fn = {
  file: string;
  /** The parameter list's opening bracket, or the single parameter's first character. */
  open: number;
  params: Param[];
  bodyStart: number;
  bodyEnd: number;
  /** Its name, for a declaration, a method or `const name = (...) =>`. */
  name: string | null;
  /** Where that name is written. */
  nameAt: number;
  exported: boolean;
  kind: "arrow" | "function" | "method";
};
/** A parameter: its position, and for one destructured, the property it takes. */
export type Param = { name: string; index: number; property: string | null };

/** A const, let or var, a name destructured by one, or an import. */
export type Decl = {
  file: string;
  name: string;
  at: number;
  /** The initializer's extent in the source; null for an import or a declaration without one. */
  init: { start: number; end: number } | null;
  /** The property a destructured name takes from the initializer; "[]" for an array element. */
  property: string | null;
  scopeStart: number;
  scopeEnd: number;
  reassigned: boolean;
  /** For an import: the file and the name it exports. */
  imported: { file: string; name: string } | null;
};

const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "new", "async", "of", "in", "do", "else", "with", "super", "constructor"]);

type Binding = { param: { fn: Fn; param: Param } } | { decl: Decl } | { fn: Fn };

/** What a set of files binds: their functions and their declarations, worked out once. */
export class Program {
  readonly sources = new Map<string, Source>();
  private readonly fns = new Map<string, Fn[]>();
  private readonly decls = new Map<string, Decl[]>();

  /** `read` is for a guard's own test, which reads files that exist nowhere but in it. */
  constructor(files: string[], read: (file: string) => string = (file) => readFileSync(file, "utf8")) {
    for (const file of files) this.sources.set(file, lex(read(file), file));
    for (const [file, s] of this.sources) {
      this.fns.set(file, functionsOf(s));
      this.decls.set(file, declarationsOf(s, (spec) => this.resolveModule(file, spec)));
    }
  }

  functions(file: string): Fn[] {
    return this.fns.get(file) ?? [];
  }

  declarations(file: string): Decl[] {
    return this.decls.get(file) ?? [];
  }

  resolveModule(from: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null;
    const target = path.resolve(path.dirname(from), spec);
    return this.sources.has(target) ? target : null;
  }

  /** The innermost binding of `name` in scope at `at`: a parameter, a declaration or a function's name. */
  bindingOf(file: string, name: string, at: number): Binding | null {
    const s = this.sources.get(file)!;
    let best: { width: number; binding: Binding } | null = null;
    const offer = (width: number, binding: Binding) => {
      if (!best || width < best.width) best = { width, binding };
    };
    for (const fn of this.functions(file)) {
      if (at < fn.open || at > fn.bodyEnd) continue;
      const param = fn.params.find((p) => p.name === name);
      if (param) offer(fn.bodyEnd - fn.open, { param: { fn, param } });
    }
    for (const decl of this.declarations(file)) {
      if (decl.name === name && decl.scopeStart <= at && at <= decl.scopeEnd) offer(decl.scopeEnd - decl.scopeStart, { decl });
    }
    for (const fn of this.functions(file)) {
      if (fn.name !== name || fn.kind !== "function") continue;
      const scope = scopeAround(s, fn.nameAt);
      if (scope.start <= at && at <= scope.end) offer(scope.end - scope.start, { fn });
    }
    return best === null ? null : (best as { binding: Binding }).binding;
  }

  /** The function a name names at `at`: a declaration, a const holding an arrow, or an import of either. */
  functionNamed(file: string, name: string, at: number): Fn | null {
    const b = this.bindingOf(file, name, at);
    if (!b) return null;
    if ("fn" in b) return b.fn;
    if ("decl" in b) {
      const d = b.decl;
      if (d.imported) return this.functions(d.imported.file).find((f) => f.name === d.imported!.name && f.exported && f.kind !== "method") ?? null;
      if (d.init && d.property === null) return this.functions(file).find((f) => f.kind === "arrow" && f.name === name && f.nameAt === d.at) ?? null;
    }
    return null;
  }

  /**
   * Every call of `fn`: in its own scope, and in each file importing it, under the name it
   * is imported as. `escapes` lists where its name is used other than called, so somebody
   * else may call it with arguments this cannot see.
   */
  callsOf(fn: Fn): { calls: { file: string; open: number; args: { text: string; at: number }[] }[]; escapes: string[] } {
    const calls: { file: string; open: number; args: { text: string; at: number }[] }[] = [];
    const escapes: string[] = [];
    if (fn.kind === "method" || !fn.name) return { calls, escapes: ["a method or an unnamed function"] };
    const home = this.sources.get(fn.file)!;
    const scope = scopeAround(home, fn.nameAt);
    const sites: { file: string; name: string; start: number; end: number }[] = [{ file: fn.file, name: fn.name, start: scope.start, end: scope.end }];
    if (fn.exported) {
      for (const [file, s] of this.sources) {
        for (const d of this.declarations(file)) {
          if (d.imported && d.imported.file === fn.file && d.imported.name === fn.name) sites.push({ file, name: d.name, start: 0, end: s.code.length });
        }
      }
    }
    for (const site of sites) {
      const s = this.sources.get(site.file)!;
      const { code } = s;
      for (const m of code.matchAll(new RegExp(`(?<![A-Za-z0-9_$.])${site.name.replace(/\$/g, "\\$")}(?![A-Za-z0-9_$])`, "g"))) {
        const at = m.index!;
        if (at < site.start || at > site.end) continue;
        if (s.imports.some((r) => r.start <= at && at < r.end)) continue;
        if (this.functionNamed(site.file, site.name, at) !== fn) continue;
        const before = code.slice(Math.max(0, at - 40), at);
        if (/(function\s*\*?\s*|(const|let|var)\s+)$/.test(before)) continue;
        const rest = code.slice(at + site.name.length, at + site.name.length + 200);
        const call = rest.match(/^\s*(?:<[^()]*?>\s*)?\(/);
        if (call) {
          const open = at + site.name.length + call[0].length - 1;
          calls.push({ file: site.file, open, args: argsOf(s, open) });
          continue;
        }
        escapes.push(`${path.basename(site.file)}:${lineOf(s, at)}`);
      }
    }
    return { calls, escapes };
  }
}

/** The arguments of the call whose bracket opens at `open`, with their positions. */
export function argsOf(s: Source, open: number): { text: string; at: number }[] {
  const close = s.match[open]!;
  let from = open + 1;
  const args: { text: string; at: number }[] = [];
  for (const part of splitTop(s.code.slice(open + 1, close))) {
    args.push({ text: s.src.slice(from, from + part.length), at: from });
    from += part.length + 1;
  }
  if (args.length === 1 && args[0]!.text.trim() === "") args.pop();
  return args;
}

/** The block a name declared at `at` is visible in: the innermost `{}` around it, or the file. */
export function scopeAround(s: Source, at: number): { start: number; end: number } {
  let k = s.around[at]!;
  while (k >= 0 && s.code[k] !== "{") k = s.around[k]!;
  if (k < 0) return { start: 0, end: s.code.length };
  return { start: k, end: s.match[k]! };
}

/** Skip whitespace forwards from `at`. */
function skip(code: string, at: number): number {
  while (at < code.length && /\s/.test(code[at]!)) at++;
  return at;
}

const TYPE_WORDS = new Set(["is", "extends", "keyof", "typeof", "infer", "asserts", "readonly", "unique"]);

/**
 * The end of a type annotation that starts at `at` (just after its colon): where the first
 * thing that is not type begins, the `{` of a body, an arrow, `=`, `,`, `;` or a closing bracket.
 */
function typeEnd(s: Source, at: number): number {
  const { code, src } = s;
  let expectTerm = true;
  let k = at;
  for (;;) {
    k = skip(code, k);
    const c = code[k];
    if (c === undefined) return k;
    if (code.startsWith("=>", k)) return k;
    // A string literal type, blanked in code, is a term.
    if (src[k] === '"' || src[k] === "'") {
      if (!expectTerm) return k;
      const quote = src[k]!;
      k++;
      while (k < src.length && src[k] !== quote) k += src[k] === "\\" ? 2 : 1;
      k++;
      expectTerm = false;
      continue;
    }
    if (c === "{") {
      if (!expectTerm) return k;
      k = s.match[k]! + 1;
      expectTerm = false;
      continue;
    }
    if (c === "(" || c === "[") {
      if (c === "(" && !expectTerm) return k;
      k = s.match[k]! + 1;
      // `(a: T) => U` as a type: its arrow continues the type.
      const after = skip(code, k);
      if (c === "(" && code.startsWith("=>", after)) {
        k = after + 2;
        expectTerm = true;
        continue;
      }
      expectTerm = false;
      continue;
    }
    if (c === "<") {
      let depth = 0;
      for (; k < code.length; k++) {
        if (code[k] === "<") depth++;
        else if (code[k] === ">" && code[k - 1] !== "=" && --depth === 0) break;
      }
      k++;
      expectTerm = false;
      continue;
    }
    if (c === "|" || c === "&" || c === ".") {
      k++;
      expectTerm = true;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = k;
      while (j < code.length && /[A-Za-z0-9_$]/.test(code[j]!)) j++;
      const word = code.slice(k, j);
      if (!expectTerm && !TYPE_WORDS.has(word)) return k;
      k = j;
      expectTerm = TYPE_WORDS.has(word);
      continue;
    }
    return k;
  }
}

/** The parameters in the list between `open` and `close`. */
function paramsOf(code: string, open: number, close: number): Param[] {
  const params: Param[] = [];
  splitTop(code.slice(open + 1, close)).forEach((raw, index) => {
    const part = raw.trim().replace(/^\.\.\./, "");
    if (part === "") return;
    if (part.startsWith("{")) {
      for (const piece of splitTop(part.slice(1, closeIn(part, 0)))) {
        const pm = piece.trim().replace(/^\.\.\./, "").match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/);
        if (pm) params.push({ name: pm[2] ?? pm[1]!, index, property: pm[1]! });
      }
      return;
    }
    if (part.startsWith("[")) return;
    const pm = part.match(/^([A-Za-z_$][\w$]*)/);
    if (pm) params.push({ name: pm[1]!, index, property: null });
  });
  return params;
}

/** The end of an arrow's expression body that starts at `at`. */
function expressionEnd(code: string, at: number): number {
  let depth = 0;
  for (let k = at; k < code.length; k++) {
    const c = code[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return k;
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return k;
  }
  return code.length;
}

/** Every function of a file. */
function functionsOf(s: Source): Fn[] {
  const { code } = s;
  const out: Fn[] = [];
  for (let open = code.indexOf("("); open >= 0; open = code.indexOf("(", open + 1)) {
    const close = s.match[open]!;
    let after = skip(code, close + 1);
    if (code[after] === ":") after = skip(code, typeEnd(s, after + 1));
    const window = Math.max(0, open - 200);
    const before = code.slice(window, open);
    if (code.startsWith("=>", after)) {
      const bodyAt = skip(code, after + 2);
      const bodyEnd = code[bodyAt] === "{" ? s.match[bodyAt]! : expressionEnd(code, bodyAt);
      const named = before.match(/(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?(?:<[^()]*>\s*)?$/);
      out.push({
        file: s.file, open, params: paramsOf(code, open, close), bodyStart: bodyAt, bodyEnd,
        name: named ? named[2]! : null,
        nameAt: named ? window + named.index! + named[0].indexOf(named[2]!, (named[1] ?? "").length + 3) : open,
        exported: Boolean(named?.[1]),
        kind: "arrow",
      });
      continue;
    }
    if (code[after] !== "{") continue;
    const decl = before.match(/(export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/);
    if (decl) {
      out.push({
        file: s.file, open, params: paramsOf(code, open, close), bodyStart: after, bodyEnd: s.match[after]!,
        name: decl[2]!, nameAt: window + decl.index! + decl[0].lastIndexOf(decl[2]!), exported: Boolean(decl[1]), kind: "function",
      });
      continue;
    }
    // A method: a name, not a keyword, before the list, in an object literal or a class.
    const method = before.match(/(?:^|[\s{},;])(?:(?:async|static|get|set|private|public|protected|readonly)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/);
    if (method && !NOT_A_NAME.has(method[1]!)) {
      out.push({
        file: s.file, open, params: paramsOf(code, open, close), bodyStart: after, bodyEnd: s.match[after]!,
        name: method[1]!, nameAt: open, exported: false, kind: "method",
      });
    }
  }
  // One parameter without brackets: `sql => ...`, `async tx => ...`.
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
    const name = m[1]!;
    if (NOT_A_NAME.has(name)) continue;
    const at = m.index!;
    const bodyAt = skip(code, at + m[0].length);
    const bodyEnd = code[bodyAt] === "{" ? s.match[bodyAt]! : expressionEnd(code, bodyAt);
    out.push({
      file: s.file, open: at, params: [{ name, index: 0, property: null }],
      bodyStart: bodyAt, bodyEnd, name: null, nameAt: at, exported: false, kind: "arrow",
    });
  }
  return out;
}

/** Every const, let, var and import of a file. */
function declarationsOf(s: Source, resolve: (spec: string) => string | null): Decl[] {
  const { code, src } = s;
  const out: Decl[] = [];
  for (const m of code.matchAll(/(?<![\w$.])(const|let|var)\s+/g)) {
    const at = m.index!;
    const first = at + m[0].length;
    const scope = scopeAround(s, at);
    const end = statementEnd(code, first);
    let declarator = first;
    for (const part of splitTop(code.slice(first, end))) {
      const start = declarator + (part.length - part.trimStart().length);
      declarator += part.length + 1;
      const eq = topLevelEquals(part);
      const target = (eq < 0 ? part : part.slice(0, eq)).trim();
      const init = eq < 0 ? null : { start: start - (part.length - part.trimStart().length) + eq + 1, end: start - (part.length - part.trimStart().length) + part.length };
      const push = (name: string, property: string | null, nameAt: number) => {
        const again = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}\\s*(?:=(?![=>])|\\+=|-=|\\+\\+|--)`);
        out.push({
          file: s.file, name, at: nameAt, init, property, scopeStart: scope.start, scopeEnd: scope.end,
          reassigned: m[1] !== "const" && again.test(code.slice(init?.end ?? start, scope.end)), imported: null,
        });
      };
      if (target.startsWith("{") || target.startsWith("[")) {
        const close = closeIn(target, 0);
        for (const piece of splitTop(target.slice(1, close))) {
          const p = piece.trim().replace(/^\.\.\./, "");
          const pm = p.match(/^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/);
          if (!pm) continue;
          const name = target.startsWith("[") ? pm[1]! : (pm[2] ?? pm[1]!);
          push(name, target.startsWith("[") ? "[]" : pm[1]!, start);
        }
      } else {
        const pm = target.match(/^([A-Za-z_$][\w$]*)/);
        if (pm) push(pm[1]!, null, start);
      }
    }
  }
  for (const m of src.matchAll(/^[ \t]*import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm)) {
    if (m[1]) continue;
    const file = resolve(m[3]!);
    if (!file) continue;
    for (const piece of m[2]!.split(",")) {
      const p = piece.trim();
      if (p === "" || p.startsWith("type ")) continue;
      const pm = p.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!pm) continue;
      out.push({
        file: s.file, name: pm[2] ?? pm[1]!, at: m.index!, init: null, property: null,
        scopeStart: 0, scopeEnd: code.length, reassigned: false, imported: { file, name: pm[1]! },
      });
    }
  }
  return out;
}

function statementEnd(code: string, at: number): number {
  let depth = 0;
  for (let k = at; k < code.length; k++) {
    const c = code[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) return k;
      depth--;
    } else if (c === ";" && depth === 0) return k;
  }
  return code.length;
}

/** Where a declarator's own `=` is: the first at the top level that is no comparison and no arrow. */
function topLevelEquals(part: string): number {
  let depth = 0;
  for (let k = 0; k < part.length; k++) {
    const c = part[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "<" && depth >= 0) depth++;
    else if (c === ">" && part[k - 1] !== "=") depth--;
    else if (c === "=" && depth === 0 && !"=>".includes(part[k + 1] ?? "") && !"=!<>".includes(part[k - 1] ?? "")) return k;
  }
  return -1;
}

// ── where a value comes from ────────────────────────────────────────────────

/**
 * What a value is, as far as the guards care:
 * - `readTx`: the transaction db.readTx hands its callback, with the caller bound;
 * - `pool`: one of the service's pools (`db.write`, `db.read`), a connection reserved from
 *   one, or a transaction begun on one, where no caller is bound;
 * - `holder`: a value whose `peerId` is a KEY the request proved it holds;
 * - `key`: that KEY itself, as bytes or as hex;
 * - `objects`: one object literal or several, for a property read off them;
 * - `unknown`: anything else, and why.
 */
export type Value =
  | { kind: "readTx" }
  | { kind: "pool"; name: string }
  | { kind: "holder"; how: string }
  | { kind: "key"; how: string }
  | { kind: "objects"; items: { file: string; start: number; end: number; trail: string[] }[] }
  | { kind: "unknown"; why: string };

export type Traced = { value: Value; trail: string[] };

/** Functions whose answer is a KEY the request proved it holds, and how it proved it. */
export const AUTHENTICATED: Record<string, { kind: "holder" | "key"; how: string }> = {
  requireBearer: { kind: "holder", how: "the request's valid token (requireBearer)" },
  optionalBearer: { kind: "key", how: "the request's valid token, or none (optionalBearer)" },
  requireUploader: { kind: "holder", how: "the request's valid token, or an upload authorization a token of its KEY asked for (requireUploader in files.ts)" },
  verifyChallenge: { kind: "holder", how: "a KEY that signed this request's challenge (verifyChallenge)" },
};

const MAX_DEPTH = 14;

const unknown = (why: string, trail: string[] = []): Traced => ({ value: { kind: "unknown", why }, trail });

/** Follows values through a Program. */
export class Tracer {
  readonly program: Program;
  constructor(program: Program) {
    this.program = program;
  }

  /** Where the value of expression `text`, written at `at` in `file`, comes from. */
  valueOf(file: string, text: string, at: number, depth = 0): Traced {
    const shown = text.replace(/\s+/g, " ").trim().slice(0, 80);
    if (depth > MAX_DEPTH) return unknown("followed too far", [shown]);
    let e = text.trim();
    let offset = at + (text.length - text.trimStart().length);
    // What changes nothing about where a value comes from: await, a non-null mark, a cast.
    for (;;) {
      const before = e;
      if (e.startsWith("await ")) {
        offset += e.length - e.slice(6).trimStart().length;
        e = e.slice(6).trimStart();
      }
      e = e.replace(/!$/, "").replace(/\s+as\s+[\w$.<>[\]\s|"]+$/, "").trim();
      if (e.startsWith("(") && closeIn(e, 0) === e.length - 1) {
        offset += 1;
        e = e.slice(1, -1).trim();
      }
      if (e === before) break;
    }
    const step = (t: Traced): Traced => ({ value: t.value, trail: [shown, ...t.trail] });
    let m: RegExpMatchArray | null;
    if (e === "null" || e === "undefined") return unknown("null", [shown]);
    if (/^db\.(write|read)$/.test(e)) return { value: { kind: "pool", name: e }, trail: [e] };
    if ((m = e.match(/^[A-Za-z_$][\w$]*$/))) return step(this.identifier(file, e, offset, depth));
    if ((m = e.match(/^([\s\S]+)\.reserve\(\s*\)$/))) {
      const base = this.valueOf(file, m[1]!, offset, depth + 1);
      if (base.value.kind === "pool") return step({ value: { kind: "pool", name: `${base.value.name}.reserve()` }, trail: base.trail });
      return step(base);
    }
    if ((m = e.match(/^toHex\(([\s\S]+)\)$/)) && closeIn(e, 5) === e.length - 1) {
      const inner = this.valueOf(file, m[1]!, offset + 6, depth + 1);
      return step(inner.value.kind === "key" ? inner : unknown(`toHex of ${describe(inner.value)}`, inner.trail));
    }
    if ((m = e.match(/^([A-Za-z_$][\w$]*)\s*\(/)) && closeIn(e, e.indexOf("(")) === e.length - 1) {
      const name = m[1]!;
      const known = AUTHENTICATED[name];
      if (known && this.importedAs(file, name, offset) === name) return { value: { kind: known.kind, how: known.how }, trail: [shown] };
      const fn = this.program.functionNamed(file, name, offset);
      if (!fn) return unknown(`a call of ${name}, which is not followed`, [shown]);
      return step(this.returnOf(fn, depth + 1));
    }
    if ((m = e.match(/^([\s\S]+)\.([A-Za-z_$][\w$]*)$/)) && !/[^\w$.)\]]/.test(m[1]!.replace(/\([^()]*\)|\[[^[\]]*\]/g, ""))) {
      const base = this.valueOf(file, m[1]!, offset, depth + 1);
      return step(this.property(base, m[2]!, depth + 1));
    }
    if (e.startsWith("{") && closeIn(e, 0) === e.length - 1) {
      return { value: { kind: "objects", items: [{ file, start: offset, end: offset + e.length, trail: [shown] }] }, trail: [shown] };
    }
    const branches = branchesOf(e);
    if (branches) {
      const values = branches.map((b) => this.valueOf(file, b.text, offset + b.at, depth + 1));
      // A branch that is null passes no KEY and no pool: the others decide.
      const kept = values.filter((v) => !(v.value.kind === "unknown" && v.value.why === "null"));
      return step(agree(kept.length ? kept : values));
    }
    return unknown(`the expression ${shown}`, [shown]);
  }

  /** The name a file imports `name` from src as, when it imports it, else null. */
  private importedAs(file: string, name: string, at: number): string | null {
    const b = this.program.bindingOf(file, name, at);
    if (b && "decl" in b && b.decl.imported) return b.decl.imported.name;
    if (b && "fn" in b && b.fn.name === name) return name;
    return null;
  }

  /** A property read off a value. */
  private property(base: Traced, name: string, depth: number): Traced {
    const v = base.value;
    if (v.kind === "holder" && name === "peerId") return { value: { kind: "key", how: v.how }, trail: base.trail };
    if (v.kind === "objects") return agree(v.items.map((item) => this.propertyOfLiteral(item, name, depth)));
    if (v.kind === "unknown") return base;
    return unknown(`the property ${name} of ${describe(v)}`, base.trail);
  }

  private propertyOfLiteral(item: { file: string; start: number; end: number; trail: string[] }, name: string, depth: number): Traced {
    const s = this.program.sources.get(item.file)!;
    let from = item.start + 1;
    const spreads: { text: string; at: number }[] = [];
    for (const part of splitTop(s.code.slice(item.start + 1, item.end - 1))) {
      const text = s.src.slice(from, from + part.length);
      const at = from;
      from += part.length + 1;
      const lead = text.length - text.trimStart().length;
      const t = text.trim();
      if (t.startsWith("...")) {
        spreads.push({ text: t.slice(3), at: at + lead + 3 });
        continue;
      }
      const pm = t.match(/^([A-Za-z_$][\w$]*)\s*(:)?/);
      if (!pm || pm[1] !== name) continue;
      const got = pm[2] ? this.valueOf(item.file, text.slice(text.indexOf(":") + 1), at + text.indexOf(":") + 1, depth + 1) : this.valueOf(item.file, name, at + lead, depth + 1);
      return { value: got.value, trail: [...item.trail, `.${name}`, ...got.trail] };
    }
    for (const spread of spreads.reverse()) {
      const got = this.property(this.valueOf(item.file, spread.text, spread.at, depth + 1), name, depth + 1);
      if (got.value.kind !== "unknown") return { value: got.value, trail: [...item.trail, `...${spread.text.trim()}`, ...got.trail] };
    }
    return unknown(`no property ${name} in the object`, item.trail);
  }

  /** What a function returns: every return must agree. */
  private returnOf(fn: Fn, depth: number): Traced {
    const s = this.program.sources.get(fn.file)!;
    const exprs: { text: string; at: number }[] = [];
    if (s.code[fn.bodyStart] !== "{") exprs.push({ text: s.src.slice(fn.bodyStart, fn.bodyEnd), at: fn.bodyStart });
    else {
      for (const m of s.code.slice(fn.bodyStart, fn.bodyEnd).matchAll(/(?<![\w$.])return\b/g)) {
        const at = fn.bodyStart + m.index!;
        // Only this function's own returns, not those of a function inside it.
        if (this.program.functions(fn.file).some((g) => g !== fn && g.bodyStart > fn.bodyStart && g.bodyStart <= at && at <= g.bodyEnd)) continue;
        const start = at + "return".length;
        exprs.push({ text: s.src.slice(start, statementEnd(s.code, start)), at: start });
      }
    }
    const where = `${fn.name ?? "a function"} (${path.basename(fn.file)}:${lineOf(s, fn.open)}) returns`;
    if (exprs.length === 0) return unknown(`${fn.name ?? "a function"} returns nothing`, [where]);
    const together = agree(exprs.map((x) => this.valueOf(fn.file, x.text, x.at, depth + 1)));
    return { value: together.value, trail: [where, ...together.trail] };
  }

  /** What a name holds at `at`. */
  private identifier(file: string, name: string, at: number, depth: number): Traced {
    const b = this.program.bindingOf(file, name, at);
    if (!b) return unknown(`${name} is bound nowhere this reader sees`);
    if ("decl" in b) {
      const d = b.decl;
      if (d.imported) return unknown(`${name} is imported, and not followed as a value`);
      if (d.reassigned) return unknown(`${name} is assigned again`);
      if (!d.init) return unknown(`${name} has no initializer`);
      const s = this.program.sources.get(file)!;
      const init = this.valueOf(file, s.src.slice(d.init.start, d.init.end), d.init.start, depth + 1);
      if (d.property === null) return init;
      if (d.property === "[]") return unknown(`${name} is an element of an array`, init.trail);
      return this.property(init, d.property, depth + 1);
    }
    if ("fn" in b) return unknown(`${name} is a function`);
    return this.parameter(b.param.fn, b.param.param, depth);
  }

  /** What a parameter holds: what every caller passes in its place. */
  private parameter(fn: Fn, param: Param, depth: number): Traced {
    const s = this.program.sources.get(fn.file)!;
    const step = `parameter ${param.name} of ${fn.name ?? "an arrow"} (${path.basename(fn.file)}:${lineOf(s, fn.open)})`;
    const own = (t: Traced): Traced => {
      const got = param.property === null ? t : this.property(t, param.property, depth + 1);
      return { value: got.value, trail: [step, ...got.trail] };
    };
    if (fn.kind === "arrow" && fn.name === null) {
      // An arrow passed straight to a call: the callee decides what it is given.
      const open = s.around[fn.open]!;
      if (open < 0 || s.code[open] !== "(") return unknown(`${step}: not an argument of a call`);
      const callee = calleeBefore(s.code, open);
      const position = splitTop(s.code.slice(open + 1, fn.open)).length - 1;
      if (/(^|\.)readTx$/.test(callee)) {
        if (position === 1 && param.index === 0 && param.property === null) return { value: { kind: "readTx" }, trail: [`${callee}(…, (${param.name}) =>`] };
        return unknown(`${step}: readTx hands its callback one parameter`);
      }
      const tx = callee.match(/^(.+)\.(begin|savepoint)$/);
      if (tx) {
        if (param.index !== 0) return unknown(`${step}: ${callee} hands its callback one parameter`);
        const base = this.valueOf(fn.file, tx[1]!, open - callee.length, depth + 1);
        const v = base.value.kind === "pool" ? { kind: "pool" as const, name: `${base.value.name}.${tx[2]}` } : base.value;
        return { value: v, trail: [`${callee}((${param.name}) =>`, ...base.trail] };
      }
      const target = /^[A-Za-z_$][\w$]*$/.test(callee) ? this.program.functionNamed(fn.file, callee, open) : null;
      if (!target) return unknown(`${step}: passed to ${callee || "an expression"}, which is not followed`);
      const slot = target.params.find((p) => p.index === position && p.property === null);
      if (!slot) return unknown(`${step}: ${callee} takes no parameter ${position}`);
      // Every call the callee makes of the function it was handed.
      const ts = this.program.sources.get(target.file)!;
      const values: Traced[] = [];
      for (const call of ts.code.slice(target.bodyStart, target.bodyEnd).matchAll(new RegExp(`(?<![\\w$.])${slot.name}(?![\\w$])`, "g"))) {
        const at = target.bodyStart + call.index!;
        const b = this.program.bindingOf(target.file, slot.name, at);
        if (!b || !("param" in b) || b.param.fn !== target) continue;
        const paren = ts.code.slice(at + slot.name.length).match(/^\s*\(/);
        if (!paren) {
          values.push(unknown(`${callee} passes ${slot.name} on (${path.basename(target.file)}:${lineOf(ts, at)})`));
          continue;
        }
        const args = argsOf(ts, at + slot.name.length + paren[0].length - 1);
        const arg = args[param.index];
        if (!arg) {
          values.push(unknown(`${callee} calls ${slot.name} without argument ${param.index}`));
          continue;
        }
        const v = this.valueOf(target.file, arg.text, arg.at, depth + 1);
        values.push({ value: v.value, trail: [`${path.basename(target.file)}:${lineOf(ts, at)} ${slot.name}(…${arg.text.trim().slice(0, 40)}…)`, ...v.trail] });
      }
      if (values.length === 0) return unknown(`${step}: ${callee} never calls ${slot.name}`);
      return own(agree(values));
    }
    if (fn.kind === "method") return unknown(`${step}: a method's parameter, which is not followed`);
    const { calls, escapes } = this.program.callsOf(fn);
    if (escapes.length > 0) return unknown(`${step}: ${fn.name} is passed on at ${escapes.join(", ")}`);
    if (calls.length === 0) return unknown(`${step}: ${fn.name} is never called`);
    return own(
      agree(
        calls.map((call) => {
          const arg = call.args[param.index];
          const cs = this.program.sources.get(call.file)!;
          if (!arg) return unknown(`a call of ${fn.name} without argument ${param.index} (${path.basename(call.file)}:${lineOf(cs, call.open)})`);
          const v = this.valueOf(call.file, arg.text, arg.at, depth + 1);
          return { value: v.value, trail: [`${path.basename(call.file)}:${lineOf(cs, call.open)} ${fn.name}(…${arg.text.trim().slice(0, 40)}…)`, ...v.trail] };
        }),
      ),
    );
  }
}

/** The callee written before the bracket at `open`: `db.readTx`, `act`, `sql.begin`. */
function calleeBefore(code: string, open: number): string {
  let j = open - 1;
  while (j >= 0 && /\s/.test(code[j]!)) j--;
  if (code[j] === ">") {
    let depth = 0;
    for (; j >= 0; j--) {
      if (code[j] === ">") depth++;
      else if (code[j] === "<" && --depth === 0) { j--; break; }
    }
  }
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$.]/.test(code[k]!)) k--;
  return code.slice(k + 1, j + 1);
}

/** The branches of `c ? a : b` or `a ?? b` at the top level, or null. */
function branchesOf(e: string): { text: string; at: number }[] | null {
  let depth = 0;
  for (let k = 0; k < e.length; k++) {
    const c = e[k]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth === 0 && e.startsWith("??", k)) return [{ text: e.slice(0, k), at: 0 }, { text: e.slice(k + 2), at: k + 2 }];
    else if (depth === 0 && c === "?" && e[k + 1] !== ".") {
      let d = 0;
      for (let j = k + 1; j < e.length; j++) {
        const x = e[j]!;
        if ("([{".includes(x)) d++;
        else if (")]}".includes(x)) d--;
        else if (d === 0 && x === ":") return [{ text: e.slice(k + 1, j), at: k + 1 }, { text: e.slice(j + 1), at: j + 1 }];
      }
      return null;
    }
  }
  return null;
}

/** One value for many: theirs when they all agree, the objects together, or unknown. */
function agree(values: Traced[]): Traced {
  if (values.length === 0) return unknown("nothing to agree on");
  const trail = values.flatMap((v) => v.trail);
  if (values.every((v) => v.value.kind === "objects")) {
    return { value: { kind: "objects", items: values.flatMap((v) => (v.value as Extract<Value, { kind: "objects" }>).items) }, trail };
  }
  const first = values[0]!.value;
  if (first.kind !== "unknown" && values.every((v) => v.value.kind === first.kind)) return { value: first, trail };
  const unknownOne = values.find((v) => v.value.kind === "unknown");
  if (unknownOne && values.length === 1) return unknownOne;
  return unknown(`the paths disagree: ${[...new Set(values.map((v) => describe(v.value)))].join(" / ")}`, trail);
}

export function describe(v: Value): string {
  switch (v.kind) {
    case "readTx": return "readTx's transaction";
    case "pool": return `the pool ${v.name}`;
    case "holder": return `the holder of ${v.how}`;
    case "key": return `the KEY of ${v.how}`;
    case "objects": return "an object";
    case "unknown": return `unknown (${v.why})`;
  }
}
