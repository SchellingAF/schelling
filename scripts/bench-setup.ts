// The fixture the hot-space benchmark runs against.
//
//   DB_NAME=schellingaf_bench node scripts/bench-setup.ts
//
// Run after scripts/seed.ts, against the same database. It makes the SPACES the
// benchmark writes in, and adds four small tables that let each pgbench
// transaction pick its actors with a primary-key probe instead of a scan,
// because a benchmark that spends its time finding an author is measuring the
// wrong thing.
//
// What the three scenarios need, and why the fixture is shaped this way:
//
//   ONE HOT SPACE       every writer appends to the same SPACE, so every write
//                       queues on one row lock.
//   ONE RECIPIENT       writers spread across many SPACES, all addressing the
//                       same PEER, so the SPACE locks are uncontended and the
//                       mailbox row is the only thing serialising.
//   ONE ADMIN GROUP     many different PEERS asking to join many different
//                       SPACES that share an admin set, so one call locks up to
//                       thirty-three mailboxes in ascending order. Each pair is
//                       used once, because a second pending request from the
//                       same PEER is refused by design.

import { ownerSql } from "./lib/db.ts";

const AUTHORS = 64;
const SPACES = 64;
const ADMINS = 32;

// The same refusal as scripts/bench.sh, for the same reason and against the same
// variable. This script makes SPACES nothing can delete, grants synthetic PEERS
// writer, reader and admin in them, and drops and recreates a schema;
// .env.example documents DB_NAME=schellingaf, and scripts/restore-drill.sh
// exports .env with `set -a`.
const DATABASE = process.env.DB_NAME ?? "schellingaf_bench";
if (!DATABASE.includes("bench")) {
  process.stderr.write(
    `refusing: DB_NAME is "${DATABASE}", which is not a benchmark database.\n` +
      "This script makes SPACES that cannot be deleted, grants memberships in them and rebuilds a schema.\n" +
      "Set DB_NAME to a name containing 'bench'.\n",
  );
  process.exit(1);
}

const sql = await ownerSql(DATABASE);
// Its own schema, so a disposable benchmark never leaves a table in the
// product's. The api role needs USAGE because pgbench connects as it.
await sql`create schema if not exists bench`;
await sql`grant usage on schema bench to schellingaf_api`;

const say = (m: string) => process.stdout.write(`  ${m}\n`);

await sql`drop table if exists bench.authors, bench.spaces, bench.recipient, bench.pairs cascade`;
await sql`drop sequence if exists bench.pair_seq`;

// ── the writers ──────────────────────────────────────────────────────────────
// Ordered by peer_id, skipping the first: the seed deliberately leaves that one
// KEY in no SPACE at all, so it can stand for a refused read.
await sql`
  create table bench.authors (n int primary key, peer_id bytea not null)`;
await sql`
  insert into bench.authors (n, peer_id)
  select (row_number() over (order by peer_id))::int, peer_id
    from (select peer_id from schellingaf.peers order by peer_id offset 1 limit ${AUTHORS}) x`;
say(`${AUTHORS} writers`);

// ── the spaces they write in ──────────────────────────────────────────────────
// SPACES of the benchmark's own, made by create_space as the service makes one,
// never the seed's. append_post links every post to the one before it and to the
// SPACE's governance chain, and the seed writes its posts and SPACES directly,
// with neither, so append_post refuses every seeded SPACE with CHAIN_BROKEN.
// Number 0 is the hot SPACE, invite only because nobody asks to join it; 1 to 64
// are the ones the other two scenarios spread across, open to requests. Each has
// an owner of its own that is none of the authors, the admins or the recipient,
// so a join request fans out to exactly the owner and the admins. A SPACE
// can never be deleted, so a second run finds its SPACES and uses them again.
await sql`
  create table bench.spaces (n int primary key, name text not null, space_id uuid not null)`;
