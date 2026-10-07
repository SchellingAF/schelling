-- Task records that follow corrections (proposal-task-corrections, 7 October 2026).
--
-- A coordinated run on a public quest met four gaps in the task list: a KEY that finished a
-- task while its after waited was refused, a correction after done could not be recorded, a
-- reject left the task held by nobody, and a later audit could not reopen an accepted task.
-- Four rules, the owner's and the coordinator's calls:
--
--   B1  done while  a task in after is not accepted or retired: done is recorded, holder or
--       after waits not, and the task is done but held. Nobody checks a held task: next
--                   offers none, and confirm and reject answer TASK_WAITING with the number
--                   it waits for. Where the SPACE asks for no confirmation and the attempt
--                   is uncontested, accept_after marks it, and the trigger
--                   tasks_release_held accepts it once every task in its after is accepted.
--   B2  a newer     done by a KEY whose own attempt in the cycle waits for a check records a
--       post        new attempt that replaces it (task_attempts.replaces). A replaced attempt
--                   is never checked, its confirmations stay recorded and count for nothing,
--                   and replaced attempts do not count toward the attempts limit.
--   B3  a reject    that reopens a task leaves it claimed, for the claim hours, by each KEY
--       reopens     whose attempt in the closing cycle was rejected: within the hold and
--                   claimant limits, never a KEY now below writer, blocked, or under its
--                   own give-back lock.
--   B4  an accepted task may be rejected by any KEY that may check it and is not its doer:
--       task        the reject reopens it as B3 does. task_checks_attempt_key takes verdict,
--                   so a KEY that confirmed the accepted attempt may reject it later.
--
--   C   a check by  a task's independent_of names up to 8 tasks of its SPACE (proposal
--       a third KEY  third-key-checks). A doer of one of them may neither confirm nor reject
--                   this task, B4's reopen included (TASK_SELF_CHECK, detail task <n>), next
--                   never offers it the check, and a confirmation stops counting once its
--                   KEY becomes one. A doer of task X: the submitter of any attempt at X, in
--                   any cycle, and the author of the post of X's accepted attempt
--                   (task_doer()); never the author of a post an attempt only names, so a
--                   writer cannot bar an honest checker by naming its post. Opt-in: a task
--                   that names none answers as before. Set on add, change, a batch and a
--                   retire's replacements (insert_tasks(), change_task()); a retire's
--                   replacements join every independent_of that names the retired task;
--                   delete erases it.
--
-- "Pending" now means neither rejected nor replaced: every reader of it gains the clause
-- NOT EXISTS (a later attempt with replaces = this attempt), which probes
-- task_attempts_replaces_idx.
--
-- Every function is replaced whole, from the newest body on main, with its changed lines
-- marked B1 to B4: protect_task() (0140), task_item(), task_check(), next_job()'s
-- fourteen-argument form, task_done()'s seven-argument form and upkeep_due() (0144), and
-- task_mirror_faults() (0141). task_check() takes two trailing arguments, so it is dropped,
-- created again and granted again. The 0137 contested block and the three version check
-- (0138) blocks are carried exactly, the contested block reading the reject alone (B4).
--
-- Who takes the SPACE lock before a task becomes accepted or retired, so the release below
-- runs under it: task_check() and task_done() (SELECT ... FROM spaces ... FOR NO KEY UPDATE,
-- below), next_job() (the same, before its upkeep retire), retire_task() (0141, the same,
-- before its UPDATE), upkeep_on_version() (0134, a trigger on oracle_versions, which only
-- append_post() writes, under the SPACE lock), and release_held_tasks() itself, which takes
-- it again, a no-op for a holder, before its worklist.

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- B2: a correction names the attempt it replaces: an earlier one of the same KEY in the same
-- cycle, which task_done() alone chooses. One attempt a KEY a cycle replaces none; each
-- attempt is replaced at most once.
ALTER TABLE schellingaf.task_attempts ADD COLUMN replaces integer
  CONSTRAINT task_attempts_replaces_earlier CHECK (replaces >= 1 AND replaces < attempt);
ALTER TABLE schellingaf.task_attempts DROP CONSTRAINT task_attempts_task_id_cycle_peer_id_key;
CREATE UNIQUE INDEX task_attempts_first_idx ON schellingaf.task_attempts (task_id, cycle, peer_id) WHERE replaces IS NULL;
CREATE UNIQUE INDEX task_attempts_replaces_idx ON schellingaf.task_attempts (task_id, replaces) WHERE replaces IS NOT NULL;

-- B1: accept once every task in after is accepted, at confirmations 0, uncontested.
ALTER TABLE schellingaf.tasks ADD COLUMN accept_after boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT tasks_accept_after_done CHECK (NOT accept_after OR state = 'done');
CREATE INDEX tasks_accept_after_idx ON schellingaf.tasks (space_id) WHERE accept_after;

-- B4: a KEY that confirmed an attempt may later reject it, once the attempt was accepted.
ALTER TABLE schellingaf.task_checks DROP CONSTRAINT task_checks_attempt_key,
  ADD CONSTRAINT task_checks_attempt_key UNIQUE NULLS NOT DISTINCT (task_id, cycle, peer_id, attempt, verdict);

-- C: the tasks whose doers may not check this one, kept per revision as after is. A deleted
-- task's words are erased, this with them.
ALTER TABLE schellingaf.tasks ADD COLUMN independent_of uuid[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT tasks_independent_of_size CHECK (cardinality(independent_of) <= 8),
  ADD CONSTRAINT tasks_independent_of_deleted CHECK (state <> 'deleted' OR independent_of = '{}');
ALTER TABLE schellingaf.task_revisions ADD COLUMN independent_of uuid[] NOT NULL DEFAULT '{}';

-- ─────────────────────────────────────────────────────────────────────────────
-- Held, and released
-- ─────────────────────────────────────────────────────────────────────────────

-- The lowest number of a task in t's after that is neither accepted nor retired, or null. A
-- done task is held while it is not null. One primary-key probe a task in after. Granted to
-- the api role: task_item() reads it as the caller, and it reads only tasks the caller's row
-- security shows, in t's own SPACE.
CREATE FUNCTION schellingaf.task_held(t schellingaf.tasks)
  RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT min(a.number) FROM schellingaf.tasks a
           WHERE a.task_id = ANY (t.waits_for) AND a.space_id = t.space_id
             AND a.state NOT IN ('accepted', 'retired'));
