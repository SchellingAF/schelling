// A SPACE's funding: GET /v1/spaces/{name}/funding, its deposit addresses, the coins it
// takes, its balance and deposits, what it stores, what a day costs, the days left and
// whether it is read-only; and its credit entries, GET /v1/spaces/{name}/funding/history. A SPACE's deposit address for a coin:
// POST /v1/spaces/{name}/funding/addresses, below. And the provider's callback when a
// deposit arrives: POST /funding/cryptapi/..., at the end.
//
// Who reads what. The deposit addresses and the coins are for anyone, a private or sealed
// SPACE's too: an address is public, and pays only into the SPACE, or, once the SPACE is
// replaced, into the end of its replaced_by chain, which credited_to names. The coins, 98 of
// them, come only with ?coins=true, as most reads do not need them. Everything else is read
// by whoever may read the SPACE, as its checkpoints are: anyone for a public SPACE, its
// members for a private or sealed one. A caller who is not a member of a private or sealed
// SPACE is answered the addresses alone, with members_only naming what it is not shown;
// the history refuses it. A withheld SPACE is refused to everyone. The bytes are the live
// counters (0148, 0121, 0154); the allowance and the rate are FUNDING's, which SQL's
// billing_rates() holds equal; the last day is the latest the billing job finished, with
// this SPACE's bill row for it when it was over. The balance and the deposits are 0153's
// reads. Storage over the allowance is billed each UTC day from billing_from (0155), and
// at zero a SPACE is read-only (0157); space_funding() (0158) says where billing stands,
// what a day costs and whether the SPACE is read-only.
//
// A side channel, closed: a post in a public SPACE carries a part only its members read
// (data, budget, run_id), stored and counted. Exact live bytes would let a stranger learn
// that part's size by reading before and after a post. So for a caller who is not a member
// the post bytes and the file bytes are each rounded down to a multiple of 100,000, and every
// other figure is worked from those: the total is their sum, and over_bytes and the money
// come from that total; the last day's money from its rounded billable bytes. A figure
// worked from the exact bytes would tell what the rounding hides. Once bills are taken, an
// exact balance or bill tells the bytes to about 6 KB a day, so to a caller who is not a
// member the balance is rounded down to the cent and each bill or adjustment taken toward
// zero to the cent; a deposit stays exact, being public on its chain. Members see exact figures.
// fundingAnswer() and fundingFigures() are the whole rule. Never cached as a public read:
// the figures change with every post.

import type { Hono } from "hono";
import type { Db } from "../db/sql.ts";
import type { Config } from "../config.ts";
import { ApiError, toApiError } from "../db/errors.ts";
import { cursor, readDenied } from "./postview.ts";
import { optionalBearer, requireBearer, type Env } from "./app.ts";
import { OWN, SHARED, giveBack, spend } from "./ratelimit.ts";
import { toHex } from "../domain/keys.ts";
import { asObject, parseStrictJson, queryFlag } from "../domain/validate.ts";
import { FUNDING, dailyMicroUsd, type Funding } from "../surface/vocabulary.ts";
import { COINS, COINS_AS_OF, COIN_FAMILIES, coinByCallbackCoin, coinByTicker, type Coin } from "../funding/coins.ts";
import { depositsOpen, type FundingConfig } from "../funding/config.ts";
import { callbackMac, callbackUrl } from "../funding/callback-url.ts";
import { createAddress } from "../funding/cryptapi.ts";
import { bodyLimit } from "hono/body-limit";
import { CALLBACK_BYTES, CALLBACK_PREFIX, MalformedCallback, creditOf, parseCallback, signedBy, type Callback } from "../funding/callback.ts";
import { decimalText, type Decimal } from "../funding/decimal.ts";

/** The byte figures a caller who is not a member sees are multiples of this. */
export const FUNDING_ROUNDING_BYTES = 100_000;

/** The money a caller who is not a member sees, but for deposits, is in whole cents. */
export const FUNDING_ROUNDING_MICRO = 10_000;

/** Where billing stands: before billing_from, billing, or switched off by the operator. */
export type BillingState = "not_started" | "started" | "paused";

/** The second sentence of the notice while billing is or will be on: the read-only rule. */
const READ_ONLY_NOTICE =
  "A SPACE over its free allowance is read-only at zero credit, or once a day's bill could not be paid in full, until credit pays a day or it is back within its allowance. Read-only means everything can be read, nothing is deleted, and nothing new is stored. ";

/** What every notice says of deposits. */
const DEPOSIT_TERMS_NOTICE =
  "Deposits are credited in US dollars once confirmed: USDT, USDC, USDC.e, USDT0, DAI and PYUSD one for one, other coins at the provider's price, after its fee and the network's. " +
  "Credit is not refundable and cannot move to another SPACE.";

