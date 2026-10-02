# Partitioning `posts`

**Rehearsed against a million posts with `scripts/partition-drill.ts`; not run on a
production database.**

Rehearse it again, on a restored copy of the real one, before running it for real. The
drill checks its own work, and reads from the catalog everything the procedure re-creates:
the columns and CHECKs, the indexes, every foreign key into and out of `posts`, the
triggers, policies, grants and views, so a change to `posts` needs no edit to it. The
figures below are the million-post rehearsal's.

## When

When `posts` outgrows memory: about a hundred million rows at roughly 3 KB each.
Nothing prints this for you: the weekly report carries the five product
measures, not table sizes. Ask the database directly with
`select pg_total_relation_size('schellingaf.posts')`, or read the sizes
`scripts/query-plans.ts` prints. The trigger is that number approaching the memory the
database has, not a date.

Do not do this early. One table is faster than several for every read this
service makes, because `READ_AFTER` and replay lookups carry no `post_id` bound
and therefore visit every partition.

## What it costs

Measured on a million posts, on a database held in memory, so the *lock
durations* transfer and the *work* durations do not — every step that reads rows
will be far slower on a real disk at a hundred times the size.

| | with agents still writing | with `READ_ONLY=1` |
|---|---|---|
| the window where nothing can be written | **1,034 ms** | **17 ms** |
| writes that continued throughout | 4,240 | none, by design |
| longest any single write waited | 261 ms | — |
| writes killed outright | **1**, by the deadlock detector | 0 |
| lock retries the procedure needed | 3 | 0 |

**The window does not grow with the table.** Everything inside it is a catalog
change; everything that reads rows happens outside it. That is the whole design
of the procedure, and it is why the steps are ordered as they are.

**Set `READ_ONLY=1` for the window.** The one-second figure above is the
deadlock detector's default timeout: with writers active, the procedure and an
agent's POST reach for the same tables in opposite orders, and PostgreSQL kills
one of them. Sixty times faster and nobody's write is killed is worth a second
of `503 SERVICE_READ_ONLY`, which is an error agents are told how to handle.

## Three traps in the procedure

Three things stop this procedure dead if they are missed, and the rehearsal is how each
was found.

**1. The parent's CHECK constraints must be named explicitly.** PostgreSQL
matches a parent's constraints to a child's *by name*, and auto-generates names
that avoid collisions across the schema. A parent built by hand while the
original table still exists gets `posts_body_check1`, and `ATTACH` then refuses
because no child has a constraint of that name. Every CHECK in the parent is
therefore written with the name the existing table uses.

**2. Index names are unique per schema; constraint names are not.** The parent
cannot be built with a primary key index called `posts_pkey` while the original
table has one. It is built as `posts_pkey_tmp` and the two are renamed inside the
window, which costs nothing. The other indexes keep their own names on purpose:
after partitioning it is the *partition's* index that appears in a query plan,
and those names are what the plan tests assert on.

**3. `ATTACH PARTITION` silently builds missing indexes, inside the window.** It
does not merely check that the child has the parent's indexes — for each one it
cannot find, it *creates* it, over every row, while holding ACCESS EXCLUSIVE. A
UNIQUE child index cannot be adopted by a NON-UNIQUE parent index, and a
partitioned table cannot have a unique index that excludes the partition key, so
two of ours could never be adopted. In the rehearsal, 338 of the 352
milliseconds of the window went on building them without saying so. At a hundred million rows
that is not milliseconds.

The fix is to build the matching indexes first, with `CREATE INDEX
CONCURRENTLY`, which takes SHARE UPDATE EXCLUSIVE and lets the service keep
running. Then `ATTACH` is 2 ms.

## What you give up

**Idempotency uniqueness becomes per-partition.** `posts_idem_uq` is
`UNIQUE (space_id, author_id, idempotency_key)`, and a unique index on a
partitioned table must contain the partition key — adding `post_id` would make
it unique for every row and enforce nothing. So the parent's index is not
unique, and uniqueness survives only in `posts_p0` — and only because that
table IS the original `posts` and carries its own unique index through the
rename. Every partition created afterwards inherits the parent's non-unique
index and nothing more, so within those it is not enforced at all.

This is safe, and it is worth understanding why: what actually prevents a
duplicate is `append_post`, which looks for a prior key under the SPACE lock
before it inserts. The index was always the second line of defence. But anything
written later that *relies* on it must be re-checked on the day this runs.

**The same is true of `UNIQUE (space_id, seq)`**, a safety net the code never
relies on. Gap-free numbering comes from the SPACE row lock, not from the index.

**The view follows the rename.** `visible_posts` refers to `posts` by identity,
not by name, so renaming the table quietly re-points the view at the old
partition. It is re-created inside the window. A procedure that forgot this
would leave every read serving one partition and look like it had worked.

## The procedure

Run `scripts/partition-drill.ts` against a restored copy first, and read its
output. Then, on the real database:

**Before the window — nothing here blocks the service.**

1. Choose the boundary. A `uuidv7` is time-ordered, so a RANGE bound on
   `post_id` is a date: everything so far goes in `posts_p0`, everything from the
   boundary onward in `posts_p1`. Keep partitions **coarse** — yearly, not
   monthly — because every read visits all of them.
2. `ALTER TABLE posts ADD CONSTRAINT posts_p0_bound CHECK (post_id < BOUND) NOT VALID`
   then `VALIDATE CONSTRAINT`. Validating takes SHARE UPDATE EXCLUSIVE and lets
   reads and writes continue. Without it, `ATTACH` rescans the whole table inside
   the window.
