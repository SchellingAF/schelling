// The requests the service makes to CryptAPI: an address made for a callback URL, and the
// key callbacks are signed with.
//
// A plain fetch, not src/oauth/fetch.ts: the address is the service's own configuration,
// CRYPTAPI_BASE, never one somebody else chose. It goes through cfg.fetch, so a test can
// prove that no request leaves where none may.
//
// An attempt has cfg.timeoutMs (10 s). A network error, a timeout or a 5xx is tried once
// more, which is safe: the same callback URL gets the same address. A 4xx is not. An
// answer is accepted only when every check below holds; anything else is
// FUNDING_UNAVAILABLE and nothing is kept. Nothing logs the request's URL, the mac or a
// wallet: a failure is one line naming the operation, the ticker and what went wrong.

import { createPublicKey } from "node:crypto";
import { ApiError } from "../db/errors.ts";
import type { Coin } from "./coins.ts";
import { PROVIDER_ADDRESS_SHAPES, type FundingConfig } from "./config.ts";

/** The longest request CryptAPI takes, URL and all. */
export const CRYPTAPI_MAX_REQUEST = 8192;

export type MadeAddress = { addressIn: string; addressOut: string; minimum: string };

type Failure = number | "timeout" | "network";

const unavailable = () =>
  new ApiError("FUNDING_UNAVAILABLE", { detail: "the payment provider did not answer, or answered wrongly", retryAfter: 60 });

function logFailure(op: string, ticker: string | null, status: Failure | "answer", reason?: string): void {
  process.stdout.write(`${JSON.stringify({ event: "funding.provider", op, ticker, status, ...(reason ? { reason } : {}) })}\n`);
}

/** A non-negative decimal as plain text, from a number or a string, exponent or not; or null. */
export function plainDecimal(raw: unknown): string | null {
  const text = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : raw;
  if (typeof text !== "string") return null;
  const m = /^(\d{1,40})(?:\.(\d{1,40}))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text);
  if (!m) return null;
  const digits = (m[1]! + (m[2] ?? "")).replace(/^0+(?=\d)/, "");
  const scale = (m[2] ?? "").length - Number(m[3] ?? 0);
  if (scale <= 0) return (digits + "0".repeat(-scale)).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** One GET, timed: the response, or why there was none. */
