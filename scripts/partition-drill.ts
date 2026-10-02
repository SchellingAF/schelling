// Rehearse the one migration that cannot be metadata-only, and time its locks.
//
//   DB_NAME=schellingaf_part node scripts/partition-drill.ts
//   DB_NAME=schellingaf_part node scripts/partition-drill.ts --check   # verify only
//
// `posts` is one table until it outgrows memory, at roughly a hundred million
// rows. runbooks/partition.md is how to partition it then. A runbook nobody has
// executed is a wish, and this one will be read for the first time on a day when
// the service is already in trouble — so it is rehearsed here, on a seeded copy,
// and every lock it takes is timed.
//
// The point is not the duration. It is which steps take a lock that stops the
// service, and for how long, so the work can be split into the part that runs on
// a Tuesday afternoon and the part that needs a window.
//
// Everything the procedure re-creates on the new parent — its columns and CHECKs,
// its indexes, the foreign keys into it and out of it, its triggers, policies and
// grants, the views over it — is read from the catalog when the drill starts, so a
// later change to `posts` is carried without editing this file.
//
// What it does NOT do: this drill runs against a copy. Lock durations here are
// floors. On a live database every exclusive lock also has to WAIT for the
// statements already running, which is why the runbook sets lock_timeout and
// retries rather than blocking the queue behind it.

import postgres from "postgres";
import { ownerSql } from "./lib/db.ts";

const CHECK_ONLY = process.argv.includes("--check");
/** Stand in for the service's READ_ONLY flag: no writers at all, which is what
 * the runbook tells the operator to arrange before the window. */
const QUIET = process.argv.includes("--read-only");

const DATABASE = process.env.DB_NAME ?? "schellingaf_part";
const sql = await ownerSql(DATABASE);
// The migration login's own search_path names schellingaf, and the catalog then
// prints its names unqualified: a view re-created from that text would be created
// in pg_catalog. With nothing on the path every name comes back qualified.
await sql`set search_path = pg_catalog`;

const out = (line = "") => process.stdout.write(line + "\n");

/**
 * A new SPACE for the drill's own writes, in whatever transaction `tx` is.
 * append_post extends a SPACE's chain of posts, and a seeded SPACE's posts have
 * none, so a write into an existing SPACE can be refused for reasons that have
 * nothing to do with partitioning. Its owner is a KEY create_space accepts: not
 * blocked, and in fewer SPACES than the cap, counted as create_space counts them.
 */
async function drillSpace(tx: postgres.Sql, name: string): Promise<{ name: string; owner: string }> {
  const [owner] = await tx<{ id: string }[]>`
    select encode(pe.peer_id, 'hex') as id from schellingaf.peers pe
     where pe.blocked_at is null
       and (select count(*) from schellingaf.spaces o where o.owner_id = pe.peer_id)
         + (select count(*) from schellingaf.memberships mm where mm.peer_id = pe.peer_id)
         < schellingaf.cap('spaces_per_key')
     order by pe.peer_id limit 1`;
  if (!owner) throw new Error("no KEY here can create a SPACE: every one is blocked or at the cap");
  await tx`select schellingaf.create_space(decode(${owner!.id}, 'hex'), ${name}, 'partition drill', '', 'invite', 'private')`;
  return { name, owner: owner!.id };
}

/**
 * Traffic, for as long as the drill runs.
 *
 * A lock's NAME says what it should block. This says what it did block: a
 * second connection appends a post through the ordinary write function as fast
 * as it can, and records the longest it ever had to wait. That number is the
 * outage, and it is the only figure in this drill anybody should plan around.
 */
async function startTraffic() {
  const conn = await ownerSql(DATABASE);
  const state = { writes: 0, worst: 0, worstAt: "", stop: false, failures: [] as string[] };
  const space = await drillSpace(conn, `drill-traffic-${process.pid}`);
  const run = (async () => {
    while (!state.stop) {
      const t0 = performance.now();
      try {
        await conn`
          select schellingaf.append_post(${space.name}, decode(${space.owner}, 'hex'), 'obs',
            null, 'traffic during the drill', null, null, '{}'::bytea[],
            null, null, null, null, '[]'::jsonb, null)`;
        const waited = performance.now() - t0;
        state.writes++;
        if (waited > state.worst) { state.worst = waited; state.worstAt = currentStep; }
      } catch (error) {
        // A write REFUSED during the swap is the honest outcome to report; a
        // write that silently succeeded against the wrong table would not be.
        state.failures.push(`${currentStep}: ${String((error as Error).message).slice(0, 60)}`);
      }
    }
    await conn.end({ timeout: 5 });
  })();
  return { state, done: () => { state.stop = true; return run; } };
}

