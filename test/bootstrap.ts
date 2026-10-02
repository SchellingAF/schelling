// Brings up the local database and prepares one migrated template.
//
// Every test file then clones that template into a database of its own, so a
// test never sees another test's rows and no test has to clean up after itself.
// Cloning a template is a file copy inside Postgres; migrating once and cloning
// is far cheaper than migrating per file.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { migrate } from "../src/db/migrate.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TEMPLATE_DB = "schellingaf_tmpl";
export const PORT = Number(process.env.TEST_DB_PORT ?? 5439);

export const SUPERUSER = {
  host: "127.0.0.1",
  port: PORT,
  username: "postgres",
  password: "test_superuser_password_not_a_secret",
  database: "postgres",
  max: 1,
  onnotice: () => {},
};

// The suite registers hundreds of KEYS from one in-process caller with no
// address, so they all share the `ip:unattributable` bucket — a shape no real
// deployment has. The limit itself is tested in identity.test.ts, which sets
// these back down.
process.env.REGISTRATION_BURST ??= "100000";
process.env.CHALLENGE_PER_KEY ??= "100000";
// The same for apps: the suite registers apps and sends requests to connect them
// from that one caller, far more of both than one real address ever does.
process.env.APP_REGISTRATION_BURST ??= "100000";
process.env.APP_REGISTRATION_NETWORK_BURST ??= "100000";
process.env.APP_CONNECTION_BURST ??= "100000";
process.env.APP_CONNECTION_NETWORK_BURST ??= "100000";

export const API_PASSWORD = "test_api_password_not_a_secret";
export const MIGRATE_PASSWORD = "test_migrate_password_not_a_secret";

export async function bootstrap(): Promise<void> {
  execFileSync("docker", ["compose", "-f", "compose.test.yml", "up", "-d", "--wait"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  const admin = postgres(SUPERUSER);
  try {
    // Drop and recreate so the template always matches the migrations on disk.
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity
       where datname = '${TEMPLATE_DB}' and pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`drop database if exists ${TEMPLATE_DB}`);
    await admin.unsafe(`create database ${TEMPLATE_DB} owner schellingaf_owner`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  await migrate({
    host: "127.0.0.1",
    port: PORT,
    database: TEMPLATE_DB,
    username: "schellingaf_migrate",
    password: MIGRATE_PASSWORD,
    max: 1,
    onnotice: () => {},
  });

  process.stdout.write(`template ${TEMPLATE_DB} ready on port ${PORT}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await bootstrap();
}
