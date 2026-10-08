// Deposits end to end on this machine: the service against a database you name, with
// deposits open against CryptAPI's double (test/support/cryptapi-double.ts), so a person
// or a coordinator makes addresses through the API and sends deposits to them. No request
// leaves this machine: CRYPTAPI_BASE is the double on 127.0.0.1, which the service treats
// as a test double, never the provider.
//
// The site's `npm run stack` starts the product with a fixed environment and no FUNDING_
// variable, so its deposits stay closed. Run this instead, with the variables
// .claude/rules/scripts.md gives for "a server of your own":
//
//   API_HOST=127.0.0.1:3001 PUBLIC_ORIGIN=http://127.0.0.1:3001 PORT=3001 \
//     CHALLENGE_KEY=a-test-challenge-key-not-a-secret DB_PORT=<port> DB_NAME=scratch \
//     DB_USER=schellingaf_api DB_PASSWORD=test_api_password_not_a_secret \
//     WELCOME_SPACE=welcome LOG_DIR=/tmp/sglogs node scripts/funding-e2e.ts
//
// It adds CRYPTAPI_BASE, CRYPTAPI_PUBKEY_FILE, FUNDING_CALLBACK_BASE (PUBLIC_ORIGIN), a
// fresh FUNDING_CALLBACK_SECRET and a made-up wallet for each family not already set. Then
// it reads commands, one a line:
//
//   deposit <address> <value> [coin]   a payment to an address the double made: pending,
//                                       then confirmed; value in the coin's units
//   pending <address> <value> [coin]   the pending callback alone
//   addresses                           every address the double made
//   quit                                stops the service and the double
//
// Each sent callback prints its status and the answer. Nothing it prints is a secret.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startCryptapiDouble } from "../test/support/cryptapi-double.ts";
import { WALLET_VARIABLES } from "../src/funding/config.ts";
import { COIN_FAMILIES, type CoinFamily } from "../src/funding/coins.ts";

/** A made-up wallet of each family's shape: never a real one. */
export const E2E_WALLETS: Readonly<Record<CoinFamily, string>> = {
  evm: `0x${"e2".repeat(20)}`,
  btc: `bc1q${"e".repeat(38)}`,
  solana: `E2e${"W".repeat(37)}`,
  tron: `T${"E".repeat(33)}`,
};

/** The environment the service starts with: `env`, plus what opens deposits against the double at `base`. */
export function e2eEnv(env: Record<string, string | undefined>, base: string, pemFile: string): Record<string, string | undefined> {
  const origin = env.PUBLIC_ORIGIN;
  if (!origin) throw new Error("PUBLIC_ORIGIN is not set: the double calls the service back there");
  const out: Record<string, string | undefined> = {
    ...env,
    CRYPTAPI_BASE: base,
    CRYPTAPI_PUBKEY_FILE: pemFile,
    FUNDING_CALLBACK_BASE: origin,
    FUNDING_CALLBACK_SECRET: randomBytes(36).toString("base64url"),
  };
  delete out.FUNDING_CALLBACK_SECRET_FILE;
  for (const family of COIN_FAMILIES) {
    const name = WALLET_VARIABLES[family];
    if (!out[name]) out[name] = E2E_WALLETS[family];
  }
  return out;
}

async function main(): Promise<void> {
  const double = await startCryptapiDouble();
  const dir = mkdtempSync(join(tmpdir(), "funding-e2e-"));
  const pemFile = join(dir, "cryptapi.pem");
  writeFileSync(pemFile, double.publicKeyPem);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const service = spawn(process.execPath, ["src/server.ts"], { cwd: root, env: e2eEnv(process.env, double.base, pemFile), stdio: ["ignore", "inherit", "inherit"] });
  const stop = async () => {
    service.kill("SIGTERM");
    await double.close();
    rmSync(dir, { recursive: true, force: true });
  };
  service.on("exit", (code) => {
    process.stdout.write(`the service stopped (${code ?? "signal"})\n`);
    void stop().then(() => process.exit(code ?? 0));
  });
  process.stdout.write(`the double answers at ${double.base}; commands: deposit, pending, addresses, quit\n`);

  for await (const line of createInterface({ input: process.stdin })) {
    const [command, address, value, coin] = line.trim().split(/\s+/);
    if (command === "quit") break;
    if (command === "addresses") {
      for (const a of double.addresses) process.stdout.write(`${a.ticker} ${a.addressIn}\n`);
      continue;
    }
    if ((command !== "deposit" && command !== "pending") || !address || !value) {
      process.stdout.write("deposit <address> <value> [coin], pending <address> <value> [coin], addresses or quit\n");
      continue;
    }
    const made = double.addresses.find((a) => a.addressIn === address);
    if (!made) {
      process.stdout.write("the double made no such address: make it with POST /v1/spaces/{name}/funding/addresses first\n");
      continue;
    }
    const deposit = double.deposit(made.callback, { value, ...(coin ? { coin } : {}) });
    const sends = command === "pending" ? [() => deposit.pending()] : [() => deposit.pending(), () => deposit.confirmed()];
    for (const send of sends) {
      const answer = await send();
      process.stdout.write(`${answer.status} ${answer.responseBody}\n`);
    }
  }
  service.removeAllListeners("exit");
  await stop();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
