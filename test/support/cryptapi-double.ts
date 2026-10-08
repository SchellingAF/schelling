// CryptAPI, played in process for tests: an HTTP server on a free port of this machine that
// answers as CryptAPI's documents say it does, and sends signed callbacks the way CryptAPI
// sends them. Point CRYPTAPI_BASE at `double.base`. Its sources:
//   https://docs.cryptapi.io/api/tickercreate                       GET /{ticker}/create/
//   https://docs.cryptapi.io/webhooks/custom-payment-flow-webhooks  the callback's fields
//   https://docs.cryptapi.io/webhooks/verify-webhook-signature      the signature
//
// The signature: RSA-SHA256 with PKCS#1 v1.5 padding, base64, in the `x-ca-signature`
// header. A POST signs its raw body; a GET signs its full URL, query included. CryptAPI's
// key is 1024-bit RSA; the double makes a pair of the same size when it starts, so no key
// is committed. Every address it answers is made from a hash, never a real one.
//
// What the documents leave open, and how the double answers it: one payment keeps one uuid
// from pending to confirmed; the fee is 1% of value_coin (/info/'s fee_percent); a convert
// field holds USD alone; error bodies are {"status": "error", "error": "..."} with words of
// the double's own.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { COINS, coinByTicker, type Coin, type CoinFamily } from "../../src/funding/coins.ts";

/** A request the double answered. `ticker` is the coin the path named, or null. */
export interface DoubleRequest {
  method: string;
  path: string;
  ticker: string | null;
  query: Record<string, string>;
}

/** An address the double made: one per ticker and callback URL, as CryptAPI makes them. */
export interface MadeAddress {
  ticker: string;
  callback: string;
  addressIn: string;
  addressOut: string;
}

/** A callback the double sent, and what the receiver answered. */
export interface CallbackSent {
  url: string;
  method: "POST" | "GET";
  contentType: string | null;
  /** The body sent; "" for a GET. */
  body: string;
  /** What the signature covers: the body signed for a POST, the full URL for a GET. */
  signedData: string;
  signature: string | null;
  status: number;
  responseBody: string;
}

export interface SendOptions {
  /** json (the default): POST, application/json, as `json=1` asks. form: POST, form-encoded,
   * as `post=1` asks. get: the fields in the URL's query, CryptAPI's default. */
  mode?: "json" | "form" | "get";
  /** Every number as a JSON number (the default) or as a string. */
  numbers?: "number" | "string";
  /** value_coin_convert and value_forwarded_coin_convert as a JSON-encoded string (the
   * default, as documented) or as an object. */
  convert?: "string" | "object";
  /** Sign with the double's key (the default) or a stranger's, which /pubkey/ never answers. */
  signWith?: "double" | "stranger";
  /** Changes the body (or, for a GET, the URL) after it was signed: a forgery. */
  alter?: (signed: string) => string;
  /** Replaces the signature header; null leaves the header out. */
  signature?: string | null;
}

export interface DepositOptions {
  /** value_coin, as a decimal in coin units. */
  value: string;
  /** The callback's `coin` field. Default: the coin the address was made for. */
  coin?: string;
  /** The coin's USD price. Default "1". */
  price?: string;
  /** fee_coin. Default 1% of value. value_forwarded_coin is value minus fee. */
  fee?: string;
  /** value_forwarded_coin_convert's USD; value_coin_convert's is worked from value. Default:
   * forwarded times price, to the cent. null leaves both convert fields out, as without
   * `convert=1`. */
  usd?: string | null;
  confirmations?: number;
  uuid?: string;
  txidIn?: string;
  txidOut?: string;
  /** For a callback URL no address was made for: the coin, and the wallet to name. */
  ticker?: string;
  addressOut?: string;
  /** Overrides the address the double made, to send a mismatch. */
  addressIn?: string;
}

export interface Deposit {
  readonly uuid: string;
  readonly txidIn: string;
  pending(options?: SendOptions): Promise<CallbackSent>;
  confirmed(options?: SendOptions): Promise<CallbackSent>;
}

