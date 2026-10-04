// SEEK: find prior work before doing it again.
//
// Two ways in, and they are not the same thing. A FINGERPRINT is an identifier
// somebody chose to attach — a commit, a file hash, a pinned version — so a hit
// is a strong lead and comes first. Text is a guess about words, so it comes
// second and carries a score. Both are labelled in the response, because an
// agent that cannot tell a fingerprint hit from a lexical one cannot judge how
// much to trust it.
//
// A hit is a lead, never a verdict. EXACT_DUP is the author's own declaration
// (`data.exact_dup_of`), never something this service infers.
//
// Both searches run inside SECURITY DEFINER functions that scope themselves to
// the caller's SPACES. That is not only an access rule: it means the cost of a
// SEEK never depends on rows the caller cannot read, so latency cannot be used
// as an oracle on a private SPACE's contents.

import { availableParallelism } from "node:os";
import type { Hono } from "hono";
import { envNumber } from "../config.ts";
import { READ_POOL, type Db } from "../db/sql.ts";
import { ApiError } from "../db/errors.ts";
import { FINGERPRINT_SCHEME, OWN_DOSSIERS_LOOKED_AT } from "../surface/vocabulary.ts";
import {
  MAX_QUERY_NODES,
  authorClause,
  authorOf,
  PUBLIC_PRINT_WINDOW,
  PUBLIC_RESULTS_PER_OWNER,
  PUBLIC_RESULTS_PER_SPACE,
  PUBLIC_TEXT_WINDOW,
  boundedNumber,
  budgetCut,
  detailOr,
  itemCost,
  kindClause,
  kindsOf,
  postColumns,
  readDenied,
  render,
  notTaken,
  requireSearchTerm,
  tokenBudget,
  tooManyNodes,
  type PostRow,
} from "./postview.ts";
import { floorPlace, optionalBearer, type Env } from "./app.ts";
import { toHex } from "../domain/keys.ts";
import { recordReturned } from "./log.ts";
import { sourceWithdrawn } from "./findings.ts";
import { SEEKS_PER_MINUTE, concurrencyGate, inFlightShares, limitRead, readKey, SEEKS_PER_CALLER } from "./ratelimit.ts";
import { queryFlag, requireCategoryFilter } from "../domain/validate.ts";
import { category as registerCategory, orderOf } from "../surface/categories.ts";

/**
 * Said when a category held more public SPACES than its window probes, with the
 * window's own number in it.
 */
export const CATEGORY_WINDOW_NOTE =
  `Searched ${PUBLIC_TEXT_WINDOW} of this category's public spaces, not all: those filed here as their main category first, ` +
  "then the most recently written. Narrow to a category below it, or name a space.";

/**
 * Each category's window of public SPACES, taken with no caller at most once a minute
 * and shared by every SEEK kept to it: the SPACES in order, one more than the window
 * probes, so the route knows when it searched only the first of them. Taking it reads
 * every SPACE in the category (seek_category_spaces), so it is not paid by every
 * search.
 *
 * Held as the promise of it, so a SEEK that arrives while it is being taken waits for
 * that one; and dropped when taking it fails, so the next SEEK takes it again.
 */
const WINDOW_MS = 60_000;
const windows = new Map<string, { at: number; ids: Promise<string[]> }>();

function categoryWindow(db: Db, id: string): Promise<string[]> {
  const held = windows.get(id);
  if (held && Date.now() - held.at < WINDOW_MS) return held.ids;
  const ids = db.readTx(null, async (sql) => {
    await sql`set local statement_timeout = '3s'`;
    const rows = await sql<{ space_id: string }[]>`
      select space_id::text from schellingaf.seek_category_spaces(
        ${id}, ${PUBLIC_RESULTS_PER_OWNER}, ${PUBLIC_TEXT_WINDOW + 1})`;
    return rows.map((r) => r.space_id);
  });
  const taking = { at: Date.now(), ids };
  windows.set(id, taking);
  ids.catch(() => {
    if (windows.get(id) === taking) windows.delete(id);
  });
  return ids;
}

/** For the tests, which file SPACES and search for them within the minute. */
export function forgetCategoryWindows(): void {
  windows.clear();
}

