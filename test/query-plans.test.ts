// The query plans the schema was shaped around, checked against real statistics:
// a plan that quietly became a sequential scan behaves perfectly with fifty rows
// and takes the service down on the day it has real traffic. So this file seeds
// a hundred thousand posts, analyses, and asserts the SHAPE of each plan.
//
// The statements the ROUTES send are captured and planned in route-plans.test.ts,
// which is where a route's read is checked. This file holds what a route cannot
// show: the row-level policy's SPACE set, the plans inside the seek functions,
// and what the plan cache does with those functions.
//
// The seek functions are SECURITY DEFINER, where EXPLAIN of a call sees only a
// function scan, so "the plans inside the seek functions" calls each function as
// the route calls it and reads the plan of the statement inside it from
// auto_explain. A copy of a body planned from literals certifies its author's
// intention, not the function. A copy's planner sees the query and a constant
// LIMIT, which the function's never does, so the copy's plan follows the term and
// the function's does not.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { SUPERUSER } from "./bootstrap.ts";
import { cloneDatabase, setUp, peerIdOf, publicKey, type Fixture } from "./helpers.ts";
import { CANDIDATES_PER_SPACE, CANDIDATES_TOTAL, PUBLIC_CANDIDATES, RANK_WORK } from "../src/http/seek.ts";
import {
  PUBLIC_PRINT_WINDOW,
  PUBLIC_RESULTS_PER_OWNER,
  PUBLIC_RESULTS_PER_SPACE,
  PUBLIC_TEXT_WINDOW,
} from "../src/http/postview.ts";

let fixture: Fixture;

/** Large enough that a sequential scan is never the cheapest plan, and large
 * enough that "the caller cannot see these" has to mean something: most of these
 * posts share the term the searches below look for. The million-row run belongs
 * on the server. */
const SPACES = 200;
const POSTS = 100_000;

let readerHex: string;
/** A KEY in one of those SPACES and nothing else: the caller a walk costs most. */
let memberHex: string;

const opened = setUp(async () => {
  fixture = await cloneDatabase("query_plans");
  const sql = fixture.owner;

  const readerKey = publicKey("plans-reader");
  readerHex = peerIdOf(readerKey);
  const memberKey = publicKey("plans-member");
  memberHex = peerIdOf(memberKey);

  await sql`select schellingaf.register_peer(${readerKey})`;
  await sql`select schellingaf.register_peer(${memberKey})`;

  // Two hundred SPACES owned by the reader, so caller_space_ids() returns a
  // realistic set rather than one row: the seek functions probe once per SPACE,
  // and a plan that is fine for one is not necessarily fine for two hundred.
  await sql`
    insert into schellingaf.spaces (name, owner_id, title, description)
    select 'plan-space-' || g, decode(${readerHex}, 'hex'), 'Space ' || g, 'seeded'
      from generate_series(1, ${SPACES}) g`;
  await sql`
    insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
    select s.space_id, decode(${memberHex}, 'hex'), 'reader', 'grant', s.owner_id, 0
      from schellingaf.spaces s where s.name = 'plan-space-1'`;

  // Posts written straight in rather than through append_post: a hundred thousand
  // function calls would take minutes and this file is about plans, not about
  // the write path, which test/concurrency.test.ts already covers.
  await sql`
    insert into schellingaf.posts
      (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id,
           row_number() over (partition by s.space_id order by g),
           0,
           decode(${readerHex}, 'hex'),
           (array['obs','result','fail','warn','dossier'])[1 + (g % 5)],
           'Seeded post ' || g,
           'ECONNREFUSED building src/main.rs with numpy==1.26.' || (g % 40) || ' on aarch64',
           sha256(('seed' || g)::bytea)
      from generate_series(1, ${POSTS}) g
      join lateral (
        select space_id from schellingaf.spaces
         where name = 'plan-space-' || (1 + (g % ${SPACES}))) s on true`;

  await sql`
    update schellingaf.spaces s
       set last_seq = (select count(*) from schellingaf.posts p where p.space_id = s.space_id)`;

  await sql`
    insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
    select p.post_id, p.space_id, 'git.commit',
           encode(sha256(p.post_id::text::bytea), 'hex')
      from schellingaf.posts p`;

  await sql`
    insert into schellingaf.post_search (post_id, space_id, tsv)
    select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body)
      from schellingaf.posts p`;

  // Without this every plan below is planned against zeroed statistics, and the
  // whole file would be asserting nothing.
  await sql`analyze schellingaf.posts, schellingaf.post_fingerprints,
                    schellingaf.post_search, schellingaf.spaces, schellingaf.memberships`;
});

