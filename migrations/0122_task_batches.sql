-- Tasks in a batch: add_tasks() adds one task, or up to p_batch_max (TASK_LIMITS.batch) in
-- one call, all added or none, numbered on in the order sent under one SPACE lock. A
-- task of a batch may wait for an earlier task of the same batch, which the route names
-- by its position. An add sent with an idempotency_key and sent again with the same
-- tasks adds nothing and answers what the first added; with other tasks it is
-- IDEMPOTENCY_CONFLICT.
--
-- add_task() (0113_tasks.sql) becomes a wrapper over add_tasks(), its signature, grant
-- and answer unchanged, so one function holds every rule of an add and a process of the
-- release before keeps working while a deploy runs this file.
--
-- What an idempotency_key is kept in. A row of task_adds lives as long as its tasks: for
-- good. No export or chain carries it, and a backup keeps it like any table.
-- recover_space continues a SPACE with no tasks and no task_adds. The key is the caller's
-- own text: nothing reads it but a replay by the same KEY in the same SPACE, through
-- add_tasks(), which alone reads and writes the table. It is granted to nobody, and row
-- security answers the api role no row should a grant ever be added.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- One row for each add sent with an idempotency_key: what it asked, as a hash, and the
-- tasks it added, which an add numbers without a gap under the SPACE lock, so
-- first_number and task_count name them exactly. Never changed or deleted.
CREATE TABLE schellingaf.task_adds (
  space_id        uuid NOT NULL REFERENCES schellingaf.spaces,
  created_by      schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  idempotency_key text NOT NULL CONSTRAINT task_adds_key_bytes CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128),
  content_hash    bytea NOT NULL CONSTRAINT task_adds_hash_bytes CHECK (octet_length(content_hash) = 32),
  first_number    integer NOT NULL CHECK (first_number > 0),
  task_count      smallint NOT NULL CHECK (task_count >= 1),
  -- Each task's key, in the order sent, NULL for a task sent without one.
  keys            text[] NOT NULL CONSTRAINT task_adds_keys_count CHECK (cardinality(keys) = task_count),
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, created_by, idempotency_key)
);
CREATE TRIGGER task_adds_immutable BEFORE UPDATE OR DELETE ON schellingaf.task_adds
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();
ALTER TABLE schellingaf.task_adds ENABLE ROW LEVEL SECURITY;

-- Tasks added in one call, by a writer or above: one task as a single add sends it, or a
-- batch of up to p_batch_max, all added or none, numbered on in the order sent under one
-- SPACE lock. p_tasks is the jsonb array the route built from fields it already checked:
--   [{"key": text?, "title": text, "body": text, "tag": text?,
--     "after": [{"number": int} | {"task_id": uuid} | {"index": int}]}]
-- A number or a task_id names a task this SPACE held before the call; index is the
-- 0-based position of an EARLIER task of the same batch, which this function holds too,
-- so no caller can make a cycle. p_batch says only how a refusal's detail names the
-- entry. A SPACE holds at most p_not_accepted_max tasks not yet accepted, and a batch
-- that does not fit is refused whole. With p_idempotency_key, the same tasks sent again
-- add nothing and answer the first, as the tasks stand now.
CREATE FUNCTION schellingaf.add_tasks(
  p_space_name text, p_actor bytea, p_tasks jsonb, p_idempotency_key text DEFAULT NULL,
  p_batch boolean DEFAULT true, p_not_accepted_max integer DEFAULT 10000,
  p_batch_max integer DEFAULT 20)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; n integer; h bytea; prior task_adds%ROWTYPE;
  v_numbers integer[]; v_map jsonb; v_i bigint; v_key text; v_j bigint; v_val text;
  v_waiting bigint; v_done bigint; v_first integer; v_ids uuid[]; v_out jsonb;
