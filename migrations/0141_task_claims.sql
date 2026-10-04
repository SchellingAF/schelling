-- Several claims: a KEY may hold a task beside the KEYS that hold it, by asking for it.
--
-- Until this file a task had one claim, on its row. A second agent that wanted to work the
-- same task beside the first could not say so, and nothing showed that two were on it
-- (proposal-task-claim-rule, slice B; its specification is the run's 10-spec-final.md,
-- sections 1.2, 1.3, 2.1, 2.3 to 2.6). Now:
--
--   task_claims    one row a live or passed claim: the task, the KEY, when it took it, until
--                  when, and the revision it took. State, not record: a row is deleted when
--                  its claim ends. Only for a task that is not upkeep.
--   the row        mirrors the claims (sync_task_claims(), called last by every write that
--                  touches them): claimed exactly while a claim row exists; claimed_until the
--                  latest claim's expiry, so every predicate that reads claimed_until > now()
--                  stays right; claimed_by, claimed_at and claim_revision the live claim
--                  taken first, or with none live the claim whose expiry is latest. Those
--                  three are set at a write and may go stale as a claim passes: every answer
--                  reads the holders from task_claims.
--   next           without a number never hands a task another KEY holds: step 5 keeps its
--                  predicate, which the mirror makes "no live claim". With a number and
--                  join, a KEY holds the task beside up to p_claimants_max - 1 others (3
--                  live claims in all); without join, a task another KEY holds is
--                  TASK_NOT_OPEN, detail claimed, naming join. A take or a join deletes other
--                  KEYS' passed claims of that task, so a renewal never brings a fourth back.
--   done           the holder is any KEY with a claim row, live or passed, against its own
--                  claim's revision. The first attempt ends every claim and tells each
--                  claimant. Contested, where no confirmation is asked: another KEY's live
--                  claim row.
--   release        gives back the caller's own claim; another KEY's only where that KEY
--                  holds the task alone.
--   progress       renews the caller's own claim only.
--   change, retire tell every claimant; retire tells every claimant of each dependent.
--
-- Upkeep tasks keep their one holder on the row, exactly as 0134_task_upkeep.sql made them:
-- no claim row, ever. It comes after 0140_task_attempts.sql.

-- ─────────────────────────────────────────────────────────────────────────────
-- The claims
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.task_claims (
  task_id        uuid NOT NULL REFERENCES schellingaf.tasks,
  space_id       uuid NOT NULL REFERENCES schellingaf.spaces,
  peer_id        schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  claimed_at     timestamptz NOT NULL,
  claimed_until  timestamptz NOT NULL,
  -- The revision this KEY took: done and next compare it with the task's.
  claim_revision integer NOT NULL,
  PRIMARY KEY (task_id, peer_id)
);
-- A KEY's claims in a SPACE: next's step 1 and the hold limit.
CREATE INDEX task_claims_peer_idx ON schellingaf.task_claims (space_id, peer_id);
ALTER TABLE schellingaf.task_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_claims_read ON schellingaf.task_claims FOR SELECT TO schellingaf_api
  USING (task_claims.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(task_claims.space_id));
GRANT SELECT ON schellingaf.task_claims TO schellingaf_api;

-- Backfill: every claimed task that is not upkeep has its one claim as a row. The row
-- already mirrors it.
INSERT INTO schellingaf.task_claims (task_id, space_id, peer_id, claimed_at, claimed_until, claim_revision)
SELECT t.task_id, t.space_id, t.claimed_by, coalesce(t.claimed_at, t.created_at), t.claimed_until,
       coalesce(t.claim_revision, t.revision)
  FROM schellingaf.tasks t
 WHERE t.upkeep IS NULL AND t.state = 'claimed';

