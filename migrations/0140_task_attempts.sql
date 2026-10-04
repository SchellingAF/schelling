-- Attempts: any writer marks a task done, and each done is a numbered attempt.
--
-- Until this file a task had one holder, and only the holder finished it, with its own
-- post. A crashed agent's claim held the task until it lapsed, a second key's done was
-- refused (TASK_NOT_OPEN claimed, or TASK_POST_NOT_FOUND for another key's post), and a
-- reject cleared every confirmation without saying which (proposal-task-claim-rule, slice
-- A; its specification is the run's 10-spec-final.md, sections 1.1, 1.3, 2.1, 2.2, 2.3,
-- 2.6 and 2.7). Now:
--
--   task_attempts  one row an attempt: the task, its number (tasks.attempts counts them,
--                  gap-free under the row lock, across cycles), its cycle, the KEY that
--                  submitted it, the post that carries the result and that post's author.
--                  Append-only; read as task_checks is.
--   done           any writer, holding the task or not, with a post in this SPACE: its
--                  own, or another KEY's that is neither hidden nor withheld. At most
--                  p_attempts_max (5) a cycle, one a KEY a cycle, never by a KEY that
--                  checked in the cycle, never with a post a reject already named as this
--                  task's result. The first of a cycle ends the claim and makes the task
--                  done; it is accepted at once only where task_confirmations is 0 and it
--                  is uncontested: cycle 0, no other KEY's live claim, and the caller not
--                  under its own give-back lock. A later one joins the done task.
--   checks         per attempt: task_checks.attempt, one check a KEY an attempt. A KEY with
--                  an attempt in a cycle, or that wrote an attempt's post, checks none of
--                  that cycle, but where task_confirmations is 0 it may confirm (concede
--                  to) another KEY's attempt. The first attempt whose confirmations reach
--                  greatest(task_confirmations, 1) is accepted. A reject sets its attempt
--                  aside; the task reopens only when no other attempt waits.
--   the offer      task_check_offers.attempt, the attempt next offered; a check with no
--                  cycle and no attempt reads the caller's live offer. A check of an
--                  earlier cycle is the late check, refused TASK_NOT_DONE naming the
--                  rejecter, its notice delivered once.
--   the row        mirrors the attempt of record: the lowest pending attempt, or the
--                  accepted one. claimed_by is its submitter, done_post_id its post, and
--                  done_at the cycle's first attempt's time, which never moves on a reject.
--                  task_mirror_faults(), for the tests only, says where a SPACE's rows and
--                  attempts disagree.
--   the mailbox    task_attempt, to the holder whose claim an attempt ended, the
--                  submitters of the other pending attempts and the post's author; every
--                  delivery about an attempt keeps it in mailbox_deliveries.task_attempt.
--
-- Upkeep tasks keep their one holder and today's done word for word: no attempt row, ever
-- (tasks_attempts_not_upkeep). It comes after 0139_peer_names.sql.

-- ─────────────────────────────────────────────────────────────────────────────
-- The record of attempts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.task_attempts (
  task_id   uuid NOT NULL REFERENCES schellingaf.tasks,
  space_id  uuid NOT NULL REFERENCES schellingaf.spaces,
  attempt   integer NOT NULL CHECK (attempt >= 1),
  cycle     integer NOT NULL CHECK (cycle >= 0),
  -- Who submitted it, which may not be who wrote its post.
  peer_id   schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  post_id   uuid NOT NULL REFERENCES schellingaf.posts,
  -- The post's author, copied at insert, so next learns who wrote it without a probe of posts.
  author_id schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, attempt),
  UNIQUE (task_id, cycle, peer_id),
  UNIQUE (task_id, cycle, post_id)
);
-- From a post to the attempts that name it: a finding that is attempt 2's post.
CREATE INDEX task_attempts_post_idx ON schellingaf.task_attempts (post_id);
CREATE TRIGGER task_attempts_immutable BEFORE UPDATE OR DELETE ON schellingaf.task_attempts
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();
ALTER TABLE schellingaf.task_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_attempts_read ON schellingaf.task_attempts FOR SELECT TO schellingaf_api
  USING (task_attempts.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(task_attempts.space_id));
GRANT SELECT ON schellingaf.task_attempts TO schellingaf_api;

ALTER TABLE schellingaf.tasks
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN attempt integer,
  ADD CONSTRAINT tasks_attempt_range CHECK (attempt IS NULL OR attempt BETWEEN 1 AND attempts),
  ADD CONSTRAINT tasks_attempts_not_upkeep CHECK (upkeep IS NULL OR attempts = 0);

