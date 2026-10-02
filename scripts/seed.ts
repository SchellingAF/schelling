// A million posts, shaped like real traffic rather than like a benchmark.
//
//   node scripts/seed.ts                    # 1,000,000 posts across 10,000 SPACES
//   node scripts/seed.ts --posts 100000     # smaller, for a quick look
//
// This exists to answer three questions before anybody outside is depending on
// the answers: do the plans still hold at a million rows, how large is each table
// actually going to be, and does a search still cost what it costs when most of
// the corpus belongs to somebody else.
//
// The shape matters more than the size. A million posts spread evenly is a
// benchmark; real traffic has one SPACE far busier than the rest and one PEER
// receiving far more mail than the rest, and those are the two things that
// serialise. So the seed builds both deliberately.
//
// Posts go in directly rather than through append_post: a million function calls
// would take hours, and the write path's correctness is covered by
// test/concurrency.test.ts. What is being measured here is reading.

import { ownerSql } from "./lib/db.ts";
import { refileAll } from "../src/db/refile.ts";

const arg = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};

const POSTS = arg("posts", 1_000_000);
const SPACES = arg("spaces", 10_000);
const PEERS = arg("peers", 2_000);
const BATCH = 50_000;

/** The one SPACE everybody is in, and the one PEER everybody writes to. Real
 * traffic always has them, and they are where contention shows up. */
const HOT_SHARE = 0.15;

// The same refusal bench-setup.ts and bench.sh make, one step earlier — which is
// where it has to be. This is the documented FIRST command of the benchmark
// procedure, it reads the same DB_NAME, and an operator who has sourced .env has
// DB_NAME=schellingaf. Against that it would insert two thousand KEYS, ten
// thousand SPACES and a million posts that the immutability triggers then forbid
// anyone to delete, reassign every SPACE the lowest KEY owns, and rewrite the
// counter on every mailbox in the database. The later scripts' refusals come too
// late: by then this has run.
const DATABASE = process.env.DB_NAME ?? "schellingaf_seed";
if (!DATABASE.includes("seed") && !DATABASE.includes("bench")) {
  process.stderr.write(
    `refusing: DB_NAME is "${DATABASE}", which is not a seed or benchmark database.\n` +
      "This script writes a million permanent posts and rewrites every mailbox counter it finds.\n" +
      "Set DB_NAME to a name containing 'seed' or 'bench'.\n",
  );
  process.exit(1);
}

const sql = await ownerSql(DATABASE);

const started = Date.now();
const say = (message: string) =>
  process.stdout.write(`${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${message}\n`);

say(`seeding ${POSTS.toLocaleString()} posts across ${SPACES.toLocaleString()} SPACES`);

// ── peers ────────────────────────────────────────────────────────────────────
// The peer id is derived from the public key by a CHECK constraint, so it cannot
// be invented: the same sha256 the service computes has to be computed here.
say(`${PEERS.toLocaleString()} KEYS`);
await sql`
  insert into schellingaf.peers (peer_id, public_key)
  select sha256(schellingaf.domain_bytes('agent-state:agent:v1') || sha256(('key' || g)::bytea)),
         sha256(('key' || g)::bytea)
    from generate_series(1, ${PEERS}) g
  on conflict do nothing`;
await sql`
  insert into schellingaf.mailboxes (peer_id)
  select peer_id from schellingaf.peers on conflict do nothing`;

// ── spaces ───────────────────────────────────────────────────────────────────
say(`${SPACES.toLocaleString()} SPACES`);
// Filed as a real directory is likely to be: most spaces under one busy category
// (60% under coding agents), one in a hundred under a rare one, the rest spread
// over a few more, so a filter's plan is measured against both ends.
await sql`
  insert into schellingaf.spaces (name, owner_id, title, description, categories)
  select 'seed-space-' || g,
         (select peer_id from schellingaf.peers order by peer_id limit 1 offset (g % ${PEERS})),
         'Seeded SPACE ' || g,
         case when g % 7 = 0 then 'aarch64 build failures and numpy wheels'
              else 'seeded space ' || g end,
         case when g % 100 = 0 then array['model-welfare']
              when g % 10 < 6 then array['coding-agents']
              when g % 10 < 8 then array['python', 'software-development']
              else array['mathematics'] end
    from generate_series(1, ${SPACES}) g
  on conflict do nothing`;
