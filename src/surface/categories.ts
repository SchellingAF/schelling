// The category register: every category a SPACE can be filed under, read once at
// start from categories.json beside this file.
//
// docs/research/category-agreement.md is how the list was built and tested. It is
// released under CC0, so anyone may copy it and it can become a shared standard.
//
// Closed here and permissive in the database, as the kinds are: the database checks
// only an id's shape, so a new release is a code change and never a migration.
//
// A broken register never serves. Loading it throws with every problem listed, so
// the service does not start, and `npm run check` runs the same checks.
//
// Three rules no release may break, because an agent holds ids between RUNS and a
// SPACE keeps the ids it was filed under:
//   * an id never changes and never goes away;
//   * a renamed entry keeps its id and its old names as aliases;
//   * a discontinued one stays, retired, naming its successor when it has one.
// test/fixtures/category-ids.json is append-only and the tests hold every release to it.

import { readFileSync } from "node:fs";

/** A category id: lowercase words and digits joined by single hyphens. */
export const CATEGORY_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CATEGORY_ID_BYTES = 64;
/** The shape, in the words a refusal uses. */
export const CATEGORY_ID_SHAPE = `lowercase words and digits joined by hyphens, at most ${CATEGORY_ID_BYTES} characters`;
export const CATEGORIES_PER_SPACE = 3;

/** Whether a value has a category id's shape. The register may still not have it. */
export function isCategoryId(value: unknown): value is string {
  return typeof value === "string" && CATEGORY_ID.test(value) && Buffer.byteLength(value) <= CATEGORY_ID_BYTES;
}

/** What a named entry is. Closed: a new type is a new release. */
export const CATEGORY_TYPES = [
  "tool", "service", "model", "dataset", "benchmark", "method", "protocol",
  "standard", "law", "policy", "organisation", "hardware", "event", "community",
] as const;

/**
 * How deep the register may go: four levels in artificial intelligence (area, family,
 * named entry), three under programming languages, two everywhere else. Published in
 * the capability document so an agent knows how far down to look.
 */
export const CATEGORY_LEVELS = { "artificial-intelligence": 4, "programming-languages": 3, default: 2 } as const;
/** The deepest any branch goes, so the most levels a list can be asked for. */
export const CATEGORY_MAX_DEPTH = Math.max(...Object.values(CATEGORY_LEVELS));
/** The levels by the id that sets them, the default left out. */
const LEVELS = new Map<string, number>(Object.entries(CATEGORY_LEVELS).filter(([id]) => id !== "default"));

/** The filing rules, as every categories answer and the capability document state them. */
export const CATEGORY_RULES = {
  per_space: { min: 1, max: CATEGORIES_PER_SPACE },
  required:
    "A public SPACE, an oracle space included, is filed under one to three categories. " +
    "A private or sealed SPACE may have none, and is then in no category.",
  main: "The first category a SPACE lists is its main one.",
  filter: "Filtering by a category includes every category below it.",
  nested: "A SPACE never lists a category together with one inside it: the narrower one is enough.",
  retired: "A retired category takes no new filing. Use the category its replaced_by names, or its parent.",
} as const;

type CategoryType = (typeof CATEGORY_TYPES)[number];

export type Category = {
  id: string;
  label: string;
  parent: string | null;
  /** Set on a named entry (a tool, a model, a law); absent on a general category. */
  type?: CategoryType;
  description: string;
  /** What does not go here, and the ids where it does. */
  elsewhere: string;
  examples: string[];
  aliases: string[];
  wikidata?: string;
  homepage?: string;
  status: "active" | "retired";
  replaced_by?: string;
  /** The release that added it. */
  since: string;
};

type Release = { version: string; changes: string[] };

type Loaded = {
  releases: Release[];
  version: string;
  licence: string;
  outlineOpens: string[];
  categories: Category[];
};

/** A Wikidata item: Q and its number. */
export const QID = /^Q[1-9][0-9]{0,9}$/;
const CONTROL = /\p{Cc}/u;
const MAX_TEXT_BYTES = 300;

// ── reading it ───────────────────────────────────────────────────────────────

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
}

/**
 * The register's shape, checked field by field, so a malformed file is a list of
 * problems rather than a crash three calls later.
 */