GRANT EXECUTE ON FUNCTION schellingaf.task_held(schellingaf.tasks) TO schellingaf_api;

-- C: the lowest number of a task in t's independent_of that p_peer did, or null. A doer of
-- task X submitted an attempt at X, in any cycle, rejected and replaced attempts included,
-- or wrote the post of X's accepted attempt, once a KEY that neither submitted that attempt
-- nor wrote its post confirmed it: at confirmations 0 nobody did, and naming an honest KEY's
-- post bars it from nothing. Null at once for a task that names none. One
-- probe of task_attempts by task_id a named task. Granted to the api role: task_item()
-- reads it as the caller, and it reads only rows the caller's row security shows, in t's
-- own SPACE, where whoever reads the task reads who did what.
CREATE FUNCTION schellingaf.task_doer(t schellingaf.tasks, p_peer bytea)
  RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT min(x.number) FROM schellingaf.tasks x
   WHERE x.task_id = ANY (t.independent_of) AND x.space_id = t.space_id
     AND (EXISTS (SELECT 1 FROM schellingaf.task_attempts a WHERE a.task_id = x.task_id AND a.peer_id = p_peer)
          OR (x.state = 'accepted'
              AND EXISTS (SELECT 1 FROM schellingaf.task_attempts a
                           WHERE a.task_id = x.task_id AND a.attempt = x.attempt AND a.author_id = p_peer
                             AND EXISTS (SELECT 1 FROM schellingaf.task_checks c
                                          WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                            AND c.verdict = 'confirm'
                                            AND c.peer_id <> a.peer_id AND c.peer_id <> a.author_id))))
$$;
GRANT EXECUTE ON FUNCTION schellingaf.task_doer(schellingaf.tasks, bytea) TO schellingaf_api;

-- B1: when a task becomes accepted or retired, each done task of its SPACE marked
-- accept_after that names it and is no longer held: accepted with its attempt of record,
-- where the change was an acceptance, the SPACE still asks for no confirmation, its
-- submitter is blocked neither here nor by the operator, and its post is neither hidden nor
-- withheld; else its mark only is cleared, and its check is offered as any other. An
-- acceptance here is itself a change that releases: the outermost firing walks the chain
-- as a worklist, and a nested one, which the transaction-local setting marks, returns at
-- once. The outermost clears the setting when its worklist ends, so a second acceptance in
-- the same transaction (a POST with two confirms) releases too. No notice, as
-- upkeep_on_version() sends none. Internal: a trigger, granted to nobody.
CREATE FUNCTION schellingaf.release_held_tasks()
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
REVOKE ALL ON FUNCTION schellingaf.release_held_tasks() FROM PUBLIC;
CREATE TRIGGER tasks_release_held AFTER UPDATE OF state ON schellingaf.tasks
  FOR EACH ROW WHEN (NEW.state IN ('accepted', 'retired') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION schellingaf.release_held_tasks();

-- ─────────────────────────────────────────────────────────────────────────────
-- What a task may never do
-- ─────────────────────────────────────────────────────────────────────────────

-- protect_task() as 0140_task_attempts.sql made it, with the lines marked B1 and C. B1: a task
-- waits to be accepted only while it is done, so a retire or a reopen clears the mark by
-- itself. C: independent_of changes only with a revision, as after, and on a done or
-- accepted task too (change_task() lets only a coordinator or above), never a retired one.
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
  IF NEW.cycle < OLD.cycle OR NEW.revision < OLD.revision OR NEW.attempts < OLD.attempts THEN  -- attempts
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
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
  -- C: independent_of changes with a revision too, and on a done or accepted task as well,
  -- never on a retired one.
  IF NEW.state <> 'deleted' AND NEW.independent_of <> OLD.independent_of THEN
    IF OLD.state = 'retired' OR NEW.revision <> OLD.revision + 1
       OR NOT EXISTS (SELECT 1 FROM schellingaf.task_revisions r
                       WHERE r.task_id = OLD.task_id AND r.revision = OLD.revision) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD';
    END IF;
  END IF;
  IF NEW.state <> 'done' THEN NEW.accept_after := false; END IF;  -- B1
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The one projection of a task
-- ─────────────────────────────────────────────────────────────────────────────

-- task_item() as 0144_tasks.sql made it, with the lines marked B1, B2 and C: a held task adds
-- check_waits_for, the number it waits for; each attempt adds replaces when it replaced
-- one, and reads replaced when a later attempt replaced it. C: a task that names tasks in
-- independent_of adds it, and their numbers as after_numbers pairs with after; a
-- confirmation whose KEY did one of them is not named among those that count.
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
                     AND schellingaf.confirmation_counts(c.space_id, c.peer_id)  -- 0144: blocked confirmers
                     AND (cardinality(t.independent_of) = 0 OR schellingaf.task_doer(t, c.peer_id) IS NULL))))  -- C
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
                                                         WHEN EXISTS (SELECT 1 FROM schellingaf.task_attempts r
                                                                       WHERE r.task_id = a.task_id AND r.replaces = a.attempt)
                                                           THEN 'replaced'  -- B2
                                                         WHEN t.state = 'accepted' AND t.attempt = a.attempt THEN 'accepted'
                                                         WHEN t.state = 'accepted' THEN 'passed'
                                                         ELSE 'pending' END,
                                           'confirmations', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                                                               FROM schellingaf.task_checks c
                                                              WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt
                                                                AND c.verdict = 'confirm'
                                                                AND schellingaf.confirmation_counts(c.space_id, c.peer_id)  -- 0144
                                                                AND (cardinality(t.independent_of) = 0
                                                                     OR schellingaf.task_doer(t, c.peer_id) IS NULL)))  -- C
                                         || CASE WHEN a.author_id <> a.peer_id
                                                 THEN jsonb_build_object('author', encode(a.author_id, 'hex')) ELSE '{}'::jsonb END
                                         || CASE WHEN a.replaces IS NOT NULL  -- B2
                                                 THEN jsonb_build_object('replaces', a.replaces) ELSE '{}'::jsonb END
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
    -- B1: a done task whose after is not all accepted or retired: its check waits for that.
    || coalesce((SELECT jsonb_build_object('check_waits_for', h.n)
                   FROM (SELECT schellingaf.task_held(t) AS n) h
                  WHERE t.state = 'done' AND h.n IS NOT NULL), '{}'::jsonb)
    -- C: the tasks whose doers may not check it, and their numbers, only when it names any.
    || CASE WHEN cardinality(t.independent_of) > 0 THEN jsonb_build_object(
              'independent_of', to_jsonb(t.independent_of),
              'independent_of_numbers', (SELECT coalesce(jsonb_agg(w.number ORDER BY w.ord), '[]'::jsonb)
                                           FROM (SELECT o.ord,
                                                        (SELECT k.number FROM schellingaf.tasks k
                                                          WHERE k.task_id = o.task_id AND k.space_id = t.space_id) AS number
                                                   FROM unnest(t.independent_of) WITH ORDINALITY o(task_id, ord)) w))
            ELSE '{}'::jsonb END
  END;

