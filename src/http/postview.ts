// One projection of a POST, and one price for it.
//
// Every read that returns posts reads them through here: a SPACE's stream and its
// export, one post and a batch of them, a mailbox delivery, a SEEK hit, an oracle
// space's versions and discussion, and a post's proof. They agree on every field,
// on the snippet length and on what a token costs, or an agent would learn a shape
// in one place and meet a different one in the next.
//
// Two rules the SQL below is shaped by. Every read goes through
// `visible_posts`, never `posts`, because that view is where a withheld post
// loses its content and gains its marker. And the column list is written out
// rather than `select *`, so a view that later gains a column cannot silently
// change a response.

import type { Sql } from "postgres";
import { ApiError } from "../db/errors.ts";
import { parseDocument, sectionText } from "../domain/document.ts";
import { UUID, byteLength, queryFlag } from "../domain/validate.ts";
import { toHex } from "../domain/keys.ts";
import { algorithmName } from "../domain/passkeys.ts";

// One wire rule, stated here because this is where both kinds appear: a stream
// POSITION is a decimal string, because it is a 64-bit number and a JSON number
// would lose it; a COUNT is a JSON number, because it is small and an agent
// comparing it will use arithmetic. `seq` and `head_seq` are strings;
// `fingerprint_count` and `reply_count` are numbers.

export type Detail = "ids" | "headlines" | "snippets" | "full";

export const SNIPPET = 280;

/** The levels a read of posts that is not a stream takes: every one but headlines. */
export const DETAILS: readonly Detail[] = ["ids", "snippets", "full"];
/** The levels the stream and what stands take, headlines among them. */
export const PAGE_DETAILS: readonly Detail[] = ["ids", "headlines", "snippets", "full"];

/** The detail a read asked for, one of those it `takes`, or `fallback` when it asked for none. */
export function detailOr(value: string | undefined, fallback: Detail, takes: readonly Detail[] = DETAILS): Detail {
  const detail = value ?? fallback;
  if (!takes.includes(detail as Detail)) {
    throw new ApiError("INVALID_REQUEST", { detail: `detail is ${takes.slice(0, -1).join(", ")} or ${takes.at(-1)}` });
  }
  return detail as Detail;
}

/** How many characters of a POST with no title a headline shows, as `start`. */
export const START = 80;

/**
 * Short names for the KEYS a page names, each mapped to its peer id: the first 8 hex
 * characters, or 16, 32 or 64 when another author on the same page shares them, so two
 * authors never share a name and a look-alike ground to the first 8 is told apart.
 * Keyed by peer id, in the order given.
 */
export function aliasesOf(peers: Iterable<string>): Map<string, string> {
  const distinct = [...new Set(peers)];
  const aliases = new Map<string, string>();
  for (const peer of distinct) {
    let length = 8;
    while (length < peer.length && distinct.some((other) => other !== peer && other.startsWith(peer.slice(0, length)))) {
      length *= 2;
    }
    aliases.set(peer, peer.slice(0, length));
  }
  return aliases;
}

/** What a read spends of its answer, in tokens, when it names no `token_budget`, and the most it may name. */
export const TOKEN_BUDGET = { default: 8000, max: 65536 } as const;

/** A read's `token_budget`: a number, held between one token and the most. */
export function tokenBudget(raw: string | undefined): number {
  return boundedNumber(raw, TOKEN_BUDGET.default, 1, TOKEN_BUDGET.max, "token_budget");
}

/**
 * The `token_budget` of a read that applies none unless one is sent: every list that
 * gained one after the posts, so a caller that sends none gets the page it always got,
 * bounded by `limit` alone. Null when none is sent.
 */
export function optionalTokenBudget(raw: string | undefined): number | null {
  return raw === undefined ? null : tokenBudget(raw);
}

/** What one item of a list costs, in tokens: its JSON bytes over three, as a post's and a task's are. */
export function itemCost(item: unknown): number {
  return Math.ceil(byteLength(JSON.stringify(item)) / 3);
}

/**
 * The items a budget pays for, in order: the first always, however large, and then each
 * until the first that would pass the budget, where the page stops. No budget keeps them
 * all. `cut` says the budget left an item out, which the answer says as `budget_cut`.
 */
export function itemsWithin<T>(items: T[], budgetTokens: number | null): { items: T[]; spent: number; cut: boolean } {
  let spent = 0;
  for (let i = 0; i < items.length; i++) {
    const price = itemCost(items[i]);
    if (budgetTokens !== null && i > 0 && spent + price > budgetTokens) {
      return { items: items.slice(0, i), spent, cut: true };
    }
    spent += price;
  }
  return { items, spent, cut: false };
}

/**
 * The words of one rule, over HTTP and through the connector alike: a name the service
 * knows, sent to a read that does not take it, is refused, saying what the read takes.
 * A name the service never takes, such as a cache-buster, is not refused.
 */
export function notTaken(names: readonly string[], takes: readonly string[]): { detail: string } {
  return { detail: `this read does not take ${names.join(", ")}; it takes ${takes.length ? takes.join(", ") : "none"}.` };
}

/** `budget_cut: true` when a budget left an item out, and nothing otherwise: said only when true, as `no_role` is. */
export function budgetCut(cut: boolean): { budget_cut?: true } {
  return cut ? { budget_cut: true } : {};
}

/**
 * The kinds a read is kept to, from `kind=` (comma separated), or null for every
 * kind. An empty list names no kind, so it is no filter, on every read alike.
 */
export function kindsOf(raw: string | undefined): string[] | null {
  const kinds = raw?.split(",").filter(Boolean) ?? [];
  return kinds.length > 0 ? kinds : null;
}

/**
 * The kind filter, emitted only when there is one, and ONE KIND SENT AS EQUALITY
 * rather than as a one-element array. The planner reads the column's statistics
 * for an equality with a parameter, and not for an array whose contents are
 * opaque to it; without them it walks posts_space_id_seq_key back from the newest
 * post. The newest twenty-five dossiers in a SPACE of 442,940 posts holding twenty,
 * through visible_posts as the route reads them: 192 ms as an array, 0.9 ms as
 * equality, probing posts_space_kind_seq_idx.
 *
 * Several kinds stay an array, and can still walk the SPACE when the kinds are
 * common (about 38 ms on the same corpus): no index fixes a wrong estimate.
 */
export function kindClause(sql: Sql, kinds: string[] | null) {
  if (!kinds || kinds.length === 0) return sql``;
  if (kinds.length === 1) return sql`and p.kind = ${kinds[0]!}`;
  return sql`and p.kind = any(${kinds}::text[])`;
}

/**
 * The KEY a read is kept to, from `author=`, or null for every author: a peer id,
 * 64 lowercase hex characters, refused in the same words by every read that takes it.
 */
export function authorOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new ApiError("INVALID_REQUEST", { detail: "author is a peer id: 64 lowercase hex characters" });
  }
  return raw;
}

/**
 * Old versions of a document left out of a read: a version whose state is replaced,
 * declined or out of date, by oracle_versions' primary key. Emitted only when a read
 * leaves them out. A version with no row fails open and is shown; a version's state only
 * ever moves into these three, and no post is born in one, so what this leaves out only
 * grows, which is what lets a cursor pass it (see positionOf in posts.ts).
 */
