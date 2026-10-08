// What the service sends to the database, held to the rules its privacy rests on, by
// reading src/ (test/lib/sql-sites.ts) against the migrated catalogue:
//
// - every statement that names a relation under row-level security runs inside readTx,
//   where the caller is bound, so a read of a policied table on a bare pool, which reads
//   as nobody, fails here where it is written; and so does every call of a function that
//   reads the caller, but a definer's that takes the actor, which the write pool calls;
// - only readTx binds the caller, for its transaction alone, and nothing in src sends SQL
//   as raw text; and every readTx binds the KEY the request proved it holds, or nobody;
// - a withheld or hidden post loses its words in visible_posts alone, so no statement
//   reads a word column from the post tables themselves except of the caller's own posts;
// - every SECURITY DEFINER function the api role may execute either reads the caller, or
//   takes the actor as a parameter, or is on a short list here with the reason it needs
//   neither; none treats a missing caller as somebody; and every call in src of one that
//   takes the actor passes the KEY the request proved it holds, never a field of its body,
//   query or path.
//
// Each guard reads a statement as the api role's search path does (qualified() in
// test/lib/sql-sites.ts): a relation or a function named without the schema, in capitals or
// quoted, is the one it names. Each guard is a function run twice: over src, where it must
// find nothing, and over a few files that exist only here and break its rule, where it
// must find exactly the break. So a guard that stopped seeing fails as surely as a
// statement that broke its rule.
//
// Written by the security review of 7 October 2026. A change this reader cannot follow
// fails with the path it took, to be read by a person; never passes.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";
import { Program, Tracer, argsOf, describe as said, lineOf, ownWords, qualified, sourceFiles, splitTop, sqlOf, type Source, type Template } from "./lib/sql-sites.ts";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

let fixture: Fixture;
let program: Program;
/** Relations the api role reads under row-level security: tables with it on, and views. */
let policied: Set<string>;
let functions: Fn[];

type Fn = { name: string; signature: string; definer: boolean; api: boolean; args: string[]; required: number; body: string };

const opened = setUp(async () => {
  fixture = await cloneDatabase("sec_db_access_sql");
  program = new Program(sourceFiles(SRC));
  const relations = await fixture.owner<{ relname: string }[]>`
    select c.relname from pg_class c
     where c.relnamespace = 'schellingaf'::regnamespace and (c.relrowsecurity or c.relkind = 'v')`;
  policied = new Set(relations.map((r) => r.relname));
  // Read through pg_get_functiondef: prosrc is empty for a SQL-standard body.
  const rows = await fixture.owner<{ name: string; signature: string; definer: boolean; api: boolean; args: string[] | null; modes: string[] | null; nargs: number; defaults: number; def: string }[]>`
    select p.proname as name, p.oid::regprocedure::text as signature, p.prosecdef as definer,
           has_function_privilege('schellingaf_api', p.oid, 'execute') as api,
           p.proargnames as args, p.proargmodes::text[] as modes, p.pronargs as nargs, p.pronargdefaults as defaults,
           pg_get_functiondef(p.oid) as def
      from pg_proc p where p.pronamespace = 'schellingaf'::regnamespace and p.prokind = 'f'`;
  functions = rows.map((r) => ({
    name: r.name,
    signature: r.signature,
    definer: r.definer,
    api: r.api,
    // The parameters a call passes, in order: IN, INOUT and VARIADIC, never OUT or TABLE.
    args: (r.args ?? []).filter((_, i) => r.modes === null || ["i", "b", "v"].includes(r.modes[i]!)).slice(0, r.nargs),
    required: r.nargs - r.defaults,
    body: bodyOf(r.def),
  }));
});

after(async () => {
  await opened;
  await fixture.end();
});

