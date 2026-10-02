// How the reads perform against real data, measured on what the service sends.
//
//   DB_NAME=schellingaf_seed node scripts/query-plans.ts
//   DB_NAME=schellingaf     node scripts/query-plans.ts                 # production
//   node scripts/query-plans.ts --statements captured.jsonl              # a file of statements
//
// THIS SCRIPT WRITES NO SQL OF ITS OWN FOR THE READS. A paraphrase of what a
// route sends certifies its author's intentions rather than the service, and a
// paraphrase of a function is planned once from literals where the function is
// planned through the plan cache from its arguments. So none of its three
// sections paraphrases anything.
//
// 1. The two seeks, CALLED — the real definer functions, with the arguments the
//    route passes, as the service role with a caller bound — and measured twice:
//    under a generic plan, which is the steady state, and under a custom plan,
//    which is what the first five executions on every pooled connection get. A
//    custom plan that costs far more than the generic one is the signature of a
//    seek that walks spaces the caller cannot read.
//
// 2. The read statements the SERVICE ACTUALLY SENT, taken from pg_stat_statements
//    (installed in the deployed database) or from a file of captured statements,
//    and explained with EXPLAIN (GENERIC_PLAN) as the service role — the plan a
//    prepared statement gets, with the row-level policies in it. Where neither
//    source exists, it says so and does not invent statements to stand in for
//    them. test/route-plans.test.ts captures the same statements on a fixture and
//    fails the build on a bad shape.
//
// 3. Table sizes, the baseline the first month of traffic is compared against.
//
// Read-only. It never writes to the database it is pointed at.

import { readFileSync } from "node:fs";
import postgres from "postgres";
import { childrenOf, pathOf } from "../src/surface/categories.ts";
import { CANDIDATES_PER_SPACE, CANDIDATES_TOTAL, PUBLIC_CANDIDATES, RANK_WORK } from "../src/http/seek.ts";
import {
  PUBLIC_PRINT_WINDOW,
  PUBLIC_RESULTS_PER_OWNER,
  PUBLIC_RESULTS_PER_SPACE,
  PUBLIC_TEXT_WINDOW,
} from "../src/http/postview.ts";

const connection = {
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 5439),
  database: process.env.DB_NAME ?? "schellingaf_seed",
  max: 1,
  onnotice: () => {},
};
const sql = postgres({
  ...connection,
  username: "schellingaf_api",
  password: process.env.DB_PASSWORD ?? "test_api_password_not_a_secret",
});
const owner = postgres({
  ...connection,
  username: "schellingaf_migrate",
  password: process.env.OWNER_PASSWORD ?? "test_migrate_password_not_a_secret",
});
await owner`set role schellingaf_owner`;

const out = (line = "") => process.stdout.write(line + "\n");
const statementsFile = (() => {
  const at = process.argv.indexOf("--statements");
  return at === -1 ? null : (process.argv[at + 1] ?? null);
})();

/** The rows of an EXPLAIN as one text. */
const planText = (rows: postgres.Row[]) => rows.map((row) => Object.values(row)[0]).join("\n");

/** Buffers touched, from EXPLAIN (ANALYZE, BUFFERS). A function scan's count
 * includes everything done inside the function, which is what makes this work. */
const buffersOf = (plan: string) =>
  [...plan.matchAll(/shared hit=(\d+)(?: read=(\d+))?/g)].reduce(
    (n, m) => n + Number(m[1]) + Number(m[2] ?? 0),
    0,
  );

/** The exclusive upper bound of an exact fingerprint match: the value followed by
 * the smallest code point. Built rather than written as an escape, so the source
 * holds no raw control character. */
const justAbove = (value: string) => value + String.fromCharCode(1);