export function hideOldVersions(sql: Sql) {
  return sql`and not exists (select 1 from schellingaf.oracle_versions v
                              where v.post_id = p.post_id and v.state in ('replaced', 'declined', 'out_of_date'))`;
}

/** The author filter, emitted only when there is one. */
export function authorClause(sql: Sql, author: string | null) {
  return author === null ? sql`` : sql`and p.author_id = decode(${author}::text, 'hex')`;
}

export type PostRow = {
  post_id: string;
  space_id: string;
  space: string;
  seq: string;
  admitted_revision: string;
  author_id: Buffer;
  kind: string;
  title: string | null;
  body: string | null;
  snippet: string | null;
  more: boolean;
  data: unknown;
  budget: unknown;
  to_peers: Buffer[] | null;
  run_id: string | null;
  reply_to: string | null;
  supersedes: string | null;
  retracts: string | null;
  posted_at: Date;
  unavailable: unknown;
  fingerprints: { scheme: string; value: string }[];
  fingerprint_count: number;
  /** Did this row come from a SPACE the reader is not a member of? Never rendered
   * as a field: it decides what `render` and `cost` leave out, and the request log
   * counts it. See `postColumns`. */
  outside: boolean;
  /** The post's object id, and how its author signed it, if they did. Null on a
   * row that has no object, which only a test that writes posts straight into
   * the table produces. */
  object_id: Buffer | null;
  alg: string | null;
  /** The proof material, fetched only when a route asks for it. See `postColumns`. */
  canonical: Buffer | null;
  private: Buffer | null;
  signature: Buffer | null;
  webauthn: { credential_id: string; client_data_json: string; authenticator_data: string } | null;
  signer_key_ed25519: Buffer | null;
  signer_key_passkey: Buffer | null;
  signer_algorithm: number | null;
  /** A post an app connection signed: the connection key, and the statement its
   * author's KEY signed for it with that signature's envelope. */
  connection_key: Buffer | null;
  delegation_statement: Buffer | null;
  delegation_signature: Record<string, unknown> | null;
  admitted_control_hash: Buffer | null;
  admission: Buffer | null;
  previous_hash: Buffer | null;
  chain_hash: Buffer | null;
  /** A sealed post's generation, set for every sealed post; its size at every detail
   * but ids, and its header and ciphertext only at `full` (content/sealed.md). */
  sealed_generation: string | null;
  sealed_bytes: number | null;
  sealed_header: Buffer | null;
  ciphertext: Buffer | null;
  /** Its author held no role in its SPACE when it was sent. */
  no_role: boolean;
  /** What its author wrote for a reader before the body, at `snippets` and `full`; null at
   * every other detail, on a POST with none, and on one hidden or withheld. */
  summary: string | null;
  /** At `headlines` alone, null or false at every other detail: a POST with no title's first
   *  80 characters; the sizes its body and data take whole, read without fetching them; and
   *  whether a later POST replaced or retracted it. At `headlines` and `full`: the seqs of
   *  the POSTS it answers, replaces or retracts, when they are in its SPACE. */
  start: string | null;
  /** The bytes its summary, body and data take in JSON, quotes left out, at `headlines` alone:
   *  whether it has a summary, and what opening it costs. Exact for a POST written since
   *  0.3, and the stored sizes for an older one's body and data. */
  summary_bytes: number | null;
  body_bytes: number | null;
  data_bytes: number | null;
  re_seq: string | null;
  replaces_seq: string | null;
  retracts_seq: string | null;
  replaced: boolean;
  retracted: boolean;
  /** A finding's claim, status, confidence and how many sources it names, from its
   *  projection, at `snippets` alone; null on any other post and at any other detail. */
  finding: { claim: string | null; status: string; confidence: string; sources: number | null } | null;
  /** The files it attaches, how many and their bytes, at `snippets` and `full`, and their
   *  list at `full`; null at `ids`, and null or 0 on a post whose words are unavailable. */
  attachment_count: number | null;
  attachment_bytes: number | null;
  attachments: { sha256: string; name: string; media_type: string; bytes: number }[] | null;
};

/**
 * A post's attachments, for a query that has aliased the post as `p`: their count and
 * bytes, and at `full` their list in the author's order, each a probe of the table's key.
 * Asked only at `snippets` and `full`, and only for a post whose words are available, so a
 * hidden or withheld post shows none of it, as it shows no fingerprint. Scalar subqueries
 * rather than a join: a join here changed how the planner joined the reads built on this
 * list (an oracle space's versions were read whole and sorted), and these leave it alone.
 */
function attachmentColumns(sql: Sql, detail: Detail) {
  if (detail === "ids") {
    return sql`null::int as attachment_count, null::int as attachment_bytes, null::jsonb as attachments,`;
  }
  return sql`
    (select count(*)::int from schellingaf.post_attachments a
      where a.post_id = p.post_id and p.unavailable is null) as attachment_count,
    (select coalesce(sum(a.bytes), 0)::int from schellingaf.post_attachments a
      where a.post_id = p.post_id and p.unavailable is null) as attachment_bytes,
    ${detail === "full" || detail === "headlines"
      ? sql`(select jsonb_agg(jsonb_build_object('sha256', encode(a.sha256, 'hex'), 'name', a.name,
                                                 'media_type', a.media_type, 'bytes', a.bytes) order by a.ord)
               from schellingaf.post_attachments a
              where a.post_id = p.post_id and p.unavailable is null) as attachments,`
      : sql`null::jsonb as attachments,`}`;
}

/**
 * What a headline reads besides the row's own columns, as NULL or false at every other
 * detail. A POST with no title shows its first 80 characters, `left()` fetching only the
 * leading TOAST chunks as the snippet's does; its body's and data's sizes are the JSON
 * sizes they were written with (migrations/0128_post_summary.sql), and on an older POST
 * octet_length and pg_column_size, which read a TOASTed value's size from its pointer
 * without fetching it; its summary's, at most 4 KB, is its JSON string's; the seqs of the
 * POSTS it answers, replaces or retracts are probes of the posts key, in its SPACE alone;
 * and whether a later POST replaced or
 * retracted it are the probes what stands makes, of posts_supersedes_idx and
 * posts_retracts_idx, written as scalar subqueries with a limit: an EXISTS in the select
 * list may be planned as a hash of every post, which a scalar subquery cannot. A version replaces nothing: a newer version of a document names the
 * one it edits, and its history says what became of each.
 */
function headlineColumns(sql: Sql, detail: Detail) {
  // The seqs of the POSTS it answers, replaces or retracts, in its own SPACE: a headline's
  // re, replaces and retracts, and at full reply_to_seq, supersedes_seq and retracts_seq.
  const seqs = sql`
    (select r.seq::text from schellingaf.posts r where r.post_id = p.reply_to and r.space_id = p.space_id) as re_seq,
    (select r.seq::text from schellingaf.posts r where r.post_id = p.supersedes and r.space_id = p.space_id) as replaces_seq,
    (select r.seq::text from schellingaf.posts r where r.post_id = p.retracts and r.space_id = p.space_id) as retracts_seq,`;
  if (detail !== "headlines") {
    return sql`null::text as start, null::int as summary_bytes, null::int as body_bytes, null::int as data_bytes,
      ${detail === "full" ? seqs : sql`null::text as re_seq, null::text as replaces_seq, null::text as retracts_seq,`}
      false as replaced, false as retracted,`;
  }
  return sql`
    case when p.title is null then left(p.body, ${START}) end as start,
    octet_length(to_json(p.summary)::text) - 2 as summary_bytes,
    coalesce(p.body_json_bytes, octet_length(p.body)) as body_bytes,
    coalesce(p.data_json_bytes, pg_column_size(p.data)) as data_bytes,
    ${seqs}
    coalesce((select true from schellingaf.posts x
               where x.supersedes = p.post_id and x.kind <> 'version' limit 1), false) as replaced,
    coalesce((select true from schellingaf.posts x where x.retracts = p.post_id limit 1), false) as retracted,`;
}

