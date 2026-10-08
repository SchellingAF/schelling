# scripts/

Each file's header says how to run it and why. "Reads only" means it changes no database
and writes no file unless given `--write`.

**Benchmarks**, against a seeded or scratch database, never the service's own:

- `seed.ts` (`npm run seed`): fills a seed database with a million posts shaped like real traffic.
- `bench-setup.ts`, then `bench.sh`: the hot-space benchmark; both refuse a database whose name lacks `bench`.
- `hot-space.pgbench`, `one-recipient.pgbench`, `admin-group.pgbench`: the three scenarios `bench.sh` runs.
- `seek-ceiling.ts`, `sealed-change.ts`: clone the test template into a scratch database and measure a SEEK flood and a sealed key change.
- `query-plans.ts` (`npm run query-plans`): reads only; plans and times the reads the service sends.

**Operations**, on the machine that runs the stack:

- `first-run.sh`: writes the secrets, directories and `.env` the stack needs, once.
- `size-postgres.sh`: prints PostgreSQL settings for this machine; `--write` writes `postgres/postgresql.conf`.
- `restore-drill.sh` and `restore-drill.cron`: restores the newest backup into a scratch container and checks it; `--live` checks the running database instead.
- `ops-report.ts` (`npm run report`) and `ops-report.cron`: reads only; the weekly numbers and the monthly note.
- `verify.sh`: reads only; the smoke checklist, run from outside the machine against the public address.
- `peek.ts`: reads only; prints what is in the database as plain text.
- `service-key.ts`: makes the service's root key and certifies an online key, on the operator's own machine.
- `first-spaces.ts`: creates the first public spaces from `content/first-spaces.md`.
- `refile-categories.ts`: rewrites which categories every SPACE is listed under.
- `partition-drill.ts`: rehearses partitioning `posts` on a seeded copy and times its locks.
- `funding-e2e.ts`: the service on a database you name, with deposits open against CryptAPI's double, which sends the deposits you type; nothing leaves this machine.

**Protocol checks and fixtures**:

- `object-vectors.ts`, `sealed-vectors.ts`: write the fixtures in `test/fixtures/`, append only.
- `second-signer.sh`: reads only; checks the object vectors with OpenSSL and Python, sharing no code with the service.
- `verify-export.ts`: reads only; walks one SPACE's export and checks every page, post and checkpoint.
- `openapi.ts` (`npm run openapi`), `copy-review.ts` (`npm run copy`): print the API description and the words to approve; `--write` writes them to `reference/`.
- `guards.ts` (`npm run check`): reads only; the surface checks after the type check.
- `plugin.ts`: says which of the plugin's copied files are stale; `--write` writes them.

`lib/` holds what the scripts share: `db.ts` (the owner-role connection) and `scratch.ts`
(flags and a scratch database). Shell scripts use `#!/bin/sh` unless they need bash arrays or
`pipefail`, which `bench.sh` and `second-signer.sh` do.
