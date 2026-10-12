-- Open work spaces and finished SPACES (proposal-space-beacons, 12 October 2026). The owner
-- decided both:
--
--   open             In an open work space any KEY takes and finishes a task without first
--                    getting an invite link, and never becomes a member: no membership,
--                    event or roster row is made. task_taker_rank() is the rank the task
--                    entry checks read: rank_in_space(), raised to writer (20) where the
--                    SPACE's join_policy is open (spaces_open_is_public_work keeps open to
--                    public work spaces). take_task(), task_progress(), task_release() and
--                    task_done() read it at both entry checks; next_job() reads it only for
--                    job any and work, so a KEY with no role is never handed a check or
--                    upkeep, and its v_rank stays the real rank. task_check(), add_tasks(),
--                    change_task(), retire_task() and delete_task() are unchanged.
--                    At task_confirmations 0, an attempt by a KEY whose real rank is below
--                    writer is never accepted at once, never marked accept_after, and never
--                    accepted later by release_held_tasks(): it waits for one member's
--                    confirm. The attempts cap counts no attempt by
--                    a KEY blocked in the SPACE or by the operator (task_attempts_live()),
--                    and the dry run reads the same number (task_attempts_counted()).
--   finished         When a version with a finished stage (finished_stage(), which holds
--                    FINISHED_STAGES) becomes current, the SPACE's open and claimed tasks,
--                    upkeep included, are retired as that transaction commits, and no KEY
--                    is told: retire_finished_tasks(), from the deferred trigger
--                    space_stages_finished. Done, accepted, retired and deleted tasks are
--                    untouched; a stage moving back retires and reopens nothing; next makes
--                    no new upkeep in a finished SPACE. The SPACES already finished have
--                    their open and claimed tasks retired here.
--
-- Every function is replaced whole from the newest body on main (take_task() and
-- task_release() of 0141, task_progress() of 0144, next_job()'s fourteen-argument form and
-- task_done()'s eight-argument form and release_held_tasks() of 0147), with its changed
-- lines marked "open (0162)" or "finished (0162)". Signatures are unchanged, so each keeps
-- its grant. next_job()'s three version check (0138) blocks are carried exactly.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- Whether a stage word is finished: FINISHED_STAGES in src/surface/vocabulary.ts, which
-- test/task-finished.test.ts holds equal.
CREATE FUNCTION schellingaf.finished_stage(p_word text)
  RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN p_word IN ('merged', 'declined', 'done', 'closed');
GRANT EXECUTE ON FUNCTION schellingaf.finished_stage(text) TO schellingaf_api;

-- The rank a task's entry checks read: the real rank, raised to writer (20) in an open work
-- space, where any KEY takes and finishes a task. Internal, granted to nobody: the task
-- functions call it as the owner. Never read for a check, upkeep, or a give-back of another
-- KEY's claim beyond a writer's.
CREATE FUNCTION schellingaf.task_taker_rank(s schellingaf.spaces, p_actor bytea)
  RETURNS int
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN CASE WHEN s.join_policy = 'open'
              THEN greatest(schellingaf.rank_in_space(s.space_id, s.owner_id, p_actor), 20)
              ELSE schellingaf.rank_in_space(s.space_id, s.owner_id, p_actor) END;

-- The attempts of a task's cycle that count toward TASK_LIMITS.attempts: those nothing
-- replaced, by a KEY blocked neither in the SPACE nor by the operator, read now, so a block
-- frees the slots its KEY's attempts held. Internal, granted to nobody: task_done() counts
-- with it, as the owner.
CREATE FUNCTION schellingaf.task_attempts_live(p_task uuid, p_cycle integer)
  RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT count(*)::int FROM schellingaf.task_attempts a
           WHERE a.task_id = p_task AND a.cycle = p_cycle
             AND NOT EXISTS (SELECT 1 FROM schellingaf.task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt)
             AND schellingaf.confirmation_stands(a.space_id, a.peer_id));

-- task_attempts_live() for the dry run of a POST's task, which reads as the caller inside
-- readTx: a definer, so it sees a block the caller's own row security hides. It answers only
-- about a task of a SPACE the caller may read, and null otherwise.
CREATE FUNCTION schellingaf.task_attempts_counted(p_task uuid)
  RETURNS integer
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT schellingaf.task_attempts_live(k.task_id, k.cycle) FROM schellingaf.tasks k
           WHERE k.task_id = p_task
             AND (schellingaf.caller_in_space(k.space_id) OR schellingaf.space_is_public(k.space_id)));
