// The dry run of the real bill, on a restored copy of the database and never on the
// service's own. It refuses a database host that is not this machine, port 5439 (the
// service's own), a DB_PORT or DB_NAME not given, and a database without the mark the
// restore drill writes on the copy it restores (scripts/restore-drill.sh). As the owner
// role it sets billing_epoch.real_from to two days before the database's today and the mode
// to real, runs the billing job's tick twice, on the database's clock, and checks that the second wrote no bill row and no ledger entry and
// that every balance still matches its ledger. Then it prints counts only: each day's line,
// the SPACES given free days by visibility, the SPACES over their allowance by visibility,
// the frozen SPACES and the notices delivered. No SPACE's name or id. Exits 1 when a check
// fails.
//
//   DB_HOST=127.0.0.1 DB_PORT=<port> DB_NAME=<the restored copy> node scripts/billing-dry-run.ts
//
// The login is the migration login, as every operator script's (scripts/lib/db.ts).

import postgres from "postgres";
import { billOnce } from "../src/db/billing.ts";
import type { Db } from "../src/db/sql.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The comment scripts/restore-drill.sh writes on the database of the copy it restored. */
export const DRILL_MARK = "schellingaf restore drill copy";

/** The service's own port, which the dry run never bills. */
const SERVICE_PORT = 5439;

export type DryRun = { ok: boolean; failures: string[]; report: Record<string, unknown> };

/** Whether a database host is this machine. */
export function loopback(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/**
 * Why the dry run may not run against this environment, or null when it may: DB_HOST on
 * this machine, DB_PORT and DB_NAME given, and DB_PORT not the service's own.
 */
export function refusal(env: Record<string, string | undefined>): string | null {
  const host = env.DB_HOST ?? "127.0.0.1";
  if (!loopback(host)) return `DB_HOST is ${host}. The dry run bills a restored copy on this machine only.`;
  if (!env.DB_PORT || !env.DB_NAME) return "DB_PORT and DB_NAME name the restored copy, and have no default.";
  if (Number(env.DB_PORT) === SERVICE_PORT) return `DB_PORT is ${SERVICE_PORT}, the service's own database. The dry run bills a restored copy only.`;
  return null;
}

/** Whether the database `sql` reaches carries the restore drill's mark. */
export async function marked(sql: postgres.Sql): Promise<boolean> {
  const [row] = await sql<{ c: string | null }[]>`
    select shobj_description(d.oid, 'pg_database') as c from pg_database d where d.datname = current_database()`;
  return row?.c === DRILL_MARK;
}

/**
 * The dry run on `sql`, a pool acting as the owner role with room for the job's reserved
 * connection, on a database the restore drill marked. The days are the database's.
 */
export async function dryRun(sql: postgres.Sql): Promise<DryRun> {
  if (!(await marked(sql))) {
    return { ok: false, failures: ["the database has no restore drill mark: it is not a copy scripts/restore-drill.sh restored"], report: {} };
  }
  const failures: string[] = [];
  const lines: string[] = [];
  await sql`update schellingaf.billing_epoch set real_from = schellingaf.billing_today() - 2, mode = 'real', mode_at = now()`;
  const counts = async () => (await sql<{ bills: number; entries: number }[]>`
    select (select count(*)::int from schellingaf.space_bills) as bills,
           (select count(*)::int from schellingaf.credit_ledger) as entries`)[0]!;
  const db = { write: sql } as unknown as Db;
  const first = await billOnce(db, { log: (line) => lines.push(line) });
  const after = await counts();
  const second = await billOnce(db, { log: (line) => lines.push(line) });
  const again = await counts();
  if (again.bills !== after.bills) failures.push(`the second tick wrote ${again.bills - after.bills} bill rows`);
  if (again.entries !== after.entries) failures.push(`the second tick wrote ${again.entries - after.entries} ledger entries`);
  const [faults] = await sql<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
  if (faults!.n !== 0) failures.push(`${faults!.n} balances disagree with their ledger`);
  const byVisibility = (rows: { visibility: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.visibility, r.n]));
  const free = await sql<{ visibility: string; n: number }[]>`
    select s.visibility, count(*)::int as n from schellingaf.space_credit c join schellingaf.spaces s on s.space_id = c.space_id
     where c.free_until is not null group by s.visibility order by 1`;
  const over = await sql<{ visibility: string; n: number }[]>`
    select s.visibility, count(*)::int as n from schellingaf.spaces s
     where schellingaf.space_billable_bytes(s.space_id) > schellingaf.space_allowance(s.visibility) group by s.visibility order by 1`;
  const [state] = await sql<{ frozen: number; low: number; read_only: number }[]>`
    select (select count(*)::int from schellingaf.space_credit where frozen) as frozen,
           (select count(*)::int from schellingaf.mailbox_deliveries where credit_notice = 'low') as low,
           (select count(*)::int from schellingaf.mailbox_deliveries where credit_notice = 'read_only') as read_only`;
  return {
    ok: failures.length === 0,
    failures,
    report: {
      ticks: [first, second],
      lines: lines.map((l) => JSON.parse(l)).filter((l) => l.event !== "storage.recount"),
      recount_corrections: lines.filter((l) => l.includes('"storage.recount"')).length,
      free_days: byVisibility(free),
      over_allowance: byVisibility(over),
      frozen: state!.frozen,
      notices_delivered: { low: state!.low, read_only: state!.read_only },
    },
  };
}

if (import.meta.main) {
  const refused = refusal(process.env);
  if (refused !== null) {
    process.stderr.write(`${refused}\n`);
    process.exit(1);
  }
  const sql = postgres({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME!,
    username: process.env.DB_USER ?? "schellingaf_migrate",
    password: process.env.DB_PASSWORD ?? "test_migrate_password_not_a_secret",
    max: 4,
    onnotice: () => {},
    // Every connection acts as the owner role, the job's reserved one included.
    connection: { role: "schellingaf_owner" } as unknown as Record<string, string>,
  });
  try {
    const out = await dryRun(sql);
    process.stdout.write(`${JSON.stringify(out.report, null, 2)}\n`);
    for (const f of out.failures) process.stderr.write(`FAIL ${f}\n`);
    process.exitCode = out.ok ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
