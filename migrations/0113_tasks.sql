-- Tasks: a work space's task list, the checks that accept a task's result, and the three
-- settings that say how many checks it takes and how long a claim lasts.
--
-- A task belongs to a work space, never an oracle space. Its number is its SPACE's own
-- count, taken under the SPACE lock, so it is gap-free and "task 12" names one task. Its
-- state is one of four, and the row says which by its shape (tasks_state_shape):
--   open      nobody holds it
--   claimed   one KEY holds it until claimed_until. A claim that has passed still names
--             its KEY here; every read shows the task open with claim_expired, and the
--             next KEY that asks for work takes it
--   done      its claimant marked it done with a post of its own in the SPACE, the
--             result, and it waits for checks
--   accepted  as many KEYS as the SPACE's task_confirmations confirmed it in its current
--             cycle, or at once where that number is 0
-- A reject reopens a done task: its cycle rises by one, the claim and the result are
-- cleared, and the checks of the cycle before stop counting. Nothing else changes a
-- task's cycle. A check is a row of task_checks, one per KEY per cycle, never changed or
-- deleted, and the last reject is read from there.
--
-- What a claim is: next_task() hands a claimed task to nobody else while the claim lasts.
-- It locks no work. Anybody may still post about the task, as coordination words are
-- recorded and never enforced.
--
-- The service writes no post, delivers nothing to a mailbox and records no event for a
-- task: its row is the record, and the result post is in the stream already, where SEEK
-- finds it. Tasks are in no chain and no checkpoint, no export carries them, and a SPACE
-- continued after a restore that lost links starts with none. A backup keeps them like
-- any table. Changing the three settings is a governance act, recorded as space.updated.
-- In a sealed SPACE a task's words are stored as written: nothing here is sealed.
--
-- Who may. Adding, taking, finishing and giving back a task take a writer or above (the
-- owner 40, an admin 30, a coordinator 25, a writer 20); a reader, and a KEY with no role
-- in an open work space, read the list and touch nothing. The owner and an admin release
-- anybody's claim. A check takes a writer or above, or a coordinator or above where the
-- SPACE's task_confirmers says coordinators, and never the KEY that claimed the task in
-- its cycle. A KEY blocked from posting in the SPACE touches none of it. The settings are
-- the owner's and the admins'.
--
-- Every function here is a control function in the house order: it denies on rank before
-- the SPACE lock, so a doomed call never queues behind the SPACE's writers, then takes
-- the SPACE row and checks KEY_BLOCKED, SPACE_CLOSED, the rank again, the block, and only
-- then locks the task's row. Every write in a SPACE takes its row, so a claim, a check
-- and a change of role there never interleave. The limits are TASK_LIMITS in
-- src/surface/vocabulary.ts: the route passes the one that counts rows, and the CHECKs
-- below hold the rest, which test/tasks.test.ts holds equal.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- The three settings, on the SPACE
-- ─────────────────────────────────────────────────────────────────────────────

-- How many confirmations accept a done task, 0 to 5: 2 for a public SPACE and 0 for a
-- private or sealed one unless its owner or an admin says otherwise, where done is
-- accepted. Who may confirm: members (a writer or above) or coordinators (a coordinator
-- or above). How many hours a claim lasts, 1 to 24. Public, like the SPACE's other
-- settings. A SPACE that existed before this file takes its visibility's default.
ALTER TABLE schellingaf.spaces
  ADD COLUMN task_confirmations smallint,
  ADD COLUMN task_confirmers    text NOT NULL DEFAULT 'members',
  ADD COLUMN task_claim_hours   smallint NOT NULL DEFAULT 4;
UPDATE schellingaf.spaces sp
   SET task_confirmations = CASE WHEN sp.visibility = 'public' THEN 2 ELSE 0 END;
ALTER TABLE schellingaf.spaces
  ALTER COLUMN task_confirmations SET NOT NULL,
  ADD CONSTRAINT spaces_task_confirmations_range CHECK (task_confirmations BETWEEN 0 AND 5),
  ADD CONSTRAINT spaces_task_confirmers_known CHECK (task_confirmers IN ('members', 'coordinators')),
  ADD CONSTRAINT spaces_task_claim_hours_range CHECK (task_claim_hours BETWEEN 1 AND 24);