let currentStep = "before the drill";

/**
 * A statement that must take a lock the service's own writers hold.
 *
 * Adding a foreign key takes SHARE ROW EXCLUSIVE on the referencing table while
 * a writer may already hold ROW EXCLUSIVE on it and be reaching for `posts`,
 * which is a deadlock. PostgreSQL kills one of the two; it must be this one, not
 * the agent's write. So every such statement runs under a short lock_timeout and
 * is retried, which is what turns a deadlock from an incident into a pause.
 */
async function insist(statement: string): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.begin(async (tx) => {
        // lock_timeout only: deadlock_timeout is superuser-only, and the
        // timeout fires first in the ordinary case anyway. A deadlock that is
        // detected instead arrives as 40P01 and is retried the same way.
        await tx`set local lock_timeout = '250ms'`;
        await tx.unsafe(statement);
      });
      return attempt;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // 55P03 lock_not_available, 40P01 deadlock_detected. Anything else is a
      // real failure and must not be retried into a loop.
      if (code !== "55P03" && code !== "40P01") throw error;
      if (attempt >= 50) throw error;
      await new Promise((r) => setTimeout(r, 50 + attempt * 20));
    }
  }
}
const timings: [string, number, string][] = [];
const adoption: string[] = [];

/** Run a step, time it, and say what lock it holds while it runs. */
async function step(what: string, lock: string, fn: () => Promise<unknown>): Promise<void> {
  currentStep = what;
  const started = performance.now();
  await fn();
  const ms = performance.now() - started;
  // A retried window re-runs its steps; report each one once, with the time
  // from the attempt that actually committed.
  const seen = timings.findIndex((t) => t[0] === what);
  if (seen === -1) {
    timings.push([what, ms, lock]);
    out(`  ${ms.toFixed(0).padStart(7)} ms  ${lock.padEnd(26)} ${what}`);
  } else {
    timings[seen] = [what, ms, lock];
  }
}

/**
 * A uuidv7 whose timestamp is the given instant, and whose remaining bits are
 * the lowest possible. uuidv7 puts 48 bits of Unix milliseconds first, so
 * ordering by post_id IS ordering by time and a RANGE bound is a date.
 */