GRANT EXECUTE ON FUNCTION schellingaf.task_attempts_counted(uuid) TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- Open work spaces: take, progress, give back, next and done
-- ─────────────────────────────────────────────────────────────────────────────

-- take_task() as 0141_task_claims.sql made it, with the lines marked open (0162): the entry
-- checks read task_taker_rank().
CREATE OR REPLACE FUNCTION schellingaf.take_task(p_space_name text, p_actor bytea, p_number integer,
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
  IF task_taker_rank(s, p_actor) < 20 THEN  -- open (0162)
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  -- open (0162): the rank the entry checks read, a writer's for any KEY in an open work space.
  -- The give-back rule below keeps it: a KEY with no role ranks below 30 either way.
  v_rank := task_taker_rank(s, p_actor);  -- open (0162)
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

-- task_progress() as 0144_tasks.sql made it, with the lines marked open (0162): the entry
-- checks read task_taker_rank(); the review's rule still reads the real rank, and an upkeep
-- task's holder now below writer renews it no more.
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
  IF task_taker_rank(s, p_actor) < 20 THEN  -- open (0162)
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF task_taker_rank(s, p_actor) < 20 THEN  -- open (0162)
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
    -- open (0162): upkeep is a member's, so a holder that has since lost its role, which an
    -- open work space still lets take work, renews none, as 0144 rules for the review.
    IF rank_in_space(s.space_id, s.owner_id, p_actor) < 20 THEN  -- open (0162)
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

-- task_release()'s five-argument form as 0141_task_claims.sql made it, with the lines marked
-- open (0162): the entry checks read task_taker_rank().
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
  IF task_taker_rank(s, p_actor) < 20 THEN  -- open (0162)
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  -- open (0162): a writer's rank for any KEY in an open work space. Giving back another KEY's
  -- claim keeps it: below 25 that is TASK_NOT_CLAIMANT, as for a writer.
  v_rank := task_taker_rank(s, p_actor);  -- open (0162)
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

-- next_job()'s fourteen-argument form as 0147_task_corrections.sql made it, its three version
-- check (0138) blocks carried exactly, with the lines marked open (0162) and finished (0162):
-- the entry checks read task_taker_rank() for job any and work only, v_rank stays the real
-- rank, so checks (v_checks, next_version_check()) and upkeep go to members alone: the
-- upkeep loop passes a KEY below writer by, and step 1 renews no upkeep task for one; no
-- upkeep in a finished SPACE.
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
  -- open (0162): job any and work read task_taker_rank(), a writer's for any KEY in an open
  -- work space; check and upkeep read the real rank.
  IF (CASE WHEN p_job IN ('any', 'work') THEN task_taker_rank(s, p_actor)  -- open (0162)
           ELSE rank_in_space(s.space_id, s.owner_id, p_actor) END)
     < (CASE WHEN p_job = 'check' THEN v_check_rank ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  v_check_rank := CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END;
  -- open (0162): v_rank stays the real rank, which every step below reads; the entry check
  -- alone reads task_taker_rank() for job any and work.
  v_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF (CASE WHEN p_job IN ('any', 'work') THEN task_taker_rank(s, p_actor) ELSE v_rank END)  -- open (0162)
     < (CASE WHEN p_job = 'check' THEN v_check_rank ELSE 20 END) THEN
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
                                   AND (k.upkeep <> 'tasks' OR v_rank >= 25)  -- 0144: a coordinator's review
                                   AND v_rank >= 20) x  -- open (0162): upkeep is a member's
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
                                         AND (c.verdict = 'reject' OR c.peer_id = p_actor))
                      AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt))  -- B2
       AND task_held(d) IS NULL  -- B1: a held task's check waits
       AND (cardinality(d.independent_of) = 0 OR task_doer(d, p_actor) IS NULL)  -- C
       AND d.done_at <= now() - make_interval(mins => p_check_first_minutes)
       -- The offer cap: confirmations given, and live offers to KEYS that have not checked
       -- it, fewer than it needs. A task needs one at least: lowering the setting accepts no
       -- done task by itself, and the next confirmation does.
       AND (SELECT coalesce(max(g.n), 0)
              FROM (SELECT count(*) AS n FROM task_checks c
                     WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm'
                       AND confirmation_stands(c.space_id, c.peer_id)  -- 0144
                       AND (cardinality(d.independent_of) = 0 OR task_doer(d, c.peer_id) IS NULL)  -- C
                       AND NOT EXISTS (SELECT 1 FROM task_checks j
                                        WHERE j.task_id = c.task_id AND j.cycle = c.cycle AND j.attempt = c.attempt
                                          AND j.verdict = 'reject')
                       AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = c.task_id AND n.replaces = c.attempt)  -- B2
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
  -- finished (0162): none in a finished SPACE, by the raw stage word.
  IF v_job IS NULL AND p_job IN ('any', 'upkeep') AND p_tag IS NULL AND p_words ? 'upkeep'
     AND NOT EXISTS (SELECT 1 FROM space_stages st
                      WHERE st.space_id = s.space_id AND finished_stage(st.word)) THEN  -- finished (0162)
    SELECT * INTO u FROM task_upkeep k WHERE k.space_id = s.space_id;
    FOREACH v_kind IN ARRAY ARRAY['tasks', 'document'] LOOP
      -- open (0162): never to a KEY below writer, which takes part in an open work space.
      CONTINUE WHEN v_job IS NOT NULL OR v_rank < 20 OR (v_kind = 'tasks' AND v_rank < 25);  -- open (0162)
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
                                         AND (c.verdict = 'reject' OR c.peer_id = p_actor))
                      AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt))  -- B2
       AND task_held(d) IS NULL  -- B1: a held task's check waits
       AND (cardinality(d.independent_of) = 0 OR task_doer(d, p_actor) IS NULL)  -- C
       AND (p_job = 'check'
            OR (SELECT coalesce(max(g.n), 0)
                  FROM (SELECT count(*) AS n FROM task_checks c
                         WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm'
                           AND confirmation_stands(c.space_id, c.peer_id)  -- 0144
                           AND (cardinality(d.independent_of) = 0 OR task_doer(d, c.peer_id) IS NULL)  -- C
                           AND NOT EXISTS (SELECT 1 FROM task_checks j
                                            WHERE j.task_id = c.task_id AND j.cycle = c.cycle AND j.attempt = c.attempt
                                              AND j.verdict = 'reject')
                           AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = c.task_id AND n.replaces = c.attempt)  -- B2
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
                                                  AND j.verdict = 'reject')
                               AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = x.task_id AND n.replaces = x.attempt))  -- B2
      INTO v_attempt, v_waiting
      FROM task_attempts a
     WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.author_id <> p_actor
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                          AND (c.verdict = 'reject' OR c.peer_id = p_actor))
       AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt);  -- B2
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

