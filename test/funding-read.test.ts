// The reads of a SPACE's funding (migrations/0153_funding_reads.sql, src/http/funding.ts):
// GET /v1/spaces/{name}/funding with its addresses, coins, balance and deposits, and GET
// /v1/spaces/{name}/funding/history; the connector's funding, funding_history and
// deposit_address; the funding totals of /v1/numbers; and the surface that names them.
//
// Addresses are made through the route, by the double in test/support/cryptapi-double.ts.
// Deposits are recorded by funding_callback() itself, called as the owner role with the
// fields a verified callback carries: what is under test here is what the reads show of
// them (test/funding-callback.test.ts holds the callback). Every wallet is made up.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { SUPERUSER } from "./bootstrap.ts";
import { useService, fixture, db, call, agent, connector, testConfig, config, type Agent, type App } from "./lib/service.ts";
import { createApp } from "../src/http/app.ts";
import { startCryptapiDouble, type CryptapiDouble } from "./support/cryptapi-double.ts";
import { COINS, COINS_AS_OF, coinByCallbackCoin } from "../src/funding/coins.ts";
import { fundingConfig, type FundingConfig } from "../src/funding/config.ts";
import { FUNDING, dailyMicroUsd } from "../src/surface/vocabulary.ts";
import { FUNDING_DEPOSIT_NOTICE, FUNDING_NOTICE, addressesAnswer, fundingFigures, historyAnswer, offerOf, REPLACED_NOTICE, type FundingRow } from "../src/http/funding.ts";
import { buildOpenApi, openApiPath } from "../src/surface/openapi.ts";
import { OPERATIONS } from "../src/surface/operations.ts";
import { REFUSALS, refusalsOf } from "../src/surface/refusals.ts";
import * as sealed from "../content/sealed.mjs";

const ready = useService("funding_read");

// Made up, each of its family's shape.
const WALLETS = {
  evm: `0x${"fa".repeat(20)}`,
  btc: `bc1q${"x".repeat(38)}`,
  solana: `Fake${"W".repeat(36)}`,
  tron: `T${"F".repeat(33)}`,
};
const OTHER_EVM = `0x${"cd".repeat(20)}`;
const SECRET = "a-made-up-callback-secret-of-more-than-32-bytes";
const ORIGIN = "https://api.schellingaf.test";

let double: CryptapiDouble;
let dir: string;
let pemFile: string;
let fund: App;

const env = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CRYPTAPI_BASE: double.base,
  CRYPTAPI_PUBKEY_FILE: pemFile,
  FUNDING_CALLBACK_BASE: ORIGIN,
  FUNDING_CALLBACK_SECRET: SECRET,
  FUNDING_WALLET_EVM: WALLETS.evm,
  FUNDING_WALLET_BTC: WALLETS.btc,
  FUNDING_WALLET_SOLANA: WALLETS.solana,
  FUNDING_WALLET_TRON: WALLETS.tron,
  ...over,
});
const serviceWith = (funding: FundingConfig): App => createApp(testConfig(fixture.name, { funding }), db);

