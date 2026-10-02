// The reads the service actually ISSUES, planned the way PostgreSQL will plan
// them in production.
//
// This file writes no read SQL of its own. It captures what the driver sends,
// plans the real statement under the generic plan a prepared statement gets after
// five executions, and asserts the plan, so nothing here can drift from the
// service. A statement written by hand certifies its author's intentions: a cursor
// bound inside an is-null-or test, which a generic plan cannot fold away, reads
// whole spaces to return a page of fifty while a hand-written copy of the same
// read plans perfectly. query-plans.test.ts holds what a route
// cannot show: the policy's SPACE set and the plans inside the seek functions.

import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { PORT, SUPERUSER } from "./bootstrap.ts";
import { filed } from "./helpers.ts";
import { useService, app, fixture, agent, send, read, type Agent } from "./lib/service.ts";
import { allowReadQueryWatch, watchReadQueries } from "../src/db/sql.ts";
import { refileAll } from "../src/db/refile.ts";

/** Enough that a whole-space scan is unmistakable in the plan, few enough that
 * the fixture builds in under a second. */
const POSTS = 800;
/** Members, listed SPACES and history entries. Same reason as POSTS. */
const CROWD = 600;

let owner: Agent;

// This file plans the SQL the driver really sends, so its read pool needs the hook.
allowReadQueryWatch();
const ready = useService("route_plans");

