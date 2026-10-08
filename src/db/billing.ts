// The shadow bill: once a UTC day, what each SPACE over its free allowance would be
// billed for the bytes it stores, recorded and logged, and nothing taken.
//
// At boot and hourly, a tick looks for a day to bill. The days are UTC dates made here,
// from getUTC* only, and passed to SQL, which never reads now() for a day. The first is
// the oldest day begun and not finished, else the day after the latest finished, else, on
// the very first run, yesterday alone: never the days since launch. Days missed while the
// service was down are billed in order, each at the measure taken now; a day finished
// already is skipped. Before it bills its first open day, a tick recounts what every SPACE
// stores (src/db/storage.ts) and reconciles every credit balance with its ledger, unless
// that day has its recount recorded (billing_runs.recounted_at); it records it once both
// ran. So both run at most once for a day, and a day begun by a tick that died before
// them still gets them. A day that keeps failing is billed again without them, and its
// line says null for both.
//
// Each day is begun, its SPACES over their allowance billed one transaction each, then
// finished with its summary. Only the call that finishes a day logs its line, one JSON
// object on stdout with no SPACE's name or id in it: the measurement this release exists
// to take. A crash leaves the day begun; the next tick does it again, and every step is
// idempotent.
//
// Two processes: the run takes a session advisory lock, which spans the many transactions
// a run is made of, and a process that cannot take it has nothing to do. The lock is
// released when the run ends, and with its connection if the process dies.
//
// A later release bills for real. Its bill locks the SPACE's credit row before it takes
// least(due, balance), and takes its rates from constants in SQL, not from parameters the
// api role passes.

import type { Db } from "./sql.ts";
import { FUNDING, type Funding } from "../surface/vocabulary.ts";
import { recountStorage, stdoutLine, type Recount } from "./storage.ts";

/**
 * The advisory lock key. Arbitrary and stable; advisory locks share one namespace across
 * the database, beside the prune's 903_551_101 and the checkpoints' 903_551_207.
 */
export const BILLING_LOCK = 903_551_301;

/** Candidates asked for at a time. */
const PAGE = 1000;

const VISIBILITY = ["public", "private", "sealed"] as const;

type Figures = {
  allowance_bytes: number;
  spaces: number;
  over: number;
  billable_bytes: number;
  max_billable_bytes: number;
  /** SPACES of this visibility holding more than each of FUNDING.spacesOverBytes, keyed by the size. */
  spaces_over: Record<string, number>;
  over_bytes: number;
  due_micro_usd: number;
};

/** The line a billed day logs, keys in this order. */
export type DayLine = {
  event: "billing.day";
  day: string;
  mode: "shadow";
  measured_at: string;
  rate: { micro_usd_per_gb_month: number; days_per_month: number; bytes_per_gb: number };
  visibility: Record<(typeof VISIBILITY)[number], Figures>;
  skipped: { fault: number; failed: number };
  /** null when this tick did not reconcile: its first open day had its recount recorded already. */
  faults_held: number | null;
  /** null when this tick did not recount: its first open day had its recount recorded already. */
  recount: Recount | null;
};

/** What one tick did. busy: another process holds the run. idle: no day to bill. */
export type BillingResult = { state: "busy" } | { state: "idle" } | { state: "billed"; days: string[] };

/** A UTC date, YYYY-MM-DD, from getUTC* only. */
export function utcDate(at: Date): string {
  const y = String(at.getUTCFullYear()).padStart(4, "0");
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The UTC date `n` days after `day`. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return utcDate(new Date(Date.UTC(y, m - 1, d + n)));
}