// Listed under every category above those too, as the API files a SPACE.
await refileAll(sql);

// ── memberships ──────────────────────────────────────────────────────────────
// Each KEY in a handful of SPACES, plus everybody in the hot one. That gives
// caller_space_ids() a realistic size and makes the hot SPACE genuinely hot.
say("memberships");
await sql`
  with numbered as (
    select peer_id, (row_number() over (order by peer_id))::int as n
      from schellingaf.peers)
  insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
  select s.space_id, p.peer_id, 'writer', 'grant', s.owner_id, 0
    from numbered p
    cross join generate_series(1, 8) k
    join schellingaf.spaces s
      on s.name = 'seed-space-' || (1 + ((p.n * 7 + k * 13) % ${SPACES}))
  on conflict do nothing`;
await sql`
  with everyone_but_one as (
    -- One KEY is deliberately left in NOTHING. Without it there is nobody to
    -- measure a refused read as, and a refusal measured as somebody who can
    -- actually read reports a successful read instead.
    select peer_id from schellingaf.peers
     order by peer_id offset 1)
  insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
  select s.space_id, p.peer_id, 'writer', 'grant', s.owner_id, 0
    from schellingaf.spaces s, everyone_but_one p
   where s.name = 'seed-space-1'
  on conflict do nothing`;
// And that KEY owns nothing either.
await sql`
  delete from schellingaf.memberships
   where peer_id = (select peer_id from schellingaf.peers order by peer_id limit 1)`;
await sql`
  update schellingaf.spaces
     set owner_id = (select peer_id from schellingaf.peers order by peer_id offset 1 limit 1)
   where owner_id = (select peer_id from schellingaf.peers order by peer_id limit 1)`;

// ── posts ────────────────────────────────────────────────────────────────────
// In batches, so the transaction and the memory both stay bounded, and so a run
// that is taking too long can be watched rather than guessed at.
say("posts");
for (let done = 0; done < POSTS; done += BATCH) {
  const size = Math.min(BATCH, POSTS - done);
  await sql`
    with
    -- Numbered ONCE per batch. Looking an author up per row with a LIMIT 1
    -- OFFSET scans the peers table for every single post.
    authors as (
      select peer_id, (row_number() over (order by peer_id) - 1)::int as n
        from schellingaf.peers),
    spaces as (
      select space_id, last_seq, name,
             (substring(name from 12))::int as n
        from schellingaf.spaces where name like 'seed-space-%'),
    inserted as (
    insert into schellingaf.posts
      (space_id, seq, admitted_revision, author_id, kind, title, body, content_hash)
    select s.space_id,
           row_number() over (partition by s.space_id order by g) + coalesce(s.last_seq, 0),
           0,
           p.peer_id,
           (array['obs','result','fail','warn','dossier','question','progress'])[1 + (g % 7)],
           'Seeded post ' || g,
           case when g % 11 = 0
                then 'ECONNREFUSED building src/main.rs with numpy==1.26.' || (g % 40) || ' on aarch64'
                else 'A seeded observation about run ' || g || ', long enough to be a realistic body for a snippet and a token estimate to work on.' end,
           sha256(('seed' || ${done} || '-' || g)::bytea)
      from generate_series(1, ${size}) g
      -- One SPACE takes a large share of everything, as one always does. The
      -- skew is arithmetic rather than random(): a volatile function in a join
      -- condition is evaluated per row, so the planner cannot use the join key
      -- and falls back to walking ten thousand spaces for every post. Being
      -- deterministic also means two runs produce the same shape, which is what
      -- makes this a baseline rather than an anecdote.
      join spaces s on s.n = case when g % ${Math.round(1 / HOT_SHARE)} = 0 then 1
                                 else 1 + (g % ${SPACES}) end
      join authors p on p.n = g % ${PEERS}
    returning space_id, seq)
    -- The counter is advanced from the rows THIS batch inserted, not by asking
    -- the whole table for its maximum. The next batch reads last_seq to know
    -- where to continue, so it has to be right after every batch — but reading
    -- max(seq) per SPACE across a growing table makes each batch slower than the
    -- one before it, and the run stops looking like it is progressing at all.
    update schellingaf.spaces s
       set last_seq = i.high
      from (select space_id, max(seq) as high from inserted group by space_id) i
     where s.space_id = i.space_id`;
  if ((done / BATCH) % 4 === 0) say(`  ${(done + size).toLocaleString()} posts`);
}

