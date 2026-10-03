// What the service refuses to start with, what it writes down once it has, and
// the script that prepares the machine for both.
//
// Every rule here is of one kind: a mistake knowable at boot is refused at boot.
// A secret file that is empty, a gate spelled a way the parser does not know, a
// log directory that cannot be written, a log nothing prunes.
//
// The first-run tests extract the shell function under test out of the shipped
// script and run it, rather than reading it and agreeing that it looks right.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { execFileSync, spawn } from "node:child_process";
import { createHmac, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { envNumber, loadConfig } from "../src/config.ts";
import { pruneRequestLog, requestLog, requestLogDays, type Head } from "../src/http/log.ts";
import { prune, startPrune } from "../src/db/prune.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrationFiles, missingMigration, waitForDatabase, type MigrationFile } from "../src/db/wait.ts";
import { openDb, type Db } from "../src/db/sql.ts";
import { createApp, type Env } from "../src/http/app.ts";
import { certify, ed25519PublicKeyOf, signStatement } from "../src/domain/service.ts";
import type { Config } from "../src/config.ts";
import { cloneDatabase, type Fixture } from "./helpers.ts";
import { API_PASSWORD, PORT } from "./bootstrap.ts";
import { withEnv } from "./lib/env.ts";
import { ROOT, read, sh, shellFunction } from "./lib/shell.ts";
import postgres from "postgres";

/**
 * loadConfig() with the four settings it requires, each setting in `extra` set
 * (or unset, for undefined), and none of the settings that change what it checks
 * left over from the shell. The whole environment is put back afterwards.
 */
function loadWith(extra: Record<string, string | undefined> = {}): { config: Config | null; error: Error | null } {
  const saved = { ...process.env };
  Object.assign(process.env, {
    API_HOST: "startup.invalid",
    PUBLIC_ORIGIN: "https://startup.invalid",
    CHALLENGE_KEY: "a-challenge-key-that-is-long-enough",
    DB_PASSWORD: "a-db-password-that-is-long-enough",
  });
  delete process.env.CHALLENGE_KEY_FILE;
  delete process.env.DB_PASSWORD_FILE;
  delete process.env.SERVICE_KEY;
  delete process.env.SERVICE_CERTIFICATE;
  delete process.env.REQUIRE_APPROVED_COPY;
  delete process.env.LOG_DIR;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return { config: loadConfig(), error: null };
  } catch (error) {
    return { config: null, error: error as Error };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

// ── the secret files ─────────────────────────────────────────────────────────

describe("a secret file the service cannot use is a refusal to start", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "secret-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [what, contents] of [
    ["empty", ""],
    ["whitespace only", "   \n\t\n"],
    ["one byte", "x"],
  ] as const) {
    test(`an ${what} challenge key file is refused`, () => {
      // An empty HMAC key is valid and publicly computable, and http/auth.ts feeds
      // config.challengeKey straight into createHmac: anybody could forge a
      // challenge, with an expiry of their choosing.
      const file = path.join(dir, `key-${what.replace(/\s/g, "-")}`);
      writeFileSync(file, contents);
      const { error } = loadWith({ CHALLENGE_KEY_FILE: file });
      assert.ok(error, `a ${what} challenge key file started the service`);
      assert.match(error.message, /at least 16 are required/);
    });
  }

  test("and so is an empty database password file", () => {
    const file = path.join(dir, "db-empty");
    writeFileSync(file, "");
    const { error } = loadWith({ DB_PASSWORD_FILE: file });
    assert.ok(error, "an empty database password file started the service");
  });

  test("a real one is accepted, so this is a length check and not a refusal to read files", () => {
    const file = path.join(dir, "key-real");
    writeFileSync(file, "0123456789abcdef0123456789abcdef0123456789abcdef");
    assert.equal(loadWith({ CHALLENGE_KEY_FILE: file }).error, null);
  });

  test("what an empty key would have meant", () => {
    // Kept as the reason rather than as prose: the digest below needs no secret
    // and no private key, and two people computing it get the same answer.
    const forged = createHmac("sha256", Buffer.alloc(0)).update("x").digest("hex");
    assert.equal(forged.slice(0, 24), "4cbc96099a6467ce002461f1");
  });
});

// ── the service's signing key ────────────────────────────────────────────────

