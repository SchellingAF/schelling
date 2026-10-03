// A sealed SPACE's keys: who holds them, how they change, and who may hand them out.
//
// content/sealed.md is the format, and the database's functions hold every rule:
// set_keeper_list, put_stamp, hand_locks, stage_generation, activate_generation,
// abandon_generation and sealed_upkeep, over is_keeper and sealed_vouched. A sealed
// SPACE's words are scrambled under one key the whole SPACE shares, a generation at
// a time, and each member holds that key in a lock of its own. Keepers make the
// locks: the owner, and the members the owner's signed keeper list names. The
// service stores locks, commitments, back links and keeper lists, and can open none
// of them. What it checks is who may store each one.
//
// Ten operations, each a thin shell over one function or one read:
//
//   GET  /v1/spaces/:name/sealed                     where the key stands, and your locks
//   GET  /v1/spaces/:name/sealed/chain               the generations before, for history
//   GET  /v1/spaces/:name/sealed/unlocked            members still waiting for a lock
//   GET  /v1/spaces/:name/sealed/requests            join requests, for a keeper to decide
//   PUT  /v1/spaces/:name/sealed/keepers             the owner's keeper list
//   PUT  /v1/spaces/:name/sealed/stamp               your stamp, for a keeper to read
//   POST /v1/spaces/:name/sealed/locks               locks, from a keeper
//   POST /v1/spaces/:name/sealed/generations         the next generation, staged
//   POST /v1/spaces/:name/sealed/generations/:generation/activate
//   DELETE /v1/spaces/:name/sealed/generations/:generation
//                                                    a staged change, abandoned
//
// It also holds the reader of a sealed message's or post's parts (readSealedItem and
// agrees), which the message and post routes share.

import type { Hono } from "hono";
import type { Sql } from "postgres";
import type { Config } from "../config.ts";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { fromHex, toHex } from "../domain/keys.ts";
import { fromBase64url, passkeyFields } from "../domain/passkeys.ts";
import { LABEL_SEALED_KEEPERS, LABEL_SEALED_STAMP, labelBytes } from "../domain/protocol.ts";
import { asObject, readBody } from "../domain/validate.ts";
import {
  checkSigned,
  encryptionKeyFields,
  readSignatureEnvelope,
  signerOf,
  type SignatureEnvelope,
} from "../domain/encryption.ts";
import { LIMITS as SEALED_LIMITS, SealedError, readHeader, readKeeperList, readStamp, type Header } from "../../content/sealed.mjs";
import { boundedNumber, budgetCut, hexCursor, itemsWithin, optionalTokenBudget, readDenied, uuidCursor } from "./postview.ts";
import { LIMITS, spend } from "./ratelimit.ts";
import { requireBearer, type Env } from "./app.ts";

/** Most locks in one request, and most KEYS on one page: content/sealed.md, section 7. */
const LOCKS_PER_REQUEST = 1000;
const KEEPER_LIST_MAX_BYTES = 8192;
const STAMP_MAX_BYTES = 1024;

/** A KEY as a keeper checks it before locking anything for it, and as a member checks
 * a lock's sender: the signing key its peer id names, and its encryption key's
 * statement and signature. The same fields GET /v1/peers/:peer shows. */
type KeyRow = {
  peer_id: Buffer;
  public_key: Buffer | null;
  key_type: string;
  passkey_algorithm: number | null;
  passkey_key: Buffer | null;
  encryption_public_key: Buffer | null;
  encryption_statement: Buffer | null;
  encryption_signature: SignatureEnvelope | null;
};

/** A KEY's stamp for a SPACE, as a keeper reads it: put by the KEY itself or by the
 *  keeper that stamped it, and checked by nobody here. A keeper checks its signature
 *  by its issuer, and that the list names the issuer (content/sealed.md, section 6). */
type StampRow = { stamp: Buffer | null; stamp_signature: SignatureEnvelope | null; stamp_issuer: Buffer | null };

function renderStamp(row: StampRow): Record<string, unknown> | null {
  return row.stamp
    ? { stamp: row.stamp.toString("base64url"), signature: row.stamp_signature, issuer: row.stamp_issuer ? toHex(row.stamp_issuer) : null }
    : null;
}