/** Bill every day that is due, once, under the lock. */
export async function billOnce(
  db: Db,
  options: { now?: Date; funding?: Funding; log?: (line: string) => void } = {},
): Promise<BillingResult> {
  const now = options.now ?? new Date();
  const funding = options.funding ?? FUNDING;
  const log = options.log ?? stdoutLine;
  const conn = await db.write.reserve();
  try {
    const [lock] = await conn<{ held: boolean }[]>`select pg_try_advisory_lock(${BILLING_LOCK}) as held`;
    if (lock?.held !== true) return { state: "busy" };
    try {
      const yesterday = addDays(utcDate(now), -1);
      const [next] = await db.write<{ day: string | null }[]>`select schellingaf.billing_next_day()::text as day`;
      const first = next?.day ?? yesterday;
      if (first > yesterday) return { state: "idle" };

      let recount: Recount | null = null;
      let faultsHeld: number | null = null;
      const days: string[] = [];
      for (let day = first; day <= yesterday; day = addDays(day, 1)) {
        const [begun] = await db.write<{ state: "begun" | "open" | "finished"; recounted: boolean }[]>`
          select state, recounted from schellingaf.billing_day_begin(${day}::date)`;
        if (begun?.state === "finished") continue;
        if (days.length === 0 && begun?.recounted !== true) {
          recount = await recountStorage(db, log);
          const [held] = await db.write<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
          faultsHeld = held?.n ?? 0;
          await db.write`select schellingaf.billing_day_recounted(${day}::date)`;
        }
        await billDay(db, day, funding, recount, faultsHeld, log);
        days.push(day);
      }
      return { state: "billed", days };
    } finally {
      await conn`select pg_advisory_unlock(${BILLING_LOCK})`;
    }
  } finally {
    conn.release();
  }
}

/** Bills one begun day that is not finished, and logs it if this call finishes it. */
async function billDay(db: Db, day: string, funding: Funding, recount: Recount | null, faultsHeld: number | null, log: (line: string) => void) {
  const a = funding.allowanceBytes;
  const measuredAt = new Date().toISOString();
  const skipped = { fault: 0, failed: 0 };
  let after: string | null = null;
  for (;;) {
    const rows: { ids: string[] }[] = await db.write<{ ids: string[] }[]>`
      select schellingaf.bill_candidates(${day}::date, ${after}::uuid, ${PAGE}, ${a.public}, ${a.private}, ${a.sealed})::text[] as ids`;
    const ids: string[] = rows[0]?.ids ?? [];
    for (const id of ids) {
      try {
        const [bill] = await db.write<{ state: string }[]>`
          select schellingaf.bill_space_day(${id}::uuid, ${day}::date, ${a.public}, ${a.private}, ${a.sealed},
                                            ${funding.microUsdPerGbMonth}, ${funding.daysPerMonth}, ${funding.bytesPerGb}, true) as state`;
        if (bill?.state === "fault") skipped.fault++;
      } catch (error) {
        skipped.failed++;
        process.stderr.write(`billing ${day} for SPACE ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (ids.length < PAGE) break;
    after = ids[ids.length - 1]!;
  }
  const [summary] = await db.write<{ s: Record<string, Record<string, unknown>> }[]>`
    select schellingaf.billing_summary(${day}::date, ${a.public}, ${a.private}, ${a.sealed}, ${[...funding.spacesOverBytes]}::bigint[]) as s`;
  const figures = (v: (typeof VISIBILITY)[number]): Figures => {
    const f = summary?.s?.[v] ?? {};
    const n = (key: string) => Number(f[key] ?? 0);
    const over = (f["spaces_over"] ?? {}) as unknown as Record<string, number | string>;
    return {
      allowance_bytes: a[v],
      spaces: n("spaces"),
      over: n("over"),
      billable_bytes: n("billable_bytes"),
      max_billable_bytes: n("max_billable_bytes"),
      spaces_over: Object.fromEntries(funding.spacesOverBytes.map((size) => [String(size), Number(over[String(size)] ?? 0)])),
      over_bytes: n("over_bytes"),
      due_micro_usd: n("due_micro_usd"),
    };
  };
  const line: DayLine = {
    event: "billing.day",
    day,
    mode: "shadow",
    measured_at: measuredAt,
    rate: { micro_usd_per_gb_month: funding.microUsdPerGbMonth, days_per_month: funding.daysPerMonth, bytes_per_gb: funding.bytesPerGb },
    visibility: { public: figures("public"), private: figures("private"), sealed: figures("sealed") },
    skipped,
    faults_held: faultsHeld,
    recount,
  };
  const [finished] = await db.write<{ done: boolean }[]>`
    select schellingaf.billing_day_finish(${day}::date, ${db.write.json(line)}) as done`;
  if (finished?.done === true) log(JSON.stringify(line));
}

/**
 * Bill now, and every hour after.
 *
 * A failure is written to stderr and not thrown: a bill that cannot be measured is worth
 * knowing about and not worth stopping the service for. Returns the timer, unref'd, so it
 * never holds the process open by itself.
 */
export function startBilling(db: Db, everyMs = 3_600_000): NodeJS.Timeout {
  const run = () => {
    void billOnce(db).catch((error: unknown) => {
      process.stderr.write(`billing failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}