-- The row of a task that is not upkeep, set from its claims, under the task row's lock its
-- caller holds: claimed while a claim row exists, its latest expiry, and the live claim taken
-- first, or with none live the claim whose expiry is latest; open with no claim row, its
-- claimed_at and claim_revision left as a release leaves them. A done, accepted or retired
-- task, and an upkeep task, is answered as it is. Internal, granted to nobody.
CREATE FUNCTION schellingaf.sync_task_claims(p_task uuid)
  RETURNS schellingaf.tasks
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE t tasks%ROWTYPE; c task_claims%ROWTYPE; v_latest timestamptz;
BEGIN
  SELECT * INTO t FROM tasks k WHERE k.task_id = p_task;
  IF t.upkeep IS NOT NULL OR t.state NOT IN ('open', 'claimed') THEN RETURN t; END IF;
  SELECT max(k.claimed_until) INTO v_latest FROM task_claims k WHERE k.task_id = p_task;
  IF v_latest IS NULL THEN
    IF t.state = 'claimed' THEN
      UPDATE tasks k SET state = 'open', claimed_by = NULL, claimed_until = NULL
       WHERE k.task_id = p_task
      RETURNING * INTO t;
    END IF;
    RETURN t;
  END IF;
  SELECT * INTO c FROM task_claims k
   WHERE k.task_id = p_task
   ORDER BY k.claimed_until > now() DESC,
            CASE WHEN k.claimed_until > now() THEN k.claimed_at END,
            CASE WHEN k.claimed_until > now() THEN NULL ELSE k.claimed_until END DESC,
            k.peer_id
   LIMIT 1;
  UPDATE tasks k SET state = 'claimed', claimed_by = c.peer_id, claimed_until = v_latest,
                     claimed_at = c.claimed_at, claim_revision = c.claim_revision
   WHERE k.task_id = p_task
  RETURNING * INTO t;
  RETURN t;
END $$;

-- The live claims a KEY holds in a SPACE: its claim rows, and an upkeep task it holds on the
-- row. The hold limit counts them, leaving out p_task. Internal, granted to nobody.
CREATE FUNCTION schellingaf.claims_held(p_space uuid, p_actor bytea, p_task uuid)
  RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT (SELECT count(*) FROM schellingaf.task_claims h
           WHERE h.space_id = p_space AND h.peer_id = p_actor AND h.claimed_until > now()
             AND h.task_id IS DISTINCT FROM p_task)
       + (SELECT count(*) FROM schellingaf.tasks h
           WHERE h.space_id = p_space AND h.upkeep IS NOT NULL AND h.state = 'claimed'
             AND h.claimed_by = p_actor AND h.claimed_until > now()
             AND h.task_id IS DISTINCT FROM p_task)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The one projection of a task
-- ─────────────────────────────────────────────────────────────────────────────
-- One task as every answer shows it, as 0140_task_attempts.sql made it, with its claims: the
-- holder of a claimed task that is not upkeep is read from task_claims at read time, the
-- live claim taken first and its own expiry, and claimants lists every live claim while
-- two or more live. A claim that passed reads as before: the row names its KEY.
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
                     AND c.attempt IS NOT DISTINCT FROM t.attempt)))
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
                                                                AND c.verdict = 'confirm'))
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