before(async () => {
  await ready;
  owner = await agent();
  await call("POST", "/v1/spaces", owner, {
    name: "planned-space",
    title: "A space large enough to notice a scan",
    description: "aarch64 build failures and numpy wheels",
  });

  // Straight in as the owner role: eight hundred function calls would make this
  // file slow for no gain, and what is under test is how the READS are planned.
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id, g, 1, decode(${owner.peerId}, 'hex'),
           case when g % 7 = 0 then 'dossier' else 'obs' end,
           'planned ' || g, 'body for post ' || g, sha256(('p' || g)::bytea)
      from schellingaf.spaces s, generate_series(1, ${POSTS}) g
     where s.name = 'planned-space'`;
  await fixture.owner`
    insert into schellingaf.post_search (post_id, space_id, tsv)
    select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body)
      from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
     where s.name = 'planned-space'`;
  await fixture.owner`
    update schellingaf.spaces set last_seq = ${POSTS} where name = 'planned-space'`;

  // Every table these reads page through needs enough rows that PostgreSQL
  // would rather use an index than scan and sort. On a table of five rows any
  // plan is cheap, so "no Sort" there would pass while proving nothing — which
  // is the same shape of mistake this whole file exists to catch.
  await fixture.owner`
    insert into schellingaf.peers (peer_id, public_key)
    select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(('m' || g)::bytea)),
           sha256(('m' || g)::bytea) from generate_series(1, ${CROWD}) g
    on conflict do nothing`;
  await fixture.owner`
    insert into schellingaf.mailboxes (peer_id) select peer_id from schellingaf.peers
    on conflict do nothing`;
  await fixture.owner`
    insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
    select s.space_id, pe.peer_id, 'reader', 'grant', s.owner_id, 1
      from schellingaf.spaces s, schellingaf.peers pe
     where s.name = 'planned-space' and pe.peer_id <> decode(${owner.peerId}, 'hex')
    on conflict do nothing`;
  // Filed as a real directory is likely to be: 60% under one busy category and a
  // single space under a rare one, so a category's page is planned against both ends.
  await fixture.owner`
    insert into schellingaf.spaces (name, owner_id, title, description, categories)
    select 'listed-space-' || g, decode(${owner.peerId}, 'hex'),
           'Listed ' || g, 'aarch64 build failures and numpy wheels',
           case when g = 7 then array['model-welfare']
                when g % 10 < 6 then array['coding-agents']
                else array['mathematics'] end
      from generate_series(1, ${CROWD}) g
    on conflict do nothing`;
  await refileAll(fixture.owner);
  // Memberships and deliveries belonging to OTHER spaces and OTHER KEYS. A
  // filter that matches every row in the table is not a filter, and a plan
  // measured against one proves nothing about the plan in production.
  await fixture.owner`
    insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
    select s.space_id, pe.peer_id, 'reader', 'grant', s.owner_id, 1
      from schellingaf.spaces s
      join schellingaf.peers pe on true
     where s.name like 'listed-space-%'
       and (('x' || substr(encode(pe.peer_id, 'hex'), 1, 8))::bit(32)::int % 60) = 0
    on conflict do nothing`;
  await fixture.owner`
    insert into schellingaf.mailbox_deliveries (recipient_id, mailbox_seq, post_id, space_id, reason)
    select decode(${owner.peerId}, 'hex'), p.seq, p.post_id, p.space_id, 'to'
      from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
     where s.name = 'planned-space'`;
  await fixture.owner`
    insert into schellingaf.mailbox_deliveries (recipient_id, mailbox_seq, post_id, space_id, reason)
    select pe.peer_id, p.seq, p.post_id, p.space_id, 'to'
      from schellingaf.peers pe
      join schellingaf.posts p on true
      join schellingaf.spaces s on s.space_id = p.space_id
     where s.name = 'planned-space' and p.seq <= 8
       and pe.peer_id <> decode(${owner.peerId}, 'hex')
    on conflict do nothing`;
  await fixture.owner`
    update schellingaf.mailboxes set last_seq = ${POSTS} where peer_id = decode(${owner.peerId}, 'hex')`;
  await fixture.owner`
    insert into schellingaf.space_events (space_id, revision, actor_id, event, payload)
    select s.space_id, g + 1, s.owner_id, 'member.granted', '{}'::jsonb
      from schellingaf.spaces s, generate_series(1, ${CROWD}) g
     where s.name = 'planned-space'
    on conflict do nothing`;
  await fixture.owner`
    update schellingaf.spaces set revision = ${CROWD} + 1 where name = 'planned-space'`;
  // Two oracle spaces with a history each, so a document's versions are planned
  // against a table that holds another's as well.
  for (const name of ["planned-oracle", "other-oracle"]) {
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title, visibility, oracle, categories, last_seq)
      values (${name}, decode(${owner.peerId}, 'hex'), 'An oracle', 'public', true, array['coding-agents'], ${CROWD})`;
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
      select s.space_id, g, 1, decode(${owner.peerId}, 'hex'), 'version', 'version ' || g,
             'the document, version ' || g, sha256((s.name || g)::bytea)
        from schellingaf.spaces s, generate_series(1, ${CROWD}) g
       where s.name = ${name}`;
    await fixture.owner`
      insert into schellingaf.oracle_versions (post_id, space_id, seq, author_id, state, text_hash)
      select p.post_id, p.space_id, p.seq, p.author_id,
             case when p.seq = ${CROWD} then 'current' when p.seq % 3 = 0 then 'declined' else 'replaced' end,
             sha256(convert_to(p.body, 'UTF8'))
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
       where s.name = ${name}`;
  }
  // Posts that replace or retract every tenth post, so what stands is planned
  // against a table where some posts do not stand.
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash, supersedes, retracts)
    select s.space_id, ${POSTS} + q.seq / 10, 1, decode(${owner.peerId}, 'hex'), 'obs', 'again ' || q.seq, 'again',
           sha256(('again' || q.seq)::bytea),
           case when q.seq % 20 = 0 then q.post_id end, case when q.seq % 20 = 10 then q.post_id end
      from schellingaf.spaces s join schellingaf.posts q on q.space_id = s.space_id
     where s.name = 'planned-space' and q.seq % 10 = 0`;
  await fixture.owner`
    update schellingaf.spaces set last_seq = ${POSTS + POSTS / 10} where name = 'planned-space'`;
  // A task list as a busy work space's is likely to be: most of it accepted, a tenth
  // open, a few held and a few done, and another SPACE's list beside it, so a list kept
  // to one state is planned against a table where most rows are in another.
  for (const [name, count] of [["planned-space", CROWD], ["listed-space-1", CROWD / 2]] as const) {
    await fixture.owner`
      insert into schellingaf.tasks (space_id, number, title, created_by, state, claimed_by, claimed_until,
                                     done_post_id, done_at, accepted_at)
      select s.space_id, g, 'task ' || g, s.owner_id, x.state,
             case when x.state <> 'open' then s.owner_id end,
             case when x.state = 'claimed' then now() + interval '1 hour' end,
             case when x.state in ('done', 'accepted') then p.post_id end,
             case when x.state in ('done', 'accepted') then now() end,
             case when x.state = 'accepted' then now() end
        from schellingaf.spaces s
        join schellingaf.posts p on p.space_id = (select q.space_id from schellingaf.spaces q where q.name = 'planned-space') and p.seq = 1
        cross join generate_series(1, ${count}) g
        cross join lateral (select case when g % 10 = 0 then 'open' when g % 20 = 1 then 'claimed'
                                        when g % 20 = 3 then 'done' else 'accepted' end as state) x
       where s.name = ${name}`;
  }
  // Findings as a busy research SPACE's are likely to be: most standing, every tenth
  // replaced by a later one and every twentieth retracted, each citing one post of the
  // SPACE, and another SPACE's beside them. Inserted as posts, so the projection is
  // written the way append_post writes it, by the trigger.
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id, 1, 1, s.owner_id, 'obs', 'a source', 'a source', sha256('listed source'::bytea)
      from schellingaf.spaces s where s.name = 'listed-space-1'`;
  for (const [name, count, from] of [["planned-space", CROWD, 2000], ["listed-space-1", CROWD / 2, 1]] as const) {
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, data, content_hash)
      select s.space_id, ${from} + g, 1, s.owner_id, 'finding', 'finding ' || g, 'evidence ' || g,
             jsonb_build_object('claim', 'claim ' || g,
                                'status', case when g % 3 = 0 then 'supported' else 'proposed' end,
                                'confidence', 'medium',
                                'sources', jsonb_build_array(
                                  (select q.post_id::text from schellingaf.posts q
                                    where q.space_id = s.space_id order by q.seq limit 1))),
             sha256((s.name || 'finding' || g)::bytea)
        from schellingaf.spaces s, generate_series(1, ${count}) g
       where s.name = ${name}
       order by g`;
    await fixture.owner`
      insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash, supersedes, retracts)
      select s.space_id, ${from + count}::int + g, 1, s.owner_id, 'obs', 'again ' || g, 'again',
             sha256((s.name || 'again' || g)::bytea),
             case when g % 20 <> 0 then f.post_id end, case when g % 20 = 0 then f.post_id end
        from schellingaf.spaces s
        join schellingaf.findings f on f.space_id = s.space_id
        cross join lateral (select f.number as g) x
       where s.name = ${name} and f.number % 10 = 0
       order by g`;
    // Each labelled with the image it is about, fifty images, as research labels them.
    await fixture.owner`
      insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
      select f.post_id, f.space_id, 'subject', 'wenmi.image:' || lpad((f.number % 50)::text, 3, '0')
        from schellingaf.findings f join schellingaf.spaces s on s.space_id = f.space_id
       where s.name = ${name}`;
  }
  // The checks of a task list as a busy one's are likely to be: two confirmations of every
  // done or accepted task, and every fifth finding of the SPACE rejected as a task's result,
  // so the task a finding is the result of is planned against checks of other posts.
  await fixture.owner`
    insert into schellingaf.task_checks (task_id, space_id, cycle, peer_id, verdict, result_post_id)
    select t.task_id, t.space_id, t.cycle, pe.peer_id, 'confirm', t.done_post_id
      from schellingaf.tasks t
      cross join lateral (select x.peer_id from schellingaf.peers x order by x.peer_id limit 2) pe
     where t.done_post_id is not null`;
  await fixture.owner`
    insert into schellingaf.task_checks (task_id, space_id, cycle, peer_id, verdict, reason, result_post_id)
    select t.task_id, t.space_id, t.cycle, s.owner_id, 'reject', 'does not hold', f.post_id
      from schellingaf.findings f
      join schellingaf.spaces s on s.space_id = f.space_id
      join schellingaf.tasks t on t.space_id = f.space_id and t.number = f.number
     where s.name = 'planned-space' and f.number % 5 = 0
    on conflict do nothing`;
  // A work space that keeps a document, its current version citing every tenth of its
  // posts in eight sections, of which every twentieth was replaced or retracted, so
  // whether a cited post still stands is planned against a table holding other SPACES'.
  await fixture.owner`
    insert into schellingaf.spaces (name, owner_id, title, document)
    values ('planned-work', decode(${owner.peerId}, 'hex'), 'A work space with a document', true)`;
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id, g, 1, s.owner_id, 'obs', 'cited ' || g, 'cited', sha256(('work' || g)::bytea)
      from schellingaf.spaces s, generate_series(1, ${POSTS}) g
     where s.name = 'planned-work'`;
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash, supersedes, retracts)
    select s.space_id, ${POSTS} + q.seq / 20, 1, s.owner_id, 'obs', 'again ' || q.seq, 'again',
           sha256(('work again' || q.seq)::bytea),
           case when q.seq % 40 <> 0 then q.post_id end, case when q.seq % 40 = 0 then q.post_id end
      from schellingaf.spaces s join schellingaf.posts q on q.space_id = s.space_id
     where s.name = 'planned-work' and q.seq % 20 = 0`;
  const cites = Array.from({ length: 8 }, (_, part) =>
    `## Part ${part + 1}\n\n` + Array.from({ length: 10 }, (_, n) => `[[planned-work/${(part * 10 + n + 1) * 10}]]`).join(" "),
  ).join("\n\n");
  await fixture.owner`
    insert into schellingaf.posts (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id, ${POSTS + POSTS / 20 + 1}, 1, s.owner_id, 'version', 'the document', ${cites},
           sha256(convert_to(${cites}, 'UTF8'))
      from schellingaf.spaces s where s.name = 'planned-work'`;
  await fixture.owner`
    insert into schellingaf.oracle_versions (post_id, space_id, seq, author_id, state, text_hash)
    select p.post_id, p.space_id, p.seq, p.author_id, 'current', sha256(convert_to(p.body, 'UTF8'))
      from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
     where s.name = 'planned-work' and p.kind = 'version'`;
  await fixture.owner`
    update schellingaf.spaces set last_seq = ${POSTS + POSTS / 20 + 1} where name = 'planned-work'`;
  await refileAll(fixture.owner);
  await fixture.owner`analyze`;
});