before(async () => {
  await ready;
  double = await startCryptapiDouble();
  dir = mkdtempSync(join(tmpdir(), "funding-read-"));
  pemFile = join(dir, "cryptapi.pem");
  writeFileSync(pemFile, double.publicKeyPem);
  fund = serviceWith(fundingConfig(env(), ORIGIN));
});
after(async () => {
  await double?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const newName = () => `fund-read-${process.pid}-${n++}`;
type Space = { name: string; id: string; owner: Agent };

async function space(visibility: "public" | "private" = "public"): Promise<Space> {
  const owner = await agent();
  const name = newName();
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Funding", visibility });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return { name, id: row!.id, owner };
}

async function sealedSpace(): Promise<Space> {
  const owner = await agent({ encryptionKey: true });
  const name = newName();
  const spaceId = randomUUID();
  const container = sealed.spaceContainer(spaceId);
  const g1 = await sealed.newGeneration(container, 1);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const me = new Uint8Array(Buffer.from(owner.peerId, "hex"));
  const lock = await sealed.sealLock({ container, g: 1, recipient: me, sender: me, commitment: g1.commitment, secret: g1.secret, pkR: owner.enc!.pk, skS: owner.enc!.sk });
  const made = await call("POST", "/v1/spaces", owner.token, {
    name, title: "Sealed", visibility: "sealed", sealed: { space_id: spaceId, commitment: hex(g1.commitment), lock: hex(lock) },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { name, id: spaceId, owner };
}

/** The SPACE's address for `coin`, made through the route by a KEY of no standing there. */
async function address(s: Space, coin = "base/usdc", on: App = fund): Promise<{ address_in: string; address_out: string; mac: string }> {
  const out = await call("POST", `/v1/spaces/${s.name}/funding/addresses`, (await agent()).token, { coin }, on);
  assert.ok(out.status === 201 || out.status === 200, JSON.stringify(out.body));
  const [row] = await fixture.owner<{ address_in: string; address_out: string; mac: string }[]>`
    select address_in, address_out, callback_mac as mac from schellingaf.funding_addresses
     where space_id = ${s.id}::uuid and address_in = ${out.body.address.address}`;
  return { ...row! };
}

type Deposit = {
  pending?: boolean; txid?: string; coin?: string; family?: string | null; usd?: number | null; hold?: string | null;
  value?: string | null; forwarded?: string | null; addressOut?: string;
};
/** One verified callback for `s`'s base/usdc address, recorded as the route records it. Its outcome. */
async function deposit(s: Space, a: { address_in: string; address_out: string; mac: string }, d: Deposit = {}): Promise<string> {
  const pending = d.pending ?? false;
  const uuid = randomUUID();
  const txid = d.txid ?? `0x${randomUUID().replaceAll("-", "")}`;
  const coin = d.coin ?? "base_usdc";
  const addressOut = d.addressOut ?? a.address_out;
  const value = d.value === undefined ? "5.000000" : d.value;
  const usd = pending ? null : d.usd === undefined ? 5_000_000 : d.usd;
  // A stablecoin is credited one for one, so by default what was forwarded is what usd says.
  const forwarded = pending ? null : d.forwarded !== undefined ? d.forwarded : usd === null ? "5.000000" : (usd / 1e6).toFixed(6);
  // The body the fields came from: funding_callback() refuses fields that are not its own.
  // A USD value worth usd, for a coin credited at it.
  const body = JSON.stringify({
    uuid, address_in: a.address_in, address_out: addressOut, txid_in: txid, coin, pending: pending ? 1 : 0,
    ...(value === null ? {} : { value_coin: value }),
    ...(pending ? {} : { value_forwarded_coin: forwarded, value_forwarded_coin_convert: { USD: usd === null ? null : String(usd / 1e6) } }),
  });
  const [row] = await fixture.owner<{ outcome: string }[]>`
    select f.outcome from schellingaf.funding_callback(
      ${a.mac}, ${s.id}::uuid, 'base_usdc', ${uuid}::uuid, ${pending},
      ${a.address_in}, ${addressOut}, ${txid}, ${coin},
      ${d.family === undefined ? "evm" : d.family}, ${coinByCallbackCoin(coin)?.stable ?? null}::boolean, ${usd}::bigint, ${d.hold ?? null},
      ${value}::numeric, ${forwarded}::numeric,
      null::numeric, null::numeric, ${pending ? null : 12}::integer, null, ${Buffer.from(body)}, 'sig',
      ${String(FUNDING.depositReviewMicro)}::bigint) f`;
  return row!.outcome;
}

const get = (name: string, who?: Agent | null, on: App = fund, query = "") => call("GET", `/v1/spaces/${name}/funding${query}`, who?.token, undefined, on);
const COINS_TOO = "?coins=true";
const history = (name: string, query = "", who?: Agent | null, on: App = fund) => call("GET", `/v1/spaces/${name}/funding/history${query}`, who?.token, undefined, on);

const FULL_ONLY = ["bytes", "allowance_bytes", "over_bytes", "rate", "would_be_billed_per_day_micro_usd", "last_day", "balance_micro_usd", "days_left", "deposits", "history"];
const OFFERED = COINS.map((c) => ({ coin: c.ticker, symbol: c.symbol, name: c.name, network: c.network, family: c.family, minimum: c.minimum, cheap: c.cheap, stable: c.stable }));

describe("who reads what", () => {
  test("anyone reads a public SPACE's everything, its addresses included, and the coins offered with coins=true alone", async () => {
    const s = await space("public");
    const a = await address(s);
    for (const who of [null, await agent(), s.owner]) {
      const out = await get(s.name, who);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      for (const key of FULL_ONLY) assert.ok(key in out.body, `${key} is missing`);
      assert.equal("members_only" in out.body, false);
      assert.equal(out.body.deposits_open, true);
      assert.equal(out.body.credited_to, null);
      // 98 coins are about 13.5 KB: only when asked for.
      assert.equal("coins" in out.body, false);
      assert.equal("minimums_as_of" in out.body, false);
      const all = await get(s.name, who, fund, COINS_TOO);
      assert.deepEqual(all.body.coins, OFFERED);
      assert.equal(all.body.minimums_as_of, COINS_AS_OF);
      assert.ok(JSON.stringify(out.body).length + 10_000 < JSON.stringify(all.body).length);
      assert.deepEqual(out.body.addresses, [{
        coin: "base/usdc", symbol: "USDC", network: "Base", family: "evm", address: a.address_in, minimum: "3",
        cheap: out.body.addresses[0].cheap, stable: true, current: true, created_at: out.body.addresses[0].created_at,
      }]);
      assert.equal(out.body.notice, FUNDING_NOTICE);
    }
  });

  test("a member reads its private SPACE's everything; a stranger and nobody read its addresses alone, and the coins with coins=true", async () => {
    const s = await space("private");
    const a = await address(s);
    const mine = await get(s.name, s.owner);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    for (const key of FULL_ONLY) assert.ok(key in mine.body, `${key} is missing`);
    for (const who of [null, await agent()]) {
      const out = await get(s.name, who);
      assert.equal(out.status, 200, JSON.stringify(out.body));
      assert.deepEqual(Object.keys(out.body), [
        "space", "visibility", "billing", "deposits_open", "addresses", "credited_to", "make_address", "members_only", "notice",
      ]);
      assert.deepEqual(out.body.members_only, ["bytes", "balance", "deposits", "history"]);
      assert.deepEqual(out.body.addresses.map((x: any) => x.address), [a.address_in]);
      const all = await get(s.name, who, fund, COINS_TOO);
      assert.deepEqual(Object.keys(all.body), [
        "space", "visibility", "billing", "deposits_open", "addresses", "credited_to", "coins", "minimums_as_of", "make_address", "members_only", "notice",
      ]);
      assert.deepEqual(all.body.coins, OFFERED);
      for (const key of ["bytes", "balance_micro_usd", "deposits"]) assert.equal(key in out.body, false, key);
    }
  });

  test("a sealed SPACE, read with no token, is its addresses and the coins alone", async () => {
    const s = await sealedSpace();
    const a = await address(s, "btc");
    const out = await get(s.name, null);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.visibility, "sealed");
    assert.deepEqual(out.body.addresses.map((x: any) => [x.coin, x.address]), [["btc", a.address_in]]);
    assert.deepEqual(out.body.members_only, ["bytes", "balance", "deposits", "history"]);
    for (const key of ["bytes", "balance_micro_usd", "deposits"]) assert.equal(key in out.body, false, key);
    const mine = await get(s.name, s.owner);
    assert.equal(mine.body.balance_micro_usd, 0);
  });

  test("a replaced SPACE names the SPACE its deposits credit, the end of its chain, to anyone, and never says its credit cannot move", async () => {
    for (const visibility of ["public", "private"] as const) {
      const s = await space(visibility);
      await address(s);
      const next = newName();
      const last = newName();
      await fixture.owner`select schellingaf.recover_space(${s.name}, ${next}, 'a test')`;
      await fixture.owner`select schellingaf.recover_space(${next}, ${last}, 'a test')`;
      const [end] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${last}`;
      for (const who of [null, s.owner]) {
        const out = await get(s.name, who);
        assert.equal(out.status, 200, JSON.stringify(out.body));
        assert.deepEqual(out.body.credited_to, { space_id: end!.id, name: last });
        assert.equal(out.body.notice, REPLACED_NOTICE(last));
        assert.ok(out.body.notice.includes(`Deposits to these addresses credit [${last}]`), out.body.notice);
        assert.ok(!/cannot move/.test(out.body.notice), out.body.notice);
      }
      // The SPACE at the end is not replaced: its own deposits are its own.
      const own = await get(last, s.owner);
      assert.equal(own.body.credited_to, null);
      assert.equal(own.body.notice, FUNDING_NOTICE);
    }
  });

  test("a withheld SPACE is refused to everyone, its addresses and its history too; no such name is SPACE_NOT_FOUND", async () => {
    const s = await space("public");
    await address(s);
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${s.id}::uuid, 'abuse', 'a test')`;
    for (const who of [null, s.owner]) {
      for (const out of [await get(s.name, who), await history(s.name, "", who)]) {
        assert.equal(out.status, 403, JSON.stringify(out.body));
        assert.equal(out.body.error.code, "READ_DENIED");
        assert.match(out.body.error.detail, /withheld/);
        assert.ok(!JSON.stringify(out.body).includes("address"), JSON.stringify(out.body));
      }
    }
    const [none] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.funding_addresses_of(${s.id}::uuid, array[${WALLETS.evm}, null, null, null]::text[])`;
    assert.equal(none!.n, 0, "the function answers a withheld SPACE's addresses");
    for (const out of [await get(newName()), await history(newName())]) assert.equal(out.body.error.code, "SPACE_NOT_FOUND");
  });

  test("the reads as the api role, with no caller, give a private SPACE's addresses and nothing else of it", async () => {
    const s = await space("private");
    await address(s);
    const a = await address(s, "btc");
    await deposit(s, await address(s), {});
    const rows = await db.readTx(null, async (sql) => ({
      addresses: await sql`select * from schellingaf.funding_addresses_of(${s.id}::uuid, array[null, null, null, null]::text[])`,
      state: await sql`select * from schellingaf.funding_state(${s.id}::uuid)`,
      deposits: await sql`select * from schellingaf.funding_deposits_of(${s.id}::uuid, 'pending', 20)`,
      confirmed: await sql`select * from schellingaf.funding_deposits_of(${s.id}::uuid, 'confirmed', 20)`,
      history: await sql`select * from schellingaf.funding_history(${s.id}::uuid, null, 200)`,
    }));
    assert.equal(rows.addresses.length, 2);
    assert.ok(rows.addresses.some((r: any) => r.address_in === a.address_in && r.address_out_current === false), "no wallet passed is no current address");
    assert.equal("address_out" in rows.addresses[0]!, false, "the wallet leaves SQL");
    for (const key of ["state", "deposits", "confirmed", "history"] as const) assert.equal(rows[key].length, 0, key);
  });
});

describe("the coins offered", () => {
  test("none, and deposits_open false, while deposits are closed on this server", async () => {
    const s = await space("public");
    const closed = await get(s.name, null, createApp(config, db), COINS_TOO);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal(closed.body.deposits_open, false);
    assert.deepEqual(closed.body.coins, []);
  });

  test("a family with no wallet here is not offered, and the rest are", async () => {
    const s = await space("public");
    const noTron = serviceWith(fundingConfig(env({ FUNDING_WALLET_TRON: undefined }), ORIGIN));
    const out = await get(s.name, null, noTron, COINS_TOO);
    assert.equal(out.body.deposits_open, true);
    assert.deepEqual(out.body.coins, OFFERED.filter((c) => c.family !== "tron"));
    assert.ok(out.body.coins.length > 0);
  });

  test("coins is true or false: any other value is INVALID_REQUEST; false is the same as leaving it out", async () => {
    const s = await space("public");
    const bad = await get(s.name, null, fund, "?coins=yes");
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error.code, "INVALID_REQUEST");
    assert.equal(bad.body.error.detail, "coins is true or false");
    const off = await get(s.name, null, fund, "?coins=false");
    assert.equal("coins" in off.body, false);
  });

  test("an address made under an older wallet is listed, not current, beside the current one", async () => {
    const s = await space("public");
    const old = await address(s, "base/usdc");
    const moved = serviceWith(fundingConfig(env({ FUNDING_WALLET_EVM: OTHER_EVM }), ORIGIN));
    const now = await address(s, "base/usdc", moved);
    assert.notEqual(now.address_in, old.address_in);
    for (const [on, current] of [[moved, now.address_in], [fund, old.address_in]] as const) {
      const out = await get(s.name, null, on);
      const listed = out.body.addresses.map((x: any) => [x.address, x.current]).sort();
      assert.deepEqual(listed, [[now.address_in, current === now.address_in], [old.address_in, current === old.address_in]].sort());
    }
  });
});

describe("the balance and the deposits", () => {
  test("the balance is the ledger's sum, and each list is the newest 20 of its state, with its count", async () => {
    const s = await space("public");
    const a = await address(s);
    for (let i = 0; i < 22; i++) assert.equal(await deposit(s, a, { pending: true, txid: `pending-${String(i).padStart(2, "0")}` }), "pending_recorded");
    assert.equal(await deposit(s, a, { txid: "credit-1", usd: 2_500_000 }), "credited");
    assert.equal(await deposit(s, a, { txid: "credit-2", usd: 1_250_001 }), "credited");
    assert.equal(await deposit(s, a, { txid: "held-1", usd: FUNDING.depositReviewMicro + 1, forwarded: "100.000001" }), "held");
    assert.equal(await deposit(s, a, { txid: "held-2", coin: "base_xyz", family: null, usd: null, hold: "unknown_coin", forwarded: "7" }), "held");
    assert.equal(await deposit(s, a, { txid: "rejected-1", addressOut: OTHER_EVM }), "rejected");

    const out = await get(s.name, null);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const [sum] = await fixture.owner<{ s: string }[]>`select coalesce(sum(amount_micro), 0)::text as s from schellingaf.credit_ledger where space_id = ${s.id}::uuid`;
    assert.equal(out.body.balance_micro_usd, Number(sum!.s));
    assert.equal(out.body.balance_micro_usd, 3_750_001);
    const d = out.body.deposits;
    assert.deepEqual([d.pending_count, d.held_count, d.rejected_count, d.credited_count], [22, 2, 1, 2]);
    assert.equal(d.pending.length, 20);
    assert.deepEqual(d.pending.map((p: any) => p.txid_in), Array.from({ length: 20 }, (_, i) => `pending-${String(21 - i).padStart(2, "0")}`), "newest first");
    assert.deepEqual(d.pending[0], { coin: "base/usdc", txid_in: "pending-21", value_coin: "5.000000", seen_at: d.pending[0].seen_at });
    assert.deepEqual(d.held.map((h: any) => ({ ...h, seen_at: null })), [
      { coin: "base_xyz", txid_in: "held-2", value_forwarded_coin: "7", usd_micro: null, reason: "unknown_coin", seen_at: null },
      { coin: "base/usdc", txid_in: "held-1", value_forwarded_coin: "100.000001", usd_micro: FUNDING.depositReviewMicro + 1, reason: "review", seen_at: null },
    ]);
    assert.deepEqual(d.rejected.map((r: any) => [r.coin, r.txid_in, r.reason]), [["base/usdc", "rejected-1", "address_out_mismatch"]]);
  });

  test("days_left is null while nothing would be billed, and the balance over the day's bill, rounded down, once something would", () => {
    const row: FundingRow = {
      post_bytes: "1000", file_bytes: "0", last_day: null,
      bill_billable: null, bill_due: null, bill_allowance: null, bill_rate: null, bill_days: null, bill_bytes_per_gb: null,
    };
    const offer = offerOf("s", [], undefined);
    const state = { balance_micro: "1000", pending_count: 0, held_count: 0, rejected_count: 0, credited_count: 1 };
    const none = { pending: [], held: [], rejected: [] };
    assert.equal(fundingFigures("s", "public", row, true, offer, state, none).days_left, null);
    const tiny = { ...FUNDING, allowanceBytes: { public: 0, private: 0, sealed: 0 }, microUsdPerGbMonth: 30_000_000_000 };
    const big: FundingRow = { ...row, post_bytes: "1000000" };
    const perDay = dailyMicroUsd(1_000_000, 0, tiny);
    assert.ok(perDay > 0 && 1000 % perDay !== 0, `per day ${perDay}`);
    const out = fundingFigures("s", "public", big, true, offer, state, none, tiny);
    assert.equal(out.would_be_billed_per_day_micro_usd, perDay);
    assert.equal(out.days_left, Math.floor(1000 / perDay));
  });

  test("the answer of the addresses alone carries no figure", () => {
    const out = addressesAnswer("s", "private", offerOf("s", [], undefined));
    for (const key of FULL_ONLY) assert.equal(key in out, false, key);
  });
});

describe("the history", () => {
  test("it pages newest first by before, each deposit with its coin, network, transaction and address, and never a ledger note", async () => {
    const s = await space("public");
    const a = await address(s);
    for (let i = 1; i <= 5; i++) assert.equal(await deposit(s, a, { txid: `tx-${i}`, usd: i * 1_000_000, forwarded: `${i}` }), "credited");
    const NOTE = `an operator's note ${randomUUID()}`;
    await fixture.owner`select * from schellingaf.credit_post(${s.id}::uuid, 'adjustment', 0, ${`adjustment:${randomUUID()}`}, ${NOTE})`;

    const seen: any[] = [];
    let page = await history(s.name, "?limit=2");
    for (;;) {
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(!JSON.stringify(page.body).includes(NOTE), "the history carries the note");
      seen.push(...page.body.entries);
      if (!page.body.has_more) {
        assert.equal(page.body.next_before, null);
        break;
      }
      assert.equal(page.body.entries.length, 2);
      assert.equal(page.body.next_before, page.body.entries.at(-1).entry_id);
      page = await history(s.name, `?limit=2&before=${page.body.next_before}`);
    }
    assert.equal(seen.length, 6);
    const ids = seen.map((e) => e.entry_id);
    assert.deepEqual(ids, [...ids].sort((x, y) => y - x), "newest first");
    assert.deepEqual({ ...seen[0], at: null }, { entry_id: ids[0], kind: "adjustment", amount_micro_usd: 0, balance_after_micro_usd: 15_000_000, at: null, deposit: null });
    assert.deepEqual({ ...seen[1], at: null }, {
      entry_id: ids[1], kind: "deposit", amount_micro_usd: 5_000_000, balance_after_micro_usd: 15_000_000, at: null,
      deposit: { coin: "base/usdc", network: "Base", txid_in: "tx-5", value_forwarded_coin: "5", address: a.address_in },
    });
    assert.deepEqual(seen.slice(1).map((e) => e.deposit.txid_in), ["tx-5", "tx-4", "tx-3", "tx-2", "tx-1"]);
    const whole = await history(s.name);
    assert.deepEqual(whole.body.entries, seen);
    assert.equal(whole.body.has_more, false);
  });

  test("a before or a limit out of range is INVALID_REQUEST", async () => {
    const s = await space("public");
    for (const query of ["?before=12345678901234567890", "?before=abc", "?before=-1", "?limit=0", "?limit=201", "?limit=x", "?limit=1.5"]) {
      const out = await history(s.name, query);
      assert.equal(out.status, 400, `${query}: ${JSON.stringify(out.body)}`);
      assert.equal(out.body.error.code, "INVALID_REQUEST", query);
    }
    assert.equal((await history(s.name, "?limit=200")).status, 200);
  });

  test("a stranger and nobody are refused a private SPACE's history whole, and a member reads it", async () => {
    const s = await space("private");
    const a = await address(s);
    await deposit(s, a, { txid: "private-1" });
    for (const who of [null, await agent()]) {
      const out = await history(s.name, "", who);
      assert.equal(out.status, 403, JSON.stringify(out.body));
      assert.equal(out.body.error.code, "READ_DENIED");
      assert.ok(!JSON.stringify(out.body).includes("private-1"));
    }
    const mine = await history(s.name, "", s.owner);
    assert.deepEqual(mine.body.entries.map((e: any) => e.deposit.txid_in), ["private-1"]);
  });

  test("a page holds one past it to say has_more, and gives that one no place", () => {
    const row = (id: number) => ({
      entry_id: String(id), kind: "free_grant", amount_micro: "1", balance_after_micro: String(id), created_at: new Date(0),
      coin: null, txid_in: null, value_forwarded_coin: null, address_in: null,
    });
    assert.deepEqual(historyAnswer("s", [row(9), row(8), row(7)], 2).entries.map((e) => e.entry_id), [9, 8]);
    assert.equal(historyAnswer("s", [row(9), row(8), row(7)], 2).next_before, 8);
    assert.equal(historyAnswer("s", [row(9), row(8)], 2).has_more, false);
  });

  test("under a generic plan the page reads the SPACE's entries by credit_ledger_space_idx, before as an index condition", async () => {
    // A ledger shaped as the service's will be: many SPACES with a few entries each, and
    // one with three thousand, so a walk of the ledger, or of the primary key past other
    // SPACES' entries, shows.
    const s = await space("public");
    await fixture.owner`
      insert into schellingaf.spaces (name, owner_id, title)
      select 'ledger-crowd-' || ${process.pid} || '-' || g, decode(${s.owner.peerId}, 'hex'), 'Crowd ' || g
        from generate_series(1, 500) g`;
    await fixture.owner`
      insert into schellingaf.space_credit (space_id, balance_micro)
      select space_id, 4 from schellingaf.spaces where name like ${`ledger-crowd-${process.pid}-%`}
      union all select ${s.id}::uuid, 3000`;
    await fixture.owner`
      insert into schellingaf.credit_ledger (space_id, kind, amount_micro, balance_after_micro, idempotency_key)
      select c.space_id, 'free_grant', 1, g, 'free_grant:plan:' || c.space_id || ':' || g
        from schellingaf.space_credit c cross join generate_series(1, 4) g
       where c.space_id <> ${s.id}::uuid
      order by g, c.space_id`;
    await fixture.owner`
      insert into schellingaf.credit_ledger (space_id, kind, amount_micro, balance_after_micro, idempotency_key)
      select ${s.id}::uuid, 'free_grant', 1, g, 'free_grant:plan:' || ${s.id} || ':' || g from generate_series(1, 3000) g`;
    await fixture.owner`vacuum analyze schellingaf.credit_ledger`;
    const [top] = await fixture.owner<{ id: string }[]>`select max(entry_id)::text as id from schellingaf.credit_ledger where space_id = ${s.id}::uuid`;
    const middle = String(BigInt(top!.id) - 1000n);

    type PlanNode = { [field: string]: any; Plans?: PlanNode[] };
    const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
    const logged: string[] = [];
    const su = postgres({ ...SUPERUSER, database: fixture.name, onnotice: (m) => logged.push(m.message ?? "") });
    try {
      await su`load 'auto_explain'`;
      for (const setting of ["log_min_duration = 0", "log_nested_statements = on", "log_format = json", "log_level = notice"]) {
        await su.unsafe(`set auto_explain.${setting}`);
      }
      await su.begin(async (tx) => {
        await tx.unsafe("set local plan_cache_mode = force_generic_plan");
        await tx.unsafe("set local role schellingaf_api");
        for (const before of [null, middle]) {
          const rows = await tx`select entry_id from schellingaf.funding_history(${s.id}::uuid, ${before}::bigint, 51)`;
          assert.equal(rows.length, 51);
        }
      });
    } finally {
      await su.end({ timeout: 5 });
    }
    const plans = logged.filter((m) => m.includes("{")).map((m) => JSON.parse(m.slice(m.indexOf("{"))) as { "Query Text": string; Plan: PlanNode });
    const inner = plans.filter((p) => /FROM credit_ledger l/.test(p["Query Text"]));
    assert.ok(inner.length >= 2, `the function's statement was not logged: ${plans.map((p) => p["Query Text"]).join(" | ")}`);
    for (const p of inner) {
      const ledger = nodesOf(p.Plan).filter((x) => x["Relation Name"] === "credit_ledger");
      assert.ok(ledger.length > 0, JSON.stringify(p.Plan));
      for (const x of ledger) {
        assert.notEqual(x["Node Type"], "Seq Scan", JSON.stringify(p.Plan));
        assert.equal(x["Index Name"], "credit_ledger_space_idx", JSON.stringify(x));
        assert.match(x["Index Cond"] ?? "", /space_id = .*entry_id </, JSON.stringify(x));
      }
    }
  });
});

describe("the connector", () => {
  test("funding says the addresses, the coins a network a line, the balance and the deposits", async () => {
    const s = await space("public");
    const a = await address(s);
    await deposit(s, a, { txid: "conn-1", usd: 3_000_000 });
    await deposit(s, a, { pending: true, txid: "conn-2" });
    const json = (await get(s.name)).body;
    const { message } = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "funding", name: s.name, coins: true } }, undefined, fund);
    assert.equal(message.result?.isError ?? false, false, JSON.stringify(message));
    const text: string = message.result.content[0].text;
    // Without coins true, no coin is listed, and it says how to ask.
    const plain = (await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "funding", name: s.name } }, undefined, fund)).message;
    const plainText: string = plain.result.content[0].text;
    assert.ok(plainText.includes("coins offered: ask again with coins true to list them, with their minimums"), plainText);
    assert.ok(!plainText.includes("base/usdc min 3"), plainText);
    assert.ok(plainText.length + 2_000 < text.length);
    for (const part of [
      "deposits: open on this server", "deposit addresses:", `base/usdc on Base: ${a.address_in}, minimum 3`,
      `coins offered, minimums as of ${COINS_AS_OF}, by network:`, "Solana (cheap): ", "base/usdc min 3",
      `make an address: POST /v1/spaces/${s.name}/funding/addresses`,
      "balance: 3000000 micro-dollars; days left at the bill shown: none, nothing would be billed",
      "deposits: 1 incoming, not yet credited; 0 held; 0 rejected; 1 credited", "incoming: base/usdc, transaction conn-2",
      `credit entries: GET /v1/spaces/${s.name}/funding/history`, json.notice,
    ]) assert.ok(text.includes(part), `${part} is missing from:\n${text}`);
    const networks = new Set(COINS.map((c) => c.network));
    assert.equal(text.split("\n").filter((l) => [...networks].some((nw) => l.startsWith(`  ${nw}`) && l.includes(" min "))).length, networks.size, text);
  });

  test("funding, to a stranger of a private SPACE, says the addresses and what is shown to members only", async () => {
    const s = await space("private");
    const a = await address(s);
    const { message } = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "funding", name: s.name } }, (await agent()).token, fund);
    const text: string = message.result.content[0].text;
    assert.ok(text.includes(a.address_in), text);
    assert.ok(text.includes("shown to members only: bytes, balance, deposits, history"), text);
    assert.ok(!text.includes("balance:"), text);
  });

  test("funding_history says each entry and the cursor to the next page, with no token", async () => {
    const s = await space("public");
    const a = await address(s);
    for (const tx of ["h-1", "h-2", "h-3"]) await deposit(s, a, { txid: tx });
    const page = (await history(s.name, "?limit=2")).body;
    const { message } = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "funding_history", name: s.name, limit: 2 } }, undefined, fund);
    assert.equal(message.result?.isError ?? false, false, JSON.stringify(message));
    const text: string = message.result.content[0].text;
    for (const part of [
      "2 credit entries, newest first", `${page.entries[0].entry_id} deposit 5000000, balance after 15000000`,
      `base/usdc on Base, forwarded 5.000000, transaction h-3, to ${a.address_in}`, `has_more true: ask again with before ${page.next_before}`,
    ]) assert.ok(text.includes(part), `${part} is missing from:\n${text}`);
    const next = await connector("tools/call", { name: "schellingaf_spaces", arguments: { action: "funding_history", name: s.name, before: String(page.next_before) } }, undefined, fund);
    assert.ok(next.message.result.content[0].text.includes("has_more false"), next.message.result.content[0].text);
    assert.deepEqual(next.message.result.structuredContent.entries.map((e: any) => e.deposit.txid_in), ["h-1"]);
  });

  test("deposit_address makes the address and says it, then the notice; it needs a token, and coin goes with it alone", async () => {
    const s = await space("private");
    const asker = await agent();
    const made = await connector("tools/call", { name: "schellingaf_space_control", arguments: { action: "deposit_address", name: s.name, coin: "sol/usdc" } }, asker.token, fund);
    assert.equal(made.message.result?.isError ?? false, false, JSON.stringify(made.message));
    const body = made.message.result.structuredContent;
    assert.equal(body.created, true);
    const text: string = made.message.result.content[0].text;
    const lines = text.split("\n");
    assert.ok(lines[1]!.includes("deposit address made now"), text);
    assert.ok(lines[2]!.startsWith(`sol/usdc on Solana: ${body.address.address}, minimum ${body.address.minimum}`), text);
    assert.equal(lines.at(-1), FUNDING_DEPOSIT_NOTICE);

    const anonymous = await connector("tools/call", { name: "schellingaf_space_control", arguments: { action: "deposit_address", name: s.name, coin: "sol/usdc" } }, undefined, fund);
    assert.equal(anonymous.message.result.isError, true, JSON.stringify(anonymous.message));
    const stray = await connector("tools/call", { name: "schellingaf_space_control", arguments: { action: "create", name: newName(), title: "x", coin: "btc" } }, asker.token, fund);
    assert.equal(stray.message.result.isError, true);
    assert.match(stray.message.result.content[0].text, /^INVALID_REQUEST/);
    const extra = await connector("tools/call", { name: "schellingaf_space_control", arguments: { action: "deposit_address", name: s.name, coin: "btc", title: "x" } }, asker.token, fund);
    assert.equal(extra.message.result.isError, true);
    assert.match(extra.message.result.content[0].text, /^INVALID_REQUEST.*title/);
    const missing = await connector("tools/call", { name: "schellingaf_space_control", arguments: { action: "deposit_address", name: s.name } }, asker.token, fund);
    assert.match(missing.message.result.content[0].text, /needs coin/);
  });
});

