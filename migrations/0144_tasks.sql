-- Who still stands when a task is checked or reviewed (security review, 7 October 2026).
--
-- Two rules, each decided by the owner:
--
--   a confirmation   counts toward accepting a task while its KEY is blocked neither in the
--                    SPACE (space_blocks) nor by the operator (peers.blocked_at), read at
--                    each confirm and on every answer, as a document's confirmations are
--                    (0138_document_decision.sql). A KEY that left, was removed without a
--                    block or was demoted still counts, and an unblocked KEY counts again.
--                    The check stays recorded; nothing accepted is undone; a reject's
--                    cleared list is the record and stays whole. task_check() counts so,
--                    next's offer cap counts so, the review's unchecked signal
--                    (upkeep_due()) counts so, and task_item() names in
--                    confirmations.given, and in each attempt's confirmations, only those.
--   the task list's  review (upkeep tasks) is a coordinator's while it is held: next does
--   review           not renew it for a holder now ranked below coordinator, and done and
--                    progress refuse such a holder TASK_DENIED, so its claim passes and the
--                    next coordinator to ask takes the same row.
--
-- Every function is replaced whole, from the newest body on main, with its changed lines
-- marked 0144. No table, grant of a table, or policy changes.

-- Whether a confirmation by KEY p_peer in SPACE p_space counts now: the KEY is blocked
-- neither in that SPACE nor by the operator. Internal, granted to nobody: task_check() and
-- next_job() count with it, as the owner, and confirmation_counts() answers it for a caller.
CREATE FUNCTION schellingaf.confirmation_stands(p_space uuid, p_peer bytea)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN NOT EXISTS (SELECT 1 FROM schellingaf.space_blocks b WHERE b.space_id = p_space AND b.peer_id = p_peer)
         AND NOT EXISTS (SELECT 1 FROM schellingaf.peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL);

-- confirmation_stands() for task_item(), which the list reads as the caller: a definer, so it
-- sees a block the caller's own row security hides. It answers only about a SPACE the caller
-- may read, and false, naming nothing, otherwise, an anonymous reader included. The one other
-- way it answers is on a connection that never bound a caller: the write pool, where the task
-- functions answer their writes. readTx() binds the setting in every read transaction, ''
-- for nobody (src/db/sql.ts), so only a connection that never ran one reads it as NULL, and
-- the test that holds this is test/sec-tasks-standing.test.ts. Called once a confirmation,
-- about its own row.
CREATE FUNCTION schellingaf.confirmation_counts(p_space uuid, p_peer bytea)
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (current_setting('schellingaf.peer_id', true) IS NULL
          OR schellingaf.caller_in_space(p_space) OR schellingaf.space_is_public(p_space))
         AND schellingaf.confirmation_stands(p_space, p_peer);
GRANT EXECUTE ON FUNCTION schellingaf.confirmation_counts(uuid, bytea) TO schellingaf_api;

-- One task as every answer shows it, as 0141_task_claims.sql made it, with the lines marked
-- 0144: confirmations.given and each attempt's confirmations name the confirmations that
-- count, those whose KEY is not blocked now.

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
      -- claims: a claimed task that is not upkeep names its live claim taken first, with that
      -- claim's own expiry; the row's claimed_until, the latest, is for predicates only.
      'claimed_by', coalesce(CASE WHEN t.state = 'claimed' AND t.upkeep IS NULL THEN
                               (SELECT encode(c.peer_id, 'hex') FROM schellingaf.task_claims c
                                   WHERE c.task_id = t.task_id AND c.claimed_until > now()
                                   ORDER BY c.claimed_at, c.peer_id LIMIT 1) END,
                             encode(t.claimed_by, 'hex')),
      'claimed_until', coalesce(CASE WHEN t.state = 'claimed' AND t.upkeep IS NULL THEN
                                  (SELECT c.claimed_until FROM schellingaf.task_claims c
                                   WHERE c.task_id = t.task_id AND c.claimed_until > now()
                                   ORDER BY c.claimed_at, c.peer_id LIMIT 1) END,
                                t.claimed_until),
      'done_post_id', t.done_post_id, 'done_at', t.done_at, 'accepted_at', t.accepted_at,
      'confirmations', jsonb_build_object(
        'required', CASE WHEN t.state = 'done' THEN greatest(p_required, 1) ELSE p_required END,
        'given', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                    FROM schellingaf.task_checks c
                   WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.verdict = 'confirm'
                     AND c.attempt IS NOT DISTINCT FROM t.attempt
                     AND schellingaf.confirmation_counts(c.space_id, c.peer_id))))  -- 0144: blocked confirmers
    || CASE WHEN t.state = 'claimed' AND t.claimed_until <= now()
            THEN jsonb_build_object('claim_expired', true) ELSE '{}'::jsonb END
    -- claims: every live claim, by when it was taken, only while two or more live.
    || CASE WHEN t.state = 'claimed' AND t.upkeep IS NULL
                 AND (SELECT count(*) FROM schellingaf.task_claims c
                       WHERE c.task_id = t.task_id AND c.claimed_until > now()) >= 2
            THEN jsonb_build_object('claimants', (SELECT jsonb_agg(jsonb_build_object('by', encode(c.peer_id, 'hex'),
                                                                                     'until', c.claimed_until)
                                                                  ORDER BY c.claimed_at, c.peer_id)
                                                     FROM schellingaf.task_claims c
                                                    WHERE c.task_id = t.task_id AND c.claimed_until > now()))
            ELSE '{}'::jsonb END
    || coalesce((SELECT jsonb_build_object('rejected', jsonb_build_object(
                          'by', encode(r.peer_id, 'hex'), 'reason', r.reason, 'at', r.checked_at,
                          'result', r.result_post_id,
                          'cleared', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                                        FROM schellingaf.task_checks c
                                       WHERE c.task_id = t.task_id AND c.cycle = r.cycle AND c.verdict = 'confirm'
                                         AND (r.attempt IS NULL OR c.attempt = r.attempt)))
                        || CASE WHEN r.attempt IS NOT NULL
                                     AND (SELECT count(*) FROM schellingaf.task_attempts x
                                           WHERE x.task_id = t.task_id AND x.cycle = r.cycle) >= 2
                                THEN jsonb_build_object('attempt', r.attempt) ELSE '{}'::jsonb END)
                   FROM schellingaf.task_checks r
                  WHERE r.task_id = t.task_id AND r.cycle = t.cycle - 1 AND r.verdict = 'reject'
                  ORDER BY r.checked_at DESC LIMIT 1), '{}'::jsonb)
    -- attempts: the attempt of record, and every attempt of the current cycle, only while
    -- that cycle holds two or more.
    || CASE WHEN t.attempts >= 2
                 AND (SELECT count(*) FROM schellingaf.task_attempts x WHERE x.task_id = t.task_id AND x.cycle = t.cycle) >= 2
            THEN jsonb_build_object(
                   'attempt', t.attempt,
                   'attempts', (SELECT jsonb_agg(
                                         jsonb_build_object(
                                           'attempt', a.attempt, 'by', encode(a.peer_id, 'hex'), 'post_id', a.post_id, 'at', a.at,
                                           'state', CASE WHEN j.peer_id IS NOT NULL THEN 'rejected'
                                                         WHEN t.state = 'accepted' AND t.attempt = a.attempt THEN 'accepted'
                                                         WHEN t.state = 'accepted' THEN 'passed'
                                                         ELSE 'pending' END,
                                           'confirmations', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                                                               FROM schellingaf.task_checks c
                                                              WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                                                AND c.verdict = 'confirm'
                                                                AND schellingaf.confirmation_counts(c.space_id, c.peer_id)))  -- 0144
                                         || CASE WHEN a.author_id <> a.peer_id
                                                 THEN jsonb_build_object('author', encode(a.author_id, 'hex')) ELSE '{}'::jsonb END
                                         || CASE WHEN j.peer_id IS NOT NULL
                                                 THEN jsonb_build_object('rejected', jsonb_build_object(
                                                        'by', encode(j.peer_id, 'hex'), 'reason', j.reason, 'at', j.checked_at))
                                                 ELSE '{}'::jsonb END
                                         ORDER BY a.attempt)
                                  FROM schellingaf.task_attempts a
                                  LEFT JOIN LATERAL (SELECT c.peer_id, c.reason, c.checked_at FROM schellingaf.task_checks c
                                                      WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                                        AND c.verdict = 'reject'
                                                      ORDER BY c.checked_at LIMIT 1) j ON true
                                 WHERE a.task_id = t.task_id AND a.cycle = t.cycle))
            ELSE '{}'::jsonb END
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
    || CASE WHEN t.upkeep IS NOT NULL THEN jsonb_build_object('upkeep', t.upkeep) ELSE '{}'::jsonb END  -- 0134
  END;