-- ─────────────────────────────────────────────────────────────────────────────
-- next with a number: take, renew or join
-- ─────────────────────────────────────────────────────────────────────────────
-- take_task() as 0134_task_upkeep.sql made it, with p_join and p_claimants_max after
-- p_held_max: a task other KEYS hold live is TASK_NOT_OPEN, detail claimed naming join,
-- unless p_join asks to hold it beside them, up to p_claimants_max live claims in all
-- (TASK_LIMIT claimants); a claim of the caller's, live or passed, is renewed; the hold
-- limit counts the caller's live claim rows and live upkeep claims. Dropped and created
-- with more trailing defaults, as 0116 did, and granted again.
DROP FUNCTION schellingaf.take_task(text, bytea, integer, integer);
CREATE FUNCTION schellingaf.take_task(p_space_name text, p_actor bytea, p_number integer,
                                      p_held_max integer DEFAULT 3, p_join boolean DEFAULT false,
                                      p_claimants_max integer DEFAULT 3)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_renewed boolean; v_waiting integer; v_rank int;
        mine task_claims%ROWTYPE; v_others integer;
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
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;  -- 0134
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired
  -- claims: a claim of the caller's, live or passed, is renewed; other KEYS' live claims
  -- refuse a take, and a join, asked with p_join, holds the task beside fewer than
  -- p_claimants_max of them.
  SELECT * INTO mine FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
  v_renewed := FOUND;
  SELECT count(*) INTO v_others FROM task_claims c
   WHERE c.task_id = t.task_id AND c.peer_id <> p_actor AND c.claimed_until > now();
  IF NOT v_renewed AND v_others > 0 AND NOT coalesce(p_join, false) THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed: send join true to hold it beside them';
  END IF;
  IF NOT v_renewed AND v_others >= p_claimants_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = 'claimants: ' || p_claimants_max;
  END IF;
  IF NOT v_renewed AND v_rank < 30 AND t.released_by IS NOT DISTINCT FROM p_actor
     AND t.released_at > now() - make_interval(hours => s.task_claim_hours) THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'given back by you';
  END IF;
  -- A take, or a claim of the caller's own that passed brought back: the caller's other
  -- live claims, read from the tasks waiting to be done, under the SPACE lock, so two
  -- calls at once cannot both take the last place.
  IF (NOT v_renewed OR mine.claimed_until <= now())
     AND claims_held(s.space_id, p_actor, t.task_id) >= p_held_max THEN  -- claims
    RAISE EXCEPTION 'TASK_HOLD_LIMIT' USING DETAIL = p_held_max::text;
  END IF;
  IF NOT v_renewed THEN
    SELECT a.number INTO v_waiting FROM tasks a
     WHERE a.task_id = ANY (t.waits_for) AND a.state NOT IN ('accepted', 'retired')  -- 0132: retired
     ORDER BY a.number LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_WAITING' USING DETAIL = v_waiting::text; END IF;
  END IF;

  -- claims: a renewal keeps when the claim was taken and the revision it took. A take or a
  -- join deletes other KEYS' passed claims of the task first, so the cap holds.
  IF v_renewed THEN
    UPDATE task_claims c SET claimed_until = now() + make_interval(hours => s.task_claim_hours)
     WHERE c.task_id = t.task_id AND c.peer_id = p_actor
    RETURNING * INTO mine;
  ELSE
    DELETE FROM task_claims c WHERE c.task_id = t.task_id AND c.claimed_until <= now();
    INSERT INTO task_claims (task_id, space_id, peer_id, claimed_at, claimed_until, claim_revision)
    VALUES (t.task_id, s.space_id, p_actor, now(), now() + make_interval(hours => s.task_claim_hours), t.revision)
    RETURNING * INTO mine;
    UPDATE tasks k SET takes = k.takes + 1 WHERE k.task_id = t.task_id;
  END IF;
  t := sync_task_claims(t.task_id);

  -- joined, the number of other KEYS holding it, is for next_job()'s why, which takes it out.
  RETURN jsonb_build_object('space', s.name, 'verify', false, 'renewed', v_renewed,
                            'task', task_item(t, s.task_confirmations))
         || CASE WHEN v_renewed AND mine.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', mine.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END
         || CASE WHEN NOT v_renewed AND v_others > 0 THEN jsonb_build_object('joined', v_others) ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- next: several claims
-- ─────────────────────────────────────────────────────────────────────────────
-- next_job() as 0140_task_attempts.sql made it, its twelve-argument form, with
-- 0138_document_decision.sql's three version check (0138) blocks kept exactly, as a new
-- overload with p_join and p_claimants_max last and no defaults; the lines marked claims
-- change: join goes with a number only; step 1 renews the caller's own claim row, or an
-- upkeep task it holds on the row, whichever has the lower number; step 5 takes a task with
-- no live claim, deletes its passed claims and adds the caller's as a row. The twelve-
-- argument form wraps it, sending false and TASK_LIMITS.claimants.
CREATE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,
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
                                   AND (p_tag IS NULL OR k.tag = p_tag)) x
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

