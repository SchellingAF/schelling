// Identity: minting a challenge, verifying a signature over it, and classifying
// the bearer token on every later request.
//
// The challenge is stateless. It carries its own expiry and its own tag, so
// nothing is written until a signature actually arrives, and a flood of
// challenge requests costs one HMAC each rather than a row each.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";
import type { Config } from "../config.ts";
import type { Db } from "../db/sql.ts";
import {
  CHALLENGE_BYTES,
  CHALLENGE_EXP_BYTES,
  CHALLENGE_NONCE_BYTES,
  CHALLENGE_TTL_SECONDS,
  LABEL_CHALLENGE,
  LABEL_PASSKEY_CHALLENGE,
  TOKEN_PREFIX,
  TOKEN_TTL_DEFAULT_SECONDS,
  TOKEN_TTL_MAX_SECONDS,
  TOKEN_TTL_MIN_SECONDS,
  challengePreimage,
} from "../domain/protocol.ts";
import { fromHex, peerIdOf, sha256, toHex, verifySignature } from "../domain/keys.ts";
import { ApiError } from "../db/errors.ts";
import { mayLookUpToken, noteTokenLookup } from "./ratelimit.ts";

export type Challenge = { peerId: Buffer; challenge: Buffer; expiresAt: Date };

/** What a challenge's tag is made from: its expiry and its nonce, under a key. */
type Signer = (exp: Buffer, nonce: Buffer) => Buffer;

