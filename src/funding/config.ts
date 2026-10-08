// Deposits: where the provider is, where it calls back, the secret the callback URL's mac
// is made with, and the wallet of each family that deposits are forwarded to. Read once,
// at start, by loadConfig().
//
// The production-host guard. Real addresses are made only by the real provider, and only
// when FUNDING_CALLBACK_BASE and PUBLIC_ORIGIN are both exactly FUNDING_PRODUCTION_BASE. A
// local stack that copies production's variables still has a local PUBLIC_ORIGIN, so it
// makes no real address. A CRYPTAPI_BASE on this machine is a test double; any other
// CRYPTAPI_BASE turns deposits off.
//
//   CRYPTAPI_BASE                          mode     addresses are made when
//   unset, or https://api.cryptapi.io      live     both bases are production, the secret is
//                                                   set, and the coin's family has a wallet
//   http(s) to 127.0.0.1, [::1], localhost double   FUNDING_CALLBACK_BASE is an origin, the
//                                                   secret is set, CRYPTAPI_PUBKEY_FILE is a
//                                                   PEM public key, and the family has a wallet
//   anything else                          off      never
//
// A missing or malformed wallet leaves its family out, and the service starts. A secret set
// but shorter than 32 bytes refuses the start, as a short CHALLENGE_KEY does. Nothing here
// prints a wallet or the secret: fundingConfigLine() names families only.

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { COIN_FAMILIES, type CoinFamily } from "./coins.ts";
import { CRYPTAPI_PUBKEY_PEM } from "./cryptapi-pubkey.ts";

/** The one origin that may receive real callbacks. */
export const FUNDING_PRODUCTION_BASE = "https://api.schellingaf.com";

/** The real provider. */
export const CRYPTAPI_LIVE_BASE = "https://api.cryptapi.io";

/** The shortest callback secret the service starts with. */
export const MIN_FUNDING_SECRET_BYTES = 32;

/** How long one request to the provider may take, in milliseconds. */
export const CRYPTAPI_TIMEOUT_MS = 10_000;

/** The shape of a receiving wallet, and of an address the provider answers, by family. */
export const WALLET_SHAPES: Readonly<Record<CoinFamily, RegExp>> = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  btc: /^bc1q[02-9ac-hj-np-z]{38,58}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

/** The shape of an address_in the provider answers, by family. Bitcoin's may be any of
 * its forms, bech32, legacy (1...) or P2SH (3...), where the service's own wallet is
 * bech32 alone. */
export const PROVIDER_ADDRESS_SHAPES: Readonly<Record<CoinFamily, RegExp>> = {
  ...WALLET_SHAPES,
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
};

/** The variable each family's wallet is read from. */
export const WALLET_VARIABLES: Readonly<Record<CoinFamily, string>> = {
  evm: "FUNDING_WALLET_EVM",
  btc: "FUNDING_WALLET_BTC",
  solana: "FUNDING_WALLET_SOLANA",
  tron: "FUNDING_WALLET_TRON",
};

export type FundingConfig = {
  mode: "live" | "double" | "off";
  /** Why addresses are refused, for the operator's log; null when deposits are open. */
  off: string | null;
  /** No trailing slash. */
  cryptapiBase: string;
  /** FUNDING_CALLBACK_BASE, an origin with no trailing slash. */
  callbackBase: string | null;
  /** FUNDING_CALLBACK_SECRET(_FILE). */
  secret: Buffer | null;
  /** Only the families with a valid wallet; an EVM wallet lower case. */
  wallets: Partial<Record<CoinFamily, string>>;
  /** The key callbacks are checked with. */
  pubkeyPem: string;
  /** Every request to the provider goes through this: the global fetch, or a test's own. */
  fetch: typeof fetch;
  /** One request's timeout, in milliseconds. */
  timeoutMs: number;
};

type Env = Record<string, string | undefined>;

const trimmed = (env: Env, name: string): string => env[name]?.trim() ?? "";

/** The callback secret: absent is null; set and short refuses the start. */
function callbackSecret(env: Env): Buffer | null {
  const file = trimmed(env, "FUNDING_CALLBACK_SECRET_FILE");
  let value: Buffer;
  let where: string;
  if (file !== "" && !file.startsWith("REPLACE_WITH_")) {
    value = Buffer.from(readFileSync(file, "utf8").trim(), "utf8");
    where = `FUNDING_CALLBACK_SECRET_FILE at ${file}`;
  } else {
    const inline = trimmed(env, "FUNDING_CALLBACK_SECRET");
    if (inline === "" || inline.startsWith("REPLACE_WITH_")) return null;
    value = Buffer.from(inline, "utf8");
    where = "FUNDING_CALLBACK_SECRET";
  }
  if (value.length < MIN_FUNDING_SECRET_BYTES) {
    throw new Error(
      `${where} holds ${value.length} bytes once surrounding whitespace is ignored, and at least ${MIN_FUNDING_SECRET_BYTES} are required.\n` +
        "A short secret makes every deposit address's callback URL guessable. Run scripts/first-run.sh, which writes 48 bytes,\n" +
        "or unset it, which leaves deposits off.",
    );
  }
  return value;
}

