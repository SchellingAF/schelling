-- What each SPACE stores: the bytes of its shown posts, kept as a counter beside the
-- file total of 0121, so a bill can be measured without walking every post.
--
-- A post's stored bytes are its object, canonical and private, and for a sealed post its
-- header and ciphertext. A sealed post's object holds only hashes of those two, so nothing
-- counts twice. octet_length on a bytea reads the size from the value's header and
-- decompresses nothing; the bytes are logical, not on disk. posts.body (the same words
-- again), the search vector, tasks, events and memberships are not counted. A post counts
-- while it is neither hidden nor withheld, as a file does; old document versions are posts
-- and count. Files stay in space_file_totals.attached_bytes.
--
-- Two insert triggers, one on post_objects and one on sealed_posts, each add their own
-- row's bytes, so the count does not depend on which of the two append_post writes first.
-- Two triggers follow hiding and withholding as file_totals_follow() does. A nightly
-- recount (src/db/storage.ts) corrects either counter that drifted, and takes the SPACE's
-- lock only to correct one that looks wrong. Nobody but the definer functions reads the counter.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- Every lock this file needs, taken up front in one statement, in the order a POST takes
-- them: append_post() updates spaces, then writes posts, post_objects and sealed_posts;
-- hiding and withholding write space_hidden and withheld. Taking them one by one, as each
-- CREATE TRIGGER came, could deadlock with a POST that holds one and wants the next. From
-- here to commit no post is written, hidden or withheld, so the backfill below misses none.
-- Every request that writes waits behind a lock this file is waiting for, and the api role
-- gives up on a lock after 2 s (postgres/init/01_roles.sh). So this file waits 1.5 s at
-- most: a timeout fails the migrate step and with it the deploy, nothing is changed, and
-- the next deploy tries again.
SET LOCAL lock_timeout = '1500ms';
LOCK TABLE schellingaf.spaces, schellingaf.posts, schellingaf.post_objects, schellingaf.sealed_posts,
           schellingaf.space_hidden, schellingaf.withheld IN SHARE ROW EXCLUSIVE MODE;

-- ─────────────────────────────────────────────────────────────────────────────
-- The counter
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.space_storage (
  space_id   uuid PRIMARY KEY REFERENCES schellingaf.spaces,
  post_bytes bigint NOT NULL DEFAULT 0 CHECK (post_bytes >= 0)
);

ALTER TABLE schellingaf.space_storage ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_storage_none ON schellingaf.space_storage FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.space_storage FROM schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- One definition of what a post stores, and whether it counts
-- ─────────────────────────────────────────────────────────────────────────────

-- The bytes one post stores: its object, and its sealed header and ciphertext. 0 for a
-- part that is absent.
CREATE FUNCTION schellingaf.post_stored_bytes(p_post uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce((SELECT octet_length(po.canonical)::bigint + coalesce(octet_length(po.private), 0)
                     FROM post_objects po WHERE po.post_id = p_post), 0)
       + coalesce((SELECT octet_length(sp.header)::bigint + octet_length(sp.ciphertext)
                     FROM sealed_posts sp WHERE sp.post_id = p_post), 0)
$$;

-- Whether a post counts: neither hidden nor withheld.
CREATE FUNCTION schellingaf.post_shown(p_post uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = p_post)
     AND NOT EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = p_post AND w.released_at IS NULL)
$$;

