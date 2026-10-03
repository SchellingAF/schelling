-- A task is retired, replaced or deleted.
--
-- Until 3 October 2026 a task stayed on its list for good: one written wrong, or made
-- pointless by another's result, could only be left open or worked against. This file adds
-- two final states (proposal-self-harness, build tasks 4 and 5; its specification is the
-- website's docs/plan/self-harness-plan.md, sections A.1, A.3, A.4 and A.7):
--
--   retired   ended before it was accepted, by a coordinator or above, with a reason:
--             retire_task(). It keeps its words, any result and its checks; a claim on it
--             ends. Sent with tasks, the retire adds them in its place, its replacements,
--             in add_tasks()' own insert. Every open or claimed task that waited for it
--             then waits for what it waited for, not yet accepted, and for its
--             replacements: each such rewrite is a change, one revision up, its holder told.
--   deleted   a task nobody ever took, its words erased: delete_task(), by the owner or an
--             admin, or by the KEY that added it while every revision is its own. Its row,
--             number and id stay, so a number is never used twice and every reference to
--             it still holds; its revisions are removed. Refused while another task not
--             yet accepted, retired or deleted waits for it.
--
-- Neither state ever goes back, and a retired task may still be deleted while nobody ever
-- took it. A retired or deleted task named in after is refused everywhere a task names
-- another. Every task function answers a retired task TASK_NOT_OPEN (a check
-- TASK_NOT_DONE) and a deleted one TASK_NOT_FOUND, each with the state as its detail. The
-- list shows a retired task and never a deleted one; a read by number shows both. A
-- retired or deleted task is never counted as accepted (space_counts()).
--
-- Like the rest of a task, a retire or a delete is no post, no event and no export: the
-- row, its revisions and its checks are the record. Those it concerns are told in their
-- mailbox: task_retired, task_deleted, and task_changed for a rewritten wait.

-- ─────────────────────────────────────────────────────────────────────────────
-- The states and the columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE schellingaf.tasks
  -- Who retired or deleted it, when and why. closed_by is null only where the service
  -- retires an upkeep task, which a later file adds; a delete always names its KEY.
  ADD COLUMN closed_by    schellingaf.bytes32 REFERENCES schellingaf.peers,
  ADD COLUMN closed_at    timestamptz,
  ADD COLUMN close_reason text CONSTRAINT tasks_close_reason_length CHECK (char_length(close_reason) BETWEEN 1 AND 500),
  -- The tasks a retire added in its place, in the order sent.
  ADD COLUMN replaced_by  uuid[] NOT NULL DEFAULT '{}' CONSTRAINT tasks_replaced_by_count CHECK (cardinality(replaced_by) <= 20);

-- The constraints a new state changes, swapped without reading the table under the swap's
-- lock, then checked.
ALTER TABLE schellingaf.tasks
  DROP CONSTRAINT tasks_state_known,
  ADD CONSTRAINT tasks_state_known
    CHECK (state IN ('open', 'claimed', 'done', 'accepted', 'retired', 'deleted')) NOT VALID,
  -- An erased title is empty.
  DROP CONSTRAINT tasks_title_length,
  ADD CONSTRAINT tasks_title_length
    CHECK (char_length(title) BETWEEN 1 AND 200 OR state = 'deleted') NOT VALID,
  -- A retired task keeps who did it and its result, if it was done, and nothing else of a
  -- claim. A deleted task was never taken, and holds no words.
  DROP CONSTRAINT tasks_state_shape,
  ADD CONSTRAINT tasks_state_shape CHECK (CASE state
    WHEN 'open' THEN claimed_by IS NULL AND claimed_until IS NULL
                     AND done_post_id IS NULL AND done_at IS NULL AND accepted_at IS NULL
    WHEN 'claimed' THEN claimed_by IS NOT NULL AND claimed_until IS NOT NULL
                        AND done_post_id IS NULL AND done_at IS NULL AND accepted_at IS NULL
    WHEN 'done' THEN claimed_by IS NOT NULL AND claimed_until IS NULL
                     AND done_post_id IS NOT NULL AND done_at IS NOT NULL AND accepted_at IS NULL
    WHEN 'accepted' THEN claimed_by IS NOT NULL AND claimed_until IS NULL
                         AND done_post_id IS NOT NULL AND done_at IS NOT NULL AND accepted_at IS NOT NULL
    WHEN 'retired' THEN claimed_until IS NULL AND accepted_at IS NULL
                        AND (claimed_by IS NULL) = (done_post_id IS NULL)
                        AND (done_post_id IS NULL) = (done_at IS NULL)
    WHEN 'deleted' THEN claimed_by IS NULL AND claimed_until IS NULL
                        AND done_post_id IS NULL AND done_at IS NULL AND accepted_at IS NULL
                        AND progress_post_id IS NULL AND takes = 0
                        AND title = '' AND body = '' AND tag IS NULL AND waits_for = '{}'
    ELSE false END) NOT VALID,
  -- Who closed it, when and why: set on a retired or deleted task, and on no other.
  ADD CONSTRAINT tasks_closed_shape CHECK (
    (state IN ('retired', 'deleted')) = (closed_at IS NOT NULL)
    AND (closed_at IS NULL) = (close_reason IS NULL)
    AND (closed_by IS NULL OR closed_at IS NOT NULL)
    AND (state <> 'deleted' OR closed_by IS NOT NULL)
    AND (cardinality(replaced_by) = 0 OR state IN ('retired', 'deleted'))) NOT VALID;
ALTER TABLE schellingaf.tasks
  VALIDATE CONSTRAINT tasks_state_known,
  VALIDATE CONSTRAINT tasks_title_length,
  VALIDATE CONSTRAINT tasks_state_shape,
  VALIDATE CONSTRAINT tasks_closed_shape;

-- The retired and deleted tasks, by number: what space_counts() leaves out of accepted, and
-- the list kept to retired tasks.
CREATE INDEX tasks_closed_idx ON schellingaf.tasks (space_id, number) WHERE state IN ('retired', 'deleted');

-- What a task may never do, as 0130_task_changes.sql listed it, with what a final state
-- adds: a deleted task never changes again; a retired task is never anything but retired,
-- or deleted; who closed it, when and why, once set, stay, and its replacements are set
-- once; a deletion erases its words, which the table's shape holds empty, and no other
-- change touches the words of a retired task.
CREATE OR REPLACE FUNCTION schellingaf.protect_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF OLD.state = 'deleted' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF OLD.state = 'retired' AND NEW.state NOT IN ('retired', 'deleted') THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF NEW.task_id <> OLD.task_id OR NEW.space_id <> OLD.space_id OR NEW.number <> OLD.number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  IF NEW.cycle < OLD.cycle OR NEW.revision < OLD.revision THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF OLD.progress_post_id IS NOT NULL AND NEW.progress_post_id IS NULL THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF NEW.state <> 'deleted' AND OLD.closed_at IS NOT NULL
     AND (NEW.closed_by IS DISTINCT FROM OLD.closed_by OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
          OR NEW.close_reason IS DISTINCT FROM OLD.close_reason) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  IF cardinality(OLD.replaced_by) > 0 AND NEW.replaced_by <> OLD.replaced_by THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF NEW.state <> 'deleted'
     AND (NEW.title <> OLD.title OR NEW.body <> OLD.body OR NEW.tag IS DISTINCT FROM OLD.tag
          OR NEW.waits_for <> OLD.waits_for) THEN
    IF OLD.state IN ('done', 'accepted', 'retired') OR NEW.revision <> OLD.revision + 1
       OR NOT EXISTS (SELECT 1 FROM schellingaf.task_revisions r
                       WHERE r.task_id = OLD.task_id AND r.revision = OLD.revision) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- One task as every answer shows it
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0131_task_give_back.sql made it, with retired: who retired it (null where the service
-- did), when, why, and its replacements by id and number, the numbers read as after's are.
-- A deleted task answers only its number, task_id and state, and deleted: who, when and
-- why. Each reason is what a PEER wrote.
CREATE OR REPLACE FUNCTION schellingaf.task_item(t schellingaf.tasks, p_required integer)
  RETURNS jsonb
  LANGUAGE sql STABLE
  RETURN CASE WHEN t.state = 'deleted' THEN jsonb_build_object(
      'task_id', t.task_id, 'number', t.number, 'state', t.state,
      'deleted', jsonb_build_object('by', encode(t.closed_by, 'hex'), 'at', t.closed_at, 'reason', t.close_reason))
  ELSE jsonb_build_object(
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
                  WHERE h.task_id = t.task_id AND h.revision = t.revision - 1), '{}'::jsonb)
    || CASE WHEN t.state = 'open' AND t.released_by IS NOT NULL
                 AND (t.claimed_at IS NULL OR t.claimed_at <= t.released_at)
            THEN jsonb_build_object('released', jsonb_build_object(
                   'by', encode(t.released_by, 'hex'), 'at', t.released_at, 'reason', t.release_reason))
            ELSE '{}'::jsonb END
    || CASE WHEN t.state = 'retired' THEN jsonb_build_object('retired', jsonb_build_object(
              'by', encode(t.closed_by, 'hex'), 'at', t.closed_at, 'reason', t.close_reason,
              'replaced_by', to_jsonb(t.replaced_by),
              'replaced_by_numbers', (SELECT coalesce(jsonb_agg(w.number ORDER BY w.ord), '[]'::jsonb)
                                        FROM (SELECT o.ord,
                                                     (SELECT k.number FROM schellingaf.tasks k
                                                       WHERE k.task_id = o.task_id AND k.space_id = t.space_id) AS number
                                                FROM unnest(t.replaced_by) WITH ORDINALITY o(task_id, ord)) w)))
            ELSE '{}'::jsonb END
  END;