BEGIN
  -- Shape, before anything is read. The route checked all of it; this holds the rules
  -- that keep the table sound whoever calls: a list of the right length, and an index
  -- that names an earlier task of the batch.
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
  -- SPACE has since filled: it adds nothing. Two calls under one key meet under the SPACE
  -- lock, so the second reads the first's row here.
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

  -- The numbers named, resolved once on the (space_id, number) index.
  SELECT coalesce(array_agg(DISTINCT (a.v->>'number')::int), '{}'::int[]) INTO v_numbers
    FROM jsonb_array_elements(p_tasks) e(t), jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) a(v)
   WHERE a.v ? 'number';
  SELECT coalesce(jsonb_object_agg(r.number::text, r.task_id), '{}'::jsonb) INTO v_map
    FROM tasks r WHERE r.space_id = s.space_id AND r.number = ANY (v_numbers);
  -- The first entry, in the order sent, that names no task of this SPACE.
  SELECT e.i, e.t->>'key', a.j, coalesce(a.v->>'number', a.v->>'task_id')
    INTO v_i, v_key, v_j, v_val
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i),
         jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) WITH ORDINALITY a(v, j)
   WHERE (a.v ? 'number' AND NOT (v_map ? (a.v->>'number')))
      OR (a.v ? 'task_id' AND NOT EXISTS (SELECT 1 FROM tasks x
                                          WHERE x.task_id = (a.v->>'task_id')::uuid AND x.space_id = s.space_id))
   ORDER BY e.i, a.j
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = CASE WHEN p_batch
      THEN format('tasks[%s]%s: after[%s] %s', v_i - 1, coalesce(' (' || v_key || ')', ''), v_j - 1, v_val)
      ELSE v_val END;
  END IF;

  -- Room for all of them, counted in the two waiting indexes up to the limit and no further.
  SELECT count(*) INTO v_waiting FROM (
    SELECT 1 FROM tasks w WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed')
     LIMIT p_not_accepted_max) a;
  SELECT count(*) INTO v_done FROM (
    SELECT 1 FROM tasks d WHERE d.space_id = s.space_id AND d.state = 'done'
     LIMIT p_not_accepted_max) b;
  IF v_waiting + v_done + n > p_not_accepted_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = p_not_accepted_max::text;
  END IF;

  -- Numbered on, in the order sent; each id made first, so an index names an earlier
  -- task's id.
  SELECT coalesce(max(m.number), 0) + 1 INTO v_first FROM tasks m WHERE m.space_id = s.space_id;
  v_ids := ARRAY(SELECT uuidv7() FROM generate_series(1, n));
  INSERT INTO tasks (task_id, space_id, number, title, body, tag, waits_for, created_by)
  SELECT v_ids[e.i::int], s.space_id, v_first + e.i::int - 1, e.t->>'title', coalesce(e.t->>'body', ''), e.t->>'tag',
         coalesce((SELECT array_agg(DISTINCT CASE
                                      WHEN a.v ? 'index'  THEN v_ids[(a.v->>'index')::int + 1]
                                      WHEN a.v ? 'number' THEN (v_map->>(a.v->>'number'))::uuid
                                      ELSE (a.v->>'task_id')::uuid END)
                     FROM jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) a(v)), '{}'::uuid[]),
         p_actor
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i);

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

-- One task, as add_task() always answered: add_tasks() holds every rule. Kept so a
-- process of the release before keeps working while a deploy runs this file. Its after
-- reaches add_tasks() sorted by id, so its first refused entry is the one add_task()
-- named before.
CREATE OR REPLACE FUNCTION schellingaf.add_task(
  p_space_name text, p_actor bytea, p_title text, p_body text, p_tag text, p_after uuid[],
  p_not_accepted_max integer DEFAULT 10000)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r jsonb;
BEGIN
  r := add_tasks(p_space_name, p_actor,
         jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
           'title', p_title, 'body', coalesce(p_body, ''), 'tag', p_tag,
           'after', (SELECT coalesce(jsonb_agg(jsonb_build_object('task_id', x) ORDER BY x), '[]'::jsonb)
                       FROM unnest(coalesce(p_after, '{}'::uuid[])) x)))),
         NULL, false, p_not_accepted_max, 1);
  RETURN jsonb_build_object('space', r->>'space', 'task', (r->'tasks'->0) - 'key', 'changed', true);
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.add_tasks(text, bytea, jsonb, text, boolean, integer, integer)
TO schellingaf_api;