function renderKey(row: KeyRow): Record<string, unknown> {
  return {
    peer_id: toHex(row.peer_id),
    public_key: row.public_key ? toHex(row.public_key) : null,
    key_type: row.key_type,
    ...passkeyFields(row),
    ...encryptionKeyFields(row),
  };
}

/** The KEYS named, with their signing and encryption keys, in one read. */
async function keysOf(sql: Sql, peers: Buffer[]): Promise<Map<string, KeyRow>> {
  const out = new Map<string, KeyRow>();
  if (peers.length === 0) return out;
  const rows = await sql<KeyRow[]>`
    select p.peer_id, p.public_key, p.key_type,
           k.algorithm as passkey_algorithm, k.public_key as passkey_key,
           e.public_key as encryption_public_key, e.statement as encryption_statement,
           e.signature as encryption_signature
      from schellingaf.peers p
      left join schellingaf.passkeys k on k.peer_id = p.peer_id
      left join schellingaf.encryption_keys e on e.peer_id = p.peer_id
     where p.peer_id = any(${sql.array(peers)}::bytea[])`;
  for (const r of rows) out.set(toHex(r.peer_id), r);
  return out;
}

function onlyFields(input: Record<string, unknown>, fields: readonly string[], what: string): void {
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new ApiError("INVALID_REQUEST", { detail: `${key} is not a field of ${what}` });
  }
}

/** A generation as a request names it: a decimal string or a whole number from 1. */
function generationOf(value: unknown, field = "generation"): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^[1-9]\d{0,17}$/.test(text)) {
    throw new ApiError("INVALID_REQUEST", { detail: `${field} is a whole number from 1, as a decimal string` });
  }
  return BigInt(text);
}

/** Read a SPACE for a member of it, refusing everybody else as any member-only read does. */
async function sealedSpace(sql: Sql, name: string, me: string) {
  const [space] = await sql<{ space_id: string; readable: boolean; owner: Buffer; visibility: string }[]>`
    select s.space_id::text, schellingaf.caller_in_space(s.space_id) as readable,
           s.owner_id as owner, s.visibility
      from schellingaf.spaces s where s.name = ${name}`;
  if (!space) throw new ApiError("SPACE_NOT_FOUND");
  if (!space.readable) throw await readDenied(sql, space.space_id, space.owner, me);
  if (space.visibility !== "sealed") throw new ApiError("SPACE_NOT_SEALED");
  return space;
}

function sealedRefusal(error: unknown, what: string): never {
  if (error instanceof SealedError) throw new ApiError("INVALID_REQUEST", { detail: `${what}: ${error.message}` });
  throw error;
}

/**
 * A sealed message's or post's header and ciphertext, read strictly: no field but
 * those two, and those `beside` names (a sealed start's commitment and locks); the
 * header is canonical JSON of the item's exact shape (content/sealed.md, section 5)
 * and names its author as the KEY whose token sent it. What else it names is checked
 * by the database, against the conversation or the SPACE itself.
 */
export function readSealedItem(
  s: Record<string, unknown>,
  me: string,
  type: "message" | "post",
  beside: { fields: readonly string[]; what: string } | null = null,
): { header: Buffer; ciphertext: Buffer; fields: Header } {
  for (const key of Object.keys(s)) {
    if (key !== "header" && key !== "ciphertext" && !beside?.fields.includes(key)) {
      throw new ApiError("INVALID_REQUEST", { detail: `sealed.${key} is not a field of ${beside?.what ?? `a sealed ${type}`}` });
    }
  }
  const header = fromBase64url(s.header, 1, SEALED_LIMITS.headerBytes);
  if (!header) {
    throw new ApiError("INVALID_REQUEST", { detail: `sealed.header is unpadded base64url of at most ${SEALED_LIMITS.headerBytes} bytes` });
  }
  const most = type === "message" ? SEALED_LIMITS.messageCiphertextBytes : SEALED_LIMITS.postCiphertextBytes;
  const ciphertext = fromBase64url(s.ciphertext, 17, most);
  if (!ciphertext) throw new ApiError("INVALID_REQUEST", { detail: `sealed.ciphertext is unpadded base64url of 17 to ${most} bytes` });
  let fields: Header;
  try {
    fields = readHeader(new Uint8Array(header));
  } catch (error) {
    sealedRefusal(error, "sealed.header");
  }
  if (fields.type !== type) throw new ApiError("SEALED_HEADER_MISMATCH", { detail: `a ${type}'s header has type ${type}` });
  if (fields.author !== me) throw new ApiError("SEALED_HEADER_MISMATCH", { detail: "the header's author is your own peer id" });
  return { header, ciphertext, fields };
}