-- The true post bytes of one SPACE: its posts by space_id, each looked up by primary key.
-- The backfill below and both phases of the recount read this one definition.
CREATE FUNCTION schellingaf.space_post_bytes_true(p_space uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(sum(post_stored_bytes(p.post_id)), 0)::bigint
    FROM posts p
   WHERE p.space_id = p_space AND post_shown(p.post_id)
$$;

-- The true file bytes of one SPACE: each attached file once, while a shown post attaches it.
CREATE FUNCTION schellingaf.space_file_bytes_true(p_space uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(sum(f.bytes), 0)::bigint
    FROM space_files f
   WHERE f.space_id = p_space AND f.attached AND file_shown(p_space, f.sha256, NULL)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The counter follows each post written
-- ─────────────────────────────────────────────────────────────────────────────

-- Adds its own table's bytes for the row written, while the post is shown: every post
-- append_post writes is, and the check matters for the recovery path that links old posts
-- (0107). Takes no SPACE lock: its callers hold it.
CREATE FUNCTION schellingaf.storage_count_insert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_bytes bigint;
BEGIN
  IF TG_TABLE_NAME = 'post_objects' THEN
    v_bytes := octet_length(NEW.canonical)::bigint + coalesce(octet_length(NEW.private), 0);
  ELSE
    v_bytes := octet_length(NEW.header)::bigint + octet_length(NEW.ciphertext);
  END IF;
  IF NOT post_shown(NEW.post_id) THEN RETURN NULL; END IF;
  INSERT INTO space_storage AS t (space_id, post_bytes) VALUES (NEW.space_id, v_bytes)
  ON CONFLICT (space_id) DO UPDATE SET post_bytes = t.post_bytes + excluded.post_bytes;
  RETURN NULL;
END $$;
CREATE TRIGGER post_objects_storage AFTER INSERT ON schellingaf.post_objects
  FOR EACH ROW EXECUTE FUNCTION schellingaf.storage_count_insert();
CREATE TRIGGER sealed_posts_storage AFTER INSERT ON schellingaf.sealed_posts
  FOR EACH ROW EXECUTE FUNCTION schellingaf.storage_count_insert();

-- A post hidden or withheld gives its bytes back; shown or released, it takes them again.
-- The same rules as file_totals_follow() (0121), which stays as it is, and the SPACE's
-- lock first, so a post counted beside it is counted before or after, never beside. The
-- SPACE is the post's own, from posts: withheld.space_id is typed by the operator and has
-- no foreign key. file_totals_follow() still trusts withheld.space_id.
CREATE FUNCTION schellingaf.storage_follow() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_post uuid; v_space uuid; v_was boolean; v_is boolean; v_hidden boolean; v_withheld boolean;
  v_delta bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN v_post := OLD.post_id; ELSE v_post := NEW.post_id; END IF;
  -- A withheld row inserted already released, or updated without changing whether it is
  -- active, changes nothing.
  IF TG_TABLE_NAME = 'withheld' THEN
    IF TG_OP = 'INSERT' AND NEW.released_at IS NOT NULL THEN RETURN NULL; END IF;
    IF TG_OP = 'UPDATE' AND (OLD.released_at IS NULL) = (NEW.released_at IS NULL) THEN RETURN NULL; END IF;
  END IF;
  SELECT p.space_id INTO v_space FROM posts p WHERE p.post_id = v_post;
  PERFORM 1 FROM spaces sp WHERE sp.space_id = v_space FOR NO KEY UPDATE;
  -- The post's state now, the row this trigger follows included.
  v_hidden := EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = v_post);
  v_withheld := EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = v_post AND w.released_at IS NULL);
  v_is := NOT v_hidden AND NOT v_withheld;
  -- What it was before this row: hidden rows come and go whole; a withheld row is made
  -- active or released, and a partial unique index keeps one active row a post.
  IF TG_TABLE_NAME = 'space_hidden' THEN
    v_was := TG_OP = 'INSERT' AND NOT v_withheld;
  ELSIF TG_OP = 'INSERT' THEN
    v_was := NOT v_hidden;
  ELSE
    v_was := NOT v_hidden AND OLD.released_at IS NOT NULL;
  END IF;
  IF v_was = v_is THEN RETURN NULL; END IF;
  v_delta := post_stored_bytes(v_post);
  IF v_delta = 0 THEN RETURN NULL; END IF;
  IF v_is THEN
    INSERT INTO space_storage AS t (space_id, post_bytes) VALUES (v_space, v_delta)
    ON CONFLICT (space_id) DO UPDATE SET post_bytes = t.post_bytes + excluded.post_bytes;
  ELSE
    UPDATE space_storage t SET post_bytes = greatest(0, t.post_bytes - v_delta)
     WHERE t.space_id = v_space;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER space_hidden_storage AFTER INSERT OR DELETE ON schellingaf.space_hidden
  FOR EACH ROW EXECUTE FUNCTION schellingaf.storage_follow();
CREATE TRIGGER withheld_storage AFTER INSERT OR UPDATE OF released_at ON schellingaf.withheld
  FOR EACH ROW EXECUTE FUNCTION schellingaf.storage_follow();