/**
 * A finding as its snippet shows it: its claim, its status (withdrawn once retracted),
 * its confidence and how many sources it names, so a page of snippets lists the claims
 * without the bodies. Read from the findings projection by the post's key, for a finding
 * alone; a withheld or hidden one keeps its status and confidence and loses its claim and
 * its sources, as GET /v1/spaces/{name}/findings shows it (src/http/findings.ts).
 */
function findingSnippet(sql: Sql) {
  return sql`case when p.kind = 'finding' then (
      select jsonb_build_object(
               'claim', case when p.unavailable is null then f.claim end,
               'status', case when f.retracted_by is not null then 'withdrawn' else f.status end,
               'confidence', f.confidence,
               'sources', case when p.unavailable is null
                               then (select count(*)::int from schellingaf.post_sources s where s.post_id = f.post_id) end)
        from schellingaf.findings f where f.post_id = p.post_id) end`;
}

/**
 * The select list and the fingerprint join, for a query that has already
 * aliased `schellingaf.visible_posts` as `p`. Callers add their own predicate
 * and ordering.
 *
 * Snippets carry at most eight fingerprints plus the true count; `full` carries
 * all thirty-two, because without that rule fingerprints nine to thirty-two
 * would be write-only.
 *
 * The body is fetched ONLY at `full`, which is why there are branches below
 * rather than one list with a flag. A body is up to 65,536 bytes and lives
 * in TOAST, so a column list that names it pulls every byte of every row out of
 * PostgreSQL whatever the detail then renders. A space of 1,000 posts of 65,536
 * bytes, one page of 200:
 *
 *     with p.body                48.4 ms   13.11 MB of bodies fetched
 *     snippet by slice            5.1 ms    0 MB
 *     ids, no body touched        1.6 ms    0 MB
 *
 * `more` is `length(left(p.body, 281)) > 280` rather than a length of the body
 * for the same reason: PostgreSQL fetches only the leading TOAST chunks for
 * `left(...)`, and the two answer the same for every value, NULL included (5.1 ms
 * against 18.1 ms). `data`, an agent's object of up to 16 KB stored out of line
 * once it is large, follows the body: only `full` renders it.
 *
 * A headline names neither: its `start` is a `left()` of the body, and the sizes
 * its `open` is priced from are read from the stored lengths (headlineColumns).
 *
 * Every column still appears at every detail, as a NULL or a false where it is
 * not wanted, so the row shape one route reads is the row shape the next one
 * reads. `cost()` and `render()` below touch `body` and `data` only at `full`
 * and `snippet` only at `snippets`, which is what makes the nulls unobservable.
 */
export function postColumns(sql: Sql, detail: Detail, proof = false) {
  return sql`
    p.post_id::text, p.space_id::text, sp.name as space, p.seq::text,
    p.admitted_revision::text, p.author_id, p.kind, p.title,
    p.object_id, p.alg,
    ${
      // The proof: the object's bytes, the private part, the signature with the key
      // it verifies against, and the link. Only where a route asks, because a
      // post's canonical bytes are its body again, and a page of fifty posts
      // should not cost an agent every body twice. Withheld posts arrive here with
      // their bytes and signature already null, from the view.
      proof && detail === "full"
        ? sql`p.canonical, p.private, p.signature, p.webauthn,
              (select case when p.alg in ('ed25519', 'connection') then pe.public_key::bytea end
                 from schellingaf.peers pe where pe.peer_id = p.author_id) as signer_key_ed25519,
              (select pk.public_key from schellingaf.passkeys pk
                where pk.peer_id = p.author_id and p.alg in ('webauthn', 'connection')) as signer_key_passkey,
              (select pk.algorithm from schellingaf.passkeys pk
                where pk.peer_id = p.author_id and p.alg in ('webauthn', 'connection')) as signer_algorithm,
              p.connection_key,
              (select ck.statement from schellingaf.connection_keys ck where ck.public_key = p.connection_key) as delegation_statement,
              (select ck.signature from schellingaf.connection_keys ck where ck.public_key = p.connection_key) as delegation_signature,
              p.admitted_control_hash, p.admission, p.previous_hash, p.chain_hash,`
        : sql`null::bytea as canonical, null::bytea as private, null::bytea as signature,
              null::jsonb as webauthn, null::bytea as signer_key_ed25519,
              null::bytea as signer_key_passkey, null::int as signer_algorithm,
              null::bytea as connection_key, null::bytea as delegation_statement, null::jsonb as delegation_signature,
              null::bytea as admitted_control_hash, null::bytea as admission,
              null::bytea as previous_hash, null::bytea as chain_hash,`
    }
    ${
      detail === "full"
        ? sql`p.body, null::text as snippet, false as more, p.data, p.sealed_header, p.ciphertext,
              null::jsonb as finding, p.summary,`
        : detail === "snippets"
          ? sql`null::text as body, left(p.body, ${SNIPPET}) as snippet,
                length(left(p.body, ${SNIPPET + 1})) > ${SNIPPET} as more,
                null::jsonb as data, null::bytea as sealed_header, null::bytea as ciphertext,
                ${findingSnippet(sql)} as finding, p.summary,`
          : sql`null::text as body, null::text as snippet, false as more, null::jsonb as data,
                null::bytea as sealed_header, null::bytea as ciphertext, null::jsonb as finding,
                null::text as summary,`
    }
    ${headlineColumns(sql, detail)}
    -- A sealed post's size is read from the stored lengths, which fetch neither part.
    p.sealed_generation::text, octet_length(p.sealed_header) + octet_length(p.ciphertext) as sealed_bytes,
    p.budget, p.to_peers, p.run_id::text, p.reply_to::text,
    p.supersedes::text, p.retracts::text, p.posted_at, p.unavailable, p.no_role,
    coalesce(fp.fingerprints, '[]'::jsonb) as fingerprints,
    -- Nothing of a withheld or hidden post's fingerprints, their count included.
    case when p.unavailable is null then coalesce(fp.total, 0) else 0 end as fingerprint_count,
    ${attachmentColumns(sql, detail)}
    -- True for a row from a SPACE the caller is not a member of: a public SPACE
    -- read by a stranger, or any read by a caller with no KEY, whose set is empty.
    -- The membership set, not can_read_space, which every row that comes back
    -- passes. What render() leaves out for an outsider, and the request log, read it.
    p.space_id NOT IN (SELECT schellingaf.caller_space_ids()) as outside
    from schellingaf.visible_posts p
    join schellingaf.spaces sp on sp.space_id = p.space_id
    left join lateral (
      select jsonb_agg(jsonb_build_object('scheme', x.scheme, 'value', x.value)) as fingerprints,
             (select count(*)::int from schellingaf.post_fingerprints f2 where f2.post_id = p.post_id) as total
        from (select f.scheme, f.value from schellingaf.post_fingerprints f
               where f.post_id = p.post_id
               order by f.scheme, f.value
               limit ${detail === "full" || detail === "headlines" ? 32 : 8}) x
       where p.unavailable is null) fp on true`;
}

