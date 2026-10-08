// The URL the provider calls back when a deposit arrives, and the mac that makes it
// unguessable.
//
//   ${base}/funding/cryptapi/${space_id}/${callbackCoin}/${mac}
//
// The mac is HMAC-SHA256 under FUNDING_CALLBACK_SECRET over "cryptapi", the SPACE's id, the
// ticker and the wallet, each after a NUL, as base64url with no padding: always 43
// characters. The wallet is an input because an address's forwarding wallet never changes:
// a new wallet must get a new URL, and so a new address, with no counter of its own. The
// same inputs give the same mac, so a retry, or two requests at once, send the provider the
// same URL and get the same address back.
//
// Every character of the URL is in [A-Za-z0-9:/._-], so the provider's URL-encoding of it
// round-trips exactly. Once a row holds a URL it is never rebuilt: a callback finds its row
// by the mac stored there, so changing the secret later breaks nothing already made.

import { createHmac } from "node:crypto";
import { coinByTicker, type Coin, type CoinFamily } from "./coins.ts";

/** A wallet as the mac reads it: lower case for an EVM wallet, whose case is only a checksum; as configured otherwise. */
export function walletKey(family: CoinFamily, wallet: string): string {
  return family === "evm" ? wallet.toLowerCase() : wallet;
}

export function callbackMac(secret: Buffer, spaceId: string, ticker: string, wallet: string): string {
  const coin = coinByTicker(ticker);
  if (coin === undefined) throw new Error(`no coin ${ticker} in the table`);
  const preimage = ["cryptapi", spaceId.toLowerCase(), ticker, walletKey(coin.family, wallet)].join("\u0000");
  return createHmac("sha256", secret).update(preimage, "utf8").digest("base64url");
}

export function callbackUrl(base: string, spaceId: string, coin: Coin, mac: string): string {
  return `${base}/funding/cryptapi/${spaceId.toLowerCase()}/${coin.callbackCoin}/${mac}`;
}
