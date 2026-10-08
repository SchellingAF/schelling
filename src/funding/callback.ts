// A deposit callback from CryptAPI: its signature, its fields, and what it credits.
//
// The signature is checked over the raw body, byte for byte, before anything is parsed:
// RSA-SHA256 with PKCS#1 v1.5 padding, base64 in x-ca-signature, under the key in
// FundingConfig.pubkeyPem (src/funding/cryptapi-pubkey.ts in live mode). Then the body is
// read as UTF-8 JSON with every number kept as its source text (decimal.ts), so a value is
// credited exactly as CryptAPI wrote it.
//
// creditOf() decides the credit from the fields alone. A stablecoin counts one for one; any
// other coin at the provider's USD value of what was forwarded; both rounded down to the
// micro-dollar. A coin not in the table, no USD value, or nothing worth crediting holds
// the deposit. What needs the address's row (its family, the wallet, the review ceiling, a
// second coin in one transaction, a second payment in one) is decided in SQL, by
// funding_callback() (0152), which also refuses fields that are not the signed body's.

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { coinByCallbackCoin, type CoinFamily } from "./coins.ts";
import { JsonNumber, parseDecimal, readJson, toMicroFloor, type Decimal } from "./decimal.ts";

/** Where callbacks arrive: ${CALLBACK_PREFIX}<space_id>/<callback coin>/<mac>, outside /v1. */
export const CALLBACK_PREFIX = "/funding/cryptapi/";

/** The largest callback body read. CryptAPI's are about 1 KB. */
export const CALLBACK_BYTES = 16 * 1024;

/** Why a deposit is held, not credited. The CHECK on funding_deposits.reason names the same set. */
export type HoldReason = "unknown_coin" | "wrong_family" | "no_usd_value" | "zero_value" | "txid_credited" | "review" | "conflict";

/** The largest amount a bigint column holds. */
const BIGINT_MAX = 2n ** 63n - 1n;

/** The fields of a callback the service reads. Every decimal is exact. */
export type Callback = {
  uuid: string;
  addressIn: string;
  /** null when CryptAPI sent several wallets, which the service never asks for. */
  addressOut: string | null;
  txidIn: string;
  coin: string;
  pending: boolean;
  price: Decimal | null;
  valueCoin: Decimal | null;
  valueForwarded: Decimal | null;
  fee: Decimal | null;
  /** value_forwarded_coin_convert's USD; null when it is missing or unreadable. */
  usd: Decimal | null;
  confirmations: number | null;
  txidOut: string | null;
};

/** A signed body the service cannot read: the field, and the uuid when one was read. */
export class MalformedCallback extends Error {
  readonly field: string;
  readonly uuid: string | null;
  constructor(field: string, uuid: string | null) {
    super(`callback field ${field}`);
    this.field = field;
    this.uuid = uuid;
  }
}

const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const keys = new Map<string, KeyObject>();

/** The body was signed by the holder of `pem`: x-ca-signature is base64 of 128 bytes that verify over `raw`. */
export function signedBy(raw: Buffer, header: string | undefined, pem: string): boolean {
  if (header === undefined || !SIGNATURE.test(header)) return false;
  const signature = Buffer.from(header, "base64");
  if (signature.length !== 128) return false;
  let key = keys.get(pem);
  if (key === undefined) {
    key = createPublicKey(pem);
    keys.set(pem, key);
  }
  try {
    return verify("RSA-SHA256", raw, key, signature);
  } catch {
    return false;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof JsonNumber);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADDRESS = /^[A-Za-z0-9]{20,128}$/;
const PRINTABLE = /^[\x20-\x7e]+$/;

/** USD in a convert field: a JSON-encoded string or an object, its USD a decimal; null when absent or unreadable. */
function convertUsd(raw: unknown): Decimal | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = readJson(value);
    } catch {
      return null;
    }
  }
  return isObject(value) ? parseDecimal(value.USD) : null;
}