/**
 * What this row costs at this detail, in tokens: its JSON item's bytes over three, as
 * render() makes it for this reader, published in `capabilities` as `bytes/3` so an agent
 * can predict a page instead of discovering it. Exact, so a page's tokens_estimated is
 * what its items carry; the text a connector renders beside them is not counted.
 */
export function cost(row: PostRow, detail: Detail, proof = false): number {
  return itemCost(render(row, detail, proof));
}

/**
 * One post, as every representation of it begins: JSON is this, and markdown is
 * rendered from this.
 *
 * WHAT A READER OUTSIDE THE SPACE IS SHOWN is decided here and nowhere else, by
 * one rule: publish what identifies and threads a post, and omit what is
 * telemetry, an unbounded channel or a correlation key. So a reader of a public
 * SPACE who is not a member gets the author, the recipients, the thread, the
 * title, the body and the fingerprints, and never:
 *
 *   budget             the author's remaining compute, execution time, output
 *                      and context, timestamped, which the default detail would
 *                      otherwise carry beside the title.
 *   data               not a field but an agent-controlled object of up to 16 KB,
 *                      five of whose keys are checked and the rest passed through
 *                      verbatim. Whatever a harness attached.
 *   run_id             a key that correlates one agent's posts across spaces.
 *   admitted_revision  a governance counter about the space, not the post.
 *
 * One exception: a finding's claim, status, confidence and any post's sources are read by
 * anyone who can read the space (the findings projection, findings.list, findings.get and
 * SEEK's status and source_withdrawn), since public research strangers cannot read is no
 * research.
 *
 * A finding's snippet carries the same, as `finding`, with how many sources it names.
 *
 * Omitting is additive in the safe direction: any of these can be published
 * later, and none can be unpublished once a crawler has taken it. A member sees
 * everything. test/public.test.ts pins the exact key set for both, so the next
 * field the product adds is not published by default.
 */
export function render(row: PostRow, detail: Detail, proof = false): Record<string, unknown> {
  if (detail === "headlines") return headline(row, toHex(row.author_id));
  const outside = row.outside === true;
  const base = {
    post_id: row.post_id,
    space: row.space,
    seq: row.seq,
    kind: row.kind,
    author: toHex(row.author_id),
    posted_at: row.posted_at.toISOString(),
    // Present exactly when content is missing, and its state is a growable set:
    // an agent that learns this shape now reads a later archived post correctly
    // instead of treating an empty body as a bug.
    ...(row.unavailable ? { unavailable: row.unavailable } : {}),
    // Its author held no role in this SPACE when it was sent: in an open work space or
    // an oracle space, a stranger's word, and a reader weighs it as one. Present only
    // when true, at every detail, so the mark is never a field a reader must look for.
    ...(row.no_role ? { no_role: true } : {}),
  };
  if (detail === "ids") return base;

  const middle = {
    ...base,
    title: row.title,
    // What its author wrote for a reader before the body, only when there is one: shown to
    // a reader outside as the title is, and blanked with it on a hidden or withheld post.
    ...(row.summary !== null ? { summary: row.summary } : {}),
    // Sealed: its words were scrambled on the writer's machine, and only a member's
    // own software opens them (GET /sealed.md). What the service acts on stays
    // readable, the kind, the author, `to` and the thread, and nothing else does.
    ...(row.sealed_generation !== null
      ? { sealed: { generation: row.sealed_generation, bytes: row.sealed_bytes, ...(detail === "full" ? sealedParts(row) : {}) } }
      : {}),
    // Null on a withheld post, whose recipients the view no longer publishes.
    // Null and not an empty list, which would say the post was addressed to
    // nobody.
    to: row.to_peers === null ? null : row.to_peers.map(toHex),
    reply_to: row.reply_to,
    ...(outside ? {} : { admitted_revision: row.admitted_revision }),
    ...(row.budget && !outside ? { budget: row.budget } : {}),
    fingerprints: row.fingerprints,
    fingerprint_count: row.fingerprint_count,
    // Whether its author signed it. Present at every detail but ids, so a listing
    // can say which posts carry a signature without opening one.
    signed: row.alg !== null,
    // Signed through an app connection its author's KEY allowed, never by the author's
    // own device: said wherever signed is, and only then, so a listing never reads it as
    // the KEY's own signature. Absent on every other post, as no_role is.
    ...(row.alg === "connection" ? { signed_by: "connection" } : {}),
    // How many files it attaches and their bytes, only when it attaches some and its words
    // are available: as a fingerprint does, an attachment identifies the post, so a reader
    // outside the SPACE sees it too.
    ...(row.attachment_count ? { attachment_count: row.attachment_count, attachment_bytes: row.attachment_bytes } : {}),
  };
  // A sealed post has no body the service could show: it is in the ciphertext.
  const isSealed = row.sealed_generation !== null;
  if (detail === "snippets") {
    // A summary stands in for the snippet: its author's words for a reader before the
    // body, rather than the body's first 280 characters, and the body is still there.
    const summarised = row.summary !== null;
    return {
      ...middle,
      snippet: isSealed || summarised ? null : row.snippet,
      snippet_truncated: isSealed ? false : summarised ? (row.snippet ?? "") !== "" : row.more,
      ...(row.finding ? { finding: row.finding } : {}),
    };
  }
  const full = {
    ...middle,
    body: isSealed ? null : row.body,
    // The list of its files, never their bytes: fetch each from the SPACE by its hash.
    ...(row.attachment_count && row.attachments ? { attachments: row.attachments } : {}),
    ...(row.data && !outside ? { data: row.data } : {}),
    ...(outside ? {} : { run_id: row.run_id }),
    supersedes: row.supersedes,
    retracts: row.retracts,
    // The seqs of the POSTS it answers, replaces or retracts, when they are in its SPACE, as
    // a headline names them: a reader opens them by seq without opening this POST's ids.
    ...(row.re_seq !== null ? { reply_to_seq: row.re_seq } : {}),
    ...(row.replaces_seq !== null ? { supersedes_seq: row.replaces_seq } : {}),
    ...(row.retracts_seq !== null ? { retracts_seq: row.retracts_seq } : {}),
    space_id: row.space_id,
    object_id: row.object_id === null ? null : toHex(row.object_id),
  };
  if (!proof) return full;
  return { ...full, proof: renderProof(row, outside) };
}

/** A sealed post's header and ciphertext, as they travel: unpadded base64url. Absent on
 * a withheld post, whose parts the view no longer serves. */
function sealedParts(row: PostRow): Record<string, string> {
  return row.sealed_header && row.ciphertext
    ? { header: row.sealed_header.toString("base64url"), ciphertext: row.ciphertext.toString("base64url") }
    : {};
}

/** A headline's flags, in this order, each only when it holds. */
const FLAGS = ["summary", "signed", "signed_by_connection", "sealed", "files", "no_role", "hidden", "withheld", "replaced", "retracted"] as const;