-- One check a KEY an attempt. A check of an earlier cycle made before this file keeps
-- attempt null, and stays one a KEY a cycle by NULLS NOT DISTINCT.
ALTER TABLE schellingaf.task_checks
  ADD COLUMN attempt integer CONSTRAINT task_checks_attempt_check CHECK (attempt >= 1);
ALTER TABLE schellingaf.task_checks DROP CONSTRAINT task_checks_pkey;
ALTER TABLE schellingaf.task_checks
  ADD CONSTRAINT task_checks_attempt_key UNIQUE NULLS NOT DISTINCT (task_id, cycle, peer_id, attempt);

-- The attempt next offered a KEY to check; null on an offer made before this file.
ALTER TABLE schellingaf.task_check_offers ADD COLUMN attempt integer;

-- The attempt a task's notice is about. A separate check, so mailbox_deliveries_one_subject
-- stays as it is. NOT VALID then VALIDATE in one transaction saves no lock: ADD COLUMN holds
-- the table's ACCESS EXCLUSIVE lock to commit anyway, which is brief at today's size.
ALTER TABLE schellingaf.mailbox_deliveries ADD COLUMN task_attempt integer;
ALTER TABLE schellingaf.mailbox_deliveries
  ADD CONSTRAINT mailbox_deliveries_task_attempt CHECK (task_attempt IS NULL OR task_id IS NOT NULL) NOT VALID;
ALTER TABLE schellingaf.mailbox_deliveries VALIDATE CONSTRAINT mailbox_deliveries_task_attempt;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: every result already on record is attempt 1
-- ─────────────────────────────────────────────────────────────────────────────

-- A task done, accepted or retired after done, and not upkeep, gets attempt 1: its cycle,
-- its holder, its result post and that post's author, at done_at. Its checks of the
-- current cycle judged that attempt. Rejects of earlier cycles keep attempt null: the
-- result they judged was cleared. Upkeep rows keep done_post_id and get no attempt.
INSERT INTO schellingaf.task_attempts (task_id, space_id, attempt, cycle, peer_id, post_id, author_id, at)
SELECT t.task_id, t.space_id, 1, t.cycle, t.claimed_by, t.done_post_id, p.author_id, t.done_at
  FROM schellingaf.tasks t JOIN schellingaf.posts p ON p.post_id = t.done_post_id
 WHERE t.upkeep IS NULL AND t.state IN ('done', 'accepted', 'retired') AND t.done_post_id IS NOT NULL;
UPDATE schellingaf.tasks t SET attempts = 1, attempt = 1
 WHERE t.upkeep IS NULL AND t.state IN ('done', 'accepted', 'retired') AND t.done_post_id IS NOT NULL;
ALTER TABLE schellingaf.task_checks DISABLE TRIGGER task_checks_immutable;
UPDATE schellingaf.task_checks c SET attempt = 1
  FROM schellingaf.tasks t
 WHERE t.task_id = c.task_id AND t.cycle = c.cycle AND t.upkeep IS NULL
   AND t.state IN ('done', 'accepted', 'retired') AND t.done_post_id IS NOT NULL;
ALTER TABLE schellingaf.task_checks ENABLE TRIGGER task_checks_immutable;

-- ─────────────────────────────────────────────────────────────────────────────
-- What a task may never do, and the one projection of a task
-- ─────────────────────────────────────────────────────────────────────────────

-- What a task may never do, as 0134_task_upkeep.sql listed it, with its attempts: the count
-- of attempts never falls.
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
  RETURN NEW;
END $$;

-- One task as every answer shows it, as 0134_task_upkeep.sql made it, with attempts:
-- confirmations.given counts the attempt of record's alone, and required is at least one
-- while the task is done; rejected, the latest reject of the cycle before, names the
-- result it judged and the confirmations it cleared, and its attempt where that cycle
-- held two or more; attempt and attempts show only while the current cycle holds two or
-- more, each attempt with its state: pending, rejected, accepted or passed.
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
        'required', CASE WHEN t.state = 'done' THEN greatest(p_required, 1) ELSE p_required END,
        'given', (SELECT coalesce(jsonb_agg(encode(c.peer_id, 'hex') ORDER BY c.checked_at, c.peer_id), '[]'::jsonb)
                    FROM schellingaf.task_checks c
                   WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.verdict = 'confirm'
                     AND c.attempt IS NOT DISTINCT FROM t.attempt)))
    || CASE WHEN t.state = 'claimed' AND t.claimed_until <= now()
            THEN jsonb_build_object('claim_expired', true) ELSE '{}'::jsonb END
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
-- Notices about an attempt
-- ─────────────────────────────────────────────────────────────────────────────