describe("the service's signing key, from two files or from two settings", () => {
  // A platform has no secret files, so the key's PEM and its certificate may be
  // given as the settings' values. Each pair is both or neither, and the files win.
  let dir: string;
  let pem: string;
  let certificate: string;
  let keyFile: string;
  let certificateFile: string;
  const none = { SERVICE_KEY_FILE: undefined, SERVICE_CERTIFICATE_FILE: undefined, SERVICE_KEY: undefined, SERVICE_CERTIFICATE: undefined, SERVICE_ROOT_KEY: undefined };
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "service-key-"));
    const root = generateKeyPairSync("ed25519").privateKey;
    const online = generateKeyPairSync("ed25519").privateKey;
    pem = online.export({ format: "pem", type: "pkcs8" }).toString();
    const signed = certify(root, ed25519PublicKeyOf(online), { notBefore: new Date(Date.now() - 1000) });
    certificate = JSON.stringify({ certificate: signed.canonical.toString("base64url"), signature: signed.signature.toString("hex") });
    keyFile = path.join(dir, "service_signing_key.pem");
    certificateFile = path.join(dir, "service_certificate.json");
    writeFileSync(keyFile, pem);
    writeFileSync(certificateFile, certificate);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("given inline, the key signs exactly what it signs read from its files", () => {
    const fromFiles = loadWith({ ...none, SERVICE_KEY_FILE: keyFile, SERVICE_CERTIFICATE_FILE: certificateFile });
    // As a platform stores a value pasted with its last line break.
    const fromSettings = loadWith({ ...none, SERVICE_KEY: `${pem}\n`, SERVICE_CERTIFICATE: `${certificate}\n` });
    assert.equal(fromFiles.error, null, String(fromFiles.error));
    assert.equal(fromSettings.error, null, String(fromSettings.error));
    const a = fromFiles.config!.serviceKey!;
    const b = fromSettings.config!.serviceKey!;
    assert.equal(b.development, false, "the inline key was taken for a development key");
    assert.deepEqual(b.publicKey, a.publicKey);
    assert.deepEqual(b.certificate, a.certificate);
    const statement = Buffer.from("a checkpoint");
    assert.deepEqual(signStatement("checkpoint", statement, b.privateKey), signStatement("checkpoint", statement, a.privateKey));
  });

  test("the files win when both pairs are given", () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const both = loadWith({ SERVICE_ROOT_KEY: undefined, SERVICE_KEY_FILE: keyFile, SERVICE_CERTIFICATE_FILE: certificateFile, SERVICE_KEY: other, SERVICE_CERTIFICATE: "{}" });
    assert.equal(both.error, null, String(both.error));
    assert.deepEqual(both.config!.serviceKey!.publicKey, ed25519PublicKeyOf(createPrivateKey(pem)));
  });

  for (const [what, extra, missing] of [
    ["the key inline without its certificate", { SERVICE_KEY: "pem" }, /SERVICE_CERTIFICATE is missing/],
    ["the certificate inline without its key", { SERVICE_CERTIFICATE: "{}" }, /SERVICE_KEY is missing/],
    ["the key's file without the certificate's", { SERVICE_KEY_FILE: "/run/secrets/key.pem" }, /SERVICE_CERTIFICATE_FILE is missing/],
  ] as const) {
    test(`${what} refuses to start, naming the one that is missing`, () => {
      const { error } = loadWith({ ...none, ...extra });
      assert.ok(error, `${what} started the service`);
      assert.match(error!.message, missing);
      assert.match(error!.message, /together or not at all/);
    });
  }

  test("a refusal of an inline key names the setting it came from", () => {
    const { error } = loadWith({ ...none, SERVICE_KEY: "not a key", SERVICE_CERTIFICATE: certificate });
    assert.ok(error, "a key that is not a PEM started the service");
    assert.equal(error!.message, "SERVICE_KEY is not a PEM private key.");
  });

  test("the deployed configuration starts with the inline pair alone", () => {
    const { error } = loadWith({
      ...none,
      SERVICE_KEY: pem,
      SERVICE_CERTIFICATE: certificate,
      REQUIRE_APPROVED_COPY: "1",
      OPERATOR_CONTACT: "abuse@example.test",
      LOG_DIR: "/var/log/schellingaf",
    });
    assert.doesNotMatch(String(error?.message), /SERVICE_KEY|SERVICE_CERTIFICATE/);
  });
});

// ── the wait for the database and its schema ─────────────────────────────────

