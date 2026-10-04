-- Contested findings: a mark the service sets on a finding from what was posted, beside its
-- author's status and never in place of it.
--
-- A finding's status and confidence are its author's words. Until this file a check's
-- reject of the post a finding rests on, or a member's warn or fail citing it, changed
-- nothing a reader of the finding saw. Two acts now mark it, on the finding's own post or
-- on a post it rests on: a check's reject of that post as a task's result, while the task
-- has not accepted that post since; and a member's warn or fail that cites that post in
-- data.sources and still stands. A warn or fail never marks a post its own author wrote.
-- The mark is read at read time (src/http/contested.ts), so it clears with its cause; this
-- file keeps the one projection it needs, post_objections, and fills one old reject.
-- The specification is the proposal proposal-contested-findings (4 October 2026).
--
-- S1, the mark: cap() names, post_objections, project_post(), the lock and the backfill,
-- and the fill of task 7 of cipher-trial-1. S2, the notice, follows in its own blocks.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- S1: two more limits
-- ─────────────────────────────────────────────────────────────────────────────

-- The structural limits, written once, as 0101 wrote them, with two more for the contested
-- notice. Each new name equals its FINDING_LIMITS key in src/surface/vocabulary.ts, and
-- test/contested.test.ts holds them equal. No index, CHECK or generated column uses cap():
-- pg_depend held no row referring to it when this file was written.
CREATE OR REPLACE FUNCTION schellingaf.cap(p_name text) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE p_name
    WHEN 'members_per_space'      THEN 10000000
    WHEN 'admins_per_space'       THEN 10000
    WHEN 'spaces_per_key'         THEN 10000
    WHEN 'granted_spaces_per_key' THEN 5000
    WHEN 'live_links_per_maker'   THEN 100000
    -- How many admins a join request or an oracle proposal is delivered to,
    -- besides the owner: the first to be admitted. The rest read the list.
    WHEN 'request_notices'        THEN 32
    -- How many findings one reject or one warn tells its authors of: the newest.
    -- The rest are marked in every read.
    WHEN 'contested_notices'      THEN 200
    -- How many citing posts of one cited post a notice walks, newest first. A finding
    -- past them is marked in every read and told nothing.
    WHEN 'contested_scan'         THEN 500
    ELSE 0 END;

-- ─────────────────────────────────────────────────────────────────────────────
-- S1: a member's warn or fail, by the post it cites
-- ─────────────────────────────────────────────────────────────────────────────

-- A member's warn or fail citing another author's post in data.sources: source_id is cited
-- by post_id, both posts of space_id. Written by project_post() in the post's transaction,
-- never changed or deleted. Whether the warn still stands is read at read time.
CREATE TABLE schellingaf.post_objections (
  source_id uuid NOT NULL REFERENCES schellingaf.posts,
  post_id   uuid NOT NULL REFERENCES schellingaf.posts,
  space_id  uuid NOT NULL REFERENCES schellingaf.spaces,
  PRIMARY KEY (source_id, post_id)
);
CREATE TRIGGER post_objections_immutable BEFORE UPDATE OR DELETE ON schellingaf.post_objections
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- Whoever can read the SPACE: its members, and anybody when it is public, as its posts.
ALTER TABLE schellingaf.post_objections ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_objections_read ON schellingaf.post_objections FOR SELECT TO schellingaf_api
  USING (post_objections.space_id IN (SELECT schellingaf.caller_space_ids())
         OR schellingaf.space_is_public(post_objections.space_id));
GRANT SELECT ON schellingaf.post_objections TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- S1: project_post() writes them
-- ─────────────────────────────────────────────────────────────────────────────