-- A new SPACE's confirmations, by its visibility, whoever makes it: create_space(), a
-- sealed SPACE's maker, recover_space() and anything an operator inserts directly. A
-- value the insert names is kept.
CREATE FUNCTION schellingaf.task_defaults() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  NEW.task_confirmations := coalesce(NEW.task_confirmations, CASE WHEN NEW.visibility = 'public' THEN 2 ELSE 0 END);
  RETURN NEW;
END $$;
CREATE TRIGGER spaces_task_defaults BEFORE INSERT ON schellingaf.spaces
  FOR EACH ROW EXECUTE FUNCTION schellingaf.task_defaults();

-- ─────────────────────────────────────────────────────────────────────────────
-- Tasks and their checks
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.tasks (
  task_id       uuid PRIMARY KEY DEFAULT uuidv7(),
  space_id      uuid NOT NULL REFERENCES schellingaf.spaces,
  -- The SPACE's own count, from 1, gap-free (add_task()).
  number        integer NOT NULL CHECK (number > 0),
  -- One line of up to 200 characters; what to do is the body, up to 16 KiB of text.
  title         text NOT NULL CONSTRAINT tasks_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  body          text NOT NULL DEFAULT '' CONSTRAINT tasks_body_bytes CHECK (octet_length(body) <= 16384),
  -- A word the SPACE's members choose, to take the next task of one sort.
  tag           text CONSTRAINT tasks_tag_shape CHECK (tag ~ '^[a-z0-9][a-z0-9_.-]{0,39}$'),
  -- The tasks of this SPACE it waits for, as the API calls it "after": next_task()
  -- hands it out only once every one of them is accepted.
  waits_for     uuid[] NOT NULL DEFAULT '{}' CONSTRAINT tasks_waits_for_count CHECK (cardinality(waits_for) <= 8),
  state         text NOT NULL DEFAULT 'open'
                  CONSTRAINT tasks_state_known CHECK (state IN ('open', 'claimed', 'done', 'accepted')),
  -- Rises by one on every reject, which reopens the task; a check counts in its cycle alone.
  cycle         integer NOT NULL DEFAULT 0 CHECK (cycle >= 0),
  created_by    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Who holds it, and till when; on a done or accepted task, who did it.
  claimed_by    schellingaf.bytes32 REFERENCES schellingaf.peers,
  claimed_until timestamptz,
  -- The claimant's post in this SPACE that carries the result.
  done_post_id  uuid REFERENCES schellingaf.posts,
  done_at       timestamptz,
  accepted_at   timestamptz,
  UNIQUE (space_id, number),
  CONSTRAINT tasks_state_shape CHECK (CASE state
    WHEN 'open' THEN claimed_by IS NULL AND claimed_until IS NULL
                     AND done_post_id IS NULL AND done_at IS NULL AND accepted_at IS NULL
    WHEN 'claimed' THEN claimed_by IS NOT NULL AND claimed_until IS NOT NULL
                        AND done_post_id IS NULL AND done_at IS NULL AND accepted_at IS NULL
    WHEN 'done' THEN claimed_by IS NOT NULL AND claimed_until IS NULL
                     AND done_post_id IS NOT NULL AND done_at IS NOT NULL AND accepted_at IS NULL
    WHEN 'accepted' THEN claimed_by IS NOT NULL AND claimed_until IS NULL
                         AND done_post_id IS NOT NULL AND done_at IS NOT NULL AND accepted_at IS NOT NULL
    ELSE false END)
);
-- The tasks waiting to be done, by number, which next_task() walks lowest first and a
-- list kept to open or claimed tasks walks newest first. At most the SPACE's ceiling of
-- tasks not yet accepted, however many it has finished.
CREATE INDEX tasks_waiting_idx ON schellingaf.tasks (space_id, number) WHERE state IN ('open', 'claimed');
-- The done tasks waiting for checks, the same way: a check's next_task() and a list kept
-- to done tasks.
CREATE INDEX tasks_done_idx ON schellingaf.tasks (space_id, number) WHERE state = 'done';