-- ─────────────────────────────────────────────────────────────────────────────
-- Adding tasks, shared by add and retire
-- ─────────────────────────────────────────────────────────────────────────────

-- The shape of a batch, before anything is read, as 0122_task_batches.sql checked it: a
-- list of 1 to p_batch_max, and an index that names an earlier task of the batch.
-- Internal: add_tasks() and retire_task() call it.
CREATE FUNCTION schellingaf.task_batch_shape(p_tasks jsonb, p_batch_max integer)
  RETURNS void
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n integer;
BEGIN
  IF jsonb_typeof(p_tasks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'tasks is a list of tasks';
  END IF;
  n := jsonb_array_length(p_tasks);
  IF n < 1 OR n > p_batch_max THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'tasks is a list of 1 to ' || p_batch_max || ' tasks';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i),
                           jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) a(v)
              WHERE CASE WHEN a.v ? 'index' THEN NOT ((a.v->>'index')::int BETWEEN 0 AND e.i - 2)
                         ELSE NOT (a.v ? 'number' OR a.v ? 'task_id') END) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'after names an earlier task of the batch by its key';
  END IF;
END $$;

-- The tasks of p_tasks, in a batch's shape, added to SPACE p_space by p_actor and numbered
-- on from its highest number, as 0122_task_batches.sql added them: add_tasks()' insert,
-- which retire_task() shares for its replacements. A number or a task_id in after names a
-- task this SPACE held before the call, never a retired or deleted one: the first entry, in
-- the order sent, that does not is TASK_AFTER_INVALID, naming the entry, or the state of
-- the task it names, after the task that sent it when p_batch. The SPACE holds at most
-- p_not_accepted_max tasks not yet accepted. Answers the first number added. Internal: its
-- callers hold the SPACE lock and checked the shape with task_batch_shape().
CREATE FUNCTION schellingaf.insert_tasks(p_space uuid, p_actor bytea, p_tasks jsonb, p_batch boolean,
                                         p_not_accepted_max integer)
  RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  n integer := jsonb_array_length(p_tasks); v_numbers integer[]; v_map jsonb; v_i bigint; v_key text;
  v_j bigint; v_val text; v_waiting bigint; v_done bigint; v_first integer; v_ids uuid[];