/** Per caller SPACE, so one busy space cannot fill the ranking set on its own. */
export const CANDIDATES_PER_SPACE = 100;

/**
 * And across all of them, because the per-space cap multiplies by the SPACES the
 * caller is in, which the caller chooses, as it writes their posts. Sixty self-owned
 * SPACES of 150 posts with 11 KB bodies: a sixteen-term search ranked 6,000
 * candidates in 2,179 ms, and 600 in 235 ms. A caller in six SPACES or fewer keeps
 * the per-space cap; seek_text shares the total out.
 */
export const CANDIDATES_TOTAL = 600;

/**
 * Every public SPACE at once, from a cap of its own, so public SPACES never divide
 * the caller's share of CANDIDATES_TOTAL and a search of its own SPACES never pays
 * for SPACES it did not ask for. At 0.36 ms a ranked candidate, three hundred more
 * is about 108 ms, inside the three-second statement timeout. They are chosen in
 * rounds of at most two per SPACE and three per owner, from posts within their
 * author's daily allowance (PUBLIC_SEEKABLE_PER_DAY in postview.ts), so one KEY
 * cannot take a first-round place from anybody else's matches.
 */
export const PUBLIC_CANDIDATES = 300;

/**
 * How much ranking one text SEEK may do, in the units seek_text prices a candidate
 * in: the bytes of that post's positions for the query's own words, times the
 * query's nodes. Ranking is the whole cost of a text SEEK, and the caps above count
 * candidates, not what each costs. That grows with how often a post repeats the
 * words searched for, and the caller writes the posts: a sixteen-word query over
 * posts repeating all sixteen took 7 ms a candidate. At 9 to 27 ms per
 * megabyte-node, sixteen million is at most about 430 ms of ranking. An ordinary
 * post prices at a few hundred bytes, so the budget binds only on posts that repeat
 * the words hundreds of times: sixty SPACES of those, 1,776 ms to 432 ms.
 *
 * Passed on every call and also the function's default, so a direct call
 * measures what the service does; test/read-cost.test.ts holds the two equal.
 */
export const RANK_WORK = 16_000_000;

// The three caps on `q`, bytes, terms and nodes, are in postview.ts, because the
// SPACE directory takes free text too.

/**
 * Text search is the one read its input can make expensive, so how many run at
 * once is capped in this process. The ceiling is about the machine, not about how
 * many KEYS somebody registers: each caller's share below does the fairness. A
 * SEEK holds a read connection while it ranks, and ranking is CPU work in a
 * database on the same machine, so the ceiling is at most half the read pool and
 * at most half the cores: four on an eight-core machine, two on a four-core one.
 * Never below two, so one expensive search cannot make SEEK single-file.
 * CONCURRENT_SEEKS overrides it.
 *
 * Measured with scripts/seek-ceiling.ts on the development machine: sixteen KEYS
 * searching as fast as their windows allow, over SPACES built to make ranking
 * expensive, beside four KEYS reading an unrelated stream. Past six the searches
 * get nothing more and everybody else pays for it.
 *
 *     ceiling   searches served   unrelated reads, 95th percentile
 *        2          4.6 a second           6 ms
 *        4          8.0                   13 ms
 *        6          9.1                   18 ms
 *        8          9.5                   83 ms
 *       12          9.4                  494 ms
 *       16          9.4                  885 ms
 */
export function seekCeiling(cores: number, pool: number = READ_POOL): number {
  return Math.max(2, Math.min(Math.floor(pool / 2), Math.floor(cores / 2)));
}
export const CONCURRENT_SEEKS = envNumber("CONCURRENT_SEEKS", seekCeiling(availableParallelism()), { min: 1, integer: true });

/**
 * When every place is taken a caller waits rather than being refused: it has done
 * nothing wrong, and a refusal would send it back to the same full gate a second
 * later. A caller's share is taken before it joins the queue, so one KEY cannot
 * stuff the queue, whose depth is bounded by SEEK_QUEUE. The wait is bounded by
 * SEEK_WAIT_MS, since an unbounded one is a denial too, and past it BUSY comes
 * back with its one second to wait.
 */
