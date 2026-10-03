-- A task's words change, and each change keeps the words before it.
--
-- Until 3 October 2026 nothing changed what a task asks (0113_tasks.sql): a task written
-- wrong stayed wrong, and a coordinator could only add another beside it. This file lets an
-- open or claimed task change (proposal-self-harness, build task 1; its specification is
-- the website's docs/plan/self-harness-plan.md, sections A.1, A.2 and A.6):
--
--   change_task()     a coordinator or above changes the title, body, tag or after of an
--                     open or claimed task, naming the revision it read and why; the KEY
--                     that added a task changes it too, while nobody ever took it. The old
--                     words go to task_revisions, and the revision rises by one. A done or
--                     accepted task never changes.
--   task_reaches()    whether a new after would make a task wait for itself, walked under
--                     the SPACE lock.
--   take and renew    next and take_task set claim_revision, claimed_at and takes on a take
--                     only. A renewal leaves them, and answers changed_since_claim when the
--                     task changed after its holder took it.
--   task_done()       takes p_revision. A holder whose task changed after it took it is
--                     refused TASK_CHANGED until it sends the revision its result answers.
--                     The old signature stays, as a wrapper that sends none.
--   task_item()       answers revision, and changed, the newest change's by, at and reason.
--
-- Like the rest of a task, a change is no post, no event and no export: the row, its
-- revisions and its checks are the record. The holder of a claimed task is told,
-- task_changed, in its mailbox. Retire, delete, a coordinator's give-back and upkeep tasks
-- come in later files; protect_task() is written as a list of refusals they add to.

ALTER TABLE schellingaf.tasks
  -- 1 when added, and one more on every change of its words.
  ADD COLUMN revision       integer NOT NULL DEFAULT 1 CONSTRAINT tasks_revision_range CHECK (revision BETWEEN 1 AND 50),
  -- The revision, and the time, at which its holder took it; a renewal leaves both.
  ADD COLUMN claim_revision integer,
  ADD COLUMN claimed_at     timestamptz,
  -- How many times a KEY took it; a renewal is not a take.
  ADD COLUMN takes          integer NOT NULL DEFAULT 0 CONSTRAINT tasks_takes_counted CHECK (takes >= 0);

-- What the rows before this file can say. A task that is claimed, done or accepted, that a
-- reject reopened, or that carries progress was taken at least once; an open task that was
-- claimed and given back left no trace, and reads 0. A claim's start is its end less the
-- SPACE's claim hours, which is exact for a claim never renewed. No trigger refuses these
-- columns, so protect_task() is left on.
UPDATE schellingaf.tasks k
   SET takes = CASE WHEN k.state <> 'open' OR k.cycle > 0 OR k.progress_post_id IS NOT NULL THEN 1 ELSE 0 END,
       claim_revision = CASE WHEN k.claimed_by IS NOT NULL THEN 1 END,
       claimed_at = CASE WHEN k.state = 'claimed'
                         THEN k.claimed_until - make_interval(hours => sp.task_claim_hours) END
  FROM schellingaf.spaces sp
 WHERE sp.space_id = k.space_id
   AND (k.state <> 'open' OR k.cycle > 0 OR k.progress_post_id IS NOT NULL OR k.claimed_by IS NOT NULL);

-- Revision r's words, and the change that ended them: who, when and why. Never changed;
-- removed only with a task whose words were erased, which a later file allows.
CREATE TABLE schellingaf.task_revisions (
  task_id    uuid NOT NULL REFERENCES schellingaf.tasks,
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  revision   integer NOT NULL CHECK (revision >= 1),
  title      text NOT NULL,
  body       text NOT NULL,
  tag        text,
  waits_for  uuid[] NOT NULL,
  ended_by   schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  ended_at   timestamptz NOT NULL DEFAULT now(),
  end_reason text NOT NULL CONSTRAINT task_revisions_reason_length CHECK (char_length(end_reason) BETWEEN 1 AND 500),
  PRIMARY KEY (task_id, revision)
);

CREATE FUNCTION schellingaf.protect_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR NOT EXISTS (SELECT 1 FROM schellingaf.tasks k
                                      WHERE k.task_id = OLD.task_id AND k.state = 'deleted') THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER task_revisions_protect BEFORE UPDATE OR DELETE ON schellingaf.task_revisions
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_task_revision();

-- Read as a task's checks are: by whoever can read the SPACE.
ALTER TABLE schellingaf.task_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_revisions_read ON schellingaf.task_revisions FOR SELECT TO schellingaf_api
  USING (task_revisions.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(task_revisions.space_id));
GRANT SELECT ON schellingaf.task_revisions TO schellingaf_api;

-- What a task may never do, one refusal a line, so a later file adds its own. Its id, SPACE,
-- number, author and time added never change, a task is never deleted, and the cycle and
-- the revision never go back. Its words change only one revision up, only with the words
-- before kept in task_revisions, and never once it is done or accepted. Progress, once
-- linked, is never cleared.
CREATE OR REPLACE FUNCTION schellingaf.protect_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF NEW.task_id <> OLD.task_id OR NEW.space_id <> OLD.space_id OR NEW.number <> OLD.number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  IF NEW.cycle < OLD.cycle OR NEW.revision < OLD.revision THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF OLD.progress_post_id IS NOT NULL AND NEW.progress_post_id IS NULL THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF NEW.title <> OLD.title OR NEW.body <> OLD.body OR NEW.tag IS DISTINCT FROM OLD.tag
     OR NEW.waits_for <> OLD.waits_for THEN
    IF OLD.state IN ('done', 'accepted') OR NEW.revision <> OLD.revision + 1
       OR NOT EXISTS (SELECT 1 FROM schellingaf.task_revisions r
                       WHERE r.task_id = OLD.task_id AND r.revision = OLD.revision) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- The lowest number of a task in p_from from which p_targets is reached by following
-- after, each task counted as reaching itself; null when none does. A new after that
-- reaches the task it is set on would make that task wait for itself. Walked under the
-- SPACE lock its caller holds, in this SPACE only, each task once from each start.
-- Internal: change_task() calls it.
CREATE FUNCTION schellingaf.task_reaches(p_space uuid, p_from uuid[], p_targets uuid[])
  RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH RECURSIVE walk(origin, task_id) AS (
    SELECT f.id, f.id FROM unnest(p_from) f(id)
    UNION
    SELECT w.origin, x.id
      FROM walk w
      JOIN schellingaf.tasks k ON k.task_id = w.task_id AND k.space_id = p_space
     CROSS JOIN LATERAL unnest(k.waits_for) x(id)
  )
  SELECT min(o.number)
    FROM walk w
    JOIN schellingaf.tasks o ON o.task_id = w.origin AND o.space_id = p_space
   WHERE w.task_id = ANY (p_targets)
$$;

-- One task as every answer shows it, as 0129_task_after_numbers.sql made it, with its
-- revision and, once it changed, changed: the newest change's KEY, time and reason, read
-- from the revision row its change ended. The reason is what a PEER wrote.
CREATE OR REPLACE FUNCTION schellingaf.task_item(t schellingaf.tasks, p_required integer)
  RETURNS jsonb
  LANGUAGE sql STABLE
  RETURN jsonb_build_object(
      'task_id', t.task_id, 'number', t.number, 'title', t.title, 'body', t.body, 'tag', t.tag,
      'after', to_jsonb(t.waits_for),
      'after_numbers', (SELECT coalesce(jsonb_agg(w.number ORDER BY w.ord), '[]'::jsonb)
                          FROM (SELECT o.ord,
                                       (SELECT k.number FROM schellingaf.tasks k
                                         WHERE k.task_id = o.task_id AND k.space_id = t.space_id) AS number
                                  FROM unnest(t.waits_for) WITH ORDINALITY o(task_id, ord)) w),
      'state', CASE WHEN t.state = 'claimed' AND t.claimed_until <= now() THEN 'open' ELSE t.state END,
      'cycle', t.cycle,
      'revision', t.revision,
      'created_by', encode(t.created_by, 'hex'), 'created_at', t.created_at,
      'claimed_by', encode(t.claimed_by, 'hex'), 'claimed_until', t.claimed_until,
      'done_post_id', t.done_post_id, 'done_at', t.done_at, 'accepted_at', t.accepted_at,
      'confirmations', jsonb_build_object(
        'required', p_required,
        'given', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                    FROM schellingaf.task_checks c
                   WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.verdict = 'confirm')))
    || CASE WHEN t.state = 'claimed' AND t.claimed_until <= now()
            THEN jsonb_build_object('claim_expired', true) ELSE '{}'::jsonb END
    || coalesce((SELECT jsonb_build_object('rejected', jsonb_build_object(
                          'by', encode(r.peer_id, 'hex'), 'reason', r.reason, 'at', r.checked_at))
                   FROM schellingaf.task_checks r
                  WHERE r.task_id = t.task_id AND r.cycle = t.cycle - 1 AND r.verdict = 'reject'), '{}'::jsonb)
    || coalesce((SELECT jsonb_build_object('progress', jsonb_build_object(
                          'post_id', v.post_id, 'title', v.title, 'by', encode(v.author_id, 'hex'), 'at', t.progress_at))
                   FROM schellingaf.visible_posts v
                  WHERE v.post_id = t.progress_post_id), '{}'::jsonb)
    || coalesce((SELECT jsonb_build_object('changed', jsonb_build_object(
                          'by', encode(h.ended_by, 'hex'), 'at', h.ended_at, 'reason', h.end_reason))
                   FROM schellingaf.task_revisions h
                  WHERE h.task_id = t.task_id AND h.revision = t.revision - 1), '{}'::jsonb);