describe("the service waits at start for the database and the schema it carries", () => {
  // A platform starts the service and the migration runner of one release in no
  // order, and may start either before the database answers.
  const files: MigrationFile[] = [
    { version: 101, name: "foundation", file: "0101_foundation.sql" },
    { version: 102, name: "tables", file: "0102_tables.sql" },
    { version: 103, name: "access", file: "0103_access.sql" },
  ];

  test("the schema is ready when every migration carried is applied, by version", () => {
    assert.equal(missingMigration(files, [101, 102, 103]), null);
    assert.equal(missingMigration(files, [103, 101, 102]), null, "the order applied is not the point");
    assert.equal(missingMigration(files, [101, 102, 103, 104]), null, "a later release's migration held the start of a rolled-back one");
    assert.deepEqual(missingMigration(files, [101, 102]), files[2]);
    assert.deepEqual(missingMigration(files, [101, 103]), files[1]);
    assert.deepEqual(missingMigration(files, []), files[0]);
  });

  test("the migrations carried are read from migrations/, as the runner reads them", () => {
    const carried = migrationFiles();
    assert.ok(carried.length > 0);
    assert.deepEqual(carried.map((m) => m.version), [...carried.map((m) => m.version)].sort((a, b) => a - b));
    const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
    try {
      writeFileSync(path.join(dir, "0101_one.sql"), "");
      writeFileSync(path.join(dir, "0101_again.sql"), "");
      assert.throws(() => migrationFiles(dir), /two migrations share version 101/);
      writeFileSync(path.join(dir, "1_bad.sql"), "");
      assert.throws(() => migrationFiles(dir), /1_bad.sql is not named/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("against a database one migration behind", () => {
    let fixture: Fixture;
    let last: { version: number; name: string; sha256: string };
    const carried = migrationFiles();
    const newest = carried.at(-1)!;
    const padded = String(newest.version).padStart(4, "0");
    before(async () => {
      fixture = await cloneDatabase("startup_wait");
      const [row] = await fixture.owner<{ version: number; name: string; sha256: string }[]>`
        delete from schellingaf.schema_migrations where version = ${newest.version} returning version, name, sha256`;
      assert.ok(row, "the clone does not hold the newest migration");
      last = row;
    });
    after(async () => {
      await fixture.end();
    });

    test("it says which migration it waits for, and goes on once it is applied", async () => {
      const said: string[] = [];
      const waiting = waitForDatabase(fixture.api, {
        seconds: 30,
        target: `127.0.0.1:${PORT}`,
        migrations: carried,
        reportEverySeconds: 0,
        write: (line) => said.push(line),
      });
      let settled = false;
      void waiting.finally(() => (settled = true));
      for (let i = 0; i < 100 && said.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      // Read as the api role: a line naming the newest migration, rather than the
      // first, is the proof the service may read the ledger's versions.
      assert.match(said[0] ?? "", new RegExp(`^waiting for migration ${padded} \\(${newest.file}\\) in the database at 127\\.0\\.0\\.1:${PORT}`));
      assert.equal(settled, false, "the wait ended with a migration missing");
      await fixture.owner`
        insert into schellingaf.schema_migrations (version, name, sha256) values (${last.version}, ${last.name}, ${last.sha256})`;
      try {
        await waiting;
      } finally {
        await fixture.owner`delete from schellingaf.schema_migrations where version = ${newest.version}`;
      }
    });

    test("and at the deadline refuses, naming the migration and the runner", async () => {
      await assert.rejects(
        waitForDatabase(fixture.api, { seconds: 0.2, target: "db.invalid:5432", migrations: carried, write: () => {} }),
        new RegExp(`the database at db\\.invalid:5432 did not have migration ${padded} \\(${newest.file}\\) within 0\\.2s.*node src/db/migrate\\.ts`),
      );
    });

    test("the service itself refuses to start there once DB_WAIT_SECONDS has passed", async () => {
      const out = await startServer({ DB_NAME: fixture.name, DB_WAIT_SECONDS: "1" });
      assert.equal(out.code, 1, out.stderr);
      assert.match(out.stderr, new RegExp(`the service did not start: the database at 127\\.0\\.0\\.1:${PORT} did not have migration ${padded}`));
    });
  });

  test("the service refuses to start when the database never answers", async () => {
    const out = await startServer({ DB_PORT: "1", DB_WAIT_SECONDS: "1" });
    assert.equal(out.code, 1, out.stderr);
    assert.match(out.stderr, /the service did not start: database did not accept a connection within 1s/);
  });

  test("a wait of 0 seconds is one look, however quickly that look fails", { timeout: 5_000 }, async (t) => {
    // The clock held still: the failure comes back in the same millisecond the wait began.
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    let looks = 0;
    const refusing = (() => {
      looks++;
      return Promise.reject(new Error("connection refused"));
    }) as unknown as postgres.Sql;
    await assert.rejects(
      waitForDatabase(refusing, { seconds: 0, target: "db.invalid:5432", write: () => {} }),
      /database did not accept a connection within 0s: Error: connection refused/,
    );
    assert.equal(looks, 1);
  });

  test("the migration runner waits as long as DB_WAIT_SECONDS says, when it is set", async () => {
    const started = Date.now();
    await withEnv({ DB_WAIT_SECONDS: "0" }, () =>
      assert.rejects(
        migrate({ host: "127.0.0.1", port: 1, database: "none", username: "none", password: "none", max: 1, onnotice: () => {} }),
        /database did not accept a connection within 0s/,
      ),
    );
    assert.ok(Date.now() - started < 10_000, "the runner waited past a setting of 0");
  });
});

/** `node src/server.ts` with the settings a start needs and `extra`, against this
 * suite's database, run until it exits. */
async function startServer(extra: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    API_HOST: "startup.invalid",
    PUBLIC_ORIGIN: "https://startup.invalid",
    CHALLENGE_KEY: "a-challenge-key-that-is-long-enough",
    DB_HOST: "127.0.0.1",
    DB_PORT: String(PORT),
    DB_USER: "schellingaf_api",
    DB_PASSWORD: API_PASSWORD,
    // Never reached: the start is refused before the service listens.
    PORT: "0",
    ...extra,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/server.ts"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

// ── READ_ONLY ────────────────────────────────────────────────────────────────

describe("the restore gate is read the way an operator writes it", () => {
  function readOnlyFor(value: string | undefined): boolean | Error {
    const { config, error } = loadWith({ READ_ONLY: value });
    return error ?? config!.readOnly;
  }

  // test/read-only.test.ts proves the service honours config.readOnly; these prove
  // READ_ONLY=<value> produces the right boolean, where a misread meaning off is
  // the one failure this service cannot repair.
  for (const on of ["1", "true", "TRUE", "True", "yes", "on", " true "]) {
    test(`READ_ONLY=${JSON.stringify(on)} refuses writes`, () => {
      assert.equal(readOnlyFor(on), true, `READ_ONLY=${on} did not close the gate`);
    });
  }

  for (const off of ["0", "false", "no", "off", ""]) {
    test(`READ_ONLY=${JSON.stringify(off)} allows them`, () => {
      assert.equal(readOnlyFor(off), false);
    });
  }

  test("unset allows them, which is the ordinary state", () => {
    assert.equal(readOnlyFor(undefined), false);
  });

  test("and a value it cannot read refuses to start rather than guessing off", () => {
    const error = readOnlyFor("maybe");
    assert.ok(error instanceof Error, 'READ_ONLY="maybe" was silently taken as off');
    assert.match(error.message, /neither on nor off/);
  });
});

// ── the request log ──────────────────────────────────────────────────────────

describe("the request log", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "reqlog-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An app whose one route records whatever the caller asked it to. */
  function appFor(
    logDir: string,
    prepare?: (c: { set: (k: never, v: never) => void; get: (k: never) => never }) => void,
  ): Hono<Env> {
    const app = new Hono<Env>();
    app.use("*", requestLog(logDir));
    app.all("*", (c) => {
      c.set("requestId", "00000000-0000-4000-8000-000000000000");
      prepare?.(c as never);
      return c.text("ok");
    });
    return app;
  }

  const lines = (from: string) =>
    readdirSync(from)
      .filter((f) => f.startsWith("requests-"))
      .flatMap((f) => readFileSync(path.join(from, f), "utf8").split("\n"))
      .filter(Boolean);

  test("refuses to start when it cannot write", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("running as root, where every directory is writable");
      return;
    }
    // mkdirSync with recursive:true says nothing about an existing directory's
    // mode, and a log it cannot write loses the only record a lossy restore can be
    // reconciled against.
    const locked = mkdtempSync(path.join(tmpdir(), "locked-"));
    chmodSync(locked, 0o555);
    try {
      assert.throws(() => requestLog(locked), /is not writable/);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  test("but a stream position it handed out always is", async () => {
    const app = appFor(dir, (c) => {
      const head: Head = { stream: "space", name: "a-space", seq: "17" };
      (c.get as unknown as (k: "heads") => Head[])("heads").push(head);
    });
    await app.request("/v1/spaces/a-space/posts", { method: "POST" });
    await new Promise((r) => setTimeout(r, 80));
    const written = lines(dir).map((l) => JSON.parse(l) as { heads?: Head[] });
    assert.equal(written.length, 1);
    assert.deepEqual(written[0]!.heads, [{ stream: "space", name: "a-space", seq: "17" }]);
  });

  test("two lines of more than a megabyte written at once come out as two whole lines", async () => {
    // Approving a version of a document with 10,000 watchers records a mailbox head
    // for each, a line of about a megabyte, and an append that long is several
    // write() calls: two of them at once could splice into each other in the one
    // file a restore is reconciled against. Every head is kept.
    const big = mkdtempSync(path.join(tmpdir(), "reqlog-big-"));
    try {
      const app = appFor(big, (c) => {
        const heads = (c.get as unknown as (k: "heads") => Head[])("heads");
        for (let i = 0; i < 12_000; i++) heads.push({ stream: "mailbox", peer: i.toString(16).padStart(64, "0"), mailbox_seq: String(i) });
      });
      await Promise.all([app.request("/v1/one", { method: "POST" }), app.request("/v1/two", { method: "POST" })]);
      const file = () => readdirSync(big).filter((f) => f.startsWith("requests-")).map((f) => readFileSync(path.join(big, f), "utf8")).join("");
      for (let i = 0; i < 250 && file().split("\n").length < 3; i++) await new Promise((r) => setTimeout(r, 20));
      const written = lines(big);
      assert.equal(written.length, 2);
      for (const line of written) {
        assert.ok(line.length > 1024 * 1024, `a line of ${line.length} bytes`);
        const parsed = JSON.parse(line) as { heads: Head[] };
        assert.equal(parsed.heads.length, 12_000, "a head was dropped");
      }
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });

  test("and so is a read by a KEY, which the report's numbers are made of", async () => {
    const measured = mkdtempSync(path.join(tmpdir(), "reqlog-seen-"));
    try {
      const app = appFor(measured, (c) => {
        (c.set as unknown as (k: "bearer", v: unknown) => void)("bearer", {
          state: "valid",
          peerId: Buffer.alloc(32, 7),
          hash: Buffer.alloc(32),
          expiresAt: new Date(),
          label: null,
        });
      });
      await app.request("/v1/spaces");
      await new Promise((r) => setTimeout(r, 80));
      const written = lines(measured).map((l) => JSON.parse(l) as { peer: string | null });
      assert.equal(written.length, 1, "a request from a registered KEY was not recorded");
      assert.equal(written[0]!.peer, "07".repeat(32));
    } finally {
      rmSync(measured, { recursive: true, force: true });
    }
  });
});

// ── what the request log costs ───────────────────────────────────────────────

describe("the request log is pruned", () => {
  // The service deletes its own old days: nothing outside it does, and a platform
  // runs nothing beside it that could.
  const dayFile = (day: string) => `requests-${day}.jsonl`;
  const now = new Date("2026-10-01T12:00:00Z");
  /** A directory holding a day file on either side of 45 days before `now`, and the
   *  other things the log directory holds, or could. */
  function directory(): { dir: string; kept: string[]; deleted: string[] } {
    const dir = mkdtempSync(path.join(tmpdir(), "reqprune-"));
    const deleted = [dayFile("2026-08-16"), dayFile("2025-12-31"), dayFile("1999-01-01")];
    const kept = [
      dayFile("2026-08-17"), // exactly 45 days back: kept
      dayFile("2026-10-01"), // today
      dayFile("2027-01-01"), // a day still to come
      dayFile("2026-02-30"), // named like a log, by a day that never was
      "requests-2026-08.jsonl",
      "requests-2020-01-01.jsonl.gz",
      "old-requests-2020-01-01.jsonl",
      "checkpoints.ndjson",
      "checkpoints.ndjson.1",
      "restore-check.json",
      "restore-drill.log",
      ".writable",
    ];
    for (const name of [...deleted, ...kept]) writeFileSync(path.join(dir, name), "{}\n");
    // A directory named like a day's file is not a file this module wrote.
    mkdirSync(path.join(dir, dayFile("2020-01-02")));
    kept.push(dayFile("2020-01-02"));
    return { dir, kept, deleted };
  }

  test("and not sooner than the oldest restorable backup", async () => {
    // The log is on the disk that holds the pgBackRest repository, and filling it
    // stops backups and archive-push together. The retention has to outlast the
    // window a restore is reconciled over, or the log is gone when it is needed.
    const days = await withEnv({ REQUEST_LOG_DAYS: undefined }, () => requestLogDays());
    // 35 days is how long the encrypted weekly dumps are kept (backup-loop.sh).
    assert.ok(days >= 35, `the request log is pruned at ${days} days, before the oldest dump`);
    assert.equal(await withEnv({ REQUEST_LOG_DAYS: "0" }, () => requestLogDays()), 0);
    assert.equal(await withEnv({ REQUEST_LOG_DAYS: "-3" }, () => requestLogDays()), days);
    assert.equal(await withEnv({ REQUEST_LOG_DAYS: "forever" }, () => requestLogDays()), days);
    // And nothing on the host prunes it: one way to do one thing.
    assert.ok(!read("scripts/ops-report.cron").includes("requests-"), "scripts/ops-report.cron still prunes the request log");
  });

  test("by the day in each file's name, and nothing else in the directory", async () => {
    const { dir, kept, deleted } = directory();
    try {
      assert.equal(await pruneRequestLog(dir, 45, now), deleted.length);
      assert.deepEqual(readdirSync(dir).sort(), [...kept].sort());
      // A second run finds nothing left to delete.
      assert.equal(await pruneRequestLog(dir, 45, now), 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never, with REQUEST_LOG_DAYS=0", async () => {
    const { dir, kept, deleted } = directory();
    try {
      assert.equal(await pruneRequestLog(dir, 0, now), 0);
      assert.deepEqual(readdirSync(dir).sort(), [...kept, ...deleted].sort());
      // Nor when the request log starts with it set. (Its own probe of whether the
      // directory is writable is a .writable it removes again.)
      await withEnv({ REQUEST_LOG_DAYS: "0" }, async () => {
        requestLog(dir);
        await new Promise((r) => setTimeout(r, 100));
      });
      assert.deepEqual(readdirSync(dir).sort(), [...kept, ...deleted].filter((name) => name !== ".writable").sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("at startup, saying how many it deleted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reqprune-boot-"));
    const today = new Date();
    const back = (n: number) => new Date(today.getTime() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const day of [back(400), back(60), back(1)]) writeFileSync(path.join(dir, dayFile(day)), "{}\n");
    writeFileSync(path.join(dir, "checkpoints.ndjson"), "");
    const written: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await withEnv({ REQUEST_LOG_DAYS: undefined }, async () => {
        requestLog(dir);
        for (let i = 0; i < 50 && readdirSync(dir).length > 2; i++) await new Promise((r) => setTimeout(r, 20));
      });
    } finally {
      process.stderr.write = write;
    }
    try {
      assert.deepEqual(readdirSync(dir).sort(), ["checkpoints.ndjson", dayFile(back(1))]);
      assert.deepEqual(written.filter((l) => l.startsWith("request log")), [`request log: deleted 2 day file(s) older than 45 days from ${dir}\n`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── first run ────────────────────────────────────────────────────────────────

describe("the first-run script", () => {
  const firstRun = read("scripts/first-run.sh");

  test("the documented command survives sudo's environment reset", () => {
    // `SSD_ROOT=... sudo sh scripts/first-run.sh` loses both variables to sudo's
    // env_reset default, so the script dies on its own guard, and the obvious next
    // move, dropping the sudo, is the run that cannot set any directory's owner.
    const deploy = read("runbooks/deploy.md");
    const invocation = deploy
      .split("\n")
      .find((line) => line.includes("scripts/first-run.sh") && line.includes("sudo"));
    assert.ok(invocation, "runbooks/deploy.md no longer documents how to run first-run.sh");
    assert.match(invocation, /sudo env /, `runbooks/deploy.md still documents: ${invocation.trim()}`);
  });

  test("a directory it cannot give away is a failure, not a warning", (t) => {
    if (process.getuid?.() === 0) {
      t.skip("running as root, where the chown succeeds and there is nothing to prove");
      return;
    }
    // A directory left 0750 and unowned is one the container cannot write to, so
    // archiving stops and the request log is never written, both quietly.
    const dir = mkdtempSync(path.join(tmpdir(), "firstrun-"));
    try {
      const result = sh(`
        set -eu
        SSD_ROOT=${JSON.stringify(dir)}
        HDD_ROOT=${JSON.stringify(dir)}
        ${shellFunction(firstRun, "install_dir")}
        install_dir ${JSON.stringify(path.join(dir, "pgdata"))} 999
        echo "CARRIED ON"
      `);
      assert.equal(result.code, 1, `install_dir carried on: ${result.out}`);
      assert.ok(!result.out.includes("CARRIED ON"));
      assert.match(result.out, /could not chown/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty secret file is caught here rather than at startup", () => {
    // An empty CHALLENGE_KEY makes the challenge HMAC publicly computable, so the
    // "already exists, left alone" branch looks at what it leaves.
    const dir = mkdtempSync(path.join(tmpdir(), "secrets-"));
    try {
      const secrets = path.join(dir, "secrets");
      execFileSync("/bin/sh", ["-c", `mkdir -p ${JSON.stringify(secrets)}`]);
      writeFileSync(path.join(secrets, "empty_key"), "");
      writeFileSync(path.join(secrets, "blank_key"), " ".repeat(16) + "\n");
      writeFileSync(path.join(secrets, "real_key"), "x".repeat(48));

      const harness = (name: string) => `
        set -eu
        ROOT=${JSON.stringify(dir)}
        MIN_SECRET_BYTES=16
        ${shellFunction(firstRun, "verify_secret")}
        verify_secret ${name} "left alone"
      `;
      const empty = sh(harness("empty_key"));
      assert.equal(empty.code, 1, `an empty secret file was accepted: ${empty.out}`);
      assert.match(empty.out, /at least 16 are required/);

      // Seventeen bytes on disk, none of them a secret: refused here, as the service
      // refuses to start on it.
      const blank = sh(harness("blank_key"));
      assert.equal(blank.code, 1, `a whitespace-only secret file was accepted: ${blank.out}`);

      const good = sh(harness("real_key"));
      assert.equal(good.code, 0, good.out);
      assert.match(good.out, /48 bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the rate-bucket prune ────────────────────────────────────────────────────

describe("the rate buckets are pruned", () => {
  let fixture: Fixture;
  let db: Db;
  const config = (name: string): Config => ({
    apiHost: "prune.invalid",
    publicOrigin: "https://prune.invalid",
    challengeKey: Buffer.from("a-challenge-key-that-is-long-enough", "utf8"),
    readOnly: false,
    logDir: null,
    welcomeSpace: null,
    db: {
      host: "127.0.0.1",
      port: Number(process.env.TEST_DB_PORT ?? 5439),
      database: name,
      username: "schellingaf_api",
      password: "test_api_password_not_a_secret",
    },
  });

  before(async () => {
    fixture = await cloneDatabase("prune");
    db = openDb(config(fixture.name));
  });
  after(async () => {
    await db.end();
    await fixture.end();
  });

  /** A bucket nobody has touched for the given number of days. */
  async function stale(key: string, days: number): Promise<void> {
    await fixture.owner`
      insert into schellingaf.rate_buckets (key, tokens, updated_at)
           values (${key}, 1, now() - ${`${days} days`}::interval)
      on conflict (key) do update set updated_at = excluded.updated_at`;
  }
  const count = async () =>
    (
      await fixture.owner<{ n: number }[]>`select count(*)::int as n from schellingaf.rate_buckets`
    )[0]!.n;
  /** A prune of the test's own. The boot prune the first test starts goes on to its later
   * deletes after the buckets are gone, each under the lock, and a prune that meets it
   * then is busy: a success in the service, and a failed test once in a few runs. */
  async function pruneOnce(): Promise<Awaited<ReturnType<typeof prune>>> {
    for (let i = 0; i < 100; i++) {
      const result = await prune(db);
      if (result.state !== "busy") return result;
      await new Promise((r) => setTimeout(r, 20));
    }
    return prune(db);
  }

  test("the first prune happens at boot, not an hour later", async () => {
    // setInterval does not fire at zero, so a process restarting more often than
    // hourly (a crash loop, a redeploy) would never prune at all.
    await stale("key:boot:0:0:0:0::/64", 3);
    assert.ok((await count()) > 0);
    const timer = startPrune(db, 3_600_000);
    try {
      for (let i = 0; i < 50 && (await count()) > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(await count(), 0, "nothing was pruned in the first second of the service's life");
    } finally {
      clearInterval(timer);
    }
  });

  test("a bucket somebody is still using is left alone", async () => {
    await stale("key:fresh:0:0:0:0::/64", 0);
    const result = await pruneOnce();
    assert.deepEqual(result, { state: "pruned", buckets: 0, tokens: 0, apps: 0, messages: 0, files: 0, offers: 0 });
    assert.equal(await count(), 1);
  });

  test("a token dead for ninety days is deleted, and nothing still of use is", async () => {
    // Registration writes a token for a caller holding no KEY yet. An expired or
    // revoked token authorises nothing; its row still holds its challenge's nonce,
    // and a challenge lasts five minutes, so ninety days past death is long past
    // replay.
    const [peer] = await fixture.owner<{ id: Buffer }[]>`
      select schellingaf.register_peer(${randomBytes(32)}) as id`;
    const token = async (label: string, expires: string, revoked: string | null) => {
      await fixture.owner`
        insert into schellingaf.tokens (token_hash, peer_id, challenge_nonce, label, expires_at, revoked_at)
        values (${randomBytes(32)}, ${peer!.id}, ${randomBytes(16)}, ${label},
                now() + ${expires}::interval, now() + ${revoked}::interval)`;
    };
    await token("expired long ago", "-91 days", null);
    await token("revoked long ago", "30 days", "-91 days");
    await token("expired yesterday", "-1 day", null);
    await token("revoked a minute ago", "30 days", "-1 minute");
    await token("live", "30 days", null);

    const result = await pruneOnce();
    assert.equal(result.state, "pruned");
    assert.equal(result.state === "pruned" ? result.tokens : -1, 2);
    const left = await fixture.owner<{ label: string }[]>`
      select label from schellingaf.tokens where peer_id = ${peer!.id} order by label`;
    assert.deepEqual(
      left.map((r) => r.label),
      ["expired yesterday", "live", "revoked a minute ago"],
      "the prune deleted a token that still guards its challenge, or kept one that guards nothing",
    );
  });

  test("the dead tokens are found through their own index, never by reading every token", async () => {
    // A token is written for every registration and every connection, so reading them
    // all each hour would one day pass the five-second limit and fail every hour. The
    // condition is read out of prune_tokens itself, so this cannot pass on a paraphrase
    // of it, and planned with table scans switched off, so it says whether an index can
    // serve it at all rather than which plan this tiny table gets.
    const [def] = await fixture.owner<{ src: string }[]>`
      select pg_get_functiondef('schellingaf.prune_tokens'::regproc) as src`;
    const where = /DELETE FROM tokens t\s+WHERE (.+?);/s.exec(def!.src)?.[1];
    assert.ok(where, `prune_tokens no longer reads as it did:\n${def!.src}`);
    const plan = await fixture.owner.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      const rows = (await tx.unsafe(`explain delete from schellingaf.tokens t where ${where}`)) as unknown as { "QUERY PLAN": string }[];
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    assert.match(plan, /tokens_dead_idx/, `the hourly delete of dead tokens reads every token:\n${plan}`);
  });

  test("two processes do not prune at the same moment", async () => {
    // A second replica may run beside this one, and prune_rate_buckets is an
    // unindexed full-table DELETE. pg_try_advisory_xact_lock refuses rather than
    // queueing, which is the right answer: somebody else is already doing it.
    const other = postgres({
      host: "127.0.0.1",
      port: Number(process.env.TEST_DB_PORT ?? 5439),
      database: fixture.name,
      username: "schellingaf_api",
      password: "test_api_password_not_a_secret",
      max: 1,
      onnotice: () => {},
    });
    try {
      await stale("key:contended:0:0:0:0::/64", 3);
      const held = await new Promise<() => void>((resolve) => {
        void other.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(903551101)`;
          await new Promise<void>((release) => resolve(release));
        });
      });
      const result = await prune(db);
      held();
      assert.deepEqual(result, { state: "busy" }, "both processes ran the same DELETE");
      assert.ok((await count()) > 0, "the stale bucket was deleted by the process that was busy");
    } finally {
      await other.end({ timeout: 5 });
      await fixture.owner`delete from schellingaf.rate_buckets`;
    }
  });
});

// ── configuration an operator can get wrong ─────────────────────────────────

describe("configuration read the way an operator writes it", () => {
  for (const [what, value] of [
    ["seventeen spaces", " ".repeat(17)],
    ["sixteen tabs", "\t".repeat(16)],
    ["a short key wrapped in spaces", "   short-key   "],
  ] as const) {
    test(`an inline CHALLENGE_KEY of ${what} is refused, as the file branch refuses it`, () => {
      const { error } = loadWith({ CHALLENGE_KEY: value });
      assert.ok(error, `CHALLENGE_KEY=${JSON.stringify(value)} started the service`);
    });
  }

  test("and a real inline key with whitespace around it is accepted", () => {
    const { config, error } = loadWith({ CHALLENGE_KEY: "  a-challenge-key-that-is-long-enough  " });
    assert.equal(error, null, String(error));
    assert.equal(config!.challengeKey.toString(), "a-challenge-key-that-is-long-enough");
  });

  test("a number an operator writes is its default whenever it cannot be read as one", async () => {
    // A bare Number() reads "256M" as NaN, and NaN compares false against
    // everything, so a limit read that way becomes no limit at all.
    const name = "SCHELLINGAF_TEST_NUMBER";
    const read = (value: string | undefined, opts?: { min?: number; integer?: boolean }) =>
      withEnv({ [name]: value }, () => envNumber(name, 7, opts));
    for (const value of [undefined, "", "   ", "lots", "256M", "NaN", "Infinity", "-Infinity"]) {
      assert.equal(await read(value), 7, `${name}=${JSON.stringify(value)}`);
    }
    assert.equal(await read("12"), 12);
    assert.equal(await read(" 12 "), 12);
    assert.equal(await read("0"), 0);
    assert.equal(await read("-1"), -1);
    assert.equal(await read("2.5"), 2.5);
    assert.equal(await read("-1", { min: 0 }), 7, "below min");
    assert.equal(await read("0", { min: 0 }), 0, "min is inclusive");
    assert.equal(await read("2.5", { integer: true }), 7, "not whole");
    assert.equal(await read("3", { min: 1, integer: true }), 3);
  });

  test("LOG_DIR still set to the shipped placeholder refuses to start", () => {
    const { error } = loadWith({ LOG_DIR: "REPLACE_WITH_LOG_DIR" });
    assert.ok(error, "the placeholder log directory was accepted");
    assert.match(error!.message, /placeholder/);
  });

  test("and so does a relative LOG_DIR, which would land inside the container", () => {
    const { error } = loadWith({ LOG_DIR: "var/log/schellingaf" });
    assert.ok(error, "a relative log directory was accepted");
    assert.match(error!.message, /absolute/);
  });

  test("an absolute LOG_DIR is taken as given, and an unset one means no log", () => {
    assert.equal(loadWith({ LOG_DIR: "/var/log/schellingaf" }).config?.logDir, "/var/log/schellingaf");
    assert.equal(loadWith({ LOG_DIR: undefined }).config?.logDir, null);
  });

  for (const unset of [undefined, "", "   "]) {
    test(`the deployed configuration refuses to start with LOG_DIR=${JSON.stringify(unset)}, saying what it holds`, () => {
      // Without it the service runs with no restore check, no checkpoint log, no
      // request log and no disk in its health check, and says nothing.
      const { error } = loadWith({ LOG_DIR: unset, REQUIRE_APPROVED_COPY: "1", OPERATOR_CONTACT: "abuse@example.test" });
      assert.ok(error, "the deployed configuration started with no log directory");
      assert.match(error!.message, /LOG_DIR is not set/);
      assert.match(error!.message, /restore check/);
      assert.match(error!.message, /persists across restarts and deploys/);
    });
  }

  test("and with LOG_DIR named, that refusal is gone", () => {
    const { error } = loadWith({ LOG_DIR: "/var/log/schellingaf", REQUIRE_APPROVED_COPY: "1", OPERATOR_CONTACT: "abuse@example.test" });
    assert.doesNotMatch(String(error?.message), /LOG_DIR/);
  });

  // This gate shares its flag parser with READ_ONLY, so every spelling READ_ONLY
  // accepts is asserted here too. Read as on, it turns on the deployed
  // configuration's checks, and one of them refuses to start here: the service's
  // signing key, which is never made on a development machine.
  for (const on of ["1", "true", "yes", "on", "TRUE", " On "]) {
    test(`REQUIRE_APPROVED_COPY=${JSON.stringify(on)} enforces the deployed configuration`, () => {
      const { error } = loadWith({ REQUIRE_APPROVED_COPY: on, OPERATOR_CONTACT: "abuse@example.test", LOG_DIR: "/var/log/schellingaf" });
      assert.ok(error, `REQUIRE_APPROVED_COPY=${JSON.stringify(on)} started as a development service`);
      assert.match(error!.message, /not been approved|records no approval|SERVICE_KEY_FILE and SERVICE_CERTIFICATE_FILE are missing/);
    });
  }

  for (const off of ["0", "false", "no", "off", ""]) {
    test(`REQUIRE_APPROVED_COPY=${JSON.stringify(off)} leaves it off`, () => {
      const { error } = loadWith({ REQUIRE_APPROVED_COPY: off });
      assert.equal(error, null, String(error));
    });
  }

  test("and a value it cannot read refuses to start rather than guessing off", () => {
    const { error } = loadWith({ REQUIRE_APPROVED_COPY: "maybe", OPERATOR_CONTACT: "abuse@example.test" });
    assert.ok(error, "an unreadable gate value started the service");
    assert.match(error!.message, /neither on nor off/);
  });

  // A passkey is bound to its relying party for good, so a wrong value here is a
  // service whose every passkey prompt fails, or one that checks a party no page
  // uses. Refused at startup rather than discovered by the first person.
  test("passkeys are off unless both passkey settings are given, and on with both", () => {
    const off = loadWith({ PASSKEY_RP_ID: undefined, PASSKEY_ORIGINS: undefined });
    assert.equal(off.error, null, String(off.error));
    assert.equal(off.config!.passkeys, null);
    const on = loadWith({ PASSKEY_RP_ID: "schellingaf.com", PASSKEY_ORIGINS: "https://schellingaf.com, https://www.schellingaf.com" });
    assert.equal(on.error, null, String(on.error));
    assert.deepEqual(on.config!.passkeys, {
      rpId: "schellingaf.com",
      origins: ["https://schellingaf.com", "https://www.schellingaf.com"],
    });
    const local = loadWith({ PASSKEY_RP_ID: "localhost", PASSKEY_ORIGINS: "http://localhost:8787" });
    assert.equal(local.error, null, String(local.error));
  });

  for (const [what, extra, message] of [
    ["one without the other", { PASSKEY_RP_ID: "schellingaf.com", PASSKEY_ORIGINS: undefined }, /together or not at all/],
    ["an origin on another domain", { PASSKEY_RP_ID: "schellingaf.com", PASSKEY_ORIGINS: "https://schellingaf.com.evil.test" }, /not schellingaf.com or a subdomain/],
    ["plain http off this machine", { PASSKEY_RP_ID: "schellingaf.com", PASSKEY_ORIGINS: "http://schellingaf.com" }, /https unless/],
    ["an origin with a path", { PASSKEY_RP_ID: "schellingaf.com", PASSKEY_ORIGINS: "https://schellingaf.com/sign-in" }, /no path/],
    ["a relying party id with a scheme", { PASSKEY_RP_ID: "https://schellingaf.com", PASSKEY_ORIGINS: "https://schellingaf.com" }, /not a lowercase host name/],
    ["an IP address as the relying party", { PASSKEY_RP_ID: "127.0.0.1", PASSKEY_ORIGINS: "http://127.0.0.1:8787" }, /not an IP address/],
  ] as const) {
    test(`passkey settings with ${what} refuse to start`, () => {
      const { error } = loadWith(extra);
      assert.ok(error, `${what} started the service`);
      assert.match(error!.message, message);
    });
  }
});

// ── free space, watched from inside the service ─────────────────────────────

describe("the health check reports a disk that is nearly full", () => {
  // The outside monitor polls the health check, so it answers 503 when the request
  // log's disk, which in the deployed stack is the backup disk, is nearly full,
  // even while the backup container and its own hourly check are stopped.

  const healthConfig = (logDir: string | null, database: Config["db"]): Config => ({
    apiHost: "health.invalid",
    publicOrigin: "https://health.invalid",
    challengeKey: Buffer.from("a-challenge-key-that-is-long-enough"),
    readOnly: false,
    logDir,
    welcomeSpace: null,
    db: database,
  });

  async function healthWith(threshold: string | undefined, logDir: string | null) {
    return withEnv({ HEALTH_MIN_FREE_PCT: threshold }, async () => {
      const fixture = await cloneDatabase("health");
      const config = healthConfig(logDir, { host: "127.0.0.1", port: PORT, database: fixture.name, username: "schellingaf_api", password: API_PASSWORD });
      const db = openDb(config);
      try {
        const res = await createApp(config, db).request("/healthz");
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      } finally {
        await db.end();
        await fixture.end();
      }
    });
  }

  test("a disk below the threshold turns the health check into a 503 that says why", async () => {
    // No test machine has a nearly full disk on demand, so the threshold moves
    // instead: at 101% every disk is below it.
    const dir = mkdtempSync(path.join(tmpdir(), "health-"));
    try {
      const out = await healthWith("101", dir);
      assert.equal(out.status, 503, JSON.stringify(out.body));
      assert.match(String(out.body.reason), /% free/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ordinary disk is healthy, and with no request log there is nothing to watch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "health-"));
    try {
      assert.equal((await healthWith(undefined, dir)).status, 200);
      assert.equal((await healthWith("101", null)).status, 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database that does not answer is a 503 that says so, not a 500 for the check itself", async () => {
    // The check's own shape is {ok: false}; a 500 INTERNAL would say the check
    // itself had failed.
    const down = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    const app = createApp(
      healthConfig(null, { host: "127.0.0.1", port: 1, database: "unused", username: "unused", password: "unused" }),
      { read: () => Promise.reject(down), write: () => Promise.reject(down) } as unknown as Db,
    );
    const saved = console.error;
    console.error = () => {};
    try {
      const res = await app.request("/healthz");
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false, reason: "the database does not answer" });
    } finally {
      console.error = saved;
    }
  });
});
