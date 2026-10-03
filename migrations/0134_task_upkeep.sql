-- Upkeep: tasks the service hands out when its counts say a work space's document or its
-- task list is behind.
--
-- Until 3 October 2026 nobody was handed the work of keeping a work space in order: a
-- document fell behind its findings, and a task list behind its document, until somebody
-- thought to look. This file fills next_job()'s steps 3 and 4 (proposal-self-harness, build
-- tasks 9 and 10; its specification is the website's docs/plan/self-harness-plan.md,
-- sections B.1 to B.7, C.3 and C.4). An upkeep task is a row of tasks with upkeep set and no
-- author (created_by null), numbered next, made only when next hands it out, already
-- claimed, and its title and body are NEXT_WORDS' fixed brief with numbers put in, never a
-- PEER's words. Two kinds:
--
--   tasks     review the task list: for a coordinator or above, when the current version
--             is newer than the last review (S1), or a done task waited upkeep_tasks_hours
--             unchecked since then (S4); at most once in p_review_gap_hours (4). Done with
--             the holder's own decision posted after it took the task, accepted at once,
--             and the time it was taken kept in task_upkeep.last_review_at: the counts
--             were read then, so what arrives while it is held counts toward the next.
--   document  bring the document in line: for a writer or above in a work space that keeps
--             one, when upkeep_document_after findings and results by members came since
--             the current version, or since a version of an upkeep holder was declined,
--             and no version posted since waits for a decision; at most once in
--             p_document_gap_hours (2). Done with the holder's own version,
--             posted after it took the task, pending or current; accepted when any version
--             of its holder posted since goes current (upkeep_on_version()), and retired by
--             the service when another goes current, or its own is declined or goes out of
--             date.
--
-- One live task of each kind a SPACE (open, claimed or done; tasks_upkeep_idx), none made
-- while the SPACE holds p_not_accepted_max tasks not yet accepted, and none with a tag. A
-- claim on one ends at most twice the claim hours after it was taken, and a claim that
-- passed is never renewed by its holder. next meets a live one that is open or whose claim
-- passed and retires it when it is no longer due, else claims the same row afresh, for any
-- KEY but the one whose claim passed or who released it (tasks.left_by). Neither kind is
-- checked: confirm, reject, change, delete and next with its number answer TASK_IS_UPKEEP,
-- and retire with replacement tasks INVALID_REQUEST. Upkeep never makes upkeep: a
-- version is not counted, and a decision not at all. Nothing here is a post, an event or an
-- export, and the service writes no notice for its own retires. service_numbers() counts
-- neither kind as a task made, nor a deleted task.
--
-- Two settings on the SPACE, public like its task settings: upkeep_document_after (3; 0 is
-- off) and upkeep_tasks_hours (24; 0 is off), set by the owner or an admin through
-- set_task_settings(), whose five-argument form stays as a wrapper. next_job() takes three
-- more numbers, and its nine-argument form stays as a wrapper sending TASK_LIMITS' own.

-- ─────────────────────────────────────────────────────────────────────────────
-- The settings, the columns and the indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Every SPACE, those before this file included, takes the defaults.
ALTER TABLE schellingaf.spaces
  ADD COLUMN upkeep_document_after smallint NOT NULL DEFAULT 3
    CONSTRAINT spaces_upkeep_document_after_range CHECK (upkeep_document_after BETWEEN 0 AND 100),
  ADD COLUMN upkeep_tasks_hours smallint NOT NULL DEFAULT 24
    CONSTRAINT spaces_upkeep_tasks_hours_range CHECK (upkeep_tasks_hours BETWEEN 0 AND 720);
-- Public, like the SPACE's other settings: the task list reads them as the caller.
GRANT SELECT (upkeep_document_after, upkeep_tasks_hours) ON schellingaf.spaces TO schellingaf_api;

-- An upkeep task names its kind and no author, and carries no tag and no after.
ALTER TABLE schellingaf.tasks
  ADD COLUMN upkeep text CONSTRAINT tasks_upkeep_known CHECK (upkeep IN ('document', 'tasks')),
  ALTER COLUMN created_by DROP NOT NULL,
  ADD CONSTRAINT tasks_upkeep_shape CHECK ((created_by IS NULL) = (upkeep IS NOT NULL)
                                           AND (upkeep IS NULL OR (tag IS NULL AND waits_for = '{}'))) NOT VALID;