/** A function's body, without its header or its comments, so a comment naming a helper calls nothing. */
function bodyOf(def: string): string {
  const at = def.search(/\n(AS |BEGIN ATOMIC|RETURN )/);
  return (at < 0 ? def : def.slice(at)).replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The relations a statement names itself (not those of the fragments it interpolates). */
function namedRelations(sql: string): string[] {
  return [...new Set([...ownWords(sql).matchAll(/schellingaf\.([a-z_][a-z0-9_]*)\b(?!\s*\()/g)].map((m) => m[1]!))];
}

/**
 * Every call `schellingaf.f(...)` in a statement, outside its comments and quoted literals:
 * the function, and its arguments as the statement writes them.
 */
function callsIn(sql: string): { name: string; args: string[] }[] {
  // The same length as the statement, with comments and the inside of literals blanked,
  // so a position in one is a position in the other.
  const words = sql
    .replace(/--[^\n]*/g, (c) => " ".repeat(c.length))
    .replace(/'(?:[^']|'')*'/g, (l) => `'${" ".repeat(l.length - 2)}'`);
  const out: { name: string; args: string[] }[] = [];
  for (const m of words.matchAll(/schellingaf\.([a-z_][a-z0-9_]*)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let k = open; k < words.length; k++) {
      if (words[k] === "(") depth++;
      else if (words[k] === ")" && --depth === 0) { close = k; break; }
    }
    const args: string[] = [];
    let from = open + 1;
    for (const part of splitTop(words.slice(open + 1, close))) {
      args.push(sql.slice(from, from + part.length));
      from += part.length + 1;
    }
    out.push({ name: m[1]!, args: args.length === 1 && args[0]!.trim() === "" ? [] : args });
  }
  return out;
}

const NONE: ReadonlySet<string> = new Set();

/** The `${}` parts an SQL argument carries. */
const holesOf = (arg: string) => [...arg.matchAll(/\u0000(\d+)\u0000/g)].map((h) => Number(h[1]));

/** A position as a person finds it: the file under `root`, and the line. */
const at = (root: string, s: Source, pos: number) => `${path.relative(root, s.file)}:${lineOf(s, pos)}`;

// ── the guards over sources ─────────────────────────────────────────────────

/** Files that send SQL on a connection they open themselves, never the service's pools, and why. */
const OPERATOR_TOOLS: Record<string, string> = {
  "db/recover.ts":
    "the restore runbook's step 5, run by hand as the migration role, which assumes the owner " +
    "(set role schellingaf_owner) on a connection of its own; the service never imports it",
};

/** Every statement naming a policied relation that does not run inside readTx. */
function readsOutsideReadTx(p: Program, root: string, relations: Set<string>): { failures: string[]; checked: number } {
  const tracer = new Tracer(p);
  const failures: string[] = [];
  let checked = 0;
  for (const [file, s] of p.sources) {
    if (path.relative(root, file) in OPERATOR_TOOLS) continue;
    for (const t of s.templates) {
      const named = namedRelations(qualified(sqlOf(s, t).text, relations, NONE)).filter((r) => relations.has(r));
      if (named.length === 0) continue;
      checked++;
      const v = tracer.valueOf(file, t.tag, t.tagStart);
      if (v.value.kind !== "readTx") failures.push(`${at(root, s, t.start)} reads ${named.join(", ")} on ${said(v.value)}:\n    ${v.trail.join("\n    ")}`);
    }
  }
  return { failures, checked };
}

/** set_config(), which callsIn() reads as the schema's own to find it. */
const SET_CONFIG: ReadonlySet<string> = new Set(["set_config"]);

/** Where src binds the caller, what it sets and for how long, and what it sends as raw text. */
function settingsOf(p: Program, root: string): { binds: string[]; settings: string[]; raw: string[] } {
  const binds: string[] = [];
  const settings: string[] = [];
  const raw: string[] = [];
  for (const [file, s] of p.sources) {
    const relative = path.relative(root, file);
    for (const m of s.src.matchAll(/schellingaf\.peer_id/gi)) {
      if (!s.comments.some((c) => c.start <= m.index! && m.index! < c.end)) binds.push(`${relative}:${lineOf(s, m.index!)}`);
    }
    for (const t of s.templates) {
      const text = qualified(sqlOf(s, t).text, NONE, SET_CONFIG).replace(/\bpg_catalog\.set_config\s*\(/g, "schellingaf.set_config(");
      for (const call of callsIn(text)) {
        if (call.name !== "set_config") continue;
        const name = call.args[0]!.trim().match(/^'([^']*)'$/);
        settings.push(`${relative} ${name ? name[1] : `a setting named by ${call.args[0]!.trim()}`} ${call.args[2]?.trim()}`);
      }
      if (/\b(set|reset)\s+(session\s+|local\s+)?"?(role|session authorization|schellingaf\.)/i.test(ownWords(text)) && relative !== "db/migrate.ts" && !(relative in OPERATOR_TOOLS)) {
        raw.push(`${at(root, s, t.start)} changes its role or the caller's setting`);
      }
    }
    for (const m of s.code.matchAll(/\.unsafe\s*\(/g)) if (relative !== "db/migrate.ts") raw.push(`${relative}:${lineOf(s, m.index!)} sends raw SQL`);
  }
  return { binds, settings: settings.sort(), raw };
}

/**
 * readTx calls whose caller this reader cannot follow to the request's token: each by its
 * file and the function it is written in, with where the reader stops (line numbers left
 * out) and why the KEY it binds is the request's own. A second way into the same call
 * stops somewhere else, and fails.
 */
const BOUND_BY_READING: Record<string, { stops: string; why: string }> = {
  "mcp/listen.ts checkAddresses": {
    stops: "toHex of unknown (parameter caller of fetchMcp (server.ts): fetchMcp is never called)",
    why:
      "a live-updates stream's own KEY: mcp/server.ts calls checkAddresses() once, with toHex(bearer.peerId) of " +
      "caller.bearer, the token the middleware in http/app.ts classified (bearer: c.get(\"bearer\")), after it refuses " +
      "every bearer whose state is not valid; this reader does not follow createMcpFetch()'s function to app.ts's call",
  },
};

/** The innermost named function around `at`, or the file's top level. */
function enclosingName(p: Program, file: string, at: number): string {
  const around = p.functions(file).filter((f) => f.name !== null && f.open <= at && at <= f.bodyEnd);
  around.sort((a, b) => a.bodyEnd - a.open - (b.bodyEnd - b.open));
  return around[0]?.name ?? "(top level)";
}

/**
 * Every readTx that binds a caller other than the KEY the request proved it holds, or
 * nobody, and every use of readTx other than a call; and listed calls that no longer stop
 * where the list says. Row security reads as whoever readTx binds, so a caller the request
 * chose reads what that KEY may.
 */
function bindsNotTheKey(p: Program, root: string, listed = BOUND_BY_READING): { failures: string[]; checked: number; stale: string[] } {
  const tracer = new Tracer(p);
  const failures: string[] = [];
  const honoured = new Set<string>();
  let checked = 0;
  for (const [file, s] of p.sources) {
    const relative = path.relative(root, file);
    for (const m of s.code.matchAll(/(?<![\w$])readTx(?![\w$])/g)) {
      const pos = m.index!;
      const after = s.code.slice(pos + "readTx".length);
      // db/sql.ts declares it in the type Db and defines it in openDb().
      if (relative === "db/sql.ts" && (/^\s*<T>\s*\(/.test(after) || /\basync\s+$/.test(s.code.slice(Math.max(0, pos - 20), pos)))) continue;
      const call = after.match(/^\s*\(/);
      if (!call || s.code[pos - 1] !== ".") {
        failures.push(`${at(root, s, pos)} names readTx other than calling it`);
        continue;
      }
      checked++;
      const [caller] = argsOf(s, pos + "readTx".length + call[0].length - 1);
      if (!caller) {
        failures.push(`${at(root, s, pos)} calls readTx with no caller`);
        continue;
      }
      const v = tracer.valueOf(file, caller.text, caller.at);
      // The request's KEY, or null: nobody, who reads what is public.
      if (v.value.kind === "key" || (v.value.kind === "unknown" && v.value.why === "null")) continue;
      const key = `${relative} ${enclosingName(p, file, pos)}`;
      if (key in listed && v.value.kind === "unknown" && v.value.why.replace(/(\.ts):\d+/g, "$1") === listed[key]!.stops) {
        honoured.add(key);
        continue;
      }
      failures.push(`${at(root, s, pos)} binds ${caller.text.trim()}:\n    ${said(v.value)}\n    ${v.trail.join("\n    ")}`);
    }
  }
  return { failures, checked, stale: Object.keys(listed).filter((k) => !honoured.has(k)).sort() };
}

/**
 * Every column of the three tables a post's words are in. A word is what visible_posts
 * blanks for a withheld or hidden post, or never carries: a hash or a key its author chose.
 * Everything else is the post's place in its SPACE and its chain, which the view passes.
 */
const POST_COLUMNS: Record<string, { words: string[]; place: string[] }> = {
  posts: {
    words: ["title", "body", "data", "budget", "to_peers", "run_id", "summary", "body_json_bytes", "data_json_bytes", "content_hash", "idempotency_key"],
    place: ["post_id", "space_id", "seq", "admitted_revision", "author_id", "kind", "reply_to", "supersedes", "retracts", "posted_at", "no_role"],
  },
  post_objects: {
    words: ["canonical", "private", "alg", "signature", "webauthn", "connection_key"],
    place: ["post_id", "space_id", "seq", "object_id", "admitted_revision", "admitted_control_hash", "admission", "previous_hash", "chain_hash"],
  },
  sealed_posts: { words: ["header", "ciphertext"], place: ["post_id", "space_id", "seq", "generation"] },
};
const POST_TABLES: ReadonlySet<string> = new Set(Object.keys(POST_COLUMNS));
/** Words the view carries, under its own name for the sealed header; the rest it never carries. */
const VIEW_NAME: Record<string, string> = { header: "sealed_header" };
const NOT_IN_VIEW = ["content_hash", "idempotency_key"];

const SQL_WORDS = new Set([
  "where", "join", "left", "right", "inner", "outer", "on", "using", "order", "group", "limit", "union", "cross", "full",
  "natural", "set", "returning", "and", "or", "as", "with", "window", "having", "offset", "for", "lateral", "values",
  "except", "intersect", "select", "from", "is", "not", "in",
]);

/**
 * The templates a statement is made of: those nested in its `${}` parts, and the fragments
 * those parts name, a const holding a template or a function returning one, a few levels.
 */
function partsOf(p: Program, s: Source, t: Template, depth = 0): { s: Source; t: Template }[] {
  const out: { s: Source; t: Template }[] = [];
  for (const inner of s.templates) if (inner !== t && inner.start > t.start && inner.end < t.end) out.push({ s, t: inner });
  if (depth > 3) return out;
  for (const e of sqlOf(s, t).exprs) {
    for (const m of e.text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const fn = p.functionNamed(s.file, m[1]!, e.at);
      if (!fn) continue;
      const fs = p.sources.get(fn.file)!;
      const returns: { start: number; end: number }[] = [];
      if (fs.code[fn.bodyStart] !== "{") returns.push({ start: fn.bodyStart, end: fn.bodyEnd });
      else {
        for (const r of fs.code.slice(fn.bodyStart, fn.bodyEnd).matchAll(/(?<![\w$.])return\b/g)) {
          const from = fn.bodyStart + r.index! + "return".length;
          let level = 0;
          let end = from;
          for (; end < fs.code.length; end++) {
            const c = fs.code[end]!;
            if ("([{".includes(c)) level++;
            else if (")]}".includes(c)) {
              if (level === 0) break;
              level--;
            } else if (c === ";" && level === 0) break;
          }
          returns.push({ start: from, end });
        }
      }
      for (const ft of fs.templates) {
        if (returns.some((r) => ft.start >= r.start && ft.end <= r.end)) out.push({ s: fs, t: ft }, ...partsOf(p, fs, ft, depth + 1));
      }
    }
    for (const m of e.text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$]*\s*\()/g)) {
      const b = p.bindingOf(s.file, m[1]!, e.at);
      if (!b || !("decl" in b) || !b.decl.init || b.decl.property !== null) continue;
      const init = s.src.slice(b.decl.init.start, b.decl.init.end);
      // A fragment: a template, or a choice of templates, never a row a statement answered.
      if (!/^\s*(?:[A-Za-z_$][\w$.]*\s*(?:<[^`]*?>)?\s*`|[^`]*\?)/.test(init)) continue;
      for (const dt of s.templates) {
        if (dt.start >= b.decl.init.start && dt.end <= b.decl.init.end) out.push({ s, t: dt }, ...partsOf(p, s, dt, depth + 1));
      }
    }
  }
  return out;
}

/** Every statement that reads a word from the post tables themselves, not of the caller's own posts. */
function wordReads(p: Program, root: string): { failures: string[]; checked: number } {
  const tracer = new Tracer(p);
  const failures: string[] = [];
  let checked = 0;
  for (const [file, s] of p.sources) {
    if (path.relative(root, file) in OPERATOR_TOOLS) continue;
    for (const t of s.templates) {
      const { text: written, exprs } = sqlOf(s, t);
      const text = qualified(written, POST_TABLES, NONE);
      const own = ownWords(text);
      // Each post table the statement reads, by its alias, or by its own name without one,
      // which is then how a column of it is qualified (`posts.body`, `schellingaf.posts.body`).
      const raw: { table: string; alias: string | null; name: string; ref: string }[] = [];
      for (const m of own.matchAll(/schellingaf\.(posts|post_objects|sealed_posts)\b(?!\.)(?!\s*\()(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/g)) {
        const table = m[1]!;
        const alias = m[2] && !SQL_WORDS.has(m[2]) ? m[2] : null;
        raw.push({ table, alias, name: alias ?? table, ref: alias ?? `(?:schellingaf\\.)?${table}` });
      }
      if (raw.length === 0) continue;
      checked++;
      const whole = [own, ...partsOf(p, s, t).map((x) => ownWords(qualified(sqlOf(x.s, x.t).text, POST_TABLES, NONE)))].join("\n");
      // A posts alias kept to the caller's own posts, `p.author_id = ${the request's KEY}`
      // as a conjunct, and the object or sealed parts joined to such a post by its id.
      const mine = new Set<string>();
      for (const { table, name, ref } of raw) {
        if (table !== "posts") continue;
        for (const m of text.matchAll(new RegExp(`(?:where|and)\\s+${ref}\\.author_id\\s*=\\s*\\u0000(\\d+)\\u0000(?!\\s*or\\b)`, "g"))) {
          const e = exprs[Number(m[1])]!;
          if (tracer.valueOf(file, e.text, e.at).value.kind === "key") mine.add(name);
        }
      }
      for (const { table, name, ref } of raw) {
        if (table === "posts") continue;
        for (const q of raw.filter((x) => mine.has(x.name))) {
          if (new RegExp(`(?<![\\w.])(${ref}\\.post_id\\s*=\\s*${q.ref}\\.post_id|${q.ref}\\.post_id\\s*=\\s*${ref}\\.post_id)\\b`).test(own)) mine.add(name);
        }
      }
      for (const { table, alias, name, ref } of raw) {
        const words = POST_COLUMNS[table]!.words;
        if (alias === null) {
          for (const w of words) if (new RegExp(`(?<![\\w.])${w}(?![\\w])`).test(whole)) failures.push(`${at(root, s, t.start)} reads ${table}.${w} unqualified`);
        }
        if (mine.has(name)) continue;
        for (const m of whole.matchAll(new RegExp(`(?<![\\w.])${ref}\\.(\\*|[a-z_][a-z0-9_]*)`, "g"))) {
          if (m[1] === "*" || words.includes(m[1]!)) failures.push(`${at(root, s, t.start)} reads ${name}.${m[1]} from ${table}`);
        }
        // The table by itself, as a whole row: to_jsonb(p), row_to_json(posts), select p.
        const bare = [...own.matchAll(new RegExp(`(?<![\\w.])(?<!\\bas\\s+)${name}(?![\\w.])`, "g"))].length;
        const declared = alias === null ? 0 : [...own.matchAll(new RegExp(`schellingaf\\.${table}\\s+(?:as\\s+)?${alias}(?![\\w])`, "g"))].length;
        if (bare > declared) failures.push(`${at(root, s, t.start)} reads ${table} ${name} as a whole row`);
      }
    }
  }
  return { failures: [...new Set(failures)], checked };
}

/** Parameters that name who acts, in the order a function's actor is looked for. */
const ACTOR_PARAMETERS = ["p_actor", "p_caller", "p_author", "p_owner", "p_starter", "p_blocker", "p_uploader", "p_peer_id", "p_peer"];

/**
 * Whether a function, or any function it calls, transitively, reads caller_id(); with
 * `setting`, or reads the caller's setting itself, as confirmation_counts() does.
 */
function callerReaders(fs: Fn[], setting = false): (name: string) => boolean {
  const direct = setting ? /\bcaller_id\s*\(\s*\)|schellingaf\.peer_id/ : /\bcaller_id\s*\(\s*\)/;
  const byName = new Map<string, Fn[]>();
  for (const f of fs) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const memo = new Map<string, boolean>();
  const reads = (name: string, seen: Set<string>): boolean => {
    if (memo.has(name)) return memo.get(name)!;
    if (seen.has(name)) return false;
    seen.add(name);
    const answer = (byName.get(name) ?? []).some(
      (f) =>
        direct.test(f.body) ||
        [...f.body.matchAll(/(?<![\w$.'])(?:schellingaf\.)?([a-z_][a-z0-9_]*)\s*\(/g)].some((m) => m[1] !== name && byName.has(m[1]!) && reads(m[1]!, seen)),
    );
    memo.set(name, answer);
    return answer;
  };
  return (name) => reads(name, new Set());
}

/** A function's actor: the first actor parameter it takes and uses, or null. */
function actorOf(f: Fn): string | null {
  const actor = ACTOR_PARAMETERS.find((a) => f.args.includes(a));
  return actor && new RegExp(`\\b${actor}\\b`).test(f.body) ? actor : null;
}

/**
 * Parameters with an actor's name that do not say who acts, each of a definer that reads
 * the caller for that, and why the request may choose it. A definer that reads the caller
 * and takes an actor too, as the task functions do through task_item(), is checked for its
 * actor like any other.
 */
const SUBJECTS: Record<string, string> = {
  "seek_fingerprint.p_author": "the author a reader asks SEEK to find (?author=); what it may see is the caller's",
  "seek_text.p_author": "the same author filter, for a search by words",
};

/** The definers that take the actor, but the listed subjects; and listed subjects that are no longer one. */
function actorTakers(fs: Fn[], subjects: Record<string, string>): { takers: Fn[]; stale: string[] } {
  const readsCaller = callerReaders(fs);
  const honoured = new Set<string>();
  const takers = fs.filter((f) => {
    const actor = f.definer && f.api ? actorOf(f) : null;
    if (actor === null) return false;
    // A subject only of a definer that reads the caller, which then decides who acts.
    if (`${f.name}.${actor}` in subjects && readsCaller(f.name)) {
      honoured.add(`${f.name}.${actor}`);
      return false;
    }
    return true;
  });
  return { takers, stale: Object.keys(subjects).filter((k) => !honoured.has(k)).sort() };
}

/** Every call in the sources of a definer that takes the actor, whose actor is not the request's KEY; and stale subjects. */
function actorsNotTheKey(p: Program, root: string, fs: Fn[], subjects = SUBJECTS): { failures: string[]; checked: number; stale: string[] } {
  const tracer = new Tracer(p);
  const { takers, stale } = actorTakers(fs, subjects);
  // Each such function's overloads: how many arguments each takes, and where the actor is.
  const takes = new Map<string, { min: number; max: number; index: number; actor: string }[]>();
  for (const f of takers) {
    const actor = actorOf(f)!;
    takes.set(f.name, [...(takes.get(f.name) ?? []), { min: f.required, max: f.args.length, index: f.args.indexOf(actor), actor }]);
  }
  const names = new Set(fs.map((f) => f.name));
  const failures: string[] = [];
  let checked = 0;
  for (const [file, s] of p.sources) {
    if (path.relative(root, file) in OPERATOR_TOOLS) continue;
    for (const t of s.templates) {
      const { text, exprs } = sqlOf(s, t);
      for (const call of callsIn(qualified(text, NONE, names))) {
        const overloads = takes.get(call.name);
        if (!overloads) continue;
        const o = overloads.find((x) => call.args.length >= x.min && call.args.length <= x.max);
        if (!o) {
          failures.push(`${at(root, s, t.start)} calls ${call.name} with ${call.args.length} arguments, which no overload takes`);
          continue;
        }
        checked++;
        const arg = call.args[o.index]!;
        const holes = holesOf(arg);
        if (holes.length !== 1) {
          failures.push(`${at(root, s, t.start)} ${call.name}(${o.actor} = ${arg.trim()}): not one value the request sent`);
          continue;
        }
        const e = exprs[holes[0]!]!;
        const v = tracer.valueOf(file, e.text, e.at);
        if (v.value.kind !== "key") failures.push(`${at(root, s, t.start)} ${call.name}(${o.actor} = \${${e.text.trim()}}) is ${said(v.value)}:\n    ${v.trail.join("\n    ")}`);
      }
    }
  }
  return { failures, checked, stale };
}

/**
 * Every statement outside readTx that calls a function reading the caller, but a definer
 * that takes the actor, which the write pool calls. Outside readTx no caller is bound:
 * caller_id() reads nobody there, and to confirmation_counts() a connection that never
 * bound one is the write pool answering its own writes.
 */
function callerReadsOutsideReadTx(p: Program, root: string, fs: Fn[], subjects = SUBJECTS): { failures: string[]; checked: number } {
  const tracer = new Tracer(p);
  const reads = callerReaders(fs, true);
  const takers = new Set(actorTakers(fs, subjects).takers.map((f) => f.name));
  const all = new Set(fs.map((f) => f.name));
  const failures: string[] = [];
  let checked = 0;
  for (const [file, s] of p.sources) {
    if (path.relative(root, file) in OPERATOR_TOOLS) continue;
    for (const t of s.templates) {
      const names = [...new Set(callsIn(qualified(sqlOf(s, t).text, NONE, all)).map((c) => c.name))].filter((n) => reads(n) && !takers.has(n));
      if (names.length === 0) continue;
      checked++;
      const v = tracer.valueOf(file, t.tag, t.tagStart);
      if (v.value.kind !== "readTx") failures.push(`${at(root, s, t.start)} calls ${names.join(", ")} on ${said(v.value)}:\n    ${v.trail.join("\n    ")}`);
    }
  }
  return { failures, checked };
}

// ── the guards over the catalogue ───────────────────────────────────────────

/**
 * Definers the api role may execute that read no caller and take no actor, and why each
 * needs neither. Anything added here is a door the service opens to every request that
 * reaches it, so say who reaches it and why that is safe.
 */
const NEITHER: Record<string, string> = {
  // The service itself, never a request: the checkpoint signer and the start-up check.
  checkpoint_leaves: "the checkpoint signer reads a SPACE's chain hashes to sign them",
  checkpoint_state: "the start-up check counts the checkpoints",
  checkpoints_due: "the checkpoint signer finds the SPACES whose chains it has not signed",
  insert_checkpoint: "the checkpoint signer stores a checkpoint, whose signature the function checks",
  register_service_key: "the service registers its own signing key, certified by the root key the function checks",
  restore_check: "the start-up check compares a SPACE's chain with the newest checkpoint",
  // Housekeeping: each removes only what has expired.
  clean_search_index: "empties the search index's pending lists",
  prune_check_offers: "removes expired check offers",
  prune_files: "removes uploads never attached within their hours",
  prune_messages: "removes messages past their retention",
  prune_oauth: "removes expired authorization requests",
  prune_rate_buckets: "removes rate buckets refilled to full",
  prune_tokens: "removes expired and revoked tokens",
  // What each SPACE stores (0148): the nightly recount, which answers deltas and no content.
  storage_recount_drift: "compares a SPACE's stored bytes with its two counters, without a lock",
  storage_recount: "counts a SPACE's stored bytes again under its lock and corrects its two counters",
  storage_recount_spaces: "lists the SPACES with a post, by id, for the recount",
  // A SPACE's credit (0149): the billing job's check of every balance against its ledger.
  credit_reconcile: "records each SPACE whose balance disagrees with its ledger",
  // The shadow bill (0150): the billing job's days, candidates, bills and summary, which
  // carry counts and ids, never a word of a SPACE.
  billing_last_day: "answers the latest day the billing job finished",
  billing_next_day: "answers the first day the billing job has to do",
  billing_day_begin: "begins a billing day",
  billing_day_recounted: "records that a billing day's recount ran",
  billing_day_finish: "finishes a billing day with its summary",
  bill_candidates: "lists the SPACES over their allowance for a day, by id",
  bill_space_day: "writes one SPACE's shadow bill for a day",
  billing_summary: "sums a day's measure by visibility, with no SPACE's name or id",
  // Allowances: a bucket the route names, holding a count and no content.
  take_tokens: "spends a rate bucket's allowance",
  charge_tokens: "charges a rate bucket after a write",
  charge_tokens_all: "charges several rate buckets one cost",
  charge_tokens_each: "charges several rate buckets their own costs",
  // Coming in: the request proves the KEY before the route calls these.
  register_peer: "registers a KEY after the route has verified its signature over the challenge",
  register_passkey: "registers a passkey after the route has verified its attestation",
  advance_passkey: "moves a passkey's counter forward after the route has verified an assertion; it only ever raises it",
  oauth_redeem: "the authorization code is the credential: single use, bound to its client and redirect",
  look_invite: "the invite code is the credential: it says what its link admits to whoever holds it",
  // Upload authorizations (0146): the authorization's secret is the credential, kept as its
  // hash; each answers or spends only the row that hash names, for the KEY that asked for it.
  upload_grant: "the upload authorization is the credential: it says whose it is, for the file PUT that presents it",
  put_file_granted: "the upload authorization is the credential: it stores its one file as the KEY whose token asked for it",
  spend_upload_grant: "the upload authorization is the credential: a body that did not match its address spends it",
  // What is public by design.
  space_is_public: "answers whether a SPACE is public",
  space_contacts: "a SPACE's owner and admins are public, so a stranger can ask to join",
  service_numbers: "the public totals behind GET /v1/numbers",
};

/** Functions that read the caller's setting themselves, not through caller_id(), and why. */
const READS_THE_SETTING: Record<string, string> = {
  caller_id: "the one reader of the caller's setting, which turns empty into null",
  // migrations/0144_tasks.sql; test/sec-tasks-standing.test.ts holds what it answers.
  confirmation_counts:
    "reads the setting itself, not caller_id(), to tell the write pool, which never binds a caller, from an " +
    "anonymous reader, whom readTx binds as ''; an anonymous or outside caller of a private SPACE reads false. " +
    "Only the task functions that take the actor reach it outside readTx, which the guard on calls outside readTx holds",
};

/** The definers the api role may execute that read no caller, take no actor and are not listed; and listed names that no longer are such. */
function unexplainedDefiners(fs: Fn[], listed: Record<string, string>): { unlisted: string[]; stale: string[]; definers: number } {
  const readsCaller = callerReaders(fs);
  const definers = fs.filter((f) => f.definer && f.api);
  const neither = [...new Set(definers.filter((f) => !readsCaller(f.name) && actorOf(f) === null).map((f) => f.name))];
  return {
    unlisted: neither.filter((n) => !(n in listed)).sort(),
    stale: Object.keys(listed).filter((n) => !neither.includes(n)).sort(),
    definers: definers.length,
  };
}

/** Functions the api role may execute that treat no caller as somebody; and those reading the setting without caller_id(). */
function callerOpeners(fs: Fn[]): { nullTests: string[]; setting: string[] } {
  // An anonymous reader reads as no caller: readTx binds it as '', which caller_id() turns
  // into null. A function that opens up when the caller is null opens up to every reader.
  return {
    nullTests: fs.filter((f) => f.api && /\bcaller_id\s*\(\s*\)\s+is\s+null\b/i.test(f.body)).map((f) => f.signature),
    setting: [...new Set(fs.filter((f) => /schellingaf\.peer_id/.test(f.body)).map((f) => f.name))].sort(),
  };
}

// ── the guards' own test ────────────────────────────────────────────────────

describe("each guard finds the break it exists for", () => {
  // Files in the shapes src/ uses, each breaking or keeping the rules above.
  const ROOT = "/virtual/";
  const files: Record<string, string> = {
    "/virtual/app.ts": `
      export function requireBearer(bearer: BearerState) {
        if (bearer.state === "valid") return bearer;
        throw new Error("no");
      }
      export function optionalBearer(bearer: BearerState): string | null {
        if (bearer.state === "none") return null;
        return toHex(requireBearer(bearer).peerId);
      }
    `,
    "/virtual/rows.ts": `
      import type { Sql } from "postgres";
      /** A helper each caller hands its connection: one hands it the write pool. */
      export function postsOf(sql: Sql, id: string) {
        return sql\`select p.seq from schellingaf.posts p where p.space_id = \${id}::uuid\`;
      }
      export function bodies(sql: Sql) {
        return sql\`p.body, p.title\`;
      }
    `,
    "/virtual/things.ts": `
      import { requireBearer, optionalBearer } from "./app.ts";
      import { postsOf, bodies } from "./rows.ts";
      export function mountThings(app: Hono<Env>, db: Db): void {
        const keyOf = (c: Context<Env>) => {
          const bearer = requireBearer(c.get("bearer"));
          return { ...bearer, hex: toHex(bearer.peerId) };
        };
        app.get("/a", async (c) => {
          const me = optionalBearer(c.get("bearer"));
          const rows = await db.readTx(me, (sql) => sql\`select p.seq from schellingaf.posts p\`);
          const bare = await db.read\`select p.seq from schellingaf.memberships p\`;
          const viaHelper = await db.readTx(me, (sql) => postsOf(sql, "x"));
          const words = await db.readTx(me, (sql) => sql\`select \${bodies(sql)} from schellingaf.posts p\`);
          const whole = await db.readTx(me, (sql) => sql\`select to_jsonb(p) from schellingaf.posts p\`);
          const view = await db.readTx(me, (sql) => sql\`select \${bodies(sql)} from schellingaf.visible_posts p\`);
          await db.read.unsafe("select 1");
          await db.write\`select set_config('schellingaf.peer_id', \${me}, false)\`;
          const mineInTx = await db.readTx(me, (sql) => sql\`select schellingaf.mine()\`);
          const mineBare = await db.read\`select schellingaf.mine()\`;
          return c.json({ rows, bare, viaHelper, words, whole, view, mineInTx, mineBare });
        });
        app.get("/b", async (c) => postsOf(db.write, "y"));
        app.post("/c", async (c) => {
          const me = keyOf(c);
          const input = await readBody(c);
          const own = await db.readTx(me.hex, (sql) => sql\`select p.body from schellingaf.posts p where p.author_id = \${me.peerId}\`);
          const theirs = await db.readTx(me.hex, (sql) => sql\`select p.body from schellingaf.posts p where p.author_id = \${input.peer}\`);
          await db.write\`select schellingaf.leave_space(\${input.name}, \${me.peerId})\`;
          await db.write\`select schellingaf.leave_space(\${input.name}, \${input.peer})\`;
          await db.write\`select schellingaf.leave_space(\${input.name}, \${c.req.param("peer")})\`;
          await act(c, (name, peer) => db.write\`select schellingaf.leave_space(\${name}, \${peer})\`);
          await act(c, (name, peer) => db.write\`select schellingaf.leave_space(\${name}, \${name})\`);
          await db.write\`select schellingaf.check_task(\${me.peerId}, \${input.task})\`;
          await db.write\`select schellingaf.check_task(\${input.peer}, \${input.task})\`;
          await db.readTx(me.hex, (sql) => sql\`select schellingaf.find_by(\${c.req.query("author")})\`);
          await db.readTx(null, (sql) => sql\`select 1\`);
          await db.readTx(c.req.query("as"), (sql) => sql\`select 1\`);
          await db.readTx(input.peer, (sql) => sql\`select 1\`);
          const later = db.readTx;
          return c.json({ own, theirs, later });
        });
        async function act(c: Context<Env>, run: (name: string, peer: Buffer) => Promise<unknown>) {
          const bearer = requireBearer(c.get("bearer"));
          return run(c.req.param("name"), bearer.peerId);
        }
      }
    `,
    "/virtual/stream.ts": `
      /** A helper nothing here calls: this reader cannot say whose KEY it binds. */
      export async function listen(db: Db, peer: string) {
        return db.readTx(peer, (sql) => sql\`select 1\`);
      }
    `,
  };
  const virtual = () => new Program(Object.keys(files), (file) => files[file]!);
  /** The line of the first line of things.ts that holds `text`. */
  const line = (text: string) => files["/virtual/things.ts"]!.split("\n").findIndex((l) => l.includes(text)) + 1;
  const firstWords = (failures: string[]) => failures.map((f) => f.split(" on ")[0]!.split(":\n")[0]!);

  test("a statement on a policied relation outside readTx, on a pool or through a helper one caller hands a pool", () => {
    const { failures, checked } = readsOutsideReadTx(virtual(), ROOT, new Set(["posts", "memberships", "visible_posts"]));
    assert.equal(checked, 8);
    assert.deepEqual(firstWords(failures), ["rows.ts:5 reads posts", `things.ts:${line("const bare")} reads memberships`]);
    assert.match(failures[0]!, /disagree/, "the helper's statement runs on readTx's transaction at one call and on the write pool at the other");
    assert.match(failures[1]!, /the pool db\.read/);
  });

  test("a readTx that binds a KEY the request chose, and readTx named other than called; never the token's KEY or nobody", () => {
    const listed = {
      "stream.ts listen": { stops: "parameter peer of listen (stream.ts): listen is never called", why: "read by a person" },
      "stream.ts gone": { stops: "parameter peer of gone (stream.ts): gone is never called", why: "a call that is no longer there" },
    };
    const { failures, checked, stale } = bindsNotTheKey(virtual(), ROOT, listed);
    assert.equal(checked, 13, "nine with the token's KEY, one with nobody, two with what the request chose, and the listed helper's");
    assert.deepEqual(firstWords(failures), [
      `things.ts:${line('readTx(c.req.query("as")')} binds c.req.query("as")`,
      `things.ts:${line("readTx(input.peer")} binds input.peer`,
      `things.ts:${line("const later")} names readTx other than calling it`,
    ]);
    assert.deepEqual(stale, ["stream.ts gone"]);
    // A second way into the listed call, with a KEY the request chose, stops elsewhere.
    const more = `
      import { listen } from "./stream.ts";
      export const more = (c: Context<Env>, db: Db) => listen(db, c.req.query("as"));
    `;
    const second = bindsNotTheKey(new Program([...Object.keys(files), "/virtual/more.ts"], (file) => (file === "/virtual/more.ts" ? more : files[file]!)), ROOT, listed);
    assert.deepEqual(second.stale, ["stream.ts gone", "stream.ts listen"]);
    assert.deepEqual(firstWords(second.failures).filter((f) => f.startsWith("stream.ts")), ["stream.ts:4 binds peer"]);
    assert.match(second.failures.find((f) => f.startsWith("stream.ts"))!, /c\.req\.query\("as"\)/);
  });

  test("a binding for the session, and raw SQL", () => {
    const { binds, settings, raw } = settingsOf(virtual(), ROOT);
    assert.deepEqual(binds, [`things.ts:${line("set_config")}`]);
    assert.deepEqual(settings, ["things.ts schellingaf.peer_id false"]);
    assert.deepEqual(raw, [`things.ts:${line(".unsafe(")} sends raw SQL`]);
  });

  test("a word read from the post tables through a fragment and as a whole row; never the caller's own, never the view's", () => {
    const { failures } = wordReads(virtual(), ROOT);
    assert.deepEqual(failures.sort(), [
      `things.ts:${line("const theirs")} reads p.body from posts`,
      `things.ts:${line("const whole")} reads posts p as a whole row`,
      `things.ts:${line("const words")} reads p.body from posts`,
      `things.ts:${line("const words")} reads p.title from posts`,
    ].sort());
  });

  /** Four definers: one acts, one reads the caller, one acts and reads the caller through it, one finds by an author. */
  const definers: Fn[] = [
    { name: "leave_space", signature: "schellingaf.leave_space(text,bytea)", definer: true, api: true, args: ["p_space_name", "p_actor"], required: 2, body: "AS $$ ... p_actor ... $$" },
    { name: "mine", signature: "schellingaf.mine()", definer: true, api: true, args: [], required: 0, body: "BEGIN ATOMIC SELECT 1 WHERE x = schellingaf.caller_id(); END" },
    { name: "check_task", signature: "schellingaf.check_task(bytea,uuid)", definer: true, api: true, args: ["p_actor", "p_task"], required: 2, body: "AS $$ BEGIN PERFORM schellingaf.mine(); UPDATE t SET a = 1 WHERE b = p_actor; END $$" },
    { name: "find_by", signature: "schellingaf.find_by(bytea)", definer: true, api: true, args: ["p_author"], required: 1, body: "BEGIN ATOMIC SELECT 1 WHERE a = p_author AND x = schellingaf.caller_id(); END" },
  ];
  const subjects = { "find_by.p_author": "an author filter", "leave_space.p_actor": "reads no caller", "gone.p_author": "no such function" };

  test("an actor from the body, the path or another parameter; never the token's KEY, through a helper too, of a definer that reads the caller too", () => {
    const { failures, checked, stale } = actorsNotTheKey(virtual(), ROOT, definers, subjects);
    assert.equal(checked, 7, "five calls of leave_space and two of check_task; find_by's author is a subject");
    assert.equal(failures.length, 4, failures.join("\n"));
    assert.match(failures[0]!, /input\.peer/);
    assert.match(failures[1]!, /c\.req\.param\("peer"\)/);
    assert.match(failures[2]!, /\$\{name\}/);
    assert.match(failures[3]!, new RegExp(`things\\.ts:${line("check_task(${input.peer}")} check_task\\(p_actor = \\$\\{input\\.peer\\}\\)`));
    // A subject of a definer that reads no caller is its actor, and checked as one.
    assert.deepEqual(stale, ["gone.p_author", "leave_space.p_actor"]);
  });

  test("a call of a function that reads the caller outside readTx; never of a definer that takes the actor", () => {
    const { failures, checked } = callerReadsOutsideReadTx(virtual(), ROOT, definers, subjects);
    assert.equal(checked, 3, "mine inside readTx and outside, and find_by; check_task takes the actor");
    assert.deepEqual(firstWords(failures), [`things.ts:${line("const mineBare")} calls mine`]);
    assert.match(failures[0]!, /the pool db\.read/);
  });

  /** Statements naming relations and functions without the schema, in capitals and quoted, as the search path reads them. */
  const plain = `
      import { optionalBearer } from "./app.ts";
      export function mountPlain(app: Hono<Env>, db: Db): void {
        app.post("/e", async (c) => {
          const me = optionalBearer(c.get("bearer"));
          const input = await readBody(c);
          await db.read\`select m.peer_id from memberships m\`;
          await db.read\`SELECT 1 FROM Schellingaf.Memberships\`;
          await db.read\`select 1 from schellingaf.spaces s, "memberships" x where x.space_id = s.space_id\`;
          await db.read\`with posts as (select 1 as seq) select seq from posts\`;
          await db.readTx(me, (sql) => sql\`select p.body from posts p\`);
          await db.readTx(me, (sql) => sql\`select posts.title from schellingaf.posts\`);
          await db.write\`select leave_space(\${input.name}, \${input.peer})\`;
          await db.write\`SELECT Schellingaf.Leave_Space(\${input.name}, \${input.peer})\`;
          await db.read\`select mine()\`;
          await db.write\`select PG_CATALOG.SET_CONFIG('statement_timeout', '1s', FALSE)\`;
          await db.write\`select set_config('SchellingAF.Peer_ID', \${me}, false)\`;
          await db.write\`set local "schellingaf.peer_id" = 'x'\`;
          return c.json({});
        });
      }
  `;
  const plainly = () => new Program(["/virtual/app.ts", "/virtual/plain.ts"], (file) => (file === "/virtual/plain.ts" ? plain : files[file]!));
  /** The line of plain.ts that holds `text`. */
  const plainLine = (text: string) => plain.split("\n").findIndex((l) => l.includes(text)) + 1;

  test("names written without the schema, in capitals or quoted, are the schema's to every guard; a WITH's own name is not", () => {
    const outside = readsOutsideReadTx(plainly(), ROOT, new Set(["posts", "memberships", "visible_posts"]));
    assert.equal(outside.checked, 5, "three bare reads of memberships and two of posts in readTx; the WITH reads no table");
    assert.deepEqual(firstWords(outside.failures), [
      `plain.ts:${plainLine("from memberships m")} reads memberships`,
      `plain.ts:${plainLine("Schellingaf.Memberships")} reads memberships`,
      `plain.ts:${plainLine('"memberships" x')} reads memberships`,
    ]);
    assert.deepEqual(wordReads(plainly(), ROOT).failures, [
      `plain.ts:${plainLine("p.body from posts p")} reads p.body from posts`,
      `plain.ts:${plainLine("posts.title")} reads posts.title from posts`,
    ]);
    const actors = actorsNotTheKey(plainly(), ROOT, definers, subjects);
    assert.equal(actors.checked, 2);
    assert.deepEqual(actors.failures.map((f) => f.split(" ").slice(0, 2).join(" ")), [
      `plain.ts:${plainLine("select leave_space(")} leave_space(p_actor`,
      `plain.ts:${plainLine("Leave_Space(")} leave_space(p_actor`,
    ]);
    assert.deepEqual(firstWords(callerReadsOutsideReadTx(plainly(), ROOT, definers, subjects).failures), [`plain.ts:${plainLine("mine()")} calls mine`]);
    const { binds, settings, raw } = settingsOf(plainly(), ROOT);
    assert.deepEqual(binds, [`plain.ts:${plainLine("SchellingAF.Peer_ID")}`, `plain.ts:${plainLine('"schellingaf.peer_id"')}`]);
    assert.deepEqual(settings, ["plain.ts SchellingAF.Peer_ID false", "plain.ts statement_timeout false"]);
    assert.deepEqual(raw, [`plain.ts:${plainLine('"schellingaf.peer_id"')} changes its role or the caller's setting`]);
  });

  test("a definer that does neither, a stale entry, and a function that treats no caller as somebody", () => {
    const fn = (name: string, body: string, args: string[] = []): Fn => ({ name, signature: `schellingaf.${name}()`, definer: true, api: true, args, required: args.length, body });
    const fs = [
      fn("caller_id", "RETURN decode(nullif(current_setting('schellingaf.peer_id', true), ''), 'hex')"),
      fn("mine", "BEGIN ATOMIC SELECT 1 WHERE x = schellingaf.caller_id(); END"),
      fn("via_mine", "BEGIN ATOMIC SELECT schellingaf.mine(); END"),
      fn("acts", "AS $$ BEGIN UPDATE t SET a = 1 WHERE b = p_actor; END $$", ["p_space", "p_actor"]),
      fn("ignores_its_actor", "AS $$ BEGIN UPDATE t SET a = 1; END $$", ["p_space", "p_actor"]),
      fn("opens", "RETURN (schellingaf.caller_id() IS NULL OR schellingaf.mine())"),
      fn("peeks", "RETURN current_setting('schellingaf.peer_id', true) IS NULL"),
    ];
    const { unlisted, stale } = unexplainedDefiners(fs, { gone: "a function that no longer exists" });
    assert.deepEqual(unlisted, ["caller_id", "ignores_its_actor", "peeks"]);
    assert.deepEqual(stale, ["gone"]);
    const { nullTests, setting } = callerOpeners(fs);
    assert.deepEqual(nullTests, ["schellingaf.opens()"]);
    assert.deepEqual(setting, ["caller_id", "peeks"]);
  });
});

// ── the guards over src and the catalogue ───────────────────────────────────

describe("every statement on a policied relation runs inside readTx", () => {
  test("so a new read of one on a bare pool fails here", async () => {
    await opened;
    const { failures, checked } = readsOutsideReadTx(program, SRC, policied);
    assert.deepEqual(failures, [], `statements outside readTx:\n${failures.join("\n")}`);
    // A reader that found nothing would pass this proving nothing.
    assert.ok(checked >= 90, `only ${checked} statements on policied relations were found`);
  });

  test("and so does every call of a function that reads the caller, but a definer's that takes the actor", async () => {
    await opened;
    const { failures, checked } = callerReadsOutsideReadTx(program, SRC, functions);
    assert.deepEqual(failures, [], `calls outside readTx:\n${failures.join("\n")}`);
    assert.ok(checked >= 40, `only ${checked} statements calling a function that reads the caller were found`);
  });

  test("an operator's tool on the list is one: it opens its own connection as the owner, and the service never imports it", async () => {
    await opened;
    for (const tool of Object.keys(OPERATOR_TOOLS)) {
      const s = program.sources.get(path.join(SRC, tool));
      assert.ok(s, `${tool} is listed as an operator's tool and does not exist: drop it from the list`);
      assert.ok(s.templates.some((t) => namedRelations(qualified(sqlOf(s, t).text, policied, NONE)).some((r) => policied.has(r))), `${tool} reads no policied relation: drop it from the list`);
      assert.match(s.src, /set role schellingaf_owner/, `${tool} no longer assumes the owner`);
      assert.doesNotMatch(s.src, /from "[./]*(db\/)?sql\.ts"/, `${tool} now uses the service's pools`);
      for (const [other, os] of program.sources) {
        if (other !== s.file) assert.doesNotMatch(os.src, new RegExp(`from "[./]*(db/)?${path.basename(tool).replace(".", "\\.")}"`), `${path.relative(SRC, other)} imports ${tool}`);
      }
    }
  });

  test("only readTx binds the caller, for its transaction alone, and src sends no SQL as raw text", async () => {
    await opened;
    const { binds, settings, raw } = settingsOf(program, SRC);
    // The caller's id is named once, in readTx's own statement, set for the transaction.
    assert.deepEqual(binds.map((b) => b.split(":")[0]), ["db/sql.ts"], "the caller's setting is named outside readTx");
    assert.deepEqual(
      settings,
      ["db/sql.ts schellingaf.peer_id true", "db/storage.ts lock_timeout true", "db/storage.ts statement_timeout true", "http/numbers.ts statement_timeout true"],
      "a statement sets something else, or for longer than its transaction",
    );
    assert.deepEqual(raw, []);
    // And readTx is the read pool's transaction whose first statement is that binding.
    const sql = program.sources.get(path.join(SRC, "db/sql.ts"))!.src;
    assert.match(
      sql,
      /async readTx\(peerIdHex, fn\) \{\s*return read\.begin\(async \(tx\) => \{\s*await tx`select set_config\('schellingaf\.peer_id', \$\{peerIdHex \?\? ""\}, true\)`;\s*return fn\(tx/,
      "readTx no longer binds the caller first, for the transaction, on the read pool",
    );
  });

  test("and every readTx binds the KEY the request proved it holds, or nobody", async () => {
    await opened;
    const { failures, checked, stale } = bindsNotTheKey(program, SRC);
    assert.deepEqual(failures, [], `readTx binds a caller that is not the request's own KEY:\n${failures.join("\n")}`);
    assert.deepEqual(stale, [], "listed, but its readTx no longer stops where the list says");
    assert.ok(checked >= 50, `only ${checked} calls of readTx were found`);
  });

  test("a name written without the schema is the schema's, as the guards read it: no built-in has one", async () => {
    await opened;
    // The api role's search path reads pg_catalog first, so a name the two shared would be
    // the built-in's, where the guards read the schema's.
    const [row] = await fixture.owner<{ names: string[] }[]>`
      select coalesce(array_agg(distinct x.name order by x.name), '{}') as names
        from (select p.proname::text as name from pg_proc p where p.pronamespace = 'schellingaf'::regnamespace
              union all
              select c.relname::text from pg_class c where c.relnamespace = 'schellingaf'::regnamespace) x
       where exists (select 1 from pg_proc b where b.pronamespace = 'pg_catalog'::regnamespace and b.proname = x.name)
          or exists (select 1 from pg_class b where b.relnamespace = 'pg_catalog'::regnamespace and b.relname = x.name)`;
    assert.deepEqual(row!.names, []);
  });
});

describe("a withheld or hidden post loses its words in visible_posts, and nothing reads them elsewhere", () => {
  /** Nine posts, three of each kind of words: one stays, one is withheld, one is hidden. */
  async function scene(): Promise<string> {
    const key = publicKey("sec-db-access-words");
    const author = peerIdOf(key);
    await fixture.owner`select schellingaf.register_peer(${key})`;
    await fixture.owner`select schellingaf.create_space(decode(${author}, 'hex'), 'sec-words', 'Words')`;
    await fixture.owner`
      insert into schellingaf.connection_keys (public_key, peer_id, request_id, not_before, not_after, statement, signature)
      values (sha256('sec-words-connection'::bytea), decode(${author}, 'hex'), gen_random_uuid(), now(), now() + interval '1 day',
              convert_to(repeat('s', 64), 'UTF8'), '{"alg": "ed25519"}')`;
    await fixture.owner`
      with s as (select space_id from schellingaf.spaces where name = 'sec-words'),
           n as (select g from generate_series(1, 9) g)
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, data, budget, to_peers,
                                     run_id, idempotency_key, content_hash, summary, body_json_bytes, data_json_bytes)
      select s.space_id, n.g, 1, decode(${author}, 'hex'), 'obs', 'a title', 'a body', '{"a": 1}', '{"b": 1}',
             array[decode(${author}, 'hex')]::bytea[], gen_random_uuid(), 'key-' || n.g, sha256(('words' || n.g)::bytea), 'a summary', 8, 8
        from s, n`;
    // Posts 1-3 signed by a passkey, 4-6 by a connection key, 7-9 sealed.
    await fixture.owner`
      insert into schellingaf.post_objects (post_id, space_id, seq, object_id, canonical, private, alg, signature, webauthn,
                                            admitted_revision, admitted_control_hash, admission, previous_hash, chain_hash, connection_key)
      select p.post_id, p.space_id, p.seq, x.object_id, x.canonical, convert_to('private', 'UTF8'), x.alg,
             sha256('a'::bytea) || sha256('b'::bytea), x.webauthn, 1, sha256('control'::bytea), x.admission, x.previous,
             sha256(schellingaf.domain_bytes('agent-state:object-chain:v1') || uuid_send(p.space_id) || int8send(p.seq)
                    || x.admission || x.previous || x.object_id),
             x.connection_key
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id and s.name = 'sec-words'
        cross join lateral (
          select convert_to('canonical ' || p.seq, 'UTF8') as canonical,
                 sha256(schellingaf.domain_bytes('agent-state:object:v1') || convert_to('canonical ' || p.seq, 'UTF8')) as object_id,
                 sha256(schellingaf.domain_bytes('agent-state:object-admission:v1') || int8send(1) || sha256('control'::bytea)) as admission,
                 case when p.seq = 1 then sha256(schellingaf.domain_bytes('agent-state:object-genesis:v1') || uuid_send(p.space_id))
                      else sha256(('previous' || p.seq)::bytea) end as previous,
                 case when p.seq <= 3 then 'webauthn' else 'connection' end as alg,
                 case when p.seq <= 3 then '{"authenticator_data": "x"}'::jsonb end as webauthn,
                 case when p.seq > 3 then sha256('sec-words-connection'::bytea) end as connection_key) x
       where p.seq <= 6`;
    await fixture.owner`
      insert into schellingaf.sealed_posts (post_id, space_id, seq, generation, header, ciphertext)
      select p.post_id, p.space_id, p.seq, 1, convert_to('header', 'UTF8'), convert_to(repeat('c', 32), 'UTF8')
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id and s.name = 'sec-words'
       where p.seq > 6`;
    await fixture.owner`
      insert into schellingaf.withheld (post_id, space_id, reason, note)
      select p.post_id, p.space_id, 'legal_order', 'test'
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id and s.name = 'sec-words'
       where p.seq in (2, 5, 8)`;
    await fixture.owner`
      insert into schellingaf.space_hidden (post_id, space_id, hidden_by, revision)
      select p.post_id, p.space_id, s.owner_id, 1
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id and s.name = 'sec-words'
       where p.seq in (3, 6, 9)`;
    return author;
  }

  /** What `view` shows a member of the nine posts that it should not: a word of one withheld or hidden, or a word lost from one standing. */
  async function wordsShown(view: string, author: string): Promise<string[]> {
    const shown = Object.values(POST_COLUMNS).flatMap((c) => c.words).filter((w) => !NOT_IN_VIEW.includes(w)).map((w) => VIEW_NAME[w] ?? w);
    const rows = await fixture.asCaller(author, (sql) => sql<Record<string, unknown>[]>`
      select seq::int as seq, unavailable, ${sql(shown)} from ${sql("schellingaf")}.${sql(view)}
       where space_id = (select space_id from schellingaf.spaces where name = 'sec-words')
       order by seq`);
    assert.equal(rows.length, 9, "the member did not read its SPACE's nine posts");
    // What each post carries when it stands: the plain words always, and its own kind of the rest.
    const carried = (seq: number) =>
      shown.filter((c) =>
        ["sealed_header", "ciphertext"].includes(c) ? seq > 6
        : ["canonical", "private", "alg", "signature"].includes(c) ? seq <= 6
        : c === "webauthn" ? seq <= 3
        : c === "connection_key" ? seq > 3 && seq <= 6
        : true);
    const wrong: string[] = [];
    for (const row of rows) {
      const seq = row.seq as number;
      if (seq % 3 === 1) {
        for (const c of carried(seq)) if (row[c] === null) wrong.push(`post ${seq} stands and lost ${c}`);
      } else {
        const state = seq % 3 === 2 ? "withheld" : "hidden";
        if (row.unavailable === null) wrong.push(`post ${seq} is ${state} and not marked unavailable`);
        for (const c of shown) if (row[c] !== null) wrong.push(`post ${seq}, ${state}, carries ${c}`);
      }
    }
    return wrong;
  }

  test("every column of the post tables is a word or a place, and the view carries no word of a withheld or hidden post", async () => {
    await opened;
    for (const [table, { words, place }] of Object.entries(POST_COLUMNS)) {
      const columns = await fixture.owner<{ attname: string }[]>`
        select attname from pg_attribute where attrelid = ${`schellingaf.${table}`}::regclass and attnum > 0 and not attisdropped`;
      assert.deepEqual(
        columns.map((c) => c.attname).sort(),
        [...words, ...place].sort(),
        `${table} has a column this test does not class as a word or a place: say which, and if a word, blank it in visible_posts`,
      );
    }
    const view = await fixture.owner<{ attname: string }[]>`
      select attname from pg_attribute where attrelid = 'schellingaf.visible_posts'::regclass and attnum > 0 and not attisdropped`;
    for (const column of NOT_IN_VIEW) assert.ok(!view.some((v) => v.attname === column), `visible_posts carries ${column}`);
    const author = await scene();
    assert.deepEqual(await wordsShown("visible_posts", author), []);
    // The same check, of a view that lets the body through, finds it in every post that lost it.
    await fixture.owner.unsafe(`
      create view schellingaf.leaky_posts with (security_invoker = true) as
      select v.post_id, v.space_id, v.seq, v.unavailable, v.title, v.data, v.budget, v.to_peers, v.run_id, v.summary,
             v.body_json_bytes, v.data_json_bytes, v.canonical, v.private, v.alg, v.signature, v.webauthn, v.connection_key,
             v.sealed_header, v.ciphertext, p.body
        from schellingaf.visible_posts v join schellingaf.posts p on p.post_id = v.post_id`);
    await fixture.owner`grant select on schellingaf.leaky_posts to schellingaf_api`;
    assert.deepEqual(await wordsShown("leaky_posts", author), [
      "post 2, withheld, carries body", "post 3, hidden, carries body", "post 5, withheld, carries body",
      "post 6, hidden, carries body", "post 8, withheld, carries body", "post 9, hidden, carries body",
    ]);
  });

  test("no statement reads a word from the post tables, except of the caller's own posts", async () => {
    await opened;
    const { failures, checked } = wordReads(program, SRC);
    assert.deepEqual(failures, [], "read visible_posts instead, which blanks a withheld or hidden post's words");
    assert.ok(checked >= 15, `only ${checked} statements on the post tables were found`);
  });
});

describe("every definer the api role may execute reads the caller, takes the actor, or is listed with its reason", () => {
  test("so a new one that does neither fails here", async () => {
    await opened;
    const { unlisted, stale, definers } = unexplainedDefiners(functions, NEITHER);
    assert.ok(definers > 80, `only ${definers} definers the api role may execute were found`);
    assert.deepEqual(unlisted, [], "a definer the api role may execute reads no caller and takes no actor: make it do one, or list it with why");
    assert.deepEqual(stale, [], "listed, but no longer an api-executable definer that does neither");
  });

  test("none treats no caller as somebody, and only caller_id() reads the caller's setting", async () => {
    await opened;
    const { nullTests, setting } = callerOpeners(functions);
    assert.deepEqual(nullTests, [], "a function the api role may execute treats no caller as somebody");
    assert.deepEqual(setting, Object.keys(READS_THE_SETTING).sort(), "a function reads the caller's setting without caller_id()");
  });

  test("every definer pins its search path", async () => {
    await opened;
    const rows = await fixture.owner<{ signature: string; config: string[] | null }[]>`
      select p.oid::regprocedure::text as signature, p.proconfig as config
        from pg_proc p where p.pronamespace = 'schellingaf'::regnamespace and p.prosecdef`;
    const loose = rows.filter((r) => !(r.config ?? []).includes("search_path=pg_catalog, schellingaf, pg_temp")).map((r) => r.signature);
    assert.deepEqual(loose, []);
  });

  test("every call in src of one that takes the actor passes the KEY the request proved it holds", async () => {
    await opened;
    const { failures, checked, stale } = actorsNotTheKey(program, SRC, functions);
    assert.deepEqual(failures, [], `an actor that is not the request's KEY:\n${failures.join("\n")}`);
    assert.deepEqual(stale, [], "listed as a subject, but no longer a parameter of a definer that reads the caller");
    assert.ok(checked >= 65, `only ${checked} calls of definers that take the actor were found`);
  });
});