function boundAt(when: Date): string {
  const ms = BigInt(when.getTime()).toString(16).padStart(12, "0");
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7000-8000-000000000000`;
}

// ── what the catalog says posts is ───────────────────────────────────────────

/** A foreign key into posts: its table (schema-qualified), its name, its definition. */
type Reference = { table: string; name: string; def: string };

/** Every foreign key into posts, the table's own three included. */
const references = () => sql<Reference[]>`
  select conrelid::regclass::text as table, conname as name,
         regexp_replace(pg_get_constraintdef(oid), '\\s+NOT VALID$', '') as def
    from pg_constraint
   where confrelid = 'schellingaf.posts'::regclass and contype = 'f' and conparentid = 0
   order by 1, 2`;

/** Every view that reads posts, as the statement that re-creates it. */
const views = () => sql<{ name: string; statement: string }[]>`
  select c.oid::regclass::text as name,
         'create or replace view ' || c.oid::regclass::text
           || coalesce(' with (' || array_to_string(c.reloptions, ', ') || ')', '')
           || ' as ' || pg_get_viewdef(c.oid) as statement
    from pg_class c
   where c.relkind = 'v'
     and c.oid in (select r.ev_class from pg_depend d join pg_rewrite r on r.oid = d.objid
                    where d.refobjid = 'schellingaf.posts'::regclass)
   order by 1`;

async function readSchema() {
  const outgoing = await sql<{ name: string; def: string }[]>`
    select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'schellingaf.posts'::regclass and contype = 'f'
       and confrelid <> 'schellingaf.posts'::regclass
     order by 1`;
  // Every index but the primary key. A twin this drill built on an earlier,
  // unfinished run is named for the unique index it stands in for, and is left
  // out here and dropped before the run starts.
  const all = await sql<{ name: string; unique: boolean; def: string }[]>`
    select c.relname as name, i.indisunique as unique, pg_get_indexdef(i.indexrelid) as def
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where i.indrelid = 'schellingaf.posts'::regclass and not i.indisprimary
     order by 1`;
  const twins = new Set(all.filter((i) => i.unique).map((i) => `${i.name}_p0`));
  const indexes = all
    .filter((i) => !twins.has(i.name))
    .map((i) => ({ name: i.name, unique: i.unique, using: i.def.slice(i.def.indexOf(" USING ")) }));
  const triggers = await sql<{ name: string; def: string }[]>`
    select tgname as name, pg_get_triggerdef(oid) as def from pg_trigger
     where tgrelid = 'schellingaf.posts'::regclass and not tgisinternal
     order by 1`;
  const policies = await sql<{ statement: string }[]>`
    select 'create policy ' || quote_ident(policyname) || ' on schellingaf.posts as ' || permissive
             || ' for ' || cmd || ' to ' || array_to_string(roles, ', ')
             || coalesce(' using (' || qual || ')', '')
             || coalesce(' with check (' || with_check || ')', '') as statement
      from pg_policies where schemaname = 'schellingaf' and tablename = 'posts'
     order by policyname`;
  const grants = await sql<{ statement: string }[]>`
    select 'grant ' || a.privilege_type || ' on schellingaf.posts to '
             || case when a.grantee = 0 then 'public' else a.grantee::regrole::text end as statement
      from pg_class c, aclexplode(c.relacl) a
     where c.oid = 'schellingaf.posts'::regclass and a.grantee <> c.relowner
     order by 1`;
  const [table] = await sql<{ rls: boolean; force: boolean; options: string | null }[]>`
    select relrowsecurity as rls, relforcerowsecurity as force,
           array_to_string(reloptions, ', ') as options
      from pg_class where oid = 'schellingaf.posts'::regclass`;
  return {
    incoming: await references(),
    outgoing,
    indexes,
    twins: [...twins],
    triggers,
    policies: policies.map((p) => p.statement),
    grants: grants.map((g) => g.statement),
    rowSecurity: table!.rls,
    forceRowSecurity: table!.force,
    /** posts' storage parameters, which PostgreSQL takes on each leaf and refuses on the parent. */
    leafOptions: table!.options ? ` with (${table!.options})` : "",
    views: await views(),
  };
}

// ── what must be true before and after ───────────────────────────────────────

type Snapshot = {
  posts: string;
  fingerprints: string;
  search: string;
  spaces_consistent: string;
  sample: { post_id: string; hash: string }[];
};

async function snapshot(): Promise<Snapshot> {
  const [a] = await sql<{ n: string }[]>`select count(*)::text as n from schellingaf.posts`;
  const [b] = await sql<{ n: string }[]>`select count(*)::text as n from schellingaf.post_fingerprints`;
  const [c] = await sql<{ n: string }[]>`select count(*)::text as n from schellingaf.post_search`;
  // The invariant the whole design rests on: a SPACE's post count, its highest
  // seq and its recorded head are the same number. If partitioning broke the
  // numbering, this is where it shows.
  const [d] = await sql<{ n: string }[]>`
    select count(*)::text as n from (
      select s.space_id from schellingaf.spaces s
        join schellingaf.posts p on p.space_id = s.space_id
       group by s.space_id, s.last_seq
      -- BEHIND, not merely different: runbooks/restore.md step 4 deliberately
      -- bumps last_seq ABOVE both numbers, because those positions were handed
      -- to agents and must never be reissued.
      having max(p.seq) > s.last_seq) x`;
  const sample = await sql<{ post_id: string; hash: string }[]>`
    select post_id::text, encode(content_hash, 'hex') as hash
      from schellingaf.posts order by post_id limit 20`;
  return { posts: a!.n, fingerprints: b!.n, search: c!.n, spaces_consistent: d!.n, sample };
}

function compare(before: Snapshot, after: Snapshot, added: number): string[] {
  const wrong: string[] = [];
  // The drill runs against live traffic on purpose, so posts and their search
  // rows are EXPECTED to have grown by exactly what that traffic wrote. A count
  // that grew by anything else is the interesting case.
  const expected: Record<string, number> = { posts: added, fingerprints: 0, search: added };
  for (const k of ["posts", "fingerprints", "search"] as const) {
    const grew = Number(after[k]) - Number(before[k]);
    if (grew !== expected[k]) {
      wrong.push(`${k} grew by ${grew}, but traffic wrote ${expected[k]}`);
    }
  }
  if (after.spaces_consistent !== "0") {
    wrong.push(`${after.spaces_consistent} SPACE(s) where count, max(seq) and head disagree`);
  }
  if (JSON.stringify(before.sample) !== JSON.stringify(after.sample)) {
    wrong.push("the first twenty posts are not byte-identical");
  }
  return wrong;
}

// ── the checks that matter more than the counts ──────────────────────────────

async function invariants(): Promise<string[]> {
  const broken: string[] = [];

  // Immutability, which is cloned from the parent to every partition.
  try {
    await sql.begin(async (tx) => {
      await tx`update schellingaf.posts set kind = 'obs' where post_id = (select post_id from schellingaf.posts limit 1)`;
      throw new Error("__no_error__");
    });
    broken.push("a post could be UPDATEd");
  } catch (error) {
    const message = String((error as Error).message);
    if (!message.includes("IMMUTABLE_RECORD")) {
      broken.push(`updating a post raised ${message.slice(0, 60)} rather than IMMUTABLE_RECORD`);
    }
  }

  // Row-level security, as the role the service actually uses, with no caller
  // bound: it reads public SPACES and nothing else. A partition that lost its
  // policy would answer with everything.
  const api = postgres({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5439),
    database: DATABASE,
    username: "schellingaf_api",
    password: process.env.API_PASSWORD ?? "test_api_password_not_a_secret",
    max: 1,
    onnotice: () => {},
  });
  /** How many of a SPACE's posts the api role reads through the view, as `caller`. */
  const readsAs = async (caller: string, space: string): Promise<string> => {
    const rows = await api.begin(async (tx) => {
      await tx`select set_config('schellingaf.peer_id', ${caller}, true)`;
      return tx<{ n: string }[]>`
        select count(*)::text as n from schellingaf.visible_posts p where p.space_id = ${space}::uuid`;
    });
    return (rows as unknown as { n: string }[])[0]!.n;
  };
  try {
    const [leak] = await api<{ n: string }[]>`
      select count(*)::text as n from schellingaf.posts p where not schellingaf.space_is_public(p.space_id)`;
    if (leak!.n !== "0") broken.push(`the api role read ${leak!.n} private posts with no caller bound`);
    const [view] = await api<{ n: string }[]>`
      select count(*)::text as n from schellingaf.visible_posts p where not schellingaf.space_is_public(p.space_id)`;
    if (view!.n !== "0") broken.push(`the view returned ${view!.n} private posts with no caller bound`);
    // And with a caller, it reads that caller's spaces.
    const [member] = await sql<{ peer: string; space: string }[]>`
      select encode(m.peer_id, 'hex') as peer, m.space_id::text as space
        from schellingaf.memberships m limit 1`;
    if ((await readsAs(member!.peer, member!.space)) === "0") {
      broken.push("a member read nothing from a space it belongs to");
    }
    // A public SPACE is read by anybody, member or not: the policy's second
    // branch. A parent given only the member branch passes every check above.
    const [open] = await sql<{ space: string; stranger: string }[]>`
      select s.space_id::text as space, encode(p.peer_id, 'hex') as stranger
        from schellingaf.spaces s, schellingaf.peers p
       where schellingaf.space_is_public(s.space_id)
         and exists (select 1 from schellingaf.posts x where x.space_id = s.space_id)
         and not exists (select 1 from schellingaf.memberships m
                          where m.space_id = s.space_id and m.peer_id = p.peer_id)
       limit 1`;
    if (!open) {
      out("  no public SPACE holds a post, so a stranger's read of one was not checked");
    } else if ((await readsAs(open.stranger, open.space)) === "0") {
      broken.push("a KEY outside a public SPACE read nothing from it");
    }
  } finally {
    await api.end({ timeout: 5 });
  }

  // Every foreign key into posts is validated, and none still points at a
  // partition rather than the parent: one left there checks the old rows only.
  const loose = await sql<{ name: string; partition: boolean }[]>`
    select c.conrelid::regclass::text || ' ' || c.conname as name,
           c.confrelid <> 'schellingaf.posts'::regclass as partition
      from pg_constraint c
     where c.contype = 'f' and c.conparentid = 0
       and (c.confrelid = 'schellingaf.posts'::regclass
            or c.confrelid in (select inhrelid from pg_inherits where inhparent = 'schellingaf.posts'::regclass))
       and (not c.convalidated or c.confrelid <> 'schellingaf.posts'::regclass)`;
  for (const fk of loose) {
    broken.push(fk.partition
      ? `the foreign key ${fk.name} points at a partition, not at posts`
      : `the foreign key ${fk.name} is not validated`);
  }

  // The read the whole product depends on still walks its index rather than
  // sorting a partition set.
  const plan = await sql.unsafe(`
    explain (costs off)
    select p.post_id, p.seq from schellingaf.visible_posts p
     where p.space_id = (select space_id from schellingaf.spaces order by last_seq desc limit 1)
       and p.seq > 1000 order by p.seq limit 50`);
  const text = (plan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
  if (!/Index Scan/.test(text)) broken.push(`READ_AFTER stopped using an index:\n${text}`);
  if (/Seq Scan on posts/.test(text)) broken.push(`READ_AFTER reads the table whole:\n${text}`);

  // Once posts is partitioned, a DEFAULT partition exists and is empty. Without
  // it the service stops accepting writes on a date nobody has written down;
  // with rows in it, the next ATTACH has to scan them while holding a lock.
  const [isPartitioned] = await sql<{ n: string }[]>`
    select count(*)::text as n from pg_partitioned_table pt
      join pg_class c on c.oid = pt.partrelid where c.relname = 'posts'`;
  const [dflt] = await sql<{ n: string }[]>`
    select count(*)::text as n from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      join pg_class pa on pa.oid = i.inhparent
     where pa.relname = 'posts' and pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`;
  if (isPartitioned!.n !== "0") {
    if (dflt!.n === "0") {
      broken.push("no DEFAULT partition: writes will fail the day the last bound passes");
    } else {
      const [rows] = await sql<{ n: string }[]>`select count(*)::text as n from schellingaf.posts_pdefault`;
      if (rows!.n !== "0") {
        broken.push(`${rows!.n} rows in the DEFAULT partition: the next ATTACH must scan them`);
      }
    }
  }

  // A write still works, end to end, through the function the service calls,
  // into a SPACE made for it, inside a transaction that is rolled back. The
  // runbook runs --check against the database it has just migrated, which may be
  // production, and a post is immutable: a committed one would stay for good.
  let wrote = false;
  try {
    await sql.begin(async (tx) => {
      const space = await drillSpace(tx as unknown as postgres.Sql, "partition-drill-check");
      const receipt = await tx<{ r: { seq: string } }[]>`
        select schellingaf.append_post(${space.name}, decode(${space.owner}, 'hex'), 'obs', 'drill',
          'a post written after the table was partitioned', null, null, '{}'::bytea[],
          null, null, null, null, '[]'::jsonb, null) as r`;
      wrote = Boolean(receipt[0]?.r?.seq);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (String((error as Error).message) !== "__rollback__") throw error;
  }
  if (!wrote) broken.push("append_post did not return a receipt");

  return broken;
}

// ── the drill ────────────────────────────────────────────────────────────────

const partitioned = await sql<{ n: string }[]>`
  select count(*)::text as n from pg_partitioned_table pt
    join pg_class c on c.oid = pt.partrelid where c.relname = 'posts'`;

if (CHECK_ONLY || partitioned[0]!.n !== "0") {
  out(partitioned[0]!.n === "0" ? "posts is not partitioned" : "posts is partitioned");
  const broken = await invariants();
  out(broken.length === 0 ? "every invariant holds" : `${broken.length} broken:`);
  for (const b of broken) out(`  ${b}`);
  await sql.end();
  process.exit(broken.length === 0 ? 0 : 1);
}

// Repeatable: a previous attempt may have left the bound, the parent and the
// twin indexes behind. The schema is read once they are gone.
await sql`alter table schellingaf.posts drop constraint if exists posts_p0_bound`;
await sql`drop table if exists schellingaf.posts_new`;
const schema = await readSchema();
for (const twin of schema.twins) await sql.unsafe(`drop index if exists schellingaf.${twin}`);

const before = await snapshot();
out(`${Number(before.posts).toLocaleString()} posts, ${Number(before.fingerprints).toLocaleString()} fingerprints\n`);
const traffic = QUIET
  ? { state: { writes: 0, worst: 0, worstAt: "", stop: true, failures: [] as string[] }, done: async () => {} }
  : await startTraffic();
out("      time  lock                     step");

// The boundary: everything written so far goes in one partition, everything
// from the next boundary onward in the next. Coarse on purpose — READ_AFTER and
// replay lookups carry no post_id bound, so every read visits every partition
// and more of them is strictly worse.
const cut = new Date();
cut.setUTCMonth(cut.getUTCMonth() + 1, 1);
cut.setUTCHours(0, 0, 0, 0);
const BOUND = boundAt(cut);
const NEXT = boundAt(new Date(Date.UTC(cut.getUTCFullYear() + 1, cut.getUTCMonth(), 1)));

/** The parent's index standing for each of posts' own. */
const parentIndex = (name: string) => `${name}_parent`;

// ── phase 1: everything that does not stop the service ───────────────────────

await step("add the partition constraint, NOT VALID", "SHARE ROW EXCLUSIVE", () =>
  sql.unsafe(`alter table schellingaf.posts
                add constraint posts_p0_bound check (post_id < '${BOUND}') not valid`));

await step("validate it, so ATTACH will not rescan", "SHARE UPDATE EXCLUSIVE", () =>
  sql.unsafe(`alter table schellingaf.posts validate constraint posts_p0_bound`));

// The parent is built BEFORE the window, empty. PostgreSQL matches a parent's
// CHECK constraints to a child's BY NAME, and LIKE copies each under the name the
// existing table gives it; a CHECK written out by hand while the original table
// still exists would be auto-named `posts_body_check1` and ATTACH would refuse.
// The primary key is posts_pkey_tmp because an index name is unique in the schema.
await step("create the parent, empty, with matching constraint names", "none (new object)", async () => {
  await sql`
    create table schellingaf.posts_new (
      like schellingaf.posts including all excluding indexes,
      constraint posts_pkey_tmp primary key (post_id)
    ) partition by range (post_id)`;
  // LIKE copies the bound added a moment ago too; on the parent it would refuse
  // every row of the partitions after the first.
  await sql`alter table schellingaf.posts_new drop constraint if exists posts_p0_bound`;
  for (const fk of schema.outgoing) {
    await sql.unsafe(`alter table schellingaf.posts_new add constraint ${fk.name} ${fk.def}`);
  }
});

// Indexes on the empty parent, so they cost nothing now and are inherited by
// every partition made later. ON ONLY leaves them unbuilt for the partitions
// that already exist; the existing indexes are ATTACHED to them below rather
// than rebuilt, which is the difference between a metadata change and reading
// a million rows inside the window.
//
// None of them is unique, and that is a real weakening rather than a detail. A
// unique index on a partitioned table must contain the partition key, and
// (post_id, space_id, author_id, idempotency_key) would be unique for every row
// and so enforce nothing. Uniqueness therefore survives only WITHIN each
// partition. What actually prevents a duplicate is append_post, which looks for
// a prior key under the SPACE lock before it inserts, and gap-free numbering
// comes from the SPACE row lock; the indexes were always the second line of
// defence. Anything that ever relies on them must be checked again on the day
// this runs.
await step("index the empty parent, ON ONLY", "none (new object)", async () => {
  for (const index of schema.indexes) {
    await sql.unsafe(`create index ${parentIndex(index.name)} on only schellingaf.posts_new${index.using}`);
  }
});

// ATTACH PARTITION does not merely check that the child has the parent's
// indexes. For every parent index the child cannot satisfy, it BUILDS one —
// inside the ACCESS EXCLUSIVE window, over every row. A UNIQUE child index cannot
// be adopted by a NON-UNIQUE parent index, so each unique one gets a non-unique
// twin first, CONCURRENTLY, outside every window. CONCURRENTLY cannot run inside
// a transaction and takes only SHARE UPDATE EXCLUSIVE, so the service keeps
// reading and writing throughout.
await step("build the indexes ATTACH would otherwise build, concurrently", "SHARE UPDATE EXCLUSIVE", async () => {
  for (const index of schema.indexes.filter((i) => i.unique)) {
    await sql.unsafe(`create index concurrently if not exists ${index.name}_p0 on schellingaf.posts${index.using}`);
  }
});

// ── phase 2: the window ──────────────────────────────────────────────────────
// Everything from here to the end of the transaction holds ACCESS EXCLUSIVE on
// posts. This is the number the runbook exists to state.

/** posts and every table with a foreign key into it. */
const locked = [...new Set(["schellingaf.posts", ...schema.incoming.map((fk) => fk.table)])];

const windowStarted = performance.now();
let windowAttempts = 0;
await (async function theWindow(): Promise<void> {
  for (windowAttempts = 1; ; windowAttempts++) {
    try {
      await runWindow();
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if ((code !== "55P03" && code !== "40P01") || windowAttempts >= 30) throw error;
      await new Promise((r) => setTimeout(r, 100 + windowAttempts * 50));
    }
  }
})();

async function runWindow(): Promise<void> {
  await sql.begin(async (tx) => {
    // EVERY table the window touches, in ONE statement, before anything else.
    // Taken one at a time, the window holds posts and waits for a referencing
    // table behind a writer that is reaching for posts, and the two deadlock,
    // killing an agent's POST.
    //
    // All-or-nothing with a short timeout means this side backs off instead, and
    // no writer is ever killed. It still needs a gap in the traffic. The certain
    // way to have one is the service's own READ_ONLY flag, which is what the
    // runbook tells the operator to set: one second of 503 SERVICE_READ_ONLY,
    // with a fix an agent can act on, beats a deadlock it cannot.
    await tx`set local lock_timeout = '2s'`;
    await tx.unsafe(`lock table ${locked.join(", ")} in access exclusive mode`);

    await step("drop the triggers", "ACCESS EXCLUSIVE", async () => {
      for (const trigger of schema.triggers) {
        await tx.unsafe(`drop trigger ${trigger.name} on schellingaf.posts`);
      }
    });

    // Foreign keys are stored against a table's OID, so every one of them has to
    // be re-pointed at the new parent.
    await step("drop the foreign keys into posts", "ACCESS EXCLUSIVE", async () => {
      for (const fk of schema.incoming) {
        await tx.unsafe(`alter table ${fk.table} drop constraint if exists ${fk.name}`);
      }
    });

    await step("swap the names, table and primary key", "ACCESS EXCLUSIVE", async () => {
      await tx`alter table schellingaf.posts rename to posts_p0`;
      await tx`alter table schellingaf.posts_new rename to posts`;
      // The other indexes keep their own names on purpose: after partitioning it
      // is the PARTITION's index that appears in a query plan, and the read-path
      // names are what the plan tests assert on.
      await tx`alter index schellingaf.posts_pkey rename to posts_p0_pkey`;
      await tx`alter index schellingaf.posts_pkey_tmp rename to posts_pkey`;
    });

    await step("attach the existing rows", "ACCESS EXCLUSIVE", () =>
      tx.unsafe(`alter table schellingaf.posts
                   attach partition schellingaf.posts_p0
                   for values from (minvalue) to ('${BOUND}')`));

    await step("create the partition for what comes next", "none (new object)", async () => {
      // The storage parameters go on each LEAF: PostgreSQL refuses them on a
      // partitioned table. posts_p0 keeps them by being the original table; every
      // partition made afterwards has to be given them, or the setting that exists
      // because posts is insert-only stops applying where the new rows go.
      await tx.unsafe(`create table schellingaf.posts_p1 partition of schellingaf.posts
                         for values from ('${BOUND}') to ('${NEXT}')${schema.leafOptions}`);
      // And a DEFAULT partition. Without one, the day the service passes
      // posts_p1's upper bound every insert fails with "no partition of relation
      // posts found for row" and the service stops accepting writes.
      //
      // It must be kept EMPTY. Attaching a new partition has to scan the default
      // to prove no row belongs in the new range, so the operator creates next
      // year's partition before the boundary passes and the scan finds nothing.
      // The default is the net, not the plan.
      await tx.unsafe(`create table schellingaf.posts_pdefault
                         partition of schellingaf.posts default${schema.leafOptions}`);
    });

    await step("re-create the view, which followed the rename", "ACCESS EXCLUSIVE", async () => {
      for (const view of schema.views) await tx.unsafe(view.statement);
    });

    await step("row-level security and the policy, on the parent", "ACCESS EXCLUSIVE", async () => {
      if (schema.rowSecurity) await tx`alter table schellingaf.posts enable row level security`;
      if (schema.forceRowSecurity) await tx`alter table schellingaf.posts force row level security`;
      for (const policy of schema.policies) await tx.unsafe(policy);
    });

    await step("the triggers, on the parent", "ACCESS EXCLUSIVE", async () => {
      for (const trigger of schema.triggers) await tx.unsafe(trigger.def);
    });

    await step("grants", "ACCESS EXCLUSIVE", async () => {
      for (const grant of schema.grants) await tx.unsafe(grant);
    });
  });
}
const windowMs = performance.now() - windowStarted;

// ── phase 3: after the window ────────────────────────────────────────────────

await step("adopt the existing indexes into the parent's", "SHARE UPDATE EXCLUSIVE", async () => {
  // A partitioned index is a container. Attaching the child's existing index to
  // it is a catalog row; failing to attach means PostgreSQL would BUILD one over
  // a million rows instead, which is why this is measured rather than assumed.
  for (const index of schema.indexes) {
    const child = index.unique ? `${index.name}_p0` : index.name;
    try {
      await sql.unsafe(`alter index schellingaf.${parentIndex(index.name)} attach partition schellingaf.${child}`);
    } catch (error) {
      adoption.push(`${parentIndex(index.name)} could not adopt ${child}: ${String((error as Error).message).slice(0, 80)}`);
    }
  }
});

let retries = 0;
await step("re-add the foreign keys, NOT VALID", "SHARE ROW EXCLUSIVE, contended", async () => {
  for (const fk of schema.incoming) {
    retries += await insist(`alter table ${fk.table} add constraint ${fk.name} ${fk.def} not valid`) - 1;
  }
});

await step("validate them", "SHARE UPDATE EXCLUSIVE", async () => {
  for (const fk of schema.incoming) {
    retries += await insist(`alter table ${fk.table} validate constraint ${fk.name}`) - 1;
  }
});

currentStep = "after the drill";
await traffic.done();
out();
out(`  the exclusive window:        ${windowMs.toFixed(0)} ms`);
out(QUIET
  ? "  writes during the window:    none, as under READ_ONLY=1"
  : `  writes that kept going:      ${traffic.state.writes.toLocaleString()}`);
out(`  longest a write ever waited: ${traffic.state.worst.toFixed(0)} ms, during "${traffic.state.worstAt}"`);
out(`  lock retries the drill took:  ${retries + windowAttempts - 1}`);
for (const f of traffic.state.failures.slice(0, 4)) out(`  a write FAILED during ${f}`);
if (traffic.state.failures.length > 4) out(`  ...and ${traffic.state.failures.length - 4} more`);
for (const a of adoption) out(`  INDEX: ${a}`);
const invalid = await sql<{ name: string }[]>`
  select c.relname as name from pg_class c join pg_index i on i.indexrelid = c.oid
   where c.relnamespace = 'schellingaf'::regnamespace and not i.indisvalid`;
for (const i of invalid) out(`  INDEX: ${i.name} is not valid: no partition has adopted it`);
out();

const after = await snapshot();
const wrong = compare(before, after, traffic.state.writes);
// The same foreign keys point at posts as before, and every view reads as it did.
const key = (fk: Reference) => `${fk.table} ${fk.name} ${fk.def}`;
const referencesAfter = new Set((await references()).map(key));
for (const fk of schema.incoming) {
  if (!referencesAfter.has(key(fk))) wrong.push(`the foreign key ${fk.table} ${fk.name} did not come back`);
}
const viewsAfter = new Map((await views()).map((v) => [v.name, v.statement]));
for (const view of schema.views) {
  if (viewsAfter.get(view.name) !== view.statement) wrong.push(`the view ${view.name} changed`);
}
const broken = await invariants();
if (wrong.length === 0 && broken.length === 0) {
  out("nothing changed that should not have, and every invariant still holds.");
} else {
  for (const w of [...wrong, ...broken]) out(`  BROKEN: ${w}`);
}

const parts = await sql<{ name: string; rows: string; size: string }[]>`
  select c.relname as name, c.reltuples::bigint::text as rows,
         pg_size_pretty(pg_total_relation_size(c.oid)) as size
    from pg_class c join pg_inherits i on i.inhrelid = c.oid
    join pg_class p on p.oid = i.inhparent
   where p.relname = 'posts' order by c.relname`;
out();
for (const p of parts) out(`  ${p.name.padEnd(12)} ${p.rows.padStart(10)} rows  ${p.size}`);

await sql.end();
process.exit(wrong.length + broken.length === 0 ? 0 : 1);
