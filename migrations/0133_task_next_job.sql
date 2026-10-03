-- next answers a job: work, check, upkeep or stop, and why.
--
-- Until 3 October 2026 next handed out work, or with verify a done task to check, and a
-- done task waited until somebody thought to ask for checks. This file makes next choose
-- (proposal-self-harness, build task 7; its specification is the website's
-- docs/plan/self-harness-plan.md, sections B.4, C.2 and C.3). next_job() takes job, any
-- unless sent, and for job any goes in this order, all under the SPACE lock:
--
--   1. renew a task the caller holds;
--   2. check first: a done task the caller may check that has waited p_check_first_minutes
--      (60) since done, oldest done first, under the offer cap;
--   3. and 4. upkeep: a seam a later file fills; nothing is due before it;
--   5. work: the lowest-numbered open task whose after are all done with, as 0.3 answered;
--   6. check when idle: the lowest-numbered done task the caller may check, under the cap;
--   7. stop: no task.
--
-- job work is steps 1 and 5; job check, which verify true is, the lowest-numbered done task
-- the caller may check, with no cap; job upkeep, steps 3 and 4, else stop. With number,
-- take_task() answers, as 0.3 did. A check claims nothing: it records an offer instead, in
-- task_check_offers, live p_offer_minutes (30), and every next drops the caller's offers in
-- the SPACE first. Steps 2 and 6 hand out a done task only while its confirmations plus the
-- live offers to KEYs that have not checked it are fewer than it needs, so ten KEYs asking
-- at once are not all sent to check one task.
--
-- why is one sentence of NEXT_WORDS (src/surface/next-words.ts), which the route sends as
-- p_words; this file fills in numbers only, never a PEER's words. next_task() stays as a
-- wrapper for the release before, with job work, or check for verify, and no words, so its
-- why is null. Nothing here is a post, an event or an export: an offer is not a record and
-- is pruned a day after it was made (prune_check_offers()).

-- ─────────────────────────────────────────────────────────────────────────────
-- Check offers
-- ─────────────────────────────────────────────────────────────────────────────

-- One KEY sent to check one task in one cycle. Written by next_job() under the SPACE lock,
-- read by nothing else, granted to nobody; row security answers the api role no row should
-- a grant ever be added. A KEY holds at most one in a SPACE: next drops its offers there
-- before it makes one.
CREATE TABLE schellingaf.task_check_offers (
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  task_id    uuid NOT NULL REFERENCES schellingaf.tasks,
  cycle      integer NOT NULL CHECK (cycle >= 0),
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  offered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, cycle, peer_id)
);
-- The drop at the start of every next, by the caller's SPACE and KEY.
CREATE INDEX task_check_offers_peer_idx ON schellingaf.task_check_offers (space_id, peer_id);
ALTER TABLE schellingaf.task_check_offers ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- why, from the words the route sends
-- ─────────────────────────────────────────────────────────────────────────────

-- The sentence p_words.why names p_case, with each {key} of p_values put in. The values are
-- numbers next counted, never text a KEY wrote. Null when no words were sent.
CREATE FUNCTION schellingaf.next_why(p_words jsonb, p_case text, p_values jsonb DEFAULT '{}')
  RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v text := p_words -> 'why' ->> p_case; k text; x text;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  FOR k, x IN SELECT e.key, e.value FROM jsonb_each_text(p_values) e WHERE e.value IS NOT NULL LOOP
    v := replace(v, '{' || k || '}', x);
  END LOOP;
  RETURN v;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The next job
-- ─────────────────────────────────────────────────────────────────────────────

CREATE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text DEFAULT 'any',
                                     p_tag text DEFAULT NULL, p_number integer DEFAULT NULL,
                                     p_words jsonb DEFAULT NULL, p_held_max integer DEFAULT 3,
                                     p_check_first_minutes integer DEFAULT 60, p_offer_minutes integer DEFAULT 30)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_check_rank int; v_checks boolean;
        v_job text; v_case text; v_values jsonb := '{}'; v_renewed boolean := false; v_out jsonb;
