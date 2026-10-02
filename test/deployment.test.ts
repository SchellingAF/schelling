// The deployed configuration, checked the only way it can be checked here.
//
// Everything in this file is a shell script, a compose file, a PostgreSQL
// configuration or a runbook, which the rest of the suite does not reach. A dead
// branch in a backup loop looks exactly like a live one.
//
// So where the thing under test is a decision expressed in shell, the decision
// is EXTRACTED from the shipped file and executed. The guard that decides
// whether the hourly backup checks run is evaluated over all 1,440 minutes of a
// day; the coupling between an alert and the heartbeat is run with a stubbed
// curl; the benchmark's refusal to point at a production database is run
// against real names. Reading a line and agreeing that it looks right is not a
// test.
//
// The service's own startup, its request log and scripts/first-run.sh are in
// test/startup.test.ts, beside the code they configure.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { API_PASSWORD, PORT, SUPERUSER } from "./bootstrap.ts";
import { cloneDatabase, type Fixture } from "./helpers.ts";
import { ROOT, read, sh, shellCase, shellFunction } from "./lib/shell.ts";

// ── the PostgreSQL server log ────────────────────────────────────────────────

describe("the database log never carries what agents wrote", () => {
  // postgres.js sends every statement through the extended query protocol, so
  // every write is a parameterised execute. PostgreSQL logs the parameters of
  // any statement past log_min_duration_statement, and log_parameter_max_length
  // defaults to -1, which means all of every value. append_post binds the SPACE
  // name, the author's peer id, the title and the body — so one slow write would
  // put a whole private post into the container log, outside row-level security,
  // outside the encrypted backup repository, in the clear on the host.

  test("no statement is logged with its values or its row, in the file the server reads", () => {
    // scripts/size-postgres.sh renders postgresql.conf.template into the file the
    // server reads, so the rendering is what is checked: a setting that reaches
    // the template but not the rendering would be a comment.
    const rendered = sh(`cd ${JSON.stringify(ROOT)} && sh scripts/size-postgres.sh`);
    assert.equal(rendered.code, 0, rendered.out);
    const config = rendered.out;
    assert.match(
      config,
      /^log_parameter_max_length = 0$/m,
      "log_parameter_max_length is not pinned to 0, so a slow write logs the post body it carried",
    );
    assert.match(config, /^log_parameter_max_length_on_error = 0$/m, "a failed statement logs the values bound to it");
    // Neither parameter setting governs an ERROR's DETAIL, and a CHECK violation
    // logs `Failing row contains (...)`: the whole row, at the default verbosity
    // and not at terse. See the comment above the setting.
    assert.match(
      config,
      /^log_error_verbosity = terse$/m,
      "log_error_verbosity is not terse, so a refused post logs its own row",
    );
    // The threshold that makes the settings above matter. Were the slow-statement
    // log removed entirely, they would stop mattering and this test should say so.
    assert.match(config, /^log_min_duration_statement = /m, "the slow-statement log is gone, so this test is vacuous");
  });

  test("the restore drill keeps its host files private, and removes them", () => {
    // The drill runs as root from cron and compares every SPACE name and every
    // KEY's peer id; in /tmp by fixed name, those and every log it produces would
    // be world-readable and never cleaned up. The scratch container's own /tmp is
    // its own business and is not what this asserts about.
    const drill = read("scripts/restore-drill.sh");
    assert.match(drill, /^umask 077$/m, "the drill does not restrict what it writes");
    assert.match(drill, /^WORK=\$\(mktemp -d /m, "the drill has no private working directory");
    assert.match(drill, /trap '.*rm -rf "\$WORK".*' EXIT/, "the drill leaves its working directory behind");
    assert.doesNotMatch(drill, />\s*"?\/tmp\//, "the drill still redirects output into /tmp by name");
    assert.doesNotMatch(drill, /read\("\/tmp\//, "the drill still reads a comparison file out of /tmp by name");
  });

  test("the restore runbook's incident bundle is not world-readable in /tmp", () => {
    // The bundle is every container's log, and Caddy's access log inside it
    // records request URIs, which carry peer-authored SPACE names. In /tmp with
    // root's default mask it would be world-readable, and an incident bundle is
    // exactly the artefact that gets attached to a ticket.
    const runbook = read("runbooks/restore.md");
    const bundle = runbook
      .split("\n")
      .filter((line) => line.includes("docker compose logs"))
      .join("\n");
    assert.ok(bundle.length > 0, "the runbook no longer collects a log bundle");
    assert.ok(!/>\s*\/tmp\//.test(bundle), "the incident bundle is still written into /tmp");
    assert.match(runbook, /umask 077/, "the incident bundle is written with the default mask");
    assert.match(runbook, /private content/i, "the runbook does not say what is in the bundle");
  });
});

// ── the backup loop ──────────────────────────────────────────────────────────

describe("the backup loop's hourly checks", () => {
  const loop = read("postgres/backup-loop.sh");

  /** The line that decides whether the hourly block runs. */
  function hourlyGuardLine(): string {
    const line = loop
      .split("\n")
      .find((l) => /^\s*if .*"07".*; then$/.test(l) && !l.trimStart().startsWith("#"));
    assert.ok(line, "the hourly guard is not where this test expects it");
    return line;
  }

  /** The condition out of that line's `if <condition>; then`. */
  function hourlyGuard(): string {
    return hourlyGuardLine().trim().replace(/^if /, "").replace(/; then$/, "");
  }

  test("it is true once an hour, in every hour of the day", () => {
    // `#` strips the SHORTEST matching prefix, so a guard such as
    //     [ "${NOW#*[0-5][0-9]}" = "" ]
    // is false in all 1,440 minutes, and four conditions the loop calls causes
    // of a real unrecoverable outage would never be checked.
    const guard = hourlyGuard();
    const result = sh(`
      hits=0; total=0; when=""
      for H in $(seq -w 0 23); do
        for M in $(seq -w 0 59); do
          NOW="$H$M"
          total=$((total+1))
          if ${guard}; then hits=$((hits+1)); when="$when $NOW"; fi
        done
      done
      echo "$total $hits"
      echo "$when"
    `);
    assert.equal(result.code, 0, result.out);
    const [counts, minutes] = result.out.trim().split("\n");
    assert.equal(counts, "1440 24", `the hourly guard fired on ${counts?.split(" ")[1]} minutes`);
    assert.match(minutes ?? "", /\b1207\b/, "12:07 is not one of the minutes it fires on");
    assert.match(minutes ?? "", /\b0007\b/);
    assert.match(minutes ?? "", /\b2307\b/);
  });

  test("the hourly check ends by beating, so an alert reaches the switch the same hour", () => {
    // The flag is cleared at the top of every hourly check, so with the only beat
    // at 03:00 an alert raised at 07:07 would be gone by 08:07 unheard, and
    // twenty-three of the twenty-four checks could not reach the switch at all.
    const lines = loop.split("\n");
    const start = lines.indexOf(hourlyGuardLine());
    const end = lines.findIndex((l, i) => i > start && /^\s*continue$/.test(l));
    assert.ok(end > start, "the hourly block does not end where this test expects it");
    const body = lines.slice(start, end);
    assert.ok(
      body.some((l) => /^\s*beat\s*$/.test(l)),
      "nothing in the hourly block pings the switch, so an alert waits for 03:00",
    );
  });

  test("a disk whose free space cannot be read is an alert, not a healthy disk", () => {
    // Extracted from the shipped loop and run against a stubbed df. A df that
    // fails, prints only its header or reports no capacity is each a way of being
    // unable to see a disk, and must never read as a disk with space to spare.
    const run = (dfBody: string) =>
      sh(`
        say() { printf '%s\\n' "$*"; }
        ALERTS=0
        ${shellFunction(loop, "alert")}
        df() { ${dfBody}; }
        ${shellFunction(loop, "free_pct")}
        ${shellFunction(loop, "check_disk")}
        check_disk /var/lib/postgresql "database disk"
        echo "ALERTS=$ALERTS"
      `);
    const header = "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'";
    const row = (pct: string) => `${header}; printf '/dev/sda1 100 50 50 ${pct} /var/lib/postgresql\\n'`;

    for (const [what, body] of [
      ["df failing", "return 1"],
      ["df printing only its header", header],
      ["a filesystem reporting no capacity", row("-")],
    ] as const) {
      const out = run(body);
      assert.equal(out.code, 0, out.out);
      assert.match(out.out, /ALERTS=1/, `${what} was treated as a healthy disk:\n${out.out}`);
      assert.match(out.out, /cannot read how much of the database disk is free/);
    }

    const full = run(row("91%"));
    assert.match(full.out, /ALERTS=1/, full.out);
    assert.match(full.out, /the database disk is 9% free/);

    const fine = run(row("40%"));
    assert.match(fine.out, /ALERTS=0/, fine.out);
  });

  test("it watches the disk the database is on, not only the backup disk", () => {
    // /var/lib/pgbackrest is the repository, and filling it stops backups;
    // /var/lib/postgresql holds pgdata and pg_wal, and filling it stops the
    // database. Both are watched.
    assert.match(loop, /^\s*check_disk \/var\/lib\/postgresql /m);
    assert.match(loop, /^\s*check_disk \/var\/lib\/pgbackrest /m);
  });

  test("an alert withholds the next heartbeat, so the switch fires", () => {
    // Saying "ALERT" into a container log is saying it to nobody: that is the
    // first paragraph of the file. So an alert withholds the next beat, rather
    // than the next successful backup reporting healthy on top of it.
    const harness = (alertFirst: boolean) => `
      set -u
      FLAG=$1
      ${shellFunction(loop, "say")}
      ALERTS=0
      ${shellFunction(loop, "alert")}
      HEARTBEAT_URL=https://switch.invalid/ping
      curl() { : > "$FLAG"; return 0; }
      ${shellFunction(loop, "beat")}
      ${alertFirst ? 'alert "the backup disk is 3% free"' : ""}
      beat
    `;
    const dir = mkdtempSync(path.join(tmpdir(), "beat-"));
    try {
      const pinged = path.join(dir, "pinged");
      const run = (alertFirst: boolean) => {
        const script = path.join(dir, `beat-${alertFirst}.sh`);
        writeFileSync(script, harness(alertFirst));
        return sh(`sh ${JSON.stringify(script)} ${JSON.stringify(pinged)}`);
      };

      const ok = run(false);
      assert.equal(ok.code, 0, ok.out);
      assert.ok(existsSync(pinged), `a clean pass did not ping the switch: ${ok.out}`);

      rmSync(pinged, { force: true });
      const alerted = run(true);
      assert.equal(alerted.code, 0, alerted.out);
      assert.ok(
        !existsSync(pinged),
        `an outstanding alert still pinged the dead-man's switch: ${alerted.out}`,
      );
      assert.match(alerted.out, /WITHHOLDING THE HEARTBEAT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("and it refuses to start with no switch to ping at all", () => {
    // Without a dead-man's switch, backups can stop and no mechanism anywhere
    // tells a person. Refused at start, where the fix takes a minute, rather than
    // at the first failure.
    const start = (url: string) =>
      sh(`
        set -u
        HEARTBEAT_URL=${JSON.stringify(url)}
        ${shellFunction(loop, "say")}
        ${shellCase(loop, 'case "${HEARTBEAT_URL}" in')}
        exit 0
      `);
    for (const url of ["", "REPLACE_WITH_HEARTBEAT_URL"]) {
      const refused = start(url);
      assert.equal(refused.code, 1, `the loop started with HEARTBEAT_URL=${JSON.stringify(url)}`);
      assert.match(refused.out, /REFUSING TO START: HEARTBEAT_URL is not set/);
    }
    assert.equal(start("https://switch.invalid/ping").code, 0, "the loop refused a real switch");
  });
});

describe("the weekly dump is never written in the clear", () => {
  // The dump is every private SPACE, and the globals file every role's password
  // hash. A plain redirect would leave both on the backup disk for the 35 days
  // retention keeps them.
  const loop = read("postgres/backup-loop.sh");

  test("it goes through gpg, and retention prunes the encrypted files", () => {
    const writeDump = shellFunction(loop, "write_dump");
    assert.match(writeDump, /"\$@" 2>\/tmp\/dump\.err \|\s+gpg_batch --symmetric /, "write_dump no longer pipes the dump through gpg");
    const names = [...loop.matchAll(/^\s*write_dump "([^"]+)"/gm)].map((m) => m[1]!);
    assert.equal(names.length, 2, "the loop no longer writes the dump and the globals");
    for (const name of names) assert.match(name, /\.gpg$/, `${name} is written without .gpg`);
    // A retention sweep that names the plain files prunes nothing while still
    // looking like it does.
    assert.match(loop, /^\s*find \/dumps -name '\*\.dump\.gpg' -mtime \+35 -delete/m, "retention does not prune the encrypted dumps");
    assert.match(loop, /^\s*find \/dumps -name 'globals-\*\.sql\.gpg' -mtime \+35 -delete/m, "retention does not prune the encrypted globals");
  });
});

// ── the test stack ───────────────────────────────────────────────────────────

describe("the test database is not published to the network", () => {
  test("it binds loopback, with the password that is printed in this repository", () => {
    // A ports entry with no interface binds the wildcard address. This file's
    // four passwords are fixed strings in the repository, and the superuser one
    // means COPY ... FROM PROGRAM. Docker DNATs a published port ahead of the
    // host firewall's INPUT chain, so ufw does not stop it.
    const compose = read("compose.test.yml");
    const ports = compose
      .split("\n")
      .filter((line) => /^\s*-\s*"[^"]*:5432"/.test(line))
      .map((line) => /"([^"]*)"/.exec(line)![1]!);
    assert.equal(ports.length, 1, "compose.test.yml no longer publishes exactly one port");
    assert.ok(
      ports[0]!.startsWith("127.0.0.1:"),
      `the test database is published on ${ports[0]}, which is every interface`,
    );
  });
});

// ── the benchmark ────────────────────────────────────────────────────────────

describe("the benchmark cannot point at a database that is not one", () => {
  // scripts/bench.sh disables five immutability triggers and deletes rows —
  // the only thing in the repository that reaches past them, and the only thing
  // that may. Which database it reaches into came from DB_NAME, whose
  // documented production value is `schellingaf` and which
  // scripts/restore-drill.sh exports out of .env with `set -a`.
  const bench = read("scripts/bench.sh");

  /** The `case "$DB" in ... esac` refusal, lifted out and run on its own. */
  const refusal = () => shellCase(bench, 'case "$DB" in');

  for (const name of ["schellingaf", "schellingaf_prod", "postgres", "schellingaf_t_docs_0"]) {
    test(`it refuses ${name}`, () => {
      const result = sh(`DB=${name}\n${refusal()}\nexit 0`);
      assert.equal(result.code, 1, `bench.sh would have run against ${name}`);
      assert.match(result.out, /not a benchmark database/);
    });
  }

  for (const name of ["schellingaf_bench", "bench", "my_bench_db"]) {
    test(`it accepts ${name}`, () => {
      const result = sh(`DB=${name}\n${refusal()}\nexit 0`);
      assert.equal(result.code, 0, result.out);
    });
  }

  // scripts/seed.ts is the FIRST step of the same procedure, reads the same
  // variable, and writes a million posts nothing can delete. Run for real: the
  // refusal has to happen before it opens a connection, so no database is needed.
  for (const name of ["schellingaf", "schellingaf_local", "production"]) {
    test(`the seed refuses DB_NAME=${name} before it connects to anything`, () => {
      const result = sh(
        `cd "${ROOT}" && DB_NAME=${name} DB_PORT=1 node scripts/seed.ts --posts 1 --spaces 1 --peers 1`,
      );
      assert.equal(result.code, 1, `seed.ts would have run against ${name}: ${result.out}`);
      assert.match(result.out, /not a seed or benchmark database/);
    });
  }

  test("and it does not refuse a seed database, which it then tries to reach", () => {
    // Port 1: nothing listens there, so the run fails on the connection — which
    // is the proof it got past the name check rather than stopping at it.
    const result = sh(`cd "${ROOT}" && DB_NAME=schellingaf_seed DB_PORT=1 node scripts/seed.ts --posts 1`);
    assert.doesNotMatch(result.out, /refusing/, result.out);
  });

  test("and every delete it makes is scoped to what the benchmark created", () => {
    // An unscoped delete from join_requests, or of every delivery carrying a
    // request_id, would reach every request and decision delivery ever made, and
    // none of them resets mailboxes.last_seq.
    const resetDb = shellFunction(bench, "reset_db");
    const deletes = [...resetDb.matchAll(/delete from ([^;]*);/g)].map((m) => m[1]!);
    assert.ok(deletes.length >= 4, `only ${deletes.length} deletes found in reset_db`);
    for (const statement of deletes) {
      assert.match(
        statement.replace(/\s+/g, " "),
        /where/i,
        `an unscoped delete is back in reset_db: delete from ${statement.trim()}`,
      );
    }
  });
});

// ── the roles the init script creates ────────────────────────────────────────

describe("the api role's defaults are the ones the comment promises", () => {
  let fixture: Fixture;
  before(async () => {
    fixture = await cloneDatabase("deployment");
  });
  after(async () => {
    await fixture.end();
  });

  test("its search path really is pg_catalog, then the schema", async () => {
    // Written 'pg_catalog, schellingaf', the whole list inside one pair of
    // quotes, PostgreSQL stores ONE identifier naming a schema that does not
    // exist, and the effective path is {pg_catalog} alone.
    const [row] = await fixture.api<{ schemas: string[] }[]>`
      select current_schemas(true) as schemas`;
    assert.deepEqual(
      row!.schemas,
      ["pg_catalog", "schellingaf"],
      "the api role's effective search path is not pg_catalog then schellingaf",
    );
  });

  test("and a temp table cannot shadow a table in it", async () => {
    // A search_path that does not name pg_temp has it searched FIRST for
    // relations, so the first unqualified relation name ever added to api-role
    // SQL would have resolved to whatever the session had made for itself.
    // pg_temp is now named last, and the privilege is gone besides — which is
    // what this proves, because the privilege is per-database and the suite's
    // clones do not inherit it from the template.
    const api = postgres({
      ...SUPERUSER,
      database: "schellingaf",
      username: "schellingaf_api",
      password: API_PASSWORD,
      port: PORT,
    });
    try {
      await assert.rejects(
        api`create temp table spaces (x int)`,
        /permission denied to create temporary tables/,
        "the api role can still create a temp table in the deployed database",
      );
    } finally {
      await api.end({ timeout: 5 });
    }
  });
});

// ── the image's entry point ──────────────────────────────────────────────────

describe("the service never runs as root, and owns its log directory", () => {
  // A host may mount the log directory's volume owned by root. The image starts as
  // root so its entry point can give that directory to node, then runs as node.
  const dockerfile = read("Dockerfile");

  test("the image runs every command through the entry point, and its health check follows PORT", () => {
    assert.match(dockerfile, /^COPY docker-entrypoint\.sh \/docker-entrypoint\.sh$/m);
    assert.match(dockerfile, /^ENTRYPOINT \["\/docker-entrypoint\.sh"\]$/m);
    assert.match(dockerfile, /^CMD \["node", "src\/server\.ts"\]$/m);
    // A USER line would start the entry point as that user, which cannot give a
    // root-owned directory away.
    assert.doesNotMatch(dockerfile, /^USER /m);
    assert.doesNotMatch(read(".dockerignore"), /^docker-entrypoint\.sh$|^\*\.sh$/m, "the entry point is kept out of the image");
    const health = dockerfile.split("\n").find((l) => l.includes("/healthz"));
    assert.ok(health?.includes("process.env.PORT"), `the health check ignores PORT: ${health}`);
  });

  /** The shipped entry point, run with `id`, `chown` and `setpriv` stubbed on PATH:
   * each stub writes what it was asked into calls, and the command is `echo ran`. */
  let bin: string;
  before(() => {
    bin = mkdtempSync(path.join(tmpdir(), "entrypoint-bin-"));
    const stub = (name: string, body: string) => writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub("id", 'echo "$STUB_UID"');
    stub("chown", 'echo "chown $*" >> "$CALLS"');
    stub("setpriv", 'echo "setpriv HOME=$HOME $*" >> "$CALLS"');
  });
  after(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  function entrypoint(uid: string, logDir: string | undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), "entrypoint-"));
    try {
      const calls = path.join(dir, "calls");
      const where = logDir?.replace("$DIR", dir);
      const env = `STUB_UID=${uid} CALLS=${JSON.stringify(calls)} PATH=${JSON.stringify(bin)}:"$PATH" HOME=/root` +
        (where === undefined ? "" : ` LOG_DIR=${JSON.stringify(where)}`);
      const out = sh(`${env} sh ${JSON.stringify(path.join(ROOT, "docker-entrypoint.sh"))} echo ran`);
      const recorded = existsSync(calls) ? readFileSync(calls, "utf8") : "";
      return { ...out, calls: recorded.replaceAll(dir, "$DIR"), made: where !== undefined && existsSync(where) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("started as root, it makes LOG_DIR, gives that one directory to node, and runs the command as node", () => {
    const out = entrypoint("0", "$DIR/logs/api");
    assert.equal(out.code, 0, out.out);
    assert.ok(out.made, "the log directory was not made");
    assert.equal(
      out.calls,
      // -h: a link put where LOG_DIR is gives node the link, never what it points to.
      "chown -h node:node $DIR/logs/api\n" + "setpriv HOME=/home/node --reuid=node --regid=node --init-groups echo ran\n",
    );
  });

  test("with no LOG_DIR, or one that is not an absolute path, it gives nothing away and still drops to node", () => {
    for (const logDir of [undefined, "", "REPLACE_WITH_LOG_DIR"]) {
      const out = entrypoint("0", logDir);
      assert.equal(out.code, 0, out.out);
      assert.equal(out.calls, "setpriv HOME=/home/node --reuid=node --regid=node --init-groups echo ran\n", String(logDir));
    }
  });

  test("started as anyone else, it runs the command as it is", () => {
    const out = entrypoint("1000", "$DIR/logs/api");
    assert.equal(out.code, 0, out.out);
    assert.equal(out.calls, "");
    assert.match(out.out, /^ran$/m);
  });

  test("the compose services that replace the entry point run as node all the same", () => {
    const compose = read("docker-compose.yml");
    const services = [...compose.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n|^[a-z]|(?![\s\S]))/gm)];
    const fromThisImage = services.filter(([, , body]) => /^    build: \.$/m.test(body!));
    assert.ok(fromThisImage.length >= 3, "the services built from this image are not where this test expects them");
    for (const [, name, body] of fromThisImage) {
      if (/^    entrypoint:/m.test(body!)) assert.match(body!, /^    user: node$/m, `${name} replaces the entry point and runs as root`);
      else assert.doesNotMatch(body!, /^    user: (?!node)/m, `${name} runs as another user`);
    }
  });

  test("the reviewer's image does the same for its state directory", () => {
    const reviewer = read("reviewer/Dockerfile");
    assert.match(reviewer, /^COPY docker-entrypoint\.sh \/docker-entrypoint\.sh$/m);
    assert.match(reviewer, /^ENTRYPOINT \["\/docker-entrypoint\.sh"\]$/m);
    assert.doesNotMatch(reviewer, /^USER /m);
    const dir = mkdtempSync(path.join(tmpdir(), "reviewer-entrypoint-"));
    try {
      const calls = path.join(dir, "calls");
      const state = path.join(dir, "state", "reviewer-state.json");
      const env = `STUB_UID=0 CALLS=${JSON.stringify(calls)} PATH=${JSON.stringify(bin)}:"$PATH" HOME=/root REVIEWER_STATE_FILE=${JSON.stringify(state)}`;
      const out = sh(`${env} sh ${JSON.stringify(path.join(ROOT, "reviewer/docker-entrypoint.sh"))} echo ran`);
      assert.equal(out.code, 0, out.out);
      assert.ok(existsSync(path.dirname(state)), "the state directory was not made");
      assert.equal(
        readFileSync(calls, "utf8").replaceAll(dir, "$DIR"),
        "chown -h node:node $DIR/state\n" + "setpriv HOME=/home/node --reuid=node --regid=node --init-groups echo ran\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── what reaches the container ───────────────────────────────────────────────

describe("the settings an operator writes reach the service", () => {
  test("every service setting .env.example documents, and the service reads, is passed to the api container", () => {
    // Compose reads .env only to fill in the ${} placeholders in the compose
    // file. It does not hand the container anything the environment block does
    // not name, so a setting the service requires at startup and the block leaves
    // out stops the deployed stack from starting.
    const documented = [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    // What the API process reads. The migration runner is its own container with
    // its own environment block, so its settings are not the api's to receive.
    const sources = sh(
      `cd "${ROOT}" && grep -rhoE '[A-Z][A-Z0-9_]{3,}' src --include='*.ts' --exclude=migrate.ts | sort -u`,
    ).out.split("\n");
    const readByService = new Set(sources);

    const compose = read("docker-compose.yml");
    const apiBlock = compose.match(/^  api:\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n)/m);
    assert.ok(apiBlock, "the api service is not where this test expects it");
    const passed = new Set([...apiBlock[1]!.matchAll(/^      ([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!));

    const missing = documented.filter((key) => readByService.has(key) && !passed.has(key));
    assert.deepEqual(missing, [], `documented, read by the service, and never passed in: ${missing.join(", ")}`);
  });

  test("every limit src/http/ratelimit.ts reads from the environment is passed to the api container, documented, and written with its own default", () => {
    // The first test above starts from what .env.example documents, so a limit
    // nobody documented is invisible to it: it can be read by the service and
    // never set by an operator. This one starts from the service. A limit added
    // to ratelimit.ts with envNumber() and left out of the deployment fails here.
    const source = read("src/http/ratelimit.ts");
    const limitsRead = [...source.matchAll(/envNumber\(\s*"([A-Z][A-Z0-9_]*)"\s*,\s*([^,)]+)/g)].map((m) => m[1]!);
    assert.ok(limitsRead.length >= 18, "this test no longer finds the limits in ratelimit.ts");

    const compose = read("docker-compose.yml");
    const apiBlock = compose.match(/^  api:\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:\n)/m);
    assert.ok(apiBlock, "the api service is not where this test expects it");
    const passed = new Map(
      [...apiBlock[1]!.matchAll(/^      ([A-Z][A-Z0-9_]*): \$\{([A-Z][A-Z0-9_]*):-([^}]*)\}/gm)].map((m) => [m[1]!, m[3]!]),
    );
    const documented = new Map(
      [...read(".env.example").matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]),
    );

    const notPassed = limitsRead.filter((k) => !passed.has(k));
    assert.deepEqual(notPassed, [], `read by ratelimit.ts and not named in the api container's environment: ${notPassed.join(", ")}`);
    const notDocumented = limitsRead.filter((k) => !documented.has(k));
    assert.deepEqual(notDocumented, [], `read by ratelimit.ts and not documented in .env.example: ${notDocumented.join(", ")}`);
    // Written twice, held equal: the compose default and the .env.example value
    // must be one number, so naming a limit never changes it.
    const differ = limitsRead.filter((k) => passed.get(k) !== documented.get(k));
    assert.deepEqual(differ, [], `the compose default and the .env.example value differ for: ${differ.join(", ")}`);
  });
});
