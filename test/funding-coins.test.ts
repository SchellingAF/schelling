// The coin table a SPACE can be funded with (src/funding/coins.ts), and the generator that
// makes it from CryptAPI's /info/ (scripts/cryptapi-coins.ts). Needs no database.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COINS, COINS_AS_OF, COIN_FAMILIES, coinByTicker, coinByCallbackCoin } from "../src/funding/coins.ts";
import {
  CHEAP_BELOW_USD, INFO_FILE, TABLE_FILE, USD_STABLECOINS,
  coinsFromInfo, exactDecimal, feeInDollars, isCheap, minimumOf, renderTable,
} from "../scripts/cryptapi-coins.ts";

describe("the committed coin table", () => {
  test("every coin is of one of the four families", () => {
    assert.deepEqual([...COIN_FAMILIES].sort(), ["btc", "evm", "solana", "tron"]);
    for (const c of COINS) assert.ok(COIN_FAMILIES.includes(c.family), `${c.ticker}: ${c.family}`);
    for (const f of COIN_FAMILIES) assert.ok(COINS.some((c) => c.family === f), `no coin of ${f}`);
  });

  test("every ticker and every callback coin is unique", () => {
    assert.equal(new Set(COINS.map((c) => c.ticker)).size, COINS.length);
    assert.equal(new Set(COINS.map((c) => c.callbackCoin)).size, COINS.length);
  });

  test("the two lookups agree, and every callback coin is the ticker with _", () => {
    for (const c of COINS) {
      assert.equal(c.callbackCoin, c.ticker.replace("/", "_"));
      assert.equal(coinByTicker(c.ticker), c);
      assert.equal(coinByCallbackCoin(c.callbackCoin), c);
    }
    assert.equal(coinByCallbackCoin("trc20_usdt")?.ticker, "trc20/usdt");
    assert.equal(coinByCallbackCoin("btc")?.ticker, "btc");
    assert.equal(coinByCallbackCoin("trc20/usdt"), undefined);
  });

  test("every minimum is a positive decimal in coin units", () => {
    for (const c of COINS) {
      assert.match(c.minimum, /^(0|[1-9]\d*)(\.\d*[1-9])?$/, c.ticker);
      assert.ok(Number(c.minimum) > 0, c.ticker);
    }
  });

  test("the coins a funder most likely holds are offered, on the right family", () => {
    const want: [string, string, string, boolean, boolean][] = [
      // ticker, family, network, cheap, stable
      ["base/usdc", "evm", "Base", false, true],
      ["sol/usdc", "solana", "Solana", true, true],
      ["btc", "btc", "Bitcoin", true, false],
      ["trc20/usdt", "tron", "Tron", false, true],
      ["erc20/usdc", "evm", "Ethereum", false, true],
      ["polygon/usdc", "evm", "Polygon", true, true],
      ["eth", "evm", "Ethereum", true, false],
    ];
    for (const [ticker, family, network, cheap, stable] of want) {
      const c = coinByTicker(ticker);
      assert.ok(c, `${ticker} is missing`);
      assert.deepEqual([c.family, c.network, c.cheap, c.stable], [family, network, cheap, stable], ticker);
    }
  });

  test("no coin of a network without a wallet", () => {
    for (const t of ["bch", "ltc", "doge", "zec", "ton/usdt", "ton/gram"]) assert.equal(coinByTicker(t), undefined, t);
    for (const c of COINS) assert.ok(!/^(bch|ltc|doge|zec|ton)(\/|$)/.test(c.ticker), c.ticker);
  });

  test("cheap is the fee estimate below $0.50, and a native coin pays its own network's fees", () => {
    assert.equal(CHEAP_BELOW_USD, "0.50");
    for (const c of COINS) {
      assert.match(c.feeUsd, /^\d+\.\d\d$/, c.ticker);
      assert.equal(c.cheap, Number(c.feeUsd) < 0.5, c.ticker);
    }
    // From the saved /info/: 12.9 TRX at about $0.336, and 0.000327 ETH at about $2,560.
    assert.equal(coinByTicker("trc20/usdt")?.feeUsd, "4.33");
    assert.equal(coinByTicker("erc20/usdt")?.feeUsd, "0.84");
    assert.equal(coinByTicker("sol/usdc")?.feeUsd, "0.00");
    assert.equal(coinByTicker("sol/sol")?.kind, "native");
    assert.equal(coinByTicker("base/eth")?.kind, "native");
    assert.equal(coinByTicker("bep20/eth")?.kind, "token");
    assert.equal(coinByTicker("erc20/bnb")?.kind, "token");
    assert.equal(coinByTicker("trx")?.kind, "native");
  });

  test("the stable coins are exactly usdt, usdc, usdc.e, usdt0, dai and pyusd", () => {
    const six = ["usdt", "usdc", "usdc.e", "usdt0", "dai", "pyusd"];
    assert.deepEqual([...USD_STABLECOINS].sort(), [...six].sort());
    for (const c of COINS) assert.equal(c.stable, six.includes(c.symbol.toLowerCase()), c.ticker);
    for (const t of ["sol/wusdt", "bep20/usd1", "erc20/musd", "trc20/tusd", "trc20/usdd", "sol/eurc", "bep20/phpt", "trc20/inrt"]) {
      assert.equal(coinByTicker(t)?.stable, false, t);
    }
  });

  test("the table is what the generator writes for its own coins", () => {
    const text = readFileSync(TABLE_FILE, "utf8");
    const date = /on (\d{4}-\d{2}-\d{2})\./.exec(text)?.[1];
    assert.ok(date, "the header names the day /info/ was read");
    assert.equal(COINS_AS_OF, date);
    assert.equal(renderTable(COINS, date), text);
  });

  test("the generator, run on the saved /info/, makes the committed table byte for byte", () => {
    const info = JSON.parse(readFileSync(INFO_FILE, "utf8"));
    assert.equal(renderTable(coinsFromInfo(info), COINS_AS_OF), readFileSync(TABLE_FILE, "utf8"));
  });
});