-- deliver_notices() as 0137_contested_findings.sql made it, with p_attempt, the attempt a
-- task's notices are about, kept in task_attempt on each task row; null for a notice about
-- no attempt and on every post row. Internal, granted to nobody; a call with seven
-- arguments still finds it.
DROP FUNCTION schellingaf.deliver_notices(uuid, bytea, uuid, integer, bytea[], text[], uuid[]);
CREATE FUNCTION schellingaf.deliver_notices(p_space uuid, p_actor bytea, p_task uuid, p_cycle integer,
                                            p_peers bytea[], p_reasons text[], p_posts uuid[],
                                            p_attempt integer DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_peers bytea[]; v_reasons text[]; v_posts uuid[]; held bytea[]; delivered jsonb := '[]';
BEGIN
  SELECT coalesce(array_agg(u.peer ORDER BY u.peer, u.i), '{}'),
         coalesce(array_agg(u.reason ORDER BY u.peer, u.i), '{}'),
         coalesce(array_agg(u.post ORDER BY u.peer, u.i), '{}')
    INTO v_peers, v_reasons, v_posts
    FROM (SELECT DISTINCT ON (x.peer, coalesce(x.post, '00000000-0000-0000-0000-000000000000'::uuid), x.reason) x.*
            FROM unnest(p_peers, p_reasons, p_posts) WITH ORDINALITY AS x(peer, reason, post, i)
           ORDER BY x.peer, coalesce(x.post, '00000000-0000-0000-0000-000000000000'::uuid), x.reason, x.i) u
    JOIN spaces sp ON sp.space_id = p_space
   WHERE u.peer IS NOT NULL AND u.peer <> p_actor
     AND (sp.visibility = 'public' OR u.peer = sp.owner_id
          OR EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = p_space AND mm.peer_id = u.peer))
     AND EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.peer_id = u.peer)
     AND (u.post IS NULL OR NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                                         WHERE md.recipient_id = u.peer AND md.post_id = u.post));
  IF cardinality(v_peers) = 0 THEN RETURN delivered; END IF;
  SELECT coalesce(array_agg(l.peer), '{}') INTO held
    FROM (SELECT mb.peer_id::bytea AS peer FROM mailboxes mb
           WHERE mb.peer_id = ANY(v_peers) ORDER BY mb.peer_id FOR UPDATE) l;
  WITH wanted AS (
    SELECT u.peer, u.reason, u.post, row_number() OVER (PARTITION BY u.peer ORDER BY u.i) AS k
      FROM unnest(v_peers, v_reasons, v_posts) WITH ORDINALITY AS u(peer, reason, post, i)
  ), bumped AS (
    UPDATE mailboxes mb SET last_seq = mb.last_seq + x.c
      FROM (SELECT wt.peer, count(*) AS c FROM wanted wt GROUP BY wt.peer) x
     WHERE mb.peer_id = x.peer
    RETURNING mb.peer_id::bytea AS peer, mb.last_seq - x.c AS base
  ), made AS (
    INSERT INTO mailbox_deliveries AS dl (recipient_id, mailbox_seq, post_id, task_id, task_cycle, actor_id, space_id, reason,
                                          task_attempt)
    SELECT wt.peer, b.base + wt.k, wt.post,
           CASE WHEN wt.post IS NULL THEN p_task END, CASE WHEN wt.post IS NULL THEN p_cycle END,
           CASE WHEN wt.post IS NULL THEN p_actor END, p_space, wt.reason,
           CASE WHEN wt.post IS NULL THEN p_attempt END  -- attempts
      FROM wanted wt JOIN bumped b ON b.peer = wt.peer
    RETURNING dl.recipient_id::bytea AS recipient, dl.mailbox_seq, dl.reason
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('recipient', encode(made.recipient, 'hex'),
                                               'mailbox_seq', made.mailbox_seq::text, 'reason', made.reason)
                            ORDER BY made.recipient, made.mailbox_seq), '[]') INTO delivered FROM made;
  RETURN delivered;
END $$;

