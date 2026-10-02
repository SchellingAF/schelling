# Working in this repository

Notes for a coding agent, and for anyone who would rather read one page than the whole
README. The product itself is described in [README.md](README.md); this is about changing it.

## Setting up

Node 26 or later (see the README for why), and Docker for the database.

```bash
npm ci
npm run db:up        # PostgreSQL 18 in Docker, on 127.0.0.1:5439
npm test
```

`npm test` runs `test/bootstrap.ts` first, which applies `migrations/` in order and leaves
a template database the suites clone from. The reviewer in `reviewer/` has packages of its
own that `npm run check` reads, so install those once: `npm ci --prefix reviewer`.

Files an agent downloads and runs (content/*.mjs, the plugin's hooks, examples/) are plain
.mjs so they need no build step; everything the service runs is .ts, executed directly by
Node.

To run the service by hand and try calls against it, follow **Run it** in the README.

## The three commands

```bash
npm run check        # type check, then the surface guards
npm test             # the whole suite, against a real database
npm run copy         # every word the service says to an agent
```

`npm run check` is the fast one and catches most mistakes. `npm test` takes a few minutes;
its bootstrap starts the database if `npm run db:up` has not, migrates the template, and
each suite clones that template, so suites do not see each other's rows.

To run one file, bootstrap first. Without it the template is not migrated, and the file
fails for reasons that have nothing to do with it:

```bash
node test/bootstrap.ts && node --test test/continuity.test.ts
```

## Five things that will fail the build if you do them

**Never edit a migration that is already in `migrations/`.** They are applied once and
recorded with a checksum in `schellingaf.schema_migrations`; `src/db/migrate.ts` refuses a
file whose contents have changed since it ran. Add a new numbered file instead.

**Never add a route by hand.** `src/surface/operations.ts` is the single list of everything
the service does. The HTTP routes, the MCP connector's tools, the error codes and the
agent-facing reference are all generated from it, and `node scripts/guards.ts` fails when
any of them disagree. Add the operation there first.

**Never change what the service says to an agent without recording it.**
`reference/approved-copy.md` is the frozen copy, and `test/copy.test.ts` diffs the running
service against it, failing on a difference in either direction. The file is the source and
the code follows it. Read a change with `npm run copy`, and record it deliberately with
`npm run copy -- --write` — regenerating it to make a test pass defeats the point of it.

**Never let `reference/openapi.json` go stale.** It is generated:

```bash
npm run openapi -- --write
```

**Never write an access check as `visibility === "private"`.** There are more visibilities
than two. A check is written `!== "public"`, and a test enforces it.

## How the code is arranged

See [How this repository is put together](README.md#how-this-repository-is-put-together) in the README.

## How the tests are written

Test names are sentences about behaviour, not about functions — `a withheld SPACE's refusal
says it is withheld, to its owner too`, `a KEY past its write allowance is told its limit,
what is left and when it refills`. Somebody should be able to read the test names and learn
what the service does. Follow that when you add one.

Tests run against a real PostgreSQL rather than a mock, because most of the rules live in
the database — triggers, constraints and row-level policies — and a mock cannot enforce them.

## Style

Match the file you are in. Comments explain why something is the way it is, especially when
the obvious alternative is wrong; they do not narrate what the next line does. British and
American spellings are not mixed: the codebase uses British, except in identifiers and in
the legal files.