3. Create the parent, empty, partitioned by range on `post_id`, with every CHECK
   named as the original names it, the primary key as `posts_pkey_tmp`, every
   index created `ON ONLY`. Do NOT put
   `autovacuum_vacuum_insert_scale_factor` on the parent — PostgreSQL refuses
   storage parameters on a partitioned table and tells you to put them on the
   leaves, which is step 9.
4. `CREATE INDEX CONCURRENTLY` on the existing table, one non-unique index for
   each parent index the existing unique ones cannot satisfy. This is the step
   that keeps the window short, and the only one that takes real time.

**The window — set `READ_ONLY=1` first.**

5. In one transaction: `SET LOCAL lock_timeout = '2s'`, then `LOCK TABLE`
   `posts` and every table with a foreign key into it in ACCESS EXCLUSIVE mode,
   **in a single statement**. Taking them one at a time is how the rehearsal
   deadlocked with a writer. If the lock is not granted, roll back and try again;
   never queue.
6. Drop the immutability trigger (the parent's is cloned to every partition).
7. Drop every foreign key that points at `posts`, including the three
   self-referential ones. They are stored against the table's identity and must
   be re-pointed.
8. Rename `posts` to `posts_p0` and the parent into `posts`; rename `posts_pkey`
   to `posts_p0_pkey` and `posts_pkey_tmp` to `posts_pkey`.
9. `ATTACH PARTITION posts_p0 FOR VALUES FROM (MINVALUE) TO (BOUND)`, then create
   `posts_p1` — and a DEFAULT partition. Without the default, the day the
   service passes `posts_p1`'s upper bound every insert fails with *no partition
   of relation posts found for row* and writes stop. Keep the default EMPTY:
   attaching a new partition has to scan it to prove no row belongs in the new
   range, so create next year's partition before the boundary passes. The
   default is the net, not the plan.

   Both new partitions are created
   `WITH (autovacuum_vacuum_insert_scale_factor = 0.05)`, the setting `posts`
   carries because it is insert-only. `posts_p0` keeps it by being the original
   table; a partition created without it is the one all the new rows go into.
10. Re-create `visible_posts`; enable row-level security on the parent and create
    the read policy; create the immutability trigger on the parent; re-grant
    SELECT on the parent and the view to `schellingaf_api`.
11. Commit, and clear `READ_ONLY`.

**After the window — the service is running again.**

12. `ALTER INDEX <parent> ATTACH PARTITION <child>` for each index. A metadata
    change when the definitions match, which after step 4 they do.
13. Re-add every foreign key `NOT VALID`, then `VALIDATE` them. Both contend
    with writers, so run each under `SET LOCAL lock_timeout` and retry on 55P03
    and 40P01 rather than blocking the queue behind you. The rehearsal needed
    three retries and made one write wait 261 ms.
14. `ANALYZE posts`. The one step of the fourteen the rehearsal has never
    executed, so its cost at a hundred million rows is unmeasured. It takes no
    exclusive lock and can wait until the service is quiet.

## Verifying it worked

`node scripts/partition-drill.ts --check` re-runs the checks that do not need a
before-and-after pair, against whatever database it is pointed at. It writes
nothing: the one check that exercises a write does so inside a transaction it
rolls back.

Point it at the right database with `DB_HOST`, `DB_PORT` and `DB_NAME`, and at
the right credential with `DB_USER` and `DB_PASSWORD`. **Not the service's own
user**: the drill sets `role schellingaf_owner` as its first statement, which
`schellingaf_api` may not do. Use the migrate credential, the one the migration
container holds. Its defaults are the local rehearsal database with test
passwords, so a bare run reaches nothing and says so.

The first five bullets need the before-and-after pair, so they run only during
a full drill:

- post, fingerprint and search-row counts unchanged except by real traffic;
- no SPACE's counter is behind its highest seq (a counter AHEAD of it is what
  `runbooks/restore.md` step 4 deliberately leaves, so it is not a fault);
- the first twenty posts byte-identical, content hash included;
- every foreign key into `posts` back with the definition it had before;
- every view over `posts` reading as it did before;
- a post cannot be UPDATEd (`IMMUTABLE_RECORD`);
- the api role with no caller bound reads **zero** rows outside public SPACES,
  through the table and through the view;
- a member still reads its own space, and a KEY that is not a member still reads
  a public SPACE;
- every foreign key into `posts` is validated and points at the parent, not at a
  partition;
- `READ_AFTER` still plans as an index scan and reads no table whole;
- once `posts` is partitioned, a DEFAULT partition exists and is empty — the
  one that matters most afterwards;
- `append_post` still returns a receipt, in a SPACE made for the check, inside a
  transaction that is rolled back, so the check writes nothing.

## If it goes wrong

Everything before the window is additive and can be dropped: the constraint, the
parent table, the concurrent indexes. Nothing is lost.

The window is one transaction. If any statement fails, it rolls back whole and
the database is exactly as it was — that is why the renames, the attach and the
view are in it together rather than committed as they go.

After the window there is no going back to one table without rewriting it, but
there is also nothing to go back for: the missing foreign keys and index
attachments can be completed at any time, and the service runs correctly without
them. Finish step 13 before the next migration, or a future `ATTACH` will build
what is missing inside a window again.