function parse(value: unknown, problems: string[]): Loaded {
  const root = (value ?? {}) as Record<string, unknown>;
  const releases = Array.isArray(root.releases) ? (root.releases as Release[]) : [];
  if (releases.length === 0) problems.push("the register has no releases");
  for (const r of releases) {
    if (typeof r?.version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.version)) problems.push("a release has no dated version");
    if (!asStringArray(r?.changes)?.length) problems.push(`release ${r?.version}: no changes listed`);
  }
  const licence = typeof root.licence === "string" ? root.licence : "";
  if (!licence) problems.push("the register names no licence");
  const outlineOpens = asStringArray(root.outline_opens) ?? [];
  const categories: Category[] = [];
  for (const raw of Array.isArray(root.categories) ? root.categories : []) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : "(no id)";
    const text = (field: string): string => {
      if (typeof c[field] !== "string") problems.push(`${id}: ${field} is not text`);
      return typeof c[field] === "string" ? (c[field] as string) : "";
    };
    const list = (field: string): string[] => {
      const found = asStringArray(c[field]);
      if (!found) problems.push(`${id}: ${field} is not a list of text`);
      return found ?? [];
    };
    const status = c.status === "active" || c.status === "retired" ? c.status : null;
    if (!status) problems.push(`${id}: status is neither active nor retired`);
    if (c.parent !== null && typeof c.parent !== "string") problems.push(`${id}: parent is neither an id nor null`);
    if (c.type !== undefined && !CATEGORY_TYPES.includes(c.type as CategoryType)) problems.push(`${id}: type ${String(c.type)} is not one the register has`);
    if (c.wikidata !== undefined && (typeof c.wikidata !== "string" || !QID.test(c.wikidata))) problems.push(`${id}: wikidata is not a Q-number`);
    if (c.homepage !== undefined && (typeof c.homepage !== "string" || !c.homepage.startsWith("https://"))) problems.push(`${id}: homepage is not an https address`);
    if (c.replaced_by !== undefined && typeof c.replaced_by !== "string") problems.push(`${id}: replaced_by is not an id`);
    const entry: Category = {
      id,
      label: text("label"),
      parent: typeof c.parent === "string" ? c.parent : null,
      description: text("description"),
      elsewhere: text("elsewhere"),
      examples: list("examples"),
      aliases: list("aliases"),
      status: status ?? "active",
      since: text("since"),
    };
    if (typeof c.type === "string") entry.type = c.type as CategoryType;
    if (typeof c.wikidata === "string") entry.wikidata = c.wikidata;
    if (typeof c.homepage === "string") entry.homepage = c.homepage;
    if (typeof c.replaced_by === "string") entry.replaced_by = c.replaced_by;
    categories.push(entry);
  }
  return { releases, version: releases.at(-1)?.version ?? "", licence, outlineOpens, categories };
}

/**
 * A category's line, from its top category down to itself, or null when its parents
 * never reach a top: one of them does not exist, or they go round.
 */
function lineOf(c: Category, byId: ReadonlyMap<string, Category>): Category[] | null {
  const line = [c];
  for (let parent = c.parent; parent !== null; parent = line[0]!.parent) {
    const above = byId.get(parent);
    if (!above || line.some((x) => x.id === above.id)) return null;
    line.unshift(above);
  }
  return line;
}

/**
 * Every rule a release must keep, as a list of problems; empty when it keeps them all.
 * Exported for the tests, which hand it broken registers. Loading the register checks
 * the same rules, so `npm run check` does too: `scripts/guards.ts` builds the app,
 * and that loads the register.
 */
export function registerProblems(value: unknown): string[] {
  return checked(value).problems;
}