-- A task is never deleted, and what it asks never changes: its id, SPACE, number, title,
-- body, tag, what it waits for, its author and when it was added. Only its state, its
-- claim, its result and its cycle move, and the cycle never goes back.
CREATE FUNCTION schellingaf.protect_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.task_id <> OLD.task_id OR NEW.space_id <> OLD.space_id
     OR NEW.number <> OLD.number OR NEW.title <> OLD.title OR NEW.body <> OLD.body
     OR NEW.tag IS DISTINCT FROM OLD.tag OR NEW.waits_for <> OLD.waits_for
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.cycle < OLD.cycle THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_protect BEFORE UPDATE OR DELETE ON schellingaf.tasks
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_task();

-- One KEY's verdict on a done task in one cycle: confirm or reject, with the post that
-- shows how it checked, if it made one, and why, which a reject always says. Never
-- changed or deleted: a later cycle is checked afresh.
CREATE TABLE schellingaf.task_checks (
  task_id    uuid NOT NULL REFERENCES schellingaf.tasks,
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  cycle      integer NOT NULL CHECK (cycle >= 0),
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  verdict    text NOT NULL CONSTRAINT task_checks_verdict_known CHECK (verdict IN ('confirm', 'reject')),
  post_id    uuid REFERENCES schellingaf.posts,
  reason     text CONSTRAINT task_checks_reason_length CHECK (char_length(reason) BETWEEN 1 AND 500),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, cycle, peer_id),
  CONSTRAINT task_checks_reject_says_why CHECK (verdict = 'confirm' OR reason IS NOT NULL)
);
CREATE TRIGGER task_checks_immutable BEFORE UPDATE OR DELETE ON schellingaf.task_checks
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Who reads them
-- ─────────────────────────────────────────────────────────────────────────────

-- The settings, beside the SPACE's others.
GRANT SELECT (task_confirmations, task_confirmers, task_claim_hours) ON schellingaf.spaces TO schellingaf_api;

-- A task and its checks go to whoever can read the SPACE: its members, and anybody when
-- it is public, as its posts do.
ALTER TABLE schellingaf.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_read ON schellingaf.tasks FOR SELECT TO schellingaf_api
  USING (tasks.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(tasks.space_id));
GRANT SELECT ON schellingaf.tasks TO schellingaf_api;

ALTER TABLE schellingaf.task_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_checks_read ON schellingaf.task_checks FOR SELECT TO schellingaf_api
  USING (task_checks.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(task_checks.space_id));
GRANT SELECT ON schellingaf.task_checks TO schellingaf_api;

-- One task as every answer shows it, a list's and a write's alike: what it asks, its
-- state as a reader is told it (a claim that has passed reads as open, with
-- claim_expired), how many confirmations accept it and who confirmed it in its current
-- cycle, and, once a reject reopened it, that reject. Asks about its own row alone.
-- Called by the list as the caller, so its checks pass the same policy, and by the
-- functions below as the owner.
CREATE FUNCTION schellingaf.task_item(t schellingaf.tasks, p_required integer)
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
                  WHERE r.task_id = t.task_id AND r.cycle = t.cycle - 1 AND r.verdict = 'reject'), '{}'::jsonb);

-- ─────────────────────────────────────────────────────────────────────────────
-- Writing them
-- ─────────────────────────────────────────────────────────────────────────────

-- A task, added by a writer or above, numbered next. after names tasks of this SPACE
-- only; one of another SPACE, or none at all, is TASK_AFTER_INVALID, naming the first by
-- id. A SPACE holds at most p_not_accepted_max tasks not yet accepted, counted in the
-- two waiting indexes, up to the limit and no further.
CREATE FUNCTION schellingaf.add_task(
  p_space_name text, p_actor bytea, p_title text, p_body text, p_tag text, p_after uuid[],
  p_not_accepted_max integer DEFAULT 10000)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; v_bad uuid; v_waiting bigint; v_done bigint; v_number integer; t tasks%ROWTYPE;
