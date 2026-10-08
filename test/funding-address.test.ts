// A SPACE's deposit address for a coin: POST /v1/spaces/{name}/funding/addresses. The
// configuration and its production-host guard (src/funding/config.ts), the callback URL and
// its mac (src/funding/callback-url.ts), the request to the provider
// (src/funding/cryptapi.ts), the route (src/http/funding.ts), its two allowances, and the
// table that keeps addresses (migrations/0151_funding_addresses.sql).
//
// Every request to the provider goes to the double in test/support/cryptapi-double.ts, or to
// a fetch that counts its calls and answers nothing, which proves where no request goes.
// Every wallet here is made up.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { useService, fixture, db, call, agent, read, testConfig, type Agent, type App } from "./lib/service.ts";
import { withEnv } from "./lib/env.ts";
import { createApp } from "../src/http/app.ts";
import { classifyBearer } from "../src/http/auth.ts";
import { startCryptapiDouble, type CryptapiDouble } from "./support/cryptapi-double.ts";
import { coinByTicker } from "../src/funding/coins.ts";
import {
  CRYPTAPI_LIVE_BASE, CRYPTAPI_TIMEOUT_MS, FUNDING_PRODUCTION_BASE, depositsOpen, fundingConfig, fundingConfigLine, type FundingConfig,
} from "../src/funding/config.ts";
import { callbackMac, callbackUrl } from "../src/funding/callback-url.ts";
import { createAddress, fetchPubkey, plainDecimal } from "../src/funding/cryptapi.ts";
import { CRYPTAPI_PUBKEY_PEM } from "../src/funding/cryptapi-pubkey.ts";
import { FUNDING_DEPOSIT_NOTICE } from "../src/http/funding.ts";
import * as sealed from "../content/sealed.mjs";

useService("funding_address");

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

/** The settings of a server whose provider is the double, with `over` on top. */
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

/** A fetch that answers nothing and counts every call: where it is given, no request may leave. */
function forbiddenFetch(): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  return { calls, fetch: (async (input: string | URL | Request) => { calls.push(String(input)); throw new Error("no request may leave here"); }) as typeof fetch };
}

/** A service on this file's database with deposits as `funding` sets them. */
const serviceWith = (funding: FundingConfig | undefined): App => createApp(testConfig(fixture.name, funding ? { funding } : {}), db);

let fund: App;