-- A task's words changed by p_actor: p_change holds the fields to set, each only when
-- present, as the route read them: title, body, tag (null clears it) and after (a list of
-- {"number": n} or {"task_id": id}; empty clears it). p_revision is the revision the caller
-- read, and p_reason why. A coordinator or above changes an open or claimed task; the KEY
-- that added a task changes it while nobody ever took it. A claim stays where it is: its
-- holder is told, task_changed, and its done then needs the new revision. after names
-- tasks of this SPACE, never a loop back to this task; a task it names that is not yet
-- accepted gates only taking. A task changes at most p_revisions_max - 1 times. Who may,
-- and in what order, as task_done(); deliveries answered only with p_deliveries, as
-- task_release() answers them.
CREATE FUNCTION schellingaf.change_task(p_space_name text, p_actor bytea, p_number integer, p_revision integer,
                                        p_reason text, p_change jsonb, p_revisions_max integer DEFAULT 50,
                                        p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_after uuid[]; v_bad text; v_loop integer;
  v_holder bytea; v_delivered jsonb := '[]'::jsonb;
BEGIN
  -- Shape, before anything is read. The route checked all of it; this holds what keeps
  -- the table sound whoever calls.
  IF p_revision IS NULL OR p_revision < 1 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'revision is the revision you read, a whole number from 1';
  END IF;
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: say why you change the task, in 1 to 500 characters';
  END IF;
  IF jsonb_typeof(p_change) IS DISTINCT FROM 'object' OR NOT (p_change ?| ARRAY['title', 'body', 'tag', 'after']) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'send at least one of title, body, tag and after';
  END IF;
  IF (p_change ? 'title' AND jsonb_typeof(p_change->'title') IS DISTINCT FROM 'string')
     OR (p_change ? 'body' AND jsonb_typeof(p_change->'body') IS DISTINCT FROM 'string')
     OR (p_change ? 'after' AND (jsonb_typeof(p_change->'after') IS DISTINCT FROM 'array'
                                 OR jsonb_array_length(p_change->'after') > 8
                                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_change->'after') a(v)
                                             WHERE NOT (a.v ? 'number' OR a.v ? 'task_id')))) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'title and body are text; after is a list of up to 8 task numbers or task_ids';
  END IF;

  -- Unlocked pre-check: a KEY that may change nothing never waits on the SPACE's lock.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 20 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  v_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF v_rank < 20 THEN RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex'); END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO t FROM tasks k WHERE k.space_id = s.space_id AND k.number = p_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
  -- Below a coordinator, only the KEY that added it, and only while nobody ever took it.
  IF v_rank < 25 AND NOT (t.created_by = p_actor AND t.takes = 0) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF p_revision <> t.revision THEN RAISE EXCEPTION 'TASK_CHANGED' USING DETAIL = t.revision::text; END IF;
  IF t.revision >= p_revisions_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = 'revisions: ' || p_revisions_max;
  END IF;

  IF p_change ? 'after' THEN
    -- The first entry, in the order sent, that names no task of this SPACE.
    SELECT coalesce(a.v->>'number', a.v->>'task_id') INTO v_bad
      FROM jsonb_array_elements(p_change->'after') WITH ORDINALITY a(v, j)
     WHERE NOT EXISTS (SELECT 1 FROM tasks x
                        WHERE x.space_id = s.space_id
                          AND CASE WHEN a.v ? 'number' THEN x.number = (a.v->>'number')::int
                                   ELSE x.task_id = (a.v->>'task_id')::uuid END)
     ORDER BY a.j
     LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = v_bad; END IF;
    SELECT coalesce(array_agg(DISTINCT x.task_id), '{}'::uuid[]) INTO v_after
      FROM jsonb_array_elements(p_change->'after') a(v)
      JOIN tasks x ON x.space_id = s.space_id
                  AND CASE WHEN a.v ? 'number' THEN x.number = (a.v->>'number')::int
                           ELSE x.task_id = (a.v->>'task_id')::uuid END;
    v_loop := task_reaches(s.space_id, v_after, ARRAY[t.task_id]);
    IF v_loop IS NOT NULL THEN RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = 'loop: ' || v_loop; END IF;
  END IF;

  INSERT INTO task_revisions (task_id, space_id, revision, title, body, tag, waits_for, ended_by, end_reason)
  VALUES (t.task_id, t.space_id, t.revision, t.title, t.body, t.tag, t.waits_for, p_actor, p_reason);
  -- A claim, live or passed and not taken since, stays with its holder, who is told.
  v_holder := CASE WHEN t.state = 'claimed' THEN t.claimed_by END;
  UPDATE tasks k
     SET title = CASE WHEN p_change ? 'title' THEN p_change->>'title' ELSE k.title END,
         body = CASE WHEN p_change ? 'body' THEN p_change->>'body' ELSE k.body END,
         tag = CASE WHEN p_change ? 'tag' THEN p_change->>'tag' ELSE k.tag END,
         waits_for = CASE WHEN p_change ? 'after' THEN v_after ELSE k.waits_for END,
         revision = k.revision + 1
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  IF v_holder IS NOT NULL THEN
    v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[v_holder], ARRAY['task_changed']);
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- The next piece of work, as 0113_tasks.sql made it, with a take now setting the revision
-- and the time it was taken at, and counting the take. A renewal leaves all three, and
-- answers changed_since_claim when the task changed after its holder took it.
CREATE OR REPLACE FUNCTION schellingaf.next_task(p_space_name text, p_actor bytea, p_tag text DEFAULT NULL,
                                                 p_verify boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_renewed boolean := false;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor)
       < (CASE WHEN p_verify AND s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor)
       < (CASE WHEN p_verify AND s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  IF p_verify THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.claimed_by <> p_actor
       AND (p_tag IS NULL OR d.tag = p_tag)
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.peer_id = p_actor)
     ORDER BY d.number
     LIMIT 1;
    RETURN jsonb_build_object('space', s.name, 'verify', true,
                              'task', CASE WHEN FOUND THEN task_item(t, s.task_confirmations) END);
  END IF;

  UPDATE tasks h SET claimed_until = now() + make_interval(hours => s.task_claim_hours)
   WHERE h.task_id = (SELECT m.task_id FROM tasks m
                       WHERE m.space_id = s.space_id AND m.state = 'claimed' AND m.claimed_by = p_actor
                         AND (p_tag IS NULL OR m.tag = p_tag)
                       ORDER BY m.number
                       LIMIT 1
                       FOR UPDATE)
  RETURNING * INTO t;
  v_renewed := FOUND;

  IF NOT v_renewed THEN
    UPDATE tasks c SET state = 'claimed', claimed_by = p_actor,
                       claimed_until = now() + make_interval(hours => s.task_claim_hours),
                       claim_revision = c.revision, claimed_at = now(), takes = c.takes + 1
     WHERE c.task_id = (SELECT o.task_id FROM tasks o
                         WHERE o.space_id = s.space_id AND o.state IN ('open', 'claimed')
                           AND (o.state = 'open' OR o.claimed_until <= now())
                           AND (p_tag IS NULL OR o.tag = p_tag)
                           AND NOT EXISTS (SELECT 1 FROM tasks a
                                            WHERE a.task_id = ANY (o.waits_for) AND a.state <> 'accepted')
                         ORDER BY o.number
                         LIMIT 1
                         FOR UPDATE SKIP LOCKED)
    RETURNING * INTO t;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('space', s.name, 'verify', false, 'task', NULL);
    END IF;
  END IF;

  RETURN jsonb_build_object('space', s.name, 'verify', false, 'renewed', v_renewed,
                            'task', task_item(t, s.task_confirmations))
         || CASE WHEN v_renewed AND t.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', t.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END;