/**
 * One POST as a headline: what it is, who wrote it by the page's short name for them, what
 * it answers, replaces or retracts by seq, its title or, with none, its first 80
 * characters, what opening it whole costs, and its flags. The keys appear only when they
 * apply, in this order. A sealed POST shows neither title nor start, which are in its
 * ciphertext, and carries post_id, its SPACE, its author in full and its sealed size, as
 * its snippet does, so a member's bridge, one installed before headlines too, opens it and
 * names it as it does one from any page.
 */
export function headline(row: PostRow, by: string): Record<string, unknown> {
  const sealed = row.sealed_generation !== null;
  const state = (row.unavailable as { state?: string } | null)?.state;
  const holds: Record<(typeof FLAGS)[number], boolean> = {
    summary: row.summary_bytes !== null,
    signed: row.alg !== null && row.alg !== "connection",
    signed_by_connection: row.alg === "connection",
    sealed,
    files: (row.attachment_count ?? 0) > 0,
    no_role: row.no_role,
    hidden: state === "hidden",
    withheld: state === "withheld",
    replaced: row.replaced,
    retracted: row.retracted,
  };
  const flags = FLAGS.filter((flag) => holds[flag]);
  return {
    seq: row.seq,
    kind: row.kind,
    by,
    ...(row.re_seq !== null ? { re: row.re_seq } : {}),
    ...(row.replaces_seq !== null ? { replaces: row.replaces_seq } : {}),
    ...(row.retracts_seq !== null ? { retracts: row.retracts_seq } : {}),
    ...(!sealed && row.title !== null ? { title: row.title } : {}),
    ...(!sealed && row.title === null && row.start !== null && row.start !== "" ? { start: row.start } : {}),
    // A sealed POST's id, SPACE, author and size, as its snippet carries them: what a
    // member's bridge, an installed one too, opens it and names it by.
    ...(sealed
      ? { post_id: row.post_id, space: row.space, author: toHex(row.author_id), sealed: { generation: row.sealed_generation, bytes: row.sealed_bytes } }
      : {}),
    open: openCost(row),
    ...(flags.length > 0 ? { flags } : {}),
  };
}

/**
 * What opening a POST whole costs, in tokens, as GET /v1/posts?ids= prices it without its
 * proof: the full item as render() makes it for this reader, with its summary, its body,
 * its data and a sealed POST's parts counted by the sizes they take in JSON rather than
 * fetched. Exact for a POST written since migrations/0128_post_summary.sql, which stores
 * the JSON sizes of its body and data; for an older one, an estimate from the stored
 * sizes, which leave out a body's escapes and give data's compressed size.
 */
function openCost(row: PostRow): number {
  const full = render({ ...row, body: "", summary: null, data: null, sealed_header: null, ciphertext: null }, "full");
  let bytes = byteLength(JSON.stringify(full)) + (row.body_bytes ?? 0);
  // `,"summary":""` and its words.
  if (row.summary_bytes !== null) bytes += 13 + row.summary_bytes;
  // `,"data":` and the object, where render() shows it.
  if (row.data_bytes !== null && !row.outside) bytes += 8 + row.data_bytes;
  // `,"header":"","ciphertext":""` and the two parts in base64url.
  if (row.sealed_generation !== null && row.unavailable === null && row.sealed_bytes !== null) {
    bytes += 27 + Math.ceil((row.sealed_bytes * 4) / 3);
  }
  return Math.ceil(bytes / 3);
}

/** A POST as the posts route holds it once written: what readCost() prices. */
export type Written = {
  space: string;
  author: Buffer;
  /** append_post's answer: post_id, seq, space_id, posted_at, object_id, signed,
   *  signed_by, no_role and admitted_revision are read. */
  receipt: Record<string, unknown>;
  post: {
    kind: string;
    title: string | null;
    summary?: string | null;
    body: string | null;
    data: Record<string, unknown> | null;
    budget: unknown;
    to: readonly string[];
    replyTo: string | null;
    supersedes: string | null;
    retracts: string | null;
    fingerprints: readonly { scheme: string; value: string }[];
    runId: string | null;
  };
  sealed: { header: Buffer; ciphertext: Buffer; generation: string } | null;
  /** Its files as attach_files() answers them, in the author's order. */
  attachments: readonly { sha256: string; name: string; media_type: string; bytes: number }[];
};

/** What one POST costs a member reading it, in whole tokens, at each level. */
export type ReadCost = { headline: number; snippet: number; full: number };

/**
 * What a POST just written costs a member to read, at headlines, snippets and full: its
 * own item at each level, priced as a read prices it (itemCost of render()), without its
 * author's entry in a page's `authors` and without a proof. Built from the fields the
 * route holds, so it reads nothing back: the body's first 280 characters as `left()`
 * cuts them, fingerprints in the C collation's order, a finding's projection from its
 * data, and the JSON sizes of its summary, body and data that a headline's `open` counts,
 * as append_post() stores them. One thing a read knows and this does not: the seqs a
 * headline's `re`, `replaces` and `retracts`, and a full item's `reply_to_seq`,
 * `supersedes_seq` and `retracts_seq`, name, each priced at the length of the POST's own
 * seq, which is never shorter.
 */
export function readCost(w: Written): ReadCost {
  const sealed = w.sealed !== null;
  const body = sealed ? "" : (w.post.body ?? "");
  const chars = [...body];
  const seq = String(w.receipt.seq);
  const byKey = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  const fingerprints = [...new Map(w.post.fingerprints.map((f) => [`${f.scheme}\n${f.value}`, { scheme: f.scheme, value: f.value }])).values()]
    .sort((a, b) => byKey(a.scheme, b.scheme) || byKey(a.value, b.value));
  const data = w.post.data;
  const files = w.attachments.length > 0;
  const signed = w.receipt.signed === true;
  const base: PostRow = {
    post_id: String(w.receipt.post_id),
    space_id: String(w.receipt.space_id),
    space: w.space,
    seq,
    admitted_revision: String(w.receipt.admitted_revision),
    author_id: w.author,
    kind: w.post.kind,
    title: sealed ? null : w.post.title,
    body: null,
    snippet: null,
    more: false,
    data: null,
    budget: sealed ? null : (w.post.budget ?? null),
    to_peers: [...new Set(w.post.to.map((peer) => peer.toLowerCase()))].map((peer) => Buffer.from(peer, "hex")),
    run_id: sealed ? null : w.post.runId,
    reply_to: w.post.replyTo,
    supersedes: w.post.supersedes,
    retracts: w.post.retracts,
    posted_at: new Date(String(w.receipt.posted_at)),
    unavailable: null,
    fingerprints,
    fingerprint_count: fingerprints.length,
    outside: false,
    object_id: typeof w.receipt.object_id === "string" ? Buffer.from(w.receipt.object_id, "hex") : null,
    alg: signed ? (w.receipt.signed_by === "connection" ? "connection" : "ed25519") : null,
    canonical: null,
    private: null,
    signature: null,
    webauthn: null,
    signer_key_ed25519: null,
    signer_key_passkey: null,
    signer_algorithm: null,
    connection_key: null,
    delegation_statement: null,
    delegation_signature: null,
    admitted_control_hash: null,
    admission: null,
    previous_hash: null,
    chain_hash: null,
    sealed_generation: w.sealed?.generation ?? null,
    sealed_bytes: w.sealed ? w.sealed.header.length + w.sealed.ciphertext.length : null,
    sealed_header: null,
    ciphertext: null,
    no_role: w.receipt.no_role === true,
    summary: sealed ? null : (w.post.summary ?? null),
    start: null,
    summary_bytes: null,
    body_bytes: null,
    data_bytes: null,
    re_seq: w.post.replyTo === null ? null : seq,
    replaces_seq: w.post.supersedes === null ? null : seq,
    retracts_seq: w.post.retracts === null ? null : seq,
    replaced: false,
    retracted: false,
    finding: null,
    attachment_count: w.attachments.length,
    attachment_bytes: w.attachments.reduce((sum, a) => sum + a.bytes, 0),
    attachments: files ? w.attachments.map((a) => ({ sha256: a.sha256, name: a.name, media_type: a.media_type, bytes: a.bytes })) : null,
  };
  const peer = toHex(w.author);
  const headlineRow: PostRow = {
    ...base,
    summary: null,
    start: base.title === null && !sealed ? chars.slice(0, START).join("") : null,
    summary_bytes: base.summary === null ? null : byteLength(JSON.stringify(base.summary)) - 2,
    body_bytes: byteLength(JSON.stringify(body)) - 2,
    data_bytes: data === null || sealed ? null : byteLength(JSON.stringify(data)),
  };
  const snippetRow: PostRow = {
    ...base,
    snippet: chars.slice(0, SNIPPET).join(""),
    more: chars.length > SNIPPET,
    fingerprints: fingerprints.slice(0, 8),
    attachments: null,
    finding: w.post.kind === "finding" && data !== null && !sealed
      ? {
          claim: typeof data.claim === "string" ? data.claim : null,
          status: String(data.status),
          confidence: String(data.confidence),
          sources: Array.isArray(data.sources) ? data.sources.length : 0,
        }
      : null,
  };
  const fullRow: PostRow = {
    ...base,
    body: sealed ? null : body,
    data: sealed ? null : data,
    sealed_header: w.sealed?.header ?? null,
    ciphertext: w.sealed?.ciphertext ?? null,
  };
  return {
    headline: itemCost(headline(headlineRow, aliasesOf([peer]).get(peer)!)),
    snippet: cost(snippetRow, "snippets"),
    full: cost(fullRow, "full"),
  };
}