before(async () => {
  double = await startCryptapiDouble();
  dir = mkdtempSync(join(tmpdir(), "funding-address-"));
  pemFile = join(dir, "cryptapi.pem");
  writeFileSync(pemFile, double.publicKeyPem);
});
after(async () => {
  await double?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const newName = () => `fund-addr-${process.pid}-${n++}`;

async function space(owner: Agent, visibility: "public" | "private" = "public"): Promise<{ name: string; id: string }> {
  const name = newName();
  const out = await call("POST", "/v1/spaces", owner.token, { name, title: "Funding", visibility });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const [row] = await fixture.owner<{ id: string }[]>`select space_id::text as id from schellingaf.spaces where name = ${name}`;
  return { name, id: row!.id };
}

async function sealedSpace(): Promise<{ name: string; id: string }> {
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
  return { name, id: spaceId };
}

const ask = (name: string, who: Agent | null, body: unknown, on: App = fund) => call("POST", `/v1/spaces/${name}/funding/addresses`, who?.token, body, on);

const creates = () => double.requests.filter((r) => r.ticker !== null);

async function rows(spaceId: string) {
  const found = await fixture.owner<{ coin: string; address_in: string; address_out: string; callback_url: string; callback_mac: string }[]>`
    select coin, address_in, address_out, callback_url, callback_mac
      from schellingaf.funding_addresses where space_id = ${spaceId}::uuid order by created_at`;
  return found.map((r) => ({ ...r }));
}

async function bucket(key: string): Promise<number | null> {
  const [row] = await fixture.owner<{ tokens: number }[]>`select tokens from schellingaf.rate_buckets where key = ${key}`;
  return row ? Number(row.tokens) : null;
}

/** What the service wrote to stdout while `during` ran. */
async function stdoutDuring(during: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    await during();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

describe("the configuration and its production-host guard", () => {
  test("the provider itself, with a callback base on this machine: deposits are not open, and no request leaves", async () => {
    const owner = await agent();
    const s = await space(owner);
    const stub = forbiddenFetch();
    const cfg = fundingConfig(env({ CRYPTAPI_BASE: undefined, FUNDING_CALLBACK_BASE: "http://127.0.0.1:3011" }), FUNDING_PRODUCTION_BASE, stub);
    assert.equal(cfg.mode, "live");
    assert.equal(depositsOpen(cfg), false);
    assert.match(cfg.off!, /not both https:\/\/api\.schellingaf\.com/);
    const out = await ask(s.name, owner, { coin: "base/usdc" }, serviceWith(cfg));
    assert.equal(out.status, 503, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "FUNDING_UNAVAILABLE");
    assert.equal(out.body.error.detail, "deposits are not open on this server");
    assert.deepEqual(stub.calls, []);
  });

  test("the provider itself, with the production callback base but a local PUBLIC_ORIGIN: not open, and no request leaves", async () => {
    const owner = await agent();
    const s = await space(owner);
    const stub = forbiddenFetch();
    for (const base of [undefined, CRYPTAPI_LIVE_BASE, `${CRYPTAPI_LIVE_BASE}/`]) {
      const cfg = fundingConfig(env({ CRYPTAPI_BASE: base, FUNDING_CALLBACK_BASE: FUNDING_PRODUCTION_BASE }), "http://127.0.0.1:3011", stub);
      assert.equal(cfg.mode, "live");
      assert.equal(depositsOpen(cfg), false);
      const out = await ask(s.name, owner, { coin: "btc" }, serviceWith(cfg));
      assert.equal(out.body.error?.code, "FUNDING_UNAVAILABLE", JSON.stringify(out.body));
    }
    assert.deepEqual(stub.calls, []);
    assert.deepEqual(await rows(s.id), []);
  });

  test("only both bases on production open live deposits, and then the request goes to the provider", async () => {
    const owner = await agent();
    const s = await space(owner);
    const sent: string[] = [];
    // The provider's address, carried to the double: the one case a live request is sent.
    const relay = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(String(input));
      return fetch(String(input).replace(CRYPTAPI_LIVE_BASE, double.base), init);
    }) as typeof fetch;
    const cfg = fundingConfig(env({ CRYPTAPI_BASE: undefined, FUNDING_CALLBACK_BASE: FUNDING_PRODUCTION_BASE }), FUNDING_PRODUCTION_BASE, { fetch: relay });
    assert.equal(cfg.mode, "live");
    assert.equal(cfg.off, null);
    assert.equal(cfg.pubkeyPem, CRYPTAPI_PUBKEY_PEM, "live mode checks callbacks with the committed key, whatever the file says");
    const out = await ask(s.name, owner, { coin: "sol/usdc" }, serviceWith(cfg));
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.startsWith(`${CRYPTAPI_LIVE_BASE}/sol/usdc/create/?callback=${encodeURIComponent(`${FUNDING_PRODUCTION_BASE}/funding/cryptapi/${s.id}/sol_usdc/`)}`));
  });

  test("CRYPTAPI_BASE on another host turns deposits off; on this machine it is the double", () => {
    for (const base of ["https://cryptapi.example", "http://10.0.0.5:8080", "https://api.cryptapi.io.example", "ftp://127.0.0.1"]) {
      const cfg = fundingConfig(env({ CRYPTAPI_BASE: base }), ORIGIN, forbiddenFetch());
      assert.equal(cfg.mode, "off", base);
      assert.match(cfg.off!, /neither CryptAPI nor this machine/, base);
    }
    for (const base of ["http://127.0.0.1:9", "http://localhost:9", "http://[::1]:9", "https://localhost"]) {
      assert.equal(fundingConfig(env({ CRYPTAPI_BASE: base }), ORIGIN).mode, "double", base);
    }
  });

  test("the double needs a readable PEM key and an origin to call back", () => {
    assert.match(fundingConfig(env({ CRYPTAPI_PUBKEY_FILE: join(dir, "missing.pem") }), ORIGIN).off!, /CRYPTAPI_PUBKEY_FILE/);
    const notPem = join(dir, "not.pem");
    writeFileSync(notPem, "not a key");
    assert.match(fundingConfig(env({ CRYPTAPI_PUBKEY_FILE: notPem }), ORIGIN).off!, /CRYPTAPI_PUBKEY_FILE/);
    assert.match(fundingConfig(env({ FUNDING_CALLBACK_BASE: "https://x.test/a/path" }), ORIGIN).off!, /FUNDING_CALLBACK_BASE/);
    const open = fundingConfig(env({ FUNDING_CALLBACK_BASE: `${ORIGIN}/` }), ORIGIN);
    assert.equal(open.off, null);
    assert.equal(open.callbackBase, ORIGIN);
    assert.equal(open.pubkeyPem, double.publicKeyPem.trim());
  });

  test("a malformed wallet leaves its family out, and the service starts", async () => {
    const owner = await agent();
    const s = await space(owner);
    const cfg = fundingConfig(env({ FUNDING_WALLET_TRON: "TooShort", FUNDING_WALLET_BTC: `  ${WALLETS.btc}  `, FUNDING_WALLET_SOLANA: "" }), ORIGIN);
    assert.deepEqual(Object.keys(cfg.wallets).sort(), ["btc", "evm"]);
    assert.equal(cfg.wallets.btc, WALLETS.btc, "trimmed");
    const before = creates().length;
    const out = await ask(s.name, owner, { coin: "trc20/usdt" }, serviceWith(cfg));
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error.code, "COIN_NOT_OFFERED");
    assert.match(out.body.error.detail, /^not offered on this server/);
    assert.equal(creates().length, before);
  });

  test("a secret under 32 bytes refuses the start; none leaves deposits off", () => {
    assert.throws(() => fundingConfig(env({ FUNDING_CALLBACK_SECRET: "short" }), ORIGIN), /at least 32 are required/);
    assert.throws(() => fundingConfig(env({ FUNDING_CALLBACK_SECRET: `  ${"x".repeat(31)}   ` }), ORIGIN), /31 bytes/);
    const file = join(dir, "short-secret");
    writeFileSync(file, `${"y".repeat(20)}\n`);
    assert.throws(() => fundingConfig(env({ FUNDING_CALLBACK_SECRET: undefined, FUNDING_CALLBACK_SECRET_FILE: file }), ORIGIN), /FUNDING_CALLBACK_SECRET_FILE/);
    const good = join(dir, "secret");
    writeFileSync(good, `${"z".repeat(48)}\n`);
    assert.equal(fundingConfig(env({ FUNDING_CALLBACK_SECRET: undefined, FUNDING_CALLBACK_SECRET_FILE: good }), ORIGIN).secret?.toString(), "z".repeat(48));
    const none = fundingConfig(env({ FUNDING_CALLBACK_SECRET: undefined }), ORIGIN);
    assert.equal(none.secret, null);
    assert.equal(depositsOpen(none), false);
    assert.match(none.off!, /FUNDING_CALLBACK_SECRET is not set/);
  });

  test("a missing secret: the coin is still checked first, then deposits are not open", async () => {
    const owner = await agent();
    const s = await space(owner);
    const on = serviceWith(fundingConfig(env({ FUNDING_CALLBACK_SECRET: undefined }), ORIGIN));
    const typo = await ask(s.name, owner, { coin: "base/usdx" }, on);
    assert.equal(typo.body.error?.code, "COIN_NOT_OFFERED");
    assert.match(typo.body.error.detail, /^not a coin this service takes/);
    const closed = await ask(s.name, owner, { coin: "base/usdc" }, on);
    assert.equal(closed.status, 503);
    assert.equal(closed.body.error.code, "FUNDING_UNAVAILABLE");
  });

  test("no funding configured at all: no coin is offered", async () => {
    const owner = await agent();
    const s = await space(owner);
    const out = await ask(s.name, owner, { coin: "base/usdc" }, serviceWith(undefined));
    assert.equal(out.body.error?.code, "COIN_NOT_OFFERED");
  });

  test("the funding.config line names families, never a wallet or the secret", async () => {
    const cfg = fundingConfig(env({ FUNDING_WALLET_TRON: "nope" }), ORIGIN);
    const line = fundingConfigLine(cfg);
    assert.deepEqual(JSON.parse(line), { event: "funding.config", mode: "double", families: ["evm", "solana", "btc"], missing: ["tron"], off: null });
    for (const secret of [...Object.values(WALLETS), SECRET, "nope"]) assert.ok(!line.includes(secret), secret);
  });

  test("one request to the provider has 10 seconds unless a test shortens it", () => {
    assert.equal(CRYPTAPI_TIMEOUT_MS, 10_000);
    assert.equal(fundingConfig(env(), ORIGIN).timeoutMs, 10_000);
  });
});