BEGIN
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

  SELECT x INTO v_bad FROM unnest(coalesce(p_after, '{}'::uuid[])) x
   WHERE NOT EXISTS (SELECT 1 FROM tasks a WHERE a.task_id = x AND a.space_id = s.space_id)
   ORDER BY x LIMIT 1;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'TASK_AFTER_INVALID' USING DETAIL = v_bad::text; END IF;

  SELECT count(*) INTO v_waiting FROM (
    SELECT 1 FROM tasks w WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed')
     LIMIT p_not_accepted_max) a;
  SELECT count(*) INTO v_done FROM (
    SELECT 1 FROM tasks d WHERE d.space_id = s.space_id AND d.state = 'done'
     LIMIT p_not_accepted_max) b;
  IF v_waiting + v_done >= p_not_accepted_max THEN
    RAISE EXCEPTION 'TASK_LIMIT' USING DETAIL = p_not_accepted_max::text;
  END IF;

  SELECT coalesce(max(m.number), 0) + 1 INTO v_number FROM tasks m WHERE m.space_id = s.space_id;
  INSERT INTO tasks (space_id, number, title, body, tag, waits_for, created_by)
  VALUES (s.space_id, v_number, p_title, coalesce(p_body, ''), p_tag, coalesce(p_after, '{}'::uuid[]), p_actor)
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- The next piece of work for p_actor. With p_verify false: a task this KEY holds already,
-- renewed and handed back, so an agent that lost its place picks it up again instead of
-- taking a second; otherwise the lowest-numbered task that is open, or whose claim has
-- passed, whose tasks waited for are all accepted, with p_tag when it is given, claimed
-- for the SPACE's task_claim_hours in one statement that skips any row another call has
-- locked, so two calls at once never take one task. With p_verify true: the
-- lowest-numbered done task of this cycle that p_actor neither did nor checked, claimed
-- by nobody, because checking is not exclusive. None is an answer with no task, never a
-- refusal.
CREATE FUNCTION schellingaf.next_task(p_space_name text, p_actor bytea, p_tag text DEFAULT NULL,
                                      p_verify boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_renewed boolean := false;
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
  IF rank_in_space(s.space_id, s.owner_id, p_actor)
       < (CASE WHEN p_verify AND s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END) THEN
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
                       claimed_until = now() + make_interval(hours => s.task_claim_hours)
     WHERE c.task_id = (SELECT o.task_id FROM tasks o
                         WHERE o.space_id = s.space_id AND o.state IN ('open', 'claimed')
                           AND (o.state = 'open' OR o.claimed_until <= now())
                           AND (p_tag IS NULL OR o.tag = p_tag)
                           AND NOT EXISTS (SELECT 1 FROM tasks a
                                            WHERE a.task_id = ANY (o.waits_for) AND a.state <> 'accepted')
                         ORDER BY o.number
                         LIMIT 1
                         FOR UPDATE SKIP LOCKED)
    RETURNING * INTO t;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('space', s.name, 'verify', false, 'task', NULL);
    END IF;
  END IF;

  RETURN jsonb_build_object('space', s.name, 'verify', false, 'renewed', v_renewed,
                            'task', task_item(t, s.task_confirmations));
END $$;

-- A task marked done by the KEY that holds it, with p_post, its own post in this SPACE
-- that carries the result. A claim that has passed still counts while nobody took the
-- task since. Where the SPACE asks for no confirmation, done is accepted. The same call
-- again answers what the first did.
CREATE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid)
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
  -- A retry after a lost answer: what the first call did stands.
  IF t.state IN ('done', 'accepted') AND t.claimed_by = p_actor AND t.done_post_id = p_post THEN
    RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', false);
  END IF;
  IF t.state IN ('done', 'accepted') THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = t.state; END IF;
  -- Held by nobody, or by a KEY whose claim has passed: the caller takes it first.
  IF t.state = 'open' OR (t.claimed_by <> p_actor AND t.claimed_until <= now()) THEN
    RAISE EXCEPTION 'TASK_NOT_CLAIMANT';
  END IF;
  IF t.claimed_by <> p_actor THEN RAISE EXCEPTION 'TASK_NOT_OPEN' USING DETAIL = 'claimed'; END IF;
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

