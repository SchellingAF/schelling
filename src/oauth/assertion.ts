// A client assertion: how an app that publishes its keys proves, at the token
// endpoint, that the request is its own (RFC 7523, `private_key_jwt`).
//
// ChatGPT authenticates this way. Its metadata document names a key set on its own
// origin, and each token request carries a short-lived JWT it signed, naming itself
// as issuer and subject and this service's token endpoint as audience. Everything
// is checked with node:crypto alone: the algorithm against what the app declared,
// the key by its id, the signature, and the claims, including that no assertion is
// used twice.
//
// A signature check is the one thing here that costs real time, and whoever
// publishes a document chooses the keys it is checked with. So it comes last, after
// every check that costs nothing; only a few keys are ever tried for one assertion;
// and an RSA key is one whose checking is cheap: a public exponent of 65537 and at
// most 4096 bits. A key of 3072 bits with an exponent as long as itself, which
// OpenSSL accepts, makes one check cost many times an ordinary one.

import { createHash, createPublicKey, verify as verifySignature, constants, type KeyObject } from "node:crypto";
import { ASSERTION_ALGORITHMS, jsonObject, keysOf, type Client } from "./clients.ts";
import type { FetchFor } from "./fetch.ts";

export const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/** Clock skew allowed either way, and the longest an assertion may claim to live. */
const SKEW_SECONDS = 60;
const LONGEST_SECONDS = 600;

/** The most keys one assertion is checked against. A set naming key ids is checked
 * only against the key it names. */
const KEYS_TRIED = 4;

/** Assertions already used, by the hash of app and jti, until each one's own
 * expiry. A hash, because an app id is up to 2,048 bytes. */
const used = new Map<string, number>();
const USED_KEPT = 100_000;

function part(text: string): Record<string, unknown> | null {
  return jsonObject(Buffer.from(text, "base64url").toString("utf8"));
}

/** A key the algorithm can use, from one JWK, or null. */
function keyFor(jwk: Record<string, unknown>, alg: string): KeyObject | null {
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  if (jwk.alg !== undefined && jwk.alg !== alg) return null;
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    return null;
  }
  const type = key.asymmetricKeyType;
  if (alg === "RS256" || alg === "PS256") {
    const details = key.asymmetricKeyDetails;
    const bits = details?.modulusLength ?? 0;
    return type === "rsa" && bits >= 2048 && bits <= 4096 && details?.publicExponent === 65537n ? key : null;
  }
  if (alg === "ES256") return type === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  if (alg === "EdDSA") return type === "ed25519" ? key : null;
  return null;
}

function signatureHolds(alg: string, key: KeyObject, input: Buffer, signature: Buffer): boolean {
  try {
    if (alg === "RS256") return verifySignature("sha256", input, key, signature);
    if (alg === "PS256") {
      return verifySignature("sha256", input, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    }
    if (alg === "ES256") return verifySignature("sha256", input, { key, dsaEncoding: "ieee-p1363" }, signature);
    if (alg === "EdDSA") return verifySignature(null, input, key, signature);
  } catch {
    return false;
  }
  return false;
}

/**
 * Whether an assertion proves this token request is the app's own. Returns null
 * when it does, and otherwise why not: the reason goes to the request log, and the
 * app is told only invalid_client.
 */
export async function checkAssertion(
  client: Client,
  assertion: string,
  audiences: readonly string[],
  fetchFor: FetchFor = {},
): Promise<string | null> {
  if (client.authMethod !== "private_key_jwt") return "this app does not sign its token requests";
  const pieces = assertion.split(".");
  if (pieces.length !== 3 || assertion.length > 8192) return "not a compact JWT";
  const [headerText, claimsText, signatureText] = pieces as [string, string, string];
  const header = part(headerText);
  const claims = part(claimsText);
  if (!header || !claims) return "a JWT part is not a JSON object";

  const alg = header.alg;
  if (typeof alg !== "string" || !(ASSERTION_ALGORITHMS as readonly string[]).includes(alg)) return "unsupported alg";
  if (client.signingAlg !== null && alg !== client.signingAlg) return "alg is not the one the app declared";
  if (header.crit !== undefined) return "crit is not understood";

  // Every claim, before any key is fetched or any signature checked.
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== client.id || claims.sub !== client.id) return "iss and sub are not the app's id";
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => typeof a === "string" && audiences.includes(a))) return "aud does not name this service's token endpoint";
  if (typeof claims.exp !== "number" || claims.exp <= seconds - SKEW_SECONDS) return "expired";
  if (claims.exp > seconds + LONGEST_SECONDS + SKEW_SECONDS) return "claims to live too long";
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > seconds + SKEW_SECONDS)) return "not yet valid";
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > seconds + SKEW_SECONDS)) return "issued in the future";
  if (typeof claims.jti !== "string" || claims.jti.length === 0 || claims.jti.length > 256) return "no jti";

  for (const [key, until] of used) {
    if (until > now) break;
    used.delete(key);
  }
  const once = createHash("sha256").update(client.id).update(Buffer.from([0])).update(claims.jti).digest("base64url");
  if (used.has(once)) return "this assertion was already used";

  // The key, by its id when the header names one. A key id the set does not have
  // may be a key the app has just rotated to, so the set is fetched again, at most
  // once every five minutes.
  const kid = typeof header.kid === "string" ? header.kid : null;
  const pick = (keys: unknown[]) =>
    (keys as Record<string, unknown>[]).filter((k) => k && typeof k === "object" && (kid === null || k.kid === kid));
  let candidates = pick(await keysOf(client, false, fetchFor));
  if (candidates.length === 0 && kid !== null) candidates = pick(await keysOf(client, true, fetchFor));
  if (candidates.length === 0) return "no key in the app's key set matches";

  const input = Buffer.from(`${headerText}.${claimsText}`, "utf8");
  const signature = Buffer.from(signatureText, "base64url");
  const holds = candidates.slice(0, KEYS_TRIED).some((jwk) => {
    const key = keyFor(jwk, alg);
    return key !== null && signatureHolds(alg, key, input, signature);
  });
  if (!holds) return "the signature does not hold";

  if (used.size >= USED_KEPT) used.delete(used.keys().next().value!);
  used.set(once, (claims.exp + SKEW_SECONDS) * 1000);
  return null;
}