describe("the callback URL and its mac", () => {
  const secret = Buffer.from(SECRET);
  const spaceId = "8f14e45f-ceea-467a-9575-1c3a3e5e0b7d";

  test("the same inputs give the same mac: 43 characters of base64url", () => {
    const mac = callbackMac(secret, spaceId, "base/usdc", WALLETS.evm);
    assert.match(mac, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(callbackMac(secret, spaceId, "base/usdc", WALLETS.evm), mac);
  });

  test("it changes with the SPACE, the ticker, the wallet and the secret, and not with an EVM wallet's case", () => {
    const mac = callbackMac(secret, spaceId, "base/usdc", WALLETS.evm);
    const others = [
      callbackMac(secret, randomUUID(), "base/usdc", WALLETS.evm),
      callbackMac(secret, spaceId, "base/usdt", WALLETS.evm),
      callbackMac(secret, spaceId, "base/usdc", OTHER_EVM),
      callbackMac(Buffer.from(`${SECRET}!`), spaceId, "base/usdc", WALLETS.evm),
    ];
    for (const other of others) assert.notEqual(other, mac);
    assert.equal(callbackMac(secret, spaceId, "base/usdc", WALLETS.evm.toUpperCase().replace("0X", "0x")), mac);
    assert.equal(callbackMac(secret, spaceId.toUpperCase(), "base/usdc", WALLETS.evm), mac);
    // Not EVM: as configured.
    assert.notEqual(callbackMac(secret, spaceId, "trx", WALLETS.tron), callbackMac(secret, spaceId, "trx", WALLETS.tron.toLowerCase()));
  });

  test("the URL has the documented form and only characters that survive URL-encoding", () => {
    const coin = coinByTicker("avax-c/usdc.e")!;
    const mac = callbackMac(secret, spaceId, coin.ticker, WALLETS.evm);
    const url = callbackUrl("http://127.0.0.1:3011", spaceId, coin, mac);
    assert.equal(url, `http://127.0.0.1:3011/funding/cryptapi/${spaceId}/avax-c_usdc.e/${mac}`);
    assert.match(url, /^[A-Za-z0-9:/._-]+$/);
    assert.equal(decodeURIComponent(encodeURIComponent(url)), url);
  });
});

describe("the request to the provider", () => {
  test("decimals arrive as numbers or strings, with an exponent or not", () => {
    assert.equal(plainDecimal(3), "3");
    assert.equal(plainDecimal("3.00000000"), "3");
    assert.equal(plainDecimal(0.00008), "0.00008");
    assert.equal(plainDecimal(1e-7), "0.0000001");
    assert.equal(plainDecimal("1E+2"), "100");
    assert.equal(plainDecimal("1.5e1"), "15");
    assert.equal(plainDecimal("0E-8"), "0");
    for (const bad of [-1, "-1", "", "abc", null, NaN, Infinity, "1e"]) assert.equal(plainDecimal(bad), null, String(bad));
  });

  test("the key callbacks are signed with is the one /pubkey/ answers", async () => {
    assert.equal(await fetchPubkey(fundingConfig(env(), ORIGIN)), double.publicKeyPem.trim());
  });

  test("an answer is checked: an address of the family's shape", async () => {
    const cfg = fundingConfig(env(), ORIGIN);
    const coin = coinByTicker("btc")!;
    double.alterNext({ address_in: `0x${"ab".repeat(20)}` });
    await assert.rejects(createAddress(cfg, coin, `${ORIGIN}/funding/cryptapi/x/btc/${"a".repeat(43)}`, WALLETS.btc), { code: "FUNDING_UNAVAILABLE" });
  });

  test("a Bitcoin address the provider answers may be bech32, legacy (1...) or P2SH (3...), where the wallet is bech32", async () => {
    const cfg = fundingConfig(env(), ORIGIN);
    const coin = coinByTicker("btc")!;
    const url = (n: number) => `${ORIGIN}/funding/cryptapi/x/btc/${String(n).repeat(43)}`;
    for (const [n, addressIn] of [[1, `1${"F".repeat(33)}`], [2, `3${"F".repeat(33)}`], [3, `bc1p${"x".repeat(58)}`]] as const) {
      double.alterNext({ address_in: addressIn });
      assert.equal((await createAddress(cfg, coin, url(n), WALLETS.btc)).addressIn, addressIn);
    }
    for (const [n, addressIn] of [[4, `2${"F".repeat(33)}`], [5, `1${"0".repeat(33)}`], [6, `bc1${"b".repeat(40)}`]] as const) {
      double.alterNext({ address_in: addressIn });
      await assert.rejects(createAddress(cfg, coin, url(n), WALLETS.btc), { code: "FUNDING_UNAVAILABLE" }, addressIn);
    }
    // The service's own wallet stays bech32 alone.
    assert.equal(fundingConfig(env({ FUNDING_WALLET_BTC: `1${"F".repeat(33)}` }), ORIGIN).wallets.btc, undefined);
  });
});

describe("POST /v1/spaces/{name}/funding/addresses", () => {
  before(() => {
    fund = serviceWith(fundingConfig(env(), ORIGIN, { timeoutMs: 300 }));
  });

  test("needs a token, and a token an app was given to read is refused", async () => {
    const owner = await agent();
    const s = await space(owner);
    const none = await ask(s.name, null, { coin: "btc" });
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, "TOKEN_MISSING");
    const bearer = await classifyBearer(db, `Bearer ${owner.token}`, "127.0.0.1", null);
    assert.equal(bearer.state, "valid");
    const reading = await read(await fund.request(`/v1/spaces/${s.name}/funding/addresses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ coin: "btc" }),
    }, { schellingafReentry: { bearer: { ...bearer, scope: "read" }, addr: "127.0.0.1" } }));
    assert.equal(reading.status, 403);
    assert.equal(reading.body.error.code, "INSUFFICIENT_SCOPE");
  });

  test("a coin this service does not take, a missing coin and another field: refused, and the provider is not asked", async () => {
    const owner = await agent();
    const s = await space(owner);
    const before = double.requests.length;
    for (const coin of ["doge", "ton/usdt", "BTC", "base_usdc", ""]) {
      const out = await ask(s.name, owner, { coin });
      assert.equal(out.status, 400, coin);
      assert.equal(out.body.error.code, "COIN_NOT_OFFERED", coin);
      assert.equal(out.body.error.detail, `not a coin this service takes: see coins in GET /v1/spaces/${s.name}/funding with coins true`);
    }
    for (const body of [{}, { coin: 5 }, { coin: "btc", amount: 3 }]) {
      const out = await ask(s.name, owner, body);
      assert.equal(out.body.error?.code, "INVALID_REQUEST", JSON.stringify(body));
    }
    assert.equal(double.requests.length, before);
  });

  test("an unknown SPACE is not found; a closed one and a replaced one are closed; a withheld one is not read", async () => {
    const owner = await agent();
    const missing = await ask("no-such-space-here", owner, { coin: "btc" });
    assert.equal(missing.body.error?.code, "SPACE_NOT_FOUND");

    const closed = await space(owner);
    await fixture.owner`update schellingaf.spaces set status = 'closed' where name = ${closed.name}`;
    const shut = await ask(closed.name, owner, { coin: "btc" });
    assert.equal(shut.status, 409);
    assert.equal(shut.body.error.code, "SPACE_CLOSED");

    const old = await space(owner);
    const next = newName();
    await fixture.owner`select schellingaf.recover_space(${old.name}, ${next}, 'a test')`;
    const replaced = await ask(old.name, owner, { coin: "btc" });
    assert.equal(replaced.body.error?.code, "SPACE_CLOSED");
    assert.equal(replaced.body.error.detail, `continued in [${next}]`);

    const held = await space(owner);
    await fixture.owner`insert into schellingaf.withheld_spaces (space_id, reason, note) values (${held.id}::uuid, 'abuse', 'a test')`;
    const withheld = await ask(held.name, owner, { coin: "btc" });
    assert.equal(withheld.body.error?.code, "READ_DENIED");
    assert.match(withheld.body.error.detail, /withheld/);
    for (const s of [closed, old, held]) assert.deepEqual(await rows(s.id), []);
  });

  test("the first request makes it, 201; the provider was asked once, as documented; a second answers it again, 200, spending nothing", async () => {
    const owner = await agent();
    const s = await space(owner);
    const before = creates().length;
    const out = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const made = creates().slice(before);
    assert.equal(made.length, 1);
    const [row] = await rows(s.id);
    assert.ok(row);
    const mac = callbackMac(Buffer.from(SECRET), s.id, "base/usdc", WALLETS.evm);
    const url = `${ORIGIN}/funding/cryptapi/${s.id}/base_usdc/${mac}`;
    assert.deepEqual(made[0]!.query, { callback: url, address: WALLETS.evm, pending: "1", json: "1", convert: "1", multi_token: "1" });
    assert.equal(row.callback_url, made[0]!.query.callback, "the URL kept is the one the provider was sent, byte for byte");
    assert.equal(row.callback_url, url);
    assert.equal(row.callback_mac, mac);
    assert.equal(row.address_out, WALLETS.evm);
    assert.deepEqual(out.body, {
      space: s.name,
      created: true,
      address: {
        coin: "base/usdc", symbol: "USDC", network: "Base", family: "evm", address: double.addressFor("base/usdc", url),
        minimum: "3", cheap: false, stable: true, current: true, created_at: out.body.address.created_at,
      },
      minimums_as_of: "2026-10-08",
      notice: FUNDING_DEPOSIT_NOTICE,
    });
    assert.equal(row.address_in, out.body.address.address);

    const own = await bucket(`fund-addr:${owner.peerId}`);
    const all = await bucket("fund-addr:all");
    assert.ok(own !== null && all !== null);
    const again = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual({ ...again.body, created: true }, out.body);
    assert.equal(again.body.created, false);
    assert.equal(creates().length, before + 1, "the provider was not asked again");
    // A bucket refills with time, so spent would be a whole token less; unspent is within a hair.
    assert.ok((await bucket(`fund-addr:${owner.peerId}`))! - own! > -0.5, "the KEY's allowance was not spent");
    assert.ok((await bucket("fund-addr:all"))! - all! > -0.5, "the service's allowance was not spent");
    // Another KEY asking for the same coin gets the same address, and spends nothing either.
    const other = await agent();
    const theirs = await ask(s.name, other, { coin: "base/usdc" });
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.address.address, out.body.address.address);
    assert.equal(await bucket(`fund-addr:${other.peerId}`), null);
  });

  test("multi_token is asked for on EVM networks and Tron only", async () => {
    const owner = await agent();
    const s = await space(owner);
    for (const [coin, multi] of [["btc", false], ["sol/usdc", false], ["trc20/usdt", true], ["trx", true], ["polygon/usdc", true]] as const) {
      const before = creates().length;
      const out = await ask(s.name, owner, { coin });
      assert.equal(out.status, 201, `${coin}: ${JSON.stringify(out.body)}`);
      const [sent] = creates().slice(before);
      assert.equal(sent!.ticker, coin);
      assert.equal(sent!.query.multi_token, multi ? "1" : undefined, coin);
      assert.equal(sent!.query.pending, "1");
      assert.equal(sent!.query.json, "1");
      assert.equal(sent!.query.convert, "1");
      assert.equal("post" in sent!.query || "confirmations" in sent!.query || "priority" in sent!.query, false);
    }
    assert.deepEqual((await rows(s.id)).map((r) => r.coin).sort(), ["btc", "polygon/usdc", "sol/usdc", "trc20/usdt", "trx"]);
  });

  test("a stranger KEY gets an address for a private SPACE and for a sealed one", async () => {
    const owner = await agent();
    const stranger = await agent();
    const hidden = await space(owner, "private");
    const out = await ask(hidden.name, stranger, { coin: "sol/usdc" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    const locked = await sealedSpace();
    const sealedOut = await ask(locked.name, stranger, { coin: "trc20/usdt" });
    assert.equal(sealedOut.status, 201, JSON.stringify(sealedOut.body));
    assert.equal((await rows(locked.id)).length, 1);
  });

  test("two requests at once keep one row, and both answer the same address", async () => {
    const owner = await agent();
    const s = await space(owner);
    const both = await Promise.all([ask(s.name, owner, { coin: "arbitrum/usdc" }), ask(s.name, await agent(), { coin: "arbitrum/usdc" })]);
    assert.deepEqual(both.map((o) => o.status).sort(), [200, 201], JSON.stringify(both.map((o) => o.body)));
    assert.equal(both[0]!.body.address.address, both[1]!.body.address.address);
    assert.equal((await rows(s.id)).length, 1);
  });

  test("the provider failing once is tried again; twice, or hanging, is 503 with nothing kept", async () => {
    const owner = await agent();
    const s = await space(owner);
    double.failNext(1, 502);
    const once = await ask(s.name, owner, { coin: "base/usdt" });
    assert.equal(once.status, 201, JSON.stringify(once.body));

    double.failNext(2, 500);
    const twice = await ask(s.name, owner, { coin: "base/dai" });
    assert.equal(twice.status, 503);
    assert.equal(twice.body.error.code, "FUNDING_UNAVAILABLE");
    assert.equal(twice.headers.get("retry-after"), "60");

    // A 4xx is not tried again.
    const before = creates().length;
    double.failNext(1, 400);
    const refused = await ask(s.name, owner, { coin: "base/eth" });
    assert.equal(refused.status, 503);
    assert.equal(creates().length, before + 1);

    double.hangNext(2);
    const started = Date.now();
    const hung = await ask(s.name, owner, { coin: "base/cbbtc" });
    assert.equal(hung.status, 503);
    assert.ok(Date.now() - started < 5_000, "two timed attempts, then the answer");
    assert.deepEqual((await rows(s.id)).map((r) => r.coin), ["base/usdt"]);
  });

  test("a provider that fails gives the service's daily allowance back and keeps the KEY's spent; the refusal says why and when to retry", async () => {
    const owner = await agent();
    const s = await space(owner);
    const all = (await bucket("fund-addr:all")) ?? 2000;
    double.failNext(2, 500);
    const out = await ask(s.name, owner, { coin: "base/usdt" });
    assert.equal(out.status, 503);
    assert.equal(out.body.error.code, "FUNDING_UNAVAILABLE");
    assert.equal(out.body.error.detail, "the payment provider did not answer, or answered wrongly");
    assert.equal(out.headers.get("retry-after"), "60");
    assert.ok((await bucket("fund-addr:all"))! - all > -0.5, "the service's allowance was not given back");
    assert.ok((await bucket(`fund-addr:${owner.peerId}`))! < 19.5, "the KEY's allowance was given back");
  });

  test("an EVM wallet set again in upper case is the same wallet: the address made before is answered, current, and nothing new is made", async () => {
    const owner = await agent();
    const s = await space(owner);
    const made = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(made.status, 201);
    const upperEnv = env({ FUNDING_WALLET_EVM: `0x${"FA".repeat(20)}` });
    assert.equal(fundingConfig(upperEnv, ORIGIN).wallets.evm, WALLETS.evm, "kept lower case");
    const upper = serviceWith(fundingConfig(upperEnv, ORIGIN));
    const asked = creates().length;
    const again = await ask(s.name, owner, { coin: "base/usdc" }, upper);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.created, false);
    assert.equal(again.body.address.address, made.body.address.address);
    assert.equal(again.body.address.current, true);
    assert.equal(creates().length, asked, "the provider was asked again");
    assert.deepEqual((await rows(s.id)).map((r) => r.address_out), [WALLETS.evm]);
  });

  test("an answer with another wallet, another callback URL or another SPACE's address is 503 with nothing kept", async () => {
    const owner = await agent();
    const s = await space(owner);
    double.alterNext({ address_out: OTHER_EVM });
    const wallet = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(wallet.body.error?.code, "FUNDING_UNAVAILABLE", JSON.stringify(wallet.body));
    double.alterNext({ callback_url: `${ORIGIN}/funding/cryptapi/elsewhere` });
    const url = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(url.body.error?.code, "FUNDING_UNAVAILABLE");
    assert.deepEqual(await rows(s.id), []);

    // An EVM wallet answered in another case is the same wallet.
    double.alterNext({ address_out: WALLETS.evm.toUpperCase().replace("0X", "0x") });
    const cased = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(cased.status, 201, JSON.stringify(cased.body));
    assert.equal((await rows(s.id))[0]!.address_out, WALLETS.evm, "kept as configured");

    const t = await space(owner);
    double.alterNext({ address_in: cased.body.address.address });
    const twin = await ask(t.name, owner, { coin: "base/usdc" });
    assert.equal(twin.status, 503, JSON.stringify(twin.body));
    assert.equal(twin.body.error.code, "FUNDING_UNAVAILABLE");
    assert.equal(twin.body.error.detail, "the payment provider answered an address this service cannot keep");
    assert.equal(twin.headers.get("retry-after"), "60");
    assert.deepEqual(await rows(t.id), []);
  });

  test("a KEY makes 20 new addresses a day; the 21st is 429 with its own numbers", async () => {
    const owner = await agent();
    const s = await space(owner);
    const tickers = ["btc", "eth", "trx", "sol/sol", "sol/usdt", "sol/pyusd", "bep20/usdt", "bep20/usdc", "bep20/dai", "optimism/usdc", "optimism/usdt", "optimism/dai",
      "linea/usdc", "linea/usdt", "monad/usdc", "bera/usdt0", "avax-c/usdt", "avax-c/usdc", "polygon/usdt", "polygon/usdc.e", "arbitrum/usdt0"];
    for (const coin of tickers.slice(0, 20)) {
      const out = await ask(s.name, owner, { coin });
      assert.equal(out.status, 201, `${coin}: ${JSON.stringify(out.body)}`);
    }
    const before = creates().length;
    const over = await ask(s.name, owner, { coin: tickers[20] });
    assert.equal(over.status, 429, JSON.stringify(over.body));
    assert.equal(over.body.error.code, "RATE_LIMITED");
    assert.equal(over.headers.get("ratelimit-limit"), "20");
    assert.equal(over.headers.get("ratelimit-remaining"), "0");
    assert.equal(creates().length, before);
    // An address already made is still answered.
    assert.equal((await ask(s.name, owner, { coin: "btc" })).status, 200);
  });

  test("the service's own daily ceiling, set to 3: the 4th new address, from another KEY, is 429 with no numbers", async () => {
    await fixture.owner`delete from schellingaf.rate_buckets where key = 'fund-addr:all'`;
    try {
      await withEnv({ FUNDING_ADDRESSES_PER_DAY: "3" }, async () => {
        const s = await space(await agent());
        for (const coin of ["btc", "eth", "trx"]) assert.equal((await ask(s.name, await agent(), { coin })).status, 201, coin);
        const out = await ask(s.name, await agent(), { coin: "sol/sol" });
        assert.equal(out.status, 429, JSON.stringify(out.body));
        assert.equal(out.headers.get("retry-after"), "60");
        for (const h of ["ratelimit-limit", "ratelimit-remaining", "ratelimit-reset"]) assert.equal(out.headers.get(h), null, h);
        assert.deepEqual((await rows(s.id)).map((r) => r.coin).sort(), ["btc", "eth", "trx"]);
      });
    } finally {
      await fixture.owner`delete from schellingaf.rate_buckets where key = 'fund-addr:all'`;
    }
  });

  test("a new wallet makes a new address for the same coin, and the old one is kept with its own wallet", async () => {
    const owner = await agent();
    const s = await space(owner);
    const first = await ask(s.name, owner, { coin: "base/usdc" });
    assert.equal(first.status, 201);
    const moved = serviceWith(fundingConfig(env({ FUNDING_WALLET_EVM: OTHER_EVM }), ORIGIN));
    const second = await ask(s.name, owner, { coin: "base/usdc" }, moved);
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.notEqual(second.body.address.address, first.body.address.address);
    const kept = await rows(s.id);
    assert.deepEqual(kept.map((r) => [r.address_in, r.address_out]), [[first.body.address.address, WALLETS.evm], [second.body.address.address, OTHER_EVM]]);
    // Back on the first wallet, the first address again.
    assert.equal((await ask(s.name, owner, { coin: "base/usdc" })).body.address.address, first.body.address.address);
  });

  test("its log lines name the SPACE by id and the coin, never a wallet, the mac or the URL", async () => {
    const owner = await agent();
    const s = await space(owner);
    let made: any;
    const out = await stdoutDuring(async () => {
      double.failNext(1, 503);
      made = await ask(s.name, owner, { coin: "trc20/usdt" });
    });
    assert.equal(made.status, 201);
    const [row] = await rows(s.id);
    const lines = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.event === "funding.provider" && l.op === "create" && l.ticker === "trc20/usdt" && l.status === 503));
    assert.ok(lines.some((l) => l.event === "funding.address" && l.space_id === s.id && l.coin === "trc20/usdt" && l.created === true));
    for (const secret of [...Object.values(WALLETS), row!.callback_mac, row!.callback_url, SECRET]) assert.ok(!out.includes(secret), secret);
  });
});

describe("the table that keeps addresses", () => {
  test("the api role reads no row, and no row is changed or deleted", async () => {
    const owner = await agent();
    const s = await space(owner);
    assert.equal((await ask(s.name, owner, { coin: "sol/usdt" }, fund)).status, 201);
    await assert.rejects(fixture.asCaller(null, (sql) => sql`select address_id from schellingaf.funding_addresses`), /permission denied/);
    await assert.rejects(fixture.asCaller(owner.peerId, (sql) => sql`select address_id from schellingaf.funding_addresses`), /permission denied/);
    await assert.rejects(fixture.owner`update schellingaf.funding_addresses set minimum_coin = 0 where space_id = ${s.id}::uuid`, /IMMUTABLE_RECORD/);
    await assert.rejects(fixture.owner`delete from schellingaf.funding_addresses where space_id = ${s.id}::uuid`, /IMMUTABLE_RECORD/);
    // Refused by its trigger, and since 0152 first by the deposits that reference it.
    await assert.rejects(fixture.owner`truncate schellingaf.funding_addresses`, /IMMUTABLE_RECORD|referenced in a foreign key constraint/);
    assert.equal((await rows(s.id)).length, 1);
  });

  test("its two functions are executable by the api role and by nobody else", async () => {
    const grants = await fixture.owner<{ fn: string; api: boolean; public: boolean }[]>`
      select p.oid::regprocedure::text as fn,
             has_function_privilege('schellingaf_api', p.oid, 'execute') as api,
             exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public
        from pg_proc p where p.pronamespace = 'schellingaf'::regnamespace and p.proname in ('funding_address_add', 'funding_address_find') order by 1`;
    assert.deepEqual(grants.map((g) => ({ ...g })), [
      { fn: "funding_address_add(bytea,uuid,text,text,text,text,text,text,text,numeric)", api: true, public: false },
      { fn: "funding_address_find(uuid,text,text)", api: true, public: false },
    ]);
  });

  test("an address is kept only for a KEY that is registered and not blocked", async () => {
    const owner = await agent();
    const s = await space(owner);
    const args = (actor: Buffer) => fixture.api`
      select * from schellingaf.funding_address_add(${actor}, ${s.id}::uuid, 'cryptapi', 'btc', 'btc',
        ${`bc1q${"z".repeat(38)}`}, ${WALLETS.btc}, ${`${ORIGIN}/funding/cryptapi/${s.id}/btc/${"m".repeat(43)}`}, ${"m".repeat(43)}, 0.00008)`;
    await assert.rejects(args(Buffer.alloc(32, 7)), /TOKEN_INVALID/);
    await fixture.owner`update schellingaf.peers set blocked_at = now() where peer_id = ${Buffer.from(owner.peerId, "hex")}`;
    await assert.rejects(args(Buffer.from(owner.peerId, "hex")), /KEY_BLOCKED/);
    assert.deepEqual(await rows(s.id), []);
  });

  test("an EVM wallet is kept lower case and nothing else", async () => {
    const owner = await agent();
    const s = await space(owner);
    const add = (wallet: string, mac: string) => fixture.api`
      select * from schellingaf.funding_address_add(${Buffer.from(owner.peerId, "hex")}, ${s.id}::uuid, 'cryptapi', 'base/usdc', 'evm',
        ${`0x${mac.slice(0, 40).toLowerCase().replace(/[^0-9a-f]/g, "1")}`}, ${wallet}, ${`${ORIGIN}/funding/cryptapi/${s.id}/base_usdc/${mac}`}, ${mac}, 3)`;
    await assert.rejects(add(`0x${"FA".repeat(20)}`, "U".repeat(43)), /funding_addresses_evm_lower/);
    assert.equal((await add(WALLETS.evm, "L".repeat(43)))[0]!.created, true);
  });
});