ALTER TABLE schellingaf.tasks VALIDATE CONSTRAINT tasks_upkeep_shape;

-- The KEY whose own release last made an upkeep task open: next hands that row to any KEY
-- but it while it stays open (task_release(), next_job()). Null on every other task, and
-- after a give-back, which released_by records.
ALTER TABLE schellingaf.tasks
  ADD COLUMN left_by schellingaf.bytes32 REFERENCES schellingaf.peers,
  ADD CONSTRAINT tasks_left_by_upkeep CHECK (left_by IS NULL OR upkeep IS NOT NULL);

-- A SPACE's live upkeep task of one kind, in one probe.
CREATE INDEX tasks_upkeep_idx ON schellingaf.tasks (space_id, upkeep)
  WHERE upkeep IS NOT NULL AND state IN ('open', 'claimed', 'done');
-- What space_counts() leaves out of accepted: retired, deleted and upkeep tasks. The list
-- kept to retired tasks still walks it by number.
DROP INDEX schellingaf.tasks_closed_idx;
CREATE INDEX tasks_closed_idx ON schellingaf.tasks (space_id, number)
  WHERE state IN ('retired', 'deleted') OR upkeep IS NOT NULL;

-- One row a SPACE, made the first time upkeep writes one, and written only under the SPACE
-- lock: where the document's count starts after a declined upkeep version, when document
-- upkeep was last handed out, and when the task list was last reviewed. Granted to nobody;
-- row security answers the api role no row should a grant ever be added.
CREATE TABLE schellingaf.task_upkeep (
  space_id           uuid PRIMARY KEY REFERENCES schellingaf.spaces,
  document_from_seq  bigint NOT NULL DEFAULT 0 CHECK (document_from_seq >= 0),
  document_handed_at timestamptz,
  last_review_at     timestamptz
);
ALTER TABLE schellingaf.task_upkeep ENABLE ROW LEVEL SECURITY;