/** The notice of a SPACE billed now. */
export const FUNDING_NOTICE = "Storage over the allowance is billed each UTC day from the balance, at the rate shown. " + READ_ONLY_NOTICE + DEPOSIT_TERMS_NOTICE;

/** The notice before billing_from. */
export const NOT_STARTED_NOTICE = (billingFrom: string): string => `Billing starts on ${billingFrom}: nothing is taken before then. ${READ_ONLY_NOTICE}${DEPOSIT_TERMS_NOTICE}`;

/** The notice while the operator has billing off. */
export const PAUSED_NOTICE = "Billing is paused: nothing is taken from the balance, and no SPACE is read-only. " + DEPOSIT_TERMS_NOTICE;

/** The notice of a replaced SPACE: its storage is billed to `credited`, the end of its replaced_by chain, and its deposits credit it. */
export const REPLACED_NOTICE = (credited: string): string =>
  `This SPACE was replaced. Its storage is billed to [${credited}], and deposits to these addresses credit [${credited}], in US dollars once confirmed: USDT, USDC, USDC.e, USDT0, DAI and PYUSD one for one, other coins at the provider's price, after its fee and the network's. Credit is not refundable.`;

/** Where a SPACE's deposits are credited: null while it is not replaced. */
export type CreditedTo = { space_id: string; name: string } | null;

/** Where billing stands and from which day, as billing_state() answers it. */
export type Billing = { state: BillingState; from: string };

/** The notice every funding.get answer ends with. */
export function fundingNotice(creditedTo: CreditedTo, billing: Billing): string {
  if (creditedTo !== null) return REPLACED_NOTICE(creditedTo.name);
  if (billing.state === "paused") return PAUSED_NOTICE;
  return billing.state === "not_started" ? NOT_STARTED_NOTICE(billing.from) : FUNDING_NOTICE;
}

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
  task_bytes: string;
  bill_taken: string | null;
  bill_free: boolean | null;
  bill_shadow: boolean | null;
  billing: BillingState;
  billing_from: string;
  free_until: string | null;
  read_only: boolean;
  read_only_since: Date | string | null;
  own_per_day: string;
  per_day: string;
  pays_for: { space: string; per_day_micro_usd: number }[];
};

type Visibility = "public" | "private" | "sealed";

/** Money a caller who is not a member sees: down to the cent, or toward zero for a bill. */
const cents = (micro: number) => Math.trunc(micro / FUNDING_ROUNDING_MICRO) * FUNDING_ROUNDING_MICRO + 0;

/**
 * The answer, for a member exact, and for anyone else worked from three rounded numbers,
 * the post, file and task bytes: total, over_bytes and what a day of its own storage costs
 * from their sum (0 while the SPACE's own day costs nothing: free days, not billed), plus
 * the SPACES it pays for, whose figures are exact (they are closed); the last day's bill
 * from its billable bytes rounded the same way, and what it took to the cent.
 */
export function fundingAnswer(space: string, visibility: Visibility, row: FundingRow, member: boolean, funding: Funding = FUNDING) {
  const shown = (bytes: number) => (member ? bytes : Math.floor(bytes / FUNDING_ROUNDING_BYTES) * FUNDING_ROUNDING_BYTES);
  const posts = shown(Number(row.post_bytes));
  const files = shown(Number(row.file_bytes));
  const tasks = shown(Number(row.task_bytes ?? 0));
  const total = posts + files + tasks;
  const allowance = funding.allowanceBytes[visibility];
  const ownExact = Number(row.own_per_day ?? 0);
  // The payer's day less its own: what the SPACES it pays for cost; 0 for a replaced SPACE.
  const others = Number(row.per_day ?? 0) - ownExact;
  const own = member || ownExact === 0 ? ownExact : dailyMicroUsd(total, allowance, funding);
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
    const billed = !over ? 0 : member ? Number(row.bill_due) : dailyMicroUsd(billable ?? 0, dayAllowance, dayRate);
    const taken = !over ? 0 : member ? Number(row.bill_taken ?? 0) : cents(Number(row.bill_taken ?? 0));
    lastDay = {
      day: row.last_day,
      over_allowance: over,
      billable_bytes: over ? billable : null,
      billed_micro_usd: billed,
      taken_micro_usd: taken,
      free: row.bill_free === true,
      shadow: row.bill_shadow === true,
      // Deprecated: 0.8's name for billed_micro_usd.
      would_be_billed_micro_usd: billed,
    };
  }
  return {
    space,
    visibility,
    billing: row.billing,
    billing_from: row.billing_from,
    bytes: { posts, files, tasks, total },
    allowance_bytes: allowance,
    over_bytes: Math.max(0, total - allowance),
    rate: { micro_usd_per_gb_month: funding.microUsdPerGbMonth, days_per_month: funding.daysPerMonth, bytes_per_gb: funding.bytesPerGb },
    free_until: row.free_until,
    per_day_micro_usd: own + others,
    ...(row.pays_for?.length ? { pays_for: row.pays_for } : {}),
    // Deprecated: 0.8's figure, what a day of these bytes over the allowance costs at the
    // rate, free days and SPACES paid for aside.
    would_be_billed_per_day_micro_usd: dailyMicroUsd(total, allowance, funding),
    last_day: lastDay,
    notice: fundingNotice(null, { state: row.billing, from: row.billing_from }),
  };
}