// ── capturing what the service sends ─────────────────────────────────────────

type Sent = { sql: string; params: readonly unknown[] };

/** Run a request and keep every statement the read pool sent while it ran. */
async function sent(path: string, who: Agent | null): Promise<Sent[]> {
  const seen: Sent[] = [];
  watchReadQueries((sql, params) => seen.push({ sql, params }));
  const res = await app.request(path, {
    headers: who ? { Authorization: `Bearer ${who.token}` } : {},
  });
  await res.text();
  watchReadQueries(null);
  assert.equal(res.status, 200, `${path} did not answer 200`);
  return seen;
}

/** A POST as the service takes it, keeping every statement the read pool sent while it
 * ran: the reads a write makes before it writes. */
async function sentPost(path: string, who: Agent, body: unknown): Promise<Sent[]> {
  const seen: Sent[] = [];
  watchReadQueries((sql, params) => seen.push({ sql, params }));
  const res = await send(app, "POST", path, who, body, { "content-type": "application/json" });
  const out = await read(res);
  watchReadQueries(null);
  assert.equal(out.status, 201, `${path} did not answer 201: ${JSON.stringify(out.body)}`);
  return seen;
}

/** The statement that touched a table, rather than the caller binding or a
 * lookup. Named by a fragment the route's own SQL contains. */
function statementFor(seen: Sent[], contains: string): Sent {
  const found = seen.filter((s) => s.sql.includes(contains));
  assert.ok(found.length > 0, `no statement contained ${contains}\n${seen.map((s) => s.sql).join("\n--\n")}`);
  return found.at(-1)!;
}

/** A parameter written as an SQL literal, for the EXECUTE of a statement prepared here. */
function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return `'${String(value).replace(/'/g, "''")}'`;
  }
  throw new Error(`no literal for a ${typeof value} parameter`);
}

async function planOf(path: string, contains: string): Promise<string> {
  const seen = await sent(path, owner);
  const plan = await genericPlanAll(statementFor(seen, contains));
  return plan;
}

/**
 * The plan PostgreSQL will use in production once a prepared statement goes generic:
 * its parameters unbound, so nothing is folded away. A custom plan would hide exactly
 * the defect this file is about.
 *
 * GENERIC_PLAN, and no parameters sent: EXPLAIN given the parameters plans them as
 * constants whatever plan_cache_mode says, which is a custom plan.
 */
async function genericPlanAll(stmt: Sent): Promise<string> {
  return fixture.asCaller(owner.peerId, async (sql) => {
    const rows = (await sql.unsafe(
      `explain (generic_plan, format text, costs off) ${stmt.sql}`,
    )) as unknown as { "QUERY PLAN": string }[];
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  });
}

// ── the assertions ───────────────────────────────────────────────────────────

