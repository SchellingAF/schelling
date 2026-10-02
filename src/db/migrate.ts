// The migration runner: numbered SQL files, applied once, in order, under one
// lock, with a checksum that refuses an applied file that changed.
//
// It connects as schellingaf_migrate and immediately assumes schellingaf_owner,
// so every object in the schema ends up owned by the owner role and the api
// role never holds rights it should not.

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { envNumber } from "../config.ts";
import { MIGRATIONS_DIR, migrationFiles, waitForDatabase } from "./wait.ts";

// One number, chosen once, never changed: two runners on the same database must
// pick the same lock or the lock is decoration.
const ADVISORY_LOCK = 7213001;

type Migration = {
  version: number;
  name: string;
  file: string;
  sql: string;
  sha256: string;
  noTransaction: boolean;
};

export type MigrateResult = {
  applied: Migration[];
  skipped: number;
};

function readSecret(value: string | undefined, fileVar: string | undefined): string {
  // Read synchronously at startup: a process that cannot read its secret should
  // fail before it opens a socket, not on the first request.
  if (fileVar) return readFileSync(fileVar, "utf8").trim();
  if (value === undefined || value === "" || value.startsWith("REPLACE_WITH_")) {
    throw new Error(
      "database password is missing or still a placeholder. Set MIGRATE_DB_PASSWORD or MIGRATE_DB_PASSWORD_FILE.",
    );
  }
  return value;
}

export function connectionOptions(): postgres.Options<Record<string, never>> {
  const password = readSecret(
    process.env.MIGRATE_DB_PASSWORD,
    process.env.MIGRATE_DB_PASSWORD_FILE,
  );
  return {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5439),
    database: process.env.DB_NAME ?? "schellingaf",
    username: process.env.MIGRATE_DB_USER ?? "schellingaf_migrate",
    password,
    max: 1,
    // The runner talks to a database that may still be starting.
    connect_timeout: 10,
    onnotice: () => {},
  };
}

/**
 * A no-transaction file's statements, to be sent one at a time: PostgreSQL runs a
 * message of several statements as one transaction block, which CREATE INDEX
 * CONCURRENTLY refuses. Such a file holds plain statements, each ending with a semicolon
 * at the end of a line, and no function body, whose semicolons are its own. A piece that
 * is only comments is no statement.
 */
export function statementsOf(sql: string): string[] {
  if (sql.includes("$$")) throw new Error("a no-transaction migration holds no function body");
  return sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.replace(/^\s*--.*$/gm, "").trim() !== "");
}

async function loadMigrations(): Promise<Migration[]> {
  const out: Migration[] = [];
  for (const { version, name, file } of migrationFiles()) {
    const raw = await readFile(path.join(MIGRATIONS_DIR, file));
    const sql = raw.toString("utf8");
    out.push({
      version,
      name,
      file,
      sql,
      // The checksum covers the raw bytes, not the parsed text: a change in
      // line endings is still a change.
      sha256: createHash("sha256").update(raw).digest("hex"),
      noTransaction: sql.startsWith("-- migrate: no-transaction"),
    });
  }
  return out;
}

export async function migrate(
  options?: postgres.Options<Record<string, never>>,
): Promise<MigrateResult> {
  const resolved = options ?? connectionOptions();
  const sql = postgres(resolved);
  try {
    return await run(sql, `${resolved.host ?? "127.0.0.1"}:${resolved.port ?? 5432}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function run(sql: postgres.Sql, target: string): Promise<MigrateResult> {
  // The database alone: the schema is what this applies. 30 seconds unless
  // DB_WAIT_SECONDS says otherwise, for a platform that starts this before the
  // database answers.
  await waitForDatabase(sql, { seconds: envNumber("DB_WAIT_SECONDS", 30, { min: 0 }), target });

  // Everything happens on one reserved connection: a session-level advisory
  // lock and SET ROLE both belong to a session, and a pool would scatter them.
  const c = await sql.reserve();
  try {
    await c`select pg_advisory_lock(${ADVISORY_LOCK})`;
    await c`set role schellingaf_owner`;

    await c`create schema if not exists schellingaf`;
    await c`
      create table if not exists schellingaf.schema_migrations (
        version    int  primary key,
        name       text not null,
        sha256     text not null,
        applied_at timestamptz not null default now()
      )`;
    // The service's own read of this ledger, which lets it wait at start for the
    // schema it carries (db/wait.ts), is granted by migrations/0112_start_checks.sql,
    // where every grant the api role holds is written.

    const applied = await c<{ version: number; name: string; sha256: string }[]>`
      select version, name, sha256 from schellingaf.schema_migrations order by version`;
    const byVersion = new Map(applied.map((row) => [row.version, row]));

    const migrations = await loadMigrations();
    // A new file is always numbered above the first, so a ledger version below the
    // first file here comes from a history these files replaced, and applying them
    // would build the schema a second time: that database is refused by name. A
    // version above the first with no file here is a later release's, or another
    // branch's. That database is ahead of this checkout, not from another history,
    // so the version is left alone and a release that was rolled back still starts.
    const first = migrations[0]?.version ?? 0;
    const replaced = applied.filter((row) => row.version < first).map((row) => row.version);
    if (replaced.length > 0) {
      throw new Error(
        `this database was built from migrations that are no longer in migrations/ ` +
          `(versions ${replaced.join(", ")}): rebuild it`,
      );
    }
    const ran: Migration[] = [];
    let skipped = 0;

    for (const m of migrations) {
      const previous = byVersion.get(m.version);
      if (previous) {
        if (previous.sha256 !== m.sha256) {
          throw new Error(
            `migration ${m.file} has changed since it was applied.\n` +
              `  applied: ${previous.sha256}\n  on disk: ${m.sha256}\n` +
              `An applied migration is history. Write a new numbered file instead.`,
          );
        }
        skipped++;
        continue;
      }

      if (m.noTransaction) {
        // For CREATE INDEX CONCURRENTLY and anything else Postgres refuses to
        // run inside a transaction, one statement at a time. The row is written
        // after the file, so a crash mid-file leaves the migration unrecorded and
        // retryable, and such a file is written to run again from the start.
        for (const statement of statementsOf(m.sql)) await c.unsafe(statement);
        await c`
          insert into schellingaf.schema_migrations (version, name, sha256)
          values (${m.version}, ${m.name}, ${m.sha256})`;
      } else {
        // Explicit transaction control: a reserved connection has no .begin(),
        // and the whole point of reserving one is that the lock, the role and
        // the transaction all belong to the same session.
        await c.unsafe("begin");
        try {
          await c.unsafe(m.sql);
          await c`
            insert into schellingaf.schema_migrations (version, name, sha256)
            values (${m.version}, ${m.name}, ${m.sha256})`;
          await c.unsafe("commit");
        } catch (error) {
          await c.unsafe("rollback");
          throw error;
        }
      }
      ran.push(m);
      process.stdout.write(`applied ${m.file}\n`);
    }

    return { applied: ran, skipped };
  } finally {
    // Releasing the connection drops the session lock with it.
    c.release();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = await migrate();
    const total = result.applied.length;
    process.stdout.write(
      total === 0
        ? `nothing to apply; ${result.skipped} migration${result.skipped === 1 ? "" : "s"} already in place\n`
        : `${total} migration${total === 1 ? "" : "s"} applied, ${result.skipped} already in place\n`,
    );
  } catch (error) {
    process.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