-- task_check() as 0140_task_attempts.sql made it, with the line marked 0144: a confirm
-- counts the confirmations of its attempt whose KEYS are not blocked now. Its 0137 contested
-- block is carried as it was.

CREATE OR REPLACE FUNCTION schellingaf.task_check(p_space_name text, p_actor bytea, p_number integer, p_verdict text,
                                       p_post uuid DEFAULT NULL, p_reason text DEFAULT NULL,
                                       p_deliveries boolean DEFAULT false, p_attempt integer DEFAULT NULL,
                                       p_cycle integer DEFAULT NULL, p_offer_minutes integer DEFAULT 30)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; r task_checks%ROWTYPE; a task_attempts%ROWTYPE; v_given bigint;
        v_state text; v_cycle integer; v_offer_cycle integer; v_offer_attempt integer; v_late integer;
        v_pending integer[]; v_mine integer; v_count integer; v_next task_attempts%ROWTYPE; v_detail text;
        v_peers bytea[]; v_delivered jsonb := '[]';
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
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;
  v_state := CASE WHEN t.state = 'claimed' AND t.claimed_until <= now() THEN 'open' ELSE t.state END;

  -- The caller's live offer for this task: at most one, since next drops a KEY's offers
  -- in the SPACE before it makes one.
  SELECT o.cycle, o.attempt INTO v_offer_cycle, v_offer_attempt FROM task_check_offers o
   WHERE o.task_id = t.task_id AND o.peer_id = p_actor
     AND o.offered_at > now() - make_interval(mins => p_offer_minutes)
   ORDER BY o.offered_at DESC LIMIT 1;
  IF p_cycle > t.cycle THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'cycle: the task is at cycle ' || t.cycle;
  END IF;
  v_cycle := coalesce(p_cycle, v_offer_cycle, t.cycle);

  IF v_cycle < t.cycle THEN
    v_late := v_cycle;
  ELSIF t.state <> 'done' THEN
    -- Reopened by a reject, and not done again: the late check of the cycle before.
    IF t.state IN ('open', 'claimed') AND t.cycle > 0
       AND EXISTS (SELECT 1 FROM task_checks c WHERE c.task_id = t.task_id AND c.cycle = t.cycle - 1 AND c.verdict = 'reject') THEN
      v_late := t.cycle - 1;
    ELSE
      RAISE EXCEPTION 'TASK_NOT_DONE' USING DETAIL = v_state;
    END IF;
  ELSIF p_attempt IS NOT NULL THEN
    SELECT * INTO a FROM task_attempts x WHERE x.task_id = t.task_id AND x.attempt = p_attempt;
    IF NOT FOUND THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'attempt ' || p_attempt; END IF;
    IF a.cycle < t.cycle THEN v_late := a.cycle; END IF;
  ELSIF v_offer_cycle = t.cycle AND v_offer_attempt IS NOT NULL THEN
    SELECT * INTO a FROM task_attempts x WHERE x.task_id = t.task_id AND x.attempt = v_offer_attempt;
  ELSE
    SELECT coalesce(array_agg(x.attempt ORDER BY x.attempt), '{}'::integer[]) INTO v_pending
      FROM task_attempts x
     WHERE x.task_id = t.task_id AND x.cycle = t.cycle
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = x.task_id AND c.cycle = x.cycle AND c.attempt = x.attempt AND c.verdict = 'reject');
    IF cardinality(v_pending) > 1 THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'attempt: name the attempt you checked: ' || array_to_string(v_pending, ', ');
    END IF;
    SELECT * INTO a FROM task_attempts x WHERE x.task_id = t.task_id AND x.attempt = v_pending[1];
  END IF;

  -- The late check, or a check of an attempt already rejected: refused naming the rejecter.
  -- Through the route it is an answer, with that reject's notice reaching the caller once
  -- and the caller's offer for this task dropped, so a retry checks the present.
  IF v_late IS NOT NULL THEN
    SELECT * INTO r FROM task_checks c
     WHERE c.task_id = t.task_id AND c.cycle = v_late AND c.verdict = 'reject'
     ORDER BY c.checked_at DESC LIMIT 1;
    v_detail := v_state || ': rejected by ' || encode(r.peer_id, 'hex');
  ELSE
    SELECT * INTO r FROM task_checks c
     WHERE c.task_id = t.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt AND c.verdict = 'reject'
     ORDER BY c.checked_at DESC LIMIT 1;
    IF FOUND THEN v_detail := 'attempt ' || a.attempt || ': rejected by ' || encode(r.peer_id, 'hex'); END IF;
  END IF;
  IF v_detail IS NOT NULL THEN
    IF NOT p_deliveries THEN RAISE EXCEPTION 'TASK_NOT_DONE' USING DETAIL = v_detail; END IF;
    IF NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                    WHERE md.recipient_id = p_actor AND md.task_id = t.task_id
                      AND md.task_cycle = r.cycle AND md.reason = 'task_rejected'
                      AND md.task_attempt IS NOT DISTINCT FROM r.attempt) THEN
      v_delivered := deliver_task_notices(s.space_id, t.task_id, r.cycle, r.peer_id,
                                          ARRAY[p_actor], ARRAY['task_rejected'], r.attempt);
    END IF;
    DELETE FROM task_check_offers o WHERE o.task_id = t.task_id AND o.peer_id = p_actor;
    RETURN jsonb_build_object('refused', 'TASK_NOT_DONE', 'detail', v_detail, 'delivered', v_delivered);
  END IF;

  -- The doer: a KEY that wrote this attempt's post, or made an attempt in the cycle. Where
  -- the SPACE asks for no confirmation, a KEY with an attempt may still confirm another's.
  IF a.peer_id = p_actor OR a.author_id = p_actor THEN
    RAISE EXCEPTION 'TASK_SELF_CHECK' USING DETAIL = 'attempt ' || a.attempt;
  END IF;
  SELECT x.attempt INTO v_mine FROM task_attempts x
   WHERE x.task_id = t.task_id AND x.cycle = t.cycle AND x.peer_id = p_actor;
  IF FOUND AND NOT (s.task_confirmations = 0 AND p_verdict = 'confirm') THEN
    RAISE EXCEPTION 'TASK_SELF_CHECK' USING DETAIL = 'attempt ' || v_mine;
  END IF;
  IF EXISTS (SELECT 1 FROM task_checks c
              WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.peer_id = p_actor
                AND (c.attempt = a.attempt OR c.attempt IS NULL)) THEN
    RAISE EXCEPTION 'TASK_ALREADY_CHECKED';
  END IF;
  IF p_post IS NOT NULL AND NOT EXISTS (SELECT 1 FROM posts p
                                         WHERE p.post_id = p_post AND p.space_id = s.space_id
                                           AND p.author_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_POST_NOT_FOUND';
  END IF;

  INSERT INTO task_checks (task_id, space_id, cycle, peer_id, verdict, post_id, reason, result_post_id, attempt)
  VALUES (t.task_id, s.space_id, t.cycle, p_actor, p_verdict, p_post, nullif(p_reason, ''), a.post_id, a.attempt);
  -- The check the offer held a place for is made: the offer is spent, so a later check by
  -- this KEY reads the task's present cycle, not this one.
  DELETE FROM task_check_offers o WHERE o.task_id = t.task_id AND o.peer_id = p_actor;
  v_cycle := t.cycle;
  SELECT count(*) INTO v_count FROM task_attempts x WHERE x.task_id = t.task_id AND x.cycle = t.cycle;

  IF p_verdict = 'confirm' THEN
    -- 0144: a confirmation counts while its KEY is blocked neither here nor by the operator.
    SELECT count(*) INTO v_given FROM task_checks c
     WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.attempt = a.attempt AND c.verdict = 'confirm'
       AND confirmation_stands(c.space_id, c.peer_id);
    IF v_given >= greatest(s.task_confirmations, 1) THEN
      UPDATE tasks k SET state = 'accepted', accepted_at = now(),
                         attempt = a.attempt, claimed_by = a.peer_id, done_post_id = a.post_id
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
    END IF;
    v_delivered := deliver_task_notices(s.space_id, t.task_id, v_cycle, p_actor, ARRAY[a.peer_id::bytea],
                                        ARRAY[CASE WHEN t.state = 'accepted' THEN 'task_accepted' ELSE 'task_confirmed' END],
                                        a.attempt);
  ELSE
    SELECT * INTO v_next FROM task_attempts x
     WHERE x.task_id = t.task_id AND x.cycle = t.cycle
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = x.task_id AND c.cycle = x.cycle AND c.attempt = x.attempt AND c.verdict = 'reject')
     ORDER BY x.attempt LIMIT 1;
    IF FOUND THEN
      -- Another attempt waits: the task stays done, and the attempt of record is the lowest
      -- pending one. done_at stays, so the check-first wait does not start again.
      UPDATE tasks k SET attempt = v_next.attempt, claimed_by = v_next.peer_id, done_post_id = v_next.post_id
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
    ELSE
      UPDATE tasks k SET state = 'open', cycle = k.cycle + 1, claimed_by = NULL, claimed_until = NULL,
                         done_post_id = NULL, done_at = NULL, attempt = NULL
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
    END IF;
    -- The attempt's submitter, the KEYS whose confirmations of it the reject voided, and
    -- its post's author.
    SELECT coalesce(array_agg(q.x ORDER BY q.x), '{}'::bytea[]) INTO v_peers
      FROM (SELECT a.peer_id::bytea AS x
            UNION
            SELECT a.author_id::bytea
            UNION
            SELECT c.peer_id FROM task_checks c
             WHERE c.task_id = t.task_id AND c.cycle = v_cycle AND c.attempt = a.attempt AND c.verdict = 'confirm') q;
    -- 0137 BEGIN contested: the same delivery tells the author of each standing finding
    -- that is this result or rests on it, once a finding. The result is read from the check
    -- just made, which kept it before the update above cleared it. clock_timestamp(), taken
    -- under the SPACE lock, never now(): a finding written while this call waited for that
    -- lock is posted after the transaction began, and would be marked and never told.
    -- attempts: the check of this attempt alone, and its notices carry the attempt.
    SELECT deliver_notices(s.space_id, p_actor, t.task_id, v_cycle,
             v_peers || coalesce(array_agg(c.peer ORDER BY c.peer, c.post) FILTER (WHERE c.peer IS NOT NULL), '{}'),
             array_fill('task_rejected'::text, ARRAY[cardinality(v_peers)])
               || coalesce(array_agg('contested'::text ORDER BY c.peer, c.post) FILTER (WHERE c.peer IS NOT NULL), '{}'),
             array_fill(NULL::uuid, ARRAY[cardinality(v_peers)])
               || coalesce(array_agg(c.post ORDER BY c.peer, c.post) FILTER (WHERE c.peer IS NOT NULL), '{}'),
             a.attempt)
      INTO v_delivered
      FROM task_checks k
      LEFT JOIN LATERAL contested_findings(s.space_id, ARRAY[k.result_post_id], p_actor, clock_timestamp()) c ON true
     WHERE k.task_id = t.task_id AND k.cycle = v_cycle AND k.peer_id = p_actor AND k.attempt = a.attempt;
    -- 0137 END contested
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN v_count >= 2 THEN jsonb_build_object('attempt', a.attempt) ELSE '{}'::jsonb END
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- next_job()'s fourteen-argument form as 0141_task_claims.sql made it, its three version
-- check (0138) blocks carried exactly, with the lines marked 0144: the offer cap counts the
-- confirmations that count, and step 1 renews a task-list review only for a holder that
-- still ranks coordinator or above. The twelve-argument wrapper is unchanged.