-- task_done()'s eight-argument form as 0147_task_corrections.sql made it, with the lines
-- marked open (0162): the entry checks read task_taker_rank(); at confirmations 0 an attempt
-- by a KEY whose real rank is below writer is neither accepted at once nor marked
-- accept_after; an upkeep task's holder now below writer finishes it no more; the attempts
-- cap counts with task_attempts_live().
CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                      p_revision integer, p_deliveries boolean, p_attempts_max integer,
                                      p_offer_minutes integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_version text; v_accept boolean; v_rank int; v_holder boolean;
        v_author bytea; v_n integer; v_count integer; v_contested boolean;
        v_my_rev integer; v_claimants bytea[] := '{}';
        r task_checks%ROWTYPE; v_peers bytea[]; v_delivered jsonb := '[]';
        v_own task_attempts%ROWTYPE; v_replaces integer; v_live integer; v_held integer;  -- B1, B2
        v_real_rank int;  -- open (0162)
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  IF task_taker_rank(s, p_actor) < 20 THEN  -- open (0162)
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  -- open (0162): v_rank is the rank the entry check reads, a writer's for any KEY in an open
  -- work space, and the give-back lock and the review's rule keep it; v_real_rank is the
  -- rank the KEY holds, which decides whether its attempt may be accepted at once.
  v_rank := task_taker_rank(s, p_actor);  -- open (0162)
  v_real_rank := rank_in_space(s.space_id, s.owner_id, p_actor);  -- open (0162)
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
    -- open (0162): upkeep is a member's: a holder now below writer finishes none, by its real
    -- rank, so its claim passes and the next member takes the same row.
    IF v_real_rank < 20 THEN RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex'); END IF;  -- open (0162)
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
  -- A retry after a lost answer: the caller's attempt with this post stands, the one of its
  -- attempts in the cycle that nothing replaced (B2).
  IF t.state IN ('done', 'accepted') THEN
    SELECT a.attempt INTO v_n FROM task_attempts a
     WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.peer_id = p_actor AND a.post_id = p_post
       AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt);  -- B2
    IF FOUND THEN
      RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false)
             || CASE WHEN v_count >= 2 THEN jsonb_build_object('attempt', v_n) ELSE '{}'::jsonb END
             || CASE WHEN t.state = 'done' AND task_held(t) IS NOT NULL  -- B1
                     THEN jsonb_build_object('check_waits_for', task_held(t)) ELSE '{}'::jsonb END
             || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', '[]'::jsonb) ELSE '{}'::jsonb END;
    END IF;
  END IF;
  IF t.state IN ('accepted', 'retired') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
  -- B2: the caller's attempt in this cycle that nothing replaced. Waiting for a check, this
  -- done replaces it; rejected, it stays the caller's last word in the cycle.
  SELECT * INTO v_own FROM task_attempts a
   WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.peer_id = p_actor
     AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt);
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM task_checks c
                WHERE c.task_id = v_own.task_id AND c.cycle = v_own.cycle AND c.attempt = v_own.attempt
                  AND c.verdict = 'reject') THEN
      RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'done';
    END IF;
    v_replaces := v_own.attempt;
  END IF;
  IF EXISTS (SELECT 1 FROM task_checks c WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.peer_id = p_actor) THEN
    RAISE EXCEPTION 'TASK_ALREADY_CHECKED' USING DETAIL = 'attempt: you checked this task in cycle ' || t.cycle;
  END IF;
  -- B2: the attempts that count toward the limit are those nothing replaced, so one KEY's
  -- corrections never shut a rival out. A replacement leaves the count as it was.
  -- open (0162): nor does an attempt by a KEY blocked here or by the operator, so a block
  -- frees the slots its KEY's attempts held; the dry run reads the same count.
  v_live := task_attempts_live(t.task_id, t.cycle);  -- open (0162)
  IF v_replaces IS NULL AND v_live >= p_attempts_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = 'attempts: ' || p_attempts_max;
  END IF;
  -- claims: the holder is a KEY with a claim row, live or passed, against its own claim's
  -- revision.
  SELECT c.claim_revision INTO v_my_rev FROM task_claims c WHERE c.task_id = t.task_id AND c.peer_id = p_actor;
  v_holder := FOUND;
  -- B1: a task in after not accepted refuses no done: the attempt is recorded and its check
  -- waits (task_held()).
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
  INSERT INTO task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id, replaces)
  VALUES (t.task_id, s.space_id, v_n, t.cycle, p_actor, p_post, v_author, v_replaces);  -- B2
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
    -- B1: held while a task in after is not accepted: never accepted at once, and marked
    -- to be accepted when its after is, where it would have been accepted now.
    v_held := task_held(t);
    -- open (0162): a KEY below writer, taking part in an open work space, is never accepted
    -- at once nor marked to be: its attempt waits for one member's confirm.
    v_accept := s.task_confirmations = 0 AND NOT v_contested AND v_held IS NULL
                AND v_real_rank >= 20;  -- open (0162)
    UPDATE tasks k
       SET state = CASE WHEN v_accept THEN 'accepted' ELSE 'done' END,
           claimed_by = p_actor, claimed_until = NULL, done_post_id = p_post, done_at = now(),
           accepted_at = CASE WHEN v_accept THEN now() END, attempts = v_n, attempt = v_n,
           accept_after = s.task_confirmations = 0 AND NOT v_contested AND v_held IS NOT NULL  -- B1
                          AND v_real_rank >= 20,  -- open (0162)
           -- After a give-back, released shows while claimed_at is not later: an attempt ends
           -- that, so a reject that reopens the task does not show the old give-back again.
           claimed_at = now()
     WHERE k.task_id = t.task_id
    RETURNING * INTO t;
  ELSIF v_replaces IS NOT NULL THEN
    -- B2: a correction replaces the caller's own waiting attempt. The task stays done and
    -- done_at stays; the attempt of record is the lowest pending one again, which may be
    -- another KEY's earlier attempt; a mark to accept after stays, the attempt being the
    -- same KEY's.
    UPDATE tasks k
       SET attempts = v_n, attempt = p.attempt, claimed_by = p.peer_id, done_post_id = p.post_id
      FROM (SELECT x.attempt, x.peer_id, x.post_id FROM task_attempts x
             WHERE x.task_id = t.task_id AND x.cycle = t.cycle
               AND NOT EXISTS (SELECT 1 FROM task_checks c
                                WHERE c.task_id = x.task_id AND c.cycle = x.cycle AND c.attempt = x.attempt
                                  AND c.verdict = 'reject')
               AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = x.task_id AND n.replaces = x.attempt)
             ORDER BY x.attempt LIMIT 1) p
     WHERE k.task_id = t.task_id
    RETURNING k.* INTO t;
  ELSE
    -- A later attempt joins the done task: the attempt of record and done_at stay. Another
    -- KEY's attempt contests a held one: its mark to accept after is cleared (B1).
    UPDATE tasks k SET attempts = v_n, accept_after = false WHERE k.task_id = t.task_id RETURNING * INTO t;
  END IF;

  -- Told, one notice a KEY, never the caller: every claimant whose claim this ended, the
  -- submitters of the other pending attempts, and the post's author; and, of a replaced
  -- attempt, every KEY that confirmed it or holds an offer naming it (B2).
  SELECT coalesce(array_agg(q.peer ORDER BY q.peer), '{}'::bytea[]) INTO v_peers
    FROM (SELECT unnest(v_claimants) AS peer  -- claims
          UNION
          SELECT a.peer_id FROM task_attempts a
           WHERE a.task_id = t.task_id AND a.cycle = t.cycle AND a.attempt <> v_n
             AND NOT EXISTS (SELECT 1 FROM task_checks c
                              WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                AND c.verdict = 'reject')
             AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt)  -- B2
          UNION
          SELECT v_author
          UNION
          SELECT c.peer_id FROM task_checks c  -- B2
           WHERE v_replaces IS NOT NULL AND c.task_id = t.task_id AND c.cycle = t.cycle AND c.attempt = v_replaces
             AND c.verdict = 'confirm'
          UNION
          SELECT o.peer_id FROM task_check_offers o  -- B2
           WHERE v_replaces IS NOT NULL AND o.task_id = t.task_id AND o.cycle = t.cycle AND o.attempt = v_replaces
             AND o.offered_at > now() - make_interval(mins => p_offer_minutes)) q
   WHERE q.peer IS NOT NULL AND q.peer <> p_actor;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, v_peers,
                                      array_fill('task_attempt'::text, ARRAY[cardinality(v_peers)]), v_n);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN v_count >= 1 THEN jsonb_build_object('attempt', v_n) ELSE '{}'::jsonb END
         || CASE WHEN v_replaces IS NOT NULL THEN jsonb_build_object('replaces', v_replaces) ELSE '{}'::jsonb END  -- B2
         || CASE WHEN t.state = 'done' AND task_held(t) IS NOT NULL  -- B1
                 THEN jsonb_build_object('check_waits_for', task_held(t)) ELSE '{}'::jsonb END
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- release_held_tasks() as 0147_task_corrections.sql made it, with the line marked open
-- (0162): a held attempt is accepted when its after is only while its submitter ranks writer
-- or above now, so a KEY below writer, or one that has since lost its role, waits for a
-- member's confirm. The trigger tasks_release_held still calls it.
CREATE OR REPLACE FUNCTION schellingaf.release_held_tasks()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; d tasks%ROWTYPE; v_work uuid[]; v_accepts boolean[]; v_at integer := 1;
        v_id uuid; v_accepting boolean;
