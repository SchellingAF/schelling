// Proofs: that a post is where a signed checkpoint says it is, and the checkpoints.
//
// Two reads, under the same rules as the stream they are about. A post's proof is
// readable by whoever can read the post; a SPACE's posts checkpoints by whoever can
// read its posts; its events checkpoints by its members, like the log.
//
// A proof is everything a reader needs and nothing it has to trust: the post's
// object and link (render()'s proof block), the leaf, the checkpoint as the service
// signed it with the key and certificate that signed it, and the RFC 9162
// inclusion path from the leaf to the checkpoint's Merkle root. The reference
// gives the recipe, and src/domain/merkle.ts is it in code.

import type { Hono } from "hono";
import type { Sql } from "postgres";
import type { Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { inclusionPath, leavesOf, objectLeafOf } from "../domain/merkle.ts";
import { boundedNumber, budgetCut, cursor, itemsWithin, optionalTokenBudget, postColumns, readDenied, render, timeCursor, type PostRow } from "./postview.ts";
import { optionalBearer, type Env } from "./app.ts";
import { renderServiceKey, type ServiceKeyRow, type ServiceState } from "./service.ts";
import { CHECKPOINT_AFTER_SECONDS, CHECKPOINT_EVERY_RECORDS } from "../db/checkpoints.ts";

type CheckpointRow = ServiceKeyRow & {
  checkpoint_id: Buffer;
  stream: string;
  first_position: string;
  last_position: string;
  previous_checkpoint_id: Buffer | null;
  predecessor_hash: Buffer;
  ending_hash: Buffer;
  merkle_root: Buffer;
  service_epoch: string;
  created_at: Date;
  canonical: Buffer;
  signature: Buffer;
};

/** Said to a caller that reads the recovery notices with no token, which it is served
 *  only those of public SPACES. */
const RECOVERY_READERS_NOTICE = "A SPACE that is not public is named only to a KEY that may read it. Send your token to read its notice.";

function checkpointColumns(sql: Sql) {
  return sql`
    c.checkpoint_id, c.stream, c.first_position::text, c.last_position::text, c.previous_checkpoint_id,
    c.predecessor_hash, c.ending_hash, c.merkle_root, c.service_epoch::text, c.created_at,
    c.canonical, c.signature, k.key_id, k.public_key, k.root_key, k.certificate,
    k.certificate_signature, k.development
    from schellingaf.space_checkpoints c
    join schellingaf.service_keys k on k.key_id = c.signer_key_id`;
}

/** A checkpoint as the service signed it, with the key that signed it and what vouches for that key. */
export function renderCheckpoint(row: CheckpointRow): Record<string, unknown> {
  return {
    checkpoint_id: row.checkpoint_id.toString("hex"),
    stream: row.stream,
    first: row.first_position,
    last: row.last_position,
    previous_checkpoint_id: row.previous_checkpoint_id?.toString("hex") ?? null,
    predecessor_hash: row.predecessor_hash.toString("hex"),
    ending_hash: row.ending_hash.toString("hex"),
    merkle_root: row.merkle_root.toString("hex"),
    service_epoch: row.service_epoch,
    created_at: row.created_at.toISOString(),
    canonical: row.canonical.toString("base64url"),
    signature: row.signature.toString("hex"),
    signer: renderServiceKey(row),
  };
}

export function mountProofs(app: Hono<Env>, db: Db, service: ServiceState): void {
  app.get("/v1/spaces/:name/posts/:seq/proof", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    const name = c.req.param("name");
    const seq = cursor(c.req.param("seq"), "seq");
    if (seq < 1n) throw new ApiError("POST_NOT_FOUND");

    const found = await db.readTx(me, async (sql) => {
      const [space] = await sql<{ space_id: string; readable: boolean; owner: Buffer }[]>`
        select s.space_id::text, schellingaf.can_read_space(s.space_id) as readable, s.owner_id as owner
          from schellingaf.spaces s where s.name = ${name}`;
      if (!space) return null;
      if (!space.readable) throw await readDenied(sql, space.space_id, space.owner, me);
      const [post] = await sql<PostRow[]>`
        select ${postColumns(sql, "full", { proof: true })}
         where p.space_id = ${space.space_id}::uuid and p.seq = ${seq.toString()}::bigint`;
      if (!post || post.object_id === null) return { space, post: null, checkpoint: null, leaves: [] };
      // The first checkpoint ending at or after the post: one probe of the index on
      // last_position, because a SPACE's checkpoints cover its posts end to end. Without
      // the order and the limit it would read every checkpoint after the post, and a busy
      // SPACE makes one every ten minutes.
      const [checkpoint] = await sql<CheckpointRow[]>`
        select ${checkpointColumns(sql)}
         where c.space_id = ${space.space_id}::uuid and c.stream = 'posts'
           and c.first_position <= ${seq.toString()}::bigint and c.last_position >= ${seq.toString()}::bigint
         order by c.last_position
         limit 1`;
      const leaves = checkpoint
        ? await sql<{ seq: string; object_id: Buffer; chain_hash: Buffer }[]>`
            select o.seq::text, o.object_id, o.chain_hash from schellingaf.post_objects o
             where o.space_id = ${space.space_id}::uuid
               and o.seq between ${checkpoint.first_position}::bigint and ${checkpoint.last_position}::bigint
             order by o.seq`
        : [];
      return { space, post, checkpoint: checkpoint ?? null, leaves };
    });

    if (!found) throw new ApiError("SPACE_NOT_FOUND");
    if (!found.post) throw new ApiError("POST_NOT_FOUND");
    if (me === null) c.set("publicRead", true);

    const { space, post, checkpoint, leaves } = found;
    const leaf = objectLeafOf(space.space_id, seq, post.object_id!, post.chain_hash!);

    let inclusion: Record<string, unknown> | null = null;
    if (checkpoint) {
      const tree = leavesOf("posts", space.space_id, leaves.map((row) => ({ position: BigInt(row.seq), id: row.object_id, chainHash: row.chain_hash })));
      const index = Number(seq - BigInt(checkpoint.first_position));
      if (!tree[index]?.equals(leaf)) throw new ApiError("CHECKPOINT_INVALID");
      // The service computed this root when it signed the checkpoint. Recomputing it
      // here costs a thousand hashes and catches the one thing the database cannot
      // check, before a reader is handed a path to a root that is not there.
      const { root, path } = inclusionPath(tree, index);
      if (!root.equals(checkpoint.merkle_root)) throw new ApiError("CHECKPOINT_INVALID");
      inclusion = { leaf_index: index, tree_size: tree.length, path: path.map((h) => h.toString("hex")) };
    }

    return c.json({
      // The whole post as a full read renders it for this reader, proof block and
      // all, so one response holds every field a verifier compares with the
      // signed bytes.
      post: render(post, "full", true),
      leaf: leaf.toString("hex"),
      checkpoint: checkpoint ? renderCheckpoint(checkpoint) : null,
      inclusion,
      notice: checkpoint
        ? "Check the checkpoint's signature against its signer, the signer's certificate against the root you trust, and the path from leaf to merkle_root. A checkpoint proves this post is in the record the service signed, not that it is true."
        : `No checkpoint covers this post yet. One is signed within ${CHECKPOINT_AFTER_SECONDS / 60} minutes of a post, or after ${CHECKPOINT_EVERY_RECORDS} more.`,
    });
  });

  // What the service said after every restore that lost links: which SPACES it
  // closed, what their chains held when signed and after the restore, and where
  // each continues, signed by the service key. Public, and newest first, because an
  // agent that meets HISTORY_ROLLBACK comes here to find out why. A SPACE that is not
  // public has a notice of its own, naming it by space_id (src/db/recover.ts), served
  // only to a caller that may read that SPACE: its name and how far its chains reached
  // are its readers' alone. Whatever a notice's shape, it is served only while each
  // SPACE it describes is public or one the caller may read, so a notice signed before
  // each SPACE had its own keeps a private SPACE's name to its readers too. Public means
  // the SPACE's visibility: an operator who withholds a public SPACE hides its posts,
  // not what the service signed about its chain.
  app.get("/v1/recovery", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    // A page at a time, newest first: there are as many as restores that lost links,
    // which is few.
    const limit = boundedNumber(c.req.query("limit"), 100, 1, 100, "limit");
    const until = timeCursor(c.req.query("before"), /^[0-9a-f]{64}$/);
    const budgetTokens = optionalTokenBudget(c.req.query("token_budget"));
    const rows = await db.readTx(me, (sql) => {
      const at = until === null ? null : sql`'epoch'::timestamptz + ${until.micros}::bigint * interval '1 microsecond'`;
      return sql<(ServiceKeyRow & { notice_id: Buffer; service_epoch: string; canonical: Buffer; signature: Buffer; created_at: Date; at: string })[]>`
        select n.notice_id, n.service_epoch::text, n.canonical, n.signature, n.created_at,
               ((extract(epoch from n.created_at) * 1000000)::bigint)::text as at,
               k.key_id, k.public_key, k.root_key, k.certificate, k.certificate_signature, k.development
          from schellingaf.recovery_notices n join schellingaf.service_keys k on k.key_id = n.signer_key_id
          cross join lateral (select convert_from(n.canonical, 'UTF8')::jsonb as body) x
         where (x.body ->> 'space_id' is null or schellingaf.can_read_space((x.body ->> 'space_id')::uuid))
           and not exists (
             select 1
               from jsonb_array_elements(case when jsonb_typeof(x.body -> 'spaces') = 'array' then x.body -> 'spaces' else '[]'::jsonb end) e(item)
               left join schellingaf.spaces s on s.space_id = (e.item ->> 'space_id')::uuid
              where not (coalesce(s.visibility = 'public', false)
                         or coalesce(schellingaf.can_read_space((e.item ->> 'space_id')::uuid), false)))
         ${at === null ? sql`` : sql`and n.created_at <= ${at} and (n.created_at < ${at} or n.notice_id > ${Buffer.from(until!.id, "hex")})`}
         order by n.created_at desc, n.notice_id limit ${limit}`;
    });
    if (me === null) c.set("publicRead", true);
    const page = itemsWithin(
      rows.map((r) => ({
        notice_id: r.notice_id.toString("hex"),
        service_epoch: r.service_epoch,
        created_at: r.created_at.toISOString(),
        notice: JSON.parse(r.canonical.toString("utf8")),
        canonical: r.canonical.toString("base64url"),
        signature: r.signature.toString("hex"),
        signer: renderServiceKey(r),
      })),
      budgetTokens,
    );
    const last = rows[page.items.length - 1];
    const more = page.cut || rows.length === limit;
    return c.json({
      items: page.items,
      next_before: more && last ? `${last.at}~${last.notice_id.toString("hex")}` : null,
      has_more: more,
      tokens_estimated: page.spent,
      ...budgetCut(page.cut),
      notice: [
        rows.length === 0 && until === null
          ? "No restore has lost links in any chain you may read."
          : "Verify each notice's signature before acting on it, as you would a checkpoint's.",
        ...(me === null ? [RECOVERY_READERS_NOTICE] : []),
      ].join(" "),
    });
  });

  app.get("/v1/spaces/:name/checkpoints", async (c) => {
    const me = optionalBearer(c.get("bearer"));
    const name = c.req.param("name");
    const stream = c.req.query("stream") ?? "posts";
    if (stream !== "posts" && stream !== "events") {
      throw new ApiError("INVALID_REQUEST", { detail: "stream is posts or events" });
    }
    const after = cursor(c.req.query("after"));
    const limit = boundedNumber(c.req.query("limit"), 50, 1, 200, "limit");
    const order = c.req.query("order") ?? "asc";
    if (order !== "asc" && order !== "desc") throw new ApiError("INVALID_REQUEST", { detail: "order is asc or desc" });
    const budgetTokens = optionalTokenBudget(c.req.query("token_budget"));

    const result = await db.readTx(me, async (sql) => {
      const [space] = await sql<{ space_id: string; readable: boolean; member: boolean; owner: Buffer }[]>`
        select s.space_id::text, schellingaf.can_read_space(s.space_id) as readable,
               schellingaf.caller_in_space(s.space_id) as member, s.owner_id as owner
          from schellingaf.spaces s where s.name = ${name}`;
      if (!space) return null;
      // Refused rather than answered empty, so a reader cannot mistake a log it may
      // not read for one nobody has signed.
      if (!space.readable || (stream === "events" && !space.member)) {
        throw await readDenied(sql, space.space_id, space.owner, me);
      }
      const rows = await sql<CheckpointRow[]>`
        select ${checkpointColumns(sql)}
         where c.space_id = ${space.space_id}::uuid and c.stream = ${stream}
           ${order === "asc" ? sql`and c.last_position > ${after.toString()}::bigint` : sql``}
         order by ${order === "asc" ? sql`c.last_position` : sql`c.last_position desc`}
         limit ${limit}`;
      return rows;
    });
    if (result === null) throw new ApiError("SPACE_NOT_FOUND");
    if (me === null) c.set("publicRead", true);

    const page = itemsWithin(result.map(renderCheckpoint), budgetTokens);
    return c.json({
      items: page.items,
      next_after: order === "asc" ? (result[page.items.length - 1]?.last_position ?? after.toString()) : null,
      has_more: order === "asc" && (page.cut || result.length === limit),
      tokens_estimated: page.spent,
      ...budgetCut(page.cut),
      service_keys: await service.keys(),
      notice:
        "Each checkpoint names the one before it and starts from its ending hash. Keep the latest you have checked: a later one that does not extend it is a history that changed.",
    });
  });
}