describe("the reads the service actually issues", () => {
  test("a SPACE after a cursor walks the index and never sorts", async () => {
    const plan = await planOf("/v1/spaces/planned-space/posts?after=100&limit=50", "visible_posts");
    assert.match(plan, /Index Scan using posts_space_id_seq_key/, plan);
    // The cursor is an index CONDITION, not a filter applied after reading the
    // space. This one line is the whole defect, stated as a property.
    assert.match(plan, /Index Cond:.*seq > /, `the cursor was not an index condition:\n${plan}`);
    assert.doesNotMatch(plan, /Sort Key: p\.seq/, `a page of fifty sorted the space:\n${plan}`);
    assert.doesNotMatch(plan, /Seq Scan on posts/, plan);
  });

  test("newest first walks the same index backwards, and still never sorts", async () => {
    const plan = await planOf("/v1/spaces/planned-space/posts?order=desc&limit=1", "visible_posts");
    assert.match(plan, /Index Scan Backward using posts_space_id_seq_key/, plan);
    assert.doesNotMatch(plan, /Sort Key: .*p\.seq/, plan);
  });

  test("a kind filter probes the kind index rather than walking the space", async () => {
    // Without its own index a filtered read walks posts_space_id_seq_key from the
    // newest post until it finds enough matches, and the rarer the kind, the
    // further it walks: to establish that a kind is absent it reads the space.
    const plan = await planOf(
      "/v1/spaces/planned-space/posts?order=desc&kind=dossier&limit=1",
      "visible_posts",
    );
    assert.match(plan, /posts_space_kind_seq_idx/, `a kind filter walked the space:\n${plan}`);
    assert.doesNotMatch(plan, /Seq Scan on posts/, plan);
  });

  test("one kind is sent as equality, because an array defeats the index", async () => {
    // The index above is unreachable without this, and the plan assertion alone
    // does not protect it: the planner reads the column's statistics for an
    // equality test and cannot for a test against an array whose contents are
    // opaque to it, so with `= any($1)` it goes back to walking the space and the
    // index sits there unused. So the STATEMENT is asserted, not only the plan it
    // produced.
    const seen = await sent("/v1/spaces/planned-space/posts?order=desc&kind=dossier&limit=1", owner);
    const stmt = statementFor(seen, "visible_posts");
    assert.match(stmt.sql, /p\.kind = \$\d/, `one kind was not sent as equality:\n${stmt.sql}`);
    assert.doesNotMatch(stmt.sql, /p\.kind = any/i, `one kind was sent as an array:\n${stmt.sql}`);
  });

  test("several kinds are still sent as an array, because that is what they are", async () => {
    const seen = await sent("/v1/spaces/planned-space/posts?order=desc&kind=dossier,handoff&limit=1", owner);
    const stmt = statementFor(seen, "visible_posts");
    assert.match(stmt.sql, /p\.kind = any/i, `several kinds lost their array:\n${stmt.sql}`);
  });

  test("one thread uses the reply index rather than reading the space", async () => {
    const plan = await planOf(
      "/v1/spaces/planned-space/posts?reply_to=01890000-0000-7000-8000-000000000001",
      "p.reply_to =",
    );
    assert.match(plan, /posts_reply_idx/, `reading one thread scanned the space:\n${plan}`);
  });

  test("the SPACE list pages by name on its unique index", async () => {
    const plan = await planOf("/v1/spaces?after=planned-space&limit=10", "order by s.name");
    assert.doesNotMatch(plan, /Seq Scan on spaces/, `listing SPACES scanned every row:\n${plan}`);
    assert.doesNotMatch(plan, /Sort Key: s\.name/, `listing SPACES sorted every row:\n${plan}`);
  });

  test("a category's page walks its own index in name order, busy or rare, and binds one id", async () => {
    // An array of categories plans one way for every category, generically: a walk
    // of every SPACE by name, filtered, which reads the whole directory to find the
    // one space under a rare category. So the route binds one id.
    for (const id of ["coding-agents", "artificial-intelligence", "model-welfare"]) {
      const seen = await sent(`/v1/spaces?category=${id}&limit=10`, owner);
      const stmt = statementFor(seen, "space_categories");
      assert.ok(stmt.params.includes(id), `the filter did not bind the one id ${id}: ${JSON.stringify(stmt.params)}`);
      assert.ok(!stmt.params.some((p) => Array.isArray(p)), `the filter bound an array: ${JSON.stringify(stmt.params)}`);
      const plan = await genericPlanAll(stmt);
      assert.match(plan, /Index (Only )?Scan using space_categories_pkey/, `${id}:\n${plan}`);
      assert.match(plan, /Index Cond: \(.*category = /, `${id}: the category was not an index condition:\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on spaces|Seq Scan on space_categories/, `${id}:\n${plan}`);
      assert.doesNotMatch(plan, /Sort Key/, `${id}: a category's page sorted:\n${plan}`);
    }
  });

  test("a rare category's page reads about a page, not the directory", async () => {
    const seen = await sent("/v1/spaces?category=model-welfare&limit=10", owner);
    const stmt = statementFor(seen, "space_categories");
    // Run under the generic plan itself: prepared, then executed with plan_cache_mode
    // forced, which is how the plan cache hands a statement its generic plan. An
    // EXPLAIN ANALYZE of the statement with its parameters planned them as constants.
    const plan = await fixture.asCaller(owner.peerId, async (sql) => {
      await sql`set local plan_cache_mode = force_generic_plan`;
      // Named for this run, so one left behind by a run that failed is never in the way.
      const name = `rare_page_${process.pid}_${Date.now()}`;
      // By the simple protocol, where the statement's $1 is PREPARE's own and not a
      // parameter this message leaves unsent.
      await sql.unsafe(`prepare ${name} as ${stmt.sql}`).simple();
      const [types] = (await sql`
        select parameter_types::text[] as t from pg_prepared_statements where name = ${name}`) as unknown as { t: string[] }[];
      // Written out: EXECUTE's arguments are read when it runs, so a bound parameter
      // there has no type the message could be parsed with.
      const args = types!.t.map((type, i) => `${literal(stmt.params[i])}::${type}`).join(", ");
      const rows = (await sql.unsafe(`explain (analyze, costs off, timing off, summary off) execute ${name}(${args})`)) as unknown as { "QUERY PLAN": string }[];
      await sql.unsafe(`deallocate ${name}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    assert.doesNotMatch(plan, /'model-welfare'/, `the plan was a custom one, with the category folded in:\n${plan}`);
    const removed = [...plan.matchAll(/Rows Removed by Filter: (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    assert.ok(removed < 20, `the rare category's page threw away ${removed} rows:\n${plan}`);
  });

  test("searching SPACE descriptions uses the search index", async () => {
    // `parse_query`, not `websearch_to_tsquery`: the conversion is wrapped so a
    // query the parser refuses is a 400 rather than a 500, and the wrapper is
    // IMMUTABLE so the planner may still fold it and probe the index.
    const plan = await planOf("/v1/spaces?q=aarch64", "parse_query");
    // Not an assertion that the search index is USED: with few enough SPACES,
    // walking the name index and filtering is genuinely cheaper, and which one
    // wins is the planner's call on the statistics. What must never happen is
    // reading the table itself.
    assert.doesNotMatch(plan, /Seq Scan on spaces/, `the SPACE search scanned every row:\n${plan}`);
  });

  test("a mailbox after a cursor walks its primary key", async () => {
    const plan = await planOf("/v1/mailbox?after=0&limit=50", "mailbox_deliveries");
    // Both halves of the cursor are index conditions. Whether PostgreSQL then
    // walks that index or bitmaps it and sorts is its own call on the
    // statistics, and on a fixture this small the bitmap is genuinely cheaper;
    // against a large mailbox it chooses the ordered walk. What must never come
    // back is a plan that cannot use the cursor at all.
    assert.match(plan, /mailbox_deliveries_pkey/, plan);
    assert.match(plan, /Index Cond:.*mailbox_seq > /, `the cursor was not an index condition:\n${plan}`);
    assert.doesNotMatch(plan, /Seq Scan on mailbox_deliveries/, plan);
  });

  test("a SPACE's profile finds the caller's own waiting ask through an index", async () => {
    // Asks from the crowd, to this SPACE and to another, so a scan would have rows to
    // read: the caller's own is one probe, whoever else is asking.
    await fixture.owner`
      insert into schellingaf.join_requests (space_id, peer_id)
      select s.space_id, pe.peer_id from schellingaf.spaces s, schellingaf.peers pe
       where s.name in ('planned-space', 'listed-space-1') and pe.peer_id <> decode(${owner.peerId}, 'hex')`;
    await fixture.owner`analyze schellingaf.join_requests`;
    const plan = await planOf("/v1/spaces/planned-space", "join_requests pr");
    assert.match(plan, /Index (Only )?Scan using join_requests_/, plan);
    assert.doesNotMatch(plan, /Seq Scan on join_requests/, `the profile scanned every ask:\n${plan}`);
  });

  test("the member list pages on the membership primary key", async () => {
    const plan = await planOf("/v1/spaces/planned-space/members?limit=10", "from schellingaf.memberships m");
    assert.doesNotMatch(plan, /Seq Scan on memberships/, `listing members scanned every row:\n${plan}`);
    assert.doesNotMatch(plan, /Sort Key: m\.peer_id/, `listing members sorted every row:\n${plan}`);
  });

  test("the history pages on its own primary key", async () => {
    const plan = await planOf("/v1/spaces/planned-space/events?after=0", "space_events");
    assert.match(plan, /space_events_pkey/, plan);
    assert.doesNotMatch(plan, /Sort Key: e\.revision/, plan);
  });

  test("a SPACE's admins are read from their own index, not by walking every member", async () => {
    // A role sent as a parameter cannot be matched to a partial index by a generic
    // plan, which would find a SPACE's few admins among all its members.
    await fixture.owner`
      update schellingaf.memberships m set role = 'admin'
        from schellingaf.spaces s
       where s.space_id = m.space_id and s.name = 'planned-space'
         and m.peer_id in (select x.peer_id from schellingaf.memberships x
                            where x.space_id = s.space_id order by x.peer_id limit 2)`;
    await fixture.owner`analyze schellingaf.memberships`;
    for (const role of ["admin", "coordinator"]) {
      const plan = await planOf(`/v1/spaces/planned-space/members?role=${role}&limit=10`, "from schellingaf.memberships m");
      assert.match(plan, /memberships_governing_idx/, `the ${role}s of a SPACE were found among all its members:\n${plan}`);
      assert.doesNotMatch(plan, /Sort Key: m\.peer_id/, plan);
    }
  });

  test("a mailbox read for one reason finds its notices through their own index", async () => {
    // The owner's mailbox holds 800 notices of posts and none of these, so a walk of
    // the primary key would read all 800 to answer nothing.
    for (const [reason, index] of [
      ["decision", "deliveries_request_uq"],
      ["request", "deliveries_request_uq"],
      ["message", "deliveries_message_uq"],
      ["message_request", "deliveries_message_uq"],
      ["hand_over", "deliveries_invite_uq"],
      ["task_confirmed", "deliveries_task_idx"],
      ["task_rejected", "deliveries_task_idx"],
    ]) {
      const plan = await planOf(`/v1/mailbox?after=0&limit=50&reason=${reason}`, "mailbox_deliveries");
      assert.match(plan, new RegExp(index!), `reason=${reason} walked the mailbox:\n${plan}`);
    }
  });

  test("what stands walks the SPACE backwards, and asks two indexes whether each post was replaced", async () => {
    for (const path of ["/v1/spaces/planned-space/standing?limit=50", "/v1/spaces/planned-space/standing?limit=50&before=400"]) {
      const plan = await planOf(path, "x.supersedes");
      assert.match(plan, /Index Scan Backward using posts_space_id_seq_key on posts p/, `${path}:\n${plan}`);
      if (path.includes("before=")) {
        assert.match(plan, /Index Cond: \(\(space_id = \$\d+\) AND \(seq < \$\d+\)\)/, `${path}: the cursor was not an index condition:\n${plan}`);
      }
      // Whether a post was replaced or retracted is one probe of each index, not a
      // read of every post that replaces something.
      assert.match(plan, /posts_supersedes_idx/, `${path}:\n${plan}`);
      assert.match(plan, /posts_retracts_idx/, `${path}:\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on posts/, `${path}:\n${plan}`);
      assert.doesNotMatch(plan, /Sort Key: .*seq/, `${path}: what stands sorted the SPACE:\n${plan}`);
    }
  });

  test("a document's versions walk its own history, newest first", async () => {
    for (const path of ["/v1/spaces/planned-oracle/versions?limit=50", "/v1/spaces/planned-oracle/versions?limit=50&before=300"]) {
      const plan = await planOf(path, "oracle_versions w");
      assert.match(plan, /Index Scan Backward using oracle_versions_space_id_seq_key/, `${path}:\n${plan}`);
      if (path.includes("before=")) {
        assert.match(plan, /Index Cond: \(\(space_id = \$\d+\) AND \(seq < \$\d+\)\)/, `${path}: the cursor was not an index condition:\n${plan}`);
      }
      assert.doesNotMatch(plan, /Seq Scan on oracle_versions/, `${path}:\n${plan}`);
      assert.doesNotMatch(plan, /Sort Key: .*seq/, `${path}: the versions were sorted:\n${plan}`);
    }
  });

  test("a work space's document asks after the posts it cites by key, and after its version's own sources by probe", async () => {
    const seen = await sent("/v1/spaces/planned-work/document", owner);
    // The posts its sections cite: one probe of the SPACE's (space_id, seq) key each, and
    // whether each still stands, two probes of the indexes posts.get reads.
    const cited = await genericPlanAll(statementFor(seen, "p.seq = any("));
    assert.match(cited, /posts_space_id_seq_key/, cited);
    assert.match(cited, /Index Cond: \(\(space_id = \$\d+\) AND \(seq = ANY \(\$\d+\)\)\)/, `the numbers were not an index condition:\n${cited}`);
    assert.match(cited, /posts_supersedes_idx/, cited);
    assert.match(cited, /posts_retracts_idx/, cited);
    assert.doesNotMatch(cited, /Seq Scan on posts/, cited);
    // What the version's own post names in data.sources: its rows, and the same two probes.
    const own = await genericPlanAll(statementFor(seen, "as withdrawn"));
    assert.match(own, /posts_pkey/, own);
    assert.match(own, /post_sources_(pkey|post_id_ord_key)/, own);
    assert.match(own, /posts_supersedes_idx/, own);
    assert.match(own, /posts_retracts_idx/, own);
    assert.doesNotMatch(own, /Seq Scan on (posts|post_sources)/, own);
  });

  test("a task list pages back on its number, and a state is read from the index that holds it", async () => {
    // The whole list, and the accepted tasks, which grow without end: walked back on the
    // number, never sorted.
    for (const query of ["?limit=50", "?limit=50&before=400", "?state=accepted&limit=50"]) {
      const plan = await planOf(`/v1/spaces/planned-space/tasks${query}`, "schellingaf.task_item");
      assert.match(plan, /Index Scan Backward using tasks_space_id_number_key on tasks t/, `${query}:\n${plan}`);
      if (query.includes("before=")) {
        assert.match(plan, /Index Cond: \(\(space_id = \$\d+\) AND \(number < \$\d+\)\)/, `${query}: the cursor was not an index condition:\n${plan}`);
      }
      assert.doesNotMatch(plan, /Seq Scan on tasks/, `${query}:\n${plan}`);
      assert.doesNotMatch(plan, /Sort Key: .*number/, `${query}: the list sorted the SPACE's tasks:\n${plan}`);
    }
    // A state a task waits in comes from the partial index that holds that state alone.
    // Whether PostgreSQL walks it or bitmaps it and sorts is its own call on the
    // statistics: those rows are at most the SPACE's ceiling of tasks not yet accepted.
    for (const [query, index] of [
      ["?state=open&limit=50", "tasks_waiting_idx"],
      ["?state=claimed&limit=50&before=400", "tasks_waiting_idx"],
      ["?state=done&limit=50", "tasks_done_idx"],
    ] as const) {
      const plan = await planOf(`/v1/spaces/planned-space/tasks${query}`, "schellingaf.task_item");
      assert.match(plan, new RegExp(`(Index|Bitmap Index) Scan( Backward)? on ${index}|Index Scan Backward using ${index}`), `${query}:\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on tasks|tasks_space_id_number_key/, `${query}: the list read every task:\n${plan}`);
    }
  });

  test("a SPACE's findings page back on their number, and what each rests on and what cites it are probes", async () => {
    for (const query of [
      "?limit=50", "?limit=50&before=400", "?status=supported&limit=50", "?status=withdrawn&limit=50",
      "?since=2026-01-01T00%3A00%3A00Z&limit=50",
    ]) {
      const plan = await planOf(`/v1/spaces/planned-space/findings${query}`, "from schellingaf.findings f");
      // The findings that stand or were withdrawn, walked back on the number, never sorted.
      assert.match(plan, /Index Scan Backward using findings_listed_idx on findings f/, `${query}:\n${plan}`);
      if (query.includes("before=")) {
        assert.match(plan, /Index Cond: \(\(space_id = \$\d+\) AND \(number < \$\d+\)\)/, `${query}: the cursor was not an index condition:\n${plan}`);
      }
      // What a finding cites is its own rows, what cites it one probe of the citing index,
      // and whether a source moved two probes of the indexes posts.get reads.
      assert.match(plan, /post_sources_(pkey|post_id_ord_key)/, `${query}:\n${plan}`);
      assert.match(plan, /post_sources_cited_idx/, `${query}:\n${plan}`);
      assert.match(plan, /posts_supersedes_idx/, `${query}:\n${plan}`);
      assert.match(plan, /posts_retracts_idx/, `${query}:\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on (findings|post_sources|posts)/, `${query}:\n${plan}`);
      assert.doesNotMatch(plan, /Sort Key: .*number/, `${query}: the list sorted the SPACE's findings:\n${plan}`);
      // The task a finding is the result of: a probe for the task whose result it is, and
      // one for the checks that judged it, never a read of the SPACE's tasks or checks.
      assert.match(plan, /tasks_done_post_idx/, `${query}:\n${plan}`);
      assert.match(plan, /task_checks_result_idx/, `${query}:\n${plan}`);
      assert.doesNotMatch(plan, /Seq Scan on (tasks|task_checks)/, `${query}:\n${plan}`);
    }
  });

  test("a SPACE's findings kept to a label find the label's posts through the SPACE's own index", async () => {
    // Fifty images over six hundred findings: either the label's rows are found by the
    // index SEEK probes and only they are sorted, or the findings are walked back and each
    // asked about its label. Never a read of every label of every SPACE.
    const plan = await planOf("/v1/spaces/planned-space/findings?fingerprint=subject%3Awenmi.image%3A037&limit=50", "from schellingaf.findings f");
    assert.match(plan, /fingerprints_seek_idx|post_fingerprints_pkey/, plan);
    assert.doesNotMatch(plan, /Seq Scan on (findings|post_sources|posts|post_fingerprints)/, plan);
  });

  test("a post's sources are looked up by id and by seq through the SPACE's own indexes, before it is written", async () => {
    // The authors told a post cites them are read beforehand, for their allowance: a probe
    // of the posts' key for the ids and of the SPACE's seq index for the seqs, whatever the
    // SPACE holds, never a walk of its posts.
    await call("POST", "/v1/spaces", owner, { name: "citing-space", title: "Citing" });
    const first = await call("POST", "/v1/spaces/citing-space/posts", owner, { kind: "obs", body: "A source." });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const seen = await sentPost("/v1/spaces/citing-space/posts", owner, {
      kind: "result", body: "Rests on it twice over.", data: { sources: [first.body.seq] },
    });
    const plan = await genericPlanAll(statementFor(seen, "p.seq = any"));
    assert.match(plan, /posts_space_id_seq_key/, plan);
    assert.match(plan, /posts_pkey/, plan);
    assert.doesNotMatch(plan, /Seq Scan on posts/, plan);
  });

  test("the posts that cite one post are read from the citing index, newest first", async () => {
    const [cited] = await fixture.owner<{ post_id: string }[]>`
      select q.post_id::text from schellingaf.posts q join schellingaf.spaces s on s.space_id = q.space_id
       where s.name = 'planned-space' order by q.seq limit 1`;
    const plan = await planOf(`/v1/posts/${cited!.post_id}/finding`, "s.source_id =");
    assert.match(plan, /post_sources_cited_idx/, plan);
    assert.doesNotMatch(plan, /Seq Scan on (post_sources|posts)/, plan);
  });

  test("the directory of oracle spaces reads the oracle spaces alone", async () => {
    // Six hundred listed SPACES and two oracles among them: walking the names to find
    // them would read all six hundred.
    const plan = await planOf("/v1/spaces?oracle=true&limit=50", "from schellingaf.spaces s");
    assert.match(plan, /spaces_oracle_idx/, `the oracle directory walked every SPACE:\n${plan}`);
  });
});

/** A request as this file sends it: a JSON content type whether or not there is a body. */
async function call(method: string, path: string, who: Agent, body?: unknown) {
  return read(await send(app, method, path, who, filed(method, path, body), { "content-type": "application/json" }));
}

// ── a post's files ───────────────────────────────────────────────────────────

describe("a file's fetch and attach_files() find their rows through an index", () => {
  // A file on every post of planned-space, uploaded by its owner, so a walk of the files,
  // the uploads, the attachments or the fingerprints is unmistakable in a plan.
  before(async () => {
    await fixture.owner`
      insert into schellingaf.space_files (space_id, sha256, content, bytes, is_text, attached)
      select s.space_id, sha256(x.c), x.c, octet_length(x.c), true, true
        from schellingaf.spaces s cross join generate_series(1, ${POSTS}) g
             cross join lateral (select convert_to('file ' || g, 'UTF8') as c) x
       where s.name = 'planned-space'`;
    await fixture.owner`
      insert into schellingaf.file_uploads (space_id, sha256, uploader_id)
      select f.space_id, f.sha256, decode(${owner.peerId}, 'hex')
        from schellingaf.space_files f join schellingaf.spaces s on s.space_id = f.space_id
       where s.name = 'planned-space'`;
    await fixture.owner`
      insert into schellingaf.post_attachments (post_id, ord, space_id, sha256, name, media_type, bytes)
      select p.post_id, 1, p.space_id, sha256(x.c), 'file-' || p.seq || '.txt', 'text/plain', octet_length(x.c)
        from schellingaf.posts p join schellingaf.spaces s on s.space_id = p.space_id
             cross join lateral (select convert_to('file ' || p.seq, 'UTF8') as c) x
       where s.name = 'planned-space' and p.seq <= ${POSTS}`;
    await fixture.owner`
      insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
      select a.post_id, a.space_id, 'sha256.file', encode(a.sha256, 'hex')
        from schellingaf.post_attachments a join schellingaf.spaces s on s.space_id = a.space_id
       where s.name = 'planned-space'`;
    await fixture.owner`analyze`;
  });

  test("a file's fetch probes the file by its key and the posts attaching it by their index", async () => {
    const address = createHash("sha256").update("file 400").digest("hex");
    const plan = await genericPlanAll(statementFor(await sent(`/v1/spaces/planned-space/files/${address}`, owner), "space_files f"));
    assert.match(plan, /space_files_pkey/, plan);
    assert.match(plan, /post_attachments_file_idx/, plan);
    assert.doesNotMatch(plan, /Seq Scan on (space_files|post_attachments|posts)\b/, plan);
  });

  test("attach_files() reads the post, its fingerprints, the files and their uploads by key, under a generic plan", async () => {
    // A pending upload, and a post naming it, written without its attachment rows; then
    // attach_files() called as the post route calls it, inside a transaction rolled back,
    // with auto_explain logging every statement it runs. Loading that takes a superuser.
    // planned-space's posts were written without their chain, so the post goes elsewhere;
    // a generic plan is the same for every SPACE.
    const made = await call("POST", "/v1/spaces", owner, { name: "attaching-space", title: "Attaching" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const content = "a file for the plan";
    const hash = createHash("sha256").update(content).digest("hex");
    await fixture.owner`
      insert into schellingaf.space_files (space_id, sha256, content, bytes, is_text)
      select s.space_id, decode(${hash}, 'hex'), convert_to(${content}, 'UTF8'), ${Buffer.byteLength(content)}, true
        from schellingaf.spaces s where s.name = 'attaching-space'`;
    await fixture.owner`
      insert into schellingaf.file_uploads (space_id, sha256, uploader_id)
      select s.space_id, decode(${hash}, 'hex'), decode(${owner.peerId}, 'hex')
        from schellingaf.spaces s where s.name = 'attaching-space'`;
    const posted = await call("POST", "/v1/spaces/attaching-space/posts", owner, {
      kind: "result", body: "Rests on a file.", fingerprints: [{ scheme: "sha256.file", value: hash }],
    });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));

    type PlanNode = { [field: string]: any; Plans?: PlanNode[] };
    const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
    const logged: string[] = [];
    const su = postgres({ ...SUPERUSER, database: fixture.name, onnotice: (n) => logged.push(n.message ?? "") });
    try {
      await su`load 'auto_explain'`;
      for (const setting of ["log_min_duration = 0", "log_nested_statements = on", "log_format = json", "log_level = notice"]) {
        await su.unsafe(`set auto_explain.${setting}`);
      }
      await su
        .begin(async (tx) => {
          await tx.unsafe("set local role schellingaf_api");
          await tx.unsafe("set local plan_cache_mode = force_generic_plan");
          const attachments = [{ sha256: hash, name: "plan.txt", media_type: "text/plain" }];
          await tx`select schellingaf.attach_files(${posted.body.post_id}::uuid, decode(${owner.peerId}, 'hex'),
                                                   ${tx.json(attachments)}, false, 24, 268435456)`;
          throw new Error("roll back");
        })
        .catch((error: Error) => {
          if (error.message !== "roll back") throw error;
        });
    } finally {
      await su.end({ timeout: 5 });
    }
    const plans = logged
      .filter((m) => m.includes("{"))
      .map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
    const nodes = plans.flatMap((p) => nodesOf(p.Plan));
    const read = new Set(nodes.map((n) => n["Relation Name"]).filter(Boolean));
    for (const table of ["posts", "post_fingerprints", "space_files", "file_uploads"]) {
      assert.ok(read.has(table), `attach_files() read no ${table}: ${[...read].join(", ")}`);
    }
    const walked = (plan: PlanNode) =>
      nodesOf(plan)
        .filter((n) => n["Node Type"] === "Seq Scan" && ["posts", "post_fingerprints", "space_files", "file_uploads", "post_attachments"].includes(n["Relation Name"]))
        .map((n) => n["Relation Name"]);
    const walks = plans.filter((p) => walked(p.Plan).length).map((p) => `${walked(p.Plan).join(", ")} in: ${p["Query Text"].replace(/\s+/g, " ")}`);
    assert.deepEqual(walks, []);
  });
});

// ── the operator's report ────────────────────────────────────────────────────

describe("npm run query-plans reads what the service sends, and nothing it wrote itself", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));

  test("given statements captured from real routes, it plans them and names their indexes", async () => {
    // pg_stat_statements is what the deployed database hands it; this test stack
    // does not preload it, so the report is handed a capture instead — the same
    // statements, from the same driver, through the other door it has.
    const captured = [
      ...(await sent("/v1/spaces/planned-space/posts?after=100&limit=50", owner)),
      ...(await sent("/v1/mailbox?after=0&limit=50", owner)),
      ...(await sent("/v1/spaces/planned-space/members?limit=50", owner)),
    ];
    const dir = mkdtempSync(path.join(tmpdir(), "plans-"));
    const file = path.join(dir, "captured.jsonl");
    writeFileSync(file, captured.map((s) => JSON.stringify({ query: s.sql })).join("\n") + "\n");
    try {
      const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "query-plans.ts"), "--statements", file], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, DB_NAME: fixture.name, DB_PORT: String(PORT) },
      });
      assert.match(out, /THE TWO SEEKS, CALLED AS THE ROUTE CALLS THEM/, out);
      assert.match(out, /text seek on the commonest word/, out);
      assert.match(out, /first five on a connection/, out);
      assert.match(out, /Index Scan using posts_space_id_seq_key/, `the stream read's own index is missing:\n${out}`);
      assert.match(out, /mailbox_deliveries_pkey/, `the mailbox read's own index is missing:\n${out}`);
      assert.doesNotMatch(out, /could not be explained/, out);
      assert.doesNotMatch(out, /WARNING/, out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("and it carries no read statement of its own to stand in for them", () => {
    // Explaining a paraphrase certifies the author's intentions, not the service.
    const script = readFileSync(path.join(ROOT, "scripts", "query-plans.ts"), "utf8");
    assert.doesNotMatch(script, /from schellingaf\.visible_posts/, "the report hand-writes a stream read");
    assert.doesNotMatch(script, /from schellingaf\.mailbox_deliveries/, "the report hand-writes a mailbox read");
    assert.doesNotMatch(script, /schellingaf\.post_fingerprints x\b/, "the report paraphrases the fingerprint seek");
    assert.doesNotMatch(script, /from schellingaf\.post_search s\b/, "the report paraphrases the text seek");
  });
});
