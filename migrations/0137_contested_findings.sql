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
-- and the fill of task 7 of cipher-trial-1. S2, the notice: deliver_notices(), which
-- deliver_task_notices() now wraps, contested_findings(), task_check()'s reject block,
-- contest_notices() and charge_tokens_each().

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- Tables locked in the order a POST takes them: append_post() updates spaces, then
-- inserts into posts, and a check then writes task_checks. spaces and posts here, first;
-- task_checks last, by the fill; S2 replaces functions and locks no table.
-- CREATE TABLE below locks posts before spaces for its foreign keys, so without this a
-- POST between its two statements deadlocked the migration. From here to commit no post
-- is written, so the backfill misses none: one written before this lock is read by it,
-- and one after commit runs the new project_post(). No lock_timeout: an anti-wraparound
-- vacuum of posts never yields its lock, and a timeout would fail the deploy over it.
LOCK TABLE schellingaf.spaces, schellingaf.posts IN SHARE ROW EXCLUSIVE MODE;

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
    -- 0137: a member's warn or fail objects to each post of another author it cites.
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

-- posts is locked since the top of this file, so the backfill misses no post.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- S2: one body for every notice a task or a contest writes
-- ─────────────────────────────────────────────────────────────────────────────

-- One notice a row, under the SPACE lock its caller holds. Row i is about p_posts[i] when
-- that is not null (no task, no actor stored: the subject check), or else about p_task in
-- p_cycle from p_actor. Never to p_actor; only to a KEY that reads the SPACE (public, its
-- owner, or a member) and has a mailbox; a post a mailbox already holds is skipped, so
-- deliveries_post_uq never refuses and numbers stay gap-free. Every mailbox locked in one
-- ascending statement, then numbered and written in one more. Internal: never granted.
CREATE FUNCTION schellingaf.deliver_notices(p_space uuid, p_actor bytea, p_task uuid, p_cycle integer,
                                            p_peers bytea[], p_reasons text[], p_posts uuid[])
  RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_peers bytea[]; v_reasons text[]; v_posts uuid[]; held bytea[]; delivered jsonb := '[]';
BEGIN
  SELECT coalesce(array_agg(u.peer ORDER BY u.peer, u.i), '{}'),
         coalesce(array_agg(u.reason ORDER BY u.peer, u.i), '{}'),
         coalesce(array_agg(u.post ORDER BY u.peer, u.i), '{}')
    INTO v_peers, v_reasons, v_posts
    FROM (SELECT DISTINCT ON (x.peer, coalesce(x.post, '00000000-0000-0000-0000-000000000000'::uuid), x.reason) x.*
            FROM unnest(p_peers, p_reasons, p_posts) WITH ORDINALITY AS x(peer, reason, post, i)
           ORDER BY x.peer, coalesce(x.post, '00000000-0000-0000-0000-000000000000'::uuid), x.reason, x.i) u
    JOIN spaces sp ON sp.space_id = p_space
   WHERE u.peer IS NOT NULL AND u.peer <> p_actor
     AND (sp.visibility = 'public' OR u.peer = sp.owner_id
          OR EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = p_space AND mm.peer_id = u.peer))
     AND EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.peer_id = u.peer)
     AND (u.post IS NULL OR NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                                         WHERE md.recipient_id = u.peer AND md.post_id = u.post));
  IF cardinality(v_peers) = 0 THEN RETURN delivered; END IF;
  SELECT coalesce(array_agg(l.peer), '{}') INTO held
    FROM (SELECT mb.peer_id::bytea AS peer FROM mailboxes mb
           WHERE mb.peer_id = ANY(v_peers) ORDER BY mb.peer_id FOR UPDATE) l;
  WITH wanted AS (
    SELECT u.peer, u.reason, u.post, row_number() OVER (PARTITION BY u.peer ORDER BY u.i) AS k
      FROM unnest(v_peers, v_reasons, v_posts) WITH ORDINALITY AS u(peer, reason, post, i)
  ), bumped AS (
    UPDATE mailboxes mb SET last_seq = mb.last_seq + x.c
      FROM (SELECT wt.peer, count(*) AS c FROM wanted wt GROUP BY wt.peer) x
     WHERE mb.peer_id = x.peer
    RETURNING mb.peer_id::bytea AS peer, mb.last_seq - x.c AS base
  ), made AS (
    INSERT INTO mailbox_deliveries AS dl (recipient_id, mailbox_seq, post_id, task_id, task_cycle, actor_id, space_id, reason)
    SELECT wt.peer, b.base + wt.k, wt.post,
           CASE WHEN wt.post IS NULL THEN p_task END, CASE WHEN wt.post IS NULL THEN p_cycle END,
           CASE WHEN wt.post IS NULL THEN p_actor END, p_space, wt.reason
      FROM wanted wt JOIN bumped b ON b.peer = wt.peer
    RETURNING dl.recipient_id::bytea AS recipient, dl.mailbox_seq, dl.reason
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('recipient', encode(made.recipient, 'hex'),
                                               'mailbox_seq', made.mailbox_seq::text, 'reason', made.reason)
                            ORDER BY made.recipient, made.mailbox_seq), '[]') INTO delivered FROM made;
  RETURN delivered;