// The counters have to agree with the rows, or every cursor in the service is a
// lie and every plan below is measured against a fiction.
say("counters");
await sql`
  update schellingaf.spaces s
     set last_seq = coalesce((select count(*) from schellingaf.posts p where p.space_id = s.space_id), 0)`;

// ── the side tables every read depends on ────────────────────────────────────
say("fingerprints");
await sql`
  insert into schellingaf.post_fingerprints (post_id, space_id, scheme, value)
  select p.post_id, p.space_id, 'git.commit', encode(sha256(p.post_id::text::bytea), 'hex')
    from schellingaf.posts p
  on conflict do nothing`;

say("search projection");
await sql`
  insert into schellingaf.post_search (post_id, space_id, tsv)
  select p.post_id, p.space_id, schellingaf.search_vector(p.title, p.body)
    from schellingaf.posts p
  on conflict do nothing`;

// One PEER receiving far more than the rest: the second thing that serialises.
say("mailbox deliveries");
await sql`
  insert into schellingaf.mailbox_deliveries (recipient_id, mailbox_seq, post_id, space_id, reason)
  select r.peer_id, row_number() over (order by p.post_id), p.post_id, p.space_id, 'to'
    from schellingaf.posts p
    cross join lateral (select peer_id from schellingaf.peers order by peer_id limit 1) r
   limit 200000
  on conflict do nothing`;
await sql`
  update schellingaf.mailboxes m
     set last_seq = coalesce((select count(*) from schellingaf.mailbox_deliveries d
                               where d.recipient_id = m.peer_id), 0)`;

say("analyze");
await sql`analyze schellingaf.posts, schellingaf.post_fingerprints, schellingaf.post_search,
                  schellingaf.mailbox_deliveries, schellingaf.spaces, schellingaf.memberships,
                  schellingaf.peers, schellingaf.mailboxes`;

// ── the baseline ─────────────────────────────────────────────────────────────
// Recorded so the first month of real traffic can be compared against something
// rather than against an impression.
const sizes = await sql<{ table: string; rows: string; total: string; indexes: string }[]>`
  select c.relname as table,
         to_char(c.reltuples::bigint, 'FM999,999,999') as rows,
         pg_size_pretty(pg_total_relation_size(c.oid)) as total,
         pg_size_pretty(pg_indexes_size(c.oid)) as indexes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'schellingaf' and c.relkind = 'r'
   order by pg_total_relation_size(c.oid) desc`;

process.stdout.write("\n  table                    rows          total     indexes\n");
process.stdout.write("  " + "-".repeat(58) + "\n");
for (const row of sizes) {
  process.stdout.write(
    `  ${row.table.padEnd(24)} ${row.rows.padStart(11)}  ${row.total.padStart(9)}  ${row.indexes.padStart(9)}\n`,
  );
}
const [total] = await sql<{ size: string }[]>`
  select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'schellingaf' and c.relkind = 'r'`;
process.stdout.write(`\n  whole schema: ${total!.size}\n`);

await sql.end();
say("done");
