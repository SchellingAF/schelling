-- A coordinator gives back the claim of a KEY ranked below it, and says why.
--
-- Until 3 October 2026 only a task's holder, the owner and an admin gave back a claim
-- (0113_tasks.sql, 0116_sources_and_notices.sql). A coordinator running a work space could
-- only wait while a KEY that had stopped working held a task. This file lets it give the
-- task back (proposal-self-harness, build task 3; its specification is the website's
-- docs/plan/self-harness-plan.md, section A.5):
--
--   task_release()   takes p_reason. A coordinator gives back the claim of a writer, a
--                    reader or a KEY that is no longer a member, and must say why
--                    (INVALID_REQUEST otherwise); the claim of a coordinator or above is
--                    TASK_DENIED to it. The owner and an admin give back anybody's claim,
--                    as before, and a reason is theirs to give or not. The holder gives
--                    back its own, as before. The old signature stays, as a wrapper that
--                    sends no reason.
--   released_*       who last gave back another KEY's claim, when and why. task_item()
--                    answers them as released while the task stays open after it.
--   no retake        a coordinator that gave a task back may not take it for the SPACE's
--                    claim hours after: next passes over it, and next with its number is
--                    TASK_NOT_OPEN, detail "given back by you". The owner and an admin may
--                    take back what they gave back, as before.
--
-- The holder is told task_reopened, as before; the mailbox shows the reason. A give-back by
-- another KEY is never a lapse of the holder's. Like the rest of a task, it is no post, no
-- event and no export: the row is the record.

ALTER TABLE schellingaf.tasks
  ADD COLUMN released_by    schellingaf.bytes32 REFERENCES schellingaf.peers,
  ADD COLUMN released_at    timestamptz,
  ADD COLUMN release_reason text CONSTRAINT tasks_release_reason_length CHECK (char_length(release_reason) BETWEEN 1 AND 500),
  ADD CONSTRAINT tasks_released_shape CHECK ((released_by IS NULL) = (released_at IS NULL)
                                             AND (release_reason IS NULL OR released_by IS NOT NULL));

-- One task as every answer shows it, as 0130_task_changes.sql made it, with released: who
-- last gave back another KEY's claim, when and why, while the task is open and nobody took
-- it since. The reason is what a PEER wrote, and null when the owner or an admin gave none.
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
                  WHERE h.task_id = t.task_id AND h.revision = t.revision - 1), '{}'::jsonb)
    || CASE WHEN t.state = 'open' AND t.released_by IS NOT NULL
                 AND (t.claimed_at IS NULL OR t.claimed_at <= t.released_at)
            THEN jsonb_build_object('released', jsonb_build_object(
                   'by', encode(t.released_by, 'hex'), 'at', t.released_at, 'reason', t.release_reason))
            ELSE '{}'::jsonb END;

-- A new parameter is a new signature, so the one 0116_sources_and_notices.sql made goes, and
-- comes back below as a wrapper; the grants are made again at the end.
DROP FUNCTION schellingaf.task_release(text, bytea, integer, boolean);

-- A claimed task given back, as 0116_sources_and_notices.sql made it, with p_reason. Its
-- holder gives back its own. The owner and an admin give back anybody's. A coordinator
-- gives back the claim of a KEY ranked below it, a writer, a reader or a KEY that is no
-- longer a member, and only with a reason. Another KEY's give-back is kept in released_*,
-- and its holder is told task_reopened. p_reason is checked before anything is read, and
-- is required only once the task shows whose claim it is.
CREATE FUNCTION schellingaf.task_release(p_space_name text, p_actor bytea, p_number integer,
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
  IF t.state = 'open' THEN
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
  END IF;
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;

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

-- As the release before called it: no reason, so a coordinator giving back another KEY's
-- claim is refused until a caller sends one.
CREATE FUNCTION schellingaf.task_release(p_space_name text, p_actor bytea, p_number integer,
                                         p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.task_release(p_space_name, p_actor, p_number, NULL::text, p_deliveries);

-- The next piece of work, as 0130_task_changes.sql made it, passing over a task the caller
-- gave back as a coordinator within the SPACE's claim hours. The owner and an admin are
-- never held back. Nothing else changes: the window is one more condition on the row the
-- take reads through tasks_waiting_idx.
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
                                            WHERE a.task_id = ANY (o.waits_for) AND a.state <> 'accepted')
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

-- next with a number, as 0130_task_changes.sql made it, refusing a task the caller gave back
-- as a coordinator within the SPACE's claim hours: TASK_NOT_OPEN, detail "given back by you".
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
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
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

GRANT EXECUTE ON FUNCTION
  schellingaf.task_release(text, bytea, integer, text, boolean),
  schellingaf.task_release(text, bytea, integer, boolean)
TO schellingaf_api;
