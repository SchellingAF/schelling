// scripts/funding-e2e.ts: the environment it starts the service with opens deposits against
// the double, and against nothing else, keeping every variable it was given.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { e2eEnv, E2E_WALLETS } from "../scripts/funding-e2e.ts";
import { WALLET_SHAPES, depositsOpen, fundingConfig } from "../src/funding/config.ts";

test("the runner's environment opens deposits against the double, with every family's wallet, and keeps what it was given", () => {
  const dir = mkdtempSync(join(tmpdir(), "funding-e2e-test-"));
  try {
    const pem = join(dir, "key.pem");
    writeFileSync(pem, generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString());
    const origin = "http://127.0.0.1:3001";
    const given = { PUBLIC_ORIGIN: origin, DB_NAME: "scratch", FUNDING_WALLET_BTC: `bc1q${"q".repeat(38)}`, FUNDING_CALLBACK_SECRET_FILE: "/nowhere" };
    const env = e2eEnv(given, "http://127.0.0.1:49999", pem);
    assert.equal(env.DB_NAME, "scratch");
    assert.equal(env.FUNDING_WALLET_BTC, given.FUNDING_WALLET_BTC, "a wallet it was given is kept");
    assert.equal(env.FUNDING_CALLBACK_SECRET_FILE, undefined);
    const cfg = fundingConfig(env, origin, { fetch: () => assert.fail("no request at configuration") });
    assert.equal(cfg.mode, "double");
    assert.equal(cfg.off, null);
    assert.ok(depositsOpen(cfg));
    assert.deepEqual(Object.keys(cfg.wallets).sort(), ["btc", "evm", "solana", "tron"]);
    for (const [family, wallet] of Object.entries(E2E_WALLETS)) assert.match(wallet, WALLET_SHAPES[family as keyof typeof WALLET_SHAPES]);
    assert.notEqual(e2eEnv(given, "http://127.0.0.1:49999", pem).FUNDING_CALLBACK_SECRET, env.FUNDING_CALLBACK_SECRET, "a fresh secret each start");
    assert.throws(() => e2eEnv({}, "http://127.0.0.1:49999", pem), /PUBLIC_ORIGIN is not set/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