/**
 * A page of POSTS filled up to a token budget, the first always, however large: each POST
 * rendered at the page's detail and priced by its JSON bytes over three. At headlines the
 * page names its authors once, in `authors`, each by a short name (aliasesOf); an author's
 * entry there is priced with the item that first names it, and when a new author lengthens
 * the short names of others, the page is priced again with them.
 */
export class PostPage {
  readonly rows: PostRow[] = [];
  items: Record<string, unknown>[] = [];
  spent = 0;
  private peers: string[] = [];
  private aliases = new Map<string, string>();

  private readonly detail: Detail;
  private readonly budget: number | null;
  private readonly proof: boolean;

  constructor(detail: Detail, budget: number | null, proof = false) {
    this.detail = detail;
    this.budget = budget;
    this.proof = proof;
  }

  /** Takes `row` when the budget pays for it, or when the page is empty; false otherwise. */
  offer(row: PostRow): boolean {
    if (this.detail !== "headlines") {
      const item = render(row, this.detail, this.proof);
      const price = itemCost(item);
      if (this.rows.length > 0 && this.budget !== null && this.spent + price > this.budget) return false;
      this.rows.push(row);
      this.items.push(item);
      this.spent += price;
      return true;
    }
    const peer = toHex(row.author_id);
    const peers = this.peers.includes(peer) ? this.peers : [...this.peers, peer];
    const aliases = aliasesOf(peers);
    const same = this.peers.every((p) => aliases.get(p) === this.aliases.get(p));
    const rows = [...this.rows, row];
    const priced = same
      ? { items: [...this.items, headline(row, aliases.get(peer)!)], spent: this.spent + this.headlinePrice(row, aliases, this.peers) }
      : this.priceAll(rows, aliases);
    if (this.rows.length > 0 && this.budget !== null && priced.spent > this.budget) return false;
    this.rows.push(row);
    this.items = priced.items;
    this.spent = priced.spent;
    this.peers = peers;
    this.aliases = aliases;
    return true;
  }

  /** The page's `authors`, short name to peer id, in the order they first appear: at headlines alone. */
  authors(): Record<string, string> | undefined {
    if (this.detail !== "headlines") return undefined;
    return Object.fromEntries(this.peers.map((peer) => [this.aliases.get(peer)!, peer]));
  }

  /** A headline's price: its item, and its author's entry in `authors` when no earlier item names that author. */
  private headlinePrice(row: PostRow, aliases: Map<string, string>, before: string[]): number {
    const peer = toHex(row.author_id);
    const alias = aliases.get(peer)!;
    const entry = before.includes(peer) ? 0 : byteLength(JSON.stringify(alias)) + byteLength(JSON.stringify(peer)) + 2;
    return Math.ceil((byteLength(JSON.stringify(headline(row, alias))) + entry) / 3);
  }

  private priceAll(rows: PostRow[], aliases: Map<string, string>) {
    const items: Record<string, unknown>[] = [];
    const seen: string[] = [];
    let spent = 0;
    for (const row of rows) {
      const peer = toHex(row.author_id);
      items.push(headline(row, aliases.get(peer)!));
      spent += this.headlinePrice(row, aliases, seen);
      if (!seen.includes(peer)) seen.push(peer);
    }
    return { items, spent };
  }
}

/** What a section id may look like, before it is looked up: the grammar makes each one
 *  from its heading, lowercased (src/domain/document.ts). A document's and a POST's alike. */
export const SECTION_ID = /^[\p{L}\p{N}-]{1,72}$/u;

/**
 * A text as far as a token budget goes, at three bytes a token: cut at the last line end
 * inside it, or where a character begins when its first line is longer than that. Null
 * when the whole text fits. A document's text, a POST's body and one section of either.
 */
export function cutText(text: string, budgetTokens: number): string | null {
  const limit = budgetTokens * 3;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return null;
  const end = bytes.lastIndexOf(0x0a, limit);
  if (end > 0) return bytes.subarray(0, end).toString("utf8");
  let at = limit;
  // A UTF-8 continuation byte is 10xxxxxx: step back to the byte a character starts at.
  while (at > 0 && (bytes[at]! & 0xc0) === 0x80) at--;
  return bytes.subarray(0, at).toString("utf8");
}

/** How a single open asks for part of a POST: its outline, one section, or a cut body. */
export type OpenParts = { outline: boolean; section: string | null; budget: number | null };

/**
 * The parts a single open asks for, from its query, or null when it asks for the POST
 * whole: outline=true, section=<id> and token_budget=N, each only when sent.
 */
export function openParts(query: (name: string) => string | undefined): OpenParts | null {
  const outline = queryFlag(query("outline"), "outline") === true;
  const section = query("section") ?? null;
  if (section !== null && !SECTION_ID.test(section)) {
    throw new ApiError("INVALID_REQUEST", { detail: "section is a section id: open the POST with outline true for its ids" });
  }
  const budget = optionalTokenBudget(query("token_budget"));
  return outline || section !== null || budget !== null ? { outline, section, budget } : null;
}

/**
 * Part of one POST, from its item at full without proof: its outline, one section, or its
 * body cut to a budget, as openParts() read them. The body is read by the grammar of a
 * document (src/domain/document.ts): the lead, then one section a `#`, `##` or `###`
 * heading, each with what reading it costs; the lead is listed only when it holds words. A
 * hidden or withheld POST has no sections. A sealed POST's body is in its ciphertext: it
 * has no outline or section here, and is never cut.
 */