-- 0116's body unchanged, and one block more: a member's warn or fail objects to each post
-- of another author it cites. A KEY with no role in the SPACE objects to nothing, and a
-- sealed post, whose data is null, projects nothing. Internal: a trigger, never granted.
CREATE OR REPLACE FUNCTION schellingaf.project_post() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_number integer; v_raw text[]; v_ids uuid[]; v_twice text;
BEGIN
  IF jsonb_typeof(NEW.data->'sources') = 'array' THEN
    -- Each as it was sent, and the post it names here: by seq, one before this post; by
    -- id, one of this SPACE. A null among them, which the api never sends, names none.
    SELECT coalesce(array_agg(r.raw ORDER BY r.i), '{}'::text[]),
           coalesce(array_agg(r.id ORDER BY r.i), '{}'::uuid[])
      INTO v_raw, v_ids
      FROM (SELECT e.v #>> '{}' AS raw, e.i,
                   CASE WHEN (e.v #>> '{}') ~ '^[1-9][0-9]{0,17}$'
                        THEN (SELECT p.post_id FROM posts p
                               WHERE p.space_id = NEW.space_id AND p.seq = (e.v #>> '{}')::bigint
                                 AND p.seq < NEW.seq)
                        ELSE (SELECT p.post_id FROM posts p
                               WHERE p.post_id = (e.v #>> '{}')::uuid AND p.space_id = NEW.space_id) END AS id
              FROM jsonb_array_elements(NEW.data->'sources') WITH ORDINALITY AS e(v, i)) r;
    FOR k IN 1..cardinality(v_ids) LOOP
      IF v_ids[k] IS NULL THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING DETAIL = coalesce(v_raw[k], 'null'); END IF;
    END LOOP;
    -- The same post by its id and by its seq: the first named again.
    SELECT v_raw[d.i] INTO v_twice
      FROM (SELECT u.i, row_number() OVER (PARTITION BY u.id ORDER BY u.i) AS nth
              FROM unnest(v_ids) WITH ORDINALITY AS u(id, i)) d
     WHERE d.nth > 1
     ORDER BY d.i
     LIMIT 1;
    IF v_twice IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'data.sources names one post twice: ' || v_twice;
    END IF;
    INSERT INTO post_sources (post_id, source_id, space_id, ord)
    SELECT NEW.post_id, u.id, NEW.space_id, u.i
      FROM unnest(v_ids) WITH ORDINALITY AS u(id, i);
    -- 0136: a member's warn or fail objects to each post of another author it cites.
    IF NEW.kind IN ('warn', 'fail') AND NOT NEW.no_role THEN
      INSERT INTO post_objections (source_id, post_id, space_id)
      SELECT u.id, NEW.post_id, NEW.space_id
        FROM unnest(v_ids) u(id) JOIN posts x ON x.post_id = u.id
       WHERE x.author_id <> NEW.author_id;
    END IF;
  END IF;

  IF NEW.kind = 'finding' AND NEW.data IS NOT NULL THEN
    SELECT coalesce(max(f.number), 0) + 1 INTO v_number FROM findings f WHERE f.space_id = NEW.space_id;
    INSERT INTO findings (post_id, space_id, number, claim, status, confidence, author_id, posted_at)
    VALUES (NEW.post_id, NEW.space_id, v_number, NEW.data->>'claim', NEW.data->>'status',
            NEW.data->>'confidence', NEW.author_id, NEW.posted_at);
  END IF;

  IF NEW.supersedes IS NOT NULL AND NEW.kind <> 'version' THEN
    UPDATE findings f SET superseded_by = NEW.post_id
     WHERE f.post_id = NEW.supersedes AND f.superseded_by IS NULL;
  END IF;
  IF NEW.retracts IS NOT NULL THEN
    UPDATE findings f SET retracted_by = NEW.post_id
     WHERE f.post_id = NEW.retracts AND f.retracted_by IS NULL;
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- S1: the warns and fails posted before this file
-- ─────────────────────────────────────────────────────────────────────────────

-- No post is written between here and commit, so none is missed: one written before the
-- lock is read by the backfill, and one after commit runs the new project_post().
LOCK TABLE schellingaf.posts IN SHARE ROW EXCLUSIVE MODE;
-- The warns and fails members posted before this file, with no notice. The owner's rule
-- applied to the record: a finding they cite reads contested from here on.
INSERT INTO schellingaf.post_objections (source_id, post_id, space_id)
SELECT ps.source_id, ps.post_id, ps.space_id
  FROM schellingaf.post_sources ps
  JOIN schellingaf.posts p ON p.post_id = ps.post_id
  JOIN schellingaf.posts x ON x.post_id = ps.source_id
 WHERE p.kind IN ('warn', 'fail') AND NOT p.no_role AND x.author_id <> p.author_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- S1: one reject made before 0116 kept the result it judged
-- ─────────────────────────────────────────────────────────────────────────────

-- Inferred, not proved: task 7 of cipher-trial-1, cycle 0, rejected before 0116 kept the
-- result a check judged. The checker's own post seq 36, nine seconds before the reject,
-- replies to seq 30 and opens "Check of T7 (seq 30)"; seq 30 carries task.reference
-- sp53-tempest:T7; a second checker (seq 37) replied to seq 30 too. A no-op where the row
-- is absent or already filled. post_id is left as it is.
ALTER TABLE schellingaf.task_checks DISABLE TRIGGER task_checks_immutable;
UPDATE schellingaf.task_checks SET result_post_id = '01a0f76b-f98d-73cc-bd7f-a374fc7126aa'
 WHERE task_id = '01a0f762-af09-7cb5-8686-675bcb1d2e15' AND cycle = 0
   AND verdict = 'reject' AND result_post_id IS NULL;
ALTER TABLE schellingaf.task_checks ENABLE TRIGGER task_checks_immutable;
