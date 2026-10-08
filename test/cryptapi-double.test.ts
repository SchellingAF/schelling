// The CryptAPI double (test/support/cryptapi-double.ts) plays CryptAPI as its documents
// say it behaves, so tests of deposits run against something true to it:
//   https://docs.cryptapi.io/api/tickercreate                       (making an address)
//   https://docs.cryptapi.io/webhooks/custom-payment-flow-webhooks  (callback fields)
//   https://docs.cryptapi.io/webhooks/verify-webhook-signature      (the signature)
// Needs no database.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createVerify } from "node:crypto";
import { startCryptapiDouble, type CryptapiDouble } from "./support/cryptapi-double.ts";
import { COINS, coinByTicker } from "../src/funding/coins.ts";

/** What a callback receiver saw, byte for byte. */
interface Received { method: string; url: string; headers: Record<string, string | string[] | undefined>; raw: string }

let double: CryptapiDouble;
let receiver: Server;
let receiverBase: string;
const received: Received[] = [];

before(async () => {
  double = await startCryptapiDouble();
  receiver = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      received.push({ method: req.method!, url: req.url!, headers: req.headers, raw });
      res.writeHead(200, { "content-type": "text/plain" }).end("*ok*");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

after(async () => {
  await double.close();
  await new Promise<void>((r) => receiver.close(() => r()));
});

const create = async (ticker: string, params: Record<string, string>) => {
  const res = await fetch(`${double.base}/${ticker}/create/?${new URLSearchParams(params)}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** Verifies as CryptAPI's own Node example does, with the key /pubkey/ answers. */
async function verifies(data: string, signatureB64: string | undefined): Promise<boolean> {
  if (!signatureB64) return false;
  const { pubkey } = (await (await fetch(`${double.base}/pubkey/`)).json()) as { pubkey: string };
  const v = createVerify("RSA-SHA256");
  v.update(data);
  return v.verify(pubkey, Buffer.from(signatureB64, "base64"));
}

const last = () => received.at(-1)!;

describe("making an address", () => {
  test("the same callback gets the same address; another callback, another", async () => {
    const cb = `${receiverBase}/v1/funding/cryptapi/1/space-a/base_usdc?n=1`;
    const params = { callback: cb, address: "0xWALLET", pending: "1", json: "1", convert: "1", multi_token: "1" };
    const a = await create("base/usdc", params);
    const b = await create("base/usdc", params);
    const c = await create("base/usdc", { ...params, callback: `${cb}2` });
    assert.equal(a.status, 200);
    assert.deepEqual(Object.keys(a.body), ["address_in", "address_out", "callback_url", "priority", "minimum_transaction_coin", "status"]);
    assert.equal(a.body.status, "success");
    assert.equal(a.body.address_out, "0xWALLET");
    assert.equal(a.body.callback_url, cb);
    assert.equal(a.body.minimum_transaction_coin, Number(coinByTicker("base/usdc")!.minimum));
    assert.match(String(a.body.address_in), /^0x[0-9a-f]{40}$/);
    assert.equal(b.body.address_in, a.body.address_in);
    assert.notEqual(c.body.address_in, a.body.address_in);
    assert.equal(double.addressFor("base/usdc", cb), a.body.address_in);
  });

  test("a changed wallet does not change address_out for a callback already used", async () => {
    const cb = `${receiverBase}/sticky`;
    await create("trc20/usdt", { callback: cb, address: "TFIRST" });
    const again = await create("trc20/usdt", { callback: cb, address: "TSECOND" });
    assert.equal(again.body.address_out, "TFIRST");
  });

  test("addresses are shaped by family", async () => {
    const shape: Record<string, RegExp> = { btc: /^bc1q[02-9ac-hj-np-z]{38}$/, "sol/usdc": /^[1-9A-HJ-NP-Za-km-z]{44}$/, "trc20/usdt": /^T[1-9A-HJ-NP-Za-km-z]{33}$/ };
    for (const [ticker, re] of Object.entries(shape)) {
      const out = await create(ticker, { callback: `${receiverBase}/shape/${ticker}`, address: "w" });
      assert.match(String(out.body.address_in), re, ticker);
    }
  });

  test("records every request with its query", async () => {
    const before = double.requests.length;
    await create("btc", { callback: `${receiverBase}/rec`, address: "bc1qx", pending: "1" });
    const r = double.requests.at(-1)!;
    assert.equal(double.requests.length, before + 1);
    assert.deepEqual([r.method, r.path, r.ticker, r.query.callback, r.query.pending], ["GET", "/btc/create/", "btc", `${receiverBase}/rec`, "1"]);
  });

  test("refuses an unknown ticker and a missing callback as CryptAPI does", async () => {
    const unknown = await create("ltc", { callback: `${receiverBase}/x`, address: "w" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.status, "error");
    const missing = await create("btc", { address: "w" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.status, "error");
  });

  test("can fail or hang the next requests, for retries and timeouts", async () => {
    double.failNext(1, 502);
    const failed = await create("btc", { callback: `${receiverBase}/f`, address: "w" });
    assert.equal(failed.status, 502);
    const ok = await create("btc", { callback: `${receiverBase}/f`, address: "w" });
    assert.equal(ok.status, 200);
    double.hangNext(1);
    await assert.rejects(fetch(`${double.base}/btc/create/?callback=x&address=w`, { signal: AbortSignal.timeout(200) }));
  });
});

describe("/info/ and /pubkey/", () => {
  test("/info/ has CryptAPI's shape for the offered coins", async () => {
    const info = (await (await fetch(`${double.base}/info/`)).json()) as Record<string, any>;
    assert.equal(info.btc.minimum_transaction_coin, coinByTicker("btc")!.minimum);
    assert.equal(info.base.usdc.minimum_transaction_coin, coinByTicker("base/usdc")!.minimum);
    assert.equal(info.trc20.usdt.ticker, "usdt");
    assert.ok(Array.isArray(info.fee_tiers));
    let n = 0;
    for (const [k, v] of Object.entries(info)) if (k !== "fee_tiers") n += "minimum_transaction_coin" in v ? 1 : Object.keys(v).length;
    assert.equal(n, COINS.length);
  });

  test("/pubkey/ answers the double's key as PEM", async () => {
    const body = (await (await fetch(`${double.base}/pubkey/`)).json()) as { status: string; pubkey: string };
    assert.equal(body.status, "success");
    assert.match(body.pubkey, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/);
    assert.equal(body.pubkey, double.publicKeyPem);
  });
});

describe("callbacks, signed as CryptAPI signs them", () => {
  const made = async (path: string, ticker = "base/usdc") => {
    const cb = `${receiverBase}${path}`;
    await create(ticker, { callback: cb, address: "0xOURWALLET", pending: "1", json: "1", convert: "1", multi_token: "1" });
    return cb;
  };

  test("a pending callback: JSON POST, the raw body signed with RSA-SHA256, base64 in x-ca-signature", async () => {
    const cb = await made("/cb/pending?space=s1");
    const dep = double.deposit(cb, { value: "25" });
    const sent = await dep.pending();
    assert.equal(sent.status, 200);
    assert.equal(sent.responseBody, "*ok*");
    const r = last();
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/cb/pending?space=s1", "the callback URL's own query comes back");
    assert.equal(r.headers["content-type"], "application/json");
    assert.equal(r.raw, sent.body);
    assert.equal(await verifies(r.raw, r.headers["x-ca-signature"] as string), true);
    const body = JSON.parse(r.raw);
    assert.deepEqual(Object.keys(body), ["uuid", "address_in", "address_out", "txid_in", "coin", "price", "pending"]);
    assert.equal(body.pending, 1);
    assert.equal(body.coin, "base_usdc");
    assert.equal(body.address_in, double.addressFor("base/usdc", cb));
    assert.equal(body.address_out, "0xOURWALLET");
    assert.equal(typeof body.price, "number");
    assert.match(body.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("a confirmed callback carries every confirmed field, with CryptAPI's types", async () => {
    const cb = await made("/cb/confirmed");
    const dep = double.deposit(cb, { value: "25", price: "0.9998" });
    const pending = JSON.parse((await dep.pending()).body);
    const sent = await dep.confirmed();
    const r = last();
    assert.equal(await verifies(r.raw, r.headers["x-ca-signature"] as string), true);
    const body = JSON.parse(r.raw);
    assert.deepEqual(Object.keys(body), [
      "uuid", "address_in", "address_out", "txid_in", "txid_out", "confirmations", "value_coin", "value_coin_convert",
      "value_forwarded_coin", "value_forwarded_coin_convert", "fee_coin", "coin", "price", "pending",
    ]);
    assert.equal(body.pending, 0);
    assert.equal(body.uuid, pending.uuid, "one payment keeps one uuid");
    assert.equal(body.txid_in, pending.txid_in);
    for (const k of ["confirmations", "value_coin", "value_forwarded_coin", "fee_coin", "price", "pending"]) assert.equal(typeof body[k], "number", k);
    for (const k of ["value_coin_convert", "value_forwarded_coin_convert"]) assert.equal(typeof body[k], "string", k);
    assert.equal(body.value_coin, 25);
    assert.equal(body.fee_coin, 0.25);
    assert.equal(body.value_forwarded_coin, 24.75);
    assert.deepEqual(JSON.parse(body.value_forwarded_coin_convert), { USD: "24.75" });
    assert.match(sent.body, /"value_forwarded_coin_convert": "\{\\"USD\\": \\"24\.75\\"\}"/, "a JSON-encoded string, spaced as CryptAPI's example");
  });

  test("numbers as strings, the convert fields as objects, and no convert at all", async () => {
    const cb = await made("/cb/forms");
    await double.deposit(cb, { value: "1.5" }).confirmed({ numbers: "string", convert: "object" });
    const body = JSON.parse(last().raw);
    assert.equal(body.value_forwarded_coin, "1.485");
    assert.equal(body.pending, "0");
    assert.deepEqual(body.value_forwarded_coin_convert, { USD: "1.49" });
    await double.deposit(cb, { value: "1.5", usd: null }).confirmed();
    assert.equal("value_forwarded_coin_convert" in JSON.parse(last().raw), false);
  });

  test("another coin than the address was made for, exact decimals, and given amounts", async () => {
    const cb = await made("/cb/other", "trc20/usdt");
    await double.deposit(cb, { value: "0.000000000000000001", coin: "trc20_usdd", fee: "0", usd: "0.00" }).confirmed();
    const r = last();
    assert.equal(await verifies(r.raw, r.headers["x-ca-signature"] as string), true);
    assert.match(r.raw, /"value_coin": 0\.000000000000000001,/);
    assert.equal(JSON.parse(r.raw).coin, "trc20_usdd");
  });

  test("form POST signs the raw body; GET signs the full URL", async () => {
    const cb = await made("/cb/modes?space=s2");
    const form = await double.deposit(cb, { value: "3" }).confirmed({ mode: "form" });
    let r = last();
    assert.equal(r.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(form.signedData, r.raw);
    assert.equal(await verifies(r.raw, r.headers["x-ca-signature"] as string), true);
    assert.equal(new URLSearchParams(r.raw).get("pending"), "0");

    const get = await double.deposit(cb, { value: "3" }).pending({ mode: "get" });
    r = last();
    assert.equal(r.method, "GET");
    assert.equal(r.raw, "");
    assert.equal(get.signedData, `${receiverBase}${r.url}`);
    assert.equal(new URL(get.signedData).searchParams.get("space"), "s2");
    assert.equal(new URL(get.signedData).searchParams.get("pending"), "1");
    assert.equal(await verifies(get.signedData, r.headers["x-ca-signature"] as string), true);
  });

  test("forged callbacks fail verification: a stranger's key, an altered body, no signature", async () => {
    const cb = await made("/cb/forged");
    const dep = double.deposit(cb, { value: "100" });

    await dep.confirmed({ signWith: "stranger" });
    let r = last();
    assert.ok(r.headers["x-ca-signature"]);
    assert.equal(await verifies(r.raw, r.headers["x-ca-signature"] as string), false);

    await dep.confirmed({ alter: (body) => body.replace('"value_forwarded_coin": 99', '"value_forwarded_coin": 9999') });
    r = last();
    assert.match(r.raw, /"value_forwarded_coin": 9999/);
    assert.equal(await verifies(r.raw, r.headers["x-ca-signature"] as string), false);

    await dep.confirmed({ signature: null });
    r = last();
    assert.equal(r.headers["x-ca-signature"], undefined);
  });

  test("a callback to a URL no address was made for, and every callback sent is recorded", async () => {
    const url = `${receiverBase}/cb/never-made`;
    assert.throws(() => double.deposit(url, { value: "1" }), /no address/);
    const n = double.callbacks.length;
    const sent = await double.deposit(url, { value: "1", ticker: "sol/usdc", addressOut: "SOLWALLET" }).confirmed();
    assert.equal(JSON.parse(sent.body).coin, "sol_usdc");
    assert.equal(JSON.parse(sent.body).address_out, "SOLWALLET");
    assert.equal(double.callbacks.length, n + 1);
    assert.equal(double.callbacks.at(-1)!.url, url);
  });
});
