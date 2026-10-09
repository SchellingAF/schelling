// The bill: once a UTC day, every SPACE over its free allowance is billed for the bytes it
// stores, from its payer's balance (migrations/0155_billing_real.sql). Days before
// billing_epoch.real_from are shadow rows that take nothing, as release 1 wrote them.
// BILLING=shadow (src/config.ts), written to billing_epoch.mode at boot, makes every later
// day a shadow row too; days billed in shadow are never charged afterwards. A set BILLING
// is written again at the top of every tick, and a tick that cannot write it bills nothing:
// a bill never runs on a mode the operator did not ask for. Unset, the database's mode stands.
//
// At boot and hourly, a tick first sweeps the credit rows that are frozen or carry a
// notice (credit_sweep()), so a SPACE whose bytes fell under what its balance pays opens
// within the hour. Then it looks for a day to bill. The days are UTC dates; yesterday is the
// database's (billing_today()), unless a test passes now. The first is the oldest day begun and not finished, else
// the day after the latest finished, else, on the very first run, yesterday alone: never
// the days since launch. Days missed while the service was down are billed in order, each
// at the measure taken now; a day finished already is skipped. Before it bills its first
// open day, a tick recounts what every SPACE stores (src/db/storage.ts) and reconciles
// every credit balance with its ledger, unless that day has its recount recorded
// (billing_runs.recounted_at); it records it once both ran. So both run at most once for a
// day, and a day begun by a tick that died before them still gets them. A day that keeps
// failing is billed again without them, and its line says null for both.
//
// Each day is begun, its SPACES over their allowance billed one transaction each, then
// finished with its summary, unless a bill failed: then the day stays open, the days after
// it are still billed, and each later tick bills what is left of it first. The rates are SQL's (billing_rates()), never passed from here.
// A bill that delivers a notice wakes each recipient's mailbox once it has committed. Only
// the call that finishes a day logs its line, one JSON object on stdout with no SPACE's name
// or id in it. A crash leaves the day begun; the next tick does it again, and every step is
// idempotent.
//
// Two processes: the run takes a session advisory lock, which spans the many transactions
// a run is made of, and a process that cannot take it has nothing to do. The lock is
// released when the run ends, and with its connection if the process dies.

import type { Db } from "./sql.ts";
import type { BillingMode } from "../config.ts";
import { FUNDING } from "../surface/vocabulary.ts";
import { recountStorage, stdoutLine, type Recount } from "./storage.ts";
import { wakeHeads } from "../http/wait.ts";
import { publishChange } from "../mcp/listen.ts";

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
  /** What the day's bills took from balances. */
  taken_micro_usd: number;
  /** The day's bills that were free days. */
  free: number;
  /** The day's real bills that could not take their whole due. */
  short: number;
  /** SPACES of this visibility whose credit is frozen now. */
  read_only: number;
};

/** The line a billed day logs, keys in this order. */
export type DayLine = {
  event: "billing.day";
  day: string;
  /** How the day was billed: shadow before real_from or while BILLING is shadow. */
  mode: "real" | "shadow";
  measured_at: string;
  rate: { micro_usd_per_gb_month: number; days_per_month: number; bytes_per_gb: number };
  visibility: Record<(typeof VISIBILITY)[number], Figures>;
  /**
   * fault: the payer's balance disagrees with its ledger; closed: not billed (closed by the
   * operator, or withheld); no_payer: a replaced SPACE whose payer was made after the day
   * ended; failed: an error, which leaves the day open.
   */
  skipped: { fault: number; closed: number; no_payer: number; failed: number };
  /** The notices the day's bills delivered, by kind, counting SPACES, not recipients. */
  notices: { low: number; read_only: number };
  /** null when this tick did not reconcile: its first open day had its recount recorded already. */
  faults_held: number | null;
  /** null when this tick did not recount: its first open day had its recount recorded already. */
  recount: Recount | null;
};

/**
 * What one tick did. busy: another process holds the run. idle: no day to bill. billed: the
 * days it billed, and `open`, present only when one is, the days a failed bill left open.
 */