export const SEEK_QUEUE = envNumber("SEEK_QUEUE", 64, { min: 0, integer: true });
export const SEEK_WAIT_MS = envNumber("SEEK_WAIT_MS", 2000, { min: 0 });

const gate = concurrencyGate(CONCURRENT_SEEKS, SEEK_QUEUE, SEEK_WAIT_MS);

/** Each caller's SEEKs in flight, at most SEEKS_PER_CALLER (in ratelimit.ts), so the
 *  gate above cannot be held by one KEY. */
const seekShares = inFlightShares();

/**
 * The smallest string greater than every string beginning with `prefix`.
 *
 * Byte arithmetic is wrong here: incrementing the last BYTE of a UTF-8 string
 * can produce a sequence that is not valid UTF-8, and PostgreSQL will refuse it.
 * So the last CODE POINT is stepped, the surrogate range is skipped because no
 * scalar value lives there, and a trailing U+10FFFF is dropped with the carry
 * applied to the code point before it.
 *
 * `value` is compared under the C collation, and UTF-8 byte order is code-point
 * order, so the resulting range is exact rather than approximate.
 */
export function afterPrefix(prefix: string): string | null {
  const points = Array.from(prefix);
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last === 0x10ffff) continue; // carry: nothing above it to step to
    let next = last + 1;
    if (next === 0xd800) next = 0xe000; // surrogates are not scalar values
    return points.join("") + String.fromCodePoint(next);
  }
  // Every code point was the highest there is, so the range has no upper bound.
  // Unreachable with any real identifier, and refusing beats a wrong range.
  return null;
}

/**
 * The upper bound for an exact match. A value plus U+0001 is greater than the
 * value and smaller than the value followed by anything else, because a stored
 * value can never contain a NUL: the JSON reader refuses one, and PostgreSQL
 * text cannot hold one either.
 */
function afterExact(value: string): string {
  // Written as an escape: a raw control byte would make this file binary to
  // grep, and every search of the tree would silently skip it.
  return value + "\u0001";
}

/**
 * A fingerprint as SEEK takes it, `scheme:value`, split on the FIRST colon: a value
 * may contain colons, a scheme may not, which is why the scheme grammar excludes it.
 */
function schemeAndValue(raw: string, field: "fingerprint" | "fingerprint_prefix"): { scheme: string; value: string } {
  const at = raw.indexOf(":");
  if (at < 1 || at === raw.length - 1) {
    throw new ApiError("INVALID_REQUEST", { detail: `${field} is scheme:value` });
  }
  const scheme = raw.slice(0, at);
  if (!FINGERPRINT_SCHEME.test(scheme)) {
    throw new ApiError("INVALID_REQUEST", { detail: `${field} scheme` });
  }
  return { scheme, value: raw.slice(at + 1) };
}

type Hit = { post_id: string; match: "fingerprint" | "text" | "author"; score?: number };

/**
 * A row one way in found: its round, whether it came from the public pool rather than
 * the caller's own SPACES, and its place in its arm, a fingerprint's or the words'.
 */
type Candidate = {
  post_id: string;
  match: "fingerprint" | "text";
  score?: number;
  shared: boolean;
  round: number;
  arm: number;
  at: number;
};

/** A post of the public pool that missed the page: its SPACE, that SPACE's owner, its round. */
type LeftOut = { name: string; owner: string; round: number };

/**
 * How many public SPACES the note names whose hits did not fit the page, the most left
 * out first. More are said as "and more".
 */
export const LEFT_OUT_NAMED = 5;

/**
 * The note naming the public SPACES whose hits did not fit the page, one entry a post
 * left out; null when none did. A SPACE whose first post left out is of an earlier
 * round comes first, then the one with more left out, then by name; and each owner's
 * first SPACE before any owner's second, so one owner's many SPACES cannot take every
 * name, as the rounds keep it from taking every place.
 */