-- Every work space made before this file counts its task reviews from now, as if one was
-- taken at release: otherwise each with a current version and a task would hand a
-- coordinator a review at its first next. Document upkeep counts as it would anyway.
INSERT INTO schellingaf.task_upkeep (space_id, last_review_at)
SELECT sp.space_id, now() FROM schellingaf.spaces sp WHERE NOT sp.oracle
ON CONFLICT (space_id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- The settings
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0113_tasks.sql made it, with the two upkeep settings. No argument has a default, so a
-- call of the five-argument form is never taken for this one.
CREATE FUNCTION schellingaf.set_task_settings(p_space_name text, p_actor bytea, p_confirmations integer,
                                              p_confirmers text, p_claim_hours integer,
                                              p_document_after integer, p_tasks_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; changed jsonb := '{}'; rev bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  IF p_confirmations IS NOT NULL AND p_confirmations <> s.task_confirmations THEN
    changed := changed || jsonb_build_object('task_confirmations', p_confirmations);
  END IF;
  IF p_confirmers IS NOT NULL AND p_confirmers <> s.task_confirmers THEN
    changed := changed || jsonb_build_object('task_confirmers', p_confirmers);
  END IF;
  IF p_claim_hours IS NOT NULL AND p_claim_hours <> s.task_claim_hours THEN
    changed := changed || jsonb_build_object('task_claim_hours', p_claim_hours);
  END IF;
  IF p_document_after IS NOT NULL AND p_document_after <> s.upkeep_document_after THEN
    changed := changed || jsonb_build_object('upkeep_document_after', p_document_after);
  END IF;
  IF p_tasks_hours IS NOT NULL AND p_tasks_hours <> s.upkeep_tasks_hours THEN
    changed := changed || jsonb_build_object('upkeep_tasks_hours', p_tasks_hours);
  END IF;

  IF changed <> '{}'::jsonb THEN
    UPDATE spaces sp
       SET task_confirmations = coalesce(p_confirmations, sp.task_confirmations),
           task_confirmers = coalesce(p_confirmers, sp.task_confirmers),
           task_claim_hours = coalesce(p_claim_hours, sp.task_claim_hours),
           upkeep_document_after = coalesce(p_document_after, sp.upkeep_document_after),
           upkeep_tasks_hours = coalesce(p_tasks_hours, sp.upkeep_tasks_hours)
     WHERE sp.space_id = s.space_id
    RETURNING * INTO s;
    rev := bump_revision(s.space_id, p_actor, 'space.updated', changed);
  END IF;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                            'revision', coalesce(rev, s.revision)::text, 'changed', changed <> '{}'::jsonb,
                            'task_confirmations', s.task_confirmations, 'task_confirmers', s.task_confirmers,
                            'task_claim_hours', s.task_claim_hours,
                            'upkeep_document_after', s.upkeep_document_after,
                            'upkeep_tasks_hours', s.upkeep_tasks_hours);
END $$;

-- As the release before called it: the three task settings, the upkeep settings left alone.
CREATE OR REPLACE FUNCTION schellingaf.set_task_settings(p_space_name text, p_actor bytea,
                                                         p_confirmations integer DEFAULT NULL,
                                                         p_confirmers text DEFAULT NULL,
                                                         p_claim_hours integer DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.set_task_settings(p_space_name, p_actor, p_confirmations, p_confirmers, p_claim_hours,
                                       NULL::integer, NULL::integer);

-- ─────────────────────────────────────────────────────────────────────────────
-- The words next fills in
-- ─────────────────────────────────────────────────────────────────────────────

-- p_text with each {key} of p_values put in: numbers next counted, or words of NEXT_WORDS
-- already filled the same way, never text a KEY wrote. Null when p_text is.
CREATE FUNCTION schellingaf.next_fill(p_text text, p_values jsonb)
  RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v text := p_text; k text; x text;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  FOR k, x IN SELECT e.key, e.value FROM jsonb_each_text(p_values) e WHERE e.value IS NOT NULL LOOP
    v := replace(v, '{' || k || '}', x);
  END LOOP;
  RETURN v;
END $$;

-- Task numbers as a sentence says them, from p_words.tasks: "task 5", "tasks 5 and 9",
-- "tasks 5, 9 and 12", and past 8 the first 8 and how many more. p_numbers is sorted.
CREATE FUNCTION schellingaf.next_task_list(p_words jsonb, p_numbers integer[])
  RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN CASE
    WHEN cardinality(p_numbers) = 1
      THEN schellingaf.next_fill(p_words -> 'tasks' ->> 'one', jsonb_build_object('numbers', p_numbers[1]))
    WHEN cardinality(p_numbers) <= 8
      THEN schellingaf.next_fill(p_words -> 'tasks' ->> 'many',
             jsonb_build_object('numbers', array_to_string(p_numbers[1:cardinality(p_numbers) - 1], ', '),
                                'last', p_numbers[cardinality(p_numbers)]))
    ELSE schellingaf.next_fill(p_words -> 'tasks' ->> 'more',
           jsonb_build_object('numbers', array_to_string(p_numbers[1:8], ', '), 'more', cardinality(p_numbers) - 8))
  END;

-- The findings and results by members (no_role false) in SPACE p_space after seq p_from,
-- up to 100: each kind counted as equality on posts_space_kind_seq_idx, its own range of
-- the index, so posts of other kinds are never walked. Internal: upkeep_due() calls it.
CREATE FUNCTION schellingaf.upkeep_document_count(p_space uuid, p_from bigint)
  RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT least(100, (SELECT count(*) FROM (SELECT 1 FROM posts p
                                            WHERE p.space_id = p_space AND p.kind = 'finding' AND p.seq > p_from
                                              AND NOT p.no_role
                                            LIMIT 100) f)
                  + (SELECT count(*) FROM (SELECT 1 FROM posts p
                                            WHERE p.space_id = p_space AND p.kind = 'result' AND p.seq > p_from
                                              AND NOT p.no_role
                                            LIMIT 100) r))::int
$$;

-- Whether upkeep of kind p_kind is called for in SPACE s by its counts, and if so what next
-- says and hands out: {case, values, title, body}, the why sentence's key and numbers, and
-- the brief filled in. Null when the counts call for none. Whether one is live, the gap
-- since the last and the task limit are next_job()'s to ask. Internal: next_job() calls it
-- under the SPACE lock.
--
-- document: findings and results by members (no_role false) since the later of the current
-- version and task_upkeep.document_from_seq, counted up to 100 (upkeep_document_count()),
-- reach upkeep_document_after, and no version posted since is pending
-- (oracle_versions_pending, at most p_pending_per_space a SPACE). The brief counts from the current version, so a declined
-- upkeep version moves when upkeep is due, never what the next brief reads.
-- tasks: the SPACE has an open, claimed or done task of a member, and the current version
-- was decided after the last review (S1), or a done task of a member, unconfirmed in its
-- cycle, was done between p_hours before the last review and p_hours ago (S4), which
-- names each such task once.
CREATE FUNCTION schellingaf.upkeep_due(s schellingaf.spaces, p_kind text, p_words jsonb)
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
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm');
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

-- ─────────────────────────────────────────────────────────────────────────────
-- The next job, with upkeep
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0133_task_next_job.sql made it, with steps 3 and 4 filled, and the lines marked 0134
-- added or changed:
--
--   1. a renewal hands back a task of the job asked: job work never renews an upkeep task,
--      and job upkeep renews only one. An upkeep claim ends at most twice the claim hours
--      after it was taken: a renewal at that cap answers renewed false and leaves it, and a
--      claim that passed is never renewed by its holder, nor an open one handed back to the
--      KEY that released it;
--   2, 5 and 6 pass upkeep tasks by, and so does the stop's test of a waiting task;
--   3 and 4: for job any or upkeep, with no tag and with words sent, the task list's review
--      for a coordinator or above, then the document's for a writer or above, as
--      upkeep_due() says, under the ceilings above.
--
-- No argument has a default, so a call of the nine-argument form is never taken for this
-- one: that form stays as a wrapper sending TASK_LIMITS' own numbers.
CREATE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,
                                     p_words jsonb, p_held_max integer, p_check_first_minutes integer,
                                     p_offer_minutes integer, p_not_accepted_max integer,
                                     p_document_gap_hours integer, p_review_gap_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_check_rank int; v_checks boolean;
        v_job text; v_case text; v_values jsonb := '{}'; v_renewed boolean := false; v_out jsonb;
        v_kind text; v_due jsonb; v_full boolean; u task_upkeep%ROWTYPE;
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

  -- 1. Renew a task the caller holds, of the tag asked when one is, and of the job asked
  -- (0134): job work never an upkeep task, job upkeep only one, and an upkeep task only
  -- while its claim lasts.
  IF p_job IN ('any', 'work', 'upkeep') THEN
    SELECT * INTO t FROM tasks m
     WHERE m.space_id = s.space_id AND m.state = 'claimed' AND m.claimed_by = p_actor
       AND (p_tag IS NULL OR m.tag = p_tag)
       AND (p_job <> 'work' OR m.upkeep IS NULL) AND (p_job <> 'upkeep' OR m.upkeep IS NOT NULL)
       AND (m.upkeep IS NULL OR m.claimed_until > now())
     ORDER BY m.number
     LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
      v_job := CASE WHEN t.upkeep IS NULL THEN 'work' ELSE 'upkeep' END;
      v_values := jsonb_build_object('from', t.claim_revision, 'to', t.revision);
      -- 0134: an upkeep claim ends at most twice the claim hours after it was taken.
      IF t.upkeep IS NOT NULL AND t.claimed_until >= t.claimed_at + make_interval(hours => 2 * s.task_claim_hours) THEN
        v_case := 'held_upkeep';
        v_values := v_values || jsonb_build_object('hours', 2 * s.task_claim_hours);
      ELSE
        UPDATE tasks h
           SET claimed_until = CASE WHEN h.upkeep IS NULL THEN now() + make_interval(hours => s.task_claim_hours)
                                    ELSE least(now() + make_interval(hours => s.task_claim_hours),
                                               h.claimed_at + make_interval(hours => 2 * s.task_claim_hours)) END
         WHERE h.task_id = t.task_id
        RETURNING * INTO t;
        v_renewed := true;
        v_case := CASE WHEN t.claim_revision < t.revision THEN 'renewed_changed' ELSE 'renewed' END;
      END IF;
    END IF;
  END IF;

  -- 2. Check first: a done task that has waited, oldest done first, under the offer cap.
  IF v_job IS NULL AND v_checks THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.upkeep IS NULL  -- 0134
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
    UPDATE tasks c SET state = 'claimed', claimed_by = p_actor,
                       claimed_until = now() + make_interval(hours => s.task_claim_hours),
                       claim_revision = c.revision, claimed_at = now(), takes = c.takes + 1
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
      v_job := 'work';
      v_case := 'work';
    END IF;
  END IF;

  -- 6. Check when idle, under the cap; or job check, the lowest-numbered with no cap.
  IF v_job IS NULL AND (v_checks OR p_job = 'check') THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.upkeep IS NULL  -- 0134
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
           -- verify answers as 0.3 did: true for a check, and for a check asked even when none waits.
           'verify', v_job = 'check' OR p_job = 'check',
           'renewed', v_renewed,
           'task', CASE WHEN v_job <> 'stop' THEN task_item(t, s.task_confirmations) END)
         || CASE WHEN v_renewed AND t.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', t.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END;
END $$;

-- As the release before called it: TASK_LIMITS' numbers for the task limit and the two gaps.
CREATE OR REPLACE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text DEFAULT 'any',
                                                p_tag text DEFAULT NULL, p_number integer DEFAULT NULL,
                                                p_words jsonb DEFAULT NULL, p_held_max integer DEFAULT 3,
                                                p_check_first_minutes integer DEFAULT 60, p_offer_minutes integer DEFAULT 30)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.next_job(p_space_name, p_actor, p_job, p_tag, p_number, p_words, p_held_max,
                              p_check_first_minutes, p_offer_minutes, 10000, 2, 4);