BEGIN
  -- The numbers named, resolved once on the (space_id, number) index.
  SELECT coalesce(array_agg(DISTINCT (a.v->>'number')::int), '{}'::int[]) INTO v_numbers
    FROM jsonb_array_elements(p_tasks) e(t), jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) a(v)
   WHERE a.v ? 'number';
  SELECT coalesce(jsonb_object_agg(r.number::text, r.task_id), '{}'::jsonb) INTO v_map
    FROM tasks r WHERE r.space_id = p_space AND r.number = ANY (v_numbers);
  -- The first entry, in the order sent, that names no task of this SPACE.
  SELECT e.i, e.t->>'key', a.j, coalesce(a.v->>'number', a.v->>'task_id')
    INTO v_i, v_key, v_j, v_val
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i),
         jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) WITH ORDINALITY a(v, j)
   WHERE (a.v ? 'number' AND NOT (v_map ? (a.v->>'number')))
      OR (a.v ? 'task_id' AND NOT EXISTS (SELECT 1 FROM tasks x
                                          WHERE x.task_id = (a.v->>'task_id')::uuid AND x.space_id = p_space))
   ORDER BY e.i, a.j
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = CASE WHEN p_batch
      THEN format('tasks[%s]%s: after[%s] %s', v_i - 1, coalesce(' (' || v_key || ')', ''), v_j - 1, v_val)
      ELSE v_val END;
  END IF;
  -- The first entry, in the order sent, that names a retired or deleted task: one is never
  -- waited for.
  SELECT e.i, e.t->>'key', a.j, x.state
    INTO v_i, v_key, v_j, v_val
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i),
         jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) WITH ORDINALITY a(v, j),
         tasks x
   WHERE x.space_id = p_space
     AND x.task_id = CASE WHEN a.v ? 'number' THEN (v_map->>(a.v->>'number'))::uuid
                          WHEN a.v ? 'task_id' THEN (a.v->>'task_id')::uuid END
     AND x.state IN ('retired', 'deleted')
   ORDER BY e.i, a.j
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = CASE WHEN p_batch
      THEN format('tasks[%s]%s: after[%s] %s', v_i - 1, coalesce(' (' || v_key || ')', ''), v_j - 1, v_val)
      ELSE v_val END;
  END IF;

  -- Room for all of them, counted in the two waiting indexes up to the limit and no further.
  SELECT count(*) INTO v_waiting FROM (
    SELECT 1 FROM tasks w WHERE w.space_id = p_space AND w.state IN ('open', 'claimed')
     LIMIT p_not_accepted_max) a;
  SELECT count(*) INTO v_done FROM (
    SELECT 1 FROM tasks d WHERE d.space_id = p_space AND d.state = 'done'
     LIMIT p_not_accepted_max) b;
  IF v_waiting + v_done + n > p_not_accepted_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = p_not_accepted_max::text;
  END IF;

  -- Numbered on, in the order sent, from the highest number the SPACE ever used, a deleted
  -- task's included; each id made first, so an index names an earlier task's id.
  SELECT coalesce(max(m.number), 0) + 1 INTO v_first FROM tasks m WHERE m.space_id = p_space;
  v_ids := ARRAY(SELECT uuidv7() FROM generate_series(1, n));
  INSERT INTO tasks (task_id, space_id, number, title, body, tag, waits_for, created_by)
  SELECT v_ids[e.i::int], p_space, v_first + e.i::int - 1, e.t->>'title', coalesce(e.t->>'body', ''), e.t->>'tag',
         coalesce((SELECT array_agg(DISTINCT CASE
                                      WHEN a.v ? 'index'  THEN v_ids[(a.v->>'index')::int + 1]
                                      WHEN a.v ? 'number' THEN (v_map->>(a.v->>'number'))::uuid
                                      ELSE (a.v->>'task_id')::uuid END)
                     FROM jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) a(v)), '{}'::uuid[]),
         p_actor
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i);
  RETURN v_first;