CREATE OR REPLACE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,
                                     p_words jsonb, p_held_max integer, p_check_first_minutes integer,
                                     p_offer_minutes integer, p_not_accepted_max integer,
                                     p_document_gap_hours integer, p_review_gap_hours integer,
                                     p_join boolean, p_claimants_max integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_check_rank int; v_checks boolean;
        v_job text; v_case text; v_values jsonb := '{}'; v_renewed boolean := false; v_out jsonb;
        v_kind text; v_due jsonb; v_full boolean; u task_upkeep%ROWTYPE;
        v_attempt integer; v_waiting integer; v_from integer;
        v_version schellingaf.oracle_versions%ROWTYPE;  -- 0138
BEGIN
  IF p_job IS NULL OR p_job NOT IN ('any', 'work', 'check', 'upkeep') THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;

  -- With a number, that task, as take_task() takes it; it checks who may and takes the
  -- SPACE lock, so the caller's offers are dropped under it.
  -- claims: join holds a task by its number only.
  IF p_join AND p_number IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'join needs number'; END IF;
  IF p_number IS NOT NULL THEN
    IF p_job NOT IN ('any', 'work') OR p_tag IS NOT NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    v_out := take_task(p_space_name, p_actor, p_number, p_held_max, p_join, p_claimants_max);
    DELETE FROM task_check_offers o
     WHERE o.space_id = (SELECT sp.space_id FROM spaces sp WHERE sp.name = p_space_name) AND o.peer_id = p_actor;
    RETURN (v_out - 'joined') || jsonb_build_object(
      'job', 'work',
      'why', next_why(p_words,
                      CASE WHEN v_out ? 'changed_since_claim' THEN 'renewed_changed'
                           WHEN (v_out ->> 'renewed')::boolean THEN 'renewed'
                           WHEN v_out ? 'joined' AND (p_words -> 'why') ? 'joined' THEN 'joined'  -- claims
                           ELSE 'number' END,
                      jsonb_build_object('number', p_number, 'from', v_out -> 'changed_since_claim' -> 'from',
                                         'to', v_out -> 'changed_since_claim' -> 'to', 'others', v_out -> 'joined')));
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  -- A check takes a coordinator or above where the SPACE says so; every other job a writer.
  v_check_rank := CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < (CASE WHEN p_job = 'check' THEN v_check_rank ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  v_check_rank := CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END;
  v_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF v_rank < (CASE WHEN p_job = 'check' THEN v_check_rank ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  -- Whether job any may hand this caller a check: a writer is passed over where only
  -- coordinators check.
  v_checks := p_job = 'any' AND v_rank >= v_check_rank;

  -- Every next drops the caller's offers in this SPACE: one it did not use is no longer
  -- held for it, so the next KEY may be sent.
  DELETE FROM task_check_offers o WHERE o.space_id = s.space_id AND o.peer_id = p_actor;

  -- 1. Renew a task the caller holds, of the tag asked when one is, and of the job asked
  -- (0134): job work never an upkeep task, job upkeep only one, and an upkeep task only
  -- while its claim lasts.
  -- claims: two probes, the lower number wins: the caller's claim rows here, live or
  -- passed, never for job upkeep; and an upkeep task it holds live on the row.
  IF p_job IN ('any', 'work', 'upkeep') THEN
    SELECT * INTO t FROM tasks m
     WHERE m.task_id = (SELECT x.task_id
                          FROM (SELECT k.number, k.task_id
                                  FROM task_claims c JOIN tasks k ON k.task_id = c.task_id
                                 WHERE c.space_id = s.space_id AND c.peer_id = p_actor AND p_job <> 'upkeep'
                                   AND k.state = 'claimed' AND (p_tag IS NULL OR k.tag = p_tag)
                                UNION ALL
                                SELECT k.number, k.task_id FROM tasks k
                                 WHERE k.space_id = s.space_id AND k.upkeep IS NOT NULL AND k.state = 'claimed'
                                   AND k.claimed_by = p_actor AND k.claimed_until > now() AND p_job <> 'work'
                                   AND (p_tag IS NULL OR k.tag = p_tag)
                                   AND (k.upkeep <> 'tasks' OR v_rank >= 25)) x  -- 0144: a coordinator's review
                         ORDER BY x.number
                         LIMIT 1)
     FOR UPDATE;
    IF FOUND THEN
      v_job := CASE WHEN t.upkeep IS NULL THEN 'work' ELSE 'upkeep' END;
      -- The revision this KEY took: its own claim's, for a task that is not upkeep.
      v_from := CASE WHEN t.upkeep IS NULL
                     THEN (SELECT c.claim_revision FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor)
                     ELSE t.claim_revision END;
      v_values := jsonb_build_object('from', v_from, 'to', t.revision);
      -- 0134: an upkeep claim ends at most twice the claim hours after it was taken.
      IF t.upkeep IS NOT NULL AND t.claimed_until >= t.claimed_at + make_interval(hours => 2 * s.task_claim_hours) THEN
        v_case := 'held_upkeep';
        v_values := v_values || jsonb_build_object('hours', 2 * s.task_claim_hours);
      ELSIF t.upkeep IS NULL THEN
        -- claims: the caller's own claim is renewed, and the row follows.
        UPDATE task_claims c SET claimed_until = now() + make_interval(hours => s.task_claim_hours)
         WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
        t := sync_task_claims(t.task_id);
        v_renewed := true;
        v_case := CASE WHEN v_from < t.revision THEN 'renewed_changed' ELSE 'renewed' END;
      ELSE
        UPDATE tasks h
           SET claimed_until = least(now() + make_interval(hours => s.task_claim_hours),
                                     h.claimed_at + make_interval(hours => 2 * s.task_claim_hours))
         WHERE h.task_id = t.task_id
        RETURNING * INTO t;
        v_renewed := true;
        v_case := CASE WHEN v_from < t.revision THEN 'renewed_changed' ELSE 'renewed' END;
      END IF;
    END IF;
  END IF;

  -- 2. Check first: a done task that has waited, oldest done first, under the offer cap.
  IF v_job IS NULL AND v_checks THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.upkeep IS NULL  -- 0134
       AND (p_tag IS NULL OR d.tag = p_tag)
       -- attempts: an attempt the caller may check waits, and the caller made none in the cycle.
       AND NOT EXISTS (SELECT 1 FROM task_attempts m
                        WHERE m.task_id = d.task_id AND m.cycle = d.cycle AND m.peer_id = p_actor)
       AND EXISTS (SELECT 1 FROM task_attempts a
                    WHERE a.task_id = d.task_id AND a.cycle = d.cycle AND a.author_id <> p_actor
                      AND NOT EXISTS (SELECT 1 FROM task_checks c
                                       WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                         AND (c.verdict = 'reject' OR c.peer_id = p_actor)))
       AND d.done_at <= now() - make_interval(mins => p_check_first_minutes)
       -- The offer cap: confirmations given, and live offers to KEYS that have not checked
       -- it, fewer than it needs. A task needs one at least: lowering the setting accepts no
       -- done task by itself, and the next confirmation does.
       AND (SELECT coalesce(max(g.n), 0)
              FROM (SELECT count(*) AS n FROM task_checks c
                     WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm'
                       AND confirmation_stands(c.space_id, c.peer_id)  -- 0144
                       AND NOT EXISTS (SELECT 1 FROM task_checks j
                                        WHERE j.task_id = c.task_id AND j.cycle = c.cycle AND j.attempt = c.attempt
                                          AND j.verdict = 'reject')
                     GROUP BY c.attempt) g)
         + (SELECT count(*) FROM task_check_offers o
             WHERE o.task_id = d.task_id AND o.cycle = d.cycle
               AND o.offered_at > now() - make_interval(mins => p_offer_minutes)
               AND NOT EXISTS (SELECT 1 FROM task_checks k
                                WHERE k.task_id = o.task_id AND k.cycle = o.cycle AND k.peer_id = o.peer_id))
         < greatest(s.task_confirmations, 1)
     ORDER BY d.done_at, d.number
     LIMIT 1;
    IF FOUND THEN
      v_job := 'check';
      v_case := 'check_first';
      v_values := jsonb_build_object('minutes', floor(extract(epoch FROM now() - t.done_at) / 60)::int);
    END IF;
  END IF;

  -- version check (0138) begin
  -- V1: a waiting version of the document, for job any with no tag, before upkeep and work.
  IF v_job IS NULL AND p_job = 'any' AND p_tag IS NULL AND (p_words -> 'why') ? 'check_version' THEN
    v_version := next_version_check(s, p_actor, v_rank);
    IF v_version.post_id IS NOT NULL THEN
      v_job := 'check';
      v_case := CASE WHEN v_rank >= 25 THEN 'check_version_decide' ELSE 'check_version' END;
    END IF;
  END IF;
  -- version check (0138) end

  -- 3. and 4. Upkeep (0134): the task list's review for a coordinator or above, then the
  -- document's, each when upkeep_due() calls for it. Never with a tag, which narrows work
  -- and checks, and never without words, which a caller from before upkeep sends none of.
  IF v_job IS NULL AND p_job IN ('any', 'upkeep') AND p_tag IS NULL AND p_words ? 'upkeep' THEN
    SELECT * INTO u FROM task_upkeep k WHERE k.space_id = s.space_id;
    FOREACH v_kind IN ARRAY ARRAY['tasks', 'document'] LOOP
      CONTINUE WHEN v_job IS NOT NULL OR (v_kind = 'tasks' AND v_rank < 25);
      -- The live one of its kind, if any: one a SPACE.
      SELECT * INTO t FROM tasks k
       WHERE k.space_id = s.space_id AND k.upkeep = v_kind AND k.state IN ('open', 'claimed', 'done')
       FOR UPDATE;
      IF FOUND THEN
        -- Held, or done and waiting for its version: nobody else gets one.
        CONTINUE WHEN t.state = 'done' OR (t.state = 'claimed' AND t.claimed_until > now());
        -- Open, or its claim passed: retired when no longer due, else claimed afresh for
        -- any KEY but the one whose claim passed or that released it itself, and never by
        -- a KEY below an admin that gave it back within the claim hours.
        v_due := upkeep_due(s, v_kind, p_words);
        IF v_due IS NULL THEN
          UPDATE tasks k SET state = 'retired', claimed_by = NULL, claimed_until = NULL,
                             closed_by = NULL, closed_at = now(), close_reason = 'no longer due'
           WHERE k.task_id = t.task_id;
          CONTINUE;
        END IF;
        CONTINUE WHEN t.state = 'claimed' AND t.claimed_by = p_actor;
        -- Nor to the KEY that released it, which would get a fresh claim on the same row.
        CONTINUE WHEN t.state = 'open' AND t.left_by IS NOT DISTINCT FROM p_actor;
        CONTINUE WHEN v_rank < 30 AND t.released_by IS NOT DISTINCT FROM p_actor
                      AND t.released_at > now() - make_interval(hours => s.task_claim_hours);
        UPDATE tasks k SET state = 'claimed', claimed_by = p_actor,
                           claimed_until = now() + make_interval(hours => s.task_claim_hours),
                           claim_revision = k.revision, claimed_at = now(), takes = k.takes + 1
         WHERE k.task_id = t.task_id
        RETURNING * INTO t;
      ELSE
        -- A new one: the cheap tests first, then the counts.
        CONTINUE WHEN v_kind = 'document' AND (NOT s.document OR s.upkeep_document_after = 0
                        OR now() < u.document_handed_at + make_interval(hours => p_document_gap_hours));
        CONTINUE WHEN v_kind = 'tasks' AND (s.upkeep_tasks_hours = 0
                        OR now() < u.last_review_at + make_interval(hours => p_review_gap_hours));
        -- None while the SPACE holds as many tasks not yet accepted as it may, counted in
        -- the two waiting indexes up to the limit and no further.
        IF v_full IS NULL THEN
          v_full := (SELECT count(*) FROM (SELECT 1 FROM tasks w
                                            WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed')
                                            LIMIT p_not_accepted_max) a)
                  + (SELECT count(*) FROM (SELECT 1 FROM tasks d
                                            WHERE d.space_id = s.space_id AND d.state = 'done'
                                            LIMIT p_not_accepted_max) b) >= p_not_accepted_max;
        END IF;
        CONTINUE WHEN v_full;
        v_due := upkeep_due(s, v_kind, p_words);
        CONTINUE WHEN v_due IS NULL;
        INSERT INTO tasks (space_id, number, title, body, upkeep, state, claimed_by, claimed_until,
                           claim_revision, claimed_at, takes)
        VALUES (s.space_id, (SELECT coalesce(max(m.number), 0) + 1 FROM tasks m WHERE m.space_id = s.space_id),
                v_due ->> 'title', v_due ->> 'body', v_kind, 'claimed', p_actor,
                now() + make_interval(hours => s.task_claim_hours), 1, now(), 1)
        RETURNING * INTO t;
        IF v_kind = 'document' THEN
          INSERT INTO task_upkeep AS k (space_id, document_handed_at) VALUES (s.space_id, now())
          ON CONFLICT (space_id) DO UPDATE SET document_handed_at = EXCLUDED.document_handed_at;
        END IF;
      END IF;
      v_job := 'upkeep';
      v_case := v_due ->> 'case';
      v_values := v_due -> 'values';
    END LOOP;
  END IF;

  -- 5. Work: the lowest-numbered task that is open, or whose claim passed, whose after are
  -- all accepted or retired, never one the caller gave back below an admin within the
  -- SPACE's claim hours, and never an upkeep task.
  IF v_job IS NULL AND p_job IN ('any', 'work') THEN
    UPDATE tasks c SET takes = c.takes + 1
     WHERE c.task_id = (SELECT o.task_id FROM tasks o
                         WHERE o.space_id = s.space_id AND o.state IN ('open', 'claimed')
                           AND (o.state = 'open' OR o.claimed_until <= now())
                           AND o.upkeep IS NULL  -- 0134
                           AND (p_tag IS NULL OR o.tag = p_tag)
                           AND NOT EXISTS (SELECT 1 FROM tasks a
                                            WHERE a.task_id = ANY (o.waits_for) AND a.state NOT IN ('accepted', 'retired'))
                           AND NOT (v_rank < 30 AND o.released_by IS NOT DISTINCT FROM p_actor
                                    AND o.released_at > now() - make_interval(hours => s.task_claim_hours))
                         ORDER BY o.number
                         LIMIT 1
                         FOR UPDATE SKIP LOCKED)
    RETURNING * INTO t;
    IF FOUND THEN
      -- claims: passed claims of it give way, and the caller's claim is a row of its own.
      DELETE FROM task_claims k WHERE k.task_id = t.task_id AND k.claimed_until <= now();
      INSERT INTO task_claims (task_id, space_id, peer_id, claimed_at, claimed_until, claim_revision)
      VALUES (t.task_id, s.space_id, p_actor, now(), now() + make_interval(hours => s.task_claim_hours), t.revision);
      t := sync_task_claims(t.task_id);
      v_job := 'work';
      v_case := 'work';
    END IF;
  END IF;

  -- 6. Check when idle, under the cap; or job check, the lowest-numbered with no cap.
  IF v_job IS NULL AND (v_checks OR p_job = 'check') THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.upkeep IS NULL  -- 0134
       AND (p_tag IS NULL OR d.tag = p_tag)
       -- attempts: an attempt the caller may check waits, and the caller made none in the cycle.
       AND NOT EXISTS (SELECT 1 FROM task_attempts m
                        WHERE m.task_id = d.task_id AND m.cycle = d.cycle AND m.peer_id = p_actor)
       AND EXISTS (SELECT 1 FROM task_attempts a
                    WHERE a.task_id = d.task_id AND a.cycle = d.cycle AND a.author_id <> p_actor
                      AND NOT EXISTS (SELECT 1 FROM task_checks c
                                       WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                         AND (c.verdict = 'reject' OR c.peer_id = p_actor)))
       AND (p_job = 'check'
            OR (SELECT coalesce(max(g.n), 0)
                  FROM (SELECT count(*) AS n FROM task_checks c
                         WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm'
                           AND confirmation_stands(c.space_id, c.peer_id)  -- 0144
                           AND NOT EXISTS (SELECT 1 FROM task_checks j
                                            WHERE j.task_id = c.task_id AND j.cycle = c.cycle AND j.attempt = c.attempt
                                              AND j.verdict = 'reject')
                         GROUP BY c.attempt) g)
             + (SELECT count(*) FROM task_check_offers o
                 WHERE o.task_id = d.task_id AND o.cycle = d.cycle
                   AND o.offered_at > now() - make_interval(mins => p_offer_minutes)
                   AND NOT EXISTS (SELECT 1 FROM task_checks k
                                    WHERE k.task_id = o.task_id AND k.cycle = o.cycle AND k.peer_id = o.peer_id))
             < greatest(s.task_confirmations, 1))
     ORDER BY d.number
     LIMIT 1;
    IF FOUND THEN
      v_job := 'check';
      v_case := CASE WHEN p_job = 'check' THEN 'check_asked' ELSE 'check_idle' END;
    END IF;
  END IF;

  -- version check (0138) begin
  -- V2: job check with no tag and no done task waiting for this KEY: a waiting version.
  IF v_job IS NULL AND p_job = 'check' AND p_tag IS NULL AND (p_words -> 'why') ? 'check_version' THEN
    v_version := next_version_check(s, p_actor, v_rank);
    IF v_version.post_id IS NOT NULL THEN
      v_job := 'check';
      v_case := CASE WHEN v_rank >= 25 THEN 'check_version_decide' ELSE 'check_version' END;
    END IF;
  END IF;
  -- version check (0138) end

  -- version check (0138) begin
  -- V3: a waiting version's answer. No offer is written for it.
  IF v_version.post_id IS NOT NULL THEN
    RETURN next_version_answer(s, v_version, p_words, v_case);
  END IF;
  -- version check (0138) end

  -- A check claims nothing: the offer holds a place under the cap for p_offer_minutes, or
  -- until this KEY's next next here.
  IF v_job = 'check' THEN
    -- attempts: the offer names the lowest attempt the caller may check, and why says how
    -- many wait when two or more do, with words for it.
    SELECT min(a.attempt), (SELECT count(*) FROM task_attempts x
                             WHERE x.task_id = t.task_id AND x.cycle = t.cycle
                               AND NOT EXISTS (SELECT 1 FROM task_checks j
                                                WHERE j.task_id = x.task_id AND j.cycle = x.cycle AND j.attempt = x.attempt
                                                  AND j.verdict = 'reject'))
      INTO v_attempt, v_waiting
      FROM task_attempts a
     WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.author_id <> p_actor
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                          AND (c.verdict = 'reject' OR c.peer_id = p_actor));
    INSERT INTO task_check_offers (space_id, task_id, cycle, peer_id, attempt)
    VALUES (s.space_id, t.task_id, t.cycle, p_actor, v_attempt)
    ON CONFLICT (task_id, cycle, peer_id) DO UPDATE SET offered_at = now(), attempt = EXCLUDED.attempt;
    IF v_waiting >= 2 AND p_words -> 'why' ? 'check_attempts' THEN
      v_case := 'check_attempts';
      v_values := jsonb_build_object('attempts', v_waiting, 'attempt', v_attempt);
    ELSE
      v_attempt := NULL;
    END IF;
  END IF;

  -- 7. Stop.
  IF v_job IS NULL THEN
    v_job := 'stop';
    v_case := CASE p_job
                WHEN 'check' THEN 'stop_check'
                WHEN 'upkeep' THEN 'stop_upkeep'
                ELSE CASE WHEN EXISTS (SELECT 1 FROM tasks w
                                        WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed')
                                          AND (w.state = 'open' OR w.claimed_until <= now())
                                          AND w.upkeep IS NULL  -- 0134
                                          AND (p_tag IS NULL OR w.tag = p_tag)
                                          AND EXISTS (SELECT 1 FROM tasks a
                                                       WHERE a.task_id = ANY (w.waits_for)
                                                         AND a.state NOT IN ('accepted', 'retired')))
                          THEN 'stop_waiting' ELSE 'stop' END
              END;
  END IF;

  RETURN jsonb_build_object(
           'space', s.name, 'job', v_job,
           'why', next_why(p_words, v_case, v_values || CASE WHEN v_job = 'stop' THEN '{}'::jsonb
                                                          ELSE jsonb_build_object('number', t.number) END),
           -- 0138: verify is true for a check, a waiting version's included (task null), and
           -- for a check asked even when none waits; with no version check it answers as 0.3 did.
           'verify', v_job = 'check' OR p_job = 'check',
           'renewed', v_renewed,
           'task', CASE WHEN v_job <> 'stop' THEN task_item(t, s.task_confirmations) END)
         || CASE WHEN v_renewed AND v_from < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', v_from, 'to', t.revision))
                 ELSE '{}'::jsonb END
         || CASE WHEN v_attempt IS NOT NULL THEN jsonb_build_object('attempt', v_attempt) ELSE '{}'::jsonb END;
END $$;

-- task_done()'s seven-argument form as 0141_task_claims.sql made it, with the line marked
-- 0144: a task-list review is done only by a holder that still ranks coordinator or above.
-- The five- and four-argument wrappers are unchanged.

CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                      p_revision integer, p_deliveries boolean, p_attempts_max integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_version text; v_accept boolean; v_rank int; v_holder boolean;
        v_author bytea; v_n integer; v_count integer; v_waiting integer; v_contested boolean;
        v_my_rev integer; v_claimants bytea[] := '{}';
        r task_checks%ROWTYPE; v_peers bytea[]; v_delivered jsonb := '[]';
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
  IF t.state = 'deleted' THEN RAISE EXCEPTION 'TASK_NOT_FOUND' USING DETAIL = 'deleted'; END IF;

  -- An upkeep task: one holder, as 0134 made it.
  IF t.upkeep IS NOT NULL THEN
    -- A retry after a lost answer: what the first call did stands.
    IF t.state IN ('done', 'accepted') AND t.claimed_by = p_actor AND t.done_post_id = p_post THEN
      RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
    END IF;
    IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
    -- Held by nobody, or by a KEY whose claim has passed: the caller takes it first.
    IF t.state = 'open' OR (t.claimed_by <> p_actor AND t.claimed_until <= now()) THEN
      RAISE EXCEPTION 'TASK_NOT_CLAIMANT';
    END IF;
    IF t.claimed_by <> p_actor THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed'; END IF;
    -- 0144: the task list's review is a coordinator's, whoever took it before.
    IF t.upkeep = 'tasks' AND v_rank < 25 THEN RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex'); END IF;
    -- The words changed after the holder took them, or after the revision it sent.
    IF (p_revision IS NOT NULL AND p_revision <> t.revision)
       OR (p_revision IS NULL AND t.claim_revision < t.revision) THEN
      RAISE EXCEPTION 'TASK_CHANGED' USING DETAIL = t.revision::text;
    END IF;
    IF t.upkeep = 'document' THEN
      SELECT v.state INTO v_version FROM posts p JOIN oracle_versions v ON v.post_id = p.post_id
       WHERE p.post_id = p_post AND p.space_id = s.space_id AND p.author_id = p_actor AND p.kind = 'version'
         AND p.posted_at >= t.claimed_at AND v.state IN ('pending', 'current');
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'post_id: your version in this SPACE, posted after you took this task';
      END IF;
      v_accept := v_version = 'current';
    ELSE
      IF NOT EXISTS (SELECT 1 FROM posts p
                      WHERE p.post_id = p_post AND p.space_id = s.space_id AND p.author_id = p_actor
                        AND p.kind = 'decision' AND p.posted_at >= t.claimed_at) THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'post_id: your decision in this SPACE, posted after you took this task';
      END IF;
      v_accept := true;
      -- When its holder took it, when next read the counts it answered: what came after
      -- counts toward the next review.
      INSERT INTO task_upkeep AS k (space_id, last_review_at) VALUES (s.space_id, t.claimed_at)
      ON CONFLICT (space_id) DO UPDATE SET last_review_at = EXCLUDED.last_review_at;
    END IF;
    UPDATE tasks k
       SET state = CASE WHEN v_accept THEN 'accepted' ELSE 'done' END,
           claimed_until = NULL, done_post_id = p_post, done_at = now(),
           accepted_at = CASE WHEN v_accept THEN now() END
     WHERE k.task_id = t.task_id
    RETURNING * INTO t;
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
           || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', '[]'::jsonb) ELSE '{}'::jsonb END;
  END IF;

  SELECT count(*) INTO v_count FROM task_attempts a WHERE a.task_id = t.task_id AND a.cycle = t.cycle;
  -- A retry after a lost answer: the caller's attempt with this post stands.
  IF t.state IN ('done', 'accepted') THEN
    SELECT a.attempt INTO v_n FROM task_attempts a
     WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.peer_id = p_actor AND a.post_id = p_post;
    IF FOUND THEN
      RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false)
             || CASE WHEN v_count >= 2 THEN jsonb_build_object('attempt', v_n) ELSE '{}'::jsonb END
             || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', '[]'::jsonb) ELSE '{}'::jsonb END;
    END IF;
  END IF;
  IF t.state IN ('accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
  IF EXISTS (SELECT 1 FROM task_attempts a WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.peer_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'done';
  END IF;
  IF EXISTS (SELECT 1 FROM task_checks c WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.peer_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_ALREADY_CHECKED' USING DETAIL = 'attempt: you checked this task in cycle ' || t.cycle;
  END IF;
  IF v_count >= p_attempts_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = 'attempts: ' || p_attempts_max;
  END IF;
  -- claims: the holder is a KEY with a claim row, live or passed, against its own claim's
  -- revision.
  SELECT c.claim_revision INTO v_my_rev FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
  v_holder := FOUND;
  IF t.state IN ('open', 'claimed') AND NOT v_holder THEN
    SELECT a.number INTO v_waiting FROM tasks a
     WHERE a.task_id = ANY (t.waits_for) AND a.state NOT IN ('accepted', 'retired')
     ORDER BY a.number LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_WAITING' USING DETAIL = v_waiting::text; END IF;
  END IF;
  -- The words changed after the holder took them, or after the revision a KEY sent.
  IF (p_revision IS NOT NULL AND p_revision <> t.revision)
     OR (v_holder AND p_revision IS NULL AND v_my_rev < t.revision) THEN  -- claims
    RAISE EXCEPTION 'TASK_CHANGED' USING DETAIL = t.revision::text;
  END IF;

  -- The post: in this SPACE, the caller's own, or another KEY's that is neither hidden nor
  -- withheld.
  SELECT p.author_id INTO v_author FROM posts p
   WHERE p.post_id = p_post AND p.space_id = s.space_id
     AND (p.author_id = p_actor
          OR (NOT EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = p.post_id)
              AND NOT EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = p.post_id AND w.released_at IS NULL)));
  IF NOT FOUND THEN RAISE EXCEPTION 'TASK_POST_NOT_FOUND'; END IF;
  -- A result a reject set aside is not sent again as new.
  SELECT * INTO r FROM task_checks c
   WHERE c.result_post_id = p_post AND c.task_id = t.task_id AND c.verdict = 'reject'
   ORDER BY c.result_post_id, c.checked_at DESC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TASK_NOT_DONE' USING DETAIL = CASE WHEN r.attempt IS NULL THEN 'cycle ' || r.cycle ELSE 'attempt ' || r.attempt END
                                                   || ': rejected by ' || encode(r.peer_id, 'hex');
  END IF;
  SELECT a.attempt INTO v_n FROM task_attempts a WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.post_id = p_post;
  IF FOUND THEN RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'post_id: attempt ' || v_n || ' names that post'; END IF;
  -- Its author checked in this cycle: citing it would let a checker win through another KEY.
  IF v_author <> p_actor AND EXISTS (SELECT 1 FROM task_checks c
                                      WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.peer_id = v_author) THEN
    RAISE EXCEPTION 'TASK_ALREADY_CHECKED' USING DETAIL = 'post_id: its author checked this task in cycle ' || t.cycle;
  END IF;

  v_n := t.attempts + 1;
  INSERT INTO task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id)
  VALUES (t.task_id, s.space_id, v_n, t.cycle, p_actor, p_post, v_author);
  IF t.state IN ('open', 'claimed') THEN
    -- The first attempt of the cycle ends the claim. Uncontested, where the SPACE asks for no
    -- confirmation, it is accepted at once: in cycle 0, with no other KEY's live claim, and
    -- by a KEY not under its own give-back lock. A claim that passed contests nothing.
    -- claims: every claim ends, and each other claimant is told. Another KEY's live claim
    -- contests the attempt.
    SELECT coalesce(array_agg(c.peer_id::bytea ORDER BY c.peer_id) FILTER (WHERE c.peer_id <> p_actor), '{}'::bytea[]),
           coalesce(bool_or(c.peer_id <> p_actor AND c.claimed_until > now()), false)
      INTO v_claimants, v_contested
      FROM task_claims c WHERE c.task_id = t.task_id;
    DELETE FROM task_claims c WHERE c.task_id = t.task_id;
    v_contested := v_contested OR t.cycle > 0
                   OR (v_rank < 30 AND t.released_by IS NOT DISTINCT FROM p_actor
                       AND t.released_at > now() - make_interval(hours => s.task_claim_hours));
    v_accept := s.task_confirmations = 0 AND NOT v_contested;
    UPDATE tasks k
       SET state = CASE WHEN v_accept THEN 'accepted' ELSE 'done' END,
           claimed_by = p_actor, claimed_until = NULL, done_post_id = p_post, done_at = now(),
           accepted_at = CASE WHEN v_accept THEN now() END, attempts = v_n, attempt = v_n,
           -- After a give-back, released shows while claimed_at is not later: an attempt ends
           -- that, so a reject that reopens the task does not show the old give-back again.
           claimed_at = now()
     WHERE k.task_id = t.task_id
    RETURNING * INTO t;
  ELSE
    -- A later attempt joins the done task: the attempt of record and done_at stay.
    UPDATE tasks k SET attempts = v_n WHERE k.task_id = t.task_id RETURNING * INTO t;
  END IF;

  -- Told, one notice a KEY, never the caller: every claimant whose claim this ended, the
  -- submitters of the other pending attempts, and the post's author.
  SELECT coalesce(array_agg(q.peer ORDER BY q.peer), '{}'::bytea[]) INTO v_peers
    FROM (SELECT unnest(v_claimants) AS peer  -- claims
          UNION
          SELECT a.peer_id FROM task_attempts a
           WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.attempt <> v_n
             AND NOT EXISTS (SELECT 1 FROM task_checks c
                              WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                AND c.verdict = 'reject')
          UNION
          SELECT v_author) q
   WHERE q.peer IS NOT NULL AND q.peer <> p_actor;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, v_peers,
                                      array_fill('task_attempt'::text, ARRAY[cardinality(v_peers)]), v_n);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN v_count >= 1 THEN jsonb_build_object('attempt', v_n) ELSE '{}'::jsonb END
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- task_progress() as 0141_task_claims.sql made it, with the line marked 0144: a holder below
-- a coordinator links no progress to a task-list review, which would renew it.