-- ─────────────────────────────────────────────────────────────────────────────
-- Every other task function, on an upkeep task
-- ─────────────────────────────────────────────────────────────────────────────

-- What a task may never do, as 0132_task_retire_delete.sql listed it, with its kind: a task
-- is an upkeep task, or not, for good.
CREATE OR REPLACE FUNCTION schellingaf.protect_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF OLD.state = 'deleted' THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF OLD.state = 'retired' AND NEW.state NOT IN ('retired', 'deleted') THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
  IF NEW.task_id <> OLD.task_id OR NEW.space_id <> OLD.space_id OR NEW.number <> OLD.number
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.upkeep IS DISTINCT FROM OLD.upkeep THEN  -- 0134: upkeep
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

-- One task as every answer shows it, as 0132_task_retire_delete.sql made it, with upkeep,
-- its kind, on an upkeep task alone, whose created_by is null: its words are the service's.
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
    || CASE WHEN t.upkeep IS NOT NULL THEN jsonb_build_object('upkeep', t.upkeep) ELSE '{}'::jsonb END  -- 0134
  END;

-- As 0132_task_retire_delete.sql made it: next with an upkeep task's number is TASK_IS_UPKEEP,
-- whoever asks, since next hands one out only from its counts.
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
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;  -- 0134
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