/** The register as read from its file, and every rule it breaks. */
function checked(value: unknown): { reg: Loaded; problems: string[] } {
  const problems: string[] = [];
  const reg = parse(value, problems);
  const byId = new Map<string, Category>();
  for (const c of reg.categories) {
    if (byId.has(c.id)) problems.push(`${c.id}: id used twice`);
    byId.set(c.id, c);
  }
  if (reg.categories.length === 0) problems.push("the register is empty");

  for (const c of reg.categories) {
    if (!isCategoryId(c.id)) problems.push(`${c.id}: id breaks the grammar`);
    if (c.parent !== null && !byId.has(c.parent)) problems.push(`${c.id}: parent ${c.parent} does not exist`);
    // Parents that exist, and no cycle: every chain of parents must reach a top.
    const line = lineOf(c, byId);
    if (line === null) {
      problems.push(`${c.id}: its parents never reach a top category`);
      continue;
    }
    // As deep as the first category in its line that sets a limit allows, top first.
    const max = line.map((x) => LEVELS.get(x.id)).find((n) => n !== undefined) ?? CATEGORY_LEVELS.default;
    if (line.length > max) problems.push(`${c.id}: depth ${line.length} is deeper than ${max}`);
    for (const [field, text] of [["label", c.label], ["description", c.description], ["elsewhere", c.elsewhere]] as const) {
      if (CONTROL.test(text)) problems.push(`${c.id}: control character in ${field}`);
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES) problems.push(`${c.id}: ${field} is over ${MAX_TEXT_BYTES} bytes`);
      if (text !== text.trim() || /\s{2,}/.test(text)) problems.push(`${c.id}: ${field} is not one clean line`);
    }
    if (!c.label) problems.push(`${c.id}: no label`);
    if (!c.description) problems.push(`${c.id}: no description`);
    if (/^other$/i.test(c.label.trim())) problems.push(`${c.id}: no entry is called Other`);
    if (c.type && !c.homepage) problems.push(`${c.id}: a named entry needs an https homepage`);
    if (!c.type && c.homepage) problems.push(`${c.id}: only a named entry has a homepage`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.since) || !reg.releases.some((r) => r.version === c.since)) {
      problems.push(`${c.id}: since names no release`);
    }
    if (c.replaced_by !== undefined) {
      const next = byId.get(c.replaced_by);
      if (c.status !== "retired") problems.push(`${c.id}: only a retired entry names a replacement`);
      else if (!next || next.status !== "active" || next.id === c.id) problems.push(`${c.id}: replaced_by ${c.replaced_by} is not another active entry`);
    }
    for (const x of [...c.examples, ...c.aliases]) {
      if (!x || Buffer.byteLength(x) > MAX_TEXT_BYTES || CONTROL.test(x) || x !== x.trim()) problems.push(`${c.id}: example or alias "${x}" is not one clean line`);
    }
  }
  for (const id of reg.outlineOpens) if (!byId.has(id)) problems.push(`outline_opens names ${id}, which is not an id`);

  // Labels: unique among siblings; the same label twice anywhere only for a model
  // family and its maker, whose goes-elsewhere notes name each other.
  const fold = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const siblings = new Map<string, Map<string, string>>();
  for (const c of reg.categories) {
    const sibs = siblings.get(c.parent ?? "") ?? new Map<string, string>();
    if (sibs.has(fold(c.label))) problems.push(`${c.id}: label "${c.label}" repeats among its siblings (${sibs.get(fold(c.label))})`);
    sibs.set(fold(c.label), c.id);
    siblings.set(c.parent ?? "", sibs);
  }
  for (const [label, same] of Map.groupBy(reg.categories, (c) => fold(c.label))) {
    if (same.length < 2) continue;
    if (same.length > 2) {
      problems.push(`label "${label}" is used ${same.length} times: ${same.map((c) => c.id).join(", ")}`);
      continue;
    }
    const [a, b] = same as [Category, Category];
    if (!namesId(a.elsewhere, b.id) || !namesId(b.elsewhere, a.id)) {
      problems.push(`label "${label}" is shared by ${a.id} and ${b.id}, whose goes-elsewhere notes must name each other`);
    }
  }

  // Aliases: never another entry's id or label, and never shared by two entries,
  // compared as the lookup compares them.
  const idKey = new Map(reg.categories.map((c) => [normalise(c.id), c.id]));
  const labelKey = Map.groupBy(reg.categories, (c) => normalise(c.label));
  const aliasOwner = new Map<string, string>();
  for (const c of reg.categories) {
    for (const a of c.aliases) {
      const k = normalise(a);
      const clash = idKey.get(k);
      if (clash && clash !== c.id) problems.push(`${c.id}: alias "${a}" is ${clash}'s id`);
      const owners = (labelKey.get(k) ?? []).filter((x) => x.id !== c.id);
      if (owners.length) problems.push(`${c.id}: alias "${a}" is the label of ${owners.map((x) => x.id).join(", ")}`);
      if (aliasOwner.has(k) && aliasOwner.get(k) !== c.id) problems.push(`${c.id}: alias "${a}" is also ${aliasOwner.get(k)}'s`);
      aliasOwner.set(k, c.id);
    }
  }

  // Examples are words specific to their entry. A generic one would outrank the
  // category a searcher means ("memory" on one framework over Memory and context), so an
  // example may not be a single word of a general category's label, and no example is
  // shared by three entries. One that is itself another entry's id, label or alias is
  // left alone: the lookup ranks that entry first anyway.
  const generalWords = new Map<string, string>();
  for (const c of reg.categories) {
    if (c.type) continue;
    for (const w of normalise(c.label).split(" ")) if (w.length > 2 && !["and", "the", "for"].includes(w)) generalWords.set(w, c.id);
  }
  const names = new Set(reg.categories.flatMap((c) => [normalise(c.id), normalise(c.label), ...c.aliases.map(normalise)]));
  const holders = Map.groupBy(
    reg.categories.flatMap((c) => c.examples.map((x) => ({ key: normalise(x), id: c.id }))),
    (h) => h.key,
  );
  for (const c of reg.categories) {
    for (const x of c.examples) {
      const k = normalise(x);
      if (names.has(k)) continue;
      const owner = generalWords.get(k);
      if (!k.includes(" ") && owner && owner !== c.id) problems.push(`${c.id}: example "${x}" is a word of ${owner}'s label`);
      const held = holders.get(k) ?? [];
      if (held.length >= 3) problems.push(`${c.id}: example "${x}" is shared by ${held.map((h) => h.id).join(", ")}`);
    }
  }

  // Goes-elsewhere notes name ids after a colon ("Running models yourself:
  // inference-and-serving."), and every hyphenated word there must be an id.
  for (const c of reg.categories) {
    for (const token of idsNamedIn(c.elsewhere)) {
      if (token.includes("-") && !byId.has(token)) problems.push(`${c.id}: elsewhere names ${token}, which is not an id`);
    }
  }
  return { reg, problems };
}

