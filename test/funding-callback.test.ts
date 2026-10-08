// The provider's deposit callback: POST /funding/cryptapi/{space_id}/{coin}/{mac}
// (src/http/funding.ts), its signature and fields (src/funding/callback.ts), the table and
// the two functions that record and credit a deposit (migrations/0152_funding_deposits.sql),
// the check of the provider's key at start (src/server.ts), the audit
// (scripts/funding-audit.ts) and the release the runbook runs (runbooks/credit.md).
//
// The service listens on a real socket here, because the double in
// test/support/cryptapi-double.ts calls back the URL each address was made with, as
// CryptAPI does. Every wallet and address is made up.

import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { useService, fixture, db, call, agent, testConfig, config, type App } from "./lib/service.ts";
import { API_PASSWORD } from "./bootstrap.ts";
import { withEnv } from "./lib/env.ts";
import { logDeadlock, loggedPath } from "../src/http/log.ts";
import { createApp } from "../src/http/app.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db/sql.ts";
import { startCryptapiDouble, type CryptapiDouble, type Deposit, type Field } from "./support/cryptapi-double.ts";
import { fundingConfig } from "../src/funding/config.ts";
import { CRYPTAPI_PUBKEY_PEM } from "../src/funding/cryptapi-pubkey.ts";
import { samePubkey } from "../src/funding/cryptapi.ts";
import { FUNDING } from "../src/surface/vocabulary.ts";
import { auditDeposits } from "../scripts/funding-audit.ts";

const ready = useService("funding_callback");

const WALLETS = {
  evm: `0x${"fa".repeat(20)}`,
  btc: `bc1q${"x".repeat(38)}`,
  solana: `Fake${"W".repeat(36)}`,
  tron: `T${"F".repeat(33)}`,
};
const STRANGER_WALLET = `0x${"5e".repeat(20)}`;
const SECRET = "a-made-up-callback-secret-of-more-than-32-bytes";

let double: CryptapiDouble;
let dir: string;
let pemFile: string;
let logDir: string;
let server: Server;
let origin: string;
/** What the socket serves: the funded service, or for one test another. */
let current: App;
let fundConfig: Config;
let fund: App;

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  CRYPTAPI_BASE: double.base,
  CRYPTAPI_PUBKEY_FILE: pemFile,
  FUNDING_CALLBACK_BASE: origin,
  FUNDING_CALLBACK_SECRET: SECRET,
  FUNDING_WALLET_EVM: WALLETS.evm,
  FUNDING_WALLET_BTC: WALLETS.btc,
  FUNDING_WALLET_SOLANA: WALLETS.solana,
  FUNDING_WALLET_TRON: WALLETS.tron,
  ...over,
});

before(async () => {
  await ready;
  double = await startCryptapiDouble();
  dir = mkdtempSync(join(tmpdir(), "funding-callback-"));
  pemFile = join(dir, "cryptapi.pem");
  writeFileSync(pemFile, double.publicKeyPem);
  logDir = join(dir, "log");
  mkdirSync(logDir);
  server = serve({ fetch: (req, e) => current.fetch(req, e), port: 0, hostname: "127.0.0.1" }) as Server;
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = testConfig(fixture.name);
  fundConfig = testConfig(fixture.name, { funding: fundingConfig(env(), base.publicOrigin), logDir });
  fund = createApp(fundConfig, db);
  current = fund;
});
after(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await double?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The ledger agrees with every balance after every case.
afterEach(async () => {
  const [row] = await fixture.owner<{ n: number }[]>`select schellingaf.credit_reconcile() as n`;
  assert.equal(row!.n, 0, "credit_reconcile() found a balance that disagrees with its ledger");
});

let n = 0;
const newName = () => `fund-cb-${process.pid}-${n++}`;

type Space = { name: string; id: string };
async function space(): Promise<Space> {
  const owner = await agent();
  const name = newName();
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Funding", visibility: "public" });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return { name, id: row!.id };
}

/** The callback URL of the SPACE's address for `coin`, made through the route as an agent makes it. */
async function addressOf(s: Space, coin = "base/usdc"): Promise<string> {
  const asker = await agent();
  const out = await call("POST", `/v1/spaces/${s.name}/funding/addresses`, asker.token, { coin }, fund);
  assert.ok(out.status === 201 || out.status === 200, JSON.stringify(out.body));
  const [row] = await fixture.owner<{ url: string }[]>`
    select callback_url as url from schellingaf.funding_addresses where space_id = ${s.id}::uuid and coin = ${coin}`;
  return row!.url;
}

type DepositRow = {
  deposit_id: string; state: string; reason: string | null; coin: string; usd_micro: string | null;
  space_id: string; credited_space: string | null; pending_uuid: string | null; confirmed_uuid: string | null; entry_id: string | null;
};
async function deposits(s: Space): Promise<DepositRow[]> {
  const rows = await fixture.owner<DepositRow[]>`
    select deposit_id::text, state, reason, coin, usd_micro::text, space_id::text, credited_space::text,
           pending_uuid::text, confirmed_uuid::text, entry_id::text
      from schellingaf.funding_deposits where space_id = ${s.id}::uuid order by seen_at, deposit_id`;
  return rows.map((r) => ({ ...r }));
}
async function ledger(spaceId: string): Promise<{ kind: string; amount: number; key: string; entry_id: string }[]> {
  const rows = await fixture.owner<{ kind: string; amount: string; key: string; entry_id: string }[]>`
    select kind, amount_micro::text as amount, idempotency_key as key, entry_id::text
      from schellingaf.credit_ledger l where l.space_id = ${spaceId}::uuid order by l.entry_id`;
  return rows.map((r) => ({ kind: r.kind, amount: Number(r.amount), key: r.key, entry_id: r.entry_id }));
}
async function balance(spaceId: string): Promise<number> {
  const [row] = await fixture.owner<{ b: string }[]>`select balance_micro::text as b from schellingaf.space_credit where space_id = ${spaceId}::uuid`;
  return row ? Number(row.b) : 0;
}

/** What the service wrote to a stream while `during` ran. */
async function written(stream: "stdout" | "stderr", during: () => Promise<unknown>): Promise<string> {
  const target = process[stream];
  const original = target.write.bind(target);
  let out = "";
  target.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof target.write;
  try {
    await during();
  } finally {
    target.write = original;
  }
  return out;
}
const callbackLines = (out: string) =>
  out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)).filter((l) => l.event === "funding.callback");

/** A callback sent again in process, as is or changed: its body, its signature, its path. */
async function resend(sent: { url: string; body: string; signature: string | null }, on: App, over: { body?: string; signature?: string | null; url?: string } = {}) {
  const url = new URL(over.url ?? sent.url);
  const signature = over.signature !== undefined ? over.signature : sent.signature;
  return on.request(url.pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature === null ? {} : { "x-ca-signature": signature }) },
    body: over.body ?? sent.body,
  });
}

