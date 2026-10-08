// Exact decimals (src/funding/decimal.ts), a callback's fields and its signature, and the
// crediting rule (creditOf in src/funding/callback.ts). No database: every case is a pure
// function. Every wallet and address here is made up.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { JsonNumber, decimalText, parseDecimal, readJson, toMicroFloor } from "../src/funding/decimal.ts";
import { creditOf, parseCallback, signedBy, MalformedCallback, type Callback } from "../src/funding/callback.ts";

const micro = (raw: unknown) => {
  const d = parseDecimal(raw);
  assert.ok(d, `${String(raw)} is a decimal`);
  return toMicroFloor(d);
};
const num = (text: string) => (readJson(`{"v":${text}}`) as { v: unknown }).v;

describe("exact decimals", () => {
  test("1.000000000000000001, as a number or as a string, floors to 1,000,000 micro", () => {
    assert.ok(num("1.000000000000000001") instanceof JsonNumber);
    assert.equal(micro(num("1.000000000000000001")), 1_000_000n);
    assert.equal(micro("1.000000000000000001"), 1_000_000n);
    // A float would have said 1, and so would the floor: the text is kept.
    assert.equal((num("1.000000000000000001") as JsonNumber).source, "1.000000000000000001");
    assert.equal(micro(num("1.9999999")), 1_999_999n);
  });

  test("exponent forms are exact: 0E-8 is 0, 1E-7 floors to 0, 1E+2, 1.5e1", () => {
    assert.equal(micro("0E-8"), 0n);
    assert.equal(micro(num("1E-7")), 0n);
    assert.equal(micro("1E-6"), 1n);
    assert.equal(micro("1E+2"), 100_000_000n);
    assert.equal(micro(num("1.5e1")), 15_000_000n);
    assert.equal(micro("+2.5"), 2_500_000n);
    assert.deepEqual(parseDecimal("1E+2"), { digits: 100n, scale: 0 });
    assert.equal(decimalText(parseDecimal("1.50E-3")!), "0.00150");
    assert.equal(decimalText(parseDecimal("12E1")!), "120");
  });

  test("-1, NaN, Infinity, an empty string and a value that is not text or a number are not decimals", () => {
    for (const raw of ["-1", num("-1"), "NaN", "Infinity", "", " 1", "1.", ".5", "0x10", true, null, {}]) {
      assert.equal(parseDecimal(raw), null, String(raw));
    }
  });

  test("81 digits are not a decimal, 80 are; an exponent past 40 either way is not", () => {
    assert.equal(parseDecimal("9".repeat(81)), null);
    assert.ok(parseDecimal("9".repeat(80)));
    assert.equal(parseDecimal("1." + "0".repeat(80)), null);
    assert.ok(parseDecimal("1E40"));
    assert.equal(parseDecimal("1E41"), null);
    assert.equal(parseDecimal("1E-41"), null);
    assert.equal(parseDecimal("1E0000000000041"), null);
  });
});