-- deliver_task_notices() as 0137_contested_findings.sql made it, a wrapper of
-- deliver_notices(), passing p_attempt on. Internal, granted to nobody: the task functions
-- call it, and a call with six arguments still finds it.
DROP FUNCTION schellingaf.deliver_task_notices(uuid, uuid, integer, bytea, bytea[], text[]);
CREATE FUNCTION schellingaf.deliver_task_notices(p_space uuid, p_task uuid, p_cycle integer, p_actor bytea,
                                                 p_peers bytea[], p_reasons text[], p_attempt integer DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  RETURN deliver_notices(p_space, p_actor, p_task, p_cycle, p_peers, p_reasons,
                         array_fill(NULL::uuid, ARRAY[cardinality(p_peers)]), p_attempt);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Done: an attempt
-- ─────────────────────────────────────────────────────────────────────────────

-- task_done() as 0134_task_upkeep.sql made it, its five-argument form, for an upkeep task
-- word for word; for any other task, an attempt, in this order after the task row:
-- deleted; the same KEY's same post again in the cycle (changed false); accepted or
-- retired; the caller's own attempt in the cycle; the caller's check in the cycle; the
-- cycle's limit; an after not yet accepted, for a KEY that does not hold the task; the
-- revision; the post, and whether a reject named it, an attempt of the cycle names it or
-- its author checked in the cycle. p_deliveries answers what it delivered, as task_check()
-- does; p_attempts_max is TASK_LIMITS.attempts. No argument has a default: the five- and
-- four-argument forms stay, as wrappers sending false and 5.
CREATE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                      p_revision integer, p_deliveries boolean, p_attempts_max integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_version text; v_accept boolean; v_rank int; v_holder boolean;
        v_author bytea; v_n integer; v_count integer; v_waiting integer; v_ended bytea; v_contested boolean;
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
  -- The holder: the KEY whose claim, live or passed, is on the row.
  v_holder := t.state = 'claimed' AND t.claimed_by = p_actor;
  IF t.state IN ('open', 'claimed') AND NOT v_holder THEN
    SELECT a.number INTO v_waiting FROM tasks a
     WHERE a.task_id = ANY (t.waits_for) AND a.state NOT IN ('accepted', 'retired')
     ORDER BY a.number LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'TASK_WAITING' USING DETAIL = v_waiting::text; END IF;
  END IF;
  -- The words changed after the holder took them, or after the revision a KEY sent.
  IF (p_revision IS NOT NULL AND p_revision <> t.revision)
     OR (v_holder AND p_revision IS NULL AND t.claim_revision < t.revision) THEN
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
    v_ended := CASE WHEN t.state = 'claimed' AND t.claimed_by <> p_actor THEN t.claimed_by END;
    v_contested := t.cycle > 0
                   OR (t.state = 'claimed' AND t.claimed_by <> p_actor AND t.claimed_until > now())
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

  -- Told, one notice a KEY, never the caller: the holder whose claim this ended, the
  -- submitters of the other pending attempts, and the post's author.
  SELECT coalesce(array_agg(q.peer ORDER BY q.peer), '{}'::bytea[]) INTO v_peers
    FROM (SELECT v_ended AS peer
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

-- As the release before called it: no deliveries answered, and TASK_LIMITS.attempts.
CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid,
                                                 p_revision integer)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.task_done(p_space_name, p_actor, p_number, p_post, p_revision, false, 5);

CREATE OR REPLACE FUNCTION schellingaf.task_done(p_space_name text, p_actor bytea, p_number integer, p_post uuid)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN schellingaf.task_done(p_space_name, p_actor, p_number, p_post, NULL::integer, false, 5);

-- ─────────────────────────────────────────────────────────────────────────────
-- A check of one attempt
-- ─────────────────────────────────────────────────────────────────────────────

-- task_check() as 0137_contested_findings.sql made it, checking one attempt, its contested
-- notice kept in the per-attempt reject. After the task row:
-- the caller's live offer for this task, read here with p_actor, since a write sets no
-- caller; the cycle checked, p_cycle or the offer's or the task's, never above the task's;
-- a cycle below the task's is the late check, as is an attempt of an earlier cycle; the
-- attempt, p_attempt or the offer's or the one pending, and a rejected one refused naming
-- its rejecter; the doer, who checks none of the cycle, but where the SPACE asks for no
-- confirmation may confirm another KEY's attempt; one check a KEY an attempt. A confirm
-- that brings its attempt's confirmations to greatest(task_confirmations, 1) accepts the
-- task with it; a reject sets the attempt aside and moves the attempt of record, or, with
-- none left pending, reopens the task as before. A late or rejected check through the
-- route is answered, with the reject's notice once and the caller's offer dropped.
DROP FUNCTION schellingaf.task_check(text, bytea, integer, text, uuid, text, boolean);
CREATE FUNCTION schellingaf.task_check(p_space_name text, p_actor bytea, p_number integer, p_verdict text,
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
    SELECT count(*) INTO v_given FROM task_checks c
     WHERE c.task_id = t.task_id AND c.cycle = t.cycle AND c.attempt = a.attempt AND c.verdict = 'confirm';
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

-- The caller's live offer for a task, for the dry run of a POST's check, which reads as the
-- caller: its cycle and attempt, or no row. task_check_offers stays granted to nobody.
CREATE FUNCTION schellingaf.task_offer_of_caller(p_task uuid, p_offer_minutes integer)
  RETURNS TABLE (cycle integer, attempt integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT o.cycle, o.attempt FROM schellingaf.task_check_offers o
   WHERE o.task_id = p_task AND o.peer_id = schellingaf.caller_id()
     AND o.offered_at > now() - make_interval(mins => p_offer_minutes)
   ORDER BY o.offered_at DESC LIMIT 1
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Retire and delete, with attempts
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0134_task_upkeep.sql made it, with one refusal more: a task with an attempt is
-- TASK_TAKEN, taken or not.
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
         closed_by = p_actor, closed_at = now(), close_reason = p_reason
   WHERE k.task_id = t.task_id
  RETURNING * INTO t;
  DELETE FROM task_revisions r WHERE r.task_id = t.task_id;
  v_delivered := deliver_task_notices(s.space_id, t.task_id, t.cycle, p_actor, ARRAY[t.created_by::bytea], ARRAY['task_deleted']);

  RETURN jsonb_build_object('space', s.name, 'task', task_item(t, s.task_confirmations), 'changed', true)
         || CASE WHEN p_deliveries THEN jsonb_build_object('delivered', v_delivered) ELSE '{}'::jsonb END;
END $$;

-- As 0134_task_upkeep.sql made it, with one condition more: below a coordinator, the KEY
-- that added a task changes it only while nobody took it and nobody made an attempt at it,
-- as delete_task() refuses a task with an attempt.
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

-- As 0134_task_upkeep.sql made it, telling more KEYS when a done task is retired: the
-- submitter of every pending attempt, and the KEYS that confirmed one, one notice a KEY.
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

-- ─────────────────────────────────────────────────────────────────────────────
-- next, checking one attempt
-- ─────────────────────────────────────────────────────────────────────────────

-- next_job() as 0138_document_decision.sql made it, its twelve-argument form, its three
-- version check (0138) blocks kept exactly, with the lines
-- marked attempts changed: steps 2 and 6 and job check hand out a done task with a
-- pending attempt the caller has not checked and whose post it did not write, when the
-- caller made no attempt in the cycle; the offer cap counts the confirmations of the
-- pending attempt with the most; the offer names the lowest attempt the caller may
-- check; and with two or more pending, why is check_attempts and the answer adds attempt.
CREATE OR REPLACE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,
                                     p_words jsonb, p_held_max integer, p_check_first_minutes integer,
                                     p_offer_minutes integer, p_not_accepted_max integer,
                                     p_document_gap_hours integer, p_review_gap_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_check_rank int; v_checks boolean;
        v_job text; v_case text; v_values jsonb := '{}'; v_renewed boolean := false; v_out jsonb;
        v_kind text; v_due jsonb; v_full boolean; u task_upkeep%ROWTYPE;
        v_attempt integer; v_waiting integer;
        v_version schellingaf.oracle_versions%ROWTYPE;  -- 0138
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
         || CASE WHEN v_renewed AND t.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', t.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END
         || CASE WHEN v_attempt IS NOT NULL THEN jsonb_build_object('attempt', v_attempt) ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The mirror, checked by the tests
-- ─────────────────────────────────────────────────────────────────────────────

-- One line for each task of a SPACE whose row disagrees with its attempts; none when all
-- agree. Granted to nobody: the tests call it as the owner after every case, so a write
-- that forgets the mirror fails there, and nothing runs it live.
CREATE FUNCTION schellingaf.task_mirror_faults(p_space uuid)
  RETURNS SETOF text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE t tasks%ROWTYPE; v_rows integer; v_top integer; v_record task_attempts%ROWTYPE; v_first timestamptz;
        v_pending integer;
BEGIN
  FOR t IN SELECT * FROM tasks k WHERE k.space_id = p_space ORDER BY k.number LOOP
    SELECT count(*), coalesce(max(a.attempt), 0) INTO v_rows, v_top FROM task_attempts a WHERE a.task_id = t.task_id;
    IF t.upkeep IS NOT NULL THEN
      IF t.attempts <> 0 OR v_rows <> 0 OR t.attempt IS NOT NULL THEN
        RETURN NEXT 'task ' || t.number || ': an upkeep task has attempts';
      END IF;
      CONTINUE;
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
  schellingaf.task_done(text, bytea, integer, uuid, integer, boolean, integer),
  schellingaf.task_check(text, bytea, integer, text, uuid, text, boolean, integer, integer, integer),
  schellingaf.task_offer_of_caller(uuid, integer)
TO schellingaf_api;