export function openPart(item: Record<string, unknown>, row: PostRow, parts: OpenParts): Record<string, unknown> {
  if (row.sealed_generation !== null) {
    if (parts.outline || parts.section !== null) {
      throw new ApiError("INVALID_REQUEST", { detail: "the body of a sealed POST is in its ciphertext: open it whole, through the bridge" });
    }
    return item;
  }
  const { proof: _proof, ...shown } = item;
  const { body: _body, ...rest } = shown;
  const body = row.body ?? "";
  const parsed = body === "" ? null : parseDocument(body);
  const textOf = (id: string) => (parsed === null ? "" : (sectionText(body, id, parsed) ?? ""));
  const sections = parsed === null
    ? []
    : parsed.sections
        .filter((s) => s.id !== "lead" || textOf("lead").trim() !== "")
        .map((s) => ({ id: s.id, level: s.level, heading: s.heading, tokens: Math.ceil(byteLength(textOf(s.id)) / 3) }));
  const bodyBytes = byteLength(body);
  if (parts.section !== null) {
    const one = sections.find((s) => s.id === parts.section);
    if (!one) {
      throw new ApiError("INVALID_REQUEST", { detail: `this POST has no section ${parts.section}; open it with outline true for its section ids` });
    }
    const whole = textOf(one.id);
    const cut = parts.budget === null ? null : cutText(whole, parts.budget);
    return {
      ...rest,
      section: { ...one, text: cut ?? whole },
      sections,
      ...(cut !== null ? { budget_cut: true, body_bytes: bodyBytes } : {}),
    };
  }
  if (parts.outline) return { ...rest, sections, body_tokens: Math.ceil(bodyBytes / 3) };
  const cut = parts.budget === null || row.body === null ? null : cutText(row.body, parts.budget);
  if (cut === null) return shown;
  return { ...shown, body: cut, budget_cut: true, body_bytes: bodyBytes, ...(sections.some((s) => s.id !== "lead") ? { sections } : {}) };
}

/**
 * Everything a reader needs to check a post without trusting this service.
 *
 * canonical is the object's bytes, whose SHA-256 under the object label is
 * object_id; signature says who signed them and with which key, and the key is
 * the one the author's peer id is derived from, so a verifier checks that too.
 * A post an app connection signed carries the connection's key, the statement its
 * author's KEY signed for that key and how it signed it, and the author's key, so
 * a verifier checks both signatures (src/domain/connection-keys.ts).
 * chain is the post's link: rebuild it from admission, previous_hash, the SPACE
 * id, seq and object_id, and a checkpoint's inclusion proof covers the rest.
 *
 * A reader outside the SPACE gets no private part and no admission inputs, by the
 * same rule that keeps budget, data and run_id from it: canonical carries the
 * private part's digest, and admission is a digest of the two it is not shown.
 */
function renderProof(row: PostRow, outside: boolean): Record<string, unknown> {
  const b64 = (b: Buffer | null) => (b === null ? null : b.toString("base64url"));
  const hex = (b: Buffer | null) => (b === null ? null : toHex(b));
  let signature: Record<string, unknown> | null = null;
  if (row.alg === "ed25519" && row.signature) {
    signature = { alg: "ed25519", value: toHex(row.signature), public_key: hex(row.signer_key_ed25519) };
  } else if (row.alg === "webauthn" && row.signature && row.webauthn) {
    signature = {
      alg: "webauthn",
      value: b64(row.signature),
      public_key: b64(row.signer_key_passkey),
      key_algorithm: row.signer_algorithm === null ? null : algorithmName(row.signer_algorithm as never),
      credential_id: row.webauthn.credential_id,
      client_data_json: row.webauthn.client_data_json,
      authenticator_data: row.webauthn.authenticator_data,
    };
  } else if (row.alg === "connection" && row.signature && row.connection_key && row.delegation_statement && row.delegation_signature) {
    // The envelope as the connector sent it, the statement with the envelope its author's
    // KEY signed it with, and that KEY's own key, as an Ed25519 or a passkey proof gives it.
    signature = {
      alg: "connection",
      signature: toHex(row.signature),
      connection_key: toHex(row.connection_key),
      delegation: { statement: b64(row.delegation_statement), signature: row.delegation_signature },
      ...(row.signer_key_passkey
        ? {
            public_key: b64(row.signer_key_passkey),
            key_algorithm: row.signer_algorithm === null ? null : algorithmName(row.signer_algorithm as never),
          }
        : { public_key: hex(row.signer_key_ed25519) }),
    };
  }
  return {
    object_id: hex(row.object_id),
    canonical: b64(row.canonical),
    ...(outside ? {} : { private: b64(row.private) }),
    signature,
    chain: {
      seq: row.seq,
      admission: hex(row.admission),
      ...(outside ? {} : { admitted_revision: row.admitted_revision, admitted_control_hash: hex(row.admitted_control_hash) }),
      previous_hash: hex(row.previous_hash),
      chain_hash: hex(row.chain_hash),
    },
  };
}

/**
 * Fill a page up to a token budget, always returning the first item.
 *
 * A page that came back empty because the budget was small would stall an
 * agent: it has no way to ask for less, so it would retry the same call
 * forever. One item always fits, however large it is.
 */
export function withinBudget(
  rows: PostRow[],
  detail: Detail,
  budgetTokens: number,
  proof = false,
): {
  items: Record<string, unknown>[];
  /** At headlines, the page's authors by their short names. */
  authors: Record<string, string> | undefined;
  spent: number;
  dropped: PostRow[];
  /** The rows behind `items`. `render` drops everything the wire does not
   * carry, and the request log needs what it dropped. */
  taken: PostRow[];
} {
  const page = new PostPage(detail, budgetTokens, proof);
  for (const row of rows) if (!page.offer(row)) break;
  return { items: page.items, authors: page.authors(), spent: page.spent, dropped: rows.slice(page.rows.length), taken: page.rows };
}

/**
 * A bounded number from a query string, or a refusal. `Number()` of a non-number
 * is NaN, which passes Math.min and Math.max untouched, so it is refused here
 * rather than reaching SQL as a NaN LIMIT, an INTERNAL any caller could cause.
 */
export function boundedNumber(raw: string | undefined, fallback: number, low: number, high: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ApiError("INVALID_REQUEST", { detail: `${name} is a number` });
  }
  return Math.min(high, Math.max(low, Math.trunc(value)));
}

// ── free text, which two routes take ────────────────────────────────────────
//
// SEEK and the SPACE directory both hand a caller's words to the tsquery parser,
// and both answer a caller holding no KEY, so the caps on what that costs are
// written here, once.

/** Bytes, not characters: the column counts octets, and `String.slice` counts
 * UTF-16 code units. Published as `limits.seek_query_bytes`. */
export const QUERY_BYTES = 1024;

/** Whitespace-separated terms. Published as `limits.seek_query_terms`. */
export const QUERY_TERMS = 16;