END $$;

-- Tasks added in one call, as 0122_task_batches.sql made it, its shape and its insert now
-- shared with retire_task(): after never names a retired or deleted task.
CREATE OR REPLACE FUNCTION schellingaf.add_tasks(
  p_space_name text, p_actor bytea, p_tasks jsonb, p_idempotency_key text DEFAULT NULL,
  p_batch boolean DEFAULT true, p_not_accepted_max integer DEFAULT 10000,
  p_batch_max integer DEFAULT 20)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; n integer; h bytea; prior task_adds%ROWTYPE; v_first integer; v_out jsonb;
BEGIN
  PERFORM task_batch_shape(p_tasks, p_batch_max);
  n := jsonb_array_length(p_tasks);
  h := sha256(convert_to(p_tasks::text, 'UTF8'));

  -- Unlocked pre-check: a KEY that may not add never waits on the SPACE's lock.
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

  -- A replay answers what the first call added, as the tasks stand now, even where the
  -- SPACE has since filled: it adds nothing. A task deleted since answers as deleted. Two
  -- calls under one key meet under the SPACE lock, so the second reads the first's row here.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO prior FROM task_adds a
     WHERE a.space_id = s.space_id AND a.created_by = p_actor AND a.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF prior.content_hash <> h THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
      SELECT coalesce(jsonb_agg(task_item(t, s.task_confirmations)
                                || jsonb_build_object('key', prior.keys[t.number - prior.first_number + 1])
                                ORDER BY t.number), '[]'::jsonb)
        INTO v_out
        FROM tasks t
       WHERE t.space_id = s.space_id
         AND t.number BETWEEN prior.first_number AND prior.first_number + prior.task_count - 1;
      RETURN jsonb_build_object('space', s.name, 'tasks', v_out, 'replayed', true, 'changed', false);
    END IF;
  END IF;

  v_first := insert_tasks(s.space_id, p_actor, p_tasks, p_batch, p_not_accepted_max);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO task_adds (space_id, created_by, idempotency_key, content_hash, first_number, task_count, keys)
    VALUES (s.space_id, p_actor, p_idempotency_key, h, v_first, n,
            ARRAY(SELECT e.t->>'key' FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i) ORDER BY e.i));
  END IF;

  -- Gathered once: never a jsonb value grown in a loop.
  SELECT coalesce(jsonb_agg(task_item(t, s.task_confirmations)
                            || jsonb_build_object('key', p_tasks->(t.number - v_first)->>'key')
                            ORDER BY t.number), '[]'::jsonb)
    INTO v_out
    FROM tasks t
   WHERE t.space_id = s.space_id AND t.number BETWEEN v_first AND v_first + n - 1;
  RETURN jsonb_build_object('space', s.name, 'tasks', v_out, 'changed', true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A change, as 0130_task_changes.sql made it
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0130_task_changes.sql made it, with a retired task refused TASK_NOT_OPEN and a deleted
-- one TASK_NOT_FOUND, each with its state as the detail, and after refusing a retired or
-- deleted task, its state as the detail.
CREATE OR REPLACE FUNCTION schellingaf.change_task(p_space_name text, p_actor bytea, p_number integer, p_revision integer,
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
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;  -- 0132
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired
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
    -- 0132: the first that names a retired or deleted task, its state as the detail.
    SELECT x.state INTO v_bad
      FROM jsonb_array_elements(p_change->'after') WITH ORDINALITY a(v, j), tasks x
     WHERE x.space_id = s.space_id
       AND CASE WHEN a.v ? 'number' THEN x.number = (a.v->>'number')::int
                ELSE x.task_id = (a.v->>'task_id')::uuid END
       AND x.state IN ('retired', 'deleted')
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Retire and replace
-- ─────────────────────────────────────────────────────────────────────────────

-- p_after without p_gone, then p_add, each task once, in the order first met. Internal:
-- retire_task() rewrites the after of the tasks that waited for a retired task with it.
CREATE FUNCTION schellingaf.task_after_without(p_after uuid[], p_gone uuid, p_add uuid[])
  RETURNS uuid[]
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT coalesce(array_agg(u.id ORDER BY u.first), '{}'::uuid[])
            FROM (SELECT x.id, min(x.ord) AS first
                    FROM unnest(array_remove(p_after, p_gone) || p_add) WITH ORDINALITY x(id, ord)
                   GROUP BY x.id) u);

-- Task p_number retired by p_actor, a coordinator or above, saying why in p_reason: an
-- open, claimed or done task; an accepted one never. A claim on it ends; a done task keeps
-- who did it and its result, so the post still reads as that task's result, and its checks
-- stop, since only a done task is checked. With p_tasks, in add_tasks()' batch shape, 1 to
-- p_batch_max tasks are added in its place, in its insert, and kept as its replacements;
-- their after may not name it, now retired.
--
-- Every open or claimed task that waited for it then waits, in its place, for each task
-- it waited for that is not yet accepted, and for its replacements. Each rewrite is a
-- change, one revision up, with the words before kept and the reason "replaced: task <n>
-- retired"; a holder of one is told task_changed, and its done then needs the new
-- revision. Refused, and nothing retired, when a rewrite would wait for more than 8 tasks
-- (TASK_AFTER_INVALID, naming the task), would make a task wait for itself
-- (TASK_AFTER_INVALID, loop: <number>), or would be a task's revision past
-- p_revisions_max (TASK_LIMIT, naming the task). A done or accepted task that named it
-- keeps its after.
--
-- Told task_retired: the holder of a claim on it, or the KEY that did a done one and the
-- KEYS that confirmed it in its current cycle. The same KEY retiring it again answers
-- changed false and adds nothing; anybody else is refused TASK_NOT_OPEN, retired. Who may,
-- and in what order, as change_task(); deliveries answered only with p_deliveries.
CREATE FUNCTION schellingaf.retire_task(p_space_name text, p_actor bytea, p_number integer, p_reason text,
                                        p_tasks jsonb DEFAULT NULL, p_not_accepted_max integer DEFAULT 10000,
                                        p_batch_max integer DEFAULT 20, p_revisions_max integer DEFAULT 50,
                                        p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; t tasks%ROWTYPE; v_was tasks%ROWTYPE; v_first integer; v_new uuid[] := '{}';
  v_inherit uuid[]; v_deps uuid[]; v_number integer; v_loop integer;
  v_parts jsonb[] := '{}'; v_out jsonb; r record;
BEGIN
  -- Shape, before anything is read.
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: say why you retire the task, in 1 to 500 characters';
  END IF;
  IF p_tasks IS NOT NULL THEN PERFORM task_batch_shape(p_tasks, p_batch_max); END IF;

  -- Unlocked pre-check: a KEY below a coordinator never waits on the SPACE's lock.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 25 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 25 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO t FROM tasks k WHERE k.space_id = s.space_id AND k.number = p_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;
  IF t.state = 'retired' THEN
    -- A retry after a lost answer: what the first call did stands, and nothing is added.
    IF t.closed_by = p_actor THEN
      SELECT coalesce(jsonb_agg(task_item(k, s.task_confirmations) ORDER BY k.number), '[]'::jsonb) INTO v_out
        FROM tasks k WHERE k.task_id = ANY (t.replaced_by);
      RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false,
                                'dependents', '[]'::jsonb, 'tasks', v_out);
    END IF;
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'retired';
  END IF;
  IF t.state = 'accepted' THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'accepted'; END IF;

  v_was := t;
  UPDATE tasks k
     SET state = 'retired',
         claimed_by = CASE WHEN k.done_post_id IS NULL THEN NULL ELSE k.claimed_by END,
         claimed_until = NULL, closed_by = p_actor, closed_at = now(), close_reason = p_reason
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  IF p_tasks IS NOT NULL THEN
    v_first := insert_tasks(s.space_id, p_actor, p_tasks, true, p_not_accepted_max);
    SELECT array_agg(k.task_id ORDER BY k.number) INTO v_new
      FROM tasks k
     WHERE k.space_id = s.space_id AND k.number BETWEEN v_first AND v_first + jsonb_array_length(p_tasks) - 1;
    UPDATE tasks k SET replaced_by = v_new WHERE k.task_id = t.task_id RETURNING * INTO t;
  END IF;

  -- What it waited for that is not yet accepted, in its order: its dependents inherit it.
  v_inherit := ARRAY(SELECT a.task_id
                       FROM unnest(v_was.waits_for) WITH ORDINALITY w(id, ord)
                       JOIN tasks a ON a.task_id = w.id AND a.space_id = s.space_id
                      WHERE a.state NOT IN ('accepted', 'retired', 'deleted')
                      ORDER BY w.ord);
  -- The open and claimed tasks that waited for it, locked in key order.
  SELECT coalesce(array_agg(d.task_id ORDER BY d.task_id), '{}'::uuid[]) INTO v_deps
    FROM (SELECT k.task_id FROM tasks k
           WHERE k.space_id = s.space_id AND k.state IN ('open', 'claimed') AND t.task_id = ANY (k.waits_for)
           ORDER BY k.task_id
           FOR UPDATE) d;

  IF cardinality(v_deps) > 0 THEN
    SELECT d.number INTO v_number FROM tasks d
     WHERE d.task_id = ANY (v_deps) AND d.revision >= p_revisions_max
     ORDER BY d.number LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = 'task ' || v_number || ': revisions: ' || p_revisions_max;
    END IF;
    -- 8 is tasks_waits_for_count's bound, which an UPDATE past it would only refuse as a CHECK.
    SELECT d.number INTO v_number
      FROM tasks d
     WHERE d.task_id = ANY (v_deps) AND cardinality(task_after_without(d.waits_for, t.task_id, v_inherit || v_new)) > 8
     ORDER BY d.number LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = 'after would hold more than 8 tasks: task ' || v_number;
    END IF;

    INSERT INTO task_revisions (task_id, space_id, revision, title, body, tag, waits_for, ended_by, end_reason)
    SELECT d.task_id, d.space_id, d.revision, d.title, d.body, d.tag, d.waits_for, p_actor,
           'replaced: task ' || t.number || ' retired'
      FROM tasks d WHERE d.task_id = ANY (v_deps);
    UPDATE tasks d
       SET waits_for = task_after_without(d.waits_for, t.task_id, v_inherit || v_new), revision = d.revision + 1
     WHERE d.task_id = ANY (v_deps);
    -- A replacement that waits for a task that waited for this one closes a loop.
    SELECT r_.reached INTO v_loop
      FROM (SELECT d.number, task_reaches(s.space_id, d.waits_for, ARRAY[d.task_id]) AS reached
              FROM tasks d WHERE d.task_id = ANY (v_deps)) r_
     WHERE r_.reached IS NOT NULL
     ORDER BY r_.number LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = 'loop: ' || v_loop; END IF;
  END IF;

  -- Each notice its own delivery, in ascending peer order across them all, as every
  -- mailbox lock is taken.
  FOR r IN
    SELECT q.peer, q.task, q.cycle, q.reason FROM (
      SELECT v_was.claimed_by AS peer, t.task_id AS task, v_was.cycle AS cycle, 'task_retired'::text AS reason
       WHERE v_was.state IN ('claimed', 'done')
      UNION
      SELECT c.peer_id, t.task_id, v_was.cycle, 'task_retired'
        FROM task_checks c
       WHERE v_was.state = 'done' AND c.task_id = t.task_id AND c.cycle = v_was.cycle AND c.verdict = 'confirm'
      UNION
      SELECT d.claimed_by, d.task_id, d.cycle, 'task_changed'
        FROM tasks d WHERE d.task_id = ANY (v_deps) AND d.state = 'claimed') q
     ORDER BY q.peer, q.task
  LOOP
    v_parts := v_parts || deliver_task_notices(s.space_id, r.task, r.cycle, p_actor, ARRAY[r.peer::bytea], ARRAY[r.reason]);
  END LOOP;

  SELECT coalesce(jsonb_agg(task_item(k, s.task_confirmations)
                            || jsonb_build_object('key', p_tasks->(k.number - v_first)->>'key')
                            ORDER BY k.number), '[]'::jsonb)
    INTO v_out
    FROM tasks k WHERE k.task_id = ANY (v_new);
  RETURN jsonb_build_object(
           'space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true,
           'dependents', (SELECT coalesce(jsonb_agg(d.number ORDER BY d.number), '[]'::jsonb)
                            FROM tasks d WHERE d.task_id = ANY (v_deps)),
           'tasks', v_out)
         || CASE WHEN p_deliveries
                 THEN jsonb_build_object('delivered', (SELECT coalesce(jsonb_agg(e.x), '[]'::jsonb)
                                                         FROM unnest(v_parts) p(x), jsonb_array_elements(p.x) e(x)))
                 ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Delete
-- ─────────────────────────────────────────────────────────────────────────────

-- Task p_number deleted by p_actor, saying why in p_reason: only while nobody ever took it
-- (takes 0, else TASK_TAKEN), so it holds no result, check or progress. The owner or an
-- admin deletes any such task; the KEY that added it deletes it while every revision was
-- its own (TASK_DENIED otherwise). Refused TASK_WAITED_ON while a task not yet accepted,
-- retired or deleted names it in after, the detail the lowest 20 of their numbers. Its
-- title and body become empty, its tag null and its after empty, and its revisions are
-- removed; the row stays, so its number is never used again and every id still names a
-- row. A retired task nobody took may be deleted too. The KEY that added it is told,
-- task_deleted, when somebody else deletes it. The same KEY deleting it again answers
-- changed false; anybody else is refused TASK_NOT_FOUND, deleted. Who may, and in what
-- order, as change_task(); deliveries answered only with p_deliveries.
CREATE FUNCTION schellingaf.delete_task(p_space_name text, p_actor bytea, p_number integer, p_reason text,
                                        p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_waiting text; v_delivered jsonb;
BEGIN
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: say why you delete the task, in 1 to 500 characters';
  END IF;

  -- Unlocked pre-check: a KEY that may delete nothing never waits on the SPACE's lock.
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
  IF t.state = 'deleted' THEN
    -- A retry after a lost answer: what the first call did stands.
    IF t.closed_by = p_actor THEN
      RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
    END IF;
    RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted';
  END IF;
  -- The owner or an admin; else the KEY that added it, while no other KEY changed it.
  IF v_rank < 30 AND NOT (t.created_by = p_actor
                          AND NOT EXISTS (SELECT 1 FROM task_revisions r
                                           WHERE r.task_id = t.task_id AND r.ended_by <> p_actor)) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF t.takes > 0 THEN RAISE EXCEPTION 'TASK_TAKEN'; END IF;
  -- The tasks that still wait for it, read from the two waiting indexes.
  SELECT string_agg(w.number::text, ', ' ORDER BY w.number) INTO v_waiting
    FROM (SELECT u.number FROM (
            SELECT k.number FROM tasks k
             WHERE k.space_id = s.space_id AND k.state IN ('open', 'claimed') AND t.task_id = ANY (k.waits_for)
            UNION ALL
            SELECT k.number FROM tasks k
             WHERE k.space_id = s.space_id AND k.state = 'done' AND t.task_id = ANY (k.waits_for)) u
           ORDER BY u.number LIMIT 20) w;
  IF v_waiting IS NOT NULL THEN RAISE EXCEPTION 'TASK_WAITED_ON' USING DETAIL = v_waiting; END IF;

  UPDATE tasks k
     SET state = 'deleted', title = '', body = '', tag = NULL, waits_for = '{}',
         closed_by = p_actor, closed_at = now(), close_reason = p_reason
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  DELETE FROM task_revisions r WHERE r.task_id = t.task_id;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[t.created_by::bytea], ARRAY['task_deleted']);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Every other task function, on a retired or deleted task
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Each below is the latest file's, with the lines marked 0132 added or changed and nothing
-- else: a deleted task is TASK_NOT_FOUND, deleted; a retired one TASK_NOT_OPEN, retired
-- (TASK_NOT_DONE for a check, which reads its state already); and a retired task in after
-- counts as done with, as an accepted one does. The rewrite in retire_task() leaves none in
-- an open task's after; this only keeps the gate sound if one is ever left.

-- As 0131_task_give_back.sql made it.
CREATE OR REPLACE FUNCTION schellingaf.next_task(p_space_name text, p_actor bytea, p_tag text DEFAULT NULL,
                                                 p_verify boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_renewed boolean := false; v_rank int;
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
  v_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF v_rank < (CASE WHEN p_verify AND s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END) THEN
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
                                            WHERE a.task_id = ANY (o.waits_for) AND a.state NOT IN ('accepted', 'retired'))  -- 0132: retired
                           -- Given back by this caller, below an admin, within the claim hours.
                           AND NOT (v_rank < 30 AND o.released_by IS NOT DISTINCT FROM p_actor
                                    AND o.released_at > now() - make_interval(hours => s.task_claim_hours))
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

-- As 0131_task_give_back.sql made it.
CREATE OR REPLACE FUNCTION schellingaf.take_task(p_space_name text, p_actor bytea, p_number integer,
                                                 p_held_max integer DEFAULT 3)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_renewed boolean; v_waiting integer; v_rank int;
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
  v_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF v_rank < 20 THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO t FROM tasks k WHERE k.space_id = s.space_id AND k.number = p_number FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND'; END IF;
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;  -- 0132
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired
  v_renewed := t.state = 'claimed' AND t.claimed_by = p_actor;
  IF NOT v_renewed AND t.state = 'claimed' AND t.claimed_until > now() THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed';
  END IF;
  IF NOT v_renewed AND v_rank < 30 AND t.released_by IS NOT DISTINCT FROM p_actor
     AND t.released_at > now() - make_interval(hours => s.task_claim_hours) THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'given back by you';
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
     WHERE a.task_id = ANY (t.waits_for) AND a.state NOT IN ('accepted', 'retired')  -- 0132: retired
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

-- As 0130_task_changes.sql made it.
CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
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
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;  -- 0132
  -- A retry after a lost answer: what the first call did stands.
  IF t.state IN ('done', 'accepted') AND t.claimed_by = p_actor AND t.done_post_id = p_post THEN
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
  END IF;
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired
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

-- As 0125_task_progress.sql made it.
CREATE OR REPLACE FUNCTION schellingaf.task_progress(p_space_name text, p_actor bytea, p_number integer,
                                                     p_post uuid, p_kinds text[], p_held_max integer DEFAULT 3)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_kind text;
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
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;  -- 0132
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired
  -- Held by nobody, or by a KEY whose claim has passed: the caller takes it first.
  IF t.state = 'open' OR (t.claimed_by <> p_actor AND t.claimed_until <= now()) THEN
    RAISE EXCEPTION 'TASK_NOT_CLAIMANT';
  END IF;
  IF t.claimed_by <> p_actor THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed'; END IF;
  SELECT p.kind INTO v_kind FROM posts p
   WHERE p.post_id = p_post AND p.space_id = s.space_id AND p.author_id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_POST_NOT_FOUND'; END IF;
  IF NOT v_kind = ANY (p_kinds) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'post_id: a post of kind ' || array_to_string(p_kinds, ', ');
  END IF;

  -- A retry after a lost answer: what the first call did stands.
  IF t.progress_post_id = p_post THEN
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
  END IF;
  -- A claim of its own that passed, brought back: counted as a take.
  IF t.claimed_until <= now()
     AND (SELECT count(*) FROM tasks h
           WHERE h.space_id = s.space_id AND h.state = 'claimed' AND h.claimed_by = p_actor
             AND h.claimed_until > now() AND h.task_id <> t.task_id) >= p_held_max THEN
    RAISE EXCEPTION 'TASK_HOLD_LIMIT' USING DETAIL = p_held_max::text;
  END IF;
  UPDATE tasks k SET progress_post_id = p_post, progress_at = now(),
                     claimed_until = now() + make_interval(hours => s.task_claim_hours)
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- As 0131_task_give_back.sql made it, its five-argument form; the four-argument wrapper
-- calls it.
CREATE OR REPLACE FUNCTION schellingaf.task_release(p_space_name text, p_actor bytea, p_number integer,
                                         p_reason text, p_deliveries boolean)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_holder bytea; v_other boolean; v_delivered jsonb;
BEGIN
  IF p_reason IS NOT NULL AND char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason is 1 to 500 characters';
  END IF;

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
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;  -- 0132
  IF t.state = 'open' THEN
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
  END IF;
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired

  v_other := t.claimed_by <> p_actor;
  IF v_other AND v_rank < 30 THEN
    -- Below an admin, a writer gives back only its own; a coordinator also the claim of a
    -- KEY ranked below it, read now, and only saying why.
    IF v_rank < 25 THEN RAISE EXCEPTION 'TASK_NOT_CLAIMANT'; END IF;
    IF rank_in_space(s.space_id, s.owner_id, t.claimed_by) >= 25 THEN
      RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
    IF p_reason IS NULL THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: say why you give back the claim of another KEY';
    END IF;
  END IF;

  v_holder := t.claimed_by;
  UPDATE tasks k SET state = 'open', claimed_by = NULL, claimed_until = NULL,
                     released_by = CASE WHEN v_other THEN p_actor ELSE k.released_by END,
                     released_at = CASE WHEN v_other THEN now() ELSE k.released_at END,
                     release_reason = CASE WHEN v_other THEN p_reason ELSE k.release_reason END
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[v_holder], ARRAY['task_reopened']);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- As 0116_sources_and_notices.sql made it. A retired task reaches the TASK_NOT_DONE its
-- state already gave, with retired as the detail.
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
    v_delivered := deliver_task_notices(s.space_id, t.task_id, v_cycle, p_actor, v_peers,
                                        array_fill('task_rejected'::text, ARRAY[cardinality(v_peers)]));
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The counts of a page of SPACES
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0123_space_stages.sql made it, with tasks_all now every task the SPACE has had less
-- those retired or deleted, counted on tasks_closed_idx, so the accepted count beside it
-- (src/http/spaces.ts, countsOf()) never takes one in.
CREATE OR REPLACE FUNCTION schellingaf.space_counts(p_spaces uuid[])
  RETURNS TABLE (space_id uuid, tasks_all int, tasks_claimed int, tasks_done int,
                 findings_proposed int, findings_supported int, findings_disputed int, findings_withdrawn int,
                 document_kept boolean, version_post_id uuid, version_seq bigint, pending int, posts_7d int)
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 200
AS $$
  SELECT s.space_id,
         ((SELECT coalesce(max(ta.number), 0) FROM schellingaf.tasks ta WHERE ta.space_id = s.space_id)
          - (SELECT count(*) FROM schellingaf.tasks tx
              WHERE tx.space_id = s.space_id AND tx.state IN ('retired', 'deleted')))::int,
         (SELECT count(*) FROM schellingaf.tasks tc
           WHERE tc.space_id = s.space_id AND tc.state = 'claimed' AND tc.claimed_until > now())::int,
         (SELECT count(*) FROM schellingaf.tasks td WHERE td.space_id = s.space_id AND td.state = 'done')::int,
         coalesce(fc.proposed, 0), coalesce(fc.supported, 0), coalesce(fc.disputed, 0), coalesce(fc.withdrawn, 0),
         s.oracle OR s.document,
         cv.post_id, cv.seq,
         (SELECT count(*) FROM schellingaf.oracle_versions pv
           WHERE pv.space_id = s.space_id AND pv.state = 'pending')::int,
         -- Never below 0: after the wall clock steps back, posted_at and seq can
         -- disagree, and the count is approximate around the step.
         CASE WHEN w.seq IS NULL THEN 0
              ELSE greatest(0, s.last_seq - w.seq + 1
                    - (SELECT count(*) FROM (
                         SELECT h.post_id FROM schellingaf.space_hidden h
                          WHERE h.space_id = s.space_id AND h.post_id >= w.post_id
                         UNION
                         SELECT wh.post_id FROM schellingaf.withheld wh
                          WHERE wh.space_id = s.space_id AND wh.post_id >= w.post_id
                            AND wh.released_at IS NULL) gone))::int END
    FROM (SELECT DISTINCT x.id FROM unnest(p_spaces[1:200]) AS x(id)) ids
    JOIN schellingaf.spaces s ON s.space_id = ids.id
    LEFT JOIN schellingaf.space_finding_counts fc ON fc.space_id = s.space_id
    LEFT JOIN schellingaf.oracle_versions cv ON cv.space_id = s.space_id AND cv.state = 'current'
    -- The window's first post. seq breaks a tie in posted_at, which the SPACE lock makes
    -- all but impossible.
    LEFT JOIN LATERAL (
      SELECT p.seq, p.post_id FROM schellingaf.posts p
       WHERE p.space_id = s.space_id AND p.posted_at >= now() - interval '168 hours'
       ORDER BY p.posted_at, p.seq
       LIMIT 1) w ON true
   WHERE s.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(s.space_id)
$$;

GRANT EXECUTE ON FUNCTION
  schellingaf.retire_task(text, bytea, integer, text, jsonb, integer, integer, integer, boolean),
  schellingaf.delete_task(text, bytea, integer, text, boolean)
TO schellingaf_api;