/** A confirmed callback's fields with `address_out` given as any field. */
function confirmedFields(o: { uuid: string; addressIn: string; addressOut: Field | null; txid: string; coin: string; value: string; usd?: string; omit?: string }): Field[] {
  const s = (name: string, value: string): Field => ({ name, type: "string", value });
  const num = (name: string, value: string): Field => ({ name, type: "number", value });
  return [
    s("uuid", o.uuid), s("address_in", o.addressIn), ...(o.addressOut ? [o.addressOut] : []), s("txid_in", o.txid),
    s("txid_out", "0xout"), num("confirmations", "1"), num("value_coin", o.value), num("value_forwarded_coin", o.value),
    { name: "value_forwarded_coin_convert", type: "convert" as const, value: { USD: o.usd ?? o.value } },
    num("fee_coin", "0"), s("coin", o.coin), num("price", "1"), num("pending", "0"),
  ].filter((f) => f.name !== o.omit);
}

describe("forged and odd callbacks", () => {
  test("1. a body altered after signing is 401, and the route touches no pool", async () => {
    const s = await space();
    const url = await addressOf(s);
    const dep = double.deposit(url, { value: "10" });
    const sent = await dep.confirmed({ alter: (b) => b.replace('"value_forwarded_coin": 9.9', '"value_forwarded_coin": 9999') });
    assert.equal(sent.status, 401);
    assert.equal(JSON.parse(sent.responseBody).error.code, "CALLBACK_SIGNATURE_INVALID");
    assert.deepEqual(await deposits(s), []);
    assert.equal(await balance(s.id), 0);

    // The same forgery against a service whose database throws on any use.
    const touched: string[] = [];
    const trap = new Proxy({}, {
      get: (_t, key) => {
        touched.push(String(key));
        throw new Error(`the database was used: ${String(key)}`);
      },
    }) as Db;
    const stub = createApp(fundConfig, trap);
    touched.length = 0;
    const res = await resend(sent, stub);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), null, "a provider's callback is not asked for a bearer");
    assert.deepEqual(touched, []);
  });

  test("2. a missing header is 401, and a header that is not base64 is 401", async () => {
    const s = await space();
    const url = await addressOf(s);
    const dep = double.deposit(url, { value: "10" });
    const out = await written("stdout", async () => {
      assert.equal((await dep.confirmed({ signature: null })).status, 401);
      assert.equal((await dep.confirmed({ signature: "not base64 at all!" })).status, 401);
    });
    assert.deepEqual(await deposits(s), []);
    const lines = callbackLines(out);
    assert.deepEqual(lines, [{ event: "funding.callback", outcome: "bad_signature" }, { event: "funding.callback", outcome: "bad_signature" }]);
  });

  test("3. a stranger's key is 401", async () => {
    const s = await space();
    const url = await addressOf(s);
    assert.equal((await double.deposit(url, { value: "10" }).confirmed({ signWith: "stranger" })).status, 401);
    assert.deepEqual(await deposits(s), []);
  });

  test("4. our URL with a stranger's wallet, or several wallets, is rejected address_out_mismatch and credits nothing", async () => {
    const s = await space();
    const url = await addressOf(s);
    const sent = await double.deposit(url, { value: "10", addressOut: STRANGER_WALLET }).confirmed();
    assert.equal(sent.status, 200);
    assert.equal(sent.responseBody, "*ok*");

    const made = double.addresses.find((a) => a.callback === url)!;
    const several = await double.send(url, confirmedFields({
      uuid: randomUUID(), addressIn: made.addressIn, txid: `0x${randomUUID()}`, coin: "base_usdc", value: "20",
      addressOut: { name: "address_out", type: "convert", value: { [WALLETS.evm]: "0.5", [STRANGER_WALLET]: "0.5" } },
    }), { convert: "object" });
    assert.equal(several.status, 200, several.responseBody);
    assert.equal(several.responseBody, "*ok*");

    const rows = await deposits(s);
    assert.deepEqual(rows.map((r) => [r.state, r.reason]), [["rejected", "address_out_mismatch"], ["rejected", "address_out_mismatch"]]);
    assert.equal(await balance(s.id), 0);
    assert.deepEqual(await ledger(s.id), []);
  });

  test("4b. an EVM wallet or address in another letter case is the same one: credited", async () => {
    const s = await space();
    const url = await addressOf(s);
    const made = double.addresses.find((a) => a.callback === url)!;
    const upper = (a: string) => `0x${a.slice(2).toUpperCase()}`;
    const sent = await double.deposit(url, { value: "10", addressOut: upper(WALLETS.evm), addressIn: upper(made.addressIn) }).confirmed();
    assert.equal(sent.responseBody, "*ok*");
    assert.deepEqual((await deposits(s)).map((r) => r.state), ["confirmed"]);
    assert.equal(await balance(s.id), 9_900_000);
  });

  test("5. another address_in is rejected address_in_mismatch", async () => {
    const s = await space();
    const url = await addressOf(s);
    const sent = await double.deposit(url, { value: "10", addressIn: `0x${"ee".repeat(20)}` }).confirmed();
    assert.equal(sent.responseBody, "*ok*");
    assert.deepEqual((await deposits(s)).map((r) => [r.state, r.reason]), [["rejected", "address_in_mismatch"]]);
    assert.equal(await balance(s.id), 0);
  });

  test("6. a mac no address has, or another SPACE or coin segment, is answered *ok* and records nothing; no_match logs the address and transaction", async () => {
    const s = await space();
    const url = await addressOf(s);
    const other = await space();
    const wrongMac = url.replace(/[^/]+$/, "A".repeat(43));
    const wrongSpace = url.replace(s.id, other.id);
    const wrongCoin = url.replace("/base_usdc/", "/base_usdt/");
    const out = await written("stdout", async () => {
      for (const target of [wrongMac, wrongSpace, wrongCoin]) {
        const sent = await double.deposit(target, { value: "10", ticker: "base/usdc", addressOut: WALLETS.evm, txidIn: `tx-${target.length}` }).confirmed();
        assert.equal(sent.status, 200, sent.responseBody);
        assert.equal(sent.responseBody, "*ok*");
      }
    });
    assert.deepEqual(await deposits(s), []);
    assert.deepEqual(await deposits(other), []);
    assert.equal(await balance(s.id), 0);
    const lines = callbackLines(out);
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.equal(line.outcome, "no_match");
      assert.match(line.address_in, /^0x[0-9a-f]{40}$/);
      assert.match(line.txid_in, /^tx-/);
      assert.equal(line.space_id, null);
    }
    const [row] = await fixture.owner<{ mac: string }[]>`select callback_mac as mac from schellingaf.funding_addresses where space_id = ${s.id}::uuid`;
    assert.ok(!out.includes(row!.mac), "the mac reached stdout");
    assert.ok(!out.includes(WALLETS.evm) && !out.includes(WALLETS.evm.toLowerCase()), "a wallet reached stdout");
  });

  test("7. one confirmed callback sent twice, and twice at once, credits once", async () => {
    const s = await space();
    const url = await addressOf(s);
    const dep = double.deposit(url, { value: "10" });
    const first = await dep.confirmed();
    const second = await dep.confirmed();
    assert.deepEqual([first.responseBody, second.responseBody], ["*ok*", "*ok*"]);
    assert.equal((await deposits(s)).length, 1);
    assert.equal((await ledger(s.id)).length, 1);
    assert.equal(await balance(s.id), 9_900_000);

    const t = await space();
    const tUrl = await addressOf(t);
    const both = double.deposit(tUrl, { value: "10" });
    const out = await written("stdout", async () => {
      const answers = await Promise.all([both.confirmed(), both.confirmed()]);
      assert.deepEqual(answers.map((a) => [a.status, a.responseBody]), [[200, "*ok*"], [200, "*ok*"]]);
    });
    assert.deepEqual(callbackLines(out).map((l) => l.outcome).sort(), ["credited", "replay"]);
    assert.equal((await deposits(t)).length, 1);
    assert.equal((await ledger(t.id)).length, 1);
    assert.equal(await balance(t.id), 9_900_000);
  });

  test("8. the same transaction confirmed again under a new uuid, with the same values, is a replay, credited once", async () => {
    const s = await space();
    const url = await addressOf(s);
    const txidIn = `0x${"12".repeat(32)}`;
    const txidOut = `0x${"13".repeat(32)}`;
    await double.deposit(url, { value: "10", txidIn, txidOut }).confirmed();
    const out = await written("stdout", () => double.deposit(url, { value: "10", txidIn, txidOut, uuid: randomUUID() }).confirmed());
    assert.deepEqual(callbackLines(out).map((l) => l.outcome), ["replay"]);
    assert.equal((await deposits(s)).length, 1);
    assert.equal((await ledger(s.id)).length, 1);
    assert.equal(await balance(s.id), 9_900_000);
  });

  test("8b. a second payment in one transaction, another value or forwarding under a new uuid, is held conflict with its values logged; the runbook releases it only forced", async () => {
    const s = await space();
    const url = await addressOf(s);
    const txidIn = `0x${"14".repeat(32)}`;
    await double.deposit(url, { value: "10", txidIn, txidOut: `0x${"15".repeat(32)}` }).confirmed();
    const second = double.deposit(url, { value: "20", txidIn, txidOut: `0x${"16".repeat(32)}` });
    const third = double.deposit(url, { value: "10", txidIn, txidOut: `0x${"17".repeat(32)}` });
    const out = await written("stdout", async () => {
      assert.equal((await second.confirmed()).responseBody, "*ok*");
      assert.equal((await third.confirmed()).responseBody, "*ok*");
      await second.confirmed();
    });
    const lines = callbackLines(out);
    assert.deepEqual(lines.map((l) => l.outcome), ["conflict", "conflict", "replay"]);
    assert.deepEqual([lines[0].txid_in, lines[0].txid_out, lines[0].value_forwarded_coin], [txidIn, `0x${"16".repeat(32)}`, "19.8"]);
    const rows = await deposits(s);
    assert.deepEqual(rows.map((r) => [r.state, r.reason, r.usd_micro]), [
      ["confirmed", null, "9900000"],
      ["held", "conflict", "19800000"],
      ["held", "conflict", "9900000"],
    ]);
    assert.equal(rows[1]!.confirmed_uuid, second.uuid);
    assert.equal(await balance(s.id), 9_900_000);

    const held = rows[1]!.deposit_id;
    const values = { "<deposit_id>": held, "<amount in micro-dollars>": "19800000", "<why, in a sentence>": "a second payment, checked on the chain" };
    await assert.rejects(runbook("release", values), /INVALID_REQUEST/);
    assert.equal(await balance(s.id), 9_900_000);
    const [entry] = await runbook("release forced", values);
    assert.equal(entry!.credited_space, s.id);
    assert.equal(await balance(s.id), 29_700_000);
    assert.deepEqual((await deposits(s)).map((r) => r.state), ["confirmed", "confirmed", "held"]);
  });

  test("9. the callback's coin decides: another family is held, an unknown coin is held, another token of the family is credited", async () => {
    const s = await space();
    const url = await addressOf(s, "base/usdc");
    const send = (coin: string, extra: { usd?: string | null } = {}) => double.deposit(url, { value: "10", coin, ...extra }).confirmed();
    await send("btc");
    await send("base_xyz");
    await send("base_usdt");
    await send("base_eth", { usd: "3.17" });
    const p = await space();
    const pol = await addressOf(p, "polygon/pol");
    await double.deposit(pol, { value: "10", usd: null }).confirmed();

    const rows = await deposits(s);
    assert.deepEqual(rows.map((r) => [r.coin, r.state, r.reason]), [
      ["btc", "held", "wrong_family"],
      ["base_xyz", "held", "unknown_coin"],
      ["base_usdt", "confirmed", null],
      ["base_eth", "confirmed", null],
    ]);
    // base_usdt one for one (9.9 forwarded); base_eth at the convert field's USD.
    assert.deepEqual((await ledger(s.id)).map((e) => e.amount), [9_900_000, 3_170_000]);
    assert.equal(await balance(s.id), 13_070_000);
    assert.deepEqual((await deposits(p)).map((r) => [r.state, r.reason]), [["held", "no_usd_value"]]);
    assert.equal(await balance(p.id), 0);
  });

  test("10. a pending callback never confirmed is recorded pending and credits nothing", async () => {
    const s = await space();
    const url = await addressOf(s);
    const sent = await double.deposit(url, { value: "10" }).pending();
    assert.equal(sent.responseBody, "*ok*");
    const rows = await deposits(s);
    assert.deepEqual(rows.map((r) => r.state), ["pending"]);
    assert.equal(await balance(s.id), 0);
    assert.deepEqual(await ledger(s.id), []);
  });

  test("11. pending then confirmed, under one uuid or two, credits once", async () => {
    const s = await space();
    const url = await addressOf(s);
    const same = double.deposit(url, { value: "10" });
    await same.pending();
    await same.confirmed();
    const txidIn = `0x${"34".repeat(32)}`;
    const pendingUuid = randomUUID();
    const confirmedUuid = randomUUID();
    await double.deposit(url, { value: "20", txidIn, uuid: pendingUuid }).pending();
    await double.deposit(url, { value: "20", txidIn, uuid: confirmedUuid }).confirmed();
    await double.deposit(url, { value: "20", txidIn, uuid: pendingUuid }).pending();

    const rows = await deposits(s);
    assert.deepEqual(rows.map((r) => r.state), ["confirmed", "confirmed"]);
    assert.equal(rows[0]!.pending_uuid, same.uuid);
    assert.equal(rows[0]!.confirmed_uuid, same.uuid);
    assert.equal(rows[1]!.pending_uuid, pendingUuid);
    assert.equal(rows[1]!.confirmed_uuid, confirmedUuid);
    assert.deepEqual((await ledger(s.id)).map((e) => e.amount), [9_900_000, 19_800_000]);
  });

  test("12. a confirmed callback with no pending one is credited, and a later pending one changes nothing", async () => {
    const s = await space();
    const url = await addressOf(s);
    const dep = double.deposit(url, { value: "10" });
    await dep.confirmed();
    const out = await written("stdout", async () => {
      await double.deposit(url, { value: "10", txidIn: dep.txidIn, uuid: randomUUID() }).pending();
      await dep.pending();
    });
    assert.deepEqual(callbackLines(out).map((l) => l.outcome), ["pending_ignored", "replay"]);
    const rows = await deposits(s);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "confirmed");
    assert.equal(rows[0]!.pending_uuid, null, "the uuid is only in confirmed_uuid");
    assert.equal(rows[0]!.confirmed_uuid, dep.uuid);
    assert.equal(await balance(s.id), 9_900_000);
  });

  test("13. a second coin in a transaction already credited is held txid_credited", async () => {
    const s = await space();
    const url = await addressOf(s);
    const txidIn = `0x${"56".repeat(32)}`;
    await double.deposit(url, { value: "10", txidIn }).confirmed();
    await double.deposit(url, { value: "10", txidIn, coin: "base_usdt" }).confirmed();
    assert.deepEqual((await deposits(s)).map((r) => [r.coin, r.state, r.reason]), [
      ["base_usdc", "confirmed", null],
      ["base_usdt", "held", "txid_credited"],
    ]);
    assert.equal((await ledger(s.id)).length, 1);
  });

  test("13b. the runbook's release of a deposit whose transaction already credited the address is refused, and forced it credits", async () => {
    const s = await space();
    const url = await addressOf(s);
    const txidIn = `0x${"57".repeat(32)}`;
    await double.deposit(url, { value: "10", txidIn }).confirmed();
    await double.deposit(url, { value: "10", txidIn, coin: "base_usdt" }).confirmed();
    const held = (await deposits(s))[1]!;
    assert.equal(held.reason, "txid_credited");
    const values = { "<deposit_id>": held.deposit_id, "<amount in micro-dollars>": "9900000", "<why, in a sentence>": "a test of the runbook" };
    await assert.rejects(runbook("release", values), /INVALID_REQUEST/);
    assert.equal(await balance(s.id), 9_900_000);
    await runbook("release forced", values);
    assert.equal(await balance(s.id), 19_800_000);
  });

  test("13c. funding_callback() refuses fields that are not its signed body's, an amount not the coin's own, and a call with no review ceiling", async () => {
    const s = await space();
    await addressOf(s);
    const [a] = await fixture.owner<{ mac: string; address_in: string; address_out: string }[]>`
      select callback_mac as mac, address_in, address_out from schellingaf.funding_addresses where space_id = ${s.id}::uuid`;
    const OTHER_WALLET = `0x${"0b".repeat(20)}`;
    // Signed as the provider signs, so the audit finds the row this makes true.
    const body = (uuid: string, txid: string, o: { coin?: string | undefined; usd?: string | undefined }) => JSON.stringify({
      uuid, address_in: a!.address_in, address_out: a!.address_out, txid_in: txid, txid_out: "0xout",
      value_coin: 200, value_forwarded_coin: 200, fee_coin: 0, coin: o.coin ?? "base_usdc", pending: 0, price: 1,
      ...(o.usd === undefined ? {} : { value_forwarded_coin_convert: JSON.stringify({ USD: o.usd }) }),
    });
    type Send = {
      uuid?: string; bodyUuid?: string; txid: string; bodyTxid?: string; coin?: string; bodyCoin?: string; addressIn?: string;
      addressOut?: string; pending?: boolean; forwarded?: string; txidOut?: string; stable?: boolean | null;
      usd?: string; bodyUsd?: string; review?: string | null;
    };
    const send = (o: Send) => {
      const uuid = o.uuid ?? randomUUID();
      const text = body(o.bodyUuid ?? uuid, o.bodyTxid ?? o.txid, { coin: o.bodyCoin ?? (o.coin === "base_eth" ? "base_eth" : undefined), usd: o.bodyUsd });
      return db.write<{ outcome: string }[]>`
        select f.outcome from schellingaf.funding_callback(
          ${a!.mac}, ${s.id}::uuid, 'base_usdc', ${uuid}::uuid, ${o.pending ?? false}, ${o.addressIn ?? a!.address_in}, ${o.addressOut ?? a!.address_out},
          ${o.txid}, ${o.coin ?? "base_usdc"}, 'evm', ${o.stable === undefined ? true : o.stable}::boolean, ${o.usd ?? "200000000"}::bigint, null,
          200::numeric, ${o.forwarded ?? "200"}::numeric, 0::numeric, 1::numeric, 1, ${o.txidOut ?? "0xout"},
          ${Buffer.from(text)}, ${double.sign(text)}, ${o.review === undefined ? "1000000000000" : o.review}::bigint) f`;
    };
    const tx = () => `0x${randomUUID().replace(/-/g, "")}`;
    for (const wrong of [
      { txid: tx(), usd: "300000000" },
      { txid: tx(), bodyTxid: tx() },
      { txid: tx(), coin: "base_usdt" },
      { txid: tx(), addressIn: `0x${"ab".repeat(20)}` },
      { txid: tx(), bodyUuid: randomUUID() },
      { txid: tx(), review: null },
      // The four the body says otherwise: pending, the wallet, the value forwarded (with an
      // amount true to the value given) and the forwarding transaction.
      { txid: tx(), pending: true },
      { txid: tx(), addressOut: OTHER_WALLET },
      { txid: tx(), forwarded: "300", usd: "300000000" },
      { txid: tx(), txidOut: "0xother" },
      // A stablecoin is its forwarded value, never the convert field's USD.
      { txid: tx(), bodyUsd: "199.5", usd: "199500000" },
      // Any other coin is the convert field's USD, never its forwarded value.
      { txid: tx(), coin: "base_eth", stable: false, bodyUsd: "400", usd: "200000000" },
      // A coin whose kind the call does not say has no amount to check against.
      { txid: tx(), stable: null },
    ] satisfies Send[]) {
      await assert.rejects(send(wrong), /INTERNAL/, JSON.stringify(wrong));
    }
    assert.deepEqual(await deposits(s), []);
    assert.equal(await balance(s.id), 0);
    const [ok] = await send({ txid: tx() });
    assert.equal(ok!.outcome, "credited");
    const [eth] = await send({ txid: tx(), coin: "base_eth", stable: false, bodyUsd: "400", usd: "400000000" });
    assert.equal(eth!.outcome, "credited");
    assert.equal(await balance(s.id), 600_000_000);
  });

  test("14. a deposit worth more than $100 is held for review; the runbook's release credits it once, and again is refused", async () => {
    assert.equal(FUNDING.depositReviewMicro, 100_000_000);
    const s = await space();
    const url = await addressOf(s);
    // 100.98 forwarded: over. 100 exactly: not.
    await double.deposit(url, { value: "102" }).confirmed();
    await double.deposit(url, { value: "100", fee: "0" }).confirmed();
    const rows = await deposits(s);
    assert.deepEqual(rows.map((r) => [r.state, r.reason, r.usd_micro]), [["held", "review", "100980000"], ["confirmed", null, "100000000"]]);
    assert.equal(await balance(s.id), 100_000_000);

    const held = rows[0]!.deposit_id;
    const release = () => runbook("release", { "<deposit_id>": held, "<amount in micro-dollars>": "100980000", "<why, in a sentence>": "a test of the runbook" });
    const [entry] = await release();
    assert.equal(entry!.credited_space, s.id);
    assert.equal(await balance(s.id), 200_980_000);
    const after = (await deposits(s))[0]!;
    assert.equal(after.state, "confirmed");
    assert.equal(after.reason, null);
    await assert.rejects(release(), /INVALID_REQUEST/);
    assert.equal(await balance(s.id), 200_980_000);
    assert.deepEqual((await ledger(s.id)).map((e) => e.key).sort(), [`deposit:cryptapi:${held}`, `deposit:cryptapi:${rows[1]!.deposit_id}`].sort());
  });

  test("15. a replaced SPACE's address credits its successor, and the deposit names both", async () => {
    const s = await space();
    const url = await addressOf(s);
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${s.name}, ${next}, 'a test')`;
    const [successor] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${next}`;
    await double.deposit(url, { value: "10" }).confirmed();
    const [row] = await deposits(s);
    assert.equal(row!.space_id, s.id);
    assert.equal(row!.credited_space, successor!.id);
    assert.equal(await balance(successor!.id), 9_900_000);
    assert.equal(await balance(s.id), 0);
  });

  test("16. a body over 16 KiB is 413 with Connection: close, before its signature is read", async () => {
    const s = await space();
    const url = await addressOf(s);
    const res = await fund.request(new URL(url).pathname, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(16 * 1024 + 1) },
      body: "x".repeat(16 * 1024 + 1),
    });
    assert.equal(res.status, 413);
    assert.equal(res.headers.get("connection"), "close");
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "TOO_LARGE");
    // Over the socket too, unsigned: refused for its size, not its signature.
    const real = await fetch(url, { method: "POST", body: "x".repeat(16 * 1024 + 1) });
    assert.equal(real.status, 413);
    assert.deepEqual(await deposits(s), []);
  });

  test("17. a signed body that is not JSON, or lacks txid_in, is 400 and records nothing", async () => {
    const s = await space();
    const url = await addressOf(s);
    const form = await double.deposit(url, { value: "10" }).confirmed({ mode: "form" });
    assert.equal(form.status, 400);
    assert.equal(JSON.parse(form.responseBody).error.code, "INVALID_REQUEST");
    const made = double.addresses.find((a) => a.callback === url)!;
    const lacking = await double.send(url, confirmedFields({
      uuid: randomUUID(), addressIn: made.addressIn, txid: "unused", coin: "base_usdc", value: "10",
      addressOut: { name: "address_out", type: "string", value: WALLETS.evm }, omit: "txid_in",
    }));
    assert.equal(lacking.status, 400);
    assert.match(JSON.parse(lacking.responseBody).error.detail, /txid_in/);
    assert.deepEqual(await deposits(s), []);
  });

  test("18. while read-only the callback is 503 and nothing is written; sent again after, it is credited", async () => {
    const s = await space();
    const url = await addressOf(s);
    const dep = double.deposit(url, { value: "10" });
    current = createApp({ ...fundConfig, readOnly: true }, db);
    try {
      const sent = await dep.confirmed();
      assert.equal(sent.status, 503);
      assert.equal(JSON.parse(sent.responseBody).error.code, "SERVICE_READ_ONLY");
    } finally {
      current = fund;
    }
    assert.deepEqual(await deposits(s), []);
    assert.equal((await dep.confirmed()).responseBody, "*ok*");
    assert.equal(await balance(s.id), 9_900_000);
  });

  test("19. a failure after the signature is a 5xx that leaves nothing, the exception log has no mac, and the retry is credited", async () => {
    const s = await space();
    const url = await addressOf(s);
    const mac = url.split("/").at(-1)!;
    const dep = double.deposit(url, { value: "10" });
    await fixture.owner.unsafe(`
      create function schellingaf.test_ledger_fails() returns trigger language plpgsql as $$
      begin raise exception 'the test made the ledger fail'; end $$`);
    await fixture.owner.unsafe(`
      create trigger test_ledger_fails before insert on schellingaf.credit_ledger
      for each row execute function schellingaf.test_ledger_fails()`);
    let errors = "";
    try {
      errors = await written("stderr", async () => {
        const sent = await dep.confirmed();
        assert.equal(sent.status, 500);
        assert.notEqual(sent.responseBody, "*ok*");
      });
    } finally {
      await fixture.owner.unsafe("drop trigger test_ledger_fails on schellingaf.credit_ledger");
      await fixture.owner.unsafe("drop function schellingaf.test_ledger_fails()");
    }
    assert.deepEqual(await deposits(s), [], "the deposit row was rolled back with the credit");
    // The exception log's line (advisor change 1): the path is there, its mac is not.
    assert.match(errors, /POST \/funding\/cryptapi\/[0-9a-f-]{36}\/base_usdc\/- /);
    assert.ok(!errors.includes(mac), "the mac reached the exception log");

    assert.equal((await dep.confirmed()).responseBody, "*ok*");
    assert.equal(await balance(s.id), 9_900_000);
    assert.equal((await ledger(s.id)).length, 1);
  });

  test("19b. a deadlock's line writes a callback's path with its mac replaced", async () => {
    const mac = "M".repeat(43);
    const path = `/funding/cryptapi/${randomUUID()}/base_usdc/${mac}`;
    const context = { get: () => "a-request-id", req: { method: "POST", path } } as unknown as Parameters<typeof logDeadlock>[0];
    const errors = await written("stderr", async () => logDeadlock(context, "answered BUSY"));
    assert.ok(errors.includes("/base_usdc/- 40P01"), errors);
    assert.ok(!errors.includes(mac));
    assert.equal(loggedPath("/v1/spaces/x/posts"), "/v1/spaces/x/posts");
  });

  test("20. numbers sent as strings credit the same as numbers", async () => {
    const s = await space();
    const url = await addressOf(s);
    await double.deposit(url, { value: "10.123456789" }).confirmed({ numbers: "string" });
    await double.deposit(url, { value: "10.123456789" }).confirmed();
    await double.deposit(url, { value: "0.01", coin: "base_eth", usd: "25.0000009" }).confirmed({ numbers: "string", convert: "object" });
    const amounts = (await ledger(s.id)).map((e) => e.amount);
    // 10.123456789 less 1%: 10.02222222111 forwarded, floored to the micro-dollar.
    assert.deepEqual(amounts, [10_022_222, 10_022_222, 25_000_000]);
  });

  test("21. *ok* is answered only after the transaction committed", async () => {
    const s = await space();
    const url = await addressOf(s);
    // A deferred trigger runs at commit: this one makes the commit take a second.
    await fixture.owner.unsafe(`
      create function schellingaf.test_slow_commit() returns trigger language plpgsql as $$
      begin perform pg_sleep(1); return null; end $$`);
    await fixture.owner.unsafe(`
      create constraint trigger test_slow_commit after insert on schellingaf.funding_deposits
      deferrable initially deferred for each row execute function schellingaf.test_slow_commit()`);
    try {
      const began = Date.now();
      let answered = false;
      const sending = double.deposit(url, { value: "10" }).confirmed().then((sent) => {
        answered = true;
        return sent;
      });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(answered, false, "answered while the commit was still running");
      assert.equal(await balance(s.id), 0);
      const sent = await sending;
      assert.equal(sent.responseBody, "*ok*");
      assert.ok(Date.now() - began >= 1000);
      // Answered, so committed: another connection sees the credit at once.
      assert.equal(await balance(s.id), 9_900_000);
    } finally {
      await fixture.owner.unsafe("drop trigger test_slow_commit on schellingaf.funding_deposits");
      await fixture.owner.unsafe("drop function schellingaf.test_slow_commit()");
    }
  });

  test("22. no per-address limit counts callbacks: 200 in a row are all *ok*, where 200 anonymous reads are refused", async () => {
    const s = await space();
    const url = await addressOf(s);
    const statuses = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const sent = await double.deposit(url, { value: "1" }).pending();
      statuses.add(`${sent.status} ${sent.responseBody}`);
    }
    assert.deepEqual([...statuses], ["200 *ok*"]);
    assert.equal((await deposits(s)).length, 200);
    let limited = 0;
    for (let i = 0; i < 200; i++) {
      const res = await fetch(`${origin}/v1/numbers`);
      await res.arrayBuffer();
      // The anonymous read ceiling answers BUSY.
      if (res.status === 503) limited++;
    }
    assert.ok(limited > 0, "the anonymous read limit is live here");
  });

  test("24. a callback takes a place in the global gate: with the gate full, the next is refused RATE_LIMITED, which the provider retries", async () => {
    const s = await space();
    const url = await addressOf(s);
    const gated = await withEnv({ GLOBAL_CONCURRENT_READS: "1", GLOBAL_READ_QUEUE: "1", GLOBAL_READ_WAIT_MS: "1" }, () => createApp(fundConfig, db));
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // The address row held, so the first callback waits in the database, in its place.
    const holding = fixture.owner.begin(async (tx) => {
      await tx`select 1 from schellingaf.funding_addresses where space_id = ${s.id}::uuid for update`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    current = gated;
    try {
      const first = double.deposit(url, { value: "10" }).confirmed();
      await new Promise((r) => setTimeout(r, 200));
      const second = await double.deposit(url, { value: "20" }).confirmed();
      assert.equal(second.status, 429, second.responseBody);
      assert.equal(JSON.parse(second.responseBody).error.code, "RATE_LIMITED");
      release.resolve();
      await holding;
      assert.equal((await first).responseBody, "*ok*");
    } finally {
      release.resolve();
      await holding.catch(() => {});
      current = fund;
    }
    assert.equal(await balance(s.id), 9_900_000);
  });

  test("25. a callback sent as a GET is 503 and logs outcome get, without its mac, and records nothing", async () => {
    const s = await space();
    const url = await addressOf(s);
    const [row] = await fixture.owner<{ mac: string }[]>`select callback_mac as mac from schellingaf.funding_addresses where space_id = ${s.id}::uuid`;
    let sent: Awaited<ReturnType<Deposit["confirmed"]>> | undefined;
    const out = await written("stdout", async () => {
      sent = await double.deposit(url, { value: "10" }).confirmed({ mode: "get" });
    });
    assert.equal(sent!.status, 503);
    assert.equal(JSON.parse(sent!.responseBody).error.code, "FUNDING_UNAVAILABLE");
    assert.deepEqual(callbackLines(out).map((l) => [l.outcome, l.space_id]), [["get", s.id]]);
    assert.ok(!out.includes(row!.mac), "the mac reached stdout");
    assert.deepEqual(await deposits(s), []);
  });

  test("25b. a GET whose URL is not an address's own is answered 404, as a path with no operation, and logs nothing", async () => {
    const s = await space();
    const url = await addressOf(s);
    const path = new URL(url).pathname;
    const [, , , spaceId, coin, mac] = path.split("/");
    const other = await space();
    const out = await written("stdout", async () => {
      for (const wrong of [
        `/funding/cryptapi/${spaceId}/${coin}/${"A".repeat(43)}`,
        `/funding/cryptapi/${other.id}/${coin}/${mac}`,
        `/funding/cryptapi/${spaceId}/base_usdt/${mac}`,
        `/funding/cryptapi/not-a-space/${coin}/${mac}`,
        `/funding/cryptapi/${spaceId}/${coin}/short`,
      ]) {
        const res = await fund.request(wrong);
        assert.equal(res.status, 404, wrong);
        assert.equal(((await res.json()) as { error: { message: string } }).error.message, "INVALID_REQUEST. There is no operation at that path.");
      }
    });
    assert.deepEqual(callbackLines(out), []);
    // The address's own URL is logged.
    const own = await written("stdout", async () => assert.equal((await fund.request(path)).status, 503));
    assert.deepEqual(callbackLines(own).map((l) => [l.outcome, l.space_id]), [["get", s.id]]);
  });

  test("27. fields the database finds are not the signed body's are 500, logged mismatch with the uuid, coin, address and transaction alone, and recorded nowhere; once mended, the same callback is credited", async () => {
    const s = await space();
    const url = await addressOf(s);
    const mac = url.split("/").at(-1)!;
    const [made] = await fixture.owner<{ address_in: string }[]>`select address_in from schellingaf.funding_addresses where space_id = ${s.id}::uuid`;
    const txidIn = randomBytes(32).toString("hex");
    const dep = double.deposit(url, { value: "10", txidIn });
    // A fault in reading the body, played by giving funding_callback() another txid_in than
    // the one signed: the function refuses it.
    const write = db.write;
    const faulty = new Proxy(write, {
      apply(fn, self, args: unknown[]) {
        const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
        if (!strings.join("").includes("funding_callback(")) return Reflect.apply(fn, self, args);
        return Reflect.apply(fn, self, [strings, ...values.map((v) => (v === txidIn ? `${txidIn}0` : v))]);
      },
    });
    const faultyDb = new Proxy(db, { get: (target, key, receiver) => (key === "write" ? faulty : Reflect.get(target, key, receiver)) }) as Db;
    current = createApp(fundConfig, faultyDb);
    let sent: Awaited<ReturnType<Deposit["confirmed"]>> | undefined;
    let out = "";
    try {
      out = await written("stdout", async () => {
        sent = await dep.confirmed();
      });
    } finally {
      current = fund;
    }
    assert.equal(sent!.status, 500);
    assert.equal(JSON.parse(sent!.responseBody).error.code, "INTERNAL");
    const lines = callbackLines(out);
    assert.deepEqual(lines, [{
      event: "funding.callback", outcome: "mismatch", uuid: dep.uuid, coin: "base_usdc", address_in: made!.address_in, txid_in: txidIn,
    }]);
    assert.ok(!out.includes(mac), "the mac reached stdout");
    assert.ok(!out.includes(WALLETS.evm), "a wallet reached stdout");
    assert.ok(!out.includes(sent!.signature ?? "no signature"), "the signature reached stdout");
    assert.deepEqual(await deposits(s), []);
    assert.equal(await balance(s.id), 0);

    assert.equal((await dep.confirmed()).responseBody, "*ok*");
    assert.equal(await balance(s.id), 9_900_000);
  });

  test("26. past the request log's daily ceiling a verified callback's line is still written", async () => {
    const s = await space();
    const url = await addressOf(s);
    const full = join(dir, "log-full");
    mkdirSync(full);
    const filler = JSON.stringify({ filler: "x".repeat(4096) }) + "\n";
    for (const offset of [0, 86_400_000]) writeFileSync(join(full, `requests-${new Date(Date.now() + offset).toISOString().slice(0, 10)}.jsonl`), filler);
    await withEnv({ LOG_BYTES_PER_DAY: "1024" }, async () => {
      current = createApp({ ...fundConfig, logDir: full }, db);
      try {
        assert.equal((await double.deposit(url, { value: "10" }).confirmed()).responseBody, "*ok*");
        let lines: string[] = [];
        for (let i = 0; i < 50 && lines.length === 0; i++) {
          lines = readdirSync(full).flatMap((f) => readFileSync(join(full, f), "utf8").split("\n")).filter((l) => l.includes('"deposit"'));
          if (lines.length === 0) await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(lines.length, 1, "the callback's line was not written past the ceiling");
        assert.equal(JSON.parse(lines[0]!).deposit.outcome, "credited");
      } finally {
        current = fund;
      }
    });
  });

  test("23. the request log writes a verified callback with its outcome and the mac replaced", async () => {
    const s = await space();
    const url = await addressOf(s);
    await double.deposit(url, { value: "10" }).confirmed();
    const macs = (await fixture.owner<{ mac: string }[]>`select callback_mac as mac from schellingaf.funding_addresses`).map((r) => r.mac);
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines = readdirSync(logDir).filter((f) => f.startsWith("requests-"))
        .flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n"))
        .filter((l) => l.includes("/funding/cryptapi/"));
      if (lines.some((l) => JSON.parse(l).deposit?.outcome === "credited")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(lines.length > 0, "no callback line in the request log");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.match(parsed.path, /\/-$/);
      for (const mac of macs) assert.ok(!line.includes(mac), "a mac reached the request log");
    }
    assert.ok(lines.some((l) => JSON.parse(l).deposit?.outcome === "credited"));
  });
});

/** The runbook's SQL between `-- <name> begin` and `-- <name> end`, its placeholders filled, run as the owner. */
async function runbook(name: string, values: Record<string, string>) {
  const lines = readFileSync(new URL("../runbooks/credit.md", import.meta.url), "utf8").split("\n").map((l) => l.trim());
  const from = lines.indexOf(`-- ${name} begin`);
  const to = lines.indexOf(`-- ${name} end`);
  assert.ok(from >= 0 && to > from, `the runbook marks ${name}`);
  let text = lines.slice(from + 1, to).join("\n");
  for (const [k, v] of Object.entries(values)) text = text.split(k).join(v);
  assert.doesNotMatch(text, /<[a-z ]+>/, "every placeholder is filled");
  return [...(await fixture.owner.unsafe(text))] as unknown as { entry_id: string; balance_after_micro: string; credited_space: string }[];
}

describe("the ledger", () => {
  test("each credit's key is deposit:cryptapi:<deposit_id>, and its entry is the deposit's", async () => {
    const rows = await fixture.owner<{ key: string; deposit_id: string; kind: string; same: boolean }[]>`
      select l.idempotency_key as key, d.deposit_id::text, l.kind, l.entry_id = d.entry_id as same
        from schellingaf.funding_deposits d join schellingaf.credit_ledger l on l.entry_id = d.entry_id`;
    assert.ok(rows.length > 10);
    for (const r of rows) {
      assert.equal(r.key, `deposit:cryptapi:${r.deposit_id}`);
      assert.equal(r.kind, "deposit");
    }
    const [orphans] = await fixture.owner<{ n: number }[]>`
      select count(*)::int as n from schellingaf.credit_ledger l
       where l.kind = 'deposit' and not exists (select 1 from schellingaf.funding_deposits d where d.entry_id = l.entry_id)`;
    assert.equal(orphans!.n, 0);
  });

  test("credit_post() and the release are the api role's to call never; funding_callback() and funding_credited_space() are, and the callback takes no kind", async () => {
    const grants = await fixture.owner<{ fn: string; api: boolean; public: boolean }[]>`
      select p.oid::regprocedure::text as fn,
             has_function_privilege('schellingaf_api', p.oid, 'execute') as api,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public
        from pg_proc p where p.pronamespace = 'schellingaf'::regnamespace
         and p.proname in ('credit_post', 'funding_callback', 'funding_release_held', 'funding_credited_space', 'funding_deposits_follow')
       order by p.proname`;
    assert.deepEqual(grants.map((g) => [g.fn.split("(")[0], g.api, g.public]), [
      ["credit_post", false, false],
      ["funding_callback", true, false],
      // Read by GET /v1/spaces/{name}/funding to name where a replaced SPACE's deposits go.
      ["funding_credited_space", true, false],
      ["funding_deposits_follow", false, false],
      ["funding_release_held", false, false],
    ]);
    const [args] = await fixture.owner<{ names: string[] }[]>`
      select p.proargnames as names from pg_proc p
       where p.pronamespace = 'schellingaf'::regnamespace and p.proname = 'funding_callback'`;
    assert.ok(!args!.names.some((a) => /kind/.test(a)), "funding_callback() takes a kind");
    const source = readFileSync(new URL("../migrations/0152_funding_deposits.sql", import.meta.url), "utf8");
    const calls = [...source.matchAll(/credit_post\(([^,]+),\s*'([a-z_]+)'/g)].map((m) => m[2]);
    assert.ok(calls.length >= 2);
    assert.deepEqual([...new Set(calls)], ["deposit"]);
  });
});

describe("the table", () => {
  test("the api role reads no row; no row is deleted, and a confirmed one is never changed", async () => {
    await assert.rejects(fixture.asCaller(null, (sql) => sql`select deposit_id from schellingaf.funding_deposits`), /permission denied/);
    const [row] = await fixture.owner<{ id: string }[]>`select deposit_id::text as id from schellingaf.funding_deposits where state = 'confirmed' limit 1`;
    await assert.rejects(fixture.owner`update schellingaf.funding_deposits set confirmations = 99 where deposit_id = ${row!.id}::uuid`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`update schellingaf.funding_deposits set state = 'held', reason = 'review', entry_id = null where deposit_id = ${row!.id}::uuid`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`delete from schellingaf.funding_deposits where deposit_id = ${row!.id}::uuid`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`truncate schellingaf.funding_deposits`, /IMMUTABLE_RECORD/);
  });
});

describe("the audit", () => {
  test("every credited or held deposit's kept body verifies; one altered by the owner fails, and the script says which", async () => {
    const clean = await auditDeposits(fixture.owner, double.publicKeyPem);
    assert.ok(clean.checked > 10);
    assert.deepEqual(clean.failed, []);

    const [row] = await fixture.owner<{ id: string }[]>`select deposit_id::text as id from schellingaf.funding_deposits where state = 'confirmed' limit 1`;
    await fixture.owner.begin(async (tx) => {
      await tx.unsafe("alter table schellingaf.funding_deposits disable trigger funding_deposits_follow");
      await tx`update schellingaf.funding_deposits set raw_confirmed = raw_confirmed || '\\x20'::bytea where deposit_id = ${row!.id}::uuid`;
      await tx.unsafe("alter table schellingaf.funding_deposits enable trigger funding_deposits_follow");
    });
    assert.deepEqual((await auditDeposits(fixture.owner, double.publicKeyPem)).failed, [row!.id]);

    const child = spawn(process.execPath, ["scripts/funding-audit.ts", "--key", pemFile], {
      cwd: path.join(import.meta.dirname, ".."),
      env: { PATH: process.env.PATH ?? "", DB_PORT: String(config.db.port), DB_NAME: fixture.name },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    const [code] = (await once(child, "exit")) as [number];
    assert.equal(code, 1);
    assert.match(stdout, /checked, 1 failed\n/);
    assert.ok(stdout.includes(row!.id));
  });
});

describe("the audit, row against body", () => {
  test("a credited row whose amount, transaction or uuid is not its body's fails, saying which; a release at the operator's amount does not", async () => {
    const s = await space();
    const url = await addressOf(s);
    for (let i = 0; i < 3; i++) await double.deposit(url, { value: "10" }).confirmed();
    await double.deposit(url, { value: "102" }).confirmed();
    const rows = await deposits(s);
    assert.equal(rows[3]!.reason, "review");
    await runbook("release", { "<deposit_id>": rows[3]!.deposit_id, "<amount in micro-dollars>": "50000000", "<why, in a sentence>": "a test of the audit" });
    const before = new Set((await auditDeposits(fixture.owner, double.publicKeyPem)).failed);

    await fixture.owner.begin(async (tx) => {
      await tx.unsafe("alter table schellingaf.funding_deposits disable trigger funding_deposits_follow");
      await tx`update schellingaf.funding_deposits set usd_micro = usd_micro + 1 where deposit_id = ${rows[0]!.deposit_id}::uuid`;
      await tx`update schellingaf.funding_deposits set txid_in = txid_in || 'f' where deposit_id = ${rows[1]!.deposit_id}::uuid`;
      await tx`update schellingaf.funding_deposits set confirmed_uuid = gen_random_uuid() where deposit_id = ${rows[2]!.deposit_id}::uuid`;
      await tx.unsafe("alter table schellingaf.funding_deposits enable trigger funding_deposits_follow");
    });
    const audit = await auditDeposits(fixture.owner, double.publicKeyPem);
    const fresh = audit.failed.filter((id) => !before.has(id));
    assert.deepEqual(fresh.map((id) => [id, audit.why[id]]).sort(), [
      [rows[0]!.deposit_id, "usd_micro"],
      [rows[1]!.deposit_id, "txid_in"],
      [rows[2]!.deposit_id, "uuid"],
    ].sort());
  });
});

describe("the provider's key at start", () => {
  test("CRYPTAPI_PUBKEY_PEM is the key /pubkey/ answered", () => {
    const saved = JSON.parse(readFileSync(new URL("./fixtures/cryptapi-pubkey.json", import.meta.url), "utf8")) as { pubkey: string };
    assert.equal(CRYPTAPI_PUBKEY_PEM, saved.pubkey);
    assert.equal(samePubkey(CRYPTAPI_PUBKEY_PEM, saved.pubkey.replace(/\n/g, "\r\n") + "\n"), true);
  });

  /** The service started as a process with `extra` set, until it logs funding.pubkey or `waitMs` passes: its stdout. */
  async function start(extra: Record<string, string>, waitMs: number): Promise<string> {
    const child = spawn(process.execPath, ["src/server.ts"], {
      cwd: path.join(import.meta.dirname, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PORT: "0",
        API_HOST: config.apiHost,
        PUBLIC_ORIGIN: config.publicOrigin,
        CHALLENGE_KEY: config.challengeKey.toString("utf8"),
        DB_HOST: config.db.host,
        DB_PORT: String(config.db.port),
        DB_NAME: config.db.database,
        DB_USER: config.db.username,
        DB_PASSWORD: API_PASSWORD,
        LOG_DIR: spawnLog,
        ...env(),
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    try {
      const began = Date.now();
      while (Date.now() - began < 20_000 && !/listening on \d+/.test(stdout)) await new Promise((r) => setTimeout(r, 50));
      assert.match(stdout, /listening on \d+/, `the service did not start: ${stderr}`);
      const listening = Date.now();
      while (Date.now() - listening < waitMs && !stdout.includes('"event":"funding.pubkey"')) await new Promise((r) => setTimeout(r, 50));
      return stdout;
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }
  let spawnLog: string;
  before(() => {
    spawnLog = join(dir, "spawn-log");
    mkdirSync(spawnLog);
  });
  const pubkeyLine = (out: string) => out.split("\n").filter((l) => l.includes('"event":"funding.pubkey"')).map((l) => JSON.parse(l));
  const pubkeyAsks = () => double.requests.filter((r) => r.path === "/pubkey/").length;

  test("the double's key against CRYPTAPI_PUBKEY_FILE is the same; another file's is not; the double closed is an error, and the service starts", async () => {
    assert.deepEqual(pubkeyLine(await start({}, 10_000)), [{ event: "funding.pubkey", same: true }]);

    const otherPem = join(dir, "other.pem");
    writeFileSync(otherPem, generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }));
    assert.deepEqual(pubkeyLine(await start({ CRYPTAPI_PUBKEY_FILE: otherPem }, 10_000)), [{ event: "funding.pubkey", same: false }]);

    const gone = await startCryptapiDouble();
    const goneBase = gone.base;
    await gone.close();
    assert.deepEqual(pubkeyLine(await start({ CRYPTAPI_BASE: goneBase }, 10_000)), [{ event: "funding.pubkey", error: "network" }]);
  });

  test("nothing asks for the key while read-only or while deposits are not open", async () => {
    const asked = pubkeyAsks();
    assert.deepEqual(pubkeyLine(await start({ READ_ONLY: "1" }, 1500)), []);
    assert.deepEqual(pubkeyLine(await start({ FUNDING_CALLBACK_SECRET: "" }, 1500)), []);
    assert.equal(pubkeyAsks(), asked);
  });
});
