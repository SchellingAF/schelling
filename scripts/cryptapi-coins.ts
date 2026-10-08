// The coin table, src/funding/coins.ts, made from CryptAPI's public list of coins.
//
//   node scripts/cryptapi-coins.ts                    # fetch /info/ and print the table
//   node scripts/cryptapi-coins.ts --write            # fetch /info/ and write the table
//   node scripts/cryptapi-coins.ts --from info.json   # read a saved /info/ instead
//
// It sends one GET to https://api.cryptapi.io/info/ (or CRYPTAPI_BASE), which needs no
// key and makes no address. It keeps the coins of the four families the service has a
// receiving wallet for: every EVM network (one address), Solana, Bitcoin and Tron. A
// network it does not know stops it, so a new one is placed in a family, or dropped, by
// a person, never by default. --write also saves the /info/ it read as
// test/fixtures/cryptapi-info.json, from which test/funding-coins.test.ts makes the table
// again, byte for byte.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Coin, CoinFamily } from "../src/funding/coins.ts";

export const TABLE_FILE = fileURLToPath(new URL("../src/funding/coins.ts", import.meta.url));
export const INFO_FILE = fileURLToPath(new URL("../test/fixtures/cryptapi-info.json", import.meta.url));

/** Each network /info/ names, as its key there: family, the name a person reads, the coin
 * native to it (a token on it is every other coin), and the ticker of the coin its fees are
 * paid in, whose price turns /info/'s fee estimate into dollars. A native coin at the top
 * level of /info/ is its own network. */
const NETWORKS: Record<string, { family: CoinFamily; name: string; native: string | null; feesIn: string }> = {
  btc: { family: "btc", name: "Bitcoin", native: "btc", feesIn: "btc" },
  eth: { family: "evm", name: "Ethereum", native: "eth", feesIn: "eth" },
  trx: { family: "tron", name: "Tron", native: "trx", feesIn: "trx" },
  erc20: { family: "evm", name: "Ethereum", native: null, feesIn: "eth" },
  bep20: { family: "evm", name: "BNB Chain", native: "bnb", feesIn: "bep20/bnb" },
  polygon: { family: "evm", name: "Polygon", native: "pol", feesIn: "polygon/pol" },
  arbitrum: { family: "evm", name: "Arbitrum", native: "eth", feesIn: "arbitrum/eth" },
  optimism: { family: "evm", name: "Optimism", native: "eth", feesIn: "optimism/eth" },
  base: { family: "evm", name: "Base", native: "eth", feesIn: "base/eth" },
  linea: { family: "evm", name: "Linea", native: "eth", feesIn: "linea/eth" },
  "avax-c": { family: "evm", name: "Avalanche C-Chain", native: "avax", feesIn: "avax-c/avax" },
  monad: { family: "evm", name: "Monad", native: "mon", feesIn: "monad/mon" },
  bera: { family: "evm", name: "Berachain", native: "bera", feesIn: "bera/bera" },
  sol: { family: "solana", name: "Solana", native: "sol", feesIn: "sol/sol" },
  trc20: { family: "tron", name: "Tron", native: null, feesIn: "trx" },
};

/** Networks with no receiving wallet: their coins are not offered. */
const DROPPED = new Set(["bch", "ltc", "doge", "zec", "ton"]);

/** Keys of /info/ that are not coins. */
const NOT_COINS = new Set(["fee_tiers"]);

/** The cheap rule: a coin is cheap when CryptAPI's estimate of the network fee to forward a
 * deposit of it, in dollars and rounded to the cent, is below this. */
export const CHEAP_BELOW_USD = "0.50";

/** USD stablecoins credited one for one, by the token's own ticker. Every other coin is
 * credited at the provider's USD price: wusdt, usd1, musd, tusd and usdd among them, and
 * EURC (euro), PHPT (peso) and INRT (rupee). */
export const USD_STABLECOINS: ReadonlySet<string> = new Set(["usdt", "usdc", "usdc.e", "usdt0", "dai", "pyusd"]);

/** Names CryptAPI gives that would mislead a person picking a coin. */
const NAME_FIXES: Record<string, string> = { eth: "Ethereum" };

const DECIMAL = /^\d+(\.\d+)?$/;

/** A non-negative decimal, exactly, as digits and a scale: "0.00008" is 8 and 5. Takes an
 * exponent, as /info/ writes "8.48097096E-7"; anything else is refused. */