END $$;

-- next with a number, as 0125_task_progress.sql made it, with a take setting and counting
-- as next_task() does, and a renewal answering changed_since_claim.
CREATE OR REPLACE FUNCTION schellingaf.take_task(p_space_name text, p_actor bytea, p_number integer,
                                                 p_held_max integer DEFAULT 3)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_renewed boolean; v_waiting integer;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 20 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 20 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO t FROM tasks k WHERE k.space_id = s.space_id AND k.number = p_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
  v_renewed := t.state = 'claimed' AND t.claimed_by = p_actor;
  IF NOT v_renewed AND t.state = 'claimed' AND t.claimed_until > now() THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed';
  END IF;
  -- A take, or a claim of the caller's own that passed brought back: the caller's other
  -- live claims, read from the tasks waiting to be done, under the SPACE lock, so two
  -- calls at once cannot both take the last place.
  IF (NOT v_renewed OR t.claimed_until <= now())
     AND (SELECT count(*) FROM tasks h
           WHERE h.space_id = s.space_id AND h.state = 'claimed' AND h.claimed_by = p_actor
             AND h.claimed_until > now() AND h.task_id <> t.task_id) >= p_held_max THEN
    RAISE EXCEPTION 'TASK_HOLD_LIMIT' USING DETAIL = p_held_max::text;
  END IF;
  IF NOT v_renewed THEN
    SELECT a.number INTO v_waiting FROM tasks a
     WHERE a.task_id = ANY (t.waits_for) AND a.state <> 'accepted'
     ORDER BY a.number LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_WAITING' USING DETAIL = v_waiting::text; END IF;
  END IF;

  UPDATE tasks k SET state = 'claimed', claimed_by = p_actor,
                     claimed_until = now() + make_interval(hours => s.task_claim_hours),
                     claim_revision = CASE WHEN v_renewed THEN k.claim_revision ELSE k.revision END,
                     claimed_at = CASE WHEN v_renewed THEN k.claimed_at ELSE now() END,
                     takes = k.takes + CASE WHEN v_renewed THEN 0 ELSE 1 END
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'verify', false, 'renewed', v_renewed,
                            'task', task_item(t, s.task_confirmations))
         || CASE WHEN v_renewed AND t.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', t.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END;