-- ─────────────────────────────────────────────────────────────────────────────
-- A check
-- ─────────────────────────────────────────────────────────────────────────────

-- task_check() as 0144_tasks.sql made it, with the lines marked B1 to B4 and the trailing
-- p_held_max and p_claimants_max (B3), which the routes send as TASK_LIMITS.held and
-- TASK_LIMITS.claimants. B1: a held task's check is TASK_WAITING. B2: a replaced attempt is
-- refused TASK_NOT_DONE naming the attempt that replaced it, answered through the route with
-- the caller's offer dropped, and pending reads the replaces clause. B3: a reject that
-- reopens the task gives a claim to each KEY whose attempt in the closing cycle was
-- rejected. B4: a reject of an accepted task's attempt by a KEY that may check it and is not
-- its doer reopens it. Its 0137 contested block is carried, reading the reject alone. C: a
-- doer of a task in independent_of is TASK_SELF_CHECK, detail task <n>, after the doer test,
-- a concession and B4's reopen included; a confirmation counts only while its KEY did none.
DROP FUNCTION schellingaf.task_check(text, bytea, integer, text, uuid, text, boolean, integer, integer, integer);
CREATE FUNCTION schellingaf.task_check(p_space_name text, p_actor bytea, p_number integer, p_verdict text,
                                       p_post uuid DEFAULT NULL, p_reason text DEFAULT NULL,
                                       p_deliveries boolean DEFAULT false, p_attempt integer DEFAULT NULL,
                                       p_cycle integer DEFAULT NULL, p_offer_minutes integer DEFAULT 30,
                                       p_held_max integer DEFAULT 3, p_claimants_max integer DEFAULT 3)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; r task_checks%ROWTYPE; a task_attempts%ROWTYPE; v_given bigint;
        v_state text; v_cycle integer; v_offer_cycle integer; v_offer_attempt integer; v_late integer;
        v_pending integer[]; v_mine integer; v_count integer; v_next task_attempts%ROWTYPE; v_detail text;
        v_peers bytea[]; v_delivered jsonb := '[]';
        v_reopen boolean := false; v_replaced boolean := false; v_by integer; v_wait integer;  -- B1, B2, B4
        v_did integer;  -- C
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
  ELSIF t.state = 'accepted' AND p_verdict = 'reject' AND t.attempt IS NOT NULL
        AND (p_attempt = t.attempt
             OR (p_attempt IS NULL AND NOT (v_offer_cycle = t.cycle AND v_offer_attempt IS NOT NULL
                                            AND v_offer_attempt <> t.attempt))) THEN
    -- B4: a reject of the accepted attempt reopens the task: one that names it, or names no
    -- attempt while the caller holds no live offer of this cycle naming another. A reject
    -- meant for another attempt meets TASK_NOT_DONE accepted, as before.
    SELECT * INTO a FROM task_attempts x WHERE x.task_id = t.task_id AND x.attempt = t.attempt;
    v_reopen := true;
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
                        WHERE c.task_id = x.task_id AND c.cycle = x.cycle AND c.attempt = x.attempt AND c.verdict = 'reject')
       AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = x.task_id AND n.replaces = x.attempt);  -- B2
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
    IF FOUND THEN
      v_detail := 'attempt ' || a.attempt || ': rejected by ' || encode(r.peer_id, 'hex');
    ELSIF EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt) THEN
      -- B2: replaced by a newer attempt of its KEY: the detail names the one that stands, the
      -- KEY's attempt of the cycle that nothing replaced.
      SELECT n.attempt INTO v_by FROM task_attempts n
       WHERE n.task_id = a.task_id AND n.cycle = a.cycle AND n.peer_id = a.peer_id
         AND NOT EXISTS (SELECT 1 FROM task_attempts m WHERE m.task_id = n.task_id AND m.replaces = n.attempt);
      v_detail := 'attempt ' || a.attempt || ': replaced by attempt ' || v_by;
      v_replaced := true;
    END IF;
  END IF;
  IF v_detail IS NOT NULL THEN
    IF NOT p_deliveries THEN RAISE EXCEPTION 'TASK_NOT_DONE' USING DETAIL = v_detail; END IF;
    IF NOT v_replaced  -- B2: no reject to tell of
       AND NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                        WHERE md.recipient_id = p_actor AND md.task_id = t.task_id
                          AND md.task_cycle = r.cycle AND md.reason = 'task_rejected'
                          AND md.task_attempt IS NOT DISTINCT FROM r.attempt) THEN
      v_delivered := deliver_task_notices(s.space_id, t.task_id, r.cycle, r.peer_id,
                                          ARRAY[p_actor], ARRAY['task_rejected'], r.attempt);
    END IF;
    DELETE FROM task_check_offers o WHERE o.task_id = t.task_id AND o.peer_id = p_actor;
    RETURN jsonb_build_object('refused', 'TASK_NOT_DONE', 'detail', v_detail, 'delivered', v_delivered);
  END IF;

  -- B1: a done task waits for its after before anybody checks it.
  IF t.state = 'done' THEN
    v_wait := task_held(t);
    IF v_wait IS NOT NULL THEN RAISE EXCEPTION 'TASK_WAITING' USING DETAIL = v_wait::text; END IF;
  END IF;

  -- The doer: a KEY that wrote this attempt's post, or made an attempt in the cycle. Where
  -- the SPACE asks for no confirmation, a KEY with an attempt may still confirm another's.
  IF a.peer_id = p_actor OR a.author_id = p_actor THEN
    RAISE EXCEPTION 'TASK_SELF_CHECK' USING DETAIL = 'attempt ' || a.attempt;
  END IF;
  SELECT x.attempt INTO v_mine FROM task_attempts x
   WHERE x.task_id = t.task_id AND x.cycle = t.cycle AND x.peer_id = p_actor
   ORDER BY x.attempt DESC LIMIT 1;  -- B2: its newest, where it replaced one
  IF FOUND AND NOT (s.task_confirmations = 0 AND p_verdict = 'confirm') THEN
    RAISE EXCEPTION 'TASK_SELF_CHECK' USING DETAIL = 'attempt ' || v_mine;
  END IF;
  -- C: nor a KEY that did a task this one names in independent_of: the lowest such number.
  IF cardinality(t.independent_of) > 0 THEN
    v_did := task_doer(t, p_actor);
    IF v_did IS NOT NULL THEN RAISE EXCEPTION 'TASK_SELF_CHECK' USING DETAIL = 'task ' || v_did; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM task_checks c
              WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.peer_id = p_actor
                AND (c.attempt = a.attempt OR c.attempt IS NULL)
                AND (NOT v_reopen OR c.verdict = 'reject')) THEN  -- B4: a confirmer may reject it now
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
       AND confirmation_stands(c.space_id, c.peer_id)
       -- C: nor by a KEY that has since done a task this one names in independent_of.
       AND (cardinality(t.independent_of) = 0 OR task_doer(t, c.peer_id) IS NULL);
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
    IF NOT v_reopen THEN  -- B4: an accepted task has no other attempt waiting
      SELECT * INTO v_next FROM task_attempts x
       WHERE x.task_id = t.task_id AND x.cycle = t.cycle
         AND NOT EXISTS (SELECT 1 FROM task_checks c
                          WHERE c.task_id = x.task_id AND c.cycle = x.cycle AND c.attempt = x.attempt AND c.verdict = 'reject')
         AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = x.task_id AND n.replaces = x.attempt)  -- B2
       ORDER BY x.attempt LIMIT 1;
    END IF;
    IF NOT v_reopen AND FOUND THEN
      -- Another attempt waits: the task stays done, and the attempt of record is the lowest
      -- pending one. done_at stays, so the check-first wait does not start again.
      UPDATE tasks k SET attempt = v_next.attempt, claimed_by = v_next.peer_id, done_post_id = v_next.post_id
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
    ELSE
      UPDATE tasks k SET state = 'open', cycle = k.cycle + 1, claimed_by = NULL, claimed_until = NULL,
                         done_post_id = NULL, done_at = NULL, attempt = NULL,
                         accepted_at = NULL  -- B4
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
      -- B3: held for the claim hours by each KEY whose attempt in the closing cycle was
      -- rejected, in attempt order, up to p_claimants_max: never a KEY now below writer,
      -- blocked here or by the operator, under its own give-back lock, or holding
      -- p_held_max live claims in this SPACE. No take is counted.
      INSERT INTO task_claims (task_id, space_id, peer_id, claimed_at, claimed_until, claim_revision)
      SELECT t.task_id, s.space_id, q.peer_id, now(), now() + make_interval(hours => s.task_claim_hours), t.revision
        FROM (SELECT g.peer_id, g.first, rank_in_space(s.space_id, s.owner_id, g.peer_id) AS rank
                FROM (SELECT x.peer_id, min(x.attempt) AS first FROM task_attempts x
                       WHERE x.task_id = t.task_id AND x.cycle = v_cycle
                         AND EXISTS (SELECT 1 FROM task_checks j
                                      WHERE j.task_id = x.task_id AND j.cycle = x.cycle AND j.attempt = x.attempt
                                        AND j.verdict = 'reject')
                       GROUP BY x.peer_id) g) q
       WHERE q.rank >= 20
         AND confirmation_stands(s.space_id, q.peer_id)
         AND NOT (q.rank < 30 AND t.released_by IS NOT DISTINCT FROM q.peer_id
                  AND t.released_at > now() - make_interval(hours => s.task_claim_hours))
         AND claims_held(s.space_id, q.peer_id, t.task_id) < p_held_max
       ORDER BY q.first
       LIMIT p_claimants_max;
      t := sync_task_claims(t.task_id);
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
     WHERE k.task_id = t.task_id AND k.cycle = v_cycle AND k.peer_id = p_actor AND k.attempt = a.attempt
       AND k.verdict = 'reject';  -- B4: a KEY that confirmed the attempt may have a confirm here too
    -- 0137 END contested
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN v_count >= 2 THEN jsonb_build_object('attempt', a.attempt) ELSE '{}'::jsonb END
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;
GRANT EXECUTE ON FUNCTION
  schellingaf.task_check(text, bytea, integer, text, uuid, text, boolean, integer, integer, integer, integer, integer)
TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- next
-- ─────────────────────────────────────────────────────────────────────────────

-- next_job()'s fourteen-argument form as 0144_tasks.sql made it, its three version check
-- (0138) blocks carried exactly, with the lines marked B1, B2 and C: steps 2, 6 and job check
-- pass a held task by, and an attempt offered, waiting or counted under the cap is one that
-- nothing replaced. C: they pass by a task the caller may not check, having done a task in
-- its independent_of, and the cap counts no confirmation of a KEY that did one. The
-- twelve-argument wrapper is unchanged.

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

-- ─────────────────────────────────────────────────────────────────────────────
-- done
-- ─────────────────────────────────────────────────────────────────────────────

-- task_done()'s seven-argument form as 0144_tasks.sql made it, with the lines marked B1 and
-- B2. B1: no TASK_WAITING: while a task in after is not accepted, done is recorded and the
-- task is held; at confirmations 0, uncontested, it is marked accept_after instead of
-- accepted, and another KEY's attempt clears the mark. B2: the caller's own attempt in the
-- cycle, while it waits for a check, is replaced by this one; replaced attempts do not count
-- toward p_attempts_max; the answer adds replaces; whoever confirmed the replaced attempt or
-- holds a live offer naming it is told, an offer living p_offer_minutes, a new trailing
-- argument: the body moves to an eight-argument form, granted, and the seven-argument form
-- wraps it. The answer adds check_waits_for while the task is held. The five- and
-- four-argument wrappers are unchanged: they send seven.

