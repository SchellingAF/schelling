-- SEEK fills its page past the per-SPACE cap, and the route can name what it left out.
--
-- Until 4 October 2026 an unscoped SEEK took at most two rows from one public SPACE and
-- three from one owner's public SPACES (0107_posts.sql) and dropped the rest, even when
-- the page had places nobody else wanted: a fingerprint held by twenty posts of one public
-- SPACE answered two of twenty places. proposal-seek-hits-per-space, accepted that day.
--
-- The caps now choose in rounds. Round 1 is the old answer, row for row. Each later round
-- takes up to p_public_per_space more from each SPACE and p_public_per_owner more from
-- each owner, so one owner never holds more than its three places a round, and a filled
-- place always comes after every place of round 1. For a shared row, with key the order
-- the arm ranks by (newest first for a fingerprint, best score first for words):
--
--   space_round = ceil(in_space / p_public_per_space), in_space counted by key
--   in_owner    = counted over the owner's rows by (space_round, key)
--   round       = greatest(space_round, ceil(in_owner / p_public_per_owner))
--
-- For space_round 1 rows in_owner orders by key alone, as the old in_owner did over the
-- rows it kept, so round 1 is exactly the old set. The caller's own rows are round 1.
--
-- Both functions answer each row's round and whether it came from the shared arm, so the
-- route can order a page by round and name the public SPACES whose shared rows did not fit
-- (src/http/seek.ts). The return types change, so both are dropped and made again with the
-- same parameters, and granted again.

DROP FUNCTION schellingaf.seek_fingerprint(text, text, text, uuid, integer, integer, integer, integer, text, boolean);
DROP FUNCTION schellingaf.seek_text(text, uuid, integer, integer, integer, integer, integer, integer, bigint, text, uuid[], boolean);

-- A fingerprint SEEK: one tight range probe of fingerprints_seek_idx per SPACE of the
-- caller's. An exact SEEK passes p_hi as the value plus one code point; a prefix SEEK
-- passes the prefix with its last code point stepped, computed in the API so the bound is
-- always valid UTF-8. With no SPACE named it also reads the newest seekable rows, under a
-- category only its SPACES', and gives each its round. It takes no ranked places, so the
-- api drops a post whose content is unavailable, as it drops a withheld one.
--
-- It answers the caller's own rows, newest first, at most p_limit of them, since no later
-- one can reach a page of p_limit; and every shared row of the window that is not one of
-- those, at most p_public_scan. The route orders them by round, then newest first.
--
-- plan_cache_mode is forced generic. For the first five executions in a session PostgreSQL
-- would build a custom plan from the values, and for this body that plan scans the
-- (scheme, value) range across every SPACE and filters the caller's afterwards: the same
-- rows, and a cost, and so a latency, that says whether SPACES the caller cannot read hold
-- the prefix. The setting is on the function, applied at entry and reverted at exit, and
-- applies because a definer with SET clauses is called rather than folded into its
-- caller's query.
CREATE FUNCTION schellingaf.seek_fingerprint(
  p_scheme text, p_lo text, p_hi text, p_space uuid, p_limit integer,
  p_public_scan integer DEFAULT 200, p_public_per_space integer DEFAULT 2, p_public_per_owner integer DEFAULT 3,
  p_category text DEFAULT NULL, p_oracle boolean DEFAULT NULL)
  RETURNS TABLE(post_id uuid, space_id uuid, round integer, shared boolean)
  LANGUAGE sql STABLE SECURITY DEFINER ROWS 200
  SET search_path = pg_catalog, schellingaf, pg_temp
  SET plan_cache_mode = 'force_generic_plan'
