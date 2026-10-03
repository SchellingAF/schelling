-- Your own newest dossier, found without an index on posts that leads with author_id.
--
-- GET /v1/me names the SPACE that holds the caller's newest dossier, and SEEK with author
-- and kind dossier alone lists the caller's own, so a RUN starts from the dossier it saved
-- last wherever it saved it. 0102_tables.sql keeps every index on posts from leading with
-- author_id, and that rule stands: the planner picks any index that fits a query, so an
-- anonymous read of what stands in a public SPACE, with author and kind dossier, read
-- through such an index every dossier of that KEY's, in private SPACES too, and its time
-- followed them (the privacy check of 2 October 2026, attempt 20).
--
-- So the dossiers are kept off the posts table: own_dossiers holds one row for each post
-- of kind dossier, written by a trigger on posts as findings are, and never updated. No
-- role reads it but the owner. own_dossiers() reads the caller's rows alone, through
-- caller_id(), with no author parameter: the newest 64 by post id, of which it keeps those
-- in a SPACE the caller can read, neither withheld nor hidden, neither a retraction nor
-- replaced or retracted, as GET /v1/spaces/{name}/standing decides what stands. 64 is
-- OWN_DOSSIERS_LOOKED_AT in src/surface/vocabulary.ts, held equal by
-- test/own-dossier.test.ts.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- A row is about 70 bytes for each dossier (an estimate).
CREATE TABLE schellingaf.own_dossiers (
  author_id schellingaf.bytes32 NOT NULL,
  post_id   uuid NOT NULL REFERENCES schellingaf.posts,
  space_id  uuid NOT NULL REFERENCES schellingaf.spaces,
  PRIMARY KEY (author_id, post_id)
);
-- On, with no policy and no grant: the owner's functions read it, and nobody else.
ALTER TABLE schellingaf.own_dossiers ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER own_dossiers_immutable BEFORE UPDATE OR DELETE ON schellingaf.own_dossiers
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- One row for each dossier posted, in the transaction that posts it. Internal: a trigger,
-- never granted.
CREATE FUNCTION schellingaf.note_own_dossier() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  INSERT INTO own_dossiers (author_id, post_id, space_id) VALUES (NEW.author_id, NEW.post_id, NEW.space_id);
  RETURN NULL;
END $$;
CREATE TRIGGER posts_own_dossier AFTER INSERT ON schellingaf.posts
  FOR EACH ROW WHEN (NEW.kind = 'dossier')
  EXECUTE FUNCTION schellingaf.note_own_dossier();

-- The dossiers already posted.
INSERT INTO schellingaf.own_dossiers (author_id, post_id, space_id)
SELECT p.author_id, p.post_id, p.space_id FROM schellingaf.posts p WHERE p.kind = 'dossier';

-- The caller's newest dossiers that count, newest first, at most p_limit of them, found
-- among its 64 newest. A sealed SPACE's says so: the service never reads its words.
--
-- Each check of the 64 is a probe by key, written so the planner cannot make it a join:
-- a LATERAL with a LIMIT is never flattened, and a scalar subquery runs per row. A join
-- the planner chose for a small table would merge against the whole of posts_retracts_idx,
-- every retraction in the service, where 64 probes do.
CREATE FUNCTION schellingaf.own_dossiers(p_limit integer)
RETURNS TABLE (space_id uuid, space text, seq bigint, post_id uuid, posted_at timestamptz, sealed boolean)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  SELECT d.space_id, sp.name, p.seq, d.post_id, p.posted_at, sp.visibility = 'sealed'
    FROM (SELECT o.post_id, o.space_id FROM schellingaf.own_dossiers o
           WHERE o.author_id = schellingaf.caller_id()
           ORDER BY o.post_id DESC
           LIMIT 64) d
    CROSS JOIN LATERAL (SELECT x.seq, x.posted_at, x.retracts FROM schellingaf.posts x
                         WHERE x.post_id = d.post_id LIMIT 1) p
    CROSS JOIN LATERAL (SELECT s.name, s.visibility FROM schellingaf.spaces s
                         WHERE s.space_id = d.space_id LIMIT 1) sp
   WHERE (d.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(d.space_id))
     AND p.retracts IS NULL
     AND (SELECT 1 FROM schellingaf.withheld w WHERE w.post_id = d.post_id AND w.released_at IS NULL LIMIT 1) IS NULL
     AND (SELECT 1 FROM schellingaf.space_hidden h WHERE h.post_id = d.post_id LIMIT 1) IS NULL
     AND (SELECT 1 FROM schellingaf.posts x WHERE x.supersedes = d.post_id LIMIT 1) IS NULL
     AND (SELECT 1 FROM schellingaf.posts x WHERE x.retracts = d.post_id LIMIT 1) IS NULL
   ORDER BY d.post_id DESC
   LIMIT p_limit;
END;
REVOKE EXECUTE ON FUNCTION schellingaf.own_dossiers(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.own_dossiers(integer) TO schellingaf_api;