BEGIN
  IF coalesce(current_setting('schellingaf.releasing', true), '') = 'on' THEN RETURN NULL; END IF;
  -- Nothing waits here: one probe of tasks_accept_after_idx.
  IF NOT EXISTS (SELECT 1 FROM tasks k WHERE k.space_id = NEW.space_id AND k.accept_after) THEN RETURN NULL; END IF;
  PERFORM set_config('schellingaf.releasing', 'on', true);
  -- The SPACE lock, which every writer that accepts or retires a task already holds.
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = NEW.space_id FOR NO KEY UPDATE;
  v_work := ARRAY[NEW.task_id];
  v_accepts := ARRAY[NEW.state = 'accepted'];
  WHILE v_at <= cardinality(v_work) LOOP
    v_id := v_work[v_at];
    v_accepting := v_accepts[v_at];
    v_at := v_at + 1;
    FOR d IN SELECT * FROM tasks k
              WHERE k.space_id = s.space_id AND k.accept_after AND v_id = ANY (k.waits_for)
              ORDER BY k.number
              FOR UPDATE LOOP
      CONTINUE WHEN task_held(d) IS NOT NULL;
      IF v_accepting AND s.task_confirmations = 0
         AND confirmation_stands(s.space_id, d.claimed_by)
         AND rank_in_space(s.space_id, s.owner_id, d.claimed_by) >= 20  -- open (0162)
         AND NOT EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = d.done_post_id)
         AND NOT EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = d.done_post_id AND w.released_at IS NULL) THEN
        UPDATE tasks k SET state = 'accepted', accepted_at = now() WHERE k.task_id = d.task_id;
        v_work := v_work || d.task_id;
        v_accepts := v_accepts || true;
      ELSE
        UPDATE tasks k SET accept_after = false WHERE k.task_id = d.task_id;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('schellingaf.releasing', '', true);
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A finished SPACE retires its leftover tasks
-- ─────────────────────────────────────────────────────────────────────────────