/** What every deposit address answer says. */
export const FUNDING_DEPOSIT_NOTICE =
  "Send only this coin on this network. Below the minimum, on another network, or a token not in coins: not credited. " +
  "Deposits are public on the blockchain. Credited once confirmed.";

/** A deposit address as the reads answer it: whether it forwards to the wallet configured now, never the wallet. */
export type AddressRow = { coin: string; family: string; address_in: string; current: boolean; created_at: Date | string };

/**
 * One deposit address as every answer shows it: the coin's table entry for what it is, and
 * whether it forwards to the wallet configured now. minimum, cheap and stable are the
 * table's, not the row's.
 */
export function addressEntry(row: AddressRow) {
  const coin = coinByTicker(row.coin);
  return {
    coin: row.coin,
    symbol: coin?.symbol ?? null,
    network: coin?.network ?? null,
    family: row.family,
    address: row.address_in,
    minimum: coin?.minimum ?? null,
    cheap: coin?.cheap ?? false,
    stable: coin?.stable ?? false,
    current: row.current,
    created_at: new Date(row.created_at).toISOString(),
  };
}

/** One coin a SPACE can be funded with on this server, as funding.get lists it. */
export function coinEntry(coin: Coin) {
  return {
    coin: coin.ticker,
    symbol: coin.symbol,
    name: coin.name,
    network: coin.network,
    family: coin.family,
    minimum: coin.minimum,
    cheap: coin.cheap,
    stable: coin.stable,
  };
}

/** The coins offered on this server now: every coin of a family with a wallet, while deposits are open; none otherwise. */
export function coinsOffered(funding: FundingConfig | undefined) {
  if (!depositsOpen(funding)) return [];
  return COINS.filter((coin) => funding.wallets[coin.family] !== undefined).map(coinEntry);
}

/** The configured wallet of each family, in COIN_FAMILIES' order, null where none: what funding_addresses_of() compares. */
export function walletsOf(funding: FundingConfig | undefined): (string | null)[] {
  return COIN_FAMILIES.map((family) => funding?.wallets[family] ?? null);
}

/**
 * What every funding.get answer carries, whoever asks: the addresses made, where their
 * deposits are credited, and how to make one. The coins and the day their minimums were
 * read only when asked for with coins=true.
 */
export type Offer = {
  deposits_open: boolean;
  addresses: ReturnType<typeof addressEntry>[];
  credited_to: CreditedTo;
  coins?: ReturnType<typeof coinEntry>[];
  minimums_as_of?: string;
  make_address: string;
};

export function offerOf(name: string, addresses: AddressRow[], funding: FundingConfig | undefined, creditedTo: CreditedTo = null, withCoins = false): Offer {
  return {
    deposits_open: depositsOpen(funding),
    addresses: addresses.map(addressEntry),
    credited_to: creditedTo,
    ...(withCoins ? { coins: coinsOffered(funding), minimums_as_of: COINS_AS_OF } : {}),
    make_address: `POST /v1/spaces/${name}/funding/addresses`,
  };
}

/** What an answer of the addresses alone leaves out. */
export const MEMBERS_ONLY = ["bytes", "balance", "deposits", "history", "read_only"] as const;

/**
 * The answer to a caller who is not a member of a private or sealed SPACE: the addresses
 * and the coins, where billing stands, and the allowance and rate, which are the service's
 * own; members_only names what it is not shown. No figure of the SPACE.
 */
export function addressesAnswer(space: string, visibility: Visibility, offer: Offer, billing: Billing, funding: Funding = FUNDING) {
  return {
    space,
    visibility,
    billing: billing.state,
    billing_from: billing.from,
    allowance_bytes: funding.allowanceBytes[visibility],
    rate: { micro_usd_per_gb_month: funding.microUsdPerGbMonth, days_per_month: funding.daysPerMonth, bytes_per_gb: funding.bytesPerGb },
    ...offer,
    members_only: [...MEMBERS_ONLY],
    notice: fundingNotice(offer.credited_to, billing),
  };
}

/** What funding_state() answers, as the driver gives it. */
export type StateRow = {
  balance_micro: string;
  pending_count: number;
  held_count: number;
  rejected_count: number;
  credited_count: number;
};