/** The HMAC, under the challenge key, of a label, a NUL byte, then the parts. */
function tag(config: Config, label: string, ...parts: Buffer[]): Buffer {
  const hmac = createHmac("sha256", config.challengeKey).update(Buffer.from(label, "utf8")).update(Buffer.from([0]));
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

/** A KEY's challenge is tagged with the peer id it was minted for. */
function keySigner(config: Config, peerId: Buffer): Signer {
  return (exp, nonce) => tag(config, LABEL_CHALLENGE, peerId, exp, nonce);
}

/**
 * A passkey's names no KEY, because nobody knows which passkey will answer until
 * it has, and it is keyed under its own label, so it can never verify as a
 * challenge minted for an Ed25519 KEY or the other way round.
 */
function passkeySigner(config: Config): Signer {
  return (exp, nonce) => tag(config, LABEL_PASSKEY_CHALLENGE, exp, nonce);
}

/**
 * exp(8) || nonce(16) || tag(32). The expiry is unsigned big-endian seconds:
 * eight bytes so no client has to think about the year 2038, and big-endian so
 * the bytes sort the way the number does.
 */
function mint(sign: Signer, now: Date): { challenge: Buffer; expiresAt: Date } {
  const expSeconds = Math.floor(now.getTime() / 1000) + CHALLENGE_TTL_SECONDS;
  const exp = Buffer.alloc(CHALLENGE_EXP_BYTES);
  exp.writeBigUInt64BE(BigInt(expSeconds));
  const nonce = randomBytes(CHALLENGE_NONCE_BYTES);
  return { challenge: Buffer.concat([exp, nonce, sign(exp, nonce)]), expiresAt: new Date(expSeconds * 1000) };
}

/**
 * Checked in this order on purpose: shape, then expiry, then the tag in constant
 * time. A caller learns "this challenge is stale" without learning anything about
 * the tag. The nonce comes back so a token can record it, which is what makes the
 * challenge single-use.
 */
function open(challenge: Buffer, sign: Signer, now: Date): { nonce: Buffer } | "CHALLENGE_INVALID" | "CHALLENGE_EXPIRED" {
  if (challenge.length !== CHALLENGE_BYTES) return "CHALLENGE_INVALID";
  const exp = challenge.subarray(0, CHALLENGE_EXP_BYTES);
  const nonce = challenge.subarray(CHALLENGE_EXP_BYTES, CHALLENGE_EXP_BYTES + CHALLENGE_NONCE_BYTES);
  const tagged = challenge.subarray(CHALLENGE_EXP_BYTES + CHALLENGE_NONCE_BYTES);
  if (Number(exp.readBigUInt64BE()) * 1000 <= now.getTime()) return "CHALLENGE_EXPIRED";
  if (!timingSafeEqual(sign(exp, nonce), tagged)) return "CHALLENGE_INVALID";
  return { nonce: Buffer.from(nonce) };
}

export function mintPasskeyChallenge(config: Config, now = new Date()): { challenge: Buffer; expiresAt: Date } {
  return mint(passkeySigner(config), now);
}

export function checkPasskeyChallenge(
  config: Config,
  challenge: Buffer,
  now = new Date(),
): { nonce: Buffer } | "CHALLENGE_INVALID" | "CHALLENGE_EXPIRED" {
  return open(challenge, passkeySigner(config), now);
}

export function mintChallenge(config: Config, publicKey: Buffer, now = new Date()): Challenge {
  const peerId = peerIdOf(publicKey);
  return { peerId, ...mint(keySigner(config, peerId), now) };
}

export type VerifyFailure =
  | "CHALLENGE_INVALID"
  | "CHALLENGE_EXPIRED"
  | "SIGNATURE_INVALID";

export type VerifyOk = { peerId: Buffer; nonce: Buffer };

/** The challenge as `open` checks it, and only then the signature. */
export function verifyChallenge(
  config: Config,
  publicKey: Buffer,
  challenge: Buffer,
  signature: Buffer,
  now = new Date(),
): VerifyOk | VerifyFailure {
  const peerId = peerIdOf(publicKey);
  const opened = open(challenge, keySigner(config, peerId), now);
  if (typeof opened === "string") return opened;

  // The audience is what stops a relay: this signature was made for this host.
  const preimage = challengePreimage(config.apiHost, challenge);
  if (!verifySignature(publicKey, preimage, signature)) return "SIGNATURE_INVALID";

  return { peerId, nonce: opened.nonce };
}

export function newToken(): { token: string; hash: Buffer } {
  const token = TOKEN_PREFIX + toHex(randomBytes(32));
  return { token, hash: sha256(token) };
}

export function clampTtl(requested: unknown): number | "INVALID_REQUEST" {
  if (requested === undefined || requested === null) return TOKEN_TTL_DEFAULT_SECONDS;
  if (typeof requested !== "number" || !Number.isInteger(requested)) return "INVALID_REQUEST";
  if (requested < TOKEN_TTL_MIN_SECONDS || requested > TOKEN_TTL_MAX_SECONDS) {
    return "INVALID_REQUEST";
  }
  return requested;
}

// ── the bearer, on every later request ───────────────────────────────────────

export type BearerState =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "expired"; peerId: Buffer }
  | { state: "revoked"; peerId: Buffer }
  | { state: "blocked"; peerId: Buffer }
  | {
      state: "valid";
      peerId: Buffer;
      hash: Buffer;
      expiresAt: Date;
      label: string | null;
      /** What an app's token may do: "read", or "read write". Null for a token a
       * KEY minted for itself, which may do everything its KEY may. */
      scope: string | null;
      /** The app a token was given to, or null. */
      clientId: string | null;
      /** When its KEY registered: a KEY's first day has smaller allowances. */
      registeredAt: Date;
    }
  /**
   * An upload authorization, presented at the file PUT, the one route that looks one up
   * (migrations/0146_exact_uploads.sql): it uploads `sha256` to the SPACE `spaceId`, named
   * `spaceName`, once,
   * as its KEY. Never a token: requireBearer() refuses it, and it holds no token's hash.
   */
  | { state: "upload"; peerId: Buffer; grant: Buffer; registeredAt: Date; spaceId: string; spaceName: string; sha256: Buffer }
  /** An upload authorization that was used, expired, or whose token ended. */
  | { state: "upload_expired" };

/**
 * The code a request is refused with for its token, or null when the token is
 * valid. Each state has its own, because "your token expired" and "that is not a
 * token" need different actions.
 */
export function tokenRefusal(bearer: BearerState): string | null {
  switch (bearer.state) {
    case "valid":
      return null;
    case "none":
      return "TOKEN_MISSING";
    case "expired":
      return "TOKEN_EXPIRED";
    case "revoked":
      return "TOKEN_REVOKED";
    case "blocked":
      return "KEY_BLOCKED";
    case "invalid":
    // An upload authorization is a bearer at the file PUT alone, which reads it itself.
    case "upload":
      return "TOKEN_INVALID";
    case "upload_expired":
      return "UPLOAD_EXPIRED";
  }
}