/** Run as the service role, with the caller bound exactly as readTx binds it. */
async function asService<T>(caller: string, run: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('schellingaf.peer_id', ${caller}, true)`;
    return run(tx as unknown as postgres.Sql);
  })) as T;
}

// A KEY in a realistic number of SPACES: the one in the most.
const [caller] = await owner<{ peer: string; spaces: number }[]>`
  select encode(m.peer_id, 'hex') as peer, count(*)::int as spaces
    from schellingaf.memberships m
   group by m.peer_id order by count(*) desc limit 1`;
const callerHex = caller?.peer ?? "";
out(caller ? `caller is a KEY in ${caller.spaces} SPACE(s)` : "no memberships in this database; reading as a KEY in none");

// ── 1. the two seeks, called ─────────────────────────────────────────────────

out("\nTHE TWO SEEKS, CALLED AS THE ROUTE CALLS THEM");

async function measure(label: string, call: string, params: unknown[]): Promise<{ ms: string; buffers: number }> {
  const cost: Record<string, { ms: string; buffers: number }> = {};
  for (const mode of ["force_generic_plan", "force_custom_plan"]) {
    let last = { ms: "?", buffers: 0 };
    // Twice, and the second is the measurement: the first call in a fresh
    // transaction also reads catalog pages.
    for (let i = 0; i < 2; i++) {
      const rows = await asService(callerHex, async (tx) => {
        await tx.unsafe(`set local plan_cache_mode = ${mode}`);
        return tx.unsafe(`explain (analyze, buffers) ${call}`, params as never[]);
      });
      const text = planText(rows as postgres.Row[]);
      last = { ms: text.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? "?", buffers: buffersOf(text) };
    }
    cost[mode] = last;
  }
  const generic = cost.force_generic_plan!;
  const custom = cost.force_custom_plan!;
  out(`\n${label}`);
  out(`  steady state (generic plan)   ${generic.ms} ms, ${generic.buffers} buffers`);
  out(`  first five on a connection    ${custom.ms} ms, ${custom.buffers} buffers`);
  if (custom.buffers > Math.max(generic.buffers * 5, generic.buffers + 500)) {
    out("  WARNING: the first executions on a connection cost far more than the steady state.");
    out("  That is the signature of a seek that walks spaces the caller cannot read.");
  }
  return generic;
}

const [print] = await owner<{ scheme: string; value: string }[]>`
  select scheme, value from schellingaf.post_fingerprints limit 1`;
if (print) {
  await measure(
    `fingerprint seek (${print.scheme})`,
    "select * from schellingaf.seek_fingerprint($1, $2, $3, null, $4, $5, $6, $7)",
    [print.scheme, print.value, justAbove(print.value), 10, PUBLIC_PRINT_WINDOW, PUBLIC_RESULTS_PER_SPACE, PUBLIC_RESULTS_PER_OWNER],
  );
} else {
  out("\nno fingerprints in this database, so the fingerprint seek cannot be measured");
}

// The commonest word in a sample of about five thousand posts: the expensive case
// for a text seek. Sized from the table's own estimate, because a fixed one-percent
// sample of a small table is often empty and of a large one is needlessly big.
const [estimate] = await owner<{ rows: number }[]>`
  select greatest(reltuples, 0)::float8 as rows from pg_class where oid = 'schellingaf.post_search'::regclass`;
const samplePct = Math.min(100, Math.max(0.01, (5000 * 100) / Math.max(1, estimate?.rows ?? 1)));
const [word] = await owner<{ word: string }[]>`
  select word from ts_stat(${`select tsv from schellingaf.post_search tablesample bernoulli (${samplePct.toFixed(4)})`})
   order by ndoc desc limit 1`.catch(() => []);
if (word) {
  const unscoped = await measure(
    `text seek on the commonest word ("${word.word}")`,
    "select * from schellingaf.seek_text($1, null, $2, $3, $4, $5, $6, $7, $8)",
    [word.word, CANDIDATES_PER_SPACE, CANDIDATES_TOTAL, PUBLIC_CANDIDATES, PUBLIC_TEXT_WINDOW, PUBLIC_RESULTS_PER_SPACE, PUBLIC_RESULTS_PER_OWNER, RANK_WORK],
  );

  // The same word kept to a category: the busiest one with nothing below it, and the
  // top category it is in. A category SEEK probes that category's SPACES one by one
  // instead of reading one window; it should cost about what the unscoped one does,
  // and a warning names three times as much.
  const busy = await owner<{ category: string; n: number }[]>`
    select category, count(*)::int as n from schellingaf.space_categories group by category order by n desc`;
  const leaf = busy.find((b) => childrenOf(b.category).length === 0);
  if (leaf) {
    const top = pathOf(leaf.category)[0]?.id ?? leaf.category;
    for (const id of [...new Set([leaf.category, top])]) {
      await measure(
        `text seek on the same word, kept to ${id} (${busy.find((b) => b.category === id)?.n ?? 0} SPACES)`,
        "select * from schellingaf.seek_text($1, null, $2, $3, $4, $5, $6, $7, $8, $9)",
        [word.word, CANDIDATES_PER_SPACE, CANDIDATES_TOTAL, PUBLIC_CANDIDATES, PUBLIC_TEXT_WINDOW, PUBLIC_RESULTS_PER_SPACE, PUBLIC_RESULTS_PER_OWNER, RANK_WORK, id],
      );
      // As the route calls it: with the category's window taken already, which it
      // does at most once a minute for each category and shares between searches.
      const [taken] = await owner<{ ids: string[] }[]>`
        select coalesce(array_agg(w.space_id::text), '{}') as ids
          from schellingaf.seek_category_spaces(${id}, ${PUBLIC_RESULTS_PER_OWNER}, ${PUBLIC_TEXT_WINDOW}) w`;
      const shared = await measure(
        `  and with its window of ${taken?.ids.length ?? 0} public SPACES taken already, as the route passes it`,
        "select * from schellingaf.seek_text($1, null, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[])",
        [word.word, CANDIDATES_PER_SPACE, CANDIDATES_TOTAL, PUBLIC_CANDIDATES, PUBLIC_TEXT_WINDOW, PUBLIC_RESULTS_PER_SPACE, PUBLIC_RESULTS_PER_OWNER, RANK_WORK, id, taken?.ids ?? []],
      );
      if (Number(shared.ms) > 3 * Number(unscoped.ms)) {
        out(`  WARNING: kept to ${id} it costs more than three times the unscoped SEEK.`);
        out("  The answers are a smaller probe window, or a higher price for a category SEEK.");
      }
    }
  } else {
    out("\nno SPACE is filed under a category here, so a category seek cannot be measured");
  }
} else {
  out("\nno searchable posts in this database, so the text seek cannot be measured");
}

// ── 2. what the service sent ─────────────────────────────────────────────────

out("\nTHE READS THE SERVICE SENT");

type Sent = { query: string; calls?: number; mean_ms?: number };
let sent: Sent[] = [];
let source = "";
if (statementsFile) {
  sent = readFileSync(statementsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Sent);
  source = `captured statements in ${statementsFile}`;
} else {
  // Its own statements only, which the service role may read in full.
  const rows = await sql<{ query: string; calls: string; mean_ms: number }[]>`
    select s.query, s.calls::text, s.mean_exec_time as mean_ms
      from pg_stat_statements s join pg_roles r on r.oid = s.userid
     where r.rolname = current_user and s.query ilike '%schellingaf.%'
     order by s.total_exec_time desc limit 40`.catch(() => null);
  if (rows === null) {
    out("  pg_stat_statements is not installed in this database, so the statements the service");
    out("  sent cannot be read here. Nothing is invented in their place: test/route-plans.test.ts");
    out("  checks the same statements against a fixture, or pass --statements with a capture.");
  } else {
    sent = rows.map((r) => ({ query: r.query, calls: Number(r.calls), mean_ms: r.mean_ms }));
    source = "pg_stat_statements";
  }
}

// Only the reads that touch data. The caller binding, transaction control and
// the seek function calls (measured above) are not plans worth reading.
const reads = sent
  .filter((s) => /^\s*(select|with)\b/i.test(s.query))
  .filter((s) => !/set_config\(|seek_text\(|seek_fingerprint\(/.test(s.query))
  .slice(0, 12);
if (source && reads.length === 0) out(`  ${source} holds no read statements from the service yet`);

// A sequential scan is only a finding on a table big enough for one to cost
// something: on a table of a few hundred rows it is the planner's correct choice,
// and a report that warns about it teaches its reader to ignore warnings.
const MUST_NOT_SCAN = ["posts", "post_search", "post_fingerprints", "mailbox_deliveries", "space_events", "memberships"];
const SCAN_WORTH_A_WARNING = 10_000;
const tableRows = new Map(
  (
    await owner<{ name: string; rows: number }[]>`
      select c.relname as name, greatest(c.reltuples, 0)::float8 as rows
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'schellingaf' and c.relname = any(${MUST_NOT_SCAN})`
  ).map((r) => [r.name, r.rows] as const),
);
for (const stmt of reads) {
  const explained = await asService(callerHex, (tx) =>
    tx.unsafe(`explain (generic_plan, costs off) ${stmt.query}`),
  ).catch((error: Error) => error);
  const head = stmt.query.replace(/\s+/g, " ").trim().slice(0, 96);
  out(`\n${head}${stmt.query.length > 96 ? "…" : ""}`);
  if (stmt.calls !== undefined) out(`  ${stmt.calls} calls, ${(stmt.mean_ms ?? 0).toFixed(2)} ms on average`);
  if (explained instanceof Error) {
    out(`  could not be explained: ${explained.message}`);
    continue;
  }
  const text = planText(explained as postgres.Row[]);
  const scans = [...text.matchAll(/(Seq Scan on \w+|Index (?:Only )?Scan(?: Backward)? using \w+|Bitmap Index Scan on \w+)/g)]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const scan of scans) out(`  ${scan}`);
  for (const m of text.matchAll(/Seq Scan on (\w+)/g)) {
    const rows = tableRows.get(m[1]!);
    if (rows !== undefined && rows > SCAN_WORTH_A_WARNING) {
      out(`  WARNING: a sequential scan on ${m[1]}, which holds about ${Math.round(rows).toLocaleString()} rows`);
    }
  }
  if (/Sort Key: [^\n]*\bseq\b/.test(text)) {
    out("  WARNING: it sorts by seq, where the index could have returned the rows in order");
  }
}
if (source) out(`\n(source: ${source})`);

// ── 3. the baseline ──────────────────────────────────────────────────────────

const sizes = await owner<{ table: string; rows: string; total: string; indexes: string }[]>`
  select c.relname as table,
         to_char(c.reltuples::bigint, 'FM999,999,999') as rows,
         pg_size_pretty(pg_total_relation_size(c.oid)) as total,
         pg_size_pretty(pg_indexes_size(c.oid)) as indexes
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'schellingaf' and c.relkind = 'r'
     and c.reltuples > 0
   order by pg_total_relation_size(c.oid) desc`;

out("\n\n  table                    rows          total     indexes");
out("  " + "-".repeat(58));
for (const row of sizes) {
  out(`  ${row.table.padEnd(24)} ${row.rows.padStart(11)}  ${row.total.padStart(9)}  ${row.indexes.padStart(9)}`);
}
const [total] = await owner<{ size: string }[]>`
  select pg_size_pretty(sum(pg_total_relation_size(c.oid))) as size
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'schellingaf' and c.relkind = 'r'`;
out(`\n  whole schema: ${total!.size}`);

await sql.end();
await owner.end();
