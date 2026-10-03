// Categories: the register every SPACE is filed under, the lookup that places a
// name in it, the two routes that teach it, and filing a SPACE.
//
// The register's rules are checked against registers broken on purpose, one rule
// each; the lookup against a hundred recorded names with their answers pinned;
// and the routes against a database holding private, public, closed and withheld
// SPACES, so a count is held to exactly what the filter pages through.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { useService, app, db, fixture, config, send, agent, type Agent, type Caller } from "./lib/service.ts";
import { titled } from "./helpers.ts";
import type { Db } from "../src/db/sql.ts";
import { createApp } from "../src/http/app.ts";
import { CATEGORY_LOOKUPS_PER_MINUTE } from "../src/http/ratelimit.ts";
import { ApiError, renderableDetail } from "../src/db/errors.ts";
import {
  REGISTER,
  childrenOf,
  lookup,
  nearest,
  registerProblems,
  subtree,
} from "../src/surface/categories.ts";
import { categoriesFor, optionalCategories, requireCategories, requireCategoryFilter } from "../src/domain/validate.ts";

const RAW = JSON.parse(readFileSync(new URL("../src/surface/categories.json", import.meta.url), "utf8"));
const IDS: string[] = JSON.parse(readFileSync(new URL("./fixtures/category-ids.json", import.meta.url), "utf8"));
const LOOKUPS: { name: string; kind: string; expected: string[]; answer: { id: string; score: number }[] }[] =
  JSON.parse(readFileSync(new URL("./fixtures/category-lookups.json", import.meta.url), "utf8"));

// ── the register ─────────────────────────────────────────────────────────────