END $$;

-- A task marked done, as 0113_tasks.sql made it, with p_revision: the revision the
-- holder's result answers. After the retry of the same post, which answers what the first
-- call did, a holder is refused TASK_CHANGED, naming the revision now, when p_revision is
-- sent and is not the task's revision, or is not sent and the task changed after the
-- holder took it. A new parameter is a new signature, so the four-argument one stays below
-- as a wrapper for the release before, which sends none.
CREATE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                      p_revision integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 20 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 20 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO t FROM tasks k WHERE k.space_id = s.space_id AND k.number = p_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  -- A retry after a lost answer: what the first call did stands.
  IF t.state IN ('done', 'accepted') AND t.claimed_by = p_actor AND t.done_post_id = p_post THEN
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
  END IF;
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
  -- Held by nobody, or by a KEY whose claim has passed: the caller takes it first.
  IF t.state = 'open' OR (t.claimed_by <> p_actor AND t.claimed_until <= now()) THEN
    RAISE EXCEPTION 'TASK_NOT_CLAIMANT';
  END IF;
  IF t.claimed_by <> p_actor THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed'; END IF;
  -- The words changed after the holder took them, or after the revision it sent.
  IF (p_revision IS NOT NULL AND p_revision <> t.revision)
     OR (p_revision IS NULL AND t.claim_revision < t.revision) THEN
    RAISE EXCEPTION 'TASK_CHANGED' USING DETAIL = t.revision::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM posts p
                  WHERE p.post_id = p_post AND p.space_id = s.space_id AND p.author_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_POST_NOT_FOUND';
  END IF;

  UPDATE tasks k
     SET state = CASE WHEN s.task_confirmations = 0 THEN 'accepted' ELSE 'done' END,
         claimed_until = NULL, done_post_id = p_post, done_at = now(),
         accepted_at = CASE WHEN s.task_confirmations = 0 THEN now() END
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- As the release before called it: task_done() with no revision, so a task that changed
-- after its holder took it is refused until a caller sends the revision.
CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.task_done(p_space_name, p_actor, p_number, p_post, NULL::integer);

GRANT EXECUTE ON FUNCTION
  schellingaf.change_task(text, bytea, integer, integer, text, jsonb, integer, boolean),
  schellingaf.task_done(text, bytea, integer, uuid, integer)
TO schellingaf_api;