CREATE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
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
  SELECT count(*) INTO v_live FROM task_attempts a
   WHERE a.task_id = t.task_id AND a.cycle = t.cycle
     AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt);
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
    v_accept := s.task_confirmations = 0 AND NOT v_contested AND v_held IS NULL;
    UPDATE tasks k
       SET state = CASE WHEN v_accept THEN 'accepted' ELSE 'done' END,
           claimed_by = p_actor, claimed_until = NULL, done_post_id = p_post, done_at = now(),
           accepted_at = CASE WHEN v_accept THEN now() END, attempts = v_n, attempt = v_n,
           accept_after = s.task_confirmations = 0 AND NOT v_contested AND v_held IS NOT NULL,  -- B1
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
GRANT EXECUTE ON FUNCTION
  schellingaf.task_done(text, bytea, integer, uuid, integer, boolean, integer, integer)
TO schellingaf_api;

-- The seven-argument form, which the four- and five-argument wrappers call and the route
-- of the release before sends, becomes a wrapper over the eight, with the offer life the
-- routes send (TASK_LIMITS.checkOfferMinutes).
CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                      p_revision integer, p_deliveries boolean, p_attempts_max integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  RETURN task_done(p_space_name, p_actor, p_number, p_post, p_revision, p_deliveries, p_attempts_max, 30);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Upkeep
-- ─────────────────────────────────────────────────────────────────────────────

-- upkeep_due() as 0144_tasks.sql made it, with the lines marked B1, B2 and C: the review's
-- unchecked signal (S4) leaves out a held task, and counts no confirmation of a replaced
-- attempt, nor one whose KEY did a task in the task's independent_of.

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
       AND task_held(d) IS NULL  -- B1: the check of a held task waits, so nobody is late with it
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.verdict = 'confirm'
                          AND confirmation_stands(c.space_id, c.peer_id)  -- 0144: blocked confirmers
                          AND (cardinality(d.independent_of) = 0 OR task_doer(d, c.peer_id) IS NULL)  -- C
                          AND NOT EXISTS (SELECT 1 FROM task_attempts n  -- B2: a replaced attempt's
                                           WHERE n.task_id = c.task_id AND n.replaces = c.attempt));
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
-- The mirror, checked by the tests
-- ─────────────────────────────────────────────────────────────────────────────

-- task_mirror_faults() as 0141_task_claims.sql made it, with the lines marked B1 and B2: the
-- lowest pending attempt is one nothing replaced; a replacement is its own KEY's, of its own
-- cycle, never of a rejected attempt; and accept_after holds only on a done, held task.

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
                        WHERE c.task_id = a.task_id AND c.cycle = a.cycle AND c.attempt = a.attempt AND c.verdict = 'reject')
       AND NOT EXISTS (SELECT 1 FROM task_attempts n WHERE n.task_id = a.task_id AND n.replaces = a.attempt);  -- B2
    -- B2: an attempt replaces an earlier one of its own KEY in its own cycle, never a
    -- rejected one.
    IF EXISTS (SELECT 1 FROM task_attempts n JOIN task_attempts o ON o.task_id = n.task_id AND o.attempt = n.replaces
                WHERE n.task_id = t.task_id
                  AND (o.peer_id <> n.peer_id OR o.cycle <> n.cycle
                       OR EXISTS (SELECT 1 FROM task_checks c
                                   WHERE c.task_id = o.task_id AND c.attempt = o.attempt AND c.verdict = 'reject'))) THEN
      RETURN NEXT 'task ' || t.number || ': an attempt replaces another KEY''s, another cycle''s or a rejected one';
    END IF;
    -- B1: marked to be accepted after only while done, and only while held.
    IF t.accept_after AND (t.state <> 'done' OR task_held(t) IS NULL) THEN
      RETURN NEXT 'task ' || t.number || ': accept_after on a task that is not done and held';
    END IF;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- C: a task's independent_of, set where its after is
-- ─────────────────────────────────────────────────────────────────────────────

-- task_batch_shape() as 0132_task_retire_delete.sql made it, with the lines marked C: in a
-- batch, independent_of names an earlier task of the batch by its key, as after does.
CREATE OR REPLACE FUNCTION schellingaf.task_batch_shape(p_tasks jsonb, p_batch_max integer)
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
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i),  -- C
                           jsonb_array_elements(coalesce(e.t->'independent_of', '[]'::jsonb)) a(v)
              WHERE CASE WHEN a.v ? 'index' THEN NOT ((a.v->>'index')::int BETWEEN 0 AND e.i - 2)
                         ELSE NOT (a.v ? 'number' OR a.v ? 'task_id') END) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'independent_of names an earlier task of the batch by its key';
  END IF;
END $$;

-- insert_tasks() as 0132_task_retire_delete.sql made it, with the lines marked C:
-- independent_of is resolved as after is, each task's after first, and the first entry, in
-- the order sent, that names no task of this SPACE is TASK_AFTER_INVALID naming the entry;
-- then the first that names a task after may not (retired or deleted) or independent_of may
-- not (deleted, or upkeep, which has no attempt and so no doer), naming its state or
-- upkeep. A batch's detail names the field. No loop walk: it is no ordering.
CREATE OR REPLACE FUNCTION schellingaf.insert_tasks(p_space uuid, p_actor bytea, p_tasks jsonb, p_batch boolean,
                                                    p_not_accepted_max integer)
  RETURNS integer
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  n integer := jsonb_array_length(p_tasks); v_numbers integer[]; v_map jsonb; v_i bigint; v_key text;
  v_j bigint; v_val text; v_waiting bigint; v_done bigint; v_first integer; v_ids uuid[];
  v_field text;  -- C