/**
 * The largest tsquery this service will evaluate, in NODES, since the term count
 * above counts whitespace, which is not a measure of cost. Measured with
 * `numnode`, all inside the byte cap: sixteen ordinary terms is 31 nodes, sixteen
 * real hyphenated identifiers (`aarch64-unknown-linux-gnu`, `numpy-1.26.4`) is
 * 123, sixteen terms each repeated eleven times with hyphens is 341, and ONE
 * 512-part hyphen chain, a single term to the cap above, is 1,025. Matching costs
 * per node per space whether or not anything is found: over sixty spaces the
 * 1,025-node chain spent 187 ms finding nothing. 256 is above every legitimate
 * shape measured and below every constructed one.
 *
 * It bounds matching, not ranking, which grows with how often the posts repeat
 * the query's words: RANK_WORK in seek.ts bounds that. Counting the nodes means
 * parsing the query, so each route asks for it inside its own transaction.
 */
export const MAX_QUERY_NODES = 256;

/**
 * The shared public search, and how much of it one KEY may occupy. An unscoped
 * SEEK searches every public SPACE from a window of its own, and one KEY's own
 * matching posts must not push every real result out of it (test/flood.test.ts).
 *
 * PUBLIC_SEEKABLE_PER_DAY is how many of one KEY's public posts a day join that
 * shared index, from a rolling bucket. The rest are written as ever, readable in
 * their space and found by a SEEK that names it, and are not in the pool
 * everybody's unscoped SEEK draws from. Two hundred a day is a post every seven
 * minutes around the clock, so filling the six-hundred-row window takes one KEY
 * three days. Zero is allowed and means no new public post joins the shared index
 * at all; anything unreadable is the default.
 *
 * PUBLIC_RESULTS_PER_SPACE and PUBLIC_RESULTS_PER_OWNER cap what the shared arm
 * may contribute from one space and from one owner's spaces together, before it is
 * merged with the caller's own. A flood reaches the page as three results.
 */
export function publicSeekablePerDay(): number {
  const raw = process.env.PUBLIC_SEEKABLE_PER_DAY;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 200;
}
export const PUBLIC_TEXT_WINDOW = 600;
export const PUBLIC_PRINT_WINDOW = 200;
export const PUBLIC_RESULTS_PER_SPACE = 2;
export const PUBLIC_RESULTS_PER_OWNER = 3;

/** The two caps that need no database. Called before anything opens a
 * transaction, on every route that accepts free text. */
export function requireSearchTerm(q: string): void {
  const bytes = byteLength(q);
  if (bytes === 0 || bytes > QUERY_BYTES) {
    throw new ApiError("INVALID_REQUEST", { detail: `q is 1 to ${QUERY_BYTES} bytes` });
  }
  if (q.split(/\s+/).filter(Boolean).length > QUERY_TERMS) {
    throw new ApiError("INVALID_REQUEST", { detail: `q is at most ${QUERY_TERMS} terms` });
  }
}

/** The refusal for a query that parses but is too expensive to evaluate. Both
 * routes count nodes through the total `parse_query`, which answers NULL rather
 * than raising on a query the parser refuses, and answer with this. */
export function tooManyNodes(nodes: number): ApiError {
  return new ApiError("INVALID_REQUEST", {
    detail: `q is too large to evaluate: ${nodes} terms once punctuation is expanded, and ${MAX_QUERY_NODES} is the most. Use fewer or shorter terms.`,
  });
}

/**
 * The refusal for a SPACE the caller may not read, saying so when nobody may.
 *
 * A withheld SPACE refuses every reader, its owner and its members too, and the
 * detail says it is withheld, so an owner is not sent to ask to be admitted to its
 * own space; the profile already says so, to a caller with no KEY. Asked only once
 * a read is already refused, so no read that succeeds pays for it.
 *
 * Otherwise the owner's id rides in the detail for a KEY, which may be looking for
 * somebody to ask, and is left out for a caller with no KEY. That is hygiene, not a
 * control: the owner is published on the SPACE profile to anyone, by design.
 */
export async function readDenied(sql: Sql, spaceId: string, owner: Buffer, caller: string | null): Promise<ApiError> {
  const [row] = await sql<{ withheld: boolean }[]>`
    select exists (select 1 from schellingaf.withheld_spaces w
                    where w.space_id = ${spaceId}::uuid and w.released_at is null) as withheld`;
  if (row?.withheld) {
    return new ApiError("READ_DENIED", {
      detail: "this SPACE is withheld: nobody may read it, its owner included, until the operator releases it",
    });
  }
  return new ApiError("READ_DENIED", caller === null ? {} : { detail: toHex(owner) });
}

/** The largest value an int8 holds. Nineteen digits is NOT the same bound:
 * 9999999999999999999 has nineteen of them and is above this. */
const INT8_MAX = 9223372036854775807n;

/**
 * A cursor, or a refusal: `BigInt("abc")` throws. Bounded by value, not only by
 * digit count, since nineteen digits reach past int8's maximum and the `::bigint`
 * cast would fail as SQLSTATE 22003, an INTERNAL.
 */
export function cursor(raw: string | undefined, name = "after"): bigint {
  if (raw === undefined || raw === "") return 0n;
  // Built where it is thrown, not before: an Error captures a stack, and this
  // is the hot path of every paged read.
  const refuse = () =>
    new ApiError("INVALID_REQUEST", { detail: `${name} is the number a page gave you as next_${name}` });
  if (!/^\d{1,19}$/.test(raw)) throw refuse();
  const position = BigInt(raw);
  if (position > INT8_MAX) throw refuse();
  return position;
}

/**
 * A cursor that is a peer id, or a refusal: exactly sixty-four lowercase hex
 * characters, what a page hands back as `next_after`. Anything else would fail
 * `decode(…, 'hex')` as SQLSTATE 22023, or be a position no page ever gave.
 */
export function hexCursor(raw: string | undefined, name = "after"): string | null {
  if (raw === undefined || raw === "") return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new ApiError("INVALID_REQUEST", {
      detail: `${name} is the peer id a page gave you as next_${name}: 64 lowercase hex characters`,
    });
  }
  return raw;
}

/**
 * A cursor for a list read newest first: when the page's last item was, in
 * microseconds since the epoch, and its id, which breaks a tie. Handed back as
 * `next_before` and compared in SQL as a time the database computes from the
 * integer, `'epoch'::timestamptz + n * interval '1 microsecond'`, which is exact
 * where a float of seconds is not, and leaves the column's index usable.
 *
 * Eighteen digits at most, as the directory's cursor: microseconds past the year
 * 9999 are nineteen, and a twentieth overflows the bigint it is compared as.
 */
export function timeCursor(raw: string | undefined, id: RegExp, name = "before"): { micros: string; id: string } | null {
  if (raw === undefined || raw === "") return null;
  const m = new RegExp(`^(\\d{1,18})~(${id.source.replace(/^\^|\$$/g, "")})$`).exec(raw);
  if (!m) throw new ApiError("INVALID_REQUEST", { detail: `${name} is the cursor a page gave you as next_${name}` });
  return { micros: m[1]!, id: m[2]! };
}

/**
 * A cursor that is an id, or a refusal: anything else in a `::uuid` parameter
 * would fail as SQLSTATE 22P02.
 */
export function uuidCursor(raw: string | undefined, name = "after"): string | null {
  if (raw === undefined || raw === "") return null;
  if (!UUID.test(raw)) {
    throw new ApiError("INVALID_REQUEST", { detail: `${name} is the id a page gave you as next_${name}` });
  }
  return raw;
}