/** The words after a colon in each sentence of a goes-elsewhere note that have an id's shape. */
function idsNamedIn(elsewhere: string): string[] {
  const out: string[] = [];
  for (const sentence of elsewhere.split(/\.(?:\s+|$)/)) {
    const at = sentence.lastIndexOf(":");
    if (at < 0) continue;
    for (const token of sentence.slice(at + 1).split(/,|\band\b|\bor\b|;/).map((t) => t.trim())) {
      if (CATEGORY_ID.test(token)) out.push(token);
    }
  }
  return out;
}

function namesId(elsewhere: string, id: string): boolean {
  return idsNamedIn(elsewhere).includes(id);
}

function load(): Loaded {
  const text = readFileSync(new URL("./categories.json", import.meta.url), "utf8");
  const { reg, problems } = checked(JSON.parse(text) as unknown);
  if (problems.length > 0) {
    throw new Error(`the category register breaks ${problems.length} rule(s):\n  ${problems.join("\n  ")}`);
  }
  return reg;
}

const LOADED = load();

/** The register as released: its version, licence and every entry in presentation order. */
export const REGISTER = {
  version: LOADED.version,
  licence: LOADED.licence,
  categories: LOADED.categories as readonly Category[],
};

const BY_ID = new Map(LOADED.categories.map((c) => [c.id, c]));
const ORDER = new Map(LOADED.categories.map((c, i) => [c.id, i]));
const CHILDREN = Map.groupBy(LOADED.categories, (c) => c.parent);
// Every line reaches a top: loading refused the register otherwise.
const PATHS = new Map(LOADED.categories.map((c) => [c.id, lineOf(c, BY_ID) ?? []]));
const SUBTREES = new Map<string, string[]>();
function collect(id: string): string[] {
  const cached = SUBTREES.get(id);
  if (cached) return cached;
  const out = [id, ...(CHILDREN.get(id) ?? []).flatMap((k) => collect(k.id))];
  SUBTREES.set(id, out);
  return out;
}
for (const c of LOADED.categories) collect(c.id);