/** One deposit, as funding_deposits_of() answers it. */
export type DepositRow = {
  coin: string;
  txid_in: string;
  value_coin: string | null;
  value_forwarded_coin: string | null;
  usd_micro: string | null;
  reason: string | null;
  seen_at: Date | string;
};

/** A deposit's coin as the table spells it, base/usdc, when the table has the coin the callback named; else as the callback spelled it. */
export function depositCoin(coin: string): string {
  return coinByCallbackCoin(coin)?.ticker ?? coin;
}

const at = (t: Date | string) => new Date(t).toISOString();
const micro = (v: string | null) => (v === null ? null : Number(v));

/**
 * The whole answer, for whoever may read the SPACE: fundingAnswer()'s figures, then the
 * balance, the days it pays for at what a day costs now, whether the SPACE is read-only,
 * and the deposits not credited. days_left is worked from the figures this caller sees,
 * and is null while a day costs nothing and for a replaced SPACE, whose payer
 * credited_to names.
 */
export function fundingFigures(
  space: string,
  visibility: Visibility,
  row: FundingRow,
  member: boolean,
  offer: Offer,
  state: StateRow,
  deposits: { pending: DepositRow[]; held: DepositRow[]; rejected: DepositRow[] },
  funding: Funding = FUNDING,
) {
  const { notice, space: _s, visibility: _v, billing, billing_from, ...figures } = fundingAnswer(space, visibility, row, member, funding);
  const exact = Number(state.balance_micro);
  const balance = member ? exact : Math.floor(exact / FUNDING_ROUNDING_MICRO) * FUNDING_ROUNDING_MICRO;
  const perDay = figures.per_day_micro_usd;
  return {
    space,
    visibility,
    billing,
    billing_from,
    ...offer,
    ...figures,
    balance_micro_usd: balance,
    days_left: perDay > 0 && offer.credited_to === null ? Math.floor(balance / perDay) : null,
    read_only: row.read_only === true,
    read_only_since: row.read_only_since === null ? null : at(row.read_only_since),
    deposits: {
      pending: deposits.pending.map((d) => ({ coin: depositCoin(d.coin), txid_in: d.txid_in, value_coin: d.value_coin, seen_at: at(d.seen_at) })),
      held: deposits.held.map((d) => ({
        coin: depositCoin(d.coin), txid_in: d.txid_in, value_forwarded_coin: d.value_forwarded_coin, usd_micro: micro(d.usd_micro), reason: d.reason, seen_at: at(d.seen_at),
      })),
      rejected: deposits.rejected.map((d) => ({ coin: depositCoin(d.coin), txid_in: d.txid_in, reason: d.reason, seen_at: at(d.seen_at) })),
      pending_count: state.pending_count,
      held_count: state.held_count,
      rejected_count: state.rejected_count,
      credited_count: state.credited_count,
    },
    history: `GET /v1/spaces/${space}/funding/history`,
    notice: offer.credited_to === null ? notice : fundingNotice(offer.credited_to, { state: billing, from: billing_from }),
  };
}

/** One credit entry, as funding_history() answers it. */
export type HistoryRow = {
  entry_id: string;
  kind: string;
  amount_micro: string;
  balance_after_micro: string;
  created_at: Date | string;
  coin: string | null;
  txid_in: string | null;
  value_forwarded_coin: string | null;
  address_in: string | null;
  bill_day: string | null;
  bill_space: string | null;
};

/**
 * A page of credit entries: `rows` holds one past the page when there is more. Never a
 * ledger entry's note. A bill names the day it is for and the SPACE it measured. To a
 * caller who is not a member, every amount but a deposit's (a bill, an adjustment) is taken
 * toward zero to the cent and every balance down to the cent; a deposit's amount is exact,
 * as its chain shows it.
 */
export function historyAnswer(space: string, rows: HistoryRow[], limit: number, member: boolean) {
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const amount = (r: HistoryRow) => (member || r.kind === "deposit" ? Number(r.amount_micro) : cents(Number(r.amount_micro)));
  const after = (micro: number) => (member ? micro : Math.floor(micro / FUNDING_ROUNDING_MICRO) * FUNDING_ROUNDING_MICRO);
  return {
    space,
    entries: page.map((r) => ({
      entry_id: Number(r.entry_id),
      kind: r.kind,
      amount_micro_usd: amount(r),
      balance_after_micro_usd: after(Number(r.balance_after_micro)),
      at: at(r.created_at),
      bill: r.bill_day !== null && r.bill_space !== null ? { day: r.bill_day, space: r.bill_space } : null,
      deposit:
        r.coin === null || r.txid_in === null || r.address_in === null
          ? null
          : {
              coin: depositCoin(r.coin),
              network: coinByCallbackCoin(r.coin)?.network ?? null,
              txid_in: r.txid_in,
              value_forwarded_coin: r.value_forwarded_coin,
              address: r.address_in,
            },
    })),
    has_more: hasMore,
    next_before: hasMore ? Number(page.at(-1)!.entry_id) : null,
  };
}