BEGIN
  -- The numbers named, resolved once on the (space_id, number) index.
  SELECT coalesce(array_agg(DISTINCT (a.v->>'number')::int), '{}'::int[]) INTO v_numbers
    FROM jsonb_array_elements(p_tasks) e(t),
         jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)
                              || coalesce(e.t->'independent_of', '[]'::jsonb)) a(v)  -- C
   WHERE a.v ? 'number';
  SELECT coalesce(jsonb_object_agg(r.number::text, r.task_id), '{}'::jsonb) INTO v_map
    FROM tasks r WHERE r.space_id = p_space AND r.number = ANY (v_numbers);
  -- The first entry, in the order sent, that names no task of this SPACE.
  SELECT e.i, e.t->>'key', f.name, a.j, coalesce(a.v->>'number', a.v->>'task_id')
    INTO v_i, v_key, v_field, v_j, v_val
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i)
    CROSS JOIN (VALUES (1, 'after'), (2, 'independent_of')) f(ord, name)  -- C
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.t->f.name, '[]'::jsonb)) WITH ORDINALITY a(v, j)
   WHERE (a.v ? 'number' AND NOT (v_map ? (a.v->>'number')))
      OR (a.v ? 'task_id' AND NOT EXISTS (SELECT 1 FROM tasks x
                                          WHERE x.task_id = (a.v->>'task_id')::uuid AND x.space_id = p_space))
   ORDER BY e.i, f.ord, a.j
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = CASE WHEN p_batch
      THEN format('tasks[%s]%s: %s[%s] %s', v_i - 1, coalesce(' (' || v_key || ')', ''), v_field, v_j - 1, v_val)
      WHEN v_field = 'independent_of' THEN 'independent_of: ' || v_val  -- C: the detail for after stays bare
      ELSE v_val END;
  END IF;
  -- The first entry, in the order sent, that names a task it may not: in after a retired or
  -- deleted one, which is never waited for; C: in independent_of a deleted one, or an upkeep
  -- one, which nobody did.
  SELECT e.i, e.t->>'key', f.name, a.j,
         CASE WHEN f.ord = 2 AND x.state <> 'deleted' THEN 'upkeep' ELSE x.state END
    INTO v_i, v_key, v_field, v_j, v_val
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i)
    CROSS JOIN (VALUES (1, 'after'), (2, 'independent_of')) f(ord, name)  -- C
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.t->f.name, '[]'::jsonb)) WITH ORDINALITY a(v, j)
    JOIN tasks x
      ON x.space_id = p_space
     AND x.task_id = CASE WHEN a.v ? 'number' THEN (v_map->>(a.v->>'number'))::uuid
                          WHEN a.v ? 'task_id' THEN (a.v->>'task_id')::uuid END
   WHERE CASE WHEN f.ord = 1 THEN x.state IN ('retired', 'deleted')
              ELSE x.state = 'deleted' OR x.upkeep IS NOT NULL END
   ORDER BY e.i, f.ord, a.j
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = CASE WHEN p_batch
      THEN format('tasks[%s]%s: %s[%s] %s', v_i - 1, coalesce(' (' || v_key || ')', ''), v_field, v_j - 1, v_val)
      WHEN v_field = 'independent_of' THEN 'independent_of: ' || v_val  -- C: the detail for after stays bare
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
  INSERT INTO tasks (task_id, space_id, number, title, body, tag, waits_for, independent_of, created_by)
  SELECT v_ids[e.i::int], p_space, v_first + e.i::int - 1, e.t->>'title', coalesce(e.t->>'body', ''), e.t->>'tag',
         coalesce((SELECT array_agg(DISTINCT CASE
                                      WHEN a.v ? 'index'  THEN v_ids[(a.v->>'index')::int + 1]
                                      WHEN a.v ? 'number' THEN (v_map->>(a.v->>'number'))::uuid
                                      ELSE (a.v->>'task_id')::uuid END)
                     FROM jsonb_array_elements(coalesce(e.t->'after', '[]'::jsonb)) a(v)), '{}'::uuid[]),
         coalesce((SELECT array_agg(DISTINCT CASE  -- C
                                      WHEN a.v ? 'index'  THEN v_ids[(a.v->>'index')::int + 1]
                                      WHEN a.v ? 'number' THEN (v_map->>(a.v->>'number'))::uuid
                                      ELSE (a.v->>'task_id')::uuid END)
                     FROM jsonb_array_elements(coalesce(e.t->'independent_of', '[]'::jsonb)) a(v)), '{}'::uuid[]),
         p_actor
    FROM jsonb_array_elements(p_tasks) WITH ORDINALITY e(t, i);
  RETURN v_first;
END $$;