export interface CryptapiDouble {
  /** Where CryptAPI is: `http://127.0.0.1:<port>`, no trailing slash. */
  readonly base: string;
  /** The key /pubkey/ answers, SPKI PEM. */
  readonly publicKeyPem: string;
  readonly requests: DoubleRequest[];
  readonly addresses: MadeAddress[];
  readonly callbacks: CallbackSent[];
  /** The address_in the double answers for this ticker and callback URL. */
  addressFor(ticker: string, callback: string): string;
  /** The next `count` requests to /create/ answer `status` with an error body. */
  failNext(count: number, status?: number): void;
  /** The next `count` requests to /create/ are accepted and never answered. */
  hangNext(count: number): void;
  /** The next request to /create/ that would succeed answers these fields in place of its
   * own: a wrong address_in, address_out or callback_url, as a provider gone wrong might. */
  alterNext(fields: Partial<Record<"address_in" | "address_out" | "callback_url", string>>): void;
  /** A payment into the address made for `callbackUrl`, ready to be called back. */
  deposit(callbackUrl: string, options: DepositOptions): Deposit;
  /** The signature CryptAPI would send with these bytes as a POST body: base64, for x-ca-signature. */
  sign(data: string): string;
  /** Sends fields to a URL, signed as CryptAPI signs; the low-level form of `deposit`. */
  send(url: string, fields: readonly Field[], options?: SendOptions): Promise<CallbackSent>;
  close(): Promise<void>;
}

/** One callback field. A number's value is its decimal text, kept exact. */
export type Field = { name: string; type: "string"; value: string } | { name: string; type: "number"; value: string } | { name: string; type: "convert"; value: Record<string, string> };

// ---- decimals, exact ----------------------------------------------------------------