after(async () => {
  await opened;
  await fixture.end();
});

/** EXPLAIN as the api role, with the caller bound the way readTx binds it: the
 * only role that sees the row-level policies in its plan. */
async function planAsApi(peerIdHex: string | null, run: (sql: any) => Promise<any[]>): Promise<string> {
  const rows = await fixture.asCaller(peerIdHex, run);
  return rows.map((r: any) => Object.values(r)[0]).join("\n");
}

describe("the plans every read depends on", () => {
  test("the caller's SPACE set is resolved once per statement, not once per row", async () => {
    // Every read of posts carries the row-level policy, `space_id IN (SELECT
    // caller_space_ids())`. A hashed SubPlan builds the set once, which makes the
    // policy's cost a constant; a per-row SubPlan builds it again for every row.
    const plan = await planAsApi(readerHex, (sql) => sql`
      explain (analyze)
      select count(*) from schellingaf.posts p
       where p.space_id in (select schellingaf.caller_space_ids())`);
    assert.match(plan, /\(hashed SubPlan \d+\)/, plan);
    assert.doesNotMatch(plan, /\(SubPlan \d+\)/, `the policy builds the caller's SPACES once per row:\n${plan}`);
  });
});

describe("the plans inside the seek functions", () => {
  type PlanNode = { [field: string]: any; Plans?: PlanNode[] };
  const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
  const FIELDS = ["Node Type", "Alias", "Index Name", "Index Cond", "Filter", "Rows Removed by Filter", "Actual Loops"];

  /**
   * The plan of the statement inside a seek function, with what each node did. The
   * function is called as the route calls it, as the api role with the caller bound,
   * and auto_explain logs the statements it runs; loading auto_explain takes a
   * superuser session. `body` picks the function's statement out of what is logged.
   */
  async function planInside(
    peerIdHex: string,
    body: RegExp,
    planCacheMode: string,
    call: (tx: postgres.TransactionSql) => Promise<unknown>,
  ): Promise<PlanNode> {
    const logged: string[] = [];
    const su = postgres({ ...SUPERUSER, database: fixture.name, onnotice: (n) => logged.push(n.message ?? "") });
    const settings = [
      "log_min_duration = 0",
      "log_nested_statements = on",
      "log_analyze = on",
      "log_timing = off",
      "log_format = json",
      "log_level = notice",
    ];
    try {
      await su`load 'auto_explain'`;
      for (const setting of settings) await su.unsafe(`set auto_explain.${setting}`);
      await su.begin(async (tx) => {
        await tx.unsafe("set local role schellingaf_api");
        await tx`select set_config('schellingaf.peer_id', ${peerIdHex}, true)`;
        await tx.unsafe(`set local plan_cache_mode = ${planCacheMode}`);
        await call(tx);
      });
    } finally {
      await su.end({ timeout: 5 });
    }
    const plans = logged
      .filter((m) => m.includes("{"))
      .map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
    const found = plans.find((p) => body.test(p["Query Text"]));
    assert.ok(found, `auto_explain logged no statement matching ${body}:\n${logged.join("\n")}`);
    return found.Plan;
  }

  /**
   * A kind or an author kept before the cut reaches posts one row at a time, by its
   * primary key: never a scan of posts, and never a hashed set of them, which would read
   * other SPACES' posts and make a SEEK's cost depend on them.
   */
  function postsByKeyOnly(nodes: PlanNode[], what: string): void {
    const posts = nodes.filter((n) => n["Relation Name"] === "posts");
    const shown = JSON.stringify(posts, [...FIELDS, "Parent Relationship"], 1);
    assert.ok(posts.length > 0, `${what}: the filter never reached posts`);
    assert.ok(
      posts.every((n) => n["Index Name"] === "posts_pkey" && /Index/.test(n["Node Type"]) && n["Parent Relationship"] === "SubPlan"),
      `${what}: posts read other than one row by its key:\n${shown}`,
    );
    // A filter may hash a small set of its own (a category's SPACES), never posts.
    const hashed = new Set(nodes.flatMap((n) => [...String(n["Filter"] ?? "").matchAll(/hashed (SubPlan \d+)/g)].map((m) => m[1])));
    assert.ok(!posts.some((n) => hashed.has(n["Subplan Name"])), `${what}: posts were hashed as a set:\n${shown}`);
  }

  // With no filter, and with a kind and an author, which 0136 keeps before the cut.
  const FILTERS: [string, string[] | null, string | null][] = [
    ["no filter", null, null],
    ["a kind and an author", ["result", "warn"], "00".repeat(32)],
  ];

  for (const [what, kinds, author] of FILTERS) test(`a fingerprint seek is one range probe per caller SPACE, ${what}`, async () => {
    const [target] = await fixture.owner<{ value: string }[]>`
      select value from schellingaf.post_fingerprints where scheme = 'git.commit' limit 1`;
    const value = target!.value;
    // The real seek_fingerprint, for the KEY in two hundred SPACES, as an exact
    // SEEK. It pins its own plan to the generic one; "what a seek costs when the
    // plan cache plans it" below is why. Seeded with scripts/seed.ts at a million
    // posts over ten thousand SPACES, a KEY in one SPACE got this same probe.
    const plan = await planInside(readerHex, /^\s*WITH mine AS/, "auto", (tx) => tx`
      select post_id::text from schellingaf.seek_fingerprint(
        ${"git.commit"}, ${value}, ${value + "\u0001"}, ${null}::uuid, ${10},
        ${PUBLIC_PRINT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER},
        ${null}::text, ${null}::boolean, ${kinds}::text[], decode(${author}::text, 'hex'))`);
    const nodes = nodesOf(plan);
    if (kinds !== null) postsByKeyOnly(nodes, what);
    const scans = nodes.filter((n) =>
      n["Actual Loops"] > 0 && (n["Relation Name"] === "post_fingerprints" || /fingerprints/.test(n["Index Name"] ?? "")));
    const shown = JSON.stringify(scans, FIELDS, 1);
    assert.ok(!scans.some((n) => n["Node Type"] === "Seq Scan"), `the function walks post_fingerprints:\n${shown}`);
    // The SPACE must be IN the index condition, not removed by a filter after
    // the fact. Anything else means the scan walked rows in SPACES the caller
    // cannot read, and the time a SEEK takes would depend on them.
    const probe = scans.find((n) => n["Index Name"] === "fingerprints_seek_idx");
    assert.match(probe?.["Index Cond"] ?? "", /space_id = /, `no probe of fingerprints_seek_idx by SPACE:\n${shown}`);
    assert.doesNotMatch(probe?.["Filter"] ?? "", /space_id/, shown);
    const joins = nodes.map((n) => n["Join Filter"]).filter((f) => f !== undefined);
    assert.ok(!joins.some((f) => /\bsid\b/.test(f)), `the caller's SPACE is a join filter: ${joins.join("; ")}`);
  });

  for (const [what, kinds] of FILTERS) test(`a fingerprint seek checks its rows newest first, only until the page is full, ${what}`, async () => {
    // Every post of plan-space-1 carries one value of a scheme of this test's own, and every
    // one is the reader's obs, so the checks keep each row they look at. They must run on
    // about p_limit rows, not on the SPACE's whole range: 0136 sorts the range from the index
    // alone and checks its rows above the sort, outside the subquery. Checks moved inside it
    // run on every row, and the cost of a SEEK follows the size of the caller's SPACES.
    await fixture.owner`
      insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
      select p.post_id, p.space_id, 'lazy.check', 'one-value'
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
       where s.name = 'plan-space-1'
      on conflict do nothing`;
    const [held] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.post_fingerprints f
       where f.scheme = 'lazy.check' and f.value = 'one-value'`;
    assert.ok(held!.n >= 100, `only ${held!.n} rows carry the value`);
    const plan = await planInside(readerHex, /^\s*WITH mine AS/, "auto", (tx) => tx`
      select post_id::text from schellingaf.seek_fingerprint(
        ${"lazy.check"}, ${"one-value"}, ${"one-value\u0001"}, ${null}::uuid, ${10},
        ${PUBLIC_PRINT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER},
        ${null}::text, ${null}::boolean, ${kinds === null ? null : ["obs"]}::text[],
        decode(${kinds === null ? null : readerHex}::text, 'hex'))`);
    const checks = nodesOf(plan).filter((n) =>
      n["Parent Relationship"] === "SubPlan" && ["posts", "withheld", "space_hidden"].includes(n["Relation Name"]));
    const shown = JSON.stringify(checks, [...FIELDS, "Relation Name"], 1);
    assert.ok(checks.some((n) => n["Actual Loops"] > 0), `${what}: no check ran:\n${shown}`);
    assert.ok(checks.every((n) => n["Actual Loops"] <= 20), `${what}: the checks ran on rows past the page, of ${held!.n}:\n${shown}`);
  });

  test("a text seek carries both the SPACE and the query into the index condition", async () => {
    // The real seek_text, for the KEY in one SPACE of five hundred posts, searching
    // for a word nothing holds: the case where a scan that walks the table reads all
    // of it. Under a custom and a generic plan, because the plan cache builds both.
    //
    // What passing certifies, and at what size. The per-SPACE LIMIT is a value the
    // planner cannot see, so it plans to read a tenth of the rows, and the query
    // comes from a CTE, so a match is priced at a default. A sequential scan's
    // tenth grows with the table; the index's price includes its pending list, up
    // to 1 MB, which every probe reads whole. So on a small table of few SPACES
    // with that list nearly full the function walks post_search. A young service
    // of a few SPACES may walk, at a cost that stays small because the table is.
    // This corpus is past the turn even with its pending list nearly full, as
    // writing it leaves it, so a walk here is a change in the function, not in the
    // table.
    for (const mode of ["force_custom_plan", "force_generic_plan"]) for (const [what, kinds, author] of FILTERS) {
      const plan = await planInside(memberHex, /^\s*WITH q AS/, mode, (tx) => tx`
        select post_id::text, score from schellingaf.seek_text(
          ${"quetzalcoatl"}, ${null}::uuid, ${CANDIDATES_PER_SPACE}, ${CANDIDATES_TOTAL}, ${PUBLIC_CANDIDATES},
          ${PUBLIC_TEXT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER}, ${RANK_WORK},
          ${null}::text, ${null}::uuid[], ${null}::boolean, ${kinds}::text[], decode(${author}::text, 'hex'))
         order by score desc, post_id desc limit 21`);
      const scans = nodesOf(plan).filter((n) =>
        n["Actual Loops"] > 0 && (n["Relation Name"] === "post_search" || /^post_search/.test(n["Index Name"] ?? "")));
      const shown = JSON.stringify(scans, FIELDS, 1);
      if (kinds !== null) postsByKeyOnly(nodesOf(plan), `${mode}, ${what}`);
      assert.ok(!scans.some((n) => n["Node Type"] === "Seq Scan"), `${mode}: the function walks post_search:\n${shown}`);
      assert.ok(!scans.some((n) => n["Index Name"] === "post_search_pkey"), `${mode}:\n${shown}`);
      // btree_gin is what allows space_id to sit in the same index condition as
      // the tsquery. Without it the SPACE is a post-filter and every hot term
      // pulls candidates from SPACES the caller cannot read.
      const probe = scans.find((n) => n["Index Name"] === "post_search_gin");
      assert.match(
        probe?.["Index Cond"] ?? "",
        /space_id = .*tsv @@/,
        `${mode}: no probe of post_search_gin with the SPACE and the query in its index condition:\n${shown}`,
      );
      // And the number that says it plainly: a search must not discard rows it
      // was never allowed to look at. A walk here discards a hundred thousand.
      const discarded = scans.reduce((sum, n) => sum + (n["Rows Removed by Filter"] ?? 0), 0);
      assert.ok(discarded < 100, `${mode}: the scans discarded ${discarded} rows they should never have visited:\n${shown}`);
    }
  });

  test("a text seek probes withheld and hidden posts one at a time, never reading them whole", async () => {
    // Found by the review of proposal-seek-filter-before-cut: as NOT EXISTS, seek_text's
    // checks of the public rows and of its answer could read space_hidden whole, so a SEEK's
    // cost followed posts hidden in SPACES the caller cannot read. Five thousand hidden posts
    // in the reader's SPACES, which the member cannot read; the member searches a word all
    // of its own five hundred posts hold.
    await fixture.owner`
      insert into schellingaf.space_hidden (post_id, space_id, hidden_by, revision)
      select p.post_id, p.space_id, decode(${readerHex}, 'hex'), 1
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
       where s.name <> 'plan-space-1'
       limit 5000
      on conflict do nothing`;
    await fixture.owner`analyze schellingaf.space_hidden`;
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      const plan = await planInside(memberHex, /^\s*WITH q AS/, mode, (tx) => tx`
        select post_id::text, score from schellingaf.seek_text(
          ${"ECONNREFUSED"}, ${null}::uuid, ${CANDIDATES_PER_SPACE}, ${CANDIDATES_TOTAL}, ${PUBLIC_CANDIDATES},
          ${PUBLIC_TEXT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER}, ${RANK_WORK},
          ${null}::text, ${null}::uuid[], ${null}::boolean)`);
      const nodes = nodesOf(plan);
      const checks = nodes.filter((n) => ["space_hidden", "withheld"].includes(n["Relation Name"]));
      const shown = JSON.stringify(checks, [...FIELDS, "Relation Name", "Parent Relationship"], 1);
      assert.ok(checks.some((n) => n["Actual Loops"] > 0), `${mode}: no check ran:\n${shown}`);
      assert.ok(checks.every((n) => /Index/.test(n["Node Type"]) && n["Parent Relationship"] === "SubPlan"),
        `${mode}: withheld or hidden posts read other than one by its key:\n${shown}`);
    }
  });
});

describe("what a seek costs when the plan cache plans it from the caller's own arguments", () => {
  // The gate the shape checks above cannot be. They assert the shape of one plan
  // for one argument; these compare what two arguments cost. A seek function is
  // planned through the PLAN CACHE, which builds a CUSTOM plan from the actual
  // arguments for the first five executions in every session. For
  // seek_fingerprint, given a prefix that matches a great many rows, that custom
  // plan walks post_fingerprints_pkey backwards with the SPACE demoted to a
  // filter, discarding every row belonging to somebody else: the rows returned
  // are the same, and the time answers "does anybody else have this?". Pooled
  // connections are retired every 30-60 minutes, so those first five never stop
  // coming. seek_fingerprint is pinned to the generic plan for that reason.
  //
  // These run the FUNCTION, not a copy of it, in a session that asks for a custom
  // plan every time, the hostile end of what the plan cache can do, and compare a
  // prefix held by forty thousand unreadable rows against one held by nobody.
  // Equal cost is the whole promise. The assertion is buffers, not milliseconds,
  // because a page count is deterministic and a duration is not.
  //
  // The corpus is small and deliberately shaped: a handful of SPACES, one of them
  // holding everything, because the 200-SPACE corpus above does not provoke the
  // bad plan. The first test asserts that this one does, so the day it stops is
  // a failure with an explanation rather than a gate passing for the wrong reason.

  let cacheFixture: Fixture;
  let callerHex: string;
  const UNREADABLE = 40_000;
  /** A prefix every unreadable post carries and no readable one does, and a
   * prefix nothing anywhere carries. */
  const HELD = { lo: "cccc00", hi: "cccc01" };
  const UNHELD = { lo: "eeee00", hi: "eeee01" };

  before(async () => {
    cacheFixture = await cloneDatabase("seekcache");
    const sql = cacheFixture.owner;

    const ownerKey = publicKey("cache-owner");
    const callerKey = publicKey("cache-caller");
    const ownerHex = peerIdOf(ownerKey);
    callerHex = peerIdOf(callerKey);
    await sql`select schellingaf.register_peer(${ownerKey})`;
    await sql`select schellingaf.register_peer(${callerKey})`;

    await sql`
      insert into schellingaf.spaces (name, owner_id, title, description)
      select 'cache-' || g, decode(${ownerHex}, 'hex'), 'Space ' || g, 'seeded'
        from generate_series(1, 6) g`;
    // The caller belongs to cache-1 and to nothing else.
    await sql`
      insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
      select s.space_id, decode(${callerHex}, 'hex'), 'reader', 'grant', s.owner_id, 0
        from schellingaf.spaces s where s.name = 'cache-1'`;

    await sql`
      insert into schellingaf.posts
        (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 0, decode(${ownerHex}, 'hex'), 'obs',
             'Readable ' || g, 'nothing in here matches', sha256(('own' || g)::bytea)
        from generate_series(1, 500) g,
             lateral (select space_id from schellingaf.spaces where name = 'cache-1') s`;
    await sql`
      insert into schellingaf.posts
        (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 0, decode(${ownerHex}, 'hex'), 'fail',
             'Unreadable ' || g, 'ECONNREFUSED building src/main.rs', sha256(('big' || g)::bytea)
        from generate_series(1, ${UNREADABLE}) g,
             lateral (select space_id from schellingaf.spaces where name = 'cache-2') s`;
    await sql`
      insert into schellingaf.posts
        (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 0, decode(${ownerHex}, 'hex'), 'obs',
             'Unreadable ' || g, 'ECONNREFUSED building src/main.rs',
             sha256(('rest' || g || s.space_id)::bytea)
        from generate_series(1, 500) g
        join lateral (select space_id from schellingaf.spaces
                       where name like 'cache-%' and name not in ('cache-1', 'cache-2')) s on true`;
    await sql`
      update schellingaf.spaces s
         set last_seq = (select count(*) from schellingaf.posts p where p.space_id = s.space_id)`;

    // A scheme whose values CLUSTER, which is the shape a fingerprint probe
    // leaks through: a package name, a repo path, an artifact digest. Every
    // unreadable post carries the prefix and no readable one does, so the caller
    // can ask about a prefix held by forty thousand rows it may not read and by
    // nothing at all that it may.
    await sql`
      insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
      select p.post_id, p.space_id, 'oci.digest',
             case when sp.name = 'cache-1' then 'dddd00' else ${HELD.lo} end
               || substr(encode(sha256(p.post_id::text::bytea), 'hex'), 7)
        from schellingaf.posts p join schellingaf.spaces sp on sp.space_id = p.space_id`;
    // The same asymmetry for the text seek: the hot term is carried only by
    // posts the caller cannot read.
    await sql`
      insert into schellingaf.post_search (post_id, space_id, tsv)
      select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body)
        from schellingaf.posts p`;
    // Written this way, the index's pending list is nearly full, and on six SPACES
    // that makes seek_text walk post_search for every term (the plan test above
    // says why). Emptied, the function probes the caller's one SPACE, the plan the
    // service runs, so the text gate below compares two probes.
    await sql`select gin_clean_pending_list('schellingaf.post_search_gin'::regclass)`;

    await sql`analyze schellingaf.posts, schellingaf.post_fingerprints,
                      schellingaf.post_search, schellingaf.spaces, schellingaf.memberships`;
  });

  after(async () => {
    await cacheFixture.end();
  });

  /** Buffers the statement touched, counted off EXPLAIN. A function scan's
   * count includes the work done inside the function, which is the point. */
  function buffersOf(plan: string): number {
    let total = 0;
    for (const m of plan.matchAll(/shared hit=(\d+)(?: read=(\d+))?/g)) {
      total += Number(m[1]) + Number(m[2] ?? 0);
    }
    return total;
  }

  /** Call a definer seek as the api role, caller bound the way readTx binds it,
   * in a transaction that has asked for a custom plan. Twice, and the second is
   * the measurement: the first call in a fresh transaction also reads catalog
   * pages, in the same number whatever the arguments are. */
  async function costOf(statement: string): Promise<number> {
    let last = 0;
    for (let i = 0; i < 2; i++) {
      const rows = await cacheFixture.asCaller(callerHex, async (tx: any) => {
        await tx.unsafe("set local plan_cache_mode = force_custom_plan");
        return tx.unsafe(`explain (analyze, buffers) ${statement}`);
      });
      last = buffersOf((rows as any[]).map((r: any) => Object.values(r)[0]).join("\n"));
    }
    return last;
  }

  test("this corpus really does provoke the plan that walks other SPACES", async () => {
    // The body, planned from the same values a custom plan would be planned
    // from, which is what a custom plan is. If this ever stops discarding tens
    // of thousands of rows, the two gates below have stopped proving anything
    // and the corpus needs rebuilding: they would be passing because the
    // planner changed its mind, not because the function is safe.
    const rows = await cacheFixture.owner.begin(async (tx) => {
      await tx`select set_config('schellingaf.peer_id', ${callerHex}, true)`;
      return tx`
        explain (analyze)
        with mine as (select sid from schellingaf.caller_space_ids() sid)
        select f.post_id, f.space_id
          from mine
          cross join lateral (
            select x.post_id, x.space_id from schellingaf.post_fingerprints x
             where x.space_id = mine.sid and x.scheme = 'oci.digest'
               and x.value >= ${HELD.lo} and x.value < ${HELD.hi}
             order by x.post_id desc limit 20) f
         order by f.post_id desc limit 20`;
    });
    const plan = (rows as any[]).map((r: any) => Object.values(r)[0]).join("\n");
    const discarded = Number(plan.match(/Rows Removed by Filter: (\d+)/)?.[1] ?? 0);
    assert.ok(
      discarded > 10_000,
      `planned from these arguments the body discarded only ${discarded} unreadable rows, ` +
        `so this corpus no longer reproduces the custom plan the gates below exist for:\n${plan}`,
    );
  });

  test("a fingerprint prefix held only by SPACES the caller cannot read costs it nothing", async () => {
    const [counts] = await cacheFixture.owner<{ unreadable: number; readable: number }[]>`
      select count(*) filter (where f.space_id <> s.space_id)::int as unreadable,
             count(*) filter (where f.space_id =  s.space_id)::int as readable
        from schellingaf.post_fingerprints f,
             lateral (select space_id from schellingaf.spaces where name = 'cache-1') s
       where f.scheme = 'oci.digest' and f.value >= ${HELD.lo} and f.value < ${HELD.hi}`;
    assert.ok(counts!.unreadable > 10_000, `only ${counts!.unreadable} unreadable rows carry the prefix`);
    assert.equal(counts!.readable, 0, "the caller's own SPACE must not carry the prefix");

    const seek = (p: { lo: string; hi: string }) =>
      `select * from schellingaf.seek_fingerprint('oci.digest', '${p.lo}', '${p.hi}', null, 20)`;
    const held = await costOf(seek(HELD));
    const unheld = await costOf(seek(UNHELD));

    assert.ok(
      held <= unheld + 200,
      `a prefix held by ${counts!.unreadable} rows in SPACES the caller cannot read cost ${held} buffers, ` +
        `against ${unheld} for a prefix held by nobody: the scan walked spaces it may not see`,
    );
  });

  test("a search term carried only by SPACES the caller cannot read costs it nothing", async () => {
    // seek_text carries no plan_cache_mode of its own, so its custom plans are
    // what this measures: a term forty thousand unreadable posts carry must cost
    // what a term nobody carries costs. With the pending list emptied, both are
    // probes of the caller's one SPACE, the plan the service runs, so a term that
    // turns the probe into a walk fails here. With it nearly full, this small
    // corpus walks post_search for both terms and the comparison would be between
    // two walks.
    const [total] = await cacheFixture.owner<{ n: number }[]>`
      select count(*)::int as n
        from schellingaf.post_search ps,
             lateral (select space_id from schellingaf.spaces where name = 'cache-1') s
       where ps.tsv @@ websearch_to_tsquery('pg_catalog.simple', 'ECONNREFUSED')
         and ps.space_id <> s.space_id`;
    assert.ok(total!.n > 10_000, `only ${total!.n} unreadable posts carry the term`);

    const hot = await costOf(`select * from schellingaf.seek_text('ECONNREFUSED', null, 100, 600)`);
    const cold = await costOf(`select * from schellingaf.seek_text('quetzalcoatl', null, 100, 600)`);
    assert.ok(
      hot <= cold + 200,
      `a term carried by ${total!.n} unreadable posts cost ${hot} buffers against ${cold} for one carried by nobody`,
    );
  });
});