/** limit on the history: a whole number from 1 to 200, 50 when it is not sent. */
export const HISTORY_LIMIT = { default: 50, max: 200 } as const;

function historyLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return HISTORY_LIMIT.default;
  const value = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (value < 1 || value > HISTORY_LIMIT.max) {
    throw new ApiError("INVALID_REQUEST", { detail: `limit is a whole number from 1 to ${HISTORY_LIMIT.max}` });
  }
  return value;
}

/** The coin a body names, and the wallet it is forwarded to here; or the refusal. */
function offeredCoin(body: Record<string, unknown>, name: string, funding: FundingConfig | undefined): { coin: Coin; wallet: string } {
  for (const key of Object.keys(body)) {
    if (key !== "coin") throw new ApiError("INVALID_REQUEST", { detail: `${key} is not a field here: send coin alone` });
  }
  if (typeof body.coin !== "string") {
    throw new ApiError("INVALID_REQUEST", { detail: `coin is required: a ticker from coins in GET /v1/spaces/${name}/funding with coins true` });
  }
  const coin = coinByTicker(body.coin);
  if (coin === undefined) {
    throw new ApiError("COIN_NOT_OFFERED", { detail: `not a coin this service takes: see coins in GET /v1/spaces/${name}/funding with coins true` });
  }
  const wallet = funding?.wallets[coin.family];
  if (wallet === undefined) {
    throw new ApiError("COIN_NOT_OFFERED", { detail: `not offered on this server: see coins in GET /v1/spaces/${name}/funding with coins true` });
  }
  return { coin, wallet };
}