/** Whether a valid token may write. */
export function mayWrite(bearer: BearerState): boolean {
  return bearer.state === "valid" && (bearer.scope === null || bearer.scope.split(" ").includes("write"));
}

/**
 * The presented token when the header is shaped like one of ours, else null.
 *
 * Free: no database, no hash, no window. It is the four checks classifyBearer
 * makes before its first query, pulled out so the floor in app.ts can ask the
 * same question BEFORE the global gate. A header that is not a well-formed
 * token cannot be a KEY, so a request carrying one is an anonymous caller and
 * takes an anonymous caller's share of the moment — otherwise `Authorization: x`
 * on any route would be a way to skip that share for nothing.
 */
export function wellFormedToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return null;
  const presented = match[1]!;
  if (!presented.startsWith(TOKEN_PREFIX)) return null;
  if (fromHex(presented.slice(TOKEN_PREFIX.length), 32) === null) return null;
  return presented;
}

/** The prefix of an upload authorization: a token's prefix and a word no token's tail holds,
 * so wellFormedToken() reads one as no token, and every route but the file PUT as invalid. */
export const UPLOAD_PREFIX = `${TOKEN_PREFIX}upload_`;

/** The presented upload authorization when the header is shaped like one, else null. */
export function wellFormedGrant(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return null;
  const presented = match[1]!;
  if (!presented.startsWith(UPLOAD_PREFIX)) return null;
  if (fromHex(presented.slice(UPLOAD_PREFIX.length), 32) === null) return null;
  return presented;
}

/** A new upload authorization: the secret, said once in an answer, and the hash kept. */
export function newGrant(): { secret: string; hash: Buffer } {
  const secret = UPLOAD_PREFIX + toHex(randomBytes(32));
  return { secret, hash: sha256(secret) };
}

/**
 * Deliberately distinguishes expired, revoked and invalid. A silent downgrade to
 * anonymous would produce a "not found" an agent cannot diagnose, and the whole
 * error design is that an agent is told what to do next.
 */
export async function classifyBearer(
  db: Db,
  header: string | undefined,
  /** The caller's address, for the guess window. */
  addr: string,
  /**
   * The one address a token given to an app works at, or null where only a token
   * a KEY minted for itself works.
   *
   * The specification requires a server to accept only tokens issued for it. So a
   * token an app was given for /mcp/connect is refused at /v1 and at /mcp, and a
   * KEY's own token is refused at /mcp/connect, each exactly as a token that does
   * not exist is. Refusing it as unknown would count a real token as a guess.
   */
  audience: string | null = null,
  /** Whether this request may carry an upload authorization: the file PUT alone. */
  uploads = false,
): Promise<BearerState> {
  if (!header) return { state: "none" };
  const grant = uploads ? wellFormedGrant(header) : null;
  if (grant !== null) return classifyGrant(db, grant, addr);
  const presented = wellFormedToken(header);
  if (presented === null) return { state: "invalid" };

  // Everything above is free. Past this line the caller makes the service do a
  // query, which any well-formed bearer reaches on routes that need no token at
  // all, so the guess window counts it.
  const hash = sha256(presented);
  const hex = toHex(hash);
  const may = mayLookUpToken(addr, hex);
  if (!may.allowed) {
    // A shared refusal: the window is per address and an address is not an
    // identity, so it carries a wait and no numbers.
    throw new ApiError("RATE_LIMITED", { retryAfter: may.retryAfter, shared: true });
  }

  // The read pool, not the write pool: this is a SELECT, and a flood of bearers
  // that match nothing must not queue in front of the writes, which have eight
  // connections between them.
  const rows = await db.read<
    {
      peer_id: Buffer;
      expires_at: Date;
      revoked_at: Date | null;
      label: string | null;
      blocked_at: Date | null;
      audience: string | null;
      scope: string | null;
      client_id: string | null;
      registered_at: Date;
    }[]
  >`
    select t.peer_id, t.expires_at, t.revoked_at, t.label, p.blocked_at, t.audience, t.scope, t.client_id, p.registered_at
      from schellingaf.tokens t
      join schellingaf.peers p on p.peer_id = t.peer_id
     where t.token_hash = ${hash}`;

  const row = rows[0];
  noteTokenLookup(addr, hex, row !== undefined);
  if (!row) return { state: "invalid" };
  // Before its state: a token presented at an address it was not issued for says
  // nothing about whether it expired or was revoked there.
  if (row.audience !== audience) return { state: "invalid" };
  if (row.blocked_at) return { state: "blocked", peerId: row.peer_id };
  if (row.revoked_at) return { state: "revoked", peerId: row.peer_id };
  if (row.expires_at.getTime() <= Date.now()) return { state: "expired", peerId: row.peer_id };

  return {
    state: "valid",
    peerId: row.peer_id,
    hash,
    expiresAt: row.expires_at,
    label: row.label,
    scope: row.scope,
    clientId: row.client_id,
    registeredAt: row.registered_at,
  };
}