export type BillingResult = { state: "busy" } | { state: "idle" } | { state: "billed"; days: string[]; open?: string[] };

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

/**
 * Write BILLING again when it is set, sweep the flagged credit rows, then bill every day
 * that is due, once, under the lock. A mode that cannot be written throws before anything
 * is billed.
 */
export async function billOnce(
  db: Db,
  options: { now?: Date; log?: (line: string) => void; mode?: BillingMode | null } = {},
): Promise<BillingResult> {
  const log = options.log ?? stdoutLine;
  const conn = await db.write.reserve();
  try {
    const [lock] = await conn<{ held: boolean }[]>`select pg_try_advisory_lock(${BILLING_LOCK}) as held`;
    if (lock?.held !== true) return { state: "busy" };
    try {
      if (options.mode != null) {
        try {
          await setBillingMode(db, options.mode);
        } catch (error) {
          throw new Error(
            `BILLING=${options.mode} could not be written, so nothing was billed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const [swept] = await db.write<{ s: { unfrozen: number; notices_reset: number } }[]>`select schellingaf.credit_sweep() as s`;
      const sweep = { unfrozen: Number(swept?.s?.unfrozen ?? 0), notices_reset: Number(swept?.s?.notices_reset ?? 0) };
      if (sweep.unfrozen > 0 || sweep.notices_reset > 0) log(JSON.stringify({ event: "billing.sweep", ...sweep }));

      const yesterday = options.now !== undefined
        ? addDays(utcDate(options.now), -1)
        : (await db.write<{ day: string }[]>`select (schellingaf.billing_today() - 1)::text as day`)[0]!.day;
      const [next] = await db.write<{ day: string | null }[]>`select schellingaf.billing_next_day()::text as day`;
      const first = next?.day ?? yesterday;
      if (first > yesterday) return { state: "idle" };

      let recount: Recount | null = null;
      let faultsHeld: number | null = null;
      const days: string[] = [];
      const open: string[] = [];
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
        if (!(await billDay(db, day, recount, faultsHeld, log))) open.push(day);
        days.push(day);
      }
      return open.length > 0 ? { state: "billed", days, open } : { state: "billed", days };
    } finally {
      await conn`select pg_advisory_unlock(${BILLING_LOCK})`;
    }
  } finally {
    conn.release();
  }
}

type Rates = {
  micro_usd_per_gb_month: string; days_per_month: number; bytes_per_gb: string;
  public_bytes: string; private_bytes: string; sealed_bytes: string;
};

/** Wakes whoever waits on the mailboxes a committed bill delivered to. */
function wake(delivered: { recipient: string; mailbox_seq: string }[]): void {
  wakeHeads(delivered.map((d) => ({ stream: "mailbox" as const, peer: d.recipient, mailbox_seq: d.mailbox_seq })));
  for (const d of delivered) publishChange({ kind: "mailbox", peer: d.recipient });
}

/**
 * Bills one begun day that is not finished, and logs it if this call finishes it. A day
 * with a failed bill is not finished: false, and the next tick bills what is left of it.
 */
async function billDay(db: Db, day: string, recount: Recount | null, faultsHeld: number | null, log: (line: string) => void): Promise<boolean> {
  const measuredAt = new Date().toISOString();
  const [mode] = await db.write<{ m: "real" | "shadow" }[]>`select schellingaf.billing_day_mode(${day}::date) as m`;
  const [rates] = await db.write<Rates[]>`
    select micro_usd_per_gb_month::text, days_per_month, bytes_per_gb::text, public_bytes::text, private_bytes::text, sealed_bytes::text
      from schellingaf.billing_rates()`;
  const allowance = { public: Number(rates!.public_bytes), private: Number(rates!.private_bytes), sealed: Number(rates!.sealed_bytes) };
  const skipped = { fault: 0, closed: 0, no_payer: 0, failed: 0 };
  const notices = { low: 0, read_only: 0 };
  let after: string | null = null;
  for (;;) {
    const rows: { ids: string[] }[] = await db.write<{ ids: string[] }[]>`
      select schellingaf.bill_candidates(${day}::date, ${after}::uuid, ${PAGE})::text[] as ids`;
    const ids: string[] = rows[0]?.ids ?? [];
    for (const id of ids) {
      try {
        const [bill] = await db.write<{ state: string; delivered: { recipient: string; mailbox_seq: string }[] }[]>`
          select state, delivered from schellingaf.bill_space_day(${id}::uuid, ${day}::date)`;
        if (bill?.state === "fault") skipped.fault++;
        if (bill?.state === "closed") skipped.closed++;
        if (bill?.state === "no_payer") skipped.no_payer++;
        const delivered = bill?.delivered ?? [];
        if (delivered.length > 0) {
          if (bill?.state === "short") notices.read_only++;
          else notices.low++;
          wake(delivered);
        }
      } catch (error) {
        skipped.failed++;
        process.stderr.write(`billing ${day} for SPACE ${id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (ids.length < PAGE) break;
    after = ids[ids.length - 1]!;
  }
  if (skipped.failed > 0) {
    process.stderr.write(`billing ${day} left open: ${skipped.failed} bills failed; the next tick bills the rest\n`);
    return false;
  }
  const [summary] = await db.write<{ s: Record<string, Record<string, unknown>> }[]>`
    select schellingaf.billing_summary(${day}::date, ${[...FUNDING.spacesOverBytes]}::bigint[]) as s`;
  const figures = (v: (typeof VISIBILITY)[number]): Figures => {
    const f = summary?.s?.[v] ?? {};
    const n = (key: string) => Number(f[key] ?? 0);
    const over = (f["spaces_over"] ?? {}) as unknown as Record<string, number | string>;
    return {
      allowance_bytes: allowance[v],
      spaces: n("spaces"),
      over: n("over"),
      billable_bytes: n("billable_bytes"),
      max_billable_bytes: n("max_billable_bytes"),
      spaces_over: Object.fromEntries(FUNDING.spacesOverBytes.map((size) => [String(size), Number(over[String(size)] ?? 0)])),
      over_bytes: n("over_bytes"),
      due_micro_usd: n("due_micro_usd"),
      taken_micro_usd: n("taken_micro_usd"),
      free: n("free"),
      short: n("short"),
      read_only: n("read_only"),
    };
  };
  const line: DayLine = {
    event: "billing.day",
    day,
    mode: mode?.m === "real" ? "real" : "shadow",
    measured_at: measuredAt,
    rate: {
      micro_usd_per_gb_month: Number(rates!.micro_usd_per_gb_month),
      days_per_month: rates!.days_per_month,
      bytes_per_gb: Number(rates!.bytes_per_gb),
    },
    visibility: { public: figures("public"), private: figures("private"), sealed: figures("sealed") },
    skipped,
    notices,
    faults_held: faultsHeld,
    recount,
  };
  const [finished] = await db.write<{ done: boolean }[]>`
    select schellingaf.billing_day_finish(${day}::date, ${db.write.json(line)}) as done`;
  if (finished?.done === true) log(JSON.stringify(line));
  return true;
}

/**
 * Writes BILLING to the database (billing_epoch.mode), which the bill and enforcement
 * read, or with null reads the mode there, and answers the start's billing.config line:
 * the mode and the first day billed for real.
 */
export async function setBillingMode(db: Db, mode: BillingMode | null): Promise<string> {
  const [row] = await db.write<{ mode: BillingMode; real_from: string }[]>`
    select mode, real_from::text from schellingaf.billing_set_mode(${mode})`;
  return JSON.stringify({ event: "billing.config", mode: row!.mode, real_from: row!.real_from });
}

/**
 * Bill now, and every hour after.
 *
 * A failure is written to stderr and not thrown: a bill that cannot be measured is worth
 * knowing about and not worth stopping the service for. Returns the timer, unref'd, so it
 * never holds the process open by itself.
 */
export function startBilling(db: Db, mode: BillingMode | null, everyMs = 3_600_000): NodeJS.Timeout {
  const run = () => {
    void billOnce(db, { mode }).catch((error: unknown) => {
      process.stderr.write(`billing failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return timer;
}