export function mountFunding(app: Hono<Env>, config: Config, db: Db) {
  app.get("/v1/spaces/:name/funding", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    const name = c.req.param("name");
    const withCoins = queryFlag(c.req.query("coins"), "coins") === true;
    const funding = config.funding;
    const answer = await db.readTx(me, async (sql) => {
      const [space] = await sql<{
        space_id: string; visibility: Visibility; readable: boolean; member: boolean; owner: Buffer; withheld: boolean;
        credited_id: string | null; credited_name: string | null;
      }[]>`
        select s.space_id::text, s.visibility, schellingaf.can_read_space(s.space_id) as readable,
               schellingaf.caller_in_space(s.space_id) as member, s.owner_id as owner,
               exists (select 1 from schellingaf.withheld_spaces w
                        where w.space_id = s.space_id and w.released_at is null) as withheld,
               -- A replaced SPACE's deposits credit the end of its chain, named as
               -- GET /v1/spaces/{name} names each link: to anyone.
               r.space_id::text as credited_id, r.name as credited_name
          from schellingaf.spaces s
          left join schellingaf.spaces r
            on s.replaced_by is not null and r.space_id = schellingaf.funding_credited_space(s.space_id)
         where s.name = ${name}`;
      if (!space) return null;
      if (space.withheld) throw await readDenied(sql, space.space_id, space.owner, me);
      const addresses = await sql<AddressRow[]>`
        select a.coin, a.family, a.address_in, a.address_out_current as current, a.created_at
          from schellingaf.funding_addresses_of(${space.space_id}::uuid, ${sql.array(walletsOf(funding) as string[], 25)}::text[]) a`;
      const creditedTo = space.credited_id === null || space.credited_name === null ? null : { space_id: space.credited_id, name: space.credited_name };
      const offer = offerOf(name, addresses, funding, creditedTo, withCoins);
      // Not a member of a private or sealed SPACE: the addresses alone.
      if (!space.readable) {
        const [billing] = await sql<{ state: BillingState; from: string }[]>`
          select b.state, b.real_from::text as from from schellingaf.billing_state() b`;
        return addressesAnswer(name, space.visibility, offer, billing!);
      }
      const [row] = await sql<FundingRow[]>`
        select post_bytes::text, file_bytes::text, last_day::text, bill_billable::text, bill_due::text,
               bill_allowance::text, bill_rate::text, bill_days, bill_bytes_per_gb::text,
               task_bytes::text, bill_taken::text, bill_free, bill_shadow, billing, billing_from::text,
               free_until::text, read_only, read_only_since, own_per_day::text, per_day::text, pays_for
          from schellingaf.space_funding(${space.space_id}::uuid)`;
      const [state] = await sql<StateRow[]>`
        select balance_micro::text, pending_count, held_count, rejected_count, credited_count
          from schellingaf.funding_state(${space.space_id}::uuid)`;
      // can_read_space and the functions' filter are one rule: a readable SPACE has a row.
      if (!row || !state) throw await readDenied(sql, space.space_id, space.owner, me);
      const list = (state: "pending" | "held" | "rejected") => sql<DepositRow[]>`
        select d.coin, d.txid_in, d.value_coin::text, d.value_forwarded_coin::text, d.usd_micro::text, d.reason, d.seen_at
          from schellingaf.funding_deposits_of(${space.space_id}::uuid, ${state}, 20) d`;
      const deposits = { pending: await list("pending"), held: await list("held"), rejected: await list("rejected") };
      return fundingFigures(name, space.visibility, row, !!space.member, offer, state, deposits);
    });
    if (answer === null) throw new ApiError("SPACE_NOT_FOUND");
    return c.json(answer);
  });

  // A SPACE's credit entries, newest first, paged by before: read by whoever may read the
  // SPACE, and refused whole to anyone else, as the figures are members' alone there.
  app.get("/v1/spaces/:name/funding/history", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    const name = c.req.param("name");
    const rawBefore = c.req.query("before");
    const before = rawBefore === undefined || rawBefore === "" ? null : cursor(rawBefore, "before");
    const limit = historyLimit(c.req.query("limit"));
    const rows = await db.readTx(me, async (sql) => {
      const [space] = await sql<{ space_id: string; readable: boolean; member: boolean; owner: Buffer }[]>`
        select s.space_id::text, schellingaf.can_read_space(s.space_id) as readable,
               schellingaf.caller_in_space(s.space_id) as member, s.owner_id as owner
          from schellingaf.spaces s where s.name = ${name}`;
      if (!space) return null;
      if (!space.readable) throw await readDenied(sql, space.space_id, space.owner, me);
      const entries = await sql<HistoryRow[]>`
        select h.entry_id::text, h.kind, h.amount_micro::text, h.balance_after_micro::text, h.created_at,
               h.coin, h.txid_in, h.value_forwarded_coin::text, h.address_in, h.bill_day::text, h.bill_space
          from schellingaf.funding_history(${space.space_id}::uuid, ${before === null ? null : before.toString()}::bigint, ${limit + 1}) h`;
      return { entries, member: !!space.member };
    });
    if (rows === null) throw new ApiError("SPACE_NOT_FOUND");
    return c.json(historyAnswer(name, rows.entries, limit, rows.member));
  });

  // The deposit address for a coin: made by the provider on the first request for this
  // SPACE, coin and wallet, and the same after. Any KEY may ask, for any SPACE it can
  // find, private and sealed ones too: an address is public, and pays only into the SPACE.
  // In order, each a refusal of its own: the token, the coin, deposits open, the SPACE,
  // then an address already made (which spends nothing and calls nobody), the KEY's daily
  // allowance and the service's, the provider, and the row kept.
  app.post("/v1/spaces/:name/funding/addresses", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");
    const text = await c.req.text().catch(() => {
      throw new ApiError("INVALID_REQUEST");
    });
    const funding = config.funding;
    const { coin, wallet } = offeredCoin(asObject(parseStrictJson(text)), name, funding);
    if (!depositsOpen(funding)) throw new ApiError("FUNDING_UNAVAILABLE", { detail: "deposits are not open on this server" });

    const space = await db.readTx(me, async (sql) => {
      const [row] = await sql<{ space_id: string; status: string; replaced: boolean; successor: string | null; withheld: boolean; owner: Buffer }[]>`
        select s.space_id::text, s.status, s.replaced_by is not null as replaced, s.owner_id as owner,
               (select r.name from schellingaf.spaces r
                 where r.space_id = s.replaced_by and schellingaf.can_read_space(r.space_id)) as successor,
               exists (select 1 from schellingaf.withheld_spaces w
                        where w.space_id = s.space_id and w.released_at is null) as withheld
          from schellingaf.spaces s where s.name = ${name}`;
      if (!row) throw new ApiError("SPACE_NOT_FOUND");
      if (row.withheld) throw await readDenied(sql, row.space_id, row.owner, me);
      return row;
    });
    if (space.replaced) {
      throw new ApiError("SPACE_CLOSED", space.successor ? { detail: `continued in [${space.successor}]` } : {});
    }
    if (space.status !== "active") throw new ApiError("SPACE_CLOSED");

    const mac = callbackMac(funding.secret, space.space_id, coin.ticker, wallet);
    const url = callbackUrl(funding.callbackBase, space.space_id, coin, mac);
    const answer = (row: AddressRow, created: boolean) => {
      process.stdout.write(`${JSON.stringify({ event: "funding.address", space_id: space.space_id, coin: coin.ticker, created })}\n`);
      return c.json(
        { space: name, created, address: addressEntry(row), minimums_as_of: COINS_AS_OF, notice: FUNDING_DEPOSIT_NOTICE },
        created ? 201 : 200,
      );
    };

    const [made] = await db.write<{ address_in: string; created_at: Date }[]>`
      select f.address_in, f.created_at
        from schellingaf.funding_address_find(${space.space_id}::uuid, ${coin.ticker}, ${wallet}) f`;
    // Found or kept for the wallet configured now, so current.
    if (made) return answer({ coin: coin.ticker, family: coin.family, address_in: made.address_in, current: true, created_at: made.created_at }, false);

    await spend(c, db, OWN.fundingAddresses(me));
    await spend(c, db, SHARED.fundingAddresses());
    // Spent before the provider answers. When it fails, the service's own allowance is given
    // back, so an outage at the provider cannot empty it for the day; the KEY's is not: one
    // KEY's loss is bounded by its own allowance.
    let address: Awaited<ReturnType<typeof createAddress>>;
    try {
      address = await createAddress(funding, coin, url, wallet);
    } catch (error) {
      await giveBack(db, SHARED.fundingAddresses());
      throw error;
    }
    let kept: { address_in: string; created_at: Date; created: boolean } | undefined;
    try {
      [kept] = await db.write<{ address_in: string; created_at: Date; created: boolean }[]>`
        select f.address_in, f.created_at, f.created
          from schellingaf.funding_address_add(
            ${bearer.peerId}, ${space.space_id}::uuid, 'cryptapi', ${coin.ticker}, ${coin.family},
            ${address.addressIn}, ${address.addressOut}, ${url}, ${mac}, ${address.minimum}::numeric) f`;
    } catch (error) {
      // Another row holds the address, URL or mac the provider answered.
      if (toApiError(error).code !== "FUNDING_UNAVAILABLE") throw error;
      throw new ApiError("FUNDING_UNAVAILABLE", { detail: "the payment provider answered an address this service cannot keep", retryAfter: 60 });
    }
    return answer({ coin: coin.ticker, family: coin.family, address_in: kept!.address_in, current: true, created_at: kept!.created_at }, kept!.created);
  });

  // A callback sent as a GET: CryptAPI's default, which the addresses made here never ask
  // for, so it means the provider sends otherwise than asked. Not an operation. When its
  // URL is an address's own (its mac, its SPACE and its coin), it is logged, so the operator
  // notices, and refused 503, so the provider sends it again while the operator looks. Any
  // other GET is answered as a path with no operation, and logs nothing, so a stranger
  // cannot write the line. Nothing of it is read, and the mac is never logged.
  app.use(`${CALLBACK_PREFIX}:space/:coin/:mac`, async (c, next) => {
    if (c.req.method !== "GET") return next();
    const space = c.req.param("space").toLowerCase();
    const mac = c.req.param("mac");
    const coin = c.req.param("coin");
    let known = false;
    if (UUID_TEXT.test(space) && MAC_TEXT.test(mac) && COIN_SEGMENT.test(coin)) {
      const [row] = await db.write<{ known: boolean }[]>`
        select schellingaf.funding_callback_known(${mac}, ${space}::uuid, ${coin}) as known`;
      known = row?.known === true;
    }
    if (!known) return c.notFound();
    c.header("Cache-Control", "no-store");
    logCallback({ outcome: "get", space_id: space });
    throw new ApiError("FUNDING_UNAVAILABLE", { detail: "this server reads a callback sent as a POST with a JSON body, not as a GET" });
  });

  // The provider's notice of a deposit to an address made above: outside /v1, so its body
  // reaches this handler as the bytes that were signed (the /v1 middleware reads and
  // re-encodes every write body). In order: the body's size, read-only, the signature over
  // the raw bytes, the fields, the credit they ask for, then one call that records the
  // payment and, once confirmed, credits it. *ok* is answered only after that call
  // returned, so after it committed; a failure is a 5xx, and the provider sends again.
  app.post(
    `${CALLBACK_PREFIX}:space/:coin/:mac`,
    bodyLimit({
      maxSize: CALLBACK_BYTES,
      onError: (c) => {
        c.header("Connection", "close");
        throw new ApiError("TOO_LARGE", { detail: `a callback is at most ${CALLBACK_BYTES} bytes` });
      },
    }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (config.readOnly) throw new ApiError("SERVICE_READ_ONLY");
      const funding = config.funding;
      if (funding === undefined) throw new ApiError("FUNDING_UNAVAILABLE", { detail: "deposits are not configured on this server" });
      let raw: Buffer;
      try {
        raw = Buffer.from(await c.req.arrayBuffer());
      } catch {
        throw new ApiError("INVALID_REQUEST");
      }
      const signature = c.req.header("x-ca-signature");
      if (!signedBy(raw, signature, funding.pubkeyPem)) {
        logCallback({ outcome: "bad_signature" });
        throw new ApiError("CALLBACK_SIGNATURE_INVALID");
      }
      c.set("depositCallback", { outcome: "verified", deposit_id: null });

      let cb: Callback;
      try {
        cb = parseCallback(raw);
      } catch (error) {
        if (!(error instanceof MalformedCallback)) throw error;
        logCallback({ outcome: "malformed", uuid: error.uuid, field: error.field });
        c.set("depositCallback", { outcome: "malformed", deposit_id: null });
        throw new ApiError("INVALID_REQUEST", { detail: `${error.field} cannot be read in this callback` });
      }
      const credit = creditOf(cb);
      const space = c.req.param("space").toLowerCase();
      const mac = c.req.param("mac");
      const said = { uuid: cb.uuid, coin: cb.coin, pending: cb.pending };

      // A path no address can have matches no row, and asks nothing of the database.
      let row: { outcome: string; deposit_id: string | null; space_id: string | null; credited_micro: string | null };
      if (!UUID_TEXT.test(space) || !MAC_TEXT.test(mac)) {
        row = { outcome: "no_match", deposit_id: null, space_id: null, credited_micro: null };
      } else {
        const dec = (d: Decimal | null) => (d === null ? null : decimalText(d));
        try {
          [row] = await db.write<typeof row[]>`
            select f.outcome, f.deposit_id::text, f.space_id::text, f.credited_micro::text
              from schellingaf.funding_callback(
                ${mac}, ${space}::uuid, ${c.req.param("coin")}, ${cb.uuid}::uuid, ${cb.pending},
                ${cb.addressIn}, ${cb.addressOut}, ${cb.txidIn}, ${cb.coin},
                ${credit.family}, ${credit.stable}::boolean, ${credit.usdMicro === null ? null : credit.usdMicro.toString()}::bigint, ${credit.hold},
                ${dec(cb.valueCoin)}::numeric, ${dec(cb.valueForwarded)}::numeric, ${dec(cb.fee)}::numeric, ${dec(cb.price)}::numeric,
                ${cb.confirmations}::integer, ${cb.txidOut}, ${raw}, ${signature!},
                ${String(FUNDING.depositReviewMicro)}::bigint) f` as unknown as [typeof row];
        } catch (error) {
          // The fields this service read are not what the provider signed: a fault here,
          // never the provider's. Logged with what the chain shows, and answered 500, so the
          // provider sends it again once the fault is mended. Nothing was written.
          if (signedFieldsDiffer(error)) {
            logCallback({ outcome: "mismatch", uuid: cb.uuid, coin: cb.coin, address_in: cb.addressIn, txid_in: cb.txidIn });
            c.set("depositCallback", { outcome: "mismatch", deposit_id: null });
          }
          throw error;
        }
      }
      c.set("depositCallback", { outcome: row.outcome, deposit_id: row.deposit_id });
      logCallback({
        outcome: row.outcome,
        ...said,
        space_id: row.space_id,
        deposit_id: row.deposit_id,
        credited_micro: row.credited_micro === null ? null : Number(row.credited_micro),
        // A payment that matched no address is recovered by hand (runbooks/credit.md),
        // from its address and transaction, which are public on the chain.
        ...(row.outcome === "no_match" ? { address_in: cb.addressIn, txid_in: cb.txidIn } : {}),
        // A second payment in one transaction is held for the operator, who checks these
        // on the chain: all public there.
        ...(row.outcome === "conflict"
          ? { txid_in: cb.txidIn, txid_out: cb.txidOut, value_forwarded_coin: cb.valueForwarded === null ? null : decimalText(cb.valueForwarded) }
          : {}),
      });
      return c.text("*ok*", 200);
    },
  );
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAC_TEXT = /^[A-Za-z0-9_-]{43}$/;
/** A coin as a callback URL spells it: funding_addresses.coin with "_" for "/". */
const COIN_SEGMENT = /^[a-z0-9.-]{1,24}(_[a-z0-9.-]{1,24})?$/;

/** The two refusals of funding_callback() (0152) that say a field it was given is not the signed body's. */
const MISMATCH_DETAILS = new Set(["a callback field is not its signed body's", "the amount is not its signed body's"]);

/** Whether funding_callback() refused the fields as not its signed body's. */
export function signedFieldsDiffer(error: unknown): boolean {
  const e = error as { message?: unknown; detail?: unknown } | null;
  return e?.message === "INTERNAL" && typeof e.detail === "string" && MISMATCH_DETAILS.has(e.detail);
}

/** One funding.callback line: never the raw body, the mac or a wallet. */
function logCallback(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ event: "funding.callback", ...fields })}\n`);
}