async function attempt(cfg: FundingConfig, url: string): Promise<Response | Failure> {
  try {
    return await cfg.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (error) {
    return (error as Error)?.name === "TimeoutError" ? "timeout" : "network";
  }
}

/** A GET tried twice when the first meets a network error, a timeout or a 5xx. */
async function getTwice(cfg: FundingConfig, url: string, op: string, ticker: string | null): Promise<Response> {
  for (let i = 0; i < 2; i++) {
    const res = await attempt(cfg, url);
    const failure: Failure | null = typeof res === "object" ? (res.status >= 500 ? res.status : null) : res;
    if (failure === null) return res as Response;
    logFailure(op, ticker, failure);
    if (typeof res === "object") await res.body?.cancel().catch(() => {});
  }
  throw unavailable();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The address CryptAPI makes for `coin` and `callback`, forwarding to `wallet`. The same
 * callback URL is always answered the same address. Throws FUNDING_UNAVAILABLE unless the
 * answer is a success, its address_in has the family's shape, its address_out is the
 * wallet, its callback_url, where present, is the URL sent, and its minimum is a decimal.
 */
export async function createAddress(cfg: FundingConfig, coin: Coin, callback: string, wallet: string): Promise<MadeAddress> {
  const query = [
    `callback=${encodeURIComponent(callback)}`,
    `address=${encodeURIComponent(wallet)}`,
    "pending=1",
    "json=1",
    "convert=1",
    // CryptAPI forwards a token sent to the address that is not the one it was made for
    // only with multi_token, and offers it on the EVM networks and Tron alone.
    ...(coin.family === "evm" || coin.family === "tron" ? ["multi_token=1"] : []),
  ].join("&");
  const url = `${cfg.cryptapiBase}/${coin.ticker}/create/?${query}`;
  if (url.length > CRYPTAPI_MAX_REQUEST) {
    logFailure("create", coin.ticker, "answer", "request_too_long");
    throw unavailable();
  }
  const res = await getTwice(cfg, url, "create", coin.ticker);
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    logFailure("create", coin.ticker, res.status);
    throw unavailable();
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    logFailure("create", coin.ticker, "answer", "not_json");
    throw unavailable();
  }
  const refuse = (reason: string): never => {
    logFailure("create", coin.ticker, "answer", reason);
    throw unavailable();
  };
  if (!isObject(body) || body.status !== "success") return refuse("status");
  const addressIn = body.address_in;
  if (typeof addressIn !== "string" || !PROVIDER_ADDRESS_SHAPES[coin.family].test(addressIn)) return refuse("address_in");
  const out = body.address_out;
  const sameWallet = typeof out === "string" && (coin.family === "evm" ? out.toLowerCase() === wallet.toLowerCase() : out === wallet);
  if (!sameWallet) return refuse("address_out");
  if ("callback_url" in body && body.callback_url !== callback) return refuse("callback_url");
  const minimum = plainDecimal(body.minimum_transaction_coin);
  if (minimum === null) return refuse("minimum");
  // The wallet as configured, which the answer named in its own case: one text for a wallet
  // wherever the service stores or looks it up.
  return { addressIn, addressOut: wallet, minimum };
}

/** Why /pubkey/ gave no key: no answer in time, no connection, a status other than 200, or no PEM public key in it. */
export type PubkeyFailure = "timeout" | "network" | "status" | "parse";

/** The key /pubkey/ answers, as PEM, or why there is none. Tried once. */
async function readPubkey(cfg: FundingConfig): Promise<{ pem: string } | { error: PubkeyFailure; status?: number }> {
  const res = await attempt(cfg, `${cfg.cryptapiBase}/pubkey/`);
  if (typeof res !== "object") return { error: res === "timeout" ? "timeout" : "network" };
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { error: "status", status: res.status };
  }
  try {
    const body = await res.json();
    const pem = isObject(body) && body.status === "success" && typeof body.pubkey === "string" ? body.pubkey.trim() : "";
    createPublicKey(pem);
    return { pem };
  } catch {
    return { error: "parse" };
  }
}

/** The key CryptAPI signs callbacks with, as GET /pubkey/ answers it: a PEM public key. */
export async function fetchPubkey(cfg: FundingConfig): Promise<string> {
  const read = await readPubkey(cfg);
  if ("pem" in read) return read.pem;
  if (read.error === "parse") logFailure("pubkey", null, "answer", "pubkey");
  else logFailure("pubkey", null, read.error === "status" ? read.status! : read.error);
  throw unavailable();
}

/** Two PEM public keys are one key: the same DER once each is trimmed and its line ends made LF. */
export function samePubkey(a: string, b: string): boolean {
  const der = (pem: string) =>
    createPublicKey(pem.trim().replace(/\r\n/g, "\n")).export({ type: "spki", format: "der" });
  try {
    return der(a).equals(der(b));
  } catch {
    return false;
  }
}

/**
 * The check at start: the key /pubkey/ answers now against the key callbacks are checked
 * with, as one funding.pubkey line, {"same":true|false} or {"error":...}. Run only when
 * deposits are open and the service is not read-only. The answer is never used to check a
 * callback: a different key is the operator's to act on (runbooks/credit.md).
 */
export async function pubkeyCheckLine(cfg: FundingConfig): Promise<string> {
  const read = await readPubkey(cfg);
  const result = "pem" in read ? { same: samePubkey(read.pem, cfg.pubkeyPem) } : { error: read.error };
  return JSON.stringify({ event: "funding.pubkey", ...result });
}