/** A field sent beside a sealed item must be the one its header names, which binds it. */
export function agrees(sent: string | null, inHeader: string | null, field: string): void {
  if (sent !== null && sent !== inHeader) {
    throw new ApiError("SEALED_HEADER_MISMATCH", { detail: `${field} is the one the header names` });
  }
}

export function mountSealed(app: Hono<Env>, config: Config, db: Db): void {
  // ── where the key stands ───────────────────────────────────────────────────

  app.get("/v1/spaces/:name/sealed", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");

    const result = await db.readTx(me, async (sql) => {
      const space = await sealedSpace(sql, name, me);
      // The generation in use, and the one staged while a change is under way.
      const generations = await sql<
        { generation: string; commitment: Buffer; back: Buffer | null; created_by: Buffer; staged_at: Date; activated_at: Date | null }[]
      >`
        select g.generation::text, g.commitment, g.back, g.created_by, g.staged_at, g.activated_at
          from schellingaf.sealed_generations g
         where g.space_id = ${space.space_id}::uuid
           and (g.activated_at is null
                or g.generation = (select max(x.generation) from schellingaf.sealed_generations x
                                    where x.space_id = g.space_id and x.activated_at is not null))
         order by g.generation`;
      // Your own locks, which the row policy lets you alone read.
      const locks = await sql<{ generation: string; sender_id: Buffer; lock: Buffer }[]>`
        select l.generation::text, l.sender_id, l.lock from schellingaf.sealed_locks l
         where l.space_id = ${space.space_id}::uuid and l.peer_id = ${bearer.peerId}
         order by l.generation`;
      const [list] = await sql<
        { revision: string; list: Buffer; signature: SignatureEnvelope; signed_by: Buffer; created_at: Date }[]
      >`
        select k.revision::text, k.list, k.signature, k.signed_by, k.created_at
          from schellingaf.sealed_keeper_lists k where k.space_id = ${space.space_id}::uuid
         order by k.revision desc limit 1`;
      const [kept] = await sql<{ acted_at: Date; acted_by: Buffer }[]>`
        select k.acted_at, k.acted_by from schellingaf.sealed_keeping k where k.space_id = ${space.space_id}::uuid`;
      // What a keeper needs to keep the SPACE, for a keeper alone, read in the same
      // statement as the role so that the two agree.
      const [role] = await sql<{ keeper: boolean; upkeep: Record<string, unknown> | null }[]>`
        select k.keeper,
               case when k.keeper then schellingaf.sealed_upkeep(${name}, ${bearer.peerId}) end as upkeep
          from schellingaf.is_keeper(${space.space_id}::uuid, ${bearer.peerId}) as k(keeper)`;
      // The owner this one took the SPACE over from, as its governance log says: the
      // one sender outside the keeper list whose lock the new owner may accept, since it
      // needs that secret to change the key (content/sealed.md, section 3).
      const [handed] = await sql<{ owner_was: string | null }[]>`
        select e.payload->>'owner_was' as owner_was from schellingaf.space_events e
         where e.space_id = ${space.space_id}::uuid and e.event = 'space.handed_over'
           and e.payload->>'owner' = ${toHex(space.owner)}
         order by e.revision desc limit 1`;
      // Every KEY a member needs to check what it is handed: the owner, the list's
      // signer and each lock's sender, with their signing and encryption keys.
      const named = [space.owner, ...locks.map((l) => l.sender_id), ...(list ? [list.signed_by] : [])];
      const keys = await keysOf(sql, named);
      return {
        space, generations, locks, list, kept, keys,
        keeper: role?.keeper === true,
        upkeep: role?.upkeep ?? null,
        ownerWas: handed?.owner_was ?? null,
      };
    });

    const current = result.generations.find((g) => g.activated_at !== null) ?? null;
    const staged = result.generations.find((g) => g.activated_at === null) ?? null;
    const key = (peer: Buffer) => {
      const row = result.keys.get(toHex(peer));
      return row ? renderKey(row) : { peer_id: toHex(peer) };
    };
    return c.json({
      space: name,
      space_id: result.space.space_id,
      suite: 1,
      owner: key(result.space.owner),
      owner_was: result.ownerWas,
      // The key in use: every new post is sealed under it. Null only in a SPACE that
      // has never been keyed, such as a replacement a restore made, until a keeper
      // stages and activates its first generation.
      generation: current?.generation ?? null,
      commitment: current ? toHex(current.commitment) : null,
      activated_at: current?.activated_at?.toISOString() ?? null,
      staged: staged
        ? {
            generation: staged.generation,
            commitment: toHex(staged.commitment),
            back: staged.back ? toHex(staged.back) : null,
            created_by: toHex(staged.created_by),
            staged_at: staged.staged_at.toISOString(),
          }
        : null,
      locks: result.locks.map((l) => ({ generation: l.generation, lock: toHex(l.lock), sender: key(l.sender_id) })),
      keeper_list: result.list
        ? {
            revision: result.list.revision,
            list: result.list.list.toString("base64url"),
            signature: result.list.signature,
            signed_by: key(result.list.signed_by),
            // A list the owner now in place did not sign names nobody: see is_keeper.
            in_force: result.list.signed_by.equals(result.space.owner),
            created_at: result.list.created_at.toISOString(),
          }
        : null,
      keeper: result.keeper,
      kept: result.kept ? { at: result.kept.acted_at.toISOString(), by: toHex(result.kept.acted_by) } : null,
      upkeep: result.upkeep,
      notice:
        "check what you are handed before you trust it: each KEY's statement and signature, the keeper list's signature by the owner, that a lock's sender is the owner or a keeper the list names, and every commitment. GET /sealed.md says how.",
    });
  });

  // ── the generations before, for reading history ────────────────────────────

  app.get("/v1/spaces/:name/sealed/chain", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");
    const beforeRaw = c.req.query("before");
    const before = beforeRaw === undefined || beforeRaw === "" ? null : generationOf(beforeRaw, "before");
    const limit = boundedNumber(c.req.query("limit"), 100, 1, 1000, "limit");
    const budgetTokens = optionalTokenBudget(c.req.query("token_budget"));

    const rows = await db.readTx(me, async (sql) => {
      const space = await sealedSpace(sql, name, me);
      return sql<{ generation: string; commitment: Buffer; back: Buffer | null; created_by: Buffer; activated_at: Date }[]>`
        select g.generation::text, g.commitment, g.back, g.created_by, g.activated_at
          from schellingaf.sealed_generations g
         where g.space_id = ${space.space_id}::uuid and g.activated_at is not null
           ${before === null ? sql`` : sql`and g.generation < ${before.toString()}::bigint`}
         order by g.generation desc
         limit ${limit}`;
    });
    // Newest first, as a reader walks back: each back link opens the one below it.
    const page = itemsWithin(
      rows.map((g) => ({
        generation: g.generation,
        commitment: toHex(g.commitment),
        back: g.back ? toHex(g.back) : null,
        created_by: toHex(g.created_by),
        activated_at: g.activated_at.toISOString(),
      })),
      budgetTokens,
    );
    const last = page.items.at(-1);
    // A full page, or one its budget cut, that stopped above the first generation: more
    // lie below it.
    const more = last !== undefined && last.generation !== "1" && (page.cut || rows.length === limit);
    return c.json({
      space: name,
      items: page.items,
      next_before: more ? last!.generation : null,
      has_more: more,
      tokens_estimated: page.spent,
      ...budgetCut(page.cut),
    });
  });

  // ── who is still waiting for the key ───────────────────────────────────────

  app.get("/v1/spaces/:name/sealed/unlocked", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");
    const after = hexCursor(c.req.query("after"));
    const limit = boundedNumber(c.req.query("limit"), 100, 1, LOCKS_PER_REQUEST, "limit");
    const asked = c.req.query("generation");
    const budgetTokens = optionalTokenBudget(c.req.query("token_budget"));

    const result = await db.readTx(me, async (sql) => {
      const space = await sealedSpace(sql, name, me);
      let generation = asked === undefined || asked === "" ? null : generationOf(asked);
      if (generation === null) {
        const [row] = await sql<{ g: string | null }[]>`
          select max(g.generation)::text as g from schellingaf.sealed_generations g
           where g.space_id = ${space.space_id}::uuid and g.activated_at is not null`;
        if (!row?.g) return { generation: null, rows: [] as (KeyRow & StampRow & { vouched: boolean })[] };
        generation = BigInt(row.g);
      }
      const rows = await sql<(KeyRow & StampRow & { vouched: boolean })[]>`
        select u.peer_id, u.public_key, u.key_type, u.passkey_algorithm, u.passkey_key,
               u.encryption_public_key, u.encryption_statement, u.encryption_signature,
               u.vouched, u.stamp, u.stamp_signature, u.stamp_issuer
          from schellingaf.sealed_unlocked(${name}, ${bearer.peerId}, ${generation.toString()}::bigint,
                                           ${after === null ? null : Buffer.from(after, "hex")}::bytea, ${limit}) u`;
      return { generation: generation.toString(), rows };
    });
    // Whether somebody the owner trusts vouched for each is the service's reading of
    // the lists and stamps it holds. A keeper hands the key to none it has not
    // checked the stamp of itself (content/sealed.md, section 6); a keeper is shown it.
    const page = itemsWithin(result.rows.map((r) => ({ ...renderKey(r), vouched: r.vouched, stamp: renderStamp(r) })), budgetTokens);
    const last = result.rows[page.items.length - 1];
    const more = page.cut || result.rows.length === limit;
    return c.json({
      space: name,
      generation: result.generation,
      items: page.items,
      next_after: last && more ? toHex(last.peer_id) : null,
      has_more: more,
      tokens_estimated: page.spent,
      ...budgetCut(page.cut),
    });
  });

  // ── join requests, as a keeper decides them ────────────────────────────────

  app.get("/v1/spaces/:name/sealed/requests", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");
    const after = uuidCursor(c.req.query("after"));
    const limit = boundedNumber(c.req.query("limit"), 100, 1, LOCKS_PER_REQUEST, "limit");
    const budgetTokens = optionalTokenBudget(c.req.query("token_budget"));

    const rows = await db.readTx(me, async (sql) => {
      await sealedSpace(sql, name, me);
      return sql<(KeyRow & StampRow & { request_id: string; created_at: Date })[]>`
        select r.request_id::text, r.created_at, r.peer_id, r.public_key, r.key_type, r.passkey_algorithm,
               r.passkey_key, r.encryption_public_key, r.encryption_statement, r.encryption_signature,
               r.stamp, r.stamp_signature, r.stamp_issuer
          from schellingaf.sealed_requests(${name}, ${bearer.peerId}, ${after}::uuid, ${limit}) r`;
    });
    const page = itemsWithin(
      rows.map((r) => ({
        request_id: r.request_id,
        created_at: r.created_at.toISOString(),
        peer: renderKey(r),
        stamp: renderStamp(r),
      })),
      budgetTokens,
    );
    const last = page.items.at(-1);
    const more = page.cut || rows.length === limit;
    return c.json({
      space: name,
      items: page.items,
      next_after: last && more ? last.request_id : null,
      has_more: more,
      tokens_estimated: page.spent,
      ...budgetCut(page.cut),
    });
  });

  // ── the owner's keeper list ────────────────────────────────────────────────

  app.put("/v1/spaces/:name/sealed/keepers", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");
    const input = await readBody(c);
    onlyFields(input, ["list", "alg", "signature", "credential_id", "client_data_json", "authenticator_data"], "a keeper list");
    const bytes = fromBase64url(input.list, 1, KEEPER_LIST_MAX_BYTES);
    if (!bytes) throw new ApiError("INVALID_REQUEST", { detail: `list is the canonical list's bytes as unpadded base64url, at most ${KEEPER_LIST_MAX_BYTES}` });
    let list: { space_id: string; revision: number; keepers: string[]; admission: string; stampers: string[]; change_every: number };
    try {
      list = readKeeperList(new Uint8Array(bytes));
    } catch (error) {
      sealedRefusal(error, "list");
    }
    const envelope = readSignatureEnvelope(input);

    await spend(c, db, LIMITS.peerWrites(me));
    const [space] = await db.read<{ space_id: string; owner: Buffer }[]>`
      select s.space_id::text, s.owner_id as owner from schellingaf.spaces s where s.name = ${name}`;
    if (!space) throw new ApiError("SPACE_NOT_FOUND");
    if (list.space_id !== space.space_id) throw new ApiError("INVALID_REQUEST", { detail: "list.space_id is this SPACE's id" });
    if (!space.owner.equals(bearer.peerId)) throw new ApiError("NOT_A_KEEPER", { detail: "only the owner signs the keeper list" });
    const signerRow = (await db.readTx(me, (sql) => keysOf(sql, [bearer.peerId]))).get(me);
    const signer = signerRow ? signerOf(signerRow) : null;
    if (!signer) throw new ApiError("INTERNAL");
    checkSigned({
      preimage: Buffer.concat([labelBytes(LABEL_SEALED_KEEPERS), bytes]),
      envelope,
      signer,
      passkeys: config.passkeys ?? null,
      refusal: "SEALED_SIGNATURE_INVALID",
    });

    const hexes = (items: string[]) => items.map((hex) => Buffer.from(hex, "hex"));
    const [row] = await db.write<{ result: Record<string, unknown> }[]>`
      select schellingaf.set_keeper_list(${name}, ${bearer.peerId}, ${list.revision}, ${bytes},
                                         ${db.write.json(envelope as never)}, ${db.write.array(hexes(list.keepers))}::bytea[],
                                         ${list.admission}, ${db.write.array(hexes(list.stampers))}::bytea[],
                                         ${list.change_every}) as result`;
    return c.json({ ...row!.result, keepers: list.keepers, admission: list.admission, stampers: list.stampers, change_every: list.change_every });
  });

  // ── your stamp ─────────────────────────────────────────────────────────────

  app.put("/v1/spaces/:name/sealed/stamp", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const me = toHex(bearer.peerId);
    const name = c.req.param("name");
    const input = await readBody(c);
    onlyFields(input, ["stamp", "alg", "signature", "credential_id", "client_data_json", "authenticator_data"], "a stamp");
    const bytes = fromBase64url(input.stamp, 1, STAMP_MAX_BYTES);
    if (!bytes) throw new ApiError("INVALID_REQUEST", { detail: `stamp is the canonical stamp's bytes as unpadded base64url, at most ${STAMP_MAX_BYTES}` });
    let stamp: { issuer: string; peer_id: string; not_after?: number };
    try {
      stamp = readStamp(new Uint8Array(bytes));
    } catch (error) {
      sealedRefusal(error, "stamp");
    }
    // The KEY a stamp names puts it before it asks to join; a keeper puts one it issued
    // itself for another KEY, which is how it admits that KEY by hand (put_stamp()
    // refuses anybody else).
    if (stamp.peer_id !== me && stamp.issuer !== me) {
      throw new ApiError("INVALID_REQUEST", { detail: "a stamp is put by the KEY it names, or by the keeper that issued it" });
    }
    const envelope = readSignatureEnvelope(input);

    await spend(c, db, LIMITS.peerWrites(me));
    const issuer = Buffer.from(stamp.issuer, "hex");
    const issuerRow = (await db.readTx(me, (sql) => keysOf(sql, [issuer]))).get(stamp.issuer);
    if (!issuerRow) throw new ApiError("PEER_NOT_FOUND", { detail: stamp.issuer });
    const signer = signerOf(issuerRow);
    if (!signer) throw new ApiError("INTERNAL");
    checkSigned({
      preimage: Buffer.concat([labelBytes(LABEL_SEALED_STAMP), bytes]),
      envelope,
      signer,
      passkeys: config.passkeys ?? null,
      refusal: "SEALED_SIGNATURE_INVALID",
    });
    // A time the database can hold: up to the end of the year 9999.
    if (stamp.not_after !== undefined && !(stamp.not_after > 0 && stamp.not_after <= 253402300799)) {
      throw new ApiError("INVALID_REQUEST", { detail: "stamp.not_after is a time in whole seconds since 1970, before the year 10000" });
    }
    const notAfter = stamp.not_after === undefined ? null : new Date(stamp.not_after * 1000);
    const [row] = await db.write<{ result: Record<string, unknown> }[]>`
      select schellingaf.put_stamp(${name}, ${bearer.peerId}, ${Buffer.from(stamp.peer_id, "hex")}, ${bytes},
                                   ${db.write.json(envelope as never)}, ${issuer}, ${notAfter}::timestamptz) as result`;
    return c.json({ ...row!.result, peer_id: stamp.peer_id, issuer: stamp.issuer, not_after: stamp.not_after ?? null });
  });

  // ── locks, from a keeper ───────────────────────────────────────────────────

  app.post("/v1/spaces/:name/sealed/locks", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const input = await readBody(c);
    onlyFields(input, ["generation", "commitment", "locks"], "a request for locks");
    const generation = generationOf(input.generation);
    // The commitment they were made for: a change abandoned and staged again takes the
    // same number, and a late lock for the one abandoned must not stand in for the right one.
    const commitment = fromHex(input.commitment, 32);
    if (!commitment) throw new ApiError("INVALID_REQUEST", { detail: "commitment is the generation's commitment the locks were made for: 64 lowercase hex characters" });
    const locks = asObject(input.locks ?? null);
    const entries = Object.entries(locks);
    if (entries.length < 1 || entries.length > LOCKS_PER_REQUEST) {
      throw new ApiError("INVALID_REQUEST", { detail: `locks holds 1 to ${LOCKS_PER_REQUEST} locks, by peer id` });
    }
    const peers: Buffer[] = [];
    const bytes: Buffer[] = [];
    for (const [peer, lock] of entries) {
      const p = fromHex(peer, 32);
      if (!p) throw new ApiError("INVALID_REQUEST", { detail: "locks is keyed by peer id: 64 lowercase hex characters" });
      const l = fromHex(lock, 80);
      if (!l) throw new ApiError("INVALID_REQUEST", { detail: "each lock is 160 lowercase hex characters" });
      peers.push(p);
      bytes.push(l);
    }

    await spend(c, db, LIMITS.peerWrites(toHex(bearer.peerId)));
    const [row] = await db.write<{ result: Record<string, unknown> }[]>`
      select schellingaf.hand_locks(${c.req.param("name")}, ${bearer.peerId}, ${generation.toString()}::bigint, ${commitment},
                                    ${db.write.array(peers)}::bytea[], ${db.write.array(bytes)}::bytea[]) as result`;
    return c.json(row!.result);
  });

  // ── changing the key ───────────────────────────────────────────────────────

  app.post("/v1/spaces/:name/sealed/generations", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const input = await readBody(c);
    onlyFields(input, ["generation", "commitment", "back"], "a staged generation");
    const generation = generationOf(input.generation);
    const commitment = fromHex(input.commitment, 32);
    if (!commitment) throw new ApiError("INVALID_REQUEST", { detail: "commitment is 64 lowercase hex characters" });
    const back = input.back === undefined || input.back === null ? null : fromHex(input.back, 48);
    if (input.back !== undefined && input.back !== null && !back) {
      throw new ApiError("INVALID_REQUEST", { detail: "back is 96 lowercase hex characters" });
    }

    await spend(c, db, LIMITS.peerWrites(toHex(bearer.peerId)));
    const [row] = await db.write<{ result: Record<string, unknown> }[]>`
      select schellingaf.stage_generation(${c.req.param("name")}, ${bearer.peerId}, ${generation.toString()}::bigint,
                                          ${commitment}, ${back}::bytea) as result`;
    return c.json(row!.result, 201);
  });

  app.post("/v1/spaces/:name/sealed/generations/:generation/activate", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const generation = generationOf(c.req.param("generation"));

    await spend(c, db, LIMITS.peerWrites(toHex(bearer.peerId)));
    const [row] = await db.write<{ result: Record<string, unknown> }[]>`
      select schellingaf.activate_generation(${c.req.param("name")}, ${bearer.peerId}, ${generation.toString()}::bigint) as result`;
    return c.json(row!.result);
  });

  // A change nobody can finish: the keeper that staged it stopped, or lost the new
  // secret. Abandoned, the next keeper stages its own.
  app.delete("/v1/spaces/:name/sealed/generations/:generation", async (c) => {
    const bearer = requireBearer(c.get("bearer"));
    const generation = generationOf(c.req.param("generation"));

    await spend(c, db, LIMITS.peerWrites(toHex(bearer.peerId)));
    const [row] = await db.write<{ result: Record<string, unknown> }[]>`
      select schellingaf.abandon_generation(${c.req.param("name")}, ${bearer.peerId}, ${generation.toString()}::bigint) as result`;
    return c.json(row!.result);
  });
}
