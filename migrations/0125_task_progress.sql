-- Work in flight shows on its task: progress, and next by number.
--
-- Until 2 October 2026 nothing tied a post to a task before it was done, so a task read
-- "claimed" or "open" while it was being built, and a KEY holding two tasks renewed only
-- the lower-numbered with next. Two calls change that (proposal-many-spaces-at-once,
-- part 3):
--
--   task_progress()  the KEY that holds a task links its own post of a kind that records
--                    work, and every read of the task shows it as progress. It renews the
--                    claim. The same post again is a retry: nothing changes.
--   take_task()      next with a number: that task, taken if it is open (or its claim
--                    passed) and every task in its after is accepted, or renewed if the
--                    caller holds it. A KEY holds at most p_held_max live claims in a
--                    SPACE when it takes one this way, or brings back a claim of its own
--                    that passed, here or with progress; a live claim's renewal is never
--                    refused. Otherwise patience would beat the cap: take three, let them
--                    pass, take three more, and bring the first three back.
--
-- next_task() and its signature stay as they were. Progress is kept through every state
-- after: a release, a claim that passes, a new holder, done, accepted and a reject leave
-- it, so the list says where work was left. protect_task() refuses clearing it. Like the
-- rest of a task, progress is no post, no event and no notice: the row is the record.

ALTER TABLE schellingaf.tasks
  -- The newest post its holder linked to show where it stands, and when it was linked.
  ADD COLUMN progress_post_id uuid REFERENCES schellingaf.posts,
  ADD COLUMN progress_at timestamptz,
  ADD CONSTRAINT tasks_progress_shape CHECK ((progress_post_id IS NULL) = (progress_at IS NULL));

-- As 0113_tasks.sql made it, with progress, once linked, never cleared.
CREATE OR REPLACE FUNCTION schellingaf.protect_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.task_id <> OLD.task_id OR NEW.space_id <> OLD.space_id
     OR NEW.number <> OLD.number OR NEW.title <> OLD.title OR NEW.body <> OLD.body
     OR NEW.tag IS DISTINCT FROM OLD.tag OR NEW.waits_for <> OLD.waits_for
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.cycle < OLD.cycle
     OR (OLD.progress_post_id IS NOT NULL AND NEW.progress_post_id IS NULL) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;

-- As 0113_tasks.sql made it, with progress once a post is linked: its id, its title as
-- visible_posts gives it (null while the post is hidden or withheld, and for a sealed
-- post), its author and when it was linked. The title is what a PEER wrote.
CREATE OR REPLACE FUNCTION schellingaf.task_item(t schellingaf.tasks, p_required integer)
  RETURNS jsonb
  LANGUAGE sql STABLE
  RETURN jsonb_build_object(
      'task_id', t.task_id, 'number', t.number, 'title', t.title, 'body', t.body, 'tag', t.tag,
      'after', to_jsonb(t.waits_for),
      'state', CASE WHEN t.state = 'claimed' AND t.claimed_until <= now() THEN 'open' ELSE t.state END,
      'cycle', t.cycle,
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
                  WHERE v.post_id = t.progress_post_id), '{}'::jsonb);

-- A post linked to a task as its progress, by the KEY that holds it: p_post, its own post
-- in this SPACE, of one of p_kinds, the kinds that record work. A claim that has passed
-- still counts while nobody took the task since, as for done. It renews the claim for the
-- SPACE's task_claim_hours, from now. Bringing back a claim of its own that passed counts
-- as taking the task: refused TASK_HOLD_LIMIT while p_actor holds p_held_max other live
-- claims in the SPACE. The same post again is a retry and changes nothing: the claim is
-- not renewed and the time stays. Who may, and in what order, as task_done().
CREATE FUNCTION schellingaf.task_progress(p_space_name text, p_actor bytea, p_number integer,
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
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
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

-- next with a number: task p_number for p_actor. Renewed if p_actor holds it, its claim
-- live or passed while nobody took it. Otherwise taken, if it is open or another KEY's
-- claim passed and every task in its after is accepted. Taking it, or bringing back a
-- claim of p_actor's own that passed, is refused while p_actor holds p_held_max other
-- live claims in the SPACE; a live claim's renewal never is. Each refusal names why in
-- its detail. Who may, and in what order, as next_task() without verify, which is left
-- as it was.
CREATE FUNCTION schellingaf.take_task(p_space_name text, p_actor bytea, p_number integer,
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
                     claimed_until = now() + make_interval(hours => s.task_claim_hours)
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'verify', false, 'renewed', v_renewed,
                            'task', task_item(t, s.task_confirmations));
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.task_progress(text, bytea, integer, uuid, text[], integer),
  schellingaf.take_task(text, bytea, integer, integer)
TO schellingaf_api;