describe("the register keeps its rules", () => {
  test("the released register breaks none", () => {
    assert.deepEqual(registerProblems(RAW), []);
    assert.equal(REGISTER.categories.length, 546);
    assert.equal(childrenOf(null).length, 13);
    assert.equal(REGISTER.licence, "CC0-1.0");
  });

  /** A copy of the register with one entry changed, found by id. */
  function broken(change: (r: any, at: (id: string) => any) => void): string[] {
    const r = structuredClone(RAW);
    change(r, (id: string) => r.categories.find((c: any) => c.id === id));
    return registerProblems(r);
  }
  const BEL = String.fromCharCode(7);

  const cases: [string, (r: any, at: (id: string) => any) => void, RegExp][] = [
    ["an id used twice", (r, at) => r.categories.push(structuredClone(at("claude-code"))), /claude-code: id used twice/],
    ["an id outside the grammar", (_, at) => { at("claude-code").id = "Claude_Code"; }, /Claude_Code: id breaks the grammar/],
    ["a parent that does not exist", (_, at) => { at("claude-code").parent = "nowhere"; }, /parent nowhere does not exist/],
    ["parents that never reach a top", (_, at) => { at("agents").parent = "coding-agents"; }, /never reach a top category/],
    ["five levels in artificial intelligence",
      (r) => r.categories.push({ ...structuredClone(RAW.categories.find((c: any) => c.id === "claude-code")), id: "claude-code-hooks", label: "Hooks", parent: "claude-code", aliases: [], examples: [] }),
      /claude-code-hooks: depth 5 is deeper than 4/],
    ["three levels in science",
      (r) => r.categories.push({ id: "millennium-prize-problems", label: "Millennium Prize Problems", parent: "mathematics", description: "The seven problems.", elsewhere: "", examples: [], aliases: [], status: "active", since: "2026-09-18" }),
      /millennium-prize-problems: depth 3 is deeper than 2/],
    ["four levels under programming languages",
      (r) => r.categories.push({ id: "django", label: "Django", parent: "python", description: "A web framework.", elsewhere: "", examples: [], aliases: [], status: "active", since: "2026-09-18" }),
      /django: depth 4 is deeper than 3/],
    ["an alias that is another entry's id", (_, at) => { at("claude-code").aliases.push("cursor"); }, /alias "cursor" is cursor's id/],
    ["an alias that is another entry's label", (_, at) => { at("claude-code").aliases.push("Codex"); }, /alias "Codex" is the label of openai-codex/],
    ["an alias two entries share", (_, at) => { at("cursor").aliases.push("Claude Code CLI"); }, /alias "Claude Code CLI" is also/],
    ["a label twice among siblings", (_, at) => { at("cursor").label = "Claude Code"; }, /label "Claude Code" repeats among its siblings/],
    ["a label shared by two entries that do not name each other", (_, at) => { at("python").label = "Mathematics"; },
      /label "mathematics" is shared by .* whose goes-elsewhere notes must name each other/],
    ["a named entry with no homepage", (_, at) => { delete at("claude-code").homepage; }, /claude-code: a named entry needs an https homepage/],
    ["a homepage that is not https", (_, at) => { at("claude-code").homepage = "http://example.com"; }, /claude-code: homepage is not an https address/],
    ["a retired entry sent to a retired one", (_, at) => { at("roo-code").replaced_by = "chatgpt-agent"; }, /replaced_by chatgpt-agent is not another active entry/],
    ["an active entry naming a replacement", (_, at) => { at("cursor").replaced_by = "cline"; }, /cursor: only a retired entry names a replacement/],
    ["a description over 300 bytes", (_, at) => { at("cursor").description = "x".repeat(301); }, /cursor: description is over 300 bytes/],
    ["a control character", (_, at) => { at("cursor").label = `Cur${BEL}sor`; }, /cursor: control character in label/],
    ["a description that is two lines", (_, at) => { at("cursor").description = "One line.\nTwo lines."; }, /cursor: control character in description/],
    ["a description with a double space", (_, at) => { at("cursor").description = "One  line."; }, /cursor: description is not one clean line/],
    ["an entry called Other", (_, at) => { at("cursor").label = "Other"; }, /no entry is called Other/],
    ["no description", (_, at) => { at("cursor").description = ""; }, /cursor: no description/],
    ["an example that is one word of a general category's label", (_, at) => { at("cursor").examples.push("memory"); },
      /cursor: example "memory" is a word of memory-and-context's label/],
    ["an example three entries share", (_, at) => { for (const id of ["cursor", "cline", "claude-code"]) at(id).examples.push("tab completion race"); },
      /example "tab completion race" is shared by/],
    ["a goes-elsewhere note naming no id", (_, at) => { at("cursor").elsewhere = "Terminal agents: not-an-entry."; }, /cursor: elsewhere names not-an-entry, which is not an id/],
    ["a type the register does not have", (_, at) => { at("cursor").type = "gadget"; }, /cursor: type gadget is not one the register has/],
    ["a since that names no release", (_, at) => { at("cursor").since = "2020-01-01"; }, /cursor: since names no release/],
    ["an outline opening an unknown id", (r) => { r.outline_opens = ["nowhere"]; }, /outline_opens names nowhere/],
    ["a wikidata id of the wrong shape", (_, at) => { at("mathematics").wikidata = "395"; }, /mathematics: wikidata is not a Q-number/],
  ];
  for (const [what, change, expect] of cases) {
    test(`refuses ${what}`, () => {
      const problems = broken(change);
      assert.ok(problems.some((p) => expect.test(p)), `expected ${expect} in:\n${problems.join("\n")}`);
    });
  }

  test("every id released is still there, and no id is missing from the list of them", () => {
    // test/fixtures/category-ids.json is append-only: an id never changes and never
    // goes away, because SPACES and agents hold it.
    const now = new Set(REGISTER.categories.map((c) => c.id));
    for (const id of IDS) assert.ok(now.has(id), `${id} was released and is gone`);
    assert.deepEqual(REGISTER.categories.map((c) => c.id).filter((id) => !IDS.includes(id)), [],
      "a new id must be appended to test/fixtures/category-ids.json");
  });
});

// ── the lookup ───────────────────────────────────────────────────────────────

describe("the lookup", () => {
  test("answers each of the hundred recorded names exactly as the fixture says", () => {
    for (const n of LOOKUPS) {
      assert.deepEqual(lookup(n.name).map((m) => ({ id: m.id, score: m.score })), n.answer, n.name);
    }
  });

  // The answers above are pinned, and are written again when the ranking changes on
  // purpose; this holds whatever they become to each name's expected ids.
  test("finds every named thing first, renamed and retired ones included, and answers nothing for the two with no home", () => {
    const named = LOOKUPS.filter((n) => n.kind === "named");
    assert.equal(named.length, 70);
    for (const n of named) {
      if (n.expected.length === 0) assert.deepEqual(lookup(n.name), [], n.name);
      else assert.ok(n.expected.includes(lookup(n.name)[0]!.id), `${n.name} → ${lookup(n.name)[0]?.id}`);
    }
  });

  test("a name two entries share returns both homes", () => {
    const comet = lookup("comet").map((m) => m.id);
    assert.ok(comet.includes("comet-browser") && comet.includes("comet-ml"), comet.join(","));
  });

  test("a renamed product finds its entry by the old name", () => {
    assert.equal(lookup("Windsurf")[0]?.id, "devin-desktop");
    assert.equal(lookup("LMArena")[0]?.id, "lmarena");
  });

  test("a lookup under a branch stays inside it", () => {
    const inside = new Set(subtree("training"));
    const found = lookup("fine-tuning", "training");
    assert.ok(found.length > 0);
    for (const m of found) assert.ok(inside.has(m.id), m.id);
  });

  test("nearest names ids a spelling away, active ones only", () => {
    assert.deepEqual(nearest("claude-kode"), ["claude-code"]);
    assert.ok(!nearest("roo-cod").includes("roo-code"));
  });
});

// ── filing a SPACE ───────────────────────────────────────────────────────────

describe("the categories a SPACE is filed under", () => {
  function refusal(fn: () => unknown): { code: string; detail: string | undefined } {
    try {
      fn();
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return { code: error.code, detail: error.detail };
    }
    assert.fail("expected a refusal");
  }

  test("takes one to three, the main one first, in the order sent", () => {
    assert.deepEqual(requireCategories(["claude-code", "python"]), ["claude-code", "python"]);
    assert.deepEqual(requireCategories(["this-service"]), ["this-service"]);
  });

  test("refuses each thing wrong, in order, naming it", () => {
    const cases: [unknown, RegExp][] = [
      [undefined, /required/],
      [[], /one to 3/],
      [["a", "b", "c", "d"], /one to 3/],
      ["coding-agents", /one to 3/],
      [[7], /an id, as text/],
      [["Coding Agents"], /lowercase words/],
      [["claude-kode"], /claude-kode is not a category. Nearest: .*claude-code/],
      [["roo-code"], /roo-code is retired. File under cline instead/],
      [["chatgpt-agent"], /chatgpt-agent is retired. File under computer-use instead/],
      [["python", "python"], /python is listed twice/],
      [["agents", "claude-code"], /claude-code is inside agents. List only claude-code/],
    ];
    for (const [value, expect] of cases) {
      const { code, detail } = refusal(() => requireCategories(value));
      assert.equal(code, "INVALID_CATEGORY", String(value));
      assert.match(detail ?? "", expect, String(value));
      assert.equal(renderableDetail(detail), detail, `the detail for ${String(value)} must survive the renderer`);
    }
  });

  test("a public SPACE needs one to three; a private or sealed one may have none", () => {
    for (const visibility of ["private", "sealed"]) {
      assert.deepEqual(categoriesFor(visibility, undefined), [], visibility);
      assert.deepEqual(categoriesFor(visibility, null), [], visibility);
      assert.deepEqual(categoriesFor(visibility, []), [], visibility);
      assert.deepEqual(categoriesFor(visibility, ["claude-code", "python"]), ["claude-code", "python"], visibility);
      // What it does send is checked as strictly as a public SPACE's.
      assert.match(refusal(() => categoriesFor(visibility, ["roo-code"])).detail ?? "", /roo-code is retired/);
      assert.match(refusal(() => categoriesFor(visibility, ["a", "b", "c", "d"])).detail ?? "", /one to 3/);
    }
    // A public SPACE, an oracle space among them, is refused exactly as requireCategories refuses it.
    for (const value of [undefined, null, [], ["nowhere-at-all"]]) {
      assert.deepEqual(refusal(() => categoriesFor("public", value)), refusal(() => requireCategories(value)), String(value));
    }
  });

  test("never empties a SPACE's categories, and absent leaves them alone", () => {
    assert.equal(optionalCategories(undefined), null);
    assert.equal(refusal(() => optionalCategories([])).code, "INVALID_CATEGORY");
  });

  test("the longest refusal still reaches the agent whole", () => {
    // The renderer drops a detail over 200 characters entirely, so the nearest ids
    // are added only while they fit.
    const longest = `${"a".repeat(30)}-${"b".repeat(33)}`;
    assert.equal(longest.length, 64);
    for (const value of [[longest], ["agent-frameworks-and-sdks-and-harnesses-and-runtimes-and-more-x"], ["claude-code-x"]]) {
      const { detail } = refusal(() => requireCategories(value));
      assert.ok(detail !== undefined && renderableDetail(detail) === detail, String(detail));
    }
  });

  test("a filter is a category, a retired one too, and an unknown id is refused", () => {
    assert.equal(requireCategoryFilter(undefined), null);
    assert.equal(requireCategoryFilter(" "), null);
    assert.equal(requireCategoryFilter("coding-agents")?.id, "coding-agents");
    assert.equal(requireCategoryFilter("roo-code")?.status, "retired");
    assert.equal(refusal(() => requireCategoryFilter("nowhere-at-all")).code, "INVALID_CATEGORY");
  });
});

// ── the routes ───────────────────────────────────────────────────────────────

before(() => {
  process.env.PUBLIC_SPACE_MIN_KEY_AGE_HOURS = "0";
});
useService("categories");

// Sent as it is, with no category added to a new SPACE, since this file files its
// own; and read leniently, since not every answer here is JSON.
async function call(method: string, path: string, who: Caller = null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await send(app, method, path, who, method === "POST" && path.endsWith("/posts") ? titled(body) : body, headers);
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed, headers: res.headers };
}

describe("GET /v1/categories", () => {
  test("the outline is every top category and the areas of artificial intelligence", async () => {
    const r = await call("GET", "/v1/categories");
    assert.equal(r.status, 200);
    assert.equal(r.body.version, REGISTER.version);
    assert.equal(r.body.licence, "CC0-1.0");
    assert.deepEqual(r.body.rules.per_space, { min: 1, max: 3 });
    assert.match(r.body.rules.required, /^A public SPACE.*A private or sealed SPACE may have none/);
    const ids = r.body.categories.map((c: any) => c.id);
    assert.deepEqual(ids.filter((id: string) => childrenOf(null).some((t) => t.id === id)), childrenOf(null).map((t) => t.id));
    for (const area of childrenOf("artificial-intelligence")) assert.ok(ids.includes(area.id), area.id);
    assert.equal(ids.length, 13 + childrenOf("artificial-intelligence").length);
    assert.equal(r.body.categories[0].description, undefined, "the outline carries no descriptions");
    assert.equal(r.body.categories[0].children, childrenOf(r.body.categories[0].id).length);
  });

  test("a branch is what is below one category, as deep as asked", async () => {
    const one = await call("GET", "/v1/categories?under=agents");
    assert.deepEqual(one.body.categories.map((c: any) => c.id), childrenOf("agents").map((c) => c.id));
    assert.deepEqual(one.body.under.path.map((p: any) => p.id), ["artificial-intelligence", "agents"]);
    const two = await call("GET", "/v1/categories?under=agents&depth=2");
    assert.deepEqual(new Set(two.body.categories.map((c: any) => c.id)), new Set(subtree("agents").filter((id) => id !== "agents")));
  });

  test("four levels from the top is every id once, in presentation order", async () => {
    const r = await call("GET", "/v1/categories?depth=4&detail=full");
    const ids = r.body.categories.map((c: any) => c.id);
    assert.deepEqual(ids, REGISTER.categories.map((c) => c.id));
    const cc = r.body.categories.find((c: any) => c.id === "claude-code");
    assert.equal(cc.type, "tool");
    assert.ok(cc.description.length > 20);
    assert.ok(Array.isArray(cc.examples) && Array.isArray(cc.aliases));
    assert.match(cc.homepage, /^https:\/\//);
  });

  test("a name is looked up, best first, each with its path", async () => {
    const r = await call("GET", "/v1/categories?q=Windsurf");
    assert.equal(r.body.matches[0].id, "devin-desktop");
    assert.equal(r.body.matches[0].matched, "alias");
    assert.deepEqual(r.body.matches[0].path.map((p: any) => p.id), ["artificial-intelligence", "agents", "coding-agents", "devin-desktop"]);
    const retired = await call("GET", "/v1/categories?q=Roo%20Cline");
    assert.equal(retired.body.matches[0].id, "roo-code");
    assert.equal(retired.body.matches[0].replaced_by, "cline");
  });

  test("a miss answers no matches and the nearest ids", async () => {
    const r = await call("GET", "/v1/categories?q=claude-kode");
    // "claude kode" shortened finds Claude, so this is no miss; a word nothing holds is,
    // and one a letter from an id names that id.
    assert.ok(r.body.matches.length > 0);
    const miss = await call("GET", "/v1/categories?q=pythn");
    assert.deepEqual(miss.body.matches, []);
    assert.ok(miss.body.nearest.includes("python"), JSON.stringify(miss.body.nearest));
  });

  test("refuses what it cannot answer, naming the parameter", async () => {
    for (const [path, detail] of [
      ["/v1/categories?depth=5", /depth/],
      ["/v1/categories?depth=two", /depth/],
      ["/v1/categories?detail=everything", /detail/],
      ["/v1/categories?counts=yes", /counts/],
      ["/v1/categories?q=claude&depth=2", /takes no depth/],
      [`/v1/categories?q=${"a".repeat(101)}`, /100 bytes/],
      ["/v1/categories?q=one%20two%20three%20four%20five%20six%20seven%20eight%20nine", /8 words/],
      // Counted as the lookup counts them: a hyphen ends a word, so fifty letters
      // joined by hyphens are fifty words, which is fifty passes over the register.
      [`/v1/categories?q=${Array.from({ length: 50 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("-")}`, /8 words/],
    ] as const) {
      const r = await call("GET", path);
      assert.equal(r.status, 400, path);
      assert.equal(r.body.error.code, "INVALID_REQUEST", path);
      assert.match(r.body.error.detail, detail, path);
    }
    const unknown = await call("GET", "/v1/categories?under=nowhere-at-all");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "CATEGORY_NOT_FOUND");
  });

  test("an empty value counts as absent", async () => {
    const r = await call("GET", "/v1/categories?under=&depth=&q=&detail=&counts=");
    const outline = await call("GET", "/v1/categories");
    assert.deepEqual(r.body, outline.body);
  });

  test("an ETag, and a 304 for a caller who holds it", async () => {
    const first = await call("GET", "/v1/categories?under=training");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const again = await app.request("/v1/categories?under=training", { headers: { "if-none-match": etag! } });
    assert.equal(again.status, 304);
  });

  test("answers as markdown when asked", async () => {
    const res = await app.request("/v1/categories", { headers: { accept: "text/markdown" } });
    const text = await res.text();
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(text, /Artificial intelligence — artificial-intelligence/);
    assert.match(text, /  - Agents — agents/);
    const one = await (await app.request("/v1/categories/roo-code", { headers: { accept: "text/markdown" } })).text();
    assert.match(one, /retired: file under Cline \(cline\) instead/);
  });
});

describe("GET /v1/categories/{id}", () => {
  test("one category: its path, what goes in and elsewhere, the categories below, and the filters", async () => {
    const r = await call("GET", "/v1/categories/coding-agents");
    assert.equal(r.status, 200);
    const c = r.body.category;
    assert.equal(c.id, "coding-agents");
    assert.deepEqual(c.path.map((p: any) => p.id), ["artificial-intelligence", "agents", "coding-agents"]);
    assert.ok(c.description && c.elsewhere);
    assert.deepEqual(c.children.map((k: any) => k.id), childrenOf("coding-agents").map((k) => k.id));
    assert.equal(c.filters.spaces, "/v1/spaces?category=coding-agents");
    assert.equal(c.filters.seek, "/v1/seek?category=coding-agents&q=");
  });

  test("a retired one says where its filings go now", async () => {
    const r = await call("GET", "/v1/categories/roo-code");
    assert.equal(r.body.category.status, "retired");
    assert.equal(r.body.category.replaced_by, "cline");
  });

  test("an unknown id is a 404 naming the nearest, and a malformed one names the shape", async () => {
    const r = await call("GET", "/v1/categories/claude-kode");
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, "CATEGORY_NOT_FOUND");
    assert.match(r.body.error.detail, /claude-kode is not a category. Nearest: .*claude-code/);
    const bad = await call("GET", "/v1/categories/Not_An_Id");
    assert.equal(bad.status, 404);
    assert.match(bad.body.error.detail, /lowercase words/);
    const long = await call("GET", `/v1/categories/${"a".repeat(80)}`);
    assert.equal(long.status, 404);
    assert.ok(long.body.error.detail);
  });
});