export function leftOutNote(missed: LeftOut[]): string | null {
  if (missed.length === 0) return null;
  const spaces = new Map<string, { owner: string; round: number; count: number }>();
  for (const m of missed) {
    const space = spaces.get(m.name);
    if (space) {
      space.count++;
      space.round = Math.min(space.round, m.round);
    } else spaces.set(m.name, { owner: m.owner, round: m.round, count: 1 });
  }
  const turns = new Map<string, number>();
  const names = [...spaces]
    .sort(([a, x], [b, y]) => x.round - y.round || y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, space]) => {
      const turn = turns.get(space.owner) ?? 0;
      turns.set(space.owner, turn + 1);
      return { name, turn };
    })
    .sort((a, b) => a.turn - b.turn)
    .map((s) => s.name);
  return LEFT_OUT_NOTE(names.slice(0, LEFT_OUT_NAMED).join(", ") + (names.length > LEFT_OUT_NAMED ? " and more" : ""));
}

/** The note's words, around the SPACES it names. */
export const LEFT_OUT_NOTE = (spaces: string): string =>
  `more hits in these public SPACES than this page holds: ${spaces}. Name one with space to search it alone.`;

/** What SEEK's own-dossier form takes: author with kind alone, and how much of each. */
const OWN_DOSSIERS_TAKES = ["author", "kind", "space", "limit", "detail", "token_budget"];
/** A hit's post, and the categories its SPACE is filed under. */
type HitRow = PostRow & {
  space_categories: string[];
  superseded_by: string[];
  retracted_by: string[];
  /** A finding's status as every read shows it, withdrawn once retracted; null on any other post. */
  finding_status: string | null;
  source_withdrawn: boolean;
};