export function category(id: string): Category | undefined {
  return BY_ID.get(id);
}

/** The categories directly below `id`, or the top categories for null, in presentation order. */
export function childrenOf(id: string | null): readonly Category[] {
  return CHILDREN.get(id) ?? [];
}

/**
 * The outline an agent reads first: every top category, and the categories directly
 * below the ones the register opens (outline_opens), which is artificial
 * intelligence, the area most SPACES are about. GET /v1/categories answers with it
 * and /llms.txt lists it.
 */
export const OUTLINE: readonly { top: Category; opened: readonly Category[] }[] = childrenOf(null).map((top) => ({
  top,
  opened: LOADED.outlineOpens.includes(top.id) ? childrenOf(top.id) : [],
}));

/** The top category first and `id` itself last; empty for an id the register does not have. */
export function pathOf(id: string): readonly Category[] {
  return PATHS.get(id) ?? [];
}

/** 1 for a top category. */
export function depthOf(id: string): number {
  return pathOf(id).length;
}

/**
 * The id itself and every id below it, retired ones included: a SPACE filed under an
 * entry before it retired is still in the categories above it. Empty for an unknown id.
 */
export function subtree(id: string): readonly string[] {
  return SUBTREES.get(id) ?? [];
}

/** Whether `inner` is `outer` or lies below it. */
export function within(inner: string, outer: string): boolean {
  return pathOf(inner).some((c) => c.id === outer);
}

/**
 * Every id paired with itself and each category above it, as two parallel lists, so
 * one query can count the SPACES in a category and everything below it, each SPACE
 * once however many of its categories fall inside.
 */
export function rollUp(): { ids: string[]; into: string[] } {
  const ids: string[] = [];
  const into: string[] = [];
  for (const c of LOADED.categories) {
    for (const above of pathOf(c.id)) {
      ids.push(c.id);
      into.push(above.id);
    }
  }
  return { ids, into };
}

/**
 * Every category a SPACE filed under `ids` is in: each id and every category above
 * it, and of those the ones that come from the first id, its main one. What the
 * database keeps in space_categories, so a filter by any category is one equality.
 */
export function underOf(ids: readonly string[]): { under: string[]; main: string[] } {
  const under = new Set<string>();
  for (const id of ids) for (const c of pathOf(id)) under.add(c.id);
  return { under: [...under], main: ids.length ? pathOf(ids[0]!).map((c) => c.id) : [] };
}

/** Where to file instead of a retired entry: its successor, or else its parent. */
export function successorOf(id: string): string | null {
  const c = BY_ID.get(id);
  if (!c || c.status !== "retired") return null;
  return c.replaced_by ?? c.parent;
}

// ── the lookup ───────────────────────────────────────────────────────────────
//
// The ranks the category research tested (docs/research/category-agreement.md, "The
// lookup"), reproduced exactly; the test holds both to the same hundred names.
// Best first:
//   100 the id                          95 the label
//    90 an alias                         70 an example
//    50 a word-start prefix of an id, label or alias (queries of three or more characters)
//    45 every word of the query among the id, label, aliases and examples
//    40 the query shortened: its last words dropped until an id, label or alias matches
//    30 every word of the query in the description
// Ties go to active entries, then the shorter key, then register order. At most ten.
// When nothing reaches 30 the lookup is a miss, answered with nearest().
//
// A lookup is keyless and served outside every read ceiling, so it is kept cheap: one
// pass over the register for the strong tiers and one for the weak ones, and for the
// shortened tier one read of NAMED, a map built at load, per word dropped. Only the
// first LOOKUP_WORDS words of a name are read. And an answer is remembered, the last
// LOOKUPS_KEPT of them, since the register cannot change while the process runs.

type LookupMatch = {
  id: string;
  score: number;
  /** id, label, alias, example; "<kind> prefix"; "every word"; "shortened"; "description". */
  matched: string;
  /** The key that matched, normalised. For a shortened query, the words that were kept. */
  key: string;
};

/** NFKD, marks and apostrophes dropped, lower case, anything but letters, digits,
 *  + # and . made a space, spaces collapsed. */