CREATE OR REPLACE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,
                                                p_words jsonb, p_held_max integer, p_check_first_minutes integer,
                                                p_offer_minutes integer, p_not_accepted_max integer,
                                                p_document_gap_hours integer, p_review_gap_hours integer)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.next_job(p_space_name, p_actor, p_job, p_tag, p_number, p_words, p_held_max,
                              p_check_first_minutes, p_offer_minutes, p_not_accepted_max,
                              p_document_gap_hours, p_review_gap_hours, false, 3);

-- ─────────────────────────────────────────────────────────────────────────────
-- Done: the holder is any claimant
-- ─────────────────────────────────────────────────────────────────────────────
-- task_done() as 0140_task_attempts.sql made it, its seven-argument form, with the lines
-- marked claims: a KEY with a claim row, live or passed, is a holder, checked against its
-- own claim's revision; the first attempt of a cycle deletes every claim and tells each
-- claimant; another KEY's live claim row contests it where no confirmation is asked.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Progress, release and change, with several claims
-- ─────────────────────────────────────────────────────────────────────────────
-- task_progress() as 0134_task_upkeep.sql made it, with the lines marked claims: for a task
-- that is not upkeep, the caller's own claim row, live or passed, is linked and renewed, and
-- no other claim; a passed one brought back counts toward the hold limit, as a take does.
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