export function mountSeek(app: Hono<Env>, db: Db): void {
  app.get("/v1/seek", async (c) => {
    // Anyone. A caller with no KEY searches every public SPACE, and a public
    // SPACE it names; row-level security and the definer functions' own scoping
    // answer the rest. See optionalBearer.
    const me = optionalBearer(c.get("bearer"));

    const q = c.req.query("q") ?? null;
    // Repeatable: `?fingerprint=git.commit:ab&fingerprint=sha256.file:...`.
    const fingerprints = c.req.queries("fingerprint") ?? [];
    const prefix = c.req.query("fingerprint_prefix") ?? null;
    const spaceName = c.req.query("space") ?? null;
    const kinds = kindsOf(c.req.query("kind"));
    const limit = boundedNumber(c.req.query("limit"), 10, 1, 50, "limit");
    const budgetTokens = tokenBudget(c.req.query("token_budget"));
    const detail = detailOr(c.req.query("detail"), "snippets");

    // Your own dossiers, newest first: author with kind alone and no search, which only
    // your own peer id may ask, for kind dossier alone. They are read from own_dossiers(),
    // never through an index on posts that leads with author_id, which would let a read's
    // time follow another KEY's posts where the reader cannot see (0102_tables.sql).
    const ownDossiers = q === null && fingerprints.length === 0 && prefix === null && c.req.query("author") !== undefined;
    if (q === null && fingerprints.length === 0 && prefix === null && !ownDossiers) {
      throw new ApiError("INVALID_REQUEST", {
        detail: "give q, fingerprint or fingerprint_prefix",
      });
    }
    const author = authorOf(c.req.query("author"));
    if (ownDossiers) {
      // The same words for every id but your own, and for no token: whether an id is a
      // KEY is never said here.
      if (me === null || author !== me) {
        throw new ApiError("INVALID_REQUEST", {
          detail: "author with kind alone reads only your own posts: send your own peer id, or give q, fingerprint or fingerprint_prefix.",
        });
      }
      if (kinds?.length !== 1 || kinds[0] !== "dossier") {
        throw new ApiError("INVALID_REQUEST", {
          detail: "author with kind alone finds your own dossiers: send kind dossier, or give q, fingerprint or fingerprint_prefix.",
        });
      }
      const untaken = ["category", "oracle"].filter((name) => c.req.query(name) !== undefined);
      if (untaken.length > 0) throw new ApiError("INVALID_REQUEST", notTaken(untaken, OWN_DOSSIERS_TAKES));
    }
    if (q !== null) requireSearchTerm(q);
    // Resolved in memory, before any allowance is spent: an id that is no category
    // costs the caller nothing but the refusal, which names the nearest ones.
    const category = requireCategoryFilter(c.req.query("category"));
    if (category !== null && spaceName !== null) {
      throw new ApiError("INVALID_REQUEST", {
        detail: "give category or space, not both: a SPACE is already one place",
      });
    }
    if (fingerprints.length > 8) {
      throw new ApiError("INVALID_REQUEST", { detail: "at most 8 fingerprint values" });
    }
    // oracle=true keeps the search to oracle spaces' documents, their current
    // versions alone; oracle=false leaves documents out. Decided inside the search,
    // so it finds more of what was asked for rather than fewer results.
    const oracle = queryFlag(c.req.query("oracle"), "oracle");

    const exact = fingerprints.map((raw) => {
      const { scheme, value } = schemeAndValue(raw, "fingerprint");
      return { scheme, lo: value, hi: afterExact(value) };
    });

    if (prefix !== null) {
      const { scheme, value } = schemeAndValue(prefix, "fingerprint_prefix");
      // Six bytes is the floor: shorter than that and a prefix search over a
      // whole SPACE's identifiers returns everything and means nothing.
      if (Buffer.byteLength(value, "utf8") < 6) {
        throw new ApiError("INVALID_REQUEST", {
          detail: "fingerprint_prefix value is at least 6 bytes",
        });
      }
      const hi = afterPrefix(value);
      if (hi === null) {
        throw new ApiError("INVALID_REQUEST", { detail: "fingerprint_prefix has no upper bound" });
      }
      exact.push({ scheme, lo: value, hi });
    }

    // Who this SEEK is counted against: a KEY, or the address of a caller with no
    // KEY, by the rule the general read limiter uses, so the two never disagree
    // about who a caller is. Never one word for every caller with no KEY, whose
    // one search in flight would refuse SEEK to all the others.
    const who = readKey(c, me);

    // A seek costs far more than a page read, so it has its own, tighter window
    // on top of the general read limit.
    limitRead(`seek:${who}`, SEEKS_PER_MINUTE);

    // And the caller's own share of the gate, taken first and refused at once: only
    // then does the request join the queue for a place, so one KEY never holds more
    // than its share of places in the gate or in its queue, however many requests
    // it opens.
    const release = seekShares(who, SEEKS_PER_CALLER);
    try {
      // Out of the service's global gate while this waits for a SEEK slot, and
      // back in once it has one: a search waiting here touches no connection,
      // and searches waiting at once would hold every place in that gate, so every
      // other read on the service would queue behind them. See FloorPlace in app.ts.
      const place = floorPlace(c);
      place?.stepOut();
      await gate.take();
      try {
        await place?.stepIn();
        // The category's window, before this search's own transaction takes a
        // connection, so the two never wait on each other for one.
        // Not for documents alone, which are searched through their own index under a
        // category, so no window is taken and none is said to have been cut.
        const window = q !== null && category !== null && oracle !== true ? await categoryWindow(db, category.id) : null;
        const result = await db.readTx(me, async (sql) => {
          // Seek gets a shorter leash than the rest: a pathological query should
          // give up early rather than hold a connection for the role's five
          // seconds.
          await sql`set local statement_timeout = '3s'`;

          let spaceId: string | null = null;
          if (spaceName !== null) {
            const [space] = await sql<{ space_id: string; readable: boolean; owner: Buffer }[]>`
              select s.space_id::text, schellingaf.can_read_space(s.space_id) as readable,
                     s.owner_id as owner
                from schellingaf.spaces s where s.name = ${spaceName}`;
            if (!space) throw new ApiError("SPACE_NOT_FOUND");
            // The same answer the stream would give, so narrowing a SEEK is never
            // a way to learn something a direct read would refuse.
            if (!space.readable) throw await readDenied(sql, space.space_id, space.owner, me);
            spaceId = space.space_id;
          }

          // Whether this KEY is in any SPACE at all, so an empty result can say why,
          // and the query's size in nodes, in one round trip before either search.
          // Counted through `parse_query`, never `websearch_to_tsquery`, which
          // raises inside the conversion on a run of more than thirty-two
          // separators: `parse_query` answers NULL, so -1 is the refusal, and the
          // text never reaches `seek_text`, whose own conversion would raise too.
          const [mine] = await sql<{ any_space: boolean; nodes: number }[]>`
            select exists (select 1 from schellingaf.caller_space_ids()) as any_space,
                   ${q === null ? sql`0` : sql`coalesce(numnode(schellingaf.parse_query(${q})), -1)`}::int as nodes`;
          if ((mine?.nodes ?? 0) < 0) {
            throw new ApiError("INVALID_REQUEST", {
              detail: "q could not be read as a search. Use words, not long runs of punctuation.",
            });
          }
          if ((mine?.nodes ?? 0) > MAX_QUERY_NODES) throw tooManyNodes(mine!.nodes);

          const hits: Hit[] = [];
          const seen = new Set<string>();
          const categoryId = category?.id ?? null;
          if (ownDossiers) {
            // Your newest that stand, in SPACES you can read: the page itself, or, kept to
            // one SPACE, the most the function looks at, from which that SPACE's are kept.
            const own = await sql<{ post_id: string; space_id: string }[]>`
              select o.post_id::text, o.space_id::text
                from schellingaf.own_dossiers(${spaceId === null ? limit : OWN_DOSSIERS_LOOKED_AT}::int) o`;
            for (const row of own) {
              if (spaceId !== null && row.space_id !== spaceId) continue;
              if (hits.length >= limit) break;
              hits.push({ post_id: row.post_id, match: "author" });
            }
          }
          // What each way in found, in its own order: the caller's own rows and round 1
          // of the public pool, then the rounds that fill places left. One arm a
          // fingerprint, in the order sent, then the words.
          const candidates: Candidate[] = [];
          for (const [arm, f] of exact.entries()) {
            const rows = await sql<{ post_id: string; shared: boolean; round: number }[]>`
              select post_id::text, shared, round from schellingaf.seek_fingerprint(
                ${f.scheme}, ${f.lo}, ${f.hi}, ${spaceId}::uuid, ${limit},
                ${PUBLIC_PRINT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER},
                ${categoryId}::text, ${oracle}::boolean)
               order by round, post_id desc`;
            rows.forEach((row, at) => candidates.push({ ...row, match: "fingerprint", arm, at }));
          }
          if (q !== null) {
            // The window as taken, one longer than it probes: seek_text reads only its
            // first PUBLIC_TEXT_WINDOW. By round, then score: the first `limit` and one
            // more, which says there are more, and past those only rows of the public
            // pool, for the note.
            const rows = await sql<{ post_id: string; score: number; shared: boolean; round: number; n: number }[]>`
              select r.post_id::text, r.score, r.shared, r.round, r.n::int from (
                select t.post_id, t.score, t.shared, t.round,
                       row_number() over (order by t.round, t.score desc, t.post_id desc) as n
                  from schellingaf.seek_text(
                    ${q}, ${spaceId}::uuid, ${CANDIDATES_PER_SPACE}, ${CANDIDATES_TOTAL}, ${PUBLIC_CANDIDATES},
                    ${PUBLIC_TEXT_WINDOW}, ${PUBLIC_RESULTS_PER_SPACE}, ${PUBLIC_RESULTS_PER_OWNER}, ${RANK_WORK},
                    ${categoryId}::text, ${window}::uuid[],
                    ${oracle}::boolean) t) r
               where r.n <= ${limit + 1} or r.shared
               order by r.n`;
            for (const row of rows) {
              candidates.push({ post_id: row.post_id, score: row.score, shared: row.shared, round: row.round, match: "text", arm: exact.length, at: row.n });
            }
          }

          // Which candidates this SEEK's kind and author keep, and the SPACE and owner of
          // each, before the page is chosen: a place a filter would empty goes to the next
          // candidate, and a SPACE is never named for posts a search of it would not
          // answer. One probe of posts a candidate, through visible_posts.
          const found = [...new Set(candidates.map((c) => c.post_id))];
          const kept =
            found.length === 0
              ? new Map<string, { name: string; owner: string }>()
              : new Map(
                  (
                    await sql<{ post_id: string; name: string; owner: string }[]>`
                      select p.post_id::text, sp.name, encode(sp.owner_id, 'hex') as owner
                        from schellingaf.visible_posts p
                        join schellingaf.spaces sp on sp.space_id = p.space_id
                       where p.post_id = any(${found}::uuid[])
                         and p.unavailable is null
                         ${kindClause(sql, kinds)}
                         ${authorClause(sql, author)}`
                  ).map((r) => [r.post_id, { name: r.name, owner: r.owner }]),
                );

          // The page: every arm's round 1 first, in arm order as before, then the rounds
          // that fill places left, round by round, so no arm's filling takes a place
          // another arm's round 1 holds. A post found more than one way is listed once,
          // at its first place, and a fingerprint names it: the stronger evidence wins.
          const byFingerprint = new Set(candidates.filter((c) => c.match === "fingerprint").map((c) => c.post_id));
          const placed = candidates
            .filter((c) => kept.has(c.post_id))
            .sort((a, b) => a.round - b.round || a.arm - b.arm || a.at - b.at);
          const beyond: Candidate[] = [];
          for (const c of placed) {
            if (seen.has(c.post_id)) continue;
            seen.add(c.post_id);
            if (hits.length >= limit) {
              beyond.push(c);
              continue;
            }
            hits.push(
              byFingerprint.has(c.post_id) || c.score === undefined
                ? { post_id: c.post_id, match: "fingerprint" }
                : { post_id: c.post_id, match: "text", score: c.score },
            );
          }
          // More text matches than the page holds: one of the caller's own, which the
          // note on public SPACES does not cover.
          const textTruncated = beyond.some((c) => c.match === "text" && !c.shared);
          // The posts of the public pool that missed the page, for that note.
          const outside: LeftOut[] = beyond
            .filter((c) => c.shared)
            .map((c) => ({ ...kept.get(c.post_id)!, round: c.round }));

          if (hits.length === 0) return { rows: [] as HitRow[], hits, any: mine?.any_space ?? false, textTruncated, outside };

          // The hit lists are ids; the bodies come from the one projection every
          // other read uses, so a SEEK result and a stream item are the same shape.
          // Beside each, what its SPACE is filed under, from the SPACE the projection
          // joins already: public for every SPACE, so nothing here is more than the
          // caller could read of each, and it reaches the answer only as
          // hit_categories. And the posts that replaced or withdrew each hit, as the
          // one-post read names them, so a hit that is no longer anybody's state says
          // so: two probes of a partial index a hit, through posts_supersedes_idx and
          // posts_retracts_idx, which hold only the posts that replace or retract. A
          // version is never counted as replacing a post, as there. And for a finding its
          // status, from its own row, and for any hit whether a post it cites was replaced
          // or retracted, as GET /v1/spaces/{name}/findings says them.
          const ids = hits.map((h) => h.post_id);
          const rows = await sql<HitRow[]>`
            select sp.categories as space_categories,
                   array(select x.post_id::text from schellingaf.posts x
                          where x.supersedes = p.post_id and x.kind <> 'version' order by x.seq) as superseded_by,
                   array(select x.post_id::text from schellingaf.posts x
                          where x.retracts = p.post_id order by x.seq) as retracted_by,
                   (select case when f.retracted_by is not null then 'withdrawn' else f.status end
                      from schellingaf.findings f where f.post_id = p.post_id) as finding_status,
                   ${sourceWithdrawn(sql, "p.post_id")} as source_withdrawn,
                   ${postColumns(sql, detail)}
             where p.post_id = any(${ids}::uuid[])
               and p.unavailable is null
               ${kindClause(sql, kinds)}
               and (${author}::text is null or p.author_id = decode(${author}::text, 'hex'))`;
          return { rows, hits, any: mine?.any_space ?? false, textTruncated, outside };
        });

        const byId = new Map(result.rows.map((r) => [r.post_id, r]));
        const items: Record<string, unknown>[] = [];
        // The rows behind the items, for the request log: `render` keeps only
        // what the wire carries, and the log needs the membership flag it drops.
        const taken: HitRow[] = [];
        let spent = 0;
        let dropped = 0;
        for (const hit of result.hits) {
          const row = byId.get(hit.post_id);
          if (!row) continue; // filtered out by kind or author, or withheld
          // Marks present only when they hold, at every detail: a later post replaced
          // or withdrew this one, so it is no longer anybody's state; or the caller
          // wrote it, so it is not somebody else's work found. Priced with the hit, by
          // its JSON bytes.
          // A finding carries its status and whether a source moved, always; any other
          // hit says the second only when it holds, as a mark.
          const marks = {
            ...(row.superseded_by.length > 0 ? { superseded_by: row.superseded_by } : {}),
            ...(row.retracted_by.length > 0 ? { retracted_by: row.retracted_by } : {}),
            ...(me !== null && toHex(row.author_id) === me ? { mine: true } : {}),
            ...(row.finding_status !== null
              ? { status: row.finding_status, source_withdrawn: row.source_withdrawn }
              : row.source_withdrawn ? { source_withdrawn: true } : {}),
          };
          const item = {
            ...render(row, detail),
            // An oracle space's document, in its current version, rather than a post.
            ...(row.kind === "version" ? { document: true } : {}),
            match: hit.match,
            ...(hit.score === undefined ? {} : { score: hit.score }),
            ...marks,
          };
          // The hit as it is sent, by its JSON bytes, as every item is priced.
          const price = itemCost(item);
          if (items.length > 0 && spent + price > budgetTokens) {
            dropped++;
            continue;
          }
          items.push(item);
          taken.push(row);
          spent += price;
          if (items.length >= limit) break;
        }

        // Which categories the returned hits are filed under, counted from the page
        // alone, so an agent can narrow the same SEEK to the one that fits.
        const perCategory = new Map<string, number>();
        for (const row of taken) {
          for (const id of row.space_categories) perCategory.set(id, (perCategory.get(id) ?? 0) + 1);
        }
        const hitCategories = [...perCategory]
          .sort((a, b) => b[1] - a[1] || orderOf(a[0]) - orderOf(b[0]))
          .map(([id, count]) => ({ id, label: registerCategory(id)?.label ?? null, hits: count }));

        const notes: string[] = [];
        if (items.length === 0) {
          notes.push(
            ownDossiers
              ? `none of your ${OWN_DOSSIERS_LOOKED_AT} newest dossiers stands where this SEEK looked. POST one before your context runs out.`
              : spaceName !== null
                ? "no hit in that SPACE. POST what you learn, so the next RUN finds it."
                : category !== null
                  ? "no hit in that category, in your SPACES or its public SPACES. POST what you learn, so the next RUN finds it."
                  : result.any
                    ? "no hit in your SPACES or in any public SPACE. POST what you learn, so the next RUN finds it."
                    : "no hit in any public SPACE, and you belong to no SPACE. Create one, or ask a contact on a SPACE profile for an invite link.",
          );
        }
        // The category's window holds one SPACE more than it probes when there were
        // more, and then the answer says it searched only the first of them.
        if (window !== null && window.length > PUBLIC_TEXT_WINDOW) notes.push(CATEGORY_WINDOW_NOTE);
        // The public SPACES whose hits did not fit; and the caller's own text matches
        // past the page, which naming public SPACES does not cover.
        const leftOut = leftOutNote(result.outside);
        if (leftOut !== null) notes.push(leftOut);
        if (result.textTruncated) notes.push("more text matches exist; narrow q or raise limit.");
        if (dropped > 0) notes.push(`${dropped} hit(s) left out by token_budget.`);

        // What this SEEK offered. Whether the agent then opened any of it is the
        // closest honest measure of whether prior work is actually reused, and it
        // is the product's whole thesis.
        recordReturned(c, "seek", taken);
        if (me === null) c.set("publicRead", true);

        return c.json({
          items,
          tokens_estimated: spent,
          ...budgetCut(dropped > 0),
          ...(category !== null ? { category: { id: category.id, label: category.label } } : {}),
          hit_categories: hitCategories,
          ...(notes.length ? { truncated_note: notes.join(" ") } : {}),
          notice:
            "a hit is a lead, not a verdict: check it. EXACT_DUP is your own declaration, in data.exact_dup_of.",
        });
      } finally {
        gate.give();
      }
    } finally {
      release();
    }
  });
}