export function normalise(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’‘`]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** The words of a text. A dot that ends a word is punctuation ("Rust." or "vLLM."),
 *  not part of a name; names keep theirs inside ("llama.cpp"). */
function words(text: string): string[] {
  return normalise(text).split(" ").map((w) => w.replace(/\.+$/, "")).filter(Boolean);
}

/** The most words of a name a lookup reads. */
export const LOOKUP_WORDS = 8;

/** How many words a name is, as the lookup counts them: a hyphen, a slash or a comma
 *  ends a word as a space does. */
export function lookupWordCount(text: string): number {
  return normalise(text).split(" ").filter(Boolean).length;
}

const LOOKUPS_KEPT = 2000;
const looked = new Map<string, LookupMatch[]>();

type Key = { kind: "id" | "label" | "alias" | "example"; text: string };
type Keyed = { c: Category; order: number; keys: Key[]; pool: Set<string>; said: Set<string> };

const KEYED: Keyed[] = LOADED.categories.map((c, order) => {
  const keys: Key[] = [
    { kind: "id", text: normalise(c.id) },
    { kind: "label", text: normalise(c.label) },
    ...c.aliases.map((a) => ({ kind: "alias" as const, text: normalise(a) })),
    ...c.examples.map((x) => ({ kind: "example" as const, text: normalise(x) })),
  ];
  return { c, order, keys, pool: new Set(keys.flatMap((k) => words(k.text))), said: new Set(words(c.description)) };
});

/** The entries each normalised id, label and alias names, in register order: what a
 *  shortened query has to equal. */
const NAMED = new Map<string, Keyed[]>();
for (const e of KEYED) {
  for (const k of e.keys) {
    if (k.kind === "example") continue;
    const named = NAMED.get(k.text);
    if (!named) NAMED.set(k.text, [e]);
    else if (named.at(-1) !== e) named.push(e);
  }
}

const EXACT: Record<Key["kind"], number> = { id: 100, label: 95, alias: 90, example: 70 };

function better(best: LookupMatch | null, score: number, key: string): boolean {
  return !best || score > best.score || (score === best.score && key.length < best.key.length);
}

/** The strong tiers: exact keys, and word-start prefixes for three characters or more.
 *  `wordStart` is the query after a space, where a later word of a key begins. */
function strong(e: Keyed, q: string, wordStart: string): LookupMatch | null {
  let best: LookupMatch | null = null;
  for (const k of e.keys) {
    if (k.text === q) {
      if (better(best, EXACT[k.kind], k.text)) best = { id: e.c.id, score: EXACT[k.kind], matched: k.kind, key: k.text };
    } else if (q.length >= 3 && k.kind !== "example" && (k.text.startsWith(q) || k.text.includes(wordStart)) && better(best, 50, k.text)) {
      best = { id: e.c.id, score: 50, matched: `${k.kind} prefix`, key: k.text };
    }
  }
  return best;
}

function weak(e: Keyed, qWords: string[]): LookupMatch | null {
  if (!qWords.length) return null;
  // The label, normalised, is always the second key.
  const label = e.keys[1]!.text;
  if (qWords.every((w) => e.pool.has(w))) return { id: e.c.id, score: 45, matched: "every word", key: label };
  if (qWords.every((w) => e.said.has(w))) return { id: e.c.id, score: 30, matched: "description", key: label };
  return null;
}

/**
 * Up to ten categories for a name, best first; empty when nothing reaches 30.
 * With `under`, only that category and those below it are considered.
 */
export function lookup(text: string, under?: string): LookupMatch[] {
  const q = normalise(text).split(" ").slice(0, LOOKUP_WORDS).join(" ");
  if (!q) return [];
  const key = `${under ?? ""}|${q}`;
  const kept = looked.get(key);
  if (kept) return kept;
  const found = lookupNow(q, under);
  if (looked.size >= LOOKUPS_KEPT) looked.delete(looked.keys().next().value!);
  looked.set(key, found);
  return found;
}

function lookupNow(q: string, under: string | undefined): LookupMatch[] {
  const inside = under === undefined ? null : new Set(subtree(under));
  const entries = inside ? KEYED.filter((e) => inside.has(e.c.id)) : KEYED;
  const qWords = words(q);
  const found = new Map<string, { m: LookupMatch; e: Keyed }>();
  const offer = (e: Keyed, m: LookupMatch | null) => {
    if (!m) return;
    const had = found.get(e.c.id);
    if (!had || better(had.m, m.score, m.key)) found.set(e.c.id, { m, e });
  };
  const wordStart = ` ${q}`;
  for (const e of entries) offer(e, strong(e, q, wordStart));
  // The query shortened: drop trailing words until what is left is an id, a label or
  // an alias, so a version such as "claude 3 opus" or "gpt 4.5 preview" finds its
  // family. Tried only when no strong tier matched, which is while nothing is found.
  if (found.size === 0) {
    const ws = q.split(" ");
    for (let k = ws.length - 1; k >= 1 && found.size === 0; k--) {
      const shorter = ws.slice(0, k).join(" ");
      for (const e of NAMED.get(shorter) ?? []) {
        if (!inside || inside.has(e.c.id)) offer(e, { id: e.c.id, score: 40, matched: "shortened", key: shorter });
      }
    }
  }
  for (const e of entries) offer(e, weak(e, qWords));
  return [...found.values()]
    .filter((f) => f.m.score >= 30)
    .sort((x, y) =>
      y.m.score - x.m.score ||
      (x.e.c.status === "active" ? 0 : 1) - (y.e.c.status === "active" ? 0 : 1) ||
      x.m.key.length - y.m.key.length ||
      x.e.order - y.e.order)
    .slice(0, 10)
    .map((f) => f.m);
}

function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

/** How many ids a miss or a refusal suggests. */
const SUGGESTED = 3;

/**
 * The nearest active ids to a word that matched nothing: an edit distance of at most
 * 1 under seven characters, 2 otherwise.
 */
export function nearest(text: string): string[] {
  const q = normalise(text).replace(/ /g, "-");
  if (!q) return [];
  const max = q.length < 7 ? 1 : 2;
  return KEYED
    .filter((e) => e.c.status === "active" && editDistanceWithin(q, e.c.id, max))
    .sort((a, b) => a.c.id.length - b.c.id.length || a.order - b.order)
    .slice(0, SUGGESTED)
    .map((e) => e.c.id);
}

/**
 * What to suggest for an id that is not a category, or not one a SPACE can be filed
 * under: the lookup's best active answers for the same words, then the nearest ids by
 * spelling. A retired answer is replaced by where its filings go now.
 */
export function suggestionsFor(text: string): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id) && BY_ID.get(id)?.status === "active") out.push(id);
  };
  for (const m of lookup(text)) {
    add(successorOf(m.id) ?? m.id);
    if (out.length >= SUGGESTED) return out;
  }
  for (const id of nearest(text)) add(id);
  return out.slice(0, SUGGESTED);
}

/**
 * Every id for a client completing one, best first: an exact id, then ids starting
 * with the prefix, then ids where a word of the label or an alias starts with it, then
 * any id containing it; active before retired and shallower before deeper within each.
 * The top categories when nothing was typed.
 */
export function idsStartingWith(prefix: string): string[] {
  const p = normalise(prefix);
  if (!p) return childrenOf(null).map((c) => c.id);
  const hyphened = p.replace(/ /g, "-");
  const wordStart = ` ${p}`;
  const rank = (e: Keyed): number => {
    if (e.c.id === hyphened) return 0;
    if (e.c.id.startsWith(hyphened)) return 1;
    if (e.keys.some((k) => (k.kind === "label" || k.kind === "alias") && (k.text.startsWith(p) || k.text.includes(wordStart)))) return 2;
    if (e.c.id.includes(hyphened)) return 3;
    return -1;
  };
  return KEYED.map((e) => ({ e, r: rank(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) =>
      a.r - b.r ||
      (a.e.c.status === "active" ? 0 : 1) - (b.e.c.status === "active" ? 0 : 1) ||
      depthOf(a.e.c.id) - depthOf(b.e.c.id) ||
      a.e.order - b.e.order)
    .map((x) => x.e.c.id);
}

/** The register's presentation order, for sorting ids a caller sent. */
export function orderOf(id: string): number {
  return ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}