/** An http(s) origin, written exactly, with no trailing slash; or null. */
function origin(raw: string): string | null {
  const value = raw.replace(/\/+$/, "");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin === value ? value : null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** A PEM public key read from a file, or null when it is not one. */
function pemFile(path: string): string | null {
  if (path === "") return null;
  try {
    const pem = readFileSync(path, "utf8").trim();
    createPublicKey(pem);
    return pem;
  } catch {
    return null;
  }
}

/**
 * Deposits as the environment sets them. `publicOrigin` is PUBLIC_ORIGIN, which the live
 * guard reads too. A test passes its own fetch, which fails the test if it is ever called
 * where no request may go, and may shorten the timeout.
 */
export function fundingConfig(
  env: Env,
  publicOrigin: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): FundingConfig {
  const secret = callbackSecret(env);
  const wallets: Partial<Record<CoinFamily, string>> = {};
  for (const family of COIN_FAMILIES) {
    const wallet = trimmed(env, WALLET_VARIABLES[family]);
    // An EVM wallet's letter case is only a checksum: kept lower case, one text wherever
    // the service stores, looks up or macs it, however the variable spells it.
    if (WALLET_SHAPES[family].test(wallet)) wallets[family] = family === "evm" ? wallet.toLowerCase() : wallet;
  }
  const rawCallback = trimmed(env, "FUNDING_CALLBACK_BASE");
  const callbackBase = rawCallback === "" ? null : origin(rawCallback);
  const rawBase = trimmed(env, "CRYPTAPI_BASE").replace(/\/+$/, "");
  const base = rawBase === "" ? CRYPTAPI_LIVE_BASE : rawBase;

  let mode: FundingConfig["mode"];
  let pubkeyPem = CRYPTAPI_PUBKEY_PEM;
  const reasons: string[] = [];
  if (base === CRYPTAPI_LIVE_BASE) {
    mode = "live";
    if (callbackBase !== FUNDING_PRODUCTION_BASE || publicOrigin !== FUNDING_PRODUCTION_BASE) {
      reasons.push(`FUNDING_CALLBACK_BASE and PUBLIC_ORIGIN are not both ${FUNDING_PRODUCTION_BASE}`);
    }
  } else {
    const host = origin(base) === null ? null : new URL(base).host.replace(/:\d+$/, "");
    if (host !== null && LOOPBACK.has(host)) {
      mode = "double";
      if (callbackBase === null) reasons.push("FUNDING_CALLBACK_BASE is not an http(s) origin");
      const pem = pemFile(trimmed(env, "CRYPTAPI_PUBKEY_FILE"));
      if (pem === null) reasons.push("CRYPTAPI_PUBKEY_FILE is not a readable PEM public key");
      else pubkeyPem = pem;
    } else {
      mode = "off";
      reasons.push("CRYPTAPI_BASE is neither CryptAPI nor this machine");
    }
  }
  if (secret === null) reasons.push("FUNDING_CALLBACK_SECRET is not set");
  if (Object.keys(wallets).length === 0) reasons.push("no FUNDING_WALLET_ is set to a wallet");

  return {
    mode,
    off: reasons.length === 0 ? null : reasons.join("; "),
    cryptapiBase: base,
    callbackBase,
    secret,
    wallets,
    pubkeyPem,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs: options.timeoutMs ?? CRYPTAPI_TIMEOUT_MS,
  };
}

/** Deposits are open: addresses may be made for a coin whose family has a wallet. */
export function depositsOpen(cfg: FundingConfig | undefined): cfg is FundingConfig & { secret: Buffer; callbackBase: string } {
  return cfg !== undefined && cfg.off === null && cfg.secret !== null && cfg.callbackBase !== null;
}

/** The line the service writes at start: the mode, the families with and without a wallet, and why deposits are off. Never a wallet. */
export function fundingConfigLine(cfg: FundingConfig): string {
  const families = COIN_FAMILIES.filter((f) => f in cfg.wallets);
  const missing = COIN_FAMILIES.filter((f) => !(f in cfg.wallets));
  return JSON.stringify({ event: "funding.config", mode: cfg.mode, families, missing, off: cfg.off });
}