describe("the generator", () => {
  const entry = (coin: string, min: string, fee = "0.0001", usd = "1") => ({
    coin, ticker: "x", minimum_transaction_coin: min, fee_percent: "1.000", network_fee_estimation: fee, prices: { USD: usd },
  });
  const info = {
    btc: entry("Bitcoin", "0.00008000", "0.00000213", "80000"),
    ltc: entry("Litecoin", "0.00200000"),
    eth: entry("Ethereum (ERC20)", "0.00150000", "0.0001", "2500"),
    base: { usdc: entry("USD Coin", "3.00000000", "0.0002", "1"), eth: entry("Ethereum", "0.00030000", "8.4E-5", "2500") },
    ton: { usdt: entry("USDT", "0.50000000") },
    sol: { eurc: entry("EURC", "1.00000000", "0.00001", "1.16"), sol: entry("Solana", "0.004", "0.00001", "115") },
    fee_tiers: [{ minimum: "0.00", fee: "1.000" }],
  };

  test("keeps the four families, drops the rest, and spells tickers as CryptAPI's paths do", () => {
    const coins = coinsFromInfo(info);
    assert.deepEqual(coins.map((c) => c.ticker), ["base/eth", "base/usdc", "btc", "eth", "sol/eurc", "sol/sol"]);
    const usdc = coins.find((c) => c.ticker === "base/usdc")!;
    // A token's fee is in its network's native coin: 0.0002 ETH at $2,500 is $0.50, not cheap.
    assert.deepEqual(usdc, {
      ticker: "base/usdc", callbackCoin: "base_usdc", symbol: "USDC", name: "USD Coin", network: "Base",
      family: "evm", kind: "token", minimum: "3", feeUsd: "0.50", cheap: false, stable: true,
    });
    assert.equal(coins.find((c) => c.ticker === "base/eth")!.feeUsd, "0.21");
    assert.equal(coins.find((c) => c.ticker === "base/eth")!.cheap, true);
    assert.equal(coins.find((c) => c.ticker === "btc")!.feeUsd, "0.17");
    assert.equal(coins.find((c) => c.ticker === "eth")!.name, "Ethereum");
    assert.equal(coins.find((c) => c.ticker === "btc")!.minimum, "0.00008");
    assert.equal(coins.find((c) => c.ticker === "sol/eurc")!.stable, false);
  });

  test("stops on a network it does not know, rather than guessing its family", () => {
    assert.throws(() => coinsFromInfo({ ...info, newchain: { usdc: entry("USDC", "1.00000000") } }), /newchain/);
  });

  test("a coin whose fees are paid in a coin it cannot price stops it", () => {
    assert.throws(() => coinsFromInfo({ base: { usdc: entry("USD Coin", "3") } }), /base\/eth/);
    const noPrice = { ...info, base: { ...info.base, eth: { ...info.base.eth, prices: {} } } };
    assert.throws(() => coinsFromInfo(noPrice), /price/);
  });

  test("dollars are exact, half up to the cent, and below $0.50 is cheap", () => {
    assert.deepEqual(exactDecimal("8.48097096E-7", "t"), { n: 848097096n, scale: 15 });
    assert.deepEqual(exactDecimal("1E+2", "t"), { n: 100n, scale: 0 });
    assert.deepEqual(exactDecimal("1.5e1", "t"), { n: 15n, scale: 0 });
    assert.equal(feeInDollars("12.90000000", "0.3357680786", "t"), "4.33");
    assert.equal(feeInDollars("0.000326593997360274", "2560.4633113465", "t"), "0.84");
    assert.equal(feeInDollars("0.0049", "1", "t"), "0.00");
    assert.equal(feeInDollars("0.005", "1", "t"), "0.01");
    assert.equal(feeInDollars("3", "1", "t"), "3.00");
    assert.equal(isCheap("0.49"), true);
    assert.equal(isCheap("0.50"), false);
    for (const bad of ["-1", "", "abc", null, "1e"]) assert.throws(() => feeInDollars(bad, "1", "t"), String(bad));
  });

  test("refuses a minimum that is not a positive decimal", () => {
    assert.equal(minimumOf("10.00000000", "t"), "10");
    assert.equal(minimumOf("0.50000000", "t"), "0.5");
    assert.equal(minimumOf(0.008, "t"), "0.008");
    for (const bad of ["0.00000000", "-1", "1e-5", "", null, "abc"]) assert.throws(() => minimumOf(bad, "t"), String(bad));
  });

  test("the rendered table names its rule and has the same shape", () => {
    const text = renderTable(coinsFromInfo(info), "2026-10-08");
    assert.match(text, /^\/\/ GENERATED by scripts\/cryptapi-coins\.ts from https:\/\/api\.cryptapi\.io\/info\/ on 2026-10-08\./);
    assert.match(text, /^\/\/ cheap: feeUsd, CryptAPI's estimate of the network fee to forward a deposit, is below \$0\.50\.$/m);
    assert.match(text, /\{ ticker: "base\/usdc", callbackCoin: "base_usdc", symbol: "USDC", name: "USD Coin", network: "Base", family: "evm", kind: "token", minimum: "3", feeUsd: "0\.50", cheap: false, stable: true \},/);
  });
});