CREATE OR REPLACE FUNCTION schellingaf.task_progress(p_space_name text, p_actor bytea, p_number integer,
                                                     p_post uuid, p_kinds text[], p_held_max integer DEFAULT 3)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_kind text; mine task_claims%ROWTYPE;
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
  IF t.upkeep IS NULL THEN
    -- claims: the caller's own claim row, live or passed. Without one: held by nobody live,
    -- the caller takes it first; held by another, TASK_NOT_OPEN.
    SELECT * INTO mine FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
    IF NOT FOUND THEN
      IF t.state = 'open' OR t.claimed_until <= now() THEN RAISE EXCEPTION 'TASK_NOT_CLAIMANT'; END IF;
      RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed';
    END IF;
  ELSE
    -- Held by nobody, or by a KEY whose claim has passed: the caller takes it first.
    IF t.state = 'open' OR (t.claimed_by <> p_actor AND t.claimed_until <= now()) THEN
      RAISE EXCEPTION 'TASK_NOT_CLAIMANT';
    END IF;
    IF t.claimed_by <> p_actor THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed'; END IF;
    -- 0144: the task list's review is a coordinator's, so a holder below one renews it no more.
    IF t.upkeep = 'tasks' AND rank_in_space(s.space_id, s.owner_id, p_actor) < 25 THEN
      RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
  END IF;
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
  IF (CASE WHEN t.upkeep IS NULL THEN mine.claimed_until ELSE t.claimed_until END) <= now()
     AND claims_held(s.space_id, p_actor, t.task_id) >= p_held_max THEN  -- claims
    RAISE EXCEPTION 'TASK_HOLD_LIMIT' USING DETAIL = p_held_max::text;
  END IF;
  UPDATE tasks k SET progress_post_id = p_post, progress_at = now(),
                     claimed_until = CASE
                       WHEN k.upkeep IS NULL THEN k.claimed_until  -- claims: the claim row, below
                       WHEN k.claimed_until <= now() THEN k.claimed_until  -- 0134
                       ELSE greatest(k.claimed_until,
                                     least(now() + make_interval(hours => s.task_claim_hours),
                                           k.claimed_at + make_interval(hours => 2 * s.task_claim_hours))) END
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  IF t.upkeep IS NULL THEN
    -- claims: the caller's own claim is renewed, and no other; the row follows.
    UPDATE task_claims c SET claimed_until = now() + make_interval(hours => s.task_claim_hours)
     WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
    t := sync_task_claims(t.task_id);
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- upkeep_due() as 0134_task_upkeep.sql made it, with the line marked 0144: the review's
-- unchecked signal (S4) counts a done task as confirmed only by a confirmation that counts,
-- one whose KEY is not blocked now. Nothing else in upkeep changes.