-- As 0132_task_retire_delete.sql made it: an upkeep task never changes (TASK_IS_UPKEEP).
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
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;  -- 0134
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

-- As 0132_task_retire_delete.sql made it: an upkeep task is never deleted (TASK_IS_UPKEEP).
CREATE OR REPLACE FUNCTION schellingaf.delete_task(p_space_name text, p_actor bytea, p_number integer, p_reason text,
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
  IF t.upkeep IS NOT NULL THEN RAISE EXCEPTION 'TASK_IS_UPKEEP'; END IF;  -- 0134
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

-- As 0132_task_retire_delete.sql made it, with an upkeep task's own rules (0134). Document
-- upkeep is done with the holder's own version in this SPACE, posted at or after it took
-- the task, pending or current: accepted at once when current, else done until
-- upkeep_on_version() accepts or retires it. A task review is done with the holder's own
-- decision posted after it took the task, and accepted at once; the review's time is kept,
-- and the next review counts only what came after it. Any other post is INVALID_REQUEST.
CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                                 p_revision integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_version text; v_accept boolean;
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
  IF t.upkeep = 'document' THEN  -- 0134
    SELECT v.state INTO v_version FROM posts p JOIN oracle_versions v ON v.post_id = p.post_id
     WHERE p.post_id = p_post AND p.space_id = s.space_id AND p.author_id = p_actor AND p.kind = 'version'
       AND p.posted_at >= t.claimed_at AND v.state IN ('pending', 'current');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'post_id: your version in this SPACE, posted after you took this task';
    END IF;
    v_accept := v_version = 'current';
  ELSIF t.upkeep = 'tasks' THEN  -- 0134
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
  ELSE
    IF NOT EXISTS (SELECT 1 FROM posts p
                    WHERE p.post_id = p_post AND p.space_id = s.space_id AND p.author_id = p_actor) THEN
      RAISE EXCEPTION 'TASK_POST_NOT_FOUND';
    END IF;
    v_accept := s.task_confirmations = 0;
  END IF;

  UPDATE tasks k
     SET state = CASE WHEN v_accept THEN 'accepted' ELSE 'done' END,
         claimed_until = NULL, done_post_id = p_post, done_at = now(),
         accepted_at = CASE WHEN v_accept THEN now() END
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- As 0132_task_retire_delete.sql made it, with an upkeep claim's cap (0134): progress
-- renews it to at most twice the claim hours after it was taken, and a claim of the
-- holder's that passed is linked and never renewed.
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
                     claimed_until = CASE
                       WHEN k.upkeep IS NULL THEN now() + make_interval(hours => s.task_claim_hours)
                       WHEN k.claimed_until <= now() THEN k.claimed_until  -- 0134
                       ELSE greatest(k.claimed_until,
                                     least(now() + make_interval(hours => s.task_claim_hours),
                                           k.claimed_at + make_interval(hours => 2 * s.task_claim_hours))) END
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- As 0132_task_retire_delete.sql made it: an upkeep task is never checked (TASK_IS_UPKEEP).
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
    v_delivered := deliver_task_notices(s.space_id, t.task_id, v_cycle, p_actor, v_peers,
                                        array_fill('task_rejected'::text, ARRAY[cardinality(v_peers)]));
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- As 0132_task_retire_delete.sql made it, with upkeep tasks left out of every count: of
-- tasks_all, on tasks_closed_idx, whose predicate now takes them in, and of the claimed and
-- the done, so the accepted count beside them (countsOf()) never takes one in.
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
              WHERE tx.space_id = s.space_id AND (tx.state IN ('retired', 'deleted') OR tx.upkeep IS NOT NULL)))::int,
         (SELECT count(*) FROM schellingaf.tasks tc
           WHERE tc.space_id = s.space_id AND tc.state = 'claimed' AND tc.claimed_until > now()
             AND tc.upkeep IS NULL)::int,
         (SELECT count(*) FROM schellingaf.tasks td
           WHERE td.space_id = s.space_id AND td.state = 'done' AND td.upkeep IS NULL)::int,
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