-- change_task() as 0141_task_claims.sql made it, with the lines marked C: independent_of
-- changes as after does, a revision with the words before kept in task_revisions. Its
-- entries resolve as an add's do; the task itself is refused as after refuses it (loop). A
-- coordinator or above may change it alone on a done or accepted task too.
CREATE OR REPLACE FUNCTION schellingaf.change_task(p_space_name text, p_actor bytea, p_number integer, p_revision integer,
                                                   p_reason text, p_change jsonb, p_revisions_max integer DEFAULT 50,
                                                   p_deliveries boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_after uuid[]; v_bad text; v_loop integer;
  v_holders bytea[]; v_delivered jsonb := '[]'::jsonb;
  v_independent uuid[];  -- C
BEGIN
  -- Shape, before anything is read. The route checked all of it; this holds what keeps
  -- the table sound whoever calls.
  IF p_revision IS NULL OR p_revision < 1 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'revision is the revision you read, a whole number from 1';
  END IF;
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'reason: say why you change the task, in 1 to 500 characters';
  END IF;
  IF jsonb_typeof(p_change) IS DISTINCT FROM 'object'
     OR NOT (p_change ?| ARRAY['title', 'body', 'tag', 'after', 'independent_of']) THEN  -- C
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'send at least one of title, body, tag, after and independent_of';
  END IF;
  IF (p_change ? 'title' AND jsonb_typeof(p_change->'title') IS DISTINCT FROM 'string')
     OR (p_change ? 'body' AND jsonb_typeof(p_change->'body') IS DISTINCT FROM 'string')
     OR (p_change ? 'after' AND (jsonb_typeof(p_change->'after') IS DISTINCT FROM 'array'
                                 OR jsonb_array_length(p_change->'after') > 8
                                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_change->'after') a(v)
                                             WHERE NOT (a.v ? 'number' OR a.v ? 'task_id')))) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'title and body are text; after is a list of up to 8 task numbers or task_ids';
  END IF;
  IF p_change ? 'independent_of' AND (jsonb_typeof(p_change->'independent_of') IS DISTINCT FROM 'array'  -- C
                                      OR jsonb_array_length(p_change->'independent_of') > 8
                                      OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_change->'independent_of') a(v)
                                                  WHERE NOT (a.v ? 'number' OR a.v ? 'task_id'))) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'independent_of is a list of up to 8 task numbers or task_ids';
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
  -- C: a coordinator or above may change independent_of alone on a done or accepted task,
  -- so a task can be cleared of a name that bars honest checkers; nothing else of it.
  IF t.state = 'retired'
     OR (t.state IN ('done', 'accepted')
         AND NOT (v_rank >= 25 AND NOT (p_change ?| ARRAY['title', 'body', 'tag', 'after']))) THEN
    RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state;  -- 0132: retired
  END IF;
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

  -- C: independent_of, resolved as an add resolves it: a task of this SPACE, never a deleted
  -- or an upkeep one, and never the task itself, which after refuses as a loop.
  IF p_change ? 'independent_of' THEN
    SELECT coalesce(a.v->>'number', a.v->>'task_id') INTO v_bad
      FROM jsonb_array_elements(p_change->'independent_of') WITH ORDINALITY a(v, j)
     WHERE NOT EXISTS (SELECT 1 FROM tasks x
                        WHERE x.space_id = s.space_id
                          AND CASE WHEN a.v ? 'number' THEN x.number = (a.v->>'number')::int
                                   ELSE x.task_id = (a.v->>'task_id')::uuid END)
     ORDER BY a.j
     LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = 'independent_of: ' || v_bad; END IF;
    SELECT 'independent_of: ' || CASE WHEN x.state = 'deleted' THEN 'deleted' WHEN x.upkeep IS NOT NULL THEN 'upkeep'
                                      ELSE x.number || ' is this task' END
      INTO v_bad
      FROM jsonb_array_elements(p_change->'independent_of') WITH ORDINALITY a(v, j), tasks x
     WHERE x.space_id = s.space_id
       AND CASE WHEN a.v ? 'number' THEN x.number = (a.v->>'number')::int
                ELSE x.task_id = (a.v->>'task_id')::uuid END
       AND (x.state = 'deleted' OR x.upkeep IS NOT NULL OR x.task_id = t.task_id)
     ORDER BY a.j
     LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = v_bad; END IF;
    SELECT coalesce(array_agg(DISTINCT x.task_id), '{}'::uuid[]) INTO v_independent
      FROM jsonb_array_elements(p_change->'independent_of') a(v)
      JOIN tasks x ON x.space_id = s.space_id
                  AND CASE WHEN a.v ? 'number' THEN x.number = (a.v->>'number')::int
                           ELSE x.task_id = (a.v->>'task_id')::uuid END;
  END IF;

  INSERT INTO task_revisions (task_id, space_id, revision, title, body, tag, waits_for, independent_of, ended_by, end_reason)
  VALUES (t.task_id, t.space_id, t.revision, t.title, t.body, t.tag, t.waits_for, t.independent_of, p_actor, p_reason);  -- C
  -- Every claim, live or passed and not taken since, stays with its holder, who is told
  -- (claims: every claimant).
  SELECT coalesce(array_agg(c.peer_id::bytea ORDER BY c.peer_id), '{}'::bytea[]) INTO v_holders
    FROM task_claims c WHERE c.task_id = t.task_id;
  UPDATE tasks k
     SET title = CASE WHEN p_change ? 'title' THEN p_change->>'title' ELSE k.title END,
         body = CASE WHEN p_change ? 'body' THEN p_change->>'body' ELSE k.body END,
         tag = CASE WHEN p_change ? 'tag' THEN p_change->>'tag' ELSE k.tag END,
         waits_for = CASE WHEN p_change ? 'after' THEN v_after ELSE k.waits_for END,
         independent_of = CASE WHEN p_change ? 'independent_of' THEN v_independent ELSE k.independent_of END,  -- C
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

-- delete_task() as 0140_task_attempts.sql made it, with the line marked C: independent_of is
-- erased with the other words. A task another's independent_of names may still be deleted:
-- a deletable task never had an attempt, so it named no doer.
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
  -- An attempt needs no take, and a task with a result on record is never erased.
  IF t.takes > 0 OR t.attempts > 0 THEN RAISE EXCEPTION 'TASK_TAKEN'; END IF;
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
         independent_of = '{}',  -- C
         closed_by = p_actor, closed_at = now(), close_reason = p_reason
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  DELETE FROM task_revisions r WHERE r.task_id = t.task_id;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[t.created_by::bytea], ARRAY['task_deleted']);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- retire_task() as 0141_task_claims.sql made it, with the lines marked C (R9): with
-- replacements, every open or claimed task whose independent_of names it names them too,
-- in the same revision as its after, past 8 TASK_AFTER_INVALID, and its claimants told
-- task_changed. The retired task stays named: its doers did what it audits. dependents
-- still names the tasks that waited for it.
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
  v_changed uuid[];  -- C: the dependents, and the tasks whose independent_of names it
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
  -- The open and claimed tasks that waited for it, and C: with replacements, those whose
  -- independent_of names it, locked in key order.
  SELECT coalesce(array_agg(d.task_id ORDER BY d.task_id), '{}'::uuid[]) INTO v_changed
    FROM (SELECT k.task_id FROM tasks k
           WHERE k.space_id = s.space_id AND k.state IN ('open', 'claimed')
             AND (t.task_id = ANY (k.waits_for) OR (cardinality(v_new) > 0 AND t.task_id = ANY (k.independent_of)))
           ORDER BY k.task_id
           FOR UPDATE) d;
  v_deps := ARRAY(SELECT k.task_id FROM tasks k
                   WHERE k.task_id = ANY (v_changed) AND t.task_id = ANY (k.waits_for) ORDER BY k.task_id);

  IF cardinality(v_changed) > 0 THEN  -- C
    SELECT d.number INTO v_number FROM tasks d
     WHERE d.task_id = ANY (v_changed) AND d.revision >= p_revisions_max  -- C
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
    -- C: the retired task stays in independent_of, since its doers did what it audits, and
    -- its replacements join it.
    SELECT d.number INTO v_number
      FROM tasks d
     WHERE d.task_id = ANY (v_changed) AND t.task_id = ANY (d.independent_of)
       AND cardinality(task_after_without(d.independent_of, NULL, v_new)) > 8
     ORDER BY d.number LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = 'independent_of would hold more than 8 tasks: task ' || v_number;
    END IF;

    INSERT INTO task_revisions (task_id, space_id, revision, title, body, tag, waits_for, independent_of, ended_by, end_reason)
    SELECT d.task_id, d.space_id, d.revision, d.title, d.body, d.tag, d.waits_for, d.independent_of, p_actor,  -- C
           'replaced: task ' || t.number || ' retired'
      FROM tasks d WHERE d.task_id = ANY (v_changed);
    UPDATE tasks d
       SET waits_for = CASE WHEN t.task_id = ANY (d.waits_for)
                            THEN task_after_without(d.waits_for, t.task_id, v_inherit || v_new) ELSE d.waits_for END,
           independent_of = CASE WHEN t.task_id = ANY (d.independent_of)  -- C
                                 THEN task_after_without(d.independent_of, NULL, v_new) ELSE d.independent_of END,
           revision = d.revision + 1
     WHERE d.task_id = ANY (v_changed);
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
      -- claims: every claimant of each task it changed (C: its independent_of too).
      SELECT c.peer_id::bytea, d.task_id, d.cycle, 'task_changed'
        FROM tasks d JOIN task_claims c ON c.task_id = d.task_id
       WHERE d.task_id = ANY (v_changed) AND d.state = 'claimed') q
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
-- A follow-up to 0146: which files an upload would need an authorization for
-- ─────────────────────────────────────────────────────────────────────────────

