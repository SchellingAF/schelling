// The wait at start, for the database and for the schema this code carries.
//
// A platform may start the service before its database answers, and starts the
// service and the migration runner from the same release in no particular order.
// So the service waits, for a bounded time, until the database answers and has
// every migration in migrations/ applied, rather than failing on its first query;
// the migration runner waits for the database alone, since applying them is its
// job. Each says every ten seconds what it is waiting for, and refuses to start
// at the deadline.

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { Config } from "../config.ts";

/** migrations/ beside src/, in a checkout and in the image alike. */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export type MigrationFile = { version: number; name: string; file: string };

/**
 * Every migration file, in version order. A file not named NNNN_lower_snake_case.sql
 * is refused, because its place in the order would be undefined, and so are two
 * files with one version.
 */
export function migrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const out: MigrationFile[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(`migration file ${file} is not named NNNN_lower_snake_case.sql, so its order is undefined`);
    }
    out.push({ version: Number(match[1]), name: match[2]!, file });
  }
  const seen = new Set<number>();
  for (const m of out) {
    if (seen.has(m.version)) throw new Error(`two migrations share version ${m.version}`);
    seen.add(m.version);
  }
  return out;
}

/**
 * The first migration this code carries that the database has not applied, or
 * null when it has them all. Version numbers only: the runner is what checks an
 * applied file's checksum. A version applied and not carried here is a later
 * release's, and does not hold the start, so a release rolled back still starts.
 */
export function missingMigration(files: readonly MigrationFile[], applied: readonly number[]): MigrationFile | null {
  const have = new Set(applied);
  return files.find((f) => !have.has(f.version)) ?? null;
}

export type WaitOptions = {
  /** How long to wait in all, in seconds; 0 checks once. */
  seconds: number;
  /** The database's host:port, named in what is written. */
  target: string;
  /** The migrations that must be applied before this returns. Absent, it waits
   * only for the database to answer, as the migration runner does. */
  migrations?: readonly MigrationFile[];
  /** How often a line says what is being waited for, in seconds. */
  reportEverySeconds?: number;
  write?: (line: string) => void;
};

type Waiting = { for: "database"; error: unknown } | { for: "migration"; missing: MigrationFile; error: unknown };

async function check(sql: postgres.Sql, migrations: readonly MigrationFile[] | undefined): Promise<Waiting | null> {
  try {
    await sql`select 1`;
  } catch (error) {
    return { for: "database", error };
  }
  if (migrations === undefined || migrations.length === 0) return null;
  let applied: number[];
  try {
    applied = (await sql<{ version: number }[]>`select version from schellingaf.schema_migrations`).map((r) => r.version);
  } catch (error) {
    // No ledger yet, because the runner has not reached this database, or none this
    // role may read, because the runner that grants it has not run: either way the
    // schema is not one this code can start on.
    return { for: "migration", missing: migrations[0]!, error };
  }
  const missing = missingMigration(migrations, applied);
  return missing === null ? null : { for: "migration", missing, error: null };
}

function waitingFor(waiting: Waiting, target: string): string {
  if (waiting.for === "database") return `the database at ${target} to answer`;
  return `migration ${String(waiting.missing.version).padStart(4, "0")} (${waiting.missing.file}) in the database at ${target}`;
}

function refusal(waiting: Waiting, options: WaitOptions): string {
  if (waiting.for === "database") {
    return `database did not accept a connection within ${options.seconds}s: ${String(waiting.error)}`;
  }
  return (
    `the database at ${options.target} did not have migration ${String(waiting.missing.version).padStart(4, "0")} ` +
    `(${waiting.missing.file}) within ${options.seconds}s, and this code needs every migration it carries. ` +
    "Run the migration runner, node src/db/migrate.ts, against that database" +
    (waiting.error ? `: ${String(waiting.error)}` : ".")
  );
}

/**
 * Returns once the database answers and, given `migrations`, has every one of them
 * applied. Until then it tries every half second, writes a line every
 * `reportEverySeconds` saying what it waits for, and past `seconds` throws an error
 * whose message says what never arrived.
 */
export async function waitForDatabase(sql: postgres.Sql, options: WaitOptions): Promise<void> {
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const started = Date.now();
  const deadline = started + options.seconds * 1000;
  const every = (options.reportEverySeconds ?? 10) * 1000;
  let reported = started;
  for (;;) {
    const waiting = await check(sql, options.migrations);
    if (waiting === null) return;
    const now = Date.now();
    if (now >= deadline) throw new Error(refusal(waiting, options));
    if (now - reported >= every) {
      reported = now;
      const detail = waiting.error ? `: ${String(waiting.error)}` : "";
      write(`waiting for ${waitingFor(waiting, options.target)} (${Math.round((now - started) / 1000)}s of ${options.seconds}s)${detail}\n`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * The service's wait, before anything else it sends: on a connection of its own,
 * so attempts at a database that is not there yet leave nothing in the service's
 * pools, and with a short connect timeout, so a database that does not answer at
 * all is still reported every ten seconds.
 */
export async function waitForSchema(db: Config["db"], seconds: number): Promise<void> {
  const sql = postgres({
    host: db.host,
    port: db.port,
    database: db.database,
    username: db.username,
    password: db.password,
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    await waitForDatabase(sql, { seconds, target: `${db.host}:${db.port}`, migrations: migrationFiles() });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