BEGIN
  IF p_job IS NULL OR p_job NOT IN ('any', 'work', 'check', 'upkeep') THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;

  -- With a number, that task, as take_task() takes it; it checks who may and takes the
  -- SPACE lock, so the caller's offers are dropped under it.
  IF p_number IS NOT NULL THEN
    IF p_job NOT IN ('any', 'work') OR p_tag IS NOT NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    v_out := take_task(p_space_name, p_actor, p_number, p_held_max);
    DELETE FROM task_check_offers o
     WHERE o.space_id = (SELECT sp.space_id FROM spaces sp WHERE sp.name = p_space_name) AND o.peer_id = p_actor;
    RETURN v_out || jsonb_build_object(
      'job', 'work',
      'why', next_why(p_words,
                      CASE WHEN v_out ? 'changed_since_claim' THEN 'renewed_changed'
                           WHEN (v_out ->> 'renewed')::boolean THEN 'renewed' ELSE 'number' END,
                      jsonb_build_object('number', p_number, 'from', v_out -> 'changed_since_claim' -> 'from',
                                         'to', v_out -> 'changed_since_claim' -> 'to')));
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

  -- 1. Renew a task the caller holds, of the tag asked when one is.
  IF p_job IN ('any', 'work') THEN
    UPDATE tasks h SET claimed_until = now() + make_interval(hours => s.task_claim_hours)
     WHERE h.task_id = (SELECT m.task_id FROM tasks m
                         WHERE m.space_id = s.space_id AND m.state = 'claimed' AND m.claimed_by = p_actor
                           AND (p_tag IS NULL OR m.tag = p_tag)
                         ORDER BY m.number
                         LIMIT 1
                         FOR UPDATE)
    RETURNING * INTO t;
    IF FOUND THEN
      v_renewed := true;
      v_job := 'work';
      v_case := CASE WHEN t.claim_revision < t.revision THEN 'renewed_changed' ELSE 'renewed' END;
      v_values := jsonb_build_object('from', t.claim_revision, 'to', t.revision);
    END IF;
  END IF;

  -- 2. Check first: a done task that has waited, oldest done first, under the offer cap.
  IF v_job IS NULL AND v_checks THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.claimed_by <> p_actor
       AND (p_tag IS NULL OR d.tag = p_tag)
       AND d.done_at <= now() - make_interval(mins => p_check_first_minutes)
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.peer_id = p_actor)
       -- The offer cap: confirmations given, and live offers to KEYs that have not checked
       -- it, fewer than it needs. A task needs one at least: lowering the setting accepts no
       -- done task by itself, and the next confirmation does.
       AND (SELECT count(*) FROM task_checks g
             WHERE g.task_id = d.task_id AND g.cycle = d.cycle AND g.verdict = 'confirm')
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

  -- 3. and 4. Upkeep: the task list's review for a coordinator or above, then the
  -- document's, each when due. The file that adds upkeep fills them in here, and for job
  -- upkeep; until then none is ever due.

  -- 5. Work: the lowest-numbered task that is open, or whose claim passed, whose after are
  -- all accepted or retired, never one the caller gave back below an admin within the
  -- SPACE's claim hours.
  IF v_job IS NULL AND p_job IN ('any', 'work') THEN
    UPDATE tasks c SET state = 'claimed', claimed_by = p_actor,
                       claimed_until = now() + make_interval(hours => s.task_claim_hours),
                       claim_revision = c.revision, claimed_at = now(), takes = c.takes + 1
     WHERE c.task_id = (SELECT o.task_id FROM tasks o
                         WHERE o.space_id = s.space_id AND o.state IN ('open', 'claimed')
                           AND (o.state = 'open' OR o.claimed_until <= now())
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
      v_job := 'work';
      v_case := 'work';
    END IF;
  END IF;

  -- 6. Check when idle, under the cap; or job check, the lowest-numbered with no cap.
  IF v_job IS NULL AND (v_checks OR p_job = 'check') THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.claimed_by <> p_actor
       AND (p_tag IS NULL OR d.tag = p_tag)
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.peer_id = p_actor)
       AND (p_job = 'check'
            OR (SELECT count(*) FROM task_checks g
                 WHERE g.task_id = d.task_id AND g.cycle = d.cycle AND g.verdict = 'confirm')
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

  -- A check claims nothing: the offer holds a place under the cap for p_offer_minutes, or
  -- until this KEY's next next here.
  IF v_job = 'check' THEN
    INSERT INTO task_check_offers (space_id, task_id, cycle, peer_id)
    VALUES (s.space_id, t.task_id, t.cycle, p_actor)
    ON CONFLICT (task_id, cycle, peer_id) DO UPDATE SET offered_at = now();
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
           -- verify answers as 0.3 did: true for a check, and for a check asked even when none waits.
           'verify', v_job = 'check' OR p_job = 'check',
           'renewed', v_renewed,
           'task', CASE WHEN v_job <> 'stop' THEN task_item(t, s.task_confirmations) END)
         || CASE WHEN v_renewed AND t.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', t.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END;
END $$;

-- As the release before called it: work, or a check for verify, with no words, so its why
-- is null. It answers as 0.3 did, with job, why and renewed added.
CREATE OR REPLACE FUNCTION schellingaf.next_task(p_space_name text, p_actor bytea, p_tag text DEFAULT NULL,
                                                 p_verify boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.next_job(p_space_name, p_actor, CASE WHEN p_verify THEN 'check' ELSE 'work' END, p_tag);

-- ─────────────────────────────────────────────────────────────────────────────
-- The prune's sixth step
-- ─────────────────────────────────────────────────────────────────────────────

-- Offers a day old: long past their 30 minutes. Locked in key order, as every prune locks.
CREATE FUNCTION schellingaf.prune_check_offers() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM task_check_offers o
   WHERE (o.task_id, o.cycle, o.peer_id) IN (SELECT x.task_id, x.cycle, x.peer_id FROM task_check_offers x
                                              WHERE x.offered_at < now() - interval '24 hours'
                                              ORDER BY x.task_id, x.cycle, x.peer_id
                                              FOR UPDATE);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.next_job(text, bytea, text, text, integer, jsonb, integer, integer, integer),
  schellingaf.prune_check_offers()
TO schellingaf_api;