-- As 0132_task_retire_delete.sql made it, with one refusal (0134): an upkeep task retired
-- with replacement tasks is INVALID_REQUEST. Retired without them, by a coordinator or
-- above, it is as any task.
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
  -- 0134: an upkeep task's work is the service's to hand out again, never a KEY's to replace.
  IF t.upkeep IS NOT NULL AND p_tasks IS NOT NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'tasks: an upkeep task is retired without replacements';
  END IF;

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

-- As 0132_task_retire_delete.sql made it, its five-argument form, with left_by (0134): the
-- holder's own release of an upkeep task names it there, so next hands that row to another
-- KEY; any other release clears it.
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
                     release_reason = CASE WHEN v_other THEN p_reason ELSE k.release_reason END,
                     left_by = CASE WHEN k.upkeep IS NOT NULL AND NOT v_other THEN p_actor END  -- 0134
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[v_holder], ARRAY['task_reopened']);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- As 0117_numbers.sql made it, with what counts as a task made (0134): a task a KEY added
-- and did not delete. An upkeep task is the service's own row, and a deleted task's words
-- are erased, so neither is counted; a retired task still is.
CREATE OR REPLACE FUNCTION schellingaf.service_numbers() RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  WITH w AS (SELECT now() - interval '7 days' AS since),
  k AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE p.registered_at > w.since) AS fresh,
           count(*) FILTER (WHERE p.key_type = 'ed25519') AS ed25519,
           count(*) FILTER (WHERE p.key_type = 'ed25519' AND p.registered_at > w.since) AS ed25519_fresh,
           count(*) FILTER (WHERE p.key_type = 'passkey') AS passkey,
           count(*) FILTER (WHERE p.key_type = 'passkey' AND p.registered_at > w.since) AS passkey_fresh
      FROM schellingaf.peers p, w
  ),
  -- A KEY that wrote a post or sent a direct message in the window, once however often.
  active AS (
    SELECT count(*) AS n
      FROM (SELECT po.author_id FROM schellingaf.posts po, w WHERE po.posted_at > w.since
            UNION
            SELECT m.author_id FROM schellingaf.messages m, w WHERE m.sent_at > w.since) a
  ),
  s AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE sp.created_at > w.since) AS fresh,
           count(*) FILTER (WHERE sp.visibility = 'public') AS public,
           count(*) FILTER (WHERE sp.visibility = 'public' AND sp.created_at > w.since) AS public_fresh,
           count(*) FILTER (WHERE sp.visibility = 'private') AS private,
           count(*) FILTER (WHERE sp.visibility = 'private' AND sp.created_at > w.since) AS private_fresh,
           count(*) FILTER (WHERE sp.visibility = 'sealed') AS sealed,
           count(*) FILTER (WHERE sp.visibility = 'sealed' AND sp.created_at > w.since) AS sealed_fresh,
           count(*) FILTER (WHERE NOT sp.oracle) AS work,
           count(*) FILTER (WHERE NOT sp.oracle AND sp.created_at > w.since) AS work_fresh,
           count(*) FILTER (WHERE sp.oracle) AS oracle,
           count(*) FILTER (WHERE sp.oracle AND sp.created_at > w.since) AS oracle_fresh,
           count(*) FILTER (WHERE sp.join_policy = 'open') AS open,
           count(*) FILTER (WHERE sp.join_policy = 'open' AND sp.created_at > w.since) AS open_fresh
      FROM schellingaf.spaces sp, w
  ),
  -- Each post by the visibility of its SPACE, which no request changes.
  po AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE x.fresh) AS fresh,
           count(*) FILTER (WHERE x.visibility = 'public') AS public,
           count(*) FILTER (WHERE x.visibility = 'public' AND x.fresh) AS public_fresh,
           count(*) FILTER (WHERE x.visibility = 'private') AS private,
           count(*) FILTER (WHERE x.visibility = 'private' AND x.fresh) AS private_fresh,
           count(*) FILTER (WHERE x.visibility = 'sealed') AS sealed,
           count(*) FILTER (WHERE x.visibility = 'sealed' AND x.fresh) AS sealed_fresh
      FROM (SELECT sp.visibility, p.posted_at > w.since AS fresh
              FROM schellingaf.posts p
              JOIN schellingaf.spaces sp ON sp.space_id = p.space_id, w) x
  ),
  t AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE ta.created_at > w.since) AS fresh
      FROM schellingaf.tasks ta, w
     WHERE ta.upkeep IS NULL AND ta.state <> 'deleted'  -- 0134
  ),
  f AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE fi.posted_at > w.since) AS fresh
      FROM schellingaf.findings fi, w
  ),
  c AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE co.created_at > w.since) AS fresh
      FROM schellingaf.conversations co, w
  ),
  m AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE me.sent_at > w.since) AS fresh,
           count(*) FILTER (WHERE me.body IS NULL) AS sealed,
           count(*) FILTER (WHERE me.body IS NULL AND me.sent_at > w.since) AS sealed_fresh
      FROM schellingaf.messages me, w
  )
  SELECT jsonb_build_object(
    'counted_at', now(),
    'keys', jsonb_build_object(
      'all',     jsonb_build_object('total', k.n,       'last_7_days', k.fresh),
      'ed25519', jsonb_build_object('total', k.ed25519, 'last_7_days', k.ed25519_fresh),
      'passkey', jsonb_build_object('total', k.passkey, 'last_7_days', k.passkey_fresh),
      'active_last_7_days', active.n),
    'spaces', jsonb_build_object(
      'all',     jsonb_build_object('total', s.n,       'last_7_days', s.fresh),
      'public',  jsonb_build_object('total', s.public,  'last_7_days', s.public_fresh),
      'private', jsonb_build_object('total', s.private, 'last_7_days', s.private_fresh),
      'sealed',  jsonb_build_object('total', s.sealed,  'last_7_days', s.sealed_fresh),
      'work',    jsonb_build_object('total', s.work,    'last_7_days', s.work_fresh),
      'oracle',  jsonb_build_object('total', s.oracle,  'last_7_days', s.oracle_fresh),
      'open',    jsonb_build_object('total', s.open,    'last_7_days', s.open_fresh)),
    'posts', jsonb_build_object(
      'all',               jsonb_build_object('total', po.n,       'last_7_days', po.fresh),
      'in_public_spaces',  jsonb_build_object('total', po.public,  'last_7_days', po.public_fresh),
      'in_private_spaces', jsonb_build_object('total', po.private, 'last_7_days', po.private_fresh),
      'in_sealed_spaces',  jsonb_build_object('total', po.sealed,  'last_7_days', po.sealed_fresh)),
    'tasks',    jsonb_build_object('total', t.n, 'last_7_days', t.fresh),
    'findings', jsonb_build_object('total', f.n, 'last_7_days', f.fresh),
    'direct_messages', jsonb_build_object(
      'conversations',   jsonb_build_object('total', c.n,      'last_7_days', c.fresh),
      'messages',        jsonb_build_object('total', m.n,      'last_7_days', m.fresh),
      'sealed_messages', jsonb_build_object('total', m.sealed, 'last_7_days', m.sealed_fresh)))
    FROM k, active, s, po, t, f, c, m;