-- Retires every open and claimed task of a SPACE, upkeep included, as retire_task() retires
-- one, with closed_by null and the reason naming the stage: every claim ends. A task added in
-- this same transaction stays open, as one added after the stage would: POST /v1/spaces
-- writes a create's version, which may set a finished stage, and then its tasks. Done,
-- accepted, retired and deleted tasks are untouched. No KEY is told: a notice here would
-- lock mailboxes after append_post()'s own, out of their ascending order, which is why
-- upkeep_on_version() and release_held_tasks() send none either; a holder's next call meets
-- TASK_NOT_OPEN, detail retired. It takes the SPACE lock, which the writer already holds,
-- then the tasks in key order through tasks_waiting_idx, and answers how many it retired. A
-- definer, granted to nobody: the trigger below and this file call it.
CREATE FUNCTION schellingaf.retire_finished_tasks(p_space uuid, p_word text)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_ids uuid[];
BEGIN
  PERFORM 1 FROM spaces sp WHERE sp.space_id = p_space FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(k.task_id ORDER BY k.task_id), '{}'::uuid[]) INTO v_ids
    FROM (SELECT w.task_id FROM tasks w
           WHERE w.space_id = p_space AND w.state IN ('open', 'claimed')
             AND w.created_at < now()  -- added before this transaction: the tasks of a create stay open
           ORDER BY w.task_id
           FOR UPDATE) k;
  IF cardinality(v_ids) = 0 THEN RETURN 0; END IF;
  DELETE FROM task_claims c WHERE c.task_id = ANY (v_ids);
  UPDATE tasks k
     SET state = 'retired',
         claimed_by = CASE WHEN k.done_post_id IS NULL THEN NULL ELSE k.claimed_by END,
         claimed_until = NULL, closed_by = NULL, closed_at = now(),
         close_reason = 'stage ' || p_word || ': the SPACE is finished'
   WHERE k.task_id = ANY (v_ids);
  RETURN cardinality(v_ids);