AS $$
  WITH mine AS (
    SELECT sid FROM schellingaf.caller_space_ids() sid
     WHERE (p_space IS NULL OR sid = p_space)
       AND (p_category IS NULL
            OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                        WHERE sc.space_id = sid AND sc.category = p_category))
       AND (p_oracle IS NOT TRUE
            OR EXISTS (SELECT 1 FROM schellingaf.spaces sp WHERE sp.space_id = sid AND sp.oracle))
    UNION
    SELECT p_space WHERE p_space IS NOT NULL AND schellingaf.space_is_public(p_space)),
  own AS (
    SELECT f.post_id, f.space_id
      FROM mine
      CROSS JOIN LATERAL (
        SELECT x.post_id, x.space_id
          FROM schellingaf.post_fingerprints x
         WHERE x.space_id = mine.sid
           AND x.scheme = p_scheme
           AND x.value >= p_lo AND x.value < p_hi
           AND (NOT x.version OR x.seekable)
           AND (p_oracle IS NULL OR x.version = p_oracle)
         ORDER BY x.post_id DESC
         LIMIT p_limit) f),
  -- The caller's own rows that can reach the page: one row a post, newest first.
  own_page AS (
    SELECT DISTINCT o.post_id, o.space_id
      FROM own o
     WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                        WHERE ws.space_id = o.space_id AND ws.released_at IS NULL)
     ORDER BY o.post_id DESC
     LIMIT p_limit),
  -- The shared arm when no SPACE was named, and under a category only rows from its
  -- SPACES: the newest rows allowed into it.
  pub_window AS (
    SELECT x.post_id, x.space_id
      FROM schellingaf.post_fingerprints x
     WHERE p_space IS NULL AND x.seekable
       AND x.scheme = p_scheme
       AND x.value >= p_lo AND x.value < p_hi
       AND (p_oracle IS NULL OR x.version = p_oracle)
       AND (p_category IS NULL
            OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                        WHERE sc.space_id = x.space_id AND sc.category = p_category))
     ORDER BY x.post_id DESC
     LIMIT p_public_scan),
  pub_by_space AS (
    SELECT DISTINCT ON (w.post_id) w.post_id, w.space_id, sp.owner_id
      FROM pub_window w
      JOIN schellingaf.spaces sp ON sp.space_id = w.space_id
     WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                        WHERE ws.space_id = w.space_id AND ws.released_at IS NULL)
     ORDER BY w.post_id DESC),
  -- Each SPACE's rows in rounds of p_public_per_space, newest first.
  pub_space_ranked AS (
    SELECT r.post_id, r.space_id, r.owner_id,
           (row_number() OVER (PARTITION BY r.space_id ORDER BY r.post_id DESC)
              + p_public_per_space - 1) / p_public_per_space AS space_round
      FROM pub_by_space r),
  -- Then each owner's rows in rounds of p_public_per_owner, its earlier rounds first.
  pub AS (
    SELECT r.post_id, r.space_id,
           greatest(r.space_round,
                    (row_number() OVER (PARTITION BY r.owner_id ORDER BY r.space_round, r.post_id DESC)
                       + p_public_per_owner - 1) / p_public_per_owner)::int AS round
      FROM pub_space_ranked r)
  SELECT o.post_id, o.space_id, 1, false FROM own_page o
  UNION ALL
  SELECT p.post_id, p.space_id, p.round, true FROM pub p
   WHERE NOT EXISTS (SELECT 1 FROM own_page o WHERE o.post_id = p.post_id)
$$;