const parseDecimal = (s: string): { n: bigint; scale: number } => {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a decimal: ${s}`);
  const [i, f = ""] = s.split(".");
  return { n: BigInt(i! + f), scale: f.length };
};
const formatDecimal = (n: bigint, scale: number): string => {
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = scale ? digits.slice(-scale).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + int + (frac ? `.${frac}` : "");
};
const align = (a: string, b: string) => {
  const x = parseDecimal(a), y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return { x: x.n * 10n ** BigInt(scale - x.scale), y: y.n * 10n ** BigInt(scale - y.scale), scale };
};
const sub = (a: string, b: string) => { const { x, y, scale } = align(a, b); return formatDecimal(x - y, scale); };
const percent = (a: string, p: number) => { const x = parseDecimal(a); return formatDecimal(x.n * BigInt(p), x.scale + 2); };
/** a times b, half up to `places`, with trailing zeros kept, as CryptAPI's "3.17". */
const mulFixed = (a: string, b: string, places: number) => {
  const x = parseDecimal(a), y = parseDecimal(b);
  const scale = x.scale + y.scale;
  let n = x.n * y.n;
  if (scale > places) {
    const d = 10n ** BigInt(scale - places);
    n = (n + d / 2n) / d;
  } else n *= 10n ** BigInt(places - scale);
  const digits = n.toString().padStart(places + 1, "0");
  return places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
};

// ---- addresses, made from a hash ----------------------------------------------------

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const stream = (seed: string, length: number) => {
  let out = Buffer.alloc(0);
  for (let i = 0; out.length < length; i++) out = Buffer.concat([out, createHash("sha256").update(`${i}\n${seed}`).digest()]);
  return out.subarray(0, length);
};
const pick = (alphabet: string, bytes: Buffer) => [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
function fakeAddress(family: CoinFamily, seed: string): string {
  switch (family) {
    case "evm": return `0x${stream(seed, 20).toString("hex")}`;
    case "btc": return `bc1q${pick(BECH32, stream(seed, 38))}`;
    case "solana": return pick(BASE58, stream(seed, 44));
    case "tron": return `T${pick(BASE58, stream(seed, 33))}`;
  }
}

// ---- what CryptAPI answers ----------------------------------------------------------

/** /info/ in CryptAPI's shape, for the offered coins: a native coin at the top level, a
 * coin on a network under its network's key. */
export function infoFor(coins: readonly Coin[]): Record<string, unknown> {
  const info: Record<string, any> = {};
  for (const c of coins) {
    const [network, token] = c.ticker.includes("/") ? c.ticker.split("/") as [string, string] : [null, c.ticker];
    const entry = {
      coin: c.name, logo: "", ticker: token, minimum_transaction: 0, minimum_transaction_coin: c.minimum,
      minimum_fee: 0, minimum_fee_coin: "0E-8", fee_percent: "1.000", network_fee_estimation: c.feeUsd, prices: { USD: "1" },
      prices_updated: "2026-10-08T00:00:00.000Z",
    };
    if (network === null) info[token] = entry;
    else (info[network] ??= {})[token] = entry;
  }
  info.fee_tiers = [{ minimum: "0.00", fee: "1.000" }];
  return info;
}

const pythonJson = (o: Record<string, string>) => `{${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")}}`;

function serialize(fields: readonly Field[], mode: "json" | "form" | "get", numbers: "number" | "string", convert: "string" | "object"): string {
  if (mode === "json") {
    const parts = fields.map((f) => {
      const v = f.type === "string" ? JSON.stringify(f.value)
        : f.type === "number" ? (numbers === "string" ? JSON.stringify(f.value) : f.value)
        : convert === "object" ? pythonJson(f.value) : JSON.stringify(pythonJson(f.value));
      return `${JSON.stringify(f.name)}: ${v}`;
    });
    return `{${parts.join(", ")}}`;
  }
  return new URLSearchParams(fields.map((f) => [f.name, f.type === "convert" ? pythonJson(f.value) : f.value])).toString();
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
};

const rsaPair = () => generateKeyPairSync("rsa", { modulusLength: 1024 });

export async function startCryptapiDouble(options: { info?: Record<string, unknown>; coins?: readonly Coin[] } = {}): Promise<CryptapiDouble> {
  const coins = options.coins ?? COINS;
  const info = options.info ?? infoFor(coins);
  const offered = new Map(coins.map((c) => [c.ticker, c]));
  const own = rsaPair();
  const stranger = rsaPair();
  const publicKeyPem = own.publicKey.export({ type: "spki", format: "pem" }).toString();

  const requests: DoubleRequest[] = [];
  const addresses: MadeAddress[] = [];
  const callbacks: CallbackSent[] = [];
  const made = new Map<string, MadeAddress>();
  const failures: number[] = [];
  const alterations: Partial<Record<"address_in" | "address_out" | "callback_url", string>>[] = [];
  let hangs = 0;

  const addressFor = (ticker: string, callback: string) => {
    const coin = offered.get(ticker) ?? coinByTicker(ticker);
    if (!coin) throw new Error(`the double offers no coin ${ticker}`);
    return fakeAddress(coin.family, `${ticker}\n${callback}`);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://double");
    const query = Object.fromEntries(url.searchParams);
    const createMatch = /^\/(.+)\/create\/?$/.exec(url.pathname);
    const ticker = createMatch ? createMatch[1]! : null;
    requests.push({ method: req.method ?? "", path: url.pathname, ticker, query });
    req.resume();

    if (req.method === "GET" && url.pathname === "/info/") return json(res, 200, info);
    if (req.method === "GET" && url.pathname === "/pubkey/") return json(res, 200, { status: "success", pubkey: publicKeyPem });
    if (req.method !== "GET" || ticker === null) return json(res, 404, { status: "error", error: "Resource not found" });

    if (hangs > 0) { hangs--; return; }
    const failure = failures.shift();
    if (failure !== undefined) return json(res, failure, { status: "error", error: "The double was told to fail this request" });
    if (!offered.has(ticker)) return json(res, 404, { status: "error", error: "Resource not found" });
    const callback = url.searchParams.get("callback");
    const address = url.searchParams.get("address");
    if (!callback) return json(res, 400, { status: "error", error: "callback is required" });
    if (!address) return json(res, 400, { status: "error", error: "address is required" });

    const key = `${ticker}\n${callback}`;
    let row = made.get(key);
    if (!row) {
      // The first wallet named for a callback stays its address_out, as CryptAPI keeps it.
      row = { ticker, callback, addressIn: addressFor(ticker, callback), addressOut: address };
      made.set(key, row);
      addresses.push(row);
    }
    json(res, 200, {
      address_in: row.addressIn,
      address_out: row.addressOut,
      callback_url: callback,
      priority: url.searchParams.get("priority") ?? "default",
      minimum_transaction_coin: Number(offered.get(ticker)!.minimum),
      status: "success",
      ...alterations.shift(),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const sign = (data: string, key: KeyObject) => createSign("RSA-SHA256").update(data).sign(key, "base64");

  async function send(url: string, fields: readonly Field[], o: SendOptions = {}): Promise<CallbackSent> {
    const mode = o.mode ?? "json";
    const encoded = serialize(fields, mode, o.numbers ?? "number", o.convert ?? "string");
    const signedData = mode === "get" ? new URL(`${url}${url.includes("?") ? "&" : "?"}${encoded}`).href : encoded;
    const signature = o.signature !== undefined ? o.signature : sign(signedData, (o.signWith === "stranger" ? stranger : own).privateKey);
    const target = mode === "get" && o.alter ? o.alter(signedData) : mode === "get" ? signedData : url;
    const body = mode === "get" ? "" : o.alter ? o.alter(encoded) : encoded;
    const contentType = mode === "json" ? "application/json" : mode === "form" ? "application/x-www-form-urlencoded" : null;
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    if (signature !== null) headers["x-ca-signature"] = signature;
    const res = await fetch(target, mode === "get" ? { method: "GET", headers } : { method: "POST", headers, body });
    const sent: CallbackSent = { url, method: mode === "get" ? "GET" : "POST", contentType, body, signedData, signature, status: res.status, responseBody: await res.text() };
    callbacks.push(sent);
    return sent;
  }

  function deposit(callbackUrl: string, d: DepositOptions): Deposit {
    const row = d.ticker ? made.get(`${d.ticker}\n${callbackUrl}`) : addresses.find((a) => a.callback === callbackUrl);
    if (!row && !d.ticker) throw new Error(`no address was made for ${callbackUrl}: name a ticker to call it back anyway`);
    const ticker = row?.ticker ?? d.ticker!;
    const coin = d.coin ?? ticker.replace("/", "_");
    const addressIn = d.addressIn ?? row?.addressIn ?? addressFor(ticker, callbackUrl);
    const addressOut = d.addressOut ?? row?.addressOut ?? "";
    const price = d.price ?? "1";
    const fee = d.fee ?? percent(d.value, 1);
    const forwarded = sub(d.value, fee);
    const uuid = d.uuid ?? randomUUID();
    const txidIn = d.txidIn ?? randomBytes(32).toString("hex");
    const txidOut = d.txidOut ?? randomBytes(32).toString("hex");
    const s = (name: string, value: string): Field => ({ name, type: "string", value });
    const n = (name: string, value: string): Field => ({ name, type: "number", value });
    const common = { head: [s("uuid", uuid), s("address_in", addressIn), s("address_out", addressOut), s("txid_in", txidIn)], tail: [s("coin", coin), n("price", price)] };
    const pendingFields = [...common.head, ...common.tail, n("pending", "1")];
    const confirmedFields = (): Field[] => {
      const convert = (name: string, usd: string): Field[] => (d.usd === null ? [] : [{ name, type: "convert", value: { USD: usd } }]);
      return [
        ...common.head,
        s("txid_out", txidOut),
        n("confirmations", String(d.confirmations ?? 1)),
        n("value_coin", d.value),
        ...convert("value_coin_convert", mulFixed(d.value, price, 2)),
        n("value_forwarded_coin", forwarded),
        ...convert("value_forwarded_coin_convert", d.usd ?? mulFixed(forwarded, price, 2)),
        n("fee_coin", fee),
        ...common.tail,
        n("pending", "0"),
      ];
    };
    return {
      uuid,
      txidIn,
      pending: (o) => send(callbackUrl, pendingFields, o),
      confirmed: (o) => send(callbackUrl, confirmedFields(), o),
    };
  }

  return {
    base,
    publicKeyPem,
    requests,
    addresses,
    callbacks,
    addressFor,
    failNext: (count, status = 500) => { for (let i = 0; i < count; i++) failures.push(status); },
    hangNext: (count) => { hangs += count; },
    alterNext: (fields) => { alterations.push(fields); },
    deposit,
    sign: (data) => sign(data, own.privateKey),
    send,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
