// The service's numbers: how many KEYS, SPACES, posts, tasks, findings and direct
// messages there are, and how many of each were made in the last seven days; and the
// deposits confirmed, the US dollars they credited, the SPACES funded and the deposits
// pending (migrations/0153_funding_reads.sql).
//
// The same for every caller, so it needs no KEY. The count is service_numbers()
// (migrations/0117_numbers.sql), a definer's function that answers totals alone: the
// api role still reads no private SPACE's rows, and nothing here names a SPACE, a KEY
// or a line anybody wrote. The answer is built from a fixed list of figures below, so
// a field the database added would not reach a caller unless this file named it.
//
// Counted at most once an hour, by one query per process, as the category counts are
// taken once a minute (categories.ts): the last count is served while a new one runs,
// unless it is over two hours old, when the caller waits for the new one; after a
// failure the last count is served whatever its age. A failed count is tried again in
// five seconds while there is no count yet, and in ten minutes once there is one, so a
// count that keeps failing (past the timeout below, at tens of millions of posts) never
// keeps the posts table scanning for whoever polls. So the answer costs one query an
// hour however many ask, and nobody can see a change finer than the hourly count.
// Before the first count has ever been made, BUSY.
//
// Unlike the categories, it is an ordinary read: inside the gate and counted against
// the caller's read ceilings, like every other read a stranger makes. Asked with no
// token, it is public to caches for a minute (publicRead in app.ts).

import type { Hono } from "hono";
import type { Env } from "./app.ts";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";

/** How often the numbers may be counted again, and after a count that failed: soon
 *  while nobody has a count, and not for ten minutes once a count is held. */
export const COUNT_EVERY_MS = 3_600_000;
const RETRY_AFTER_FAILURE_MS = 5_000;
export const RETRY_AFTER_FAILURE_WITH_COUNT_MS = 600_000;
/** How long the count may run, against the five seconds every other read has. */
const COUNT_TIMEOUT = "30s";

/** The figures each group holds, in the order the answer gives them. */
const KEY_FIGURES = ["all", "ed25519", "passkey"] as const;
const SPACE_FIGURES = ["all", "public", "private", "sealed", "work", "oracle", "open"] as const;
const POST_FIGURES = ["all", "in_public_spaces", "in_private_spaces", "in_sealed_spaces"] as const;
const MESSAGE_FIGURES = ["conversations", "messages", "sealed_messages"] as const;

type Pair = { total: number; last_7_days: number };
export type Numbers = {
  counted_at: string;
  keys: Record<(typeof KEY_FIGURES)[number], Pair> & { active_last_7_days: number };
  spaces: Record<(typeof SPACE_FIGURES)[number], Pair>;
  posts: Record<(typeof POST_FIGURES)[number], Pair>;
  tasks: Pair;
  findings: Pair;
  direct_messages: Record<(typeof MESSAGE_FIGURES)[number], Pair>;
  funding: { deposits: Pair; credited_micro_usd: Pair; spaces_funded: number; pending: number };
};

/** A count, or 0 where the database gave none. */
const whole = (n: unknown): number => (Number.isSafeInteger(n) ? (n as number) : 0);
const pair = (p: any): Pair => ({ total: whole(p?.total), last_7_days: whole(p?.last_7_days) });
const group = <K extends string>(g: any, names: readonly K[]): Record<K, Pair> =>
  Object.fromEntries(names.map((name) => [name, pair(g?.[name])])) as Record<K, Pair>;

/** What service_numbers() answered, as the answer gives it: every figure named, in order, and nothing else. */
export function shapeNumbers(raw: any): Numbers {
  return {
    counted_at: new Date(raw.counted_at).toISOString(),
    keys: { ...group(raw.keys, KEY_FIGURES), active_last_7_days: whole(raw.keys?.active_last_7_days) },
    spaces: group(raw.spaces, SPACE_FIGURES),
    posts: group(raw.posts, POST_FIGURES),
    tasks: pair(raw.tasks),
    findings: pair(raw.findings),
    direct_messages: group(raw.direct_messages, MESSAGE_FIGURES),
    funding: {
      deposits: pair(raw.funding?.deposits),
      credited_micro_usd: pair(raw.funding?.credited_micro_usd),
      spaces_funded: whole(raw.funding?.spaces_funded),
      pending: whole(raw.funding?.pending),
    },
  };
}

function numbersCounter(db: Db): () => Promise<Numbers> {
  let snapshot: Numbers | null = null;
  let running: Promise<void> | null = null;
  let startedAt = 0;

  async function take(): Promise<void> {
    const [row] = await db.readTx(null, async (sql) => {
      // The count reads every row of posts twice, which took 0.7 s at a million posts
      // (migrations/0117_numbers.sql), so the api role's five seconds would end it at
      // a few million. Once an hour it may take longer, in this transaction alone.
      await sql`select set_config('statement_timeout', ${COUNT_TIMEOUT}, true)`;
      return sql<{ numbers: unknown }[]>`select schellingaf.service_numbers() as numbers`;
    });
    snapshot = shapeNumbers(row!.numbers);
  }

  return async () => {
    if (running === null && Date.now() - startedAt >= COUNT_EVERY_MS) {
      startedAt = Date.now();
      running = take()
        .catch((error: unknown) => {
          // Logged like any other failure the service did not expect, and never thrown
          // at a caller while an older count can still answer, which then stands for
          // ten minutes before the next try.
          console.error(`service numbers not counted: ${(error as Error)?.message ?? String(error)}`);
          const wait = snapshot === null ? RETRY_AFTER_FAILURE_MS : RETRY_AFTER_FAILURE_WITH_COUNT_MS;
          startedAt = Date.now() - COUNT_EVERY_MS + wait;
        })
        .finally(() => {
          running = null;
        });
    }
    const stale = snapshot === null || Date.now() - Date.parse(snapshot.counted_at) > 2 * COUNT_EVERY_MS;
    if (stale && running !== null) await running;
    if (snapshot === null) throw new ApiError("BUSY", { retryAfter: 5 });
    return snapshot;
  };
}

export function mountNumbers(app: Hono<Env>, db: Db): void {
  const counter = numbersCounter(db);
  app.get("/v1/numbers", async (c) => {
    const numbers = await counter();
    // The same answer whoever asks; app.ts makes it public to caches when no token came.
    c.set("publicRead", true);
    return c.json(numbers);
  });
}