END;

-- ─────────────────────────────────────────────────────────────────────────────
-- A version decided, and the document's upkeep task
-- ─────────────────────────────────────────────────────────────────────────────

-- The SPACE's live document upkeep task, when one of its versions goes current, is declined
-- or goes out of date. A version that goes current accepts it when its holder wrote that
-- version after taking the task (naming it as the result if the task was only claimed), and
-- retires it otherwise: another version settled the document. A version declined retires it
-- when the task names it or its holder wrote it after taking the task, and moves where the
-- document's count starts to that version, so the same findings do not call for upkeep
-- again at once; the next brief still reads from the current version. A version that goes
-- out of date retires it while the task names it. The service retires it, so closed_by is
-- null. oracle_versions is written only by append_post(), under the SPACE lock, so this runs
-- under it too; it writes no mailbox notice, which keeps append_post()'s ascending lock
-- order on mailboxes, and a holder learns at its next done or progress (TASK_NOT_OPEN).
CREATE FUNCTION schellingaf.upkeep_on_version() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE t tasks%ROWTYPE; v_mine boolean; v_reason text;
BEGIN
  SELECT * INTO t FROM tasks k
   WHERE k.space_id = NEW.space_id AND k.upkeep = 'document' AND k.state IN ('open', 'claimed', 'done')
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Written by its holder after it took the task.
  v_mine := t.claimed_by IS NOT NULL AND NEW.author_id = t.claimed_by
            AND (SELECT p.posted_at FROM posts p WHERE p.post_id = NEW.post_id) >= t.claimed_at;

  IF NEW.state = 'current' AND v_mine THEN
    UPDATE tasks k SET state = 'accepted', claimed_until = NULL,
                       done_post_id = coalesce(k.done_post_id, NEW.post_id), done_at = coalesce(k.done_at, now()),
                       accepted_at = now()
     WHERE k.task_id = t.task_id;
    RETURN NULL;
  END IF;
  v_reason := CASE
    WHEN NEW.state = 'current' THEN 'version ' || NEW.seq || ' became current'
    WHEN NEW.state = 'declined' AND (t.done_post_id = NEW.post_id OR v_mine) THEN 'version ' || NEW.seq || ' declined'
    WHEN NEW.state = 'out_of_date' AND t.done_post_id = NEW.post_id THEN 'version ' || NEW.seq || ' out of date'
  END;
  IF v_reason IS NULL THEN RETURN NULL; END IF;
  UPDATE tasks k SET state = 'retired', claimed_until = NULL,
                     claimed_by = CASE WHEN k.done_post_id IS NULL THEN NULL ELSE k.claimed_by END,
                     closed_by = NULL, closed_at = now(), close_reason = v_reason
   WHERE k.task_id = t.task_id;
  IF NEW.state = 'declined' THEN
    INSERT INTO task_upkeep AS k (space_id, document_from_seq) VALUES (NEW.space_id, NEW.seq)
    ON CONFLICT (space_id) DO UPDATE SET document_from_seq = greatest(k.document_from_seq, EXCLUDED.document_from_seq);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER oracle_versions_upkeep
  AFTER UPDATE OF state ON schellingaf.oracle_versions
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state IN ('current', 'declined', 'out_of_date'))
  EXECUTE FUNCTION schellingaf.upkeep_on_version();

GRANT EXECUTE ON FUNCTION
  schellingaf.set_task_settings(text, bytea, integer, text, integer, integer, integer),
  schellingaf.next_job(text, bytea, text, text, integer, jsonb, integer, integer, integer, integer, integer, integer)
TO schellingaf_api;