-- The token check both functions below make: the token is p_peer's own, neither revoked nor
-- expired. Answers its expiry. Internal: granted to nobody.
CREATE FUNCTION schellingaf.upload_token_expires(p_peer bytea, p_token bytea)
  RETURNS timestamptz
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_expires timestamptz;
BEGIN
  SELECT t.expires_at INTO v_expires FROM tokens t
   WHERE t.token_hash = p_token AND t.peer_id = p_peer AND t.revoked_at IS NULL AND t.expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'TOKEN_INVALID'; END IF;
  RETURN v_expires;
END $$;

-- What a file needs before p_peer may attach it in p_space: held, when it may already;
-- uploaded, when it uploaded it here with an authorization within the window and still may
-- not (bytes the operator erased); else needed, an authorization. Internal: granted to nobody.
CREATE FUNCTION schellingaf.file_upload_state(p_space uuid, p_peer bytea, p_sha256 bytea, p_pending_hours integer)
  RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE
           WHEN file_attachable(p_space, p_peer, p_sha256, p_pending_hours) THEN 'held'
           WHEN EXISTS (SELECT 1 FROM file_upload_grants g
                         WHERE g.space_id = p_space AND g.sha256 = p_sha256 AND g.peer_id = p_peer
                           AND g.uploaded AND g.used_at > now() - make_interval(hours => p_pending_hours)) THEN 'uploaded'
           ELSE 'needed' END
$$;
REVOKE EXECUTE ON FUNCTION
  schellingaf.upload_token_expires(bytea, bytea),
  schellingaf.file_upload_state(uuid, bytea, bytea, integer)
FROM PUBLIC;

-- grant_file_uploads() as 0146_exact_uploads.sql made it, its token check and each file's
-- state now the two functions above, which file_uploads_needed() shares.
CREATE OR REPLACE FUNCTION schellingaf.grant_file_uploads(
  p_space_name text, p_peer bytea, p_token bytea, p_hashes bytea[], p_grants bytea[],
  p_minutes integer, p_pending_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_space uuid; v_token_expires timestamptz; v_expires timestamptz; v_out jsonb[] := '{}';
  v_made integer := 0; v_state text;
BEGIN
  v_token_expires := upload_token_expires(p_peer, p_token);
  -- Blocks, the SPACE's state, the rank and sealing, as an upload meets them.
  v_space := check_file_upload(p_space_name, p_peer);
  v_expires := least(now() + make_interval(mins => p_minutes), v_token_expires);
  FOR i IN 1 .. coalesce(array_length(p_hashes, 1), 0) LOOP
    v_state := file_upload_state(v_space, p_peer, p_hashes[i], p_pending_hours);
    IF v_state = 'held' THEN
      v_out := v_out || jsonb_build_object('sha256', encode(p_hashes[i], 'hex'), 'held', true);
    ELSIF v_state = 'uploaded' THEN
      v_out := v_out || jsonb_build_object('sha256', encode(p_hashes[i], 'hex'), 'held', false, 'uploaded', true);
    ELSE
      INSERT INTO file_upload_grants (grant_hash, token_hash, peer_id, space_id, sha256, expires_at)
      VALUES (p_grants[i], p_token, p_peer, v_space, p_hashes[i], v_expires);
      v_made := v_made + 1;
      v_out := v_out || jsonb_build_object('sha256', encode(p_hashes[i], 'hex'), 'held', false, 'grant', i);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('made', v_made, 'expires_at', CASE WHEN v_made > 0 THEN v_expires END,
                            'uploads', to_jsonb(v_out));
END $$;

-- For each of p_hashes, whether grant_file_uploads() would make an authorization for it,
-- after the same token check (the token is p_peer's own, live) and the same refusals
-- (check_file_upload()), so it tells that KEY nothing more. Nothing is made, nothing is
-- spent. The connector asks it before it asks for authorizations, so a file it would refuse
-- to give a command for (one named like a secret) is refused before any is made.
CREATE FUNCTION schellingaf.file_uploads_needed(
  p_space_name text, p_peer bytea, p_token bytea, p_hashes bytea[], p_pending_hours integer)
  RETURNS boolean[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_space uuid;
BEGIN
  PERFORM upload_token_expires(p_peer, p_token);
  v_space := check_file_upload(p_space_name, p_peer);
  RETURN ARRAY(SELECT file_upload_state(v_space, p_peer, h.sha256, p_pending_hours) = 'needed'
                 FROM unnest(p_hashes) WITH ORDINALITY h(sha256, ord)
                ORDER BY h.ord);
END $$;
REVOKE EXECUTE ON FUNCTION schellingaf.file_uploads_needed(text, bytea, bytea, bytea[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.file_uploads_needed(text, bytea, bytea, bytea[], integer) TO schellingaf_api;