-- ─────────────────────────────────────────────────────────────────────────────
-- The recount
-- ─────────────────────────────────────────────────────────────────────────────

-- The recount is two calls, each its own transaction (src/db/storage.ts), so the SPACE
-- lock is held only for a correction. Phase 1, storage_recount_drift(): unlocked, the true
-- values and the stored ones in one statement, one snapshot; true when they differ. It
-- may take long on a large SPACE and blocks no writer. Phase 2, storage_recount(): the
-- SPACE lock, then both computed again, set where they differ, and true minus stored
-- answered. A statement begun after the lock sees every post committed before it, and
-- every writer after it waits. Lock order is the rule's: the SPACE row, then its
-- projection rows.
CREATE FUNCTION schellingaf.storage_recount_drift(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT space_post_bytes_true(p_space) <> coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0)
      OR space_file_bytes_true(p_space) <> coalesce((SELECT ft.attached_bytes FROM space_file_totals ft WHERE ft.space_id = p_space), 0)
$$;

CREATE FUNCTION schellingaf.storage_recount(p_space uuid) RETURNS TABLE (post_delta bigint, file_delta bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_posts bigint; v_files bigint; v_had_posts bigint; v_had_files bigint;
BEGIN
  PERFORM 1 FROM spaces sp WHERE sp.space_id = p_space FOR NO KEY UPDATE;
  SELECT space_post_bytes_true(p_space), space_file_bytes_true(p_space),
         coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0),
         coalesce((SELECT ft.attached_bytes FROM space_file_totals ft WHERE ft.space_id = p_space), 0)
    INTO v_posts, v_files, v_had_posts, v_had_files;
  IF v_posts <> v_had_posts THEN
    INSERT INTO space_storage AS t (space_id, post_bytes) VALUES (p_space, v_posts)
    ON CONFLICT (space_id) DO UPDATE SET post_bytes = excluded.post_bytes;
  END IF;
  IF v_files <> v_had_files THEN
    INSERT INTO space_file_totals AS ft (space_id, attached_bytes) VALUES (p_space, v_files)
    ON CONFLICT (space_id) DO UPDATE SET attached_bytes = excluded.attached_bytes;
  END IF;
  post_delta := v_posts - v_had_posts;
  file_delta := v_files - v_had_files;
  RETURN NEXT;
END $$;

-- The SPACES with a post, by space_id, after the cursor, at most a thousand a call. The
-- missing bound is the lowest uuid, taken with the cursor's own test, so it stays an index
-- condition under a generic plan.
CREATE FUNCTION schellingaf.storage_recount_spaces(p_after uuid, p_limit int) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(array_agg(x.space_id ORDER BY x.space_id), '{}'::uuid[])
    FROM (SELECT s.space_id FROM spaces s
           WHERE s.space_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
             AND s.space_id IS DISTINCT FROM p_after
             AND s.last_seq > 0
           ORDER BY s.space_id
           LIMIT least(p_limit, 1000)) x
$$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.post_stored_bytes(uuid),
  schellingaf.post_shown(uuid),
  schellingaf.space_post_bytes_true(uuid),
  schellingaf.space_file_bytes_true(uuid),
  schellingaf.storage_count_insert(),
  schellingaf.storage_follow(),
  schellingaf.storage_recount_drift(uuid),
  schellingaf.storage_recount(uuid),
  schellingaf.storage_recount_spaces(uuid, int)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schellingaf.storage_recount_drift(uuid),
  schellingaf.storage_recount(uuid),
  schellingaf.storage_recount_spaces(uuid, int)
TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- The backfill: every SPACE with a post, zero included
-- ─────────────────────────────────────────────────────────────────────────────

-- After the triggers, in this file's one transaction: the locks taken at the top hold to
-- commit, so no post lands, is hidden or is withheld between this count and the
-- triggers. One statement, not slices: slices would need the triggers live while counting,
-- and then a double count. Revisit past about a million posts.
-- backfill begin
INSERT INTO schellingaf.space_storage (space_id, post_bytes) SELECT s.space_id, schellingaf.space_post_bytes_true(s.space_id) FROM schellingaf.spaces s WHERE EXISTS (SELECT 1 FROM schellingaf.posts p WHERE p.space_id = s.space_id) ON CONFLICT (space_id) DO UPDATE SET post_bytes = excluded.post_bytes;
-- backfill end