export function exactDecimal(raw: unknown, what: string): { n: bigint; scale: number } {
  const text = typeof raw === "number" ? String(raw) : raw;
  const m = typeof text === "string" ? /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text) : null;
  if (!m) throw new Error(`${what} ${JSON.stringify(raw)} is not a decimal`);
  const fraction = m[2] ?? "";
  const scale = fraction.length - Number(m[3] ?? 0);
  const n = BigInt(m[1]! + fraction);
  return scale >= 0 ? { n, scale } : { n: n * 10n ** BigInt(-scale), scale: 0 };
}

/** fee times price, in dollars, half up to the cent: "0.84". */
export function feeInDollars(fee: unknown, price: unknown, what: string): string {
  const f = exactDecimal(fee, `${what}: network_fee_estimation`);
  const p = exactDecimal(price, `${what}: the USD price of the coin its fees are paid in`);
  const scale = f.scale + p.scale;
  const product = f.n * p.n;
  // Cents: product / 10^(scale - 2), half up.
  const cents = scale <= 2 ? product * 10n ** BigInt(2 - scale) : (product * 10n / 10n ** BigInt(scale - 2) + 5n) / 10n;
  const digits = cents.toString().padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Whether a fee in dollars, as feeInDollars writes it, is below CHEAP_BELOW_USD. */
export function isCheap(feeUsd: string): boolean {
  const cents = (s: string) => Number(exactDecimal(s, "dollars").n) * 10 ** (2 - exactDecimal(s, "dollars").scale);
  return cents(feeUsd) < cents(CHEAP_BELOW_USD);
}

/** "3.00000000" is "3"; "0.00008000" is "0.00008". Refuses anything but a positive decimal. */
export function minimumOf(raw: unknown, ticker: string): string {
  const text = typeof raw === "number" ? String(raw) : raw;
  if (typeof text !== "string" || !DECIMAL.test(text)) throw new Error(`${ticker}: minimum_transaction_coin ${JSON.stringify(raw)} is not a decimal`);
  const plain = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  const trimmed = plain.replace(/^0+(?=\d)/, "");
  if (!/[1-9]/.test(trimmed)) throw new Error(`${ticker}: minimum_transaction_coin ${text} is not above zero`);
  return trimmed;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The coins of /info/ the service offers, sorted by ticker. */
export function coinsFromInfo(info: unknown): Coin[] {
  if (!isObject(info)) throw new Error("/info/ is not an object");
  // Every entry by its ticker, first, so a token finds the coin its fees are paid in.
  const entries: { networkKey: string; token: string; ticker: string; entry: Record<string, unknown> }[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (NOT_COINS.has(key) || DROPPED.has(key)) continue;
    if (!(key in NETWORKS)) throw new Error(`/info/ names ${key}, a network this table does not know: put it in NETWORKS or DROPPED`);
    if (!isObject(value)) throw new Error(`/info/ ${key} is not an object`);
    // A native coin at the top level is named by its key alone; a coin on a network, by both.
    if ("minimum_transaction_coin" in value) {
      entries.push({ networkKey: key, token: key, ticker: key, entry: value });
      continue;
    }
    for (const [token, entry] of Object.entries(value)) {
      if (!isObject(entry)) throw new Error(`/info/ ${key}/${token} is not an object`);
      entries.push({ networkKey: key, token, ticker: `${key}/${token}`, entry });
    }
  }
  const byTicker = new Map(entries.map((e) => [e.ticker, e.entry]));
  const coins: Coin[] = entries.map(({ networkKey, token, ticker, entry }) => {
    const network = NETWORKS[networkKey]!;
    const name = NAME_FIXES[ticker] ?? (typeof entry.coin === "string" && entry.coin.trim() ? entry.coin.trim() : token.toUpperCase());
    const feesIn = byTicker.get(network.feesIn);
    if (!feesIn) throw new Error(`${ticker}: /info/ has no ${network.feesIn}, the coin its fees are paid in`);
    const prices = isObject(feesIn.prices) ? feesIn.prices : {};
    const feeUsd = feeInDollars(entry.network_fee_estimation, prices.USD, ticker);
    return {
      ticker,
      callbackCoin: ticker.replace("/", "_"),
      symbol: token.toUpperCase(),
      name,
      network: network.name,
      family: network.family,
      kind: token === network.native ? "native" : "token",
      minimum: minimumOf(entry.minimum_transaction_coin, ticker),
      feeUsd,
      cheap: isCheap(feeUsd),
      stable: USD_STABLECOINS.has(token),
    };
  });
  coins.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  const seen = new Set<string>();
  for (const c of coins) {
    if (seen.has(c.ticker)) throw new Error(`ticker ${c.ticker} appears twice`);
    seen.add(c.ticker);
  }
  return coins;
}

const entryLine = (c: Coin) =>
  `  { ticker: ${JSON.stringify(c.ticker)}, callbackCoin: ${JSON.stringify(c.callbackCoin)}, symbol: ${JSON.stringify(c.symbol)}, ` +
  `name: ${JSON.stringify(c.name)}, network: ${JSON.stringify(c.network)}, family: ${JSON.stringify(c.family)}, kind: ${JSON.stringify(c.kind)}, ` +
  `minimum: ${JSON.stringify(c.minimum)}, feeUsd: ${JSON.stringify(c.feeUsd)}, cheap: ${c.cheap}, stable: ${c.stable} },`;

/** The whole of src/funding/coins.ts. `date` is the UTC day /info/ was read. */
export function renderTable(coins: readonly Coin[], date: string): string {
  return `// GENERATED by scripts/cryptapi-coins.ts from https://api.cryptapi.io/info/ on ${date}.
// Do not edit by hand: run \`node scripts/cryptapi-coins.ts --write\` and commit the result.
//
// The coins a SPACE can be funded with: those CryptAPI forwards on a network the service
// has a receiving wallet for (every EVM network, Solana, Bitcoin, Tron). ${coins.length} coins.
// cheap: feeUsd, CryptAPI's estimate of the network fee to forward a deposit, is below $${CHEAP_BELOW_USD}.

/** Which receiving wallet a coin is forwarded to. Every EVM network shares one. */
export type CoinFamily = "evm" | "solana" | "btc" | "tron";

export const COIN_FAMILIES: readonly CoinFamily[] = ["evm", "solana", "btc", "tron"];

export interface Coin {
  /** As CryptAPI's paths spell it: \`btc\`, \`base/usdc\`, \`trc20/usdt\`. */
  readonly ticker: string;
  /** As a callback's \`coin\` field spells it: the ticker with \`_\` for \`/\`. CryptAPI documents
   * this form for erc20, bep20, trc20 and polygon tokens; the rest follow the same rule. */
  readonly callbackCoin: string;
  /** The coin's own ticker, upper case: \`USDC\`. */
  readonly symbol: string;
  /** CryptAPI's name for the coin. */
  readonly name: string;
  /** The network it moves on, as a person reads it. */
  readonly network: string;
  readonly family: CoinFamily;
  /** native: the coin that pays the network's fees; token: any other coin on it. */
  readonly kind: "native" | "token";
  /** The smallest deposit CryptAPI forwards, in the coin's units, as a decimal. */
  readonly minimum: string;
  /** CryptAPI's estimate of the network fee to forward one deposit, in dollars, to the cent,
   * when the table was made: /info/'s network_fee_estimation, in the coin its network's
   * fees are paid in, times that coin's price. Read by the generator alone. */
  readonly feeUsd: string;
  /** feeUsd is below $${CHEAP_BELOW_USD}. */
  readonly cheap: boolean;
  /** A USD stablecoin, credited one for one. */
  readonly stable: boolean;
}

/** The UTC day the minimums were read from CryptAPI. */
export const COINS_AS_OF = "${date}";

export const COINS: readonly Coin[] = [
${coins.map(entryLine).join("\n")}
];

const BY_TICKER = new Map(COINS.map((c) => [c.ticker, c]));
const BY_CALLBACK_COIN = new Map(COINS.map((c) => [c.callbackCoin, c]));

/** The coin CryptAPI's path names, or undefined when the service does not offer it. */
export function coinByTicker(ticker: string): Coin | undefined {
  return BY_TICKER.get(ticker);
}

/** The coin a callback's \`coin\` field names, or undefined when the service does not offer it. */
export function coinByCallbackCoin(coin: string): Coin | undefined {
  return BY_CALLBACK_COIN.get(coin);
}
`;
}

async function readInfo(from: string | undefined): Promise<unknown> {
  if (from) return JSON.parse(readFileSync(from, "utf8"));
  const base = (process.env.CRYPTAPI_BASE ?? "https://api.cryptapi.io").replace(/\/+$/, "");
  const res = await fetch(`${base}/info/`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${base}/info/ answered ${res.status}`);
  return res.json();
}

if (import.meta.filename === process.argv[1]) {
  const at = process.argv.indexOf("--from");
  const from = at >= 0 ? process.argv[at + 1] : undefined;
  const info = await readInfo(from);
  const coins = coinsFromInfo(info);
  const text = renderTable(coins, new Date().toISOString().slice(0, 10));
  if (process.argv.includes("--write")) {
    writeFileSync(TABLE_FILE, text);
    if (from === undefined) writeFileSync(INFO_FILE, JSON.stringify(info));
    process.stdout.write(`src/funding/coins.ts written: ${coins.length} coins${from === undefined ? ", and the /info/ it was made from" : ""}\n`);
  } else {
    process.stdout.write(text);
  }
}