/** A confirmed callback's body, as CryptAPI's json=1 sends it, with `over` on top. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: "5b0a2f6e-0c1d-4e2f-8a3b-4c5d6e7f8a9b",
    address_in: `0x${"1a".repeat(20)}`,
    address_out: `0x${"fa".repeat(20)}`,
    txid_in: `0x${"ab".repeat(32)}`,
    txid_out: `0x${"cd".repeat(32)}`,
    confirmations: 1,
    value_coin: 10,
    value_forwarded_coin: 9.9,
    fee_coin: 0.1,
    value_forwarded_coin_convert: '{"USD": "9.90"}',
    coin: "base_usdc",
    price: 1,
    pending: 0,
    ...over,
  };
}
const raw = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o));

describe("a callback's fields", () => {
  test("a convert field as a JSON-encoded string and as an object both give USD", () => {
    assert.equal(toMicroFloor(parseCallback(raw(body({ value_forwarded_coin_convert: '{"USD": "3.17"}' }))).usd!), 3_170_000n);
    assert.equal(toMicroFloor(parseCallback(raw(body({ value_forwarded_coin_convert: { USD: "3.17" } }))).usd!), 3_170_000n);
    assert.equal(toMicroFloor(parseCallback(raw(body({ value_forwarded_coin_convert: { USD: 3.17 } }))).usd!), 3_170_000n);
    // Missing or unreadable is no USD value, not a malformed callback.
    assert.equal(parseCallback(raw(body({ value_forwarded_coin_convert: undefined }))).usd, null);
    assert.equal(parseCallback(raw(body({ value_forwarded_coin_convert: "not json" }))).usd, null);
    assert.equal(parseCallback(raw(body({ value_forwarded_coin_convert: { EUR: "3" } }))).usd, null);
  });

  test("pending is 1 or 0, as a number or a string; anything else is malformed", () => {
    assert.equal(parseCallback(raw(body({ pending: "0" }))).pending, false);
    assert.equal(parseCallback(raw(body({ pending: 1, value_coin: undefined, value_forwarded_coin: undefined }))).pending, true);
    for (const pending of [2, "yes", true, null, undefined]) {
      assert.throws(() => parseCallback(raw(body({ pending }))), (e: MalformedCallback) => e.field === "pending");
    }
    // 1.0 is the number one, but not as CryptAPI writes the flag.
    assert.throws(() => parseCallback(Buffer.from(JSON.stringify(body()).replace('"pending":0', '"pending":0.0'))), MalformedCallback);
  });

  test("a body that is not JSON, not UTF-8, or lacks a required field is malformed, naming the field and the uuid read", () => {
    assert.throws(() => parseCallback(Buffer.from("uuid=1&pending=0")), (e: MalformedCallback) => e.field === "body");
    assert.throws(() => parseCallback(Buffer.from([0x7b, 0xff, 0x7d])), (e: MalformedCallback) => e.field === "body");
    assert.throws(() => parseCallback(raw(body({ txid_in: undefined }))), (e: MalformedCallback) => e.field === "txid_in" && e.uuid === body().uuid);
    assert.throws(() => parseCallback(raw(body({ value_forwarded_coin: undefined }))), (e: MalformedCallback) => e.field === "value_forwarded_coin");
    assert.throws(() => parseCallback(raw(body({ value_coin: "-1" }))), (e: MalformedCallback) => e.field === "value_coin");
    assert.throws(() => parseCallback(raw(body({ uuid: "not-a-uuid" }))), (e: MalformedCallback) => e.field === "uuid" && e.uuid === null);
    assert.throws(() => parseCallback(raw(body({ coin: "base\u0000usdc" }))), (e: MalformedCallback) => e.field === "coin");
  });

  test("several wallets in address_out are read as none, which the address will not match", () => {
    assert.equal(parseCallback(raw(body({ address_out: { [`0x${"fa".repeat(20)}`]: 1 } }))).addressOut, null);
  });
});

describe("the signature", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signed = raw(body());
  const sig = createSign("RSA-SHA256").update(signed).sign(pair.privateKey, "base64");

  test("verifies over the raw bytes, and over nothing else", () => {
    assert.equal(signedBy(signed, sig, pem), true);
    assert.equal(signedBy(Buffer.concat([signed, Buffer.from(" ")]), sig, pem), false);
    assert.equal(signedBy(signed, undefined, pem), false);
    assert.equal(signedBy(signed, "not base64!", pem), false);
    assert.equal(signedBy(signed, sig.slice(0, 40), pem), false);
    const other = generateKeyPairSync("rsa", { modulusLength: 1024 });
    assert.equal(signedBy(signed, createSign("RSA-SHA256").update(signed).sign(other.privateKey, "base64"), pem), false);
  });
});

describe("creditOf", () => {
  const cb = (over: Record<string, unknown> = {}): Callback => parseCallback(raw(body(over)));

  test("a stablecoin is one for one, whatever price or the convert field says", () => {
    assert.deepEqual(creditOf(cb({ value_forwarded_coin: "10.5000009", price: 2, value_forwarded_coin_convert: '{"USD": "999"}' })), {
      family: "evm", stable: true, usdMicro: 10_500_000n, hold: null,
    });
  });

  test("any other coin is the convert field's USD", () => {
    assert.deepEqual(creditOf(cb({ coin: "base_eth", value_forwarded_coin: "0.001", value_forwarded_coin_convert: '{"USD": "3.1700009"}' })), {
      family: "evm", stable: false, usdMicro: 3_170_000n, hold: null,
    });
  });

  test("no USD value is no_usd_value; an unknown coin is unknown_coin; nothing forwarded is zero_value", () => {
    assert.equal(creditOf(cb({ coin: "base_eth", value_forwarded_coin_convert: undefined })).hold, "no_usd_value");
    assert.deepEqual(creditOf(cb({ coin: "base_xyz" })), { family: null, stable: null, usdMicro: null, hold: "unknown_coin" });
    assert.equal(creditOf(cb({ value_forwarded_coin: 0 })).hold, "zero_value");
    assert.equal(creditOf(cb({ value_forwarded_coin: "0.0000009" })).hold, "zero_value");
    assert.equal(creditOf(cb({ coin: "base_eth", value_forwarded_coin_convert: '{"USD": "0.0000001"}' })).hold, "zero_value");
  });

  test("an amount past what a bigint holds is held for review", () => {
    assert.deepEqual(creditOf(cb({ value_forwarded_coin: "9".repeat(20) })), { family: "evm", stable: true, usdMicro: null, hold: "review" });
  });

  test("a pending callback is never credited", () => {
    const pending = cb({ pending: 1, value_coin: 10, value_forwarded_coin: undefined });
    assert.deepEqual(creditOf(pending), { family: "evm", stable: true, usdMicro: null, hold: null });
    assert.deepEqual(creditOf({ ...pending, coin: "base_xyz" }), { family: null, stable: null, usdMicro: null, hold: null });
  });
});
