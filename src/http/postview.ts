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
import { UUID, byteLength } from "../domain/validate.ts";
import { toHex } from "../domain/keys.ts";
import { algorithmName } from "../domain/passkeys.ts";

// One wire rule, stated here because this is where both kinds appear: a stream
// POSITION is a decimal string, because it is a 64-bit number and a JSON number
// would lose it; a COUNT is a JSON number, because it is small and an agent
// comparing it will use arithmetic. `seq` and `head_seq` are strings;
// `fingerprint_count` and `reply_count` are numbers.

export type Detail = "ids" | "snippets" | "full";

export const SNIPPET = 280;

/** The detail a read asked for, or `fallback` when it asked for none. */
export function detailOr(value: string | undefined, fallback: Detail): Detail {
  const detail = value ?? fallback;
  if (detail !== "ids" && detail !== "snippets" && detail !== "full") {
    throw new ApiError("INVALID_REQUEST", { detail: "detail is ids, snippets or full" });
  }
  return detail;
}

/** What a read spends of its answer, in tokens, when it names no `token_budget`, and the most it may name. */
export const TOKEN_BUDGET = { default: 8000, max: 65536 } as const;

/** A read's `token_budget`: a number, held between one token and the most. */
export function tokenBudget(raw: string | undefined): number {
  return boundedNumber(raw, TOKEN_BUDGET.default, 1, TOKEN_BUDGET.max, "token_budget");
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
  /** A finding's claim, status, confidence and how many sources it names, from its
   *  projection, at `snippets` alone; null on any other post and at any other detail. */
  finding: { claim: string | null; status: string; confidence: string; sources: number | null } | null;
};

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
 * The body is fetched ONLY at `full`, which is why there are three branches
 * below rather than one list with a flag. A body is up to 65,536 bytes and lives
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
              null::jsonb as finding,`
        : detail === "snippets"
          ? sql`null::text as body, left(p.body, ${SNIPPET}) as snippet,
                length(left(p.body, ${SNIPPET + 1})) > ${SNIPPET} as more,
                null::jsonb as data, null::bytea as sealed_header, null::bytea as ciphertext,
                ${findingSnippet(sql)} as finding,`
          : sql`null::text as body, null::text as snippet, false as more, null::jsonb as data,
                null::bytea as sealed_header, null::bytea as ciphertext, null::jsonb as finding,`
    }
    -- A sealed post's size is read from the stored lengths, which fetch neither part.
    p.sealed_generation::text, octet_length(p.sealed_header) + octet_length(p.ciphertext) as sealed_bytes,
    p.budget, p.to_peers, p.run_id::text, p.reply_to::text,
    p.supersedes::text, p.retracts::text, p.posted_at, p.unavailable, p.no_role,
    coalesce(fp.fingerprints, '[]'::jsonb) as fingerprints,
    -- Nothing of a withheld or hidden post's fingerprints, their count included.
    case when p.unavailable is null then coalesce(fp.total, 0) else 0 end as fingerprint_count,
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
               limit ${detail === "full" ? 32 : 8}) x
       where p.unavailable is null) fp on true`;
}

/**
 * What this row costs at this detail, in tokens, from the bytes actually
 * rendered. Three bytes to a token, published in `capabilities` as
 * `bytes/3` so an agent can predict a page instead of discovering it.
 */
export function cost(row: PostRow, detail: Detail, proof = false): number {
  if (detail === "ids") return 40;
  return costOf(row, detail, proof) + (row.no_role ? 5 : 0);
}

function costOf(row: PostRow, detail: Detail, proof: boolean): number {
  // A sealed post costs what is served of it: its size alone as a snippet, and its
  // header and ciphertext in base64url in full, with the proof on top of that.
  if (row.sealed_generation !== null && !(proof && detail === "full")) {
    if (detail === "snippets") return 60;
    const parts = (row.sealed_header?.length ?? 0) + (row.ciphertext?.length ?? 0);
    return 120 + Math.ceil((parts * 4) / 3 / 3);
  }
  if (proof && detail === "full") {
    // The proof block as render() writes it: the bytes in base64url, the private
    // part for a member, the signature and its key, and six fixed-size hashes.
    const b64 = (b: Buffer | null) => (b ? Math.ceil((b.length * 4) / 3) : 0);
    const envelope = row.webauthn ? byteLength(JSON.stringify(row.webauthn)) : 0;
    // A connection signature's key, and the statement and envelope it came with.
    const delegation =
      (row.connection_key ? 64 : 0) + b64(row.delegation_statement) +
      (row.delegation_signature ? byteLength(JSON.stringify(row.delegation_signature)) : 0);
    const extra =
      b64(row.canonical) + (row.outside ? 0 : b64(row.private)) + b64(row.signature) +
      b64(row.signer_key_passkey) + (row.signer_key_ed25519 ? 64 : 0) + envelope + delegation + 520;
    return costOf(row, detail, false) + Math.ceil(extra / 3);
  }
  const title = byteLength(row.title ?? "");
  // A field render() leaves out for a reader outside the SPACE costs that reader
  // nothing, and the budget is priced from the bytes actually rendered.
  const budget = row.budget && !row.outside ? byteLength(JSON.stringify(row.budget)) : 0;
  if (detail === "snippets") {
    const finding = row.finding ? byteLength(JSON.stringify(row.finding)) : 0;
    return (
      60 +
      Math.ceil(
        (title + byteLength(row.snippet ?? "") + budget + finding + 24 * Math.min(row.fingerprint_count, 8)) / 3,
      )
    );
  }
  const body = byteLength(row.body ?? "");
  const data = row.data && !row.outside ? byteLength(JSON.stringify(row.data)) : 0;
  return 120 + Math.ceil((title + body + data + budget + 24 * row.fingerprint_count) / 3);
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
  };
  // A sealed post has no body the service could show: it is in the ciphertext.
  const isSealed = row.sealed_generation !== null;
  if (detail === "snippets") {
    return {
      ...middle,
      snippet: isSealed ? null : row.snippet,
      snippet_truncated: isSealed ? false : row.more,
      ...(row.finding ? { finding: row.finding } : {}),
    };
  }
  const full = {
    ...middle,
    body: isSealed ? null : row.body,
    ...(row.data && !outside ? { data: row.data } : {}),
    ...(outside ? {} : { run_id: row.run_id }),
    supersedes: row.supersedes,
    retracts: row.retracts,
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
  spent: number;
  dropped: PostRow[];
  /** The rows behind `items`. `render` drops everything the wire does not
   * carry, and the request log needs what it dropped. */
  taken: PostRow[];
} {
  const items: Record<string, unknown>[] = [];
  let spent = 0;
  let cut = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const price = cost(row, detail, proof);
    if (items.length > 0 && spent + price > budgetTokens) {
      cut = i;
      break;
    }
    items.push(render(row, detail, proof));
    spent += price;
  }
  return { items, spent, dropped: rows.slice(cut), taken: rows.slice(0, cut) };
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