describe("filing, listing and counting", () => {
  let owner: Agent;
  before(async () => {
    owner = await agent();
    const make = async (name: string, categories: string[], visibility = "private") => {
      const r = await call("POST", "/v1/spaces", owner, { name, title: `The ${name} space`, categories, visibility });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body;
    };
    await make("cat-private", ["coding-agents"]);
    await make("cat-public", ["claude-code", "python"], "public");
    await make("cat-two-in-agents", ["coding-agents", "agent-frameworks"]);
    await make("cat-closed", ["coding-agents"]);
    await make("cat-withheld", ["claude-code"]);
    await make("cat-maths", ["mathematics"]);
    await fixture.owner`update schellingaf.spaces set status = 'closed' where name = 'cat-closed'`;
    await fixture.owner`
      insert into schellingaf.withheld_spaces (space_id, reason, note)
      select space_id, 'abuse', 'a test' from schellingaf.spaces where name = 'cat-withheld'`;
  });

  test("a SPACE is created with its categories, and they are public", async () => {
    const r = await call("POST", "/v1/spaces", owner, { name: "cat-echo", title: "Echo", categories: ["this-service"] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.categories, ["this-service"]);
    const profile = await call("GET", "/v1/spaces/cat-echo");
    assert.deepEqual(profile.body.categories, ["this-service"]);
  });

  test("creating a public SPACE or an oracle space without categories, or any SPACE with a wrong one, is refused before anything is written", async () => {
    const required = "categories is required: one to 3 category ids, the main one first";
    const list = "categories is a list of one to 3 category ids, the main one first";
    const cases: [Record<string, unknown>, string | null][] = [
      [{ visibility: "public" }, required],
      [{ visibility: "public", categories: [] }, list],
      [{ oracle: true }, required],
      [{ oracle: true, categories: [] }, list],
      [{ oracle: true, visibility: "public" }, required],
      [{ visibility: "public", join_policy: "open" }, required],
      [{ categories: ["roo-code"] }, null],
      [{ categories: ["agents", "claude-code"] }, null],
      [{ categories: ["nowhere-at-all"] }, null],
      [{ visibility: "public", categories: ["nowhere-at-all"] }, null],
    ];
    for (const [fields, detail] of cases) {
      const r = await call("POST", "/v1/spaces", owner, { name: "cat-never", title: "Never", ...fields });
      assert.equal(r.status, 400, JSON.stringify(fields));
      assert.equal(r.body.error.code, "INVALID_CATEGORY", JSON.stringify(fields));
      assert.equal(r.body.error.message, "INVALID_CATEGORY. That is not a category a space can be filed under.");
      if (detail !== null) assert.equal(r.body.error.detail, detail, JSON.stringify(fields));
    }
    const [row] = await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.spaces where name = 'cat-never'`;
    assert.equal(row!.n, 0);
  });

  test("a private SPACE may be created with no categories, and is then in no category", async () => {
    const absent = await call("POST", "/v1/spaces", owner, { name: "cat-none", title: "Filed nowhere" });
    assert.equal(absent.status, 201, JSON.stringify(absent.body));
    assert.equal(absent.body.visibility, "private");
    assert.deepEqual(absent.body.categories, []);
    const empty = await call("POST", "/v1/spaces", owner, { name: "cat-empty", title: "Filed nowhere either", categories: [], visibility: "private" });
    assert.equal(empty.status, 201, JSON.stringify(empty.body));
    assert.deepEqual(empty.body.categories, []);

    // Its profile, as JSON and as text, and the directory say none.
    for (const name of ["cat-none", "cat-empty"]) {
      const profile = await call("GET", `/v1/spaces/${name}`, owner);
      assert.equal(profile.status, 200);
      assert.deepEqual(profile.body.categories, []);
      const stranger = await call("GET", `/v1/spaces/${name}`);
      assert.deepEqual(stranger.body.categories, []);
      const text = await (await app.request(`/v1/spaces/${name}`, { headers: { accept: "text/markdown" } })).text();
      assert.doesNotMatch(text, /filed under/);
    }
    const directory = await call("GET", "/v1/spaces?limit=200", owner);
    const listed = directory.body.items.find((s: any) => s.name === "cat-none");
    assert.ok(listed, "the directory lists it");
    assert.deepEqual(listed.categories, []);

    // Its owner's own lists name it.
    const me = await call("GET", "/v1/me", owner);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.ok(me.body.spaces_owned.includes("cat-none") && me.body.spaces_owned.includes("cat-empty"), JSON.stringify(me.body.spaces_owned));

    // No category holds it: no filing row, no top category's list, and no category's SEEK,
    // though a SEEK with no category finds what is posted there.
    const [rows] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.space_categories where name in ('cat-none', 'cat-empty')`;
    assert.equal(rows!.n, 0);
    for (const top of childrenOf(null)) {
      const r = await call("GET", `/v1/spaces?category=${top.id}&limit=200`, owner);
      assert.ok(!r.body.items.some((s: any) => s.name === "cat-none" || s.name === "cat-empty"), top.id);
    }
    const posted = await call("POST", "/v1/spaces/cat-none/posts", owner, { kind: "obs", body: "wombat lanterns hum in the unfiled space", idempotency_key: "cat-none-1" });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    const found = await call("GET", "/v1/seek?q=wombat", owner);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.items.map((h: any) => h.space), ["cat-none"]);
    assert.deepEqual(found.body.hit_categories, []);
    for (const top of childrenOf(null)) {
      const kept = await call("GET", `/v1/seek?q=wombat&category=${top.id}`, owner);
      assert.equal(kept.status, 200, top.id);
      assert.deepEqual(kept.body.items, [], top.id);
    }

    // It can be filed later, and is then found by category like any other.
    const filed = await call("PATCH", "/v1/spaces/cat-empty", owner, { categories: ["mathematics"] });
    assert.equal(filed.body.changed, true, JSON.stringify(filed.body));
    const maths = await call("GET", "/v1/spaces?category=mathematics", owner);
    assert.ok(maths.body.items.some((s: any) => s.name === "cat-empty"));
    await call("PATCH", "/v1/spaces/cat-empty", owner, { categories: ["general"] });
  });

  test("a private SPACE with categories is filed as before", async () => {
    const r = await call("POST", "/v1/spaces", owner, { name: "cat-private-filed", title: "Filed", categories: ["python"], visibility: "private" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.categories, ["python"]);
    const listed = await call("GET", "/v1/spaces?category=python", owner);
    assert.ok(listed.body.items.some((s: any) => s.name === "cat-private-filed"));
  });

  test("a withheld SPACE's profile hides its categories with its words", async () => {
    const r = await call("GET", "/v1/spaces/cat-withheld");
    assert.equal(r.body.categories, null);
  });

  test("the list is limited to a category and everything below it", async () => {
    const agents = await call("GET", "/v1/spaces?category=agents");
    assert.deepEqual(agents.body.items.map((s: any) => s.name).sort(), ["cat-private", "cat-public", "cat-two-in-agents"]);
    const tool = await call("GET", "/v1/spaces?category=claude-code");
    assert.deepEqual(tool.body.items.map((s: any) => s.name), ["cat-public"]);
    assert.deepEqual(tool.body.items[0].categories, ["claude-code", "python"]);
    const none = await call("GET", "/v1/spaces?category=");
    assert.equal(none.status, 200);
    const unknown = await call("GET", "/v1/spaces?category=nowhere-at-all");
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, "INVALID_CATEGORY");
    const policy = await call("GET", "/v1/spaces?join_policy=anyone");
    assert.equal(policy.status, 400);
  });

  test("the oracle spaces are counted apart, each count exactly what the filter pages through, and the rest are work spaces", async () => {
    const made = await call("POST", "/v1/spaces", owner, { name: "cat-oracle", title: "An oracle", categories: ["claude-code"], oracle: true });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    // A process of its own, so the counts are taken now and not a minute ago.
    const fresh = createApp(config, db);
    const ask = async (path: string, headers: Record<string, string> = {}) => (await fresh.request(path, { headers }));
    const list = (await (await ask("/v1/categories?depth=4&counts=true")).json()) as any;
    assert.ok(list.counted_at);
    const byId = new Map<string, any>(list.categories.map((c: any) => [c.id, c]));
    for (const id of ["artificial-intelligence", "agents", "coding-agents", "claude-code", "agent-frameworks", "computing", "python", "science", "mathematics", "health-and-medicine"]) {
      const every = await call("GET", `/v1/spaces?category=${id}&limit=200`);
      const oracles = await call("GET", `/v1/spaces?category=${id}&oracle=true&limit=200`);
      assert.equal(byId.get(id).spaces, every.body.items.length, id);
      assert.equal(byId.get(id).oracle_spaces, oracles.body.items.length, id);
    }
    assert.deepEqual([byId.get("claude-code").spaces, byId.get("claude-code").oracle_spaces], [2, 1]);
    assert.deepEqual([byId.get("agents").spaces, byId.get("agents").oracle_spaces], [4, 1], "a SPACE filed twice inside agents counts once");
    assert.deepEqual([byId.get("mathematics").spaces, byId.get("mathematics").oracle_spaces], [1, 0]);
    // One category and the categories below it; a lookup; and neither field without counts.
    const agents = (await (await ask("/v1/categories/agents?counts=true")).json()) as any;
    assert.equal(agents.category.spaces, 4);
    assert.equal(agents.category.children.find((k: any) => k.id === "coding-agents").spaces, 4);
    const one = (await (await ask("/v1/categories/coding-agents?counts=true")).json()) as any;
    assert.equal(one.category.oracle_spaces, 1);
    assert.equal(one.category.children.find((k: any) => k.id === "claude-code").oracle_spaces, 1);
    const looked = (await (await ask("/v1/categories?q=claude%20code&counts=true")).json()) as any;
    assert.equal(looked.matches[0].oracle_spaces, 1);
    const plain = (await (await ask("/v1/categories/coding-agents")).json()) as any;
    assert.ok(!("spaces" in plain.category) && !("oracle_spaces" in plain.category));
    // As text, the share of oracle spaces is said where there is one.
    const text = await (await ask("/v1/categories/coding-agents?counts=true", { accept: "text/markdown" })).text();
    assert.match(text, /4 SPACE\(s\) here and below, 1 of them an oracle space, counted at/);
    assert.match(text, /- Claude Code — claude-code \([^)]*2 SPACE\(s\), 1 of them an oracle space\)/);
  });

  test("changing categories is an event; the same list is none, and a new order is one", async () => {
    await call("POST", "/v1/spaces", owner, { name: "cat-changes", title: "Changes", categories: ["python"] });
    const same = await call("PATCH", "/v1/spaces/cat-changes", owner, { categories: ["python"] });
    assert.equal(same.body.changed, false);
    const more = await call("PATCH", "/v1/spaces/cat-changes", owner, { categories: ["python", "mathematics"] });
    assert.equal(more.body.changed, true);
    const reordered = await call("PATCH", "/v1/spaces/cat-changes", owner, { categories: ["mathematics", "python"] });
    assert.equal(reordered.body.changed, true);
    const emptied = await call("PATCH", "/v1/spaces/cat-changes", owner, { categories: [] });
    assert.equal(emptied.body.error.code, "INVALID_CATEGORY");
    const events = await call("GET", "/v1/spaces/cat-changes/events", owner);
    const payloads = events.body.items.map((e: any) => [e.event, e.payload.categories]);
    assert.deepEqual(payloads.filter(([, c]: any) => c !== undefined), [
      ["space.created", ["python"]],
      ["space.updated", ["python", "mathematics"]],
      ["space.updated", ["mathematics", "python"]],
    ]);
  });

  test("the database takes only an id's shape, and nothing else", async () => {
    for (const bad of [["Not An Id"], ["a", "a"], ["a", "b", "c", "d"], [`${"a".repeat(65)}`]]) {
      await assert.rejects(
        fixture.owner`update schellingaf.spaces set categories = ${bad}::text[] where name = 'cat-maths'`,
        /spaces_categories_valid/,
        JSON.stringify(bad),
      );
    }
    await assert.rejects(
      fixture.owner`update schellingaf.spaces set categories = '{{a},{b}}'::text[] where name = 'cat-maths'`,
      /spaces_categories_valid/,
    );
    await assert.rejects(fixture.owner`update schellingaf.spaces set categories = null where name = 'cat-maths'`);
    // A shape-valid id the register does not have is the API's to refuse, not the database's.
    await fixture.owner`update schellingaf.spaces set categories = ${["some-future-id"]}::text[] where name = 'cat-maths'`;
    await fixture.owner`update schellingaf.spaces set categories = ${["mathematics"]}::text[] where name = 'cat-maths'`;
  });
});