CREATE OR REPLACE FUNCTION schellingaf.upkeep_due(s schellingaf.spaces, p_kind text, p_words jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE u task_upkeep%ROWTYPE; cur oracle_versions%ROWTYPE; v_from bigint; v_count integer; v_values jsonb;
        v_unchecked integer[]; v_signals text[] := '{}'; v_case text; v_brief text;
BEGIN
  SELECT * INTO u FROM task_upkeep k WHERE k.space_id = s.space_id;
  SELECT * INTO cur FROM oracle_versions v WHERE v.space_id = s.space_id AND v.state = 'current';

  IF p_kind = 'document' THEN
    IF NOT s.document OR s.upkeep_document_after = 0 THEN RETURN NULL; END IF;
    v_from := greatest(coalesce(cur.seq, 0), coalesce(u.document_from_seq, 0));
    -- A version posted since, waiting for a decision, may bring it in line already.
    IF EXISTS (SELECT 1 FROM oracle_versions p
                WHERE p.space_id = s.space_id AND p.state = 'pending' AND p.seq > v_from) THEN
      RETURN NULL;
    END IF;
    v_count := upkeep_document_count(s.space_id, v_from);
    IF v_count < s.upkeep_document_after THEN RETURN NULL; END IF;
    -- What the brief reads: from the current version, whatever moved the count's start.
    IF v_from > coalesce(cur.seq, 0) THEN v_count := upkeep_document_count(s.space_id, coalesce(cur.seq, 0)); END IF;
    v_case := CASE WHEN cur.post_id IS NULL THEN 'upkeep_document_first' ELSE 'upkeep_document' END;
    v_brief := CASE WHEN cur.post_id IS NULL THEN 'document_first' ELSE 'document' END;
    v_values := jsonb_build_object(
      'count', CASE WHEN v_count >= 100 THEN next_fill(p_words ->> 'count_cap', jsonb_build_object('count', v_count))
                    ELSE v_count::text END,
      'seq', coalesce(cur.seq, 0), 'version_id', cur.post_id, 'space', s.name);
  ELSE
    IF s.upkeep_tasks_hours = 0 THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM tasks w
                    WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed') AND w.upkeep IS NULL)
       AND NOT EXISTS (SELECT 1 FROM tasks d
                        WHERE d.space_id = s.space_id AND d.state = 'done' AND d.upkeep IS NULL) THEN
      RETURN NULL;
    END IF;
    -- S1: a version decided since the last review, or none reviewed yet.
    IF cur.post_id IS NOT NULL AND (u.last_review_at IS NULL OR cur.decided_at > u.last_review_at) THEN
      v_signals := v_signals || (p_words -> 'signals' ->> 'version');
    END IF;
    -- S4: done tasks nobody confirmed, p_hours after done, each named by one review only.
    SELECT array_agg(d.number ORDER BY d.number) INTO v_unchecked
      FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done' AND d.upkeep IS NULL
       AND d.done_at <= now() - make_interval(hours => s.upkeep_tasks_hours)
       AND (u.last_review_at IS NULL OR d.done_at > u.last_review_at - make_interval(hours => s.upkeep_tasks_hours))
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm'
                          AND confirmation_stands(c.space_id, c.peer_id));  -- 0144: blocked confirmers
    IF v_unchecked IS NOT NULL THEN
      v_signals := v_signals || next_fill(p_words -> 'signals' ->> 'unchecked',
                                          jsonb_build_object('tasks', next_task_list(p_words, v_unchecked),
                                                             'hours', s.upkeep_tasks_hours));
    END IF;
    IF cardinality(v_signals) = 0 THEN RETURN NULL; END IF;
    v_case := 'upkeep_tasks';
    v_brief := 'tasks';
    v_values := jsonb_build_object('signals', array_to_string(v_signals, '; '), 'space', s.name);
  END IF;

  RETURN jsonb_build_object(
    'case', v_case, 'values', v_values,
    'title', next_fill(p_words -> 'upkeep' -> v_brief ->> 'title', v_values),
    'body', next_fill(p_words -> 'upkeep' -> v_brief ->> 'body', v_values));
END $$;