for (let n = 0; n <= SPACES; n++) {
  const name = n === 0 ? "bench-hot" : `bench-space-${n}`;
  const [made] = await sql<{ space_id: string }[]>`
    select space_id from schellingaf.spaces where name = ${name}`;
  if (!made) {
    await sql`
      select schellingaf.create_space(
        (select peer_id from schellingaf.peers order by peer_id offset ${AUTHORS + 2 + n} limit 1),
        ${name}, 'benchmark', '', ${n === 0 ? "invite" : "request"}, 'private')`;
  }
  await sql`
    insert into bench.spaces (n, name, space_id)
    select ${n}, name, space_id from schellingaf.spaces where name = ${name}`;
}

// Every writer can write in every one of them, or a run would be measuring
// refusals rather than appends.
await sql`
  insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
  select r.space_id, a.peer_id, 'writer', 'grant',
         (select owner_id from schellingaf.spaces s where s.space_id = r.space_id), 0
    from bench.spaces r cross join bench.authors a
   where a.peer_id <> (select owner_id from schellingaf.spaces s where s.space_id = r.space_id)
  on conflict (space_id, peer_id) do nothing`;
say(`${SPACES + 1} spaces, every writer in each`);

// ── the one PEER everybody writes to ─────────────────────────────────────────
// It has to be a member of every space it is addressed in, or the write is
// refused before a seq is burned, which is the service working correctly and
// the benchmark measuring nothing.
await sql`create table bench.recipient (peer_id bytea primary key)`;
await sql`
  insert into bench.recipient (peer_id)
  select peer_id from schellingaf.peers order by peer_id offset ${AUTHORS + 1} limit 1`;
await sql`
  insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
  select r.space_id, b.peer_id, 'reader', 'grant',
         (select owner_id from schellingaf.spaces s where s.space_id = r.space_id), 0
    from bench.spaces r cross join bench.recipient b
   where b.peer_id <> (select owner_id from schellingaf.spaces s where s.space_id = r.space_id)
  on conflict (space_id, peer_id) do nothing`;
say("one recipient, a member of every space");

// ── the admin group the join requests fan out to ─────────────────────────────
// Thirty-two admins plus the owner is the widest fan-out the service permits,
// and it is the shape that decides whether a busy space's admins serialise
// everybody else's joins.
await sql`
  insert into schellingaf.memberships (space_id, peer_id, role, via, granted_by, revision)
  select r.space_id, a.peer_id, 'admin', 'grant',
         (select owner_id from schellingaf.spaces s where s.space_id = r.space_id), 0
    from bench.spaces r
    join bench.authors a on a.n <= ${ADMINS}
   where r.n >= 1
     and a.peer_id <> (select owner_id from schellingaf.spaces s where s.space_id = r.space_id)
  on conflict (space_id, peer_id) do update set role = 'admin'`;
say(`${ADMINS} admins in each space`);

// ── the requesters ───────────────────────────────────────────────────────────
// A pending request is unique per (SPACE, PEER), so every transaction needs a
// pair nobody has used. A sequence hands them out in order; when the pool runs
// out the run has gone on longer than it was sized for and says so.
await sql`create table bench.pairs (n bigint primary key, peer_id bytea not null, space_name text not null)`;
await sql`
  insert into bench.pairs (n, peer_id, space_name)
  select (row_number() over (order by p.peer_id, r.n))::bigint, p.peer_id, r.name
    from (select peer_id from schellingaf.peers
           order by peer_id offset ${AUTHORS + 2}) p
    cross join bench.spaces r
   where r.n >= 1
     and not exists (select 1 from schellingaf.memberships m
                      where m.peer_id = p.peer_id and m.space_id = r.space_id)
     and not exists (select 1 from schellingaf.spaces s
                      where s.space_id = r.space_id and s.owner_id = p.peer_id)`;
await sql`create sequence bench.pair_seq`;
const [pairs] = await sql<{ n: string }[]>`select count(*)::text as n from bench.pairs`;
say(`${Number(pairs!.n).toLocaleString()} unused requester and space pairs`);

// pgbench connects as the api role, which owns none of this.
for (const t of ["bench.authors", "bench.spaces", "bench.recipient", "bench.pairs"]) {
  await sql.unsafe(`grant select on ${t} to schellingaf_api`);
}
await sql`grant usage on sequence bench.pair_seq to schellingaf_api`;

process.stdout.write("fixture ready\n");
await sql.end();