END $$;

-- 0116's notices of a task, now the task rows of deliver_notices(): same signature, same
-- answers. Every caller sends each peer once a reason, so the repeat deliver_notices()
-- drops never comes from here.
CREATE OR REPLACE FUNCTION schellingaf.deliver_task_notices(p_space uuid, p_task uuid, p_cycle integer, p_actor bytea,
                                                            p_peers bytea[], p_reasons text[])
  RETURNS jsonb
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  RETURN deliver_notices(p_space, p_actor, p_task, p_cycle, p_peers, p_reasons,
                         array_fill(NULL::uuid, ARRAY[cardinality(p_peers)]));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- S2: who a contest tells
-- ─────────────────────────────────────────────────────────────────────────────

-- The standing findings of p_space that are one of p_posts or rest on one, posted at or
-- before p_before, whose author is not p_actor and has not been handed that finding: the
-- newest cap('contested_notices'). Per cited post, walks the newest cap('contested_scan')
-- citing posts of post_sources_cited_idx (source_id, post_id) backward, with no sort, then
-- probes findings by key, one lateral with limit 1 a post: a join let the generic plan
-- read every finding of the database into a hash. A finding past the scan is marked in
-- every read and told nothing. Then the newest of the union, a bounded sort. Internal.
-- Measured on 4 October 2026, generic plans, a test database with 20,000 findings: a reject
-- of a result 5,000 non-finding posts cite took 1.0 ms in task_check() (median of 7); a
-- warn citing 32 sources, one cited by 5,000 posts and 31 by 600 each, so 16,000 citers
-- walked and probed, took 10.8 ms in contest_notices(). Target: under 20 ms.
CREATE FUNCTION schellingaf.contested_findings(p_space uuid, p_posts uuid[], p_actor bytea, p_before timestamptz)
  RETURNS TABLE (peer bytea, post uuid)
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT c.peer, c.post
    FROM (SELECT DISTINCT z.id FROM (
            SELECT x.id FROM unnest(p_posts) x(id)
            UNION ALL
            SELECT n.post_id FROM unnest(p_posts) x(id)
             CROSS JOIN LATERAL (SELECT s.post_id FROM post_sources s
                                  WHERE s.source_id = x.id
                                  ORDER BY s.source_id DESC, s.post_id DESC
                                  LIMIT cap('contested_scan')) n) z) k
   CROSS JOIN LATERAL (SELECT f.author_id::bytea AS peer, f.post_id AS post FROM findings f
                        WHERE f.post_id = k.id AND f.space_id = p_space
                          AND f.superseded_by IS NULL AND f.retracted_by IS NULL
                          AND f.posted_at <= p_before AND f.author_id <> p_actor
                          AND NOT EXISTS (SELECT 1 FROM space_hidden hd WHERE hd.post_id = f.post_id)
                          AND NOT EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = f.post_id AND w.released_at IS NULL)
                          AND NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                                           WHERE md.recipient_id = f.author_id AND md.post_id = f.post_id)
                        LIMIT 1) c
   ORDER BY c.post DESC
   LIMIT cap('contested_notices')
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- S2: a reject tells the findings it contests
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0134_task_upkeep.sql made it, with one change, the block marked 0137 in the reject
-- branch: the notice to the holder and the voided confirmers is written in the same
-- deliver_notices() call as a contested notice to each finding's author. v_cycle is the
-- checked cycle there: it is read before the update moves the task to the next one.
CREATE OR REPLACE FUNCTION schellingaf.task_check(p_space_name text, p_actor bytea, p_number integer, p_verdict text,
                                                  p_post uuid DEFAULT NULL, p_reason text DEFAULT NULL,
                                                  p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; r task_checks%ROWTYPE; v_given bigint; v_state text;
        v_holder bytea; v_cycle integer; v_peers bytea[]; v_delivered jsonb := '[]';
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('confirm', 'reject') THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  IF p_verdict = 'reject' AND (p_reason IS NULL OR p_reason = '') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: a reject says what failed';
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor)
       < (CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor)
       < (CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO t FROM tasks k WHERE k.space_id = s.space_id AND k.number = p_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;  -- 0132
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;  -- 0134
  IF t.state <> 'done' THEN
    v_state := CASE WHEN t.state = 'claimed' AND t.claimed_until <= now() THEN 'open' ELSE t.state END;
    IF t.state IN ('open', 'claimed') AND t.cycle > 0 THEN
      SELECT * INTO r FROM task_checks c
       WHERE c.task_id = t.task_id AND c.cycle = t.cycle - 1 AND c.verdict = 'reject';
      IF FOUND AND NOT p_deliveries THEN
        RAISE EXCEPTION 'TASK_NOT_DONE' USING DETAIL = v_state || ': rejected by ' || encode(r.peer_id, 'hex');
      END IF;
      IF FOUND THEN
        IF NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                        WHERE md.recipient_id = p_actor AND md.task_id = t.task_id
                          AND md.task_cycle = r.cycle AND md.reason = 'task_rejected') THEN
          v_delivered := deliver_task_notices(s.space_id, t.task_id, r.cycle, r.peer_id,
                                              ARRAY[p_actor], ARRAY['task_rejected']);
        END IF;
        RETURN jsonb_build_object('refused', 'TASK_NOT_DONE',
                                  'detail', v_state || ': rejected by ' || encode(r.peer_id, 'hex'),
                                  'delivered', v_delivered);
      END IF;
    END IF;
    RAISE EXCEPTION 'TASK_NOT_DONE' USING DETAIL = v_state;
  END IF;
  IF t.claimed_by = p_actor THEN RAISE EXCEPTION 'TASK_SELF_CHECK'; END IF;
  IF EXISTS (SELECT 1 FROM task_checks c
              WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.peer_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_ALREADY_CHECKED';
  END IF;
  IF p_post IS NOT NULL AND NOT EXISTS (SELECT 1 FROM posts p
                                         WHERE p.post_id = p_post AND p.space_id = s.space_id
                                           AND p.author_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_POST_NOT_FOUND';
  END IF;

  INSERT INTO task_checks (task_id, space_id, cycle, peer_id, verdict, post_id, reason, result_post_id)
  VALUES (t.task_id, s.space_id, t.cycle, p_actor, p_verdict, p_post, nullif(p_reason, ''), t.done_post_id);
  v_holder := t.claimed_by;
  v_cycle := t.cycle;

  IF p_verdict = 'confirm' THEN
    SELECT count(*) INTO v_given FROM task_checks c
     WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.verdict = 'confirm';
    IF v_given >= s.task_confirmations THEN
      UPDATE tasks k SET state = 'accepted', accepted_at = now()
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
    END IF;
    v_delivered := deliver_task_notices(s.space_id, t.task_id, v_cycle, p_actor, ARRAY[v_holder],
                                        ARRAY[CASE WHEN t.state = 'accepted' THEN 'task_accepted' ELSE 'task_confirmed' END]);
  ELSE
    UPDATE tasks k SET state = 'open', cycle = k.cycle + 1, claimed_by = NULL, claimed_until = NULL,
                       done_post_id = NULL, done_at = NULL
     WHERE k.task_id = t.task_id
    RETURNING * INTO t;
    -- Its holder, and the KEYS whose confirmations of that cycle the reject voided.
    SELECT coalesce(array_agg(q.x ORDER BY q.x), '{}'::bytea[]) INTO v_peers
      FROM (SELECT v_holder AS x
            UNION
            SELECT c.peer_id FROM task_checks c
             WHERE c.task_id = t.task_id AND c.cycle = v_cycle AND c.verdict = 'confirm') q;
    -- 0137 BEGIN contested: the same delivery tells the author of each standing finding
    -- that is this result or rests on it, once a finding. The result is read from the check
    -- just made, which kept it before the update above cleared it. clock_timestamp(), taken
    -- under the SPACE lock, never now(): a finding written while this call waited for that
    -- lock is posted after the transaction began, and would be marked and never told.
    SELECT deliver_notices(s.space_id, p_actor, t.task_id, v_cycle,
             v_peers || coalesce(array_agg(c.peer ORDER BY c.peer, c.post) FILTER (WHERE c.peer IS NOT NULL), '{}'),
             array_fill('task_rejected'::text, ARRAY[cardinality(v_peers)])
               || coalesce(array_agg('contested'::text ORDER BY c.peer, c.post) FILTER (WHERE c.peer IS NOT NULL), '{}'),
             array_fill(NULL::uuid, ARRAY[cardinality(v_peers)])
               || coalesce(array_agg(c.post ORDER BY c.peer, c.post) FILTER (WHERE c.peer IS NOT NULL), '{}'))
      INTO v_delivered
      FROM task_checks k
      LEFT JOIN LATERAL contested_findings(s.space_id, ARRAY[k.result_post_id], p_actor, clock_timestamp()) c ON true
     WHERE k.task_id = t.task_id AND k.cycle = v_cycle AND k.peer_id = p_actor;
    -- 0137 END contested
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- S2: a member's warn or fail tells the findings it contests
-- ─────────────────────────────────────────────────────────────────────────────

-- After a member's warn or fail is written, in the same transaction: the author of each
-- standing finding it marks, cited or resting on a post it cites, is told once a finding as
-- contested. Only posts it objects to count, so never a post of its own author: its own
-- sources, at most 32, each probed in post_objections by key. Answers what it delivered,
-- for the route. Only for p_actor's own post. A call tells at most the newest
-- cap('contested_notices') findings not yet told, so a second call is not a no-op: it tells the
-- next ones. The posts route calls it once a warn: a replay skips the call, and a retry
-- after a deadlock rolled the first call back with the POST, so each warn is told once.
CREATE FUNCTION schellingaf.contest_notices(p_post uuid, p_actor bytea) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE w posts%ROWTYPE; v_peers bytea[]; v_posts uuid[];
BEGIN
  SELECT * INTO w FROM posts p
   WHERE p.post_id = p_post AND p.author_id = p_actor AND p.kind IN ('warn', 'fail') AND NOT p.no_role;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  -- The SPACE lock append_post took in this transaction: taken again, it waits on nothing.
  PERFORM 1 FROM spaces sp WHERE sp.space_id = w.space_id FOR NO KEY UPDATE;
  -- append_post refused a blocked KEY already; checked again so no write here skips it.
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  SELECT coalesce(array_agg(c.peer ORDER BY c.peer, c.post), '{}'),
         coalesce(array_agg(c.post ORDER BY c.peer, c.post), '{}')
    INTO v_peers, v_posts
    FROM contested_findings(w.space_id,
           ARRAY(SELECT o.source_id FROM post_sources s
                   JOIN post_objections o ON o.source_id = s.source_id AND o.post_id = s.post_id
                  WHERE s.post_id = w.post_id), p_actor, w.posted_at) c;
  RETURN deliver_notices(w.space_id, p_actor, NULL, NULL, v_peers,
                         array_fill('contested'::text, ARRAY[cardinality(v_peers)]), v_posts);
END $$;
GRANT EXECUTE ON FUNCTION schellingaf.contest_notices(uuid, bytea) TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- S2: each bucket charged once, with its total
-- ─────────────────────────────────────────────────────────────────────────────

-- charge_tokens_all() with a cost a key, which charge() in src/http/ratelimit.ts calls
-- with each key once and its total: a warn telling one author of 200 findings updates each
-- of that author's buckets once, not 200 times. Each charged as charge_tokens() charges
-- it, in key order, so two calls that share buckets never wait on each other. A key named
-- twice is charged once, with the sum of its costs. charge_tokens_all() stays for an api
-- still running the code before this file.
CREATE FUNCTION schellingaf.charge_tokens_each(
  p_keys text[], p_capacities double precision[], p_refills_per_sec double precision[],
  p_costs double precision[])
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE b record;
BEGIN
  FOR b IN SELECT u.k, min(u.c) AS c, min(u.r) AS r, sum(u.n) AS n
             FROM unnest(p_keys, p_capacities, p_refills_per_sec, p_costs) AS u(k, c, r, n)
            GROUP BY u.k ORDER BY u.k LOOP
    PERFORM charge_tokens(b.k, b.c, b.r, b.n);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION
  schellingaf.charge_tokens_each(text[], double precision[], double precision[], double precision[])
TO schellingaf_api;