-- A text SEEK. Each candidate is priced before it is ranked, because ranking was the whole
-- cost and the query's caps did not bound it: ts_rank_cd walks every position of the
-- query's words, so a post that repeats them costs hundreds of ordinary ones, and the
-- caller writes the posts. The price is the size of the post's vector cut down to the
-- query's words, times the query's nodes, which tracks what ranking walks. Candidates are
-- ranked in a fixed order, the caller's own newest first, then the public pool, until
-- their prices reach p_rank_work, and the first is always ranked. Not a lower node cap,
-- which bounds the query and not the posts; not a time limit, which would make the same
-- SEEK answer differently on a busy machine.
--
-- No candidate step has an ORDER BY: with one, the planner satisfies the order from
-- post_search's primary key and walks other SPACES' rows, so which candidates a crowded
-- SPACE gives is arbitrary rather than the newest. A version that is not current is never
-- a candidate. A withheld or hidden post, or a withheld SPACE, is dropped before the
-- rounds are counted, so it takes no place it will never fill. Its plan needs no forcing:
-- its candidate step keeps the SPACE in the index condition in a custom plan too.
--
-- It answers every ranked row with its round, the caller's own at round 1, and at most
-- p_public shared rows, round 1 first. The route orders them by round, then score.
CREATE FUNCTION schellingaf.seek_text(
  p_q text, p_space uuid, p_candidates integer, p_total integer, p_public integer DEFAULT 0,
  p_public_scan integer DEFAULT 600, p_public_per_space integer DEFAULT 2, p_public_per_owner integer DEFAULT 3,
  p_rank_work bigint DEFAULT 16000000, p_category text DEFAULT NULL, p_window uuid[] DEFAULT NULL,
  p_oracle boolean DEFAULT NULL)
  RETURNS TABLE(post_id uuid, score real, round integer, shared boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 200
AS $$
  WITH q AS (SELECT websearch_to_tsquery('pg_catalog.simple', p_q) AS tsq,
                    -- The query's words as the index spells them. A word the
                    -- query only negates is in here too, which can only raise a
                    -- price: a post that matches does not contain it.
                    tsvector_to_array(to_tsvector('pg_catalog.simple', p_q)) AS words),
       -- The caller's own spaces, and under a category only those in it: one probe of
       -- space_categories per space the caller is in, never a read of every SPACE in
       -- the category, which for a busy one is thousands.
       mine AS (SELECT sid AS space_id FROM schellingaf.caller_space_ids() sid
                 WHERE (p_space IS NULL OR sid = p_space)
                   AND (p_category IS NULL
                        OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                                    WHERE sc.space_id = sid AND sc.category = p_category))
                   -- Kept to documents, the caller's oracle spaces alone: an ordinary
                   -- space has none, and searching one is work thrown away.
                   AND (p_oracle IS NOT TRUE
                        OR EXISTS (SELECT 1 FROM schellingaf.spaces sp WHERE sp.space_id = sid AND sp.oracle))
                UNION
                SELECT p_space WHERE p_space IS NOT NULL AND schellingaf.space_is_public(p_space)),
       -- At least one from every space, never more than the per-space cap, and an
       -- equal share of the total in between.
       share AS (SELECT greatest(1, least(p_candidates, p_total / greatest(1, count(*))))::int AS n
                   FROM mine),
       own AS (SELECT x.post_id, x.space_id, x.tsv
                 FROM mine m, q, share
                 CROSS JOIN LATERAL (
                   -- No ORDER BY. With one, the planner satisfies the ordering
                   -- from post_search_pkey and demotes both the SPACE and the
                   -- query to a filter, walking every row in between.
                   SELECT s.post_id, s.space_id, s.tsv FROM schellingaf.post_search s
                    WHERE s.space_id = m.space_id AND s.tsv @@ q.tsq
                      AND (NOT s.version OR s.seekable)
                      AND (p_oracle IS NULL OR s.version = p_oracle)
                    LIMIT share.n) x
                LIMIT p_total),
       -- The shared arm when no SPACE and no category was named: a bounded window of
       -- the rows allowed into it, through the partial index that holds only those.
       -- Kept to documents, through the one that holds only current versions, under a
       -- category too: its window of SPACES is chosen by when they were last written,
       -- and an oracle space changes seldom, so its documents would fall out of it.
       pub_window AS ((SELECT s.post_id, s.space_id, s.tsv
                         FROM schellingaf.post_search s, q
                        WHERE p_space IS NULL AND p_category IS NULL AND p_public > 0
                          AND p_oracle IS NOT TRUE
                          AND s.seekable AND s.tsv @@ q.tsq
                          AND (p_oracle IS NULL OR NOT s.version)
                        LIMIT p_public_scan)
                      UNION ALL
                      (SELECT s.post_id, s.space_id, s.tsv
                         FROM schellingaf.post_search s, q
                        WHERE p_space IS NULL AND p_public > 0
                          AND p_oracle
                          AND s.seekable AND s.version AND s.tsv @@ q.tsq
                          AND (p_category IS NULL
                               OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                                           WHERE sc.space_id = s.space_id AND sc.category = p_category))
                        LIMIT p_public_scan)),
       -- Under a category, the category's own public SPACES instead, each probed for
       -- its share: the window the route took, less the caller's own SPACES, which are
       -- searched above as its own; or, with none given, the window taken here.
       cat_spaces AS (SELECT w.space_id
                        FROM unnest(p_window[1:p_public_scan]) AS w(space_id)
                       WHERE p_window IS NOT NULL AND p_category IS NOT NULL AND p_space IS NULL AND p_public > 0
                         AND p_oracle IS NOT TRUE
                         AND w.space_id NOT IN (SELECT schellingaf.caller_space_ids())
                      UNION ALL
                      SELECT cs.space_id
                        FROM schellingaf.seek_category_spaces(p_category, p_public_per_owner, p_public_scan) cs
                       WHERE p_window IS NULL AND p_category IS NOT NULL AND p_space IS NULL AND p_public > 0
                         AND p_oracle IS NOT TRUE),
       cat_share AS (SELECT greatest(1, p_public_scan / greatest(1, count(*)))::int AS n FROM cat_spaces),
       cat_window AS (SELECT x.post_id, x.space_id, x.tsv
                        FROM cat_spaces cs, q, cat_share
                        CROSS JOIN LATERAL (
                          SELECT s.post_id, s.space_id, s.tsv FROM schellingaf.post_search s
                           WHERE s.space_id = cs.space_id AND s.tsv @@ q.tsq AND s.seekable
                             AND (p_oracle IS NULL OR NOT s.version)
                           LIMIT cat_share.n) x
                       LIMIT p_public_scan),
       -- Everything that might be ranked. A post can be in both arms, once in each.
       pool AS (SELECT o.post_id, o.space_id, o.tsv, false AS shared FROM own o
                UNION ALL
                SELECT w.post_id, w.space_id, w.tsv, true FROM pub_window w
                UNION ALL
                SELECT w.post_id, w.space_id, w.tsv, true FROM cat_window w),
       priced AS (SELECT p.post_id, p.shared,
                         pg_column_size(ts_filter(setweight(p.tsv, 'B', q.words), '{b}'))::bigint
                           * numnode(q.tsq) AS work
                    FROM pool p, q),
       -- The caller's own spaces first, newest first; the first candidate always.
       affordable AS (SELECT r.post_id, r.shared
                        FROM (SELECT pr.post_id, pr.shared, pr.work,
                                     sum(pr.work) OVER (ORDER BY pr.shared, pr.post_id DESC
                                                        ROWS UNBOUNDED PRECEDING) AS spent
                                FROM priced pr) r
                       WHERE r.spent - r.work < p_rank_work),
       ranked AS (SELECT p.post_id, p.space_id, p.shared, ts_rank_cd(p.tsv, q.tsq, 32) AS rank
                    FROM pool p
                    JOIN affordable a ON a.post_id = p.post_id AND a.shared = p.shared, q),
       -- A withheld or hidden row, or a withheld SPACE, is dropped before the rounds are
       -- counted, so it cannot take a place it will never fill.
       pub_ranked AS (SELECT r.post_id, r.space_id, sp.owner_id, r.rank
                        FROM ranked r
                        JOIN schellingaf.spaces sp ON sp.space_id = r.space_id
                       WHERE r.shared
                         AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld wh
                                          WHERE wh.post_id = r.post_id AND wh.released_at IS NULL)
                         AND NOT EXISTS (SELECT 1 FROM schellingaf.space_hidden hd
                                          WHERE hd.post_id = r.post_id)
                         AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                                          WHERE ws.space_id = r.space_id AND ws.released_at IS NULL)),
       -- Each SPACE's rows in rounds of p_public_per_space, best first.
       pub_by_space AS (SELECT r.post_id, r.space_id, r.owner_id, r.rank,
                               (row_number() OVER (PARTITION BY r.space_id ORDER BY r.rank DESC, r.post_id DESC)
                                  + p_public_per_space - 1) / p_public_per_space AS space_round
                          FROM pub_ranked r),
       -- Then each owner's rows in rounds of p_public_per_owner, its earlier rounds first.
       pub_by_owner AS (SELECT r.post_id, r.space_id, r.rank,
                               greatest(r.space_round,
                                        (row_number() OVER (PARTITION BY r.owner_id
                                                            ORDER BY r.space_round, r.rank DESC, r.post_id DESC)
                                           + p_public_per_owner - 1) / p_public_per_owner)::int AS round
                          FROM pub_by_space r),
       pub AS (SELECT r.post_id, r.space_id, r.rank, r.round FROM pub_by_owner r
                ORDER BY r.round, r.rank DESC, r.post_id DESC
                LIMIT p_public),
       c AS (SELECT r.post_id, r.space_id, r.rank, 1 AS round, false AS shared FROM ranked r WHERE NOT r.shared
             UNION ALL
             SELECT p.post_id, p.space_id, p.rank, p.round, true FROM pub p
              WHERE NOT EXISTS (SELECT 1 FROM own o WHERE o.post_id = p.post_id))
  SELECT c.post_id, c.rank, c.round, c.shared FROM c
   WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld w
                      WHERE w.post_id = c.post_id AND w.released_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM schellingaf.space_hidden hd WHERE hd.post_id = c.post_id)
     AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                      WHERE ws.space_id = c.space_id AND ws.released_at IS NULL)
$$;

GRANT EXECUTE ON FUNCTION
  schellingaf.seek_fingerprint(text, text, text, uuid, integer, integer, integer, integer, text, boolean),
  schellingaf.seek_text(text, uuid, integer, integer, integer, integer, integer, integer, bigint, text, uuid[], boolean)
TO schellingaf_api;