END $$;

-- The trigger: a stage row written with a finished word, by oracle_make_current() alone
-- (0123), under append_post()'s SPACE lock. Deferred to the commit, so a POST that sets the
-- stage and finishes a task in one call (posts.ts calls task_done() after append_post())
-- keeps that task done. The word is read as it is at commit, so a stage set finished and
-- then moved back in one transaction retires nothing. A finished word set again retires
-- whatever opened since; an unfinished one retires nothing.
CREATE FUNCTION schellingaf.space_stage_finished()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_word text;
BEGIN
  SELECT st.word INTO v_word FROM space_stages st WHERE st.space_id = NEW.space_id;
  IF finished_stage(v_word) THEN PERFORM retire_finished_tasks(NEW.space_id, v_word); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER space_stages_finished AFTER INSERT OR UPDATE ON schellingaf.space_stages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (schellingaf.finished_stage(NEW.word))
  EXECUTE FUNCTION schellingaf.space_stage_finished();

-- The SPACES already finished: their leftover open and claimed tasks retire now, as the
-- trigger would have retired them, with no notice. In SPACE order, one SPACE lock at a time.
SELECT schellingaf.retire_finished_tasks(st.space_id, st.word)
  FROM (SELECT x.space_id, x.word FROM schellingaf.space_stages x
         WHERE schellingaf.finished_stage(x.word)
         ORDER BY x.space_id) st;