-- task_release() as 0134_task_upkeep.sql made it, its five-argument form, with the lines
-- marked claims: for a task that is not upkeep, the caller's own claim row is deleted and
-- the row follows, the task staying claimed while another claim lives; with no claim of the
-- caller's, the give-back rules apply to another KEY's claim only where it is the one claim,
-- and two or more are INVALID_REQUEST naming them. The four-argument form still wraps it.
CREATE OR REPLACE FUNCTION schellingaf.task_release(p_space_name text, p_actor bytea, p_number integer,
                                         p_reason text, p_deliveries boolean)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_holder bytea; v_other boolean; v_delivered jsonb;
        v_count integer;
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

  IF t.upkeep IS NULL THEN
    -- claims: the caller's own claim is given back, and the others stay.
    IF EXISTS (SELECT 1 FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor) THEN
      DELETE FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
      t := sync_task_claims(t.task_id);
      RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
             || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', '[]'::jsonb) ELSE '{}'::jsonb END;
    END IF;
    -- Another KEY's claim is given back only where that KEY holds the task alone: with two or
    -- more live, after the rank check, each passes by itself. A claim that passed counts for
    -- nothing. The detail counts them; the task's claimants names them, since three KEYS' ids
    -- pass the 200 characters a detail may hold.
    IF v_rank < 25 THEN RAISE EXCEPTION 'TASK_NOT_CLAIMANT'; END IF;
    SELECT count(*) INTO v_count FROM task_claims c WHERE c.task_id = t.task_id AND c.claimed_until > now();
    IF v_count >= 2 THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'claims: give back only a claim one KEY holds alone; KEYS holding it: ' || v_count;
    END IF;
    -- The holder is read from the claims, never the row, whose claimed_by may name a claim
    -- that passed after the last write: the one live claim, or with none live the claim whose
    -- expiry is latest, as sync_task_claims() orders them.
    SELECT c.peer_id INTO v_holder FROM task_claims c
     WHERE c.task_id = t.task_id
     ORDER BY c.claimed_until > now() DESC, c.claimed_until DESC, c.peer_id
     LIMIT 1;
  END IF;
  v_holder := coalesce(v_holder, t.claimed_by);

  v_other := v_holder <> p_actor;
  IF v_other AND v_rank < 30 THEN
    -- Below an admin, a writer gives back only its own; a coordinator also the claim of a
    -- KEY ranked below it, read now, and only saying why.
    IF v_rank < 25 THEN RAISE EXCEPTION 'TASK_NOT_CLAIMANT'; END IF;
    IF rank_in_space(s.space_id, s.owner_id, v_holder) >= 25 THEN
      RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
    IF p_reason IS NULL THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: say why you give back the claim of another KEY';
    END IF;
  END IF;

  DELETE FROM task_claims c WHERE c.task_id = t.task_id;  -- claims: the one claim, given back
  UPDATE tasks k SET state = 'open', claimed_by = NULL, claimed_until = NULL,
                     released_by = CASE WHEN v_other THEN p_actor ELSE k.released_by END,
                     released_at = CASE WHEN v_other THEN now() ELSE k.released_at END,
                     release_reason = CASE WHEN v_other THEN p_reason ELSE k.release_reason END,
                     left_by = CASE WHEN k.upkeep IS NOT NULL AND NOT v_other THEN p_actor END  -- 0134
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[v_holder], ARRAY['task_reopened']);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- change_task() as 0140_task_attempts.sql made it, telling every claimant but the actor,
-- not the row's one holder.
CREATE OR REPLACE FUNCTION schellingaf.change_task(p_space_name text, p_actor bytea, p_number integer, p_revision integer,
                                                   p_reason text, p_change jsonb, p_revisions_max integer DEFAULT 50,
                                                   p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_after uuid[]; v_bad text; v_loop integer;
  v_holders bytea[]; v_delivered jsonb := '[]'::jsonb;
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
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;  -- 0134
  IF t.state IN ('done', 'accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;  -- 0132: retired
  -- Below a coordinator, only the KEY that added it, and only while nobody ever took it
  -- or made an attempt at it: an attempt needs no take.
  IF v_rank < 25 AND NOT (t.created_by = p_actor AND t.takes = 0 AND t.attempts = 0) THEN  -- attempts
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
  -- Every claim, live or passed and not taken since, stays with its holder, who is told
  -- (claims: every claimant).
  SELECT coalesce(array_agg(c.peer_id::bytea ORDER BY c.peer_id), '{}'::bytea[]) INTO v_holders
    FROM task_claims c WHERE c.task_id = t.task_id;
  UPDATE tasks k
     SET title = CASE WHEN p_change ? 'title' THEN p_change->>'title' ELSE k.title END,
         body = CASE WHEN p_change ? 'body' THEN p_change->>'body' ELSE k.body END,
         tag = CASE WHEN p_change ? 'tag' THEN p_change->>'tag' ELSE k.tag END,
         waits_for = CASE WHEN p_change ? 'after' THEN v_after ELSE k.waits_for END,
         revision = k.revision + 1
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  IF cardinality(v_holders) > 0 THEN
    v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, v_holders,
                                        array_fill('task_changed'::text, ARRAY[cardinality(v_holders)]));
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Retire
-- ─────────────────────────────────────────────────────────────────────────────
-- retire_task() as 0140_task_attempts.sql made it, with the lines marked claims: a claimed
-- task loses every claim and every claimant is told; a dependent's task_changed goes to every
-- claimant of it.
CREATE OR REPLACE FUNCTION schellingaf.retire_task(p_space_name text, p_actor bytea, p_number integer, p_reason text,
                                        p_tasks jsonb DEFAULT NULL, p_not_accepted_max integer DEFAULT 10000,
                                        p_batch_max integer DEFAULT 20, p_revisions_max integer DEFAULT 50,
                                        p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; t tasks%ROWTYPE; v_was tasks%ROWTYPE; v_first integer; v_new uuid[] := '{}';
  v_inherit uuid[]; v_deps uuid[]; v_number integer; v_loop integer;
  v_parts jsonb[] := '{}'; v_out jsonb; r record; v_claimants bytea[];
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
  -- 0134: an upkeep task's work is the service's to hand out again, never a KEY's to replace.
  IF t.upkeep IS NOT NULL AND p_tasks IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'tasks: an upkeep task is retired without replacements';
  END IF;

  v_was := t;
  -- claims: every claim ends, and each claimant is told below.
  SELECT coalesce(array_agg(c.peer_id::bytea ORDER BY c.peer_id), '{}'::bytea[]) INTO v_claimants
    FROM task_claims c WHERE c.task_id = t.task_id;
  DELETE FROM task_claims c WHERE c.task_id = t.task_id;
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
      SELECT v_was.claimed_by::bytea AS peer, t.task_id AS task, v_was.cycle AS cycle, 'task_retired'::text AS reason
       WHERE v_was.state = 'done' OR (v_was.state = 'claimed' AND v_was.upkeep IS NOT NULL)
      UNION
      -- claims: every claimant of a claimed task.
      SELECT x.peer, t.task_id, v_was.cycle, 'task_retired' FROM unnest(v_claimants) x(peer)
      UNION
      -- attempts: every pending attempt's submitter, and the KEYS that confirmed one.
      SELECT a.peer_id, t.task_id, v_was.cycle, 'task_retired'
        FROM task_attempts a
       WHERE v_was.state = 'done' AND a.task_id = t.task_id AND a.cycle = v_was.cycle
         AND NOT EXISTS (SELECT 1 FROM task_checks j
                          WHERE j.task_id = a.task_id AND j.cycle = a.cycle AND j.attempt = a.attempt AND j.verdict = 'reject')
      UNION
      SELECT c.peer_id, t.task_id, v_was.cycle, 'task_retired'
        FROM task_checks c
       WHERE v_was.state = 'done' AND c.task_id = t.task_id AND c.cycle = v_was.cycle AND c.verdict = 'confirm'
         AND NOT EXISTS (SELECT 1 FROM task_checks j
                          WHERE j.task_id = c.task_id AND j.cycle = c.cycle AND j.attempt = c.attempt AND j.verdict = 'reject')
      UNION
      -- claims: every claimant of each dependent.
      SELECT c.peer_id::bytea, d.task_id, d.cycle, 'task_changed'
        FROM tasks d JOIN task_claims c ON c.task_id = d.task_id
       WHERE d.task_id = ANY (v_deps) AND d.state = 'claimed') q
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
-- The mirror, checked by the tests
-- ─────────────────────────────────────────────────────────────────────────────
-- task_mirror_faults() as 0140_task_attempts.sql made it, with the claims: a claimed task
-- that is not upkeep has a claim row, its latest expiry on the row and one claim's holder,
-- taken-at and revision; every other task, and every upkeep task, has none.
CREATE OR REPLACE FUNCTION schellingaf.task_mirror_faults(p_space uuid)
  RETURNS SETOF text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE t tasks%ROWTYPE; v_rows integer; v_top integer; v_record task_attempts%ROWTYPE; v_first timestamptz;
        v_pending integer; v_claims integer; v_latest timestamptz; v_claim task_claims%ROWTYPE;
BEGIN
  FOR t IN SELECT * FROM tasks k WHERE k.space_id = p_space ORDER BY k.number LOOP
    SELECT count(*), coalesce(max(a.attempt), 0) INTO v_rows, v_top FROM task_attempts a WHERE a.task_id = t.task_id;
    SELECT count(*), max(c.claimed_until) INTO v_claims, v_latest FROM task_claims c WHERE c.task_id = t.task_id;
    IF t.upkeep IS NOT NULL THEN
      IF t.attempts <> 0 OR v_rows <> 0 OR t.attempt IS NOT NULL THEN
        RETURN NEXT 'task ' || t.number || ': an upkeep task has attempts';
      END IF;
      IF v_claims <> 0 THEN RETURN NEXT 'task ' || t.number || ': an upkeep task has claim rows'; END IF;
      CONTINUE;
    END IF;
    -- claims: claimed exactly while a claim row exists, its latest expiry on the row, and
    -- claimed_by, claimed_at and claim_revision one claim's, as the last write set them.
    IF t.state = 'claimed' THEN
      IF v_claims = 0 THEN
        RETURN NEXT 'task ' || t.number || ': claimed with no claim row';
      ELSE
        IF t.claimed_until IS DISTINCT FROM v_latest THEN
          RETURN NEXT 'task ' || t.number || ': claimed_until is not the latest claim''s';
        END IF;
        SELECT * INTO v_claim FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = t.claimed_by;
        IF NOT FOUND OR v_claim.claimed_at IS DISTINCT FROM t.claimed_at
           OR v_claim.claim_revision IS DISTINCT FROM t.claim_revision THEN
          RETURN NEXT 'task ' || t.number || ': claimed_by, claimed_at or claim_revision is not one claim''s';
        END IF;
      END IF;
    ELSIF v_claims <> 0 THEN
      RETURN NEXT 'task ' || t.number || ': ' || t.state || ' with claim rows';
    END IF;
    IF v_rows <> t.attempts OR v_top <> t.attempts THEN
      RETURN NEXT 'task ' || t.number || ': attempts ' || t.attempts || ', rows ' || v_rows || ', highest ' || v_top;
    END IF;
    -- The cycle's first attempt is its lowest-numbered: a done that waited for the lock may
    -- have begun, and so be timed, before the one that took the lock first.
    SELECT a.at INTO v_first FROM task_attempts a WHERE a.task_id = t.task_id AND a.cycle = t.cycle
     ORDER BY a.attempt LIMIT 1;
    SELECT min(a.attempt) INTO v_pending FROM task_attempts a
     WHERE a.task_id = t.task_id AND a.cycle = t.cycle
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt AND c.verdict = 'reject');
    IF t.state IN ('open', 'claimed', 'deleted') OR (t.state = 'retired' AND t.done_post_id IS NULL) THEN
      IF t.attempt IS NOT NULL THEN RETURN NEXT 'task ' || t.number || ': ' || t.state || ' with an attempt of record'; END IF;
      IF t.state IN ('open', 'claimed') AND v_first IS NOT NULL THEN
        RETURN NEXT 'task ' || t.number || ': ' || t.state || ' with attempts in its cycle';
      END IF;
      CONTINUE;
    END IF;
    SELECT * INTO v_record FROM task_attempts a WHERE a.task_id = t.task_id AND a.attempt = t.attempt;
    IF NOT FOUND OR v_record.cycle <> t.cycle THEN
      RETURN NEXT 'task ' || t.number || ': ' || t.state || ' with no attempt of record in its cycle';
      CONTINUE;
    END IF;
    IF t.state IN ('done', 'retired') AND t.attempt IS DISTINCT FROM v_pending THEN
      RETURN NEXT 'task ' || t.number || ': attempt of record ' || t.attempt || ', lowest pending ' || coalesce(v_pending::text, 'none');
    END IF;
    IF t.state = 'accepted' AND EXISTS (SELECT 1 FROM task_checks c
                                         WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.attempt = t.attempt
                                           AND c.verdict = 'reject') THEN
      RETURN NEXT 'task ' || t.number || ': accepted with a rejected attempt';
    END IF;
    IF t.claimed_by IS DISTINCT FROM v_record.peer_id OR t.done_post_id IS DISTINCT FROM v_record.post_id THEN
      RETURN NEXT 'task ' || t.number || ': claimed_by or done_post_id is not attempt ' || t.attempt || '''s';
    END IF;
    IF t.done_at IS DISTINCT FROM v_first THEN
      RETURN NEXT 'task ' || t.number || ': done_at is not the first attempt''s time';
    END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.take_task(text, bytea, integer, integer, boolean, integer),
  schellingaf.next_job(text, bytea, text, text, integer, jsonb, integer, integer, integer, integer, integer, integer, boolean, integer)
TO schellingaf_api;