/**
 * An upload authorization, looked up as a token is: inside the same guess window, on the
 * read pool, by its hash. Unknown is invalid and counted as a guess; used, expired or with
 * its token ended, upload_expired; its KEY blocked, blocked.
 */
async function classifyGrant(db: Db, presented: string, addr: string): Promise<BearerState> {
  const hash = sha256(presented);
  const hex = toHex(hash);
  const may = mayLookUpToken(addr, hex);
  if (!may.allowed) throw new ApiError("RATE_LIMITED", { retryAfter: may.retryAfter, shared: true });
  const rows = await db.read<
    { state: string; peer_id: Buffer; blocked_at: Date | null; registered_at: Date; space_id: string; sha256: Buffer; space_name: string }[]
  >`
    select g.state, g.peer_id, g.blocked_at, g.registered_at, g.space_id::text as space_id, g.sha256, g.space_name
      from schellingaf.upload_grant(${hash}) g`;
  const row = rows[0];
  noteTokenLookup(addr, hex, row !== undefined);
  if (!row) return { state: "invalid" };
  if (row.blocked_at) return { state: "blocked", peerId: row.peer_id };
  if (row.state !== "valid") return { state: "upload_expired" };
  return { state: "upload", peerId: row.peer_id, grant: hash, registeredAt: row.registered_at, spaceId: row.space_id, spaceName: row.space_name, sha256: row.sha256 };
}

/** Whether a KEY registered in the last day, which gets the smaller first-day allowances. */
export function firstDay(bearer: { registeredAt: Date }): boolean {
  return Date.now() - bearer.registeredAt.getTime() < 86_400_000;
}

/** How often a token's last use is written. */
const TOUCH_EVERY_MS = 60_000;
/** The most tokens this process remembers touching before it forgets the stale ones. */
const TOUCHED_MAX = 10_000;
/** When this process last wrote each token's last use, by its hash in hex. */
const touched = new Map<string, number>();

/**
 * Written at most once a minute: a timestamp on every request would turn every
 * read into a write on the hottest small table in the database. The UPDATE says
 * so itself; a token this process wrote within the minute is not sent it at
 * all, since it would change nothing, and a connector request awaits it before
 * every call. The time is taken before the UPDATE is sent, so the window never
 * outlasts the database's own.
 */
export async function touchToken(db: Db, hash: Buffer): Promise<void> {
  const key = hash.toString("hex");
  const now = Date.now();
  const last = touched.get(key);
  if (last !== undefined && now - last < TOUCH_EVERY_MS) return;
  const changed = await db.write`
    update schellingaf.tokens
       set last_used_at = now()
     where token_hash = ${hash}
       and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
  if (changed.count === 0) return;
  if (touched.size >= TOUCHED_MAX) {
    for (const [stale, at] of touched) {
      if (now - at >= TOUCH_EVERY_MS) touched.delete(stale);
    }
    if (touched.size >= TOUCHED_MAX) touched.clear();
  }
  touched.set(key, now);
}

export async function insertToken(
  sql: postgres.Sql,
  args: { hash: Buffer; peerId: Buffer; nonce: Buffer; ttlSeconds: number; label: string | null },
): Promise<Date> {
  const rows = await sql<{ expires_at: Date }[]>`
    insert into schellingaf.tokens (token_hash, peer_id, challenge_nonce, label, expires_at)
    values (${args.hash}, ${args.peerId}, ${args.nonce}, ${args.label},
            now() + make_interval(secs => ${args.ttlSeconds}))
    returning expires_at`;
  return rows[0]!.expires_at;
}
