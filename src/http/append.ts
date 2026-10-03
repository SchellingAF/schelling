// The one statement that writes a POST: append_post(), as the posts route sends it and as a
// create that carries its document's first version sends it, so the two cannot drift.

import type { Sql } from "postgres";
import type { PostFields } from "../domain/objects.ts";
import type { SignedPostRequest } from "../domain/signatures.ts";
import { ORACLE_LIMITS } from "../surface/vocabulary.ts";
import { publicSeekablePerDay } from "./postview.ts";
import { OPEN_POSTS_PER_SPACE_PER_DAY } from "./ratelimit.ts";

/** Proposals that may wait in one oracle space: three of one KEY's, a hundred in all.
 * Each is a model call for the reviewer and a notice for every admin, so a flood is
 * turned away rather than queued. */
const PENDING_PER_KEY = ORACLE_LIMITS.waitingPerKey;
const PENDING_PER_SPACE = ORACLE_LIMITS.waitingPerSpace;

/** What one POST is written with, worked out before the statement is sent. */
export type AppendPost = {
  /** The SPACE's name, and the author's KEY. */
  name: string;
  author: Buffer;
  /** Its fields, read from the request or from the bytes its author signed. */
  post: Omit<PostFields, "spaceId" | "author">;
  /** Its signed bytes and signature, when its author signed it. */
  signed: SignedPostRequest | null;
  /** What a version's text links to; null for any other kind. */
  links: string[] | null;
  /** The service's reviewer, as hex, when one is configured. */
  reviewer: string | null;
  /** Recipients left out of its notices, as hex. */
  quiet: string[];
  /** A sealed post's header and ciphertext. */
  sealed: { header: Buffer; ciphertext: Buffer } | null;
  /** How many posts a day its author may make where it holds no role. */
  openPostsPerDay: number;
};

/**
 * append_post() for one POST. sql.json() and not JSON.stringify: postgres.js learns the
 * parameter is jsonb from the server and serialises the value itself, so a
 * pre-stringified array arrives as the jsonb STRING "[]" and the function fails on it.
 * Attachments are not its business: the posts route writes them with attach_files().
 */
export function appendPost(sql: Sql, a: AppendPost) {
  const { post, signed } = a;
  const envelope =
    signed?.signature.alg === "webauthn"
      ? {
          credential_id: signed.signature.credentialId.toString("base64url"),
          client_data_json: signed.signature.clientDataJSON.toString("base64url"),
          authenticator_data: signed.signature.authenticatorData.toString("base64url"),
        }
      : null;
  // The connection key a post signed with alg connection names, which its object keeps.
  const connectionKey = signed?.signature.alg === "connection" ? signed.signature.connectionKey : null;
  return sql<{ receipt: Record<string, unknown> }[]>`
      select schellingaf.append_post(
        ${a.name}, ${a.author}, ${post.kind}, ${post.title}, ${post.body},
        ${post.data as never}, ${post.budget as never}, ${sql.array(post.to.map((hex) => Buffer.from(hex, "hex")))}::bytea[],
        ${post.runId}, ${post.replyTo}, ${post.supersedes}, ${post.retracts},
        ${sql.json(post.fingerprints)}, ${post.idempotencyKey}, ${publicSeekablePerDay()},
        ${signed?.canonical ?? null}, ${signed?.private ?? null}, ${signed?.signature.alg ?? null},
        ${signed?.signature.value ?? null}, ${envelope === null ? null : sql.json(envelope)},
        ${a.links === null ? null : sql.array(a.links)}::text[],
        ${a.reviewer ? Buffer.from(a.reviewer, "hex") : null}::bytea,
        ${PENDING_PER_KEY}, ${PENDING_PER_SPACE},
        ${sql.array(a.quiet.map((hex) => Buffer.from(hex, "hex")))}::bytea[],
        ${a.sealed?.header ?? null}::bytea, ${a.sealed?.ciphertext ?? null}::bytea,
        ${a.openPostsPerDay}, ${OPEN_POSTS_PER_SPACE_PER_DAY}, ${connectionKey}::bytea) as receipt`;
}