describe("the floor", () => {
  test("never refused, however often one address asks", async () => {
    const answers = await Promise.all(Array.from({ length: 300 }, () => app.request("/v1/categories")));
    assert.deepEqual([...new Set(answers.map((r) => r.status))], [200]);
  });

  test("a name looked up, and an id that is none, are rationed per address; the rest of the register is not", async (t) => {
    // A lookup is a pass over the register each time it is new; an outline, a branch
    // and a category are built once and kept.
    //
    // The clock stands still at the start of a minute, so a slow machine cannot carry
    // the lookups across a minute's edge, where the window weighs the minute before
    // by how much of the new one is left and would admit the one it must refuse.
    t.mock.timers.enable({ apis: ["Date"], now: Math.floor(Date.now() / 60_000) * 60_000 });
    const from = { "x-forwarded-for": "198.51.100.77" };
    for (let i = 0; i < CATEGORY_LOOKUPS_PER_MINUTE; i++) {
      const r = await call("GET", `/v1/categories?q=qqzz${i}`, null, undefined, from);
      if (r.status !== 200) assert.fail(`lookup ${i} answered ${r.status}`);
    }
    for (const path of ["/v1/categories?q=vllm", "/v1/categories/not-a-category-at-all", "/v1/categories?under=nowhere-at-all"]) {
      const r = await call("GET", path, null, undefined, from);
      assert.equal(r.status, 429, path);
      assert.equal(r.body.error.code, "RATE_LIMITED", path);
    }
    for (const path of ["/v1/categories", "/v1/categories/vllm", "/v1/categories?under=agents&depth=2"]) {
      assert.equal((await call("GET", path, null, undefined, from)).status, 200, path);
    }
    // Another address is its own.
    assert.equal((await call("GET", "/v1/categories?q=vllm", null, undefined, { "x-forwarded-for": "198.51.100.78" })).status, 200);
  });

  test("twenty-five callers asking for counts at once make one query", async () => {
    let queries = 0;
    const counted: Db = { ...db, readTx: (peer, fn) => { queries += 1; return db.readTx(peer, fn); } };
    const fresh = createApp(config, counted);
    const answers = await Promise.all(Array.from({ length: 25 }, () => fresh.request("/v1/categories?counts=true")));
    assert.deepEqual([...new Set(answers.map((r) => r.status))], [200]);
    assert.equal(queries, 1);
  });
});