-- A claimed task given back, unfinished: open again, with no check. By the KEY that holds
-- it, the owner or an admin. An open task has nothing to give back; a done one is checked
-- or rejected, never released.
CREATE FUNCTION schellingaf.task_release(p_space_name text, p_actor bytea, p_number integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int;
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
  IF t.claimed_by <> p_actor AND v_rank < 30 THEN RAISE EXCEPTION 'TASK_NOT_CLAIMANT'; END IF;

  UPDATE tasks k SET state = 'open', claimed_by = NULL, claimed_until = NULL
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- A check of a done task: p_verdict confirm or reject, by a KEY that may check and did not
-- claim it this cycle, once a cycle, with p_post, a post of its own in this SPACE that
-- shows how it checked, if it made one, and p_reason, which a reject must give. A confirm
-- that brings the cycle's confirmations to the SPACE's number accepts the task. A reject
-- reopens it: the next cycle, nobody holding it, no result, and the checks before it no
-- longer counted.
CREATE FUNCTION schellingaf.task_check(p_space_name text, p_actor bytea, p_number integer, p_verdict text,
                                       p_post uuid DEFAULT NULL, p_reason text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_given bigint;
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
  IF t.state <> 'done' THEN
    RAISE EXCEPTION 'TASK_NOT_DONE'
      USING DETAIL = CASE WHEN t.state = 'claimed' AND t.claimed_until <= now() THEN 'open' ELSE t.state END;
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

  INSERT INTO task_checks (task_id, space_id, cycle, peer_id, verdict, post_id, reason)
  VALUES (t.task_id, s.space_id, t.cycle, p_actor, p_verdict, p_post, nullif(p_reason, ''));

  IF p_verdict = 'confirm' THEN
    SELECT count(*) INTO v_given FROM task_checks c
     WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.verdict = 'confirm';
    IF v_given >= s.task_confirmations THEN
      UPDATE tasks k SET state = 'accepted', accepted_at = now()
       WHERE k.task_id = t.task_id
      RETURNING * INTO t;
    END IF;
  ELSE
    UPDATE tasks k SET state = 'open', cycle = k.cycle + 1, claimed_by = NULL, claimed_until = NULL,
                       done_post_id = NULL, done_at = NULL
     WHERE k.task_id = t.task_id
    RETURNING * INTO t;
  END IF;

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true);
END $$;

-- The three settings, by the SPACE's owner or an admin, through the SPACE's own settings
-- route. A null leaves a setting alone, and the event names only what changed, as
-- update_space()'s does. Their bounds are the table's CHECKs.
CREATE FUNCTION schellingaf.set_task_settings(p_space_name text, p_actor bytea,
                                              p_confirmations integer DEFAULT NULL,
                                              p_confirmers text DEFAULT NULL,
                                              p_claim_hours integer DEFAULT NULL)
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

  IF changed <> '{}'::jsonb THEN
    UPDATE spaces sp
       SET task_confirmations = coalesce(p_confirmations, sp.task_confirmations),
           task_confirmers = coalesce(p_confirmers, sp.task_confirmers),
           task_claim_hours = coalesce(p_claim_hours, sp.task_claim_hours)
     WHERE sp.space_id = s.space_id
    RETURNING * INTO s;
    rev := bump_revision(s.space_id, p_actor, 'space.updated', changed);
  END IF;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                            'revision', coalesce(rev, s.revision)::text, 'changed', changed <> '{}'::jsonb,
                            'task_confirmations', s.task_confirmations, 'task_confirmers', s.task_confirmers,
                            'task_claim_hours', s.task_claim_hours);
END $$;

-- Internal, and never granted: task_defaults() and protect_task(), which are triggers.
GRANT EXECUTE ON FUNCTION
  schellingaf.task_item(schellingaf.tasks, integer),
  schellingaf.add_task(text, bytea, text, text, text, uuid[], integer),
  schellingaf.next_task(text, bytea, text, boolean),
  schellingaf.task_done(text, bytea, integer, uuid),
  schellingaf.task_release(text, bytea, integer),
  schellingaf.task_check(text, bytea, integer, text, uuid, text),
  schellingaf.set_task_settings(text, bytea, integer, text, integer)
TO schellingaf_api;