describe("the service's numbers", () => {
  test("after one credit, funding counts it, its dollars and its SPACE, and the deposit still pending", async () => {
    const count = async () => ((await (await createApp(config, db).request("/v1/numbers")).json()) as any).funding;
    const before = await count();
    const s = await space("private");
    const a = await address(s);
    await deposit(s, a, { txid: "numbers-1", usd: 4_200_000 });
    await deposit(s, a, { pending: true, txid: "numbers-2" });
    const after = await count();
    assert.deepEqual(after, {
      deposits: { total: before.deposits.total + 1, last_7_days: before.deposits.last_7_days + 1 },
      credited_micro_usd: { total: before.credited_micro_usd.total + 4_200_000, last_7_days: before.credited_micro_usd.last_7_days + 4_200_000 },
      spaces_funded: before.spaces_funded + 1,
      pending: before.pending + 1,
    });
    assert.ok(!JSON.stringify(after).includes(s.name) && !JSON.stringify(after).includes(s.id));
  });
});

describe("the surface", () => {
  const doc = buildOpenApi("https://api.funding-read.test", "test") as any;

  test("OpenAPI has the four funding operations, each with its refusals", () => {
    for (const name of ["funding.get", "funding.history", "funding.address", "funding.callback"]) {
      const op = OPERATIONS.find((o) => o.name === name)!;
      const entry = doc.paths[openApiPath(op.path)]?.[op.method.toLowerCase()];
      assert.ok(entry, name);
      assert.deepEqual(entry["x-refusals"], refusalsOf(op), name);
      for (const code of REFUSALS[name]!) assert.ok(entry["x-refusals"].includes(code), `${name} does not name ${code}`);
    }
    const get = doc.paths["/v1/spaces/{name}/funding"].get.responses["200"].content["application/json"].schema;
    assert.deepEqual(get.oneOf.map((s: any) => s.$ref.split("/").pop()), ["FundingFull", "FundingAddresses"]);
    assert.deepEqual(doc.paths["/v1/spaces/{name}/funding/history"].get.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name), ["before", "limit"]);
  });

  test("capabilities has funding among the modules, its limits, and nothing of it planned", async () => {
    const caps = await (await fund.request("/v1/capabilities")).json() as any;
    assert.equal(caps.modules.funding.status, "available");
    assert.equal(caps.modules.funding.deposits_open, true);
    assert.equal(caps.modules.funding.history, "GET /v1/spaces/{name}/funding/history");
    assert.equal("funding" in caps.planned, false);
    assert.deepEqual(Object.keys(caps.limits.funding), ["addresses_per_key_per_day", "addresses_per_day", "callback_bytes"]);
    const closed = await (await createApp(config, db).request("/v1/capabilities")).json() as any;
    assert.deepEqual({ ...closed.modules.funding, deposits_open: true }, caps.modules.funding, "the module is the same with deposits closed");
  });

  test("the connector reaches funding.history and funding.address through the actions the operations name", () => {
    assert.deepEqual(OPERATIONS.find((o) => o.name === "funding.history")!.mcpArgs, { action: "funding_history" });
    assert.equal(OPERATIONS.find((o) => o.name === "funding.address")!.mcp, "schellingaf_space_control");
    assert.deepEqual(OPERATIONS.find((o) => o.name === "funding.address")!.mcpArgs, { action: "deposit_address" });
  });
});