/** The callback in a signed body. Throws MalformedCallback naming the first field it cannot read. */
export function parseCallback(raw: Buffer): Callback {
  let text: string;
  let body: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    body = readJson(text);
  } catch {
    throw new MalformedCallback("body", null);
  }
  if (!isObject(body)) throw new MalformedCallback("body", null);

  const uuidRaw = body.uuid;
  const uuid = typeof uuidRaw === "string" && UUID.test(uuidRaw.toLowerCase()) ? uuidRaw.toLowerCase() : null;
  if (uuid === null) throw new MalformedCallback("uuid", null);
  const bad = (field: string): never => {
    throw new MalformedCallback(field, uuid);
  };

  const addressIn = body.address_in;
  if (typeof addressIn !== "string" || !ADDRESS.test(addressIn)) bad("address_in");
  const out = body.address_out;
  let addressOut: string | null = null;
  if (typeof out === "string") {
    if (!ADDRESS.test(out)) bad("address_out");
    addressOut = out;
  } else if (!isObject(out)) bad("address_out");
  const txidIn = body.txid_in;
  if (typeof txidIn !== "string" || txidIn.length > 200 || !PRINTABLE.test(txidIn)) bad("txid_in");
  const coin = body.coin;
  if (typeof coin !== "string" || coin.length > 64 || !PRINTABLE.test(coin)) bad("coin");

  const flag = body.pending instanceof JsonNumber ? body.pending.source : body.pending;
  if (flag !== "0" && flag !== "1") bad("pending");
  const pending = flag === "1";

  /** An optional decimal: absent is null, present must be one. */
  const decimal = (field: string, required: boolean): Decimal | null => {
    const v = body[field];
    if (v === undefined || v === null) return required ? bad(field) : null;
    return parseDecimal(v) ?? bad(field);
  };
  const price = decimal("price", false);
  const valueCoin = decimal("value_coin", !pending);
  const valueForwarded = pending ? null : decimal("value_forwarded_coin", true);
  const fee = pending ? null : decimal("fee_coin", false);
  const usd = pending ? null : convertUsd(body.value_forwarded_coin_convert);

  let confirmations: number | null = null;
  if (!pending && body.confirmations !== undefined && body.confirmations !== null) {
    const c = body.confirmations instanceof JsonNumber ? body.confirmations.source : body.confirmations;
    if (typeof c !== "string" || !/^\d{1,9}$/.test(c)) bad("confirmations");
    confirmations = Number(c);
  }
  let txidOut: string | null = null;
  if (!pending && body.txid_out !== undefined && body.txid_out !== null) {
    const t = body.txid_out;
    if (typeof t !== "string" || t.length > 200 || (t !== "" && !PRINTABLE.test(t))) bad("txid_out");
    txidOut = t as string;
  }

  return {
    uuid,
    addressIn: addressIn as string,
    addressOut,
    txidIn: txidIn as string,
    coin: coin as string,
    pending,
    price,
    valueCoin,
    valueForwarded,
    fee,
    usd,
    confirmations,
    txidOut,
  };
}

/** What a callback credits, as far as its fields decide: the coin's family, whether the table counts it one for one (null when the table has no such coin), the micro-dollars, or why it is held. */
export type Credit = { family: CoinFamily | null; stable: boolean | null; usdMicro: bigint | null; hold: HoldReason | null };

/**
 * The credit a callback asks for. A pending callback credits nothing and holds nothing. A
 * confirmed one: a coin not in the table is held; a stablecoin is value_forwarded_coin one
 * for one, whatever price or the convert field says; any other coin is
 * value_forwarded_coin_convert's USD, held when there is none. Rounded down to the
 * micro-dollar; nothing left is held as zero_value. An amount past what a bigint holds is
 * held for review.
 */
export function creditOf(cb: Callback): Credit {
  const coin = coinByCallbackCoin(cb.coin);
  const family = coin?.family ?? null;
  const stable = coin?.stable ?? null;
  if (cb.pending) return { family, stable, usdMicro: null, hold: null };
  if (coin === undefined) return { family: null, stable, usdMicro: null, hold: "unknown_coin" };
  if (cb.valueForwarded === null || cb.valueForwarded.digits === 0n) return { family, stable, usdMicro: 0n, hold: "zero_value" };
  let usdMicro: bigint;
  if (coin.stable) usdMicro = toMicroFloor(cb.valueForwarded);
  else if (cb.usd === null) return { family, stable, usdMicro: null, hold: "no_usd_value" };
  else usdMicro = toMicroFloor(cb.usd);
  if (usdMicro === 0n) return { family, stable, usdMicro, hold: "zero_value" };
  if (usdMicro > BIGINT_MAX) return { family, stable, usdMicro: null, hold: "review" };
  return { family, stable, usdMicro, hold: null };
}
