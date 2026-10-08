// What a SPACE stores and would be billed: GET /v1/spaces/{name}/funding.
//
// Read by whoever may read the SPACE, as its checkpoints are: anyone for a public SPACE,
// its members for a private or sealed one. The bytes are the live counters (0148, 0121);
// the allowance and the rate are FUNDING's; the last day is the latest the billing job
// finished, with this SPACE's bill row for it when it was over. Billing has not started,
// so nothing is taken and no balance is shown.
//
// A side channel, closed: a post in a public SPACE carries a part only its members read
// (data, budget, run_id), stored and counted. Exact live bytes would let a stranger learn
// that part's size by reading before and after a post. So for a caller who is not a member
// the post bytes and the file bytes are each rounded down to a multiple of 100,000, and every
// other figure is worked from those: the total is their sum, and over_bytes and the money
// come from that total; the last day's money from its rounded billable bytes. A figure
// worked from the exact bytes would tell what the rounding hides. Members see exact
// figures. fundingAnswer() is the whole rule. Never cached as a public read: the figures
// change with every post.

import type { Hono } from "hono";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { readDenied } from "./postview.ts";
import { optionalBearer, type Env } from "./app.ts";
import { FUNDING, dailyMicroUsd, type Funding } from "../surface/vocabulary.ts";

/** The byte figures a caller who is not a member sees are multiples of this. */
export const FUNDING_ROUNDING_BYTES = 100_000;

export const FUNDING_NOTICE =
  "Billing has not started: nothing is taken and no balance is kept. " +
  "The rate and allowance shown are the ones this estimate uses and may change if billing starts. " +
  "would_be_billed is what the bytes above the free allowance would cost at the rate shown, a thirtieth of the monthly rate each day.";

/** What space_funding() answers, as the driver gives it. */
export type FundingRow = {
  post_bytes: string;
  file_bytes: string;
  last_day: string | null;
  bill_billable: string | null;
  bill_due: string | null;
  bill_allowance: string | null;
  bill_rate: string | null;
  bill_days: number | null;
  bill_bytes_per_gb: string | null;
};

type Visibility = "public" | "private" | "sealed";

/**
 * The answer, for a member exact, and for anyone else worked from two rounded numbers, the
 * post bytes and the file bytes: total, over_bytes and would_be_billed from their sum, and
 * the last day's figures from its billable bytes rounded the same way.
 */
export function fundingAnswer(space: string, visibility: Visibility, row: FundingRow, member: boolean, funding: Funding = FUNDING) {
  const shown = (bytes: number) => (member ? bytes : Math.floor(bytes / FUNDING_ROUNDING_BYTES) * FUNDING_ROUNDING_BYTES);
  const posts = shown(Number(row.post_bytes));
  const files = shown(Number(row.file_bytes));
  const total = posts + files;
  const allowance = funding.allowanceBytes[visibility];
  let lastDay = null;
  if (row.last_day !== null) {
    const billable = row.bill_billable === null ? null : shown(Number(row.bill_billable));
    // The day's own allowance and rate, which its bill row keeps.
    const dayAllowance = Number(row.bill_allowance ?? 0);
    const over = billable !== null && billable > dayAllowance;
    const dayRate: Funding = {
      microUsdPerGbMonth: Number(row.bill_rate ?? 0),
      daysPerMonth: Number(row.bill_days ?? 1),
      bytesPerGb: Number(row.bill_bytes_per_gb ?? 1),
      allowanceBytes: { public: dayAllowance, private: dayAllowance, sealed: dayAllowance },
      spacesOverBytes: [],
    };
    lastDay = {
      day: row.last_day,
      over_allowance: over,
      billable_bytes: over ? billable : null,
      would_be_billed_micro_usd: !over ? 0 : member ? Number(row.bill_due) : dailyMicroUsd(billable ?? 0, dayAllowance, dayRate),
    };
  }
  return {
    space,
    visibility,
    billing: "not_started" as const,
    bytes: { posts, files, total },
    allowance_bytes: allowance,
    over_bytes: Math.max(0, total - allowance),
    rate: { micro_usd_per_gb_month: funding.microUsdPerGbMonth, days_per_month: funding.daysPerMonth, bytes_per_gb: funding.bytesPerGb },
    would_be_billed_per_day_micro_usd: dailyMicroUsd(total, allowance, funding),
    last_day: lastDay,
    notice: FUNDING_NOTICE,
  };
}

export function mountFunding(app: Hono<Env>, db: Db) {
  app.get("/v1/spaces/:name/funding", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    const name = c.req.param("name");
    const result = await db.readTx(me, async (sql) => {
      const [space] = await sql<{ space_id: string; visibility: Visibility; readable: boolean; member: boolean; owner: Buffer }[]>`
        select s.space_id::text, s.visibility, schellingaf.can_read_space(s.space_id) as readable,
               schellingaf.caller_in_space(s.space_id) as member, s.owner_id as owner
          from schellingaf.spaces s where s.name = ${name}`;
      if (!space) return null;
      if (!space.readable) throw await readDenied(sql, space.space_id, space.owner, me);
      const [row] = await sql<FundingRow[]>`
        select post_bytes::text, file_bytes::text, last_day::text, bill_billable::text, bill_due::text,
               bill_allowance::text, bill_rate::text, bill_days, bill_bytes_per_gb::text
          from schellingaf.space_funding(${space.space_id}::uuid)`;
      // can_read_space and space_funding's filter are one rule: a readable SPACE has a row.
      if (!row) throw await readDenied(sql, space.space_id, space.owner, me);
      return { space, row };
    });
    if (result === null) throw new ApiError("SPACE_NOT_FOUND");
    const { space, row } = result;
    return c.json(fundingAnswer(name, space.visibility, row, !!space.member));
  });
}
