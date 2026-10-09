-- The real bill. From billing_epoch.real_from, a UTC day after the day this file runs and
-- never sooner than six hours, each SPACE over the free allowance of its visibility is
-- billed once a day from its payer's balance: one transaction a SPACE and day, a
-- space_bills row and the ledger entry bill:<space_id>:<day> through credit_post(). Days
-- before real_from stay shadow rows, as 0150 wrote them.
--
-- The rates are SQL constants, billing_rates(), never parameters the api role passes, so
-- an api role that calls the bill can only bill an ended, unbilled day at the constant
-- rate: what the job does. FUNDING in src/surface/vocabulary.ts holds the same numbers,
-- and a test holds them equal.
--
-- The payer is the end of a SPACE's replaced_by chain (funding_credited_space()). Each
-- SPACE of a chain is measured alone, with its own allowance and free days; the bill row
-- is the measured SPACE's, the ledger entry and any notice the payer's. Not billed: a
-- SPACE the operator closed (closed with no replaced_by), a withheld SPACE, and a SPACE
-- whose payer is either.
--
-- A bill that cannot take its whole due freezes the payer's credit row; credit_post()
-- clears it in the deposit's own transaction once the balance pays one day, and
-- credit_sweep(), each tick, once anything else (hidden posts, free days) brings the day's
-- due under the balance. Notices go to the payer's owner and first admins, once a crossing:
-- low (7 days or fewer of credit) and read_only (a bill fell short), kept in
-- space_credit.notice. The mailbox reason is funding.
--
-- billing_epoch.mode is the off switch: shadow makes every later day a shadow row. The
-- service writes it at boot from BILLING (src/config.ts, src/server.ts).

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- In the order a POST takes them: the SPACE row, then projection rows, then mailboxes. 1.5 s
-- at most, under the api role's 2 s, as 0148 waits; a timeout fails the deploy, and the
-- next one tries again.
SET LOCAL lock_timeout = '1500ms';
LOCK TABLE schellingaf.spaces IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE schellingaf.space_credit, schellingaf.space_bills, schellingaf.mailbox_deliveries IN ACCESS EXCLUSIVE MODE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables and columns
-- ─────────────────────────────────────────────────────────────────────────────

-- The first day billed for real: the UTC date six hours from p_at, plus one. So a file run
-- at 17:59 UTC bills from the next day, and one run at 18:00 or later from the day after:
-- billing never goes live minutes after a deploy near midnight.
CREATE FUNCTION schellingaf.billing_first_day(p_at timestamptz) RETURNS date
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT ((p_at AT TIME ZONE 'UTC') + interval '6 hours')::date + 1
$$;

-- One row. The owner role may update it: the tests, the dry run and the runbook. The api
-- role reaches it only through the functions below.
CREATE TABLE schellingaf.billing_epoch (
  one       boolean PRIMARY KEY DEFAULT true CHECK (one),
  real_from date NOT NULL,
  mode      text NOT NULL DEFAULT 'real' CHECK (mode IN ('real', 'shadow')),
  mode_at   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schellingaf.billing_epoch (real_from) VALUES (schellingaf.billing_first_day(now()));
ALTER TABLE schellingaf.billing_epoch ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_epoch_none ON schellingaf.billing_epoch FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.billing_epoch FROM schellingaf_api;

-- frozen: a bill could not take its whole due. free_until: the first day this SPACE's own
-- bytes are billed, set once below for the SPACES that exist now. notice: the last notice
-- delivered, so each is delivered once a crossing.
ALTER TABLE schellingaf.space_credit
  ADD COLUMN frozen       boolean NOT NULL DEFAULT false,
  ADD COLUMN frozen_since timestamptz,
  ADD COLUMN free_until   date,
  ADD COLUMN notice       text NOT NULL DEFAULT 'none' CHECK (notice IN ('none', 'low', 'read_only')),
  ADD CONSTRAINT space_credit_frozen_since CHECK (frozen = (frozen_since IS NOT NULL));
-- What credit_sweep() walks: the rows with something to clear.
CREATE INDEX space_credit_flagged_idx ON schellingaf.space_credit (space_id) WHERE frozen OR notice <> 'none';

-- Release 1's rows are all shadow, with task_bytes 0, free false and payer_id NULL, so every
-- new CHECK holds on them. The immutability trigger does not fire on DDL.
ALTER TABLE schellingaf.space_bills
  ADD COLUMN task_bytes bigint NOT NULL DEFAULT 0 CHECK (task_bytes >= 0),
  ADD COLUMN free       boolean NOT NULL DEFAULT false,
  ADD COLUMN payer_id   uuid REFERENCES schellingaf.spaces,
  DROP CONSTRAINT space_bills_over,
  ADD CONSTRAINT space_bills_over CHECK (post_bytes + file_bytes + task_bytes > allowance_bytes),
  ADD CONSTRAINT space_bills_free CHECK (NOT free OR (taken_micro = 0 AND NOT shadow)),
  ADD CONSTRAINT space_bills_payer CHECK (shadow = (payer_id IS NULL));
CREATE INDEX space_bills_payer_idx ON schellingaf.space_bills (payer_id, day) WHERE NOT shadow;

-- A SPACE's predecessors, walked backwards from its payer. Small, and the lock is held.
CREATE INDEX spaces_replaced_by_idx ON schellingaf.spaces (replaced_by) WHERE replaced_by IS NOT NULL;

-- A funding notice: which crossing, and the day billed. NOT VALID, so nothing is scanned
-- under this file's lock; 0156 validates both outside a transaction.
ALTER TABLE schellingaf.mailbox_deliveries
  ADD COLUMN credit_notice text,
  ADD COLUMN credit_day    date,
  ADD CONSTRAINT mailbox_deliveries_credit_notice CHECK (credit_notice IN ('low', 'read_only')) NOT VALID,
  DROP CONSTRAINT mailbox_deliveries_one_subject,
  ADD CONSTRAINT mailbox_deliveries_one_subject CHECK (
    num_nonnulls(post_id, request_id, message_id, invite_id, task_id, credit_notice) = 1
    AND ((space_id IS NOT NULL) = (message_id IS NULL))
    AND ((task_id IS NULL) = (task_cycle IS NULL))
    AND ((task_id IS NULL) = (actor_id IS NULL))
    AND ((credit_notice IS NULL) = (credit_day IS NULL))) NOT VALID;

-- ─────────────────────────────────────────────────────────────────────────────
-- Constants and measures
-- ─────────────────────────────────────────────────────────────────────────────

-- The one place in SQL: $5 per GB-month in micro-dollars, a day a thirtieth, a GB 10^9
-- bytes, and the free allowance of each visibility in bytes.
CREATE FUNCTION schellingaf.billing_rates()
  RETURNS TABLE (micro_usd_per_gb_month bigint, days_per_month integer, bytes_per_gb bigint,
                 public_bytes bigint, private_bytes bigint, sealed_bytes bigint)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT 5000000::bigint, 30, 1000000000::bigint, 25000000::bigint, 10000000::bigint, 1000000::bigint
$$;

CREATE FUNCTION schellingaf.space_allowance(p_visibility text) RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE p_visibility WHEN 'public' THEN r.public_bytes WHEN 'private' THEN r.private_bytes ELSE r.sealed_bytes END
    FROM billing_rates() r
$$;

-- A day's due in micro-dollars, rounded down: the bytes over the allowance at a thirtieth
-- of the monthly rate. dailyMicroUsd() in TypeScript makes the same sum.
CREATE FUNCTION schellingaf.day_due_micro(p_bytes bigint, p_allowance bigint) RETURNS bigint
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT floor(greatest(0, p_bytes - p_allowance)::numeric * r.micro_usd_per_gb_month
               / (r.days_per_month::numeric * r.bytes_per_gb))::bigint
    FROM billing_rates() r
$$;

-- What a SPACE stores now, from its three counters, 0 for a missing row. Unlocked reads.
CREATE FUNCTION schellingaf.space_billable_bytes(p_space uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce((SELECT t.post_bytes + t.task_bytes FROM space_storage t WHERE t.space_id = p_space), 0)
       + coalesce((SELECT f.attached_bytes FROM space_file_totals f WHERE f.space_id = p_space), 0)
$$;

-- The one now() that names a day: today in UTC. The job still passes every day it bills.
CREATE FUNCTION schellingaf.billing_today() RETURNS date
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT (now() AT TIME ZONE 'UTC')::date
$$;

-- How a day is billed: shadow while the switch says so or before real_from, else real.
CREATE FUNCTION schellingaf.billing_day_mode(p_day date) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE WHEN e.mode = 'shadow' OR p_day < e.real_from THEN 'shadow' ELSE 'real' END
    FROM billing_epoch e
$$;

-- Whether billing is live now: the switch on real, and real_from begun.
CREATE FUNCTION schellingaf.billing_live() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT e.mode = 'real' AND billing_today() >= e.real_from FROM billing_epoch e
$$;

-- Whether a SPACE is billed: not when it, or its payer, was closed by the operator (closed
-- with no replaced_by) or is withheld.
CREATE FUNCTION schellingaf.space_billed(p_space uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH p AS (SELECT funding_credited_space(p_space) AS payer)
  SELECT NOT EXISTS (SELECT 1 FROM spaces s, p
                      WHERE (s.space_id = p_space OR s.space_id = p.payer)
                        AND s.status = 'closed' AND s.replaced_by IS NULL)
     AND NOT EXISTS (SELECT 1 FROM withheld_spaces w, p
                      WHERE (w.space_id = p_space OR w.space_id = p.payer) AND w.released_at IS NULL)
$$;

-- A SPACE's own due for a day, with p_add bytes more: 0 when it is not billed or the day is
-- one of its free days.
CREATE FUNCTION schellingaf.space_day_due(p_space uuid, p_add bigint, p_day date) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE
           WHEN NOT space_billed(p_space) THEN 0
           WHEN p_day < (SELECT c.free_until FROM space_credit c WHERE c.space_id = p_space) THEN 0
           ELSE day_due_micro(space_billable_bytes(p_space) + p_add,
                              space_allowance((SELECT s.visibility FROM spaces s WHERE s.space_id = p_space)))
         END
$$;

-- What a payer pays a day: its own due, with p_add bytes more, and the due of every SPACE
-- whose replaced_by chain ends at it, walked backwards at most 16 steps, as
-- funding_credited_space() walks forwards. A SPACE with no predecessor costs one probe.
CREATE FUNCTION schellingaf.space_daily_due(p_payer uuid, p_add bigint, p_day date) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH RECURSIVE chain (space_id, depth) AS (
    SELECT x.space_id, 1 FROM spaces x WHERE x.replaced_by = p_payer
    UNION ALL
    SELECT x.space_id, c.depth + 1 FROM chain c JOIN spaces x ON x.replaced_by = c.space_id WHERE c.depth < 16
  )
  SELECT space_day_due(p_payer, p_add, p_day)
       + coalesce((SELECT sum(space_day_due(c.space_id, 0, p_day)) FROM chain c), 0)::bigint
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The switch
-- ─────────────────────────────────────────────────────────────────────────────

-- Sets the mode, real or shadow, and answers it with real_from. Written by the service at
-- boot from BILLING. An api role that calls it can only take less or enforce less than the
-- constants allow, or as much as they allow; never more.
CREATE FUNCTION schellingaf.billing_set_mode(p_mode text) RETURNS TABLE (mode text, real_from date)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('real', 'shadow') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'billing mode is real or shadow';
  END IF;
  UPDATE billing_epoch e SET mode = p_mode, mode_at = now() WHERE e.one AND e.mode <> p_mode;
  RETURN QUERY SELECT e.mode, e.real_from FROM billing_epoch e;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Notices
-- ─────────────────────────────────────────────────────────────────────────────

-- A funding notice to a payer's owner and its first admins, the recipients a join request
-- reaches (0106): ascending peer id, mailboxes last, each when its mailbox exists. Answers
-- [{recipient, mailbox_seq}] for the job to wake.
CREATE FUNCTION schellingaf.deliver_funding_notice(p_space uuid, p_day date, p_notice text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  r bytea; m bigint; v_delivered jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT u.x FROM (
      SELECT sp.owner_id::bytea AS x FROM spaces sp WHERE sp.space_id = p_space
      UNION
      SELECT a.peer_id::bytea FROM (
        SELECT mm.peer_id FROM memberships mm
         WHERE mm.space_id = p_space AND mm.role = 'admin'
         ORDER BY mm.granted_at, mm.peer_id
         LIMIT cap('request_notices')) a) u
     ORDER BY u.x
  LOOP
    UPDATE mailboxes mb SET last_seq = mb.last_seq + 1 WHERE mb.peer_id = r RETURNING mb.last_seq INTO m;
    IF FOUND THEN
      INSERT INTO mailbox_deliveries (recipient_id, mailbox_seq, space_id, reason, credit_notice, credit_day)
      VALUES (r, m, p_space, 'funding', p_notice, p_day);
      v_delivered := v_delivered || jsonb_build_object('recipient', encode(r, 'hex'), 'mailbox_seq', m::text);
    END IF;
  END LOOP;
  RETURN v_delivered;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The bill
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION schellingaf.bill_candidates(date, uuid, int, bigint, bigint, bigint);
DROP FUNCTION schellingaf.bill_space_day(uuid, date, bigint, bigint, bigint, bigint, int, bigint, boolean);
DROP FUNCTION schellingaf.billing_summary(date, bigint, bigint, bigint, bigint[]);

-- The SPACES over the allowance of their visibility, made before the day ended and not yet
-- billed for it, by space_id after the cursor, at most a thousand a call. SPACES not billed
-- (closed by the operator, withheld) are listed too: their bill answers closed, which the
-- day's line counts. The missing bound is the lowest uuid, taken with the cursor's own
-- test, as checkpoints_due() writes it.
CREATE FUNCTION schellingaf.bill_candidates(p_day date, p_after uuid, p_limit int) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(array_agg(x.space_id ORDER BY x.space_id), '{}'::uuid[])
    FROM (SELECT s.space_id
            FROM spaces s
            LEFT JOIN space_storage t ON t.space_id = s.space_id
            LEFT JOIN space_file_totals f ON f.space_id = s.space_id
           WHERE s.space_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
             AND s.space_id IS DISTINCT FROM p_after
             AND s.created_at < (p_day + 1)::timestamp AT TIME ZONE 'UTC'
             AND coalesce(t.post_bytes, 0) + coalesce(t.task_bytes, 0) + coalesce(f.attached_bytes, 0)
                 > space_allowance(s.visibility)
             AND NOT EXISTS (SELECT 1 FROM space_bills b WHERE b.space_id = s.space_id AND b.day = p_day)
           ORDER BY s.space_id
           LIMIT least(p_limit, 1000)) x
$$;

-- One SPACE's bill for one ended day, its own transaction. Answers its state and the
-- deliveries it made:
--   young    the SPACE was made after the day ended
--   closed   not billed (space_billed())
--   fault    the payer's balance disagrees with its ledger
--   under    at or under its allowance
--   already  the day has its row
--   shadow   a shadow row, nothing taken
--   free     one of its free days: the due recorded, nothing taken
--   short    real, and the balance could not pay the whole due: the payer is frozen
--   billed   real, the whole due taken
-- The payer's credit row is locked before the balance is read, so a rerun and a deposit
-- both wait here; the primary key and the ledger key each make a rerun write nothing. Then
-- mailboxes, in ascending peer id. The counters are read without a lock: a reading a
-- moment either side of a post is the same day's measure.
CREATE FUNCTION schellingaf.bill_space_day(p_space uuid, p_day date) RETURNS TABLE (state text, delivered jsonb)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_visibility text; v_created timestamptz; v_mode text; v_payer uuid;
  v_balance bigint := 0; v_frozen boolean := false; v_notice text := 'none';
  v_posts bigint; v_files bigint; v_tasks bigint; v_allowance bigint;
  v_due bigint; v_free_until date; v_free boolean; v_taken bigint; v_after bigint; v_daily bigint;
BEGIN
  delivered := '[]'::jsonb;
  IF p_day >= billing_today() THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'the day has not ended';
  END IF;
  SELECT s.visibility, s.created_at INTO v_visibility, v_created FROM spaces s WHERE s.space_id = p_space;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF v_created >= (p_day + 1)::timestamp AT TIME ZONE 'UTC' THEN
    state := 'young'; RETURN NEXT; RETURN;
  END IF;
  v_mode := billing_day_mode(p_day);
  v_payer := funding_credited_space(p_space);
  IF NOT space_billed(p_space) THEN
    state := 'closed'; RETURN NEXT; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM credit_faults cf WHERE cf.space_id = v_payer) THEN
    state := 'fault'; RETURN NEXT; RETURN;
  END IF;
  IF v_mode = 'real' THEN
    INSERT INTO space_credit (space_id) VALUES (v_payer) ON CONFLICT (space_id) DO NOTHING;
    SELECT c.balance_micro, c.frozen, c.notice INTO v_balance, v_frozen, v_notice
      FROM space_credit c WHERE c.space_id = v_payer FOR UPDATE;
  END IF;

  SELECT coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0),
         coalesce((SELECT f.attached_bytes FROM space_file_totals f WHERE f.space_id = p_space), 0),
         coalesce((SELECT t.task_bytes FROM space_storage t WHERE t.space_id = p_space), 0)
    INTO v_posts, v_files, v_tasks;
  v_allowance := space_allowance(v_visibility);
  IF v_posts + v_files + v_tasks <= v_allowance THEN
    state := 'under'; RETURN NEXT; RETURN;
  END IF;
  v_due := day_due_micro(v_posts + v_files + v_tasks, v_allowance);
  SELECT c.free_until INTO v_free_until FROM space_credit c WHERE c.space_id = p_space;
  v_free := v_mode = 'real' AND v_free_until IS NOT NULL AND p_day < v_free_until;
  v_taken := CASE WHEN v_mode = 'real' AND NOT v_free THEN least(v_due, v_balance) ELSE 0 END;

  INSERT INTO space_bills (space_id, day, post_bytes, file_bytes, task_bytes, allowance_bytes, micro_usd_per_gb_month,
                           days_per_month, bytes_per_gb, due_micro, taken_micro, shadow, free, payer_id)
  SELECT p_space, p_day, v_posts, v_files, v_tasks, v_allowance, r.micro_usd_per_gb_month,
         r.days_per_month, r.bytes_per_gb, v_due, v_taken, v_mode = 'shadow', v_free,
         CASE WHEN v_mode = 'real' THEN v_payer END
    FROM billing_rates() r
  ON CONFLICT (space_id, day) DO NOTHING;
  IF NOT FOUND THEN
    state := 'already'; RETURN NEXT; RETURN;
  END IF;
  IF v_mode = 'shadow' THEN
    state := 'shadow'; RETURN NEXT; RETURN;
  END IF;
  IF v_free THEN
    state := 'free'; RETURN NEXT; RETURN;
  END IF;

  -- A bill of 0 writes no ledger entry: the ledger refuses an amount of 0 for a bill. The
  -- key names the measured SPACE, so a payer pays its own and a predecessor's bill of one
  -- day under two keys.
  IF v_taken > 0 THEN
    PERFORM credit_post(v_payer, 'bill', -v_taken, 'bill:' || p_space::text || ':' || to_char(p_day, 'YYYY-MM-DD'), '');
  END IF;
  v_after := v_balance - v_taken;

  IF v_taken < v_due THEN
    UPDATE space_credit c
       SET frozen = true, frozen_since = coalesce(c.frozen_since, now()), notice = 'read_only'
     WHERE c.space_id = v_payer;
    IF v_notice <> 'read_only' THEN
      delivered := deliver_funding_notice(v_payer, p_day, 'read_only');
    END IF;
    state := 'short'; RETURN NEXT; RETURN;
  END IF;

  v_daily := space_daily_due(v_payer, 0, billing_today());
  IF v_daily > 0 AND v_after / v_daily <= 7 AND v_notice = 'none' AND NOT v_frozen THEN
    UPDATE space_credit c SET notice = 'low' WHERE c.space_id = v_payer;
    delivered := deliver_funding_notice(v_payer, p_day, 'low');
  ELSIF v_notice = 'low' AND (v_daily = 0 OR v_after / v_daily > 7) THEN
    UPDATE space_credit c SET notice = 'none' WHERE c.space_id = v_payer;
  END IF;
  state := 'billed';
  RETURN NEXT;
END $$;

-- What a day measured and billed, by visibility: every SPACE of it, the bytes its three
-- counters hold now, together and the largest, how many SPACES hold more than each size in
-- p_sizes (spaces_over, keyed by the size); from the day's bill rows how many were over, by
-- how many bytes, what was due and taken, how many were free days and how many fell short;
-- and how many SPACES are read-only now. One statement; no SPACE's name or id leaves it.
CREATE FUNCTION schellingaf.billing_summary(p_day date, p_sizes bigint[]) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH kinds (visibility) AS (
    VALUES ('public'), ('private'), ('sealed')
  ),
  measured AS (
    SELECT s.visibility,
           coalesce(t.post_bytes, 0) + coalesce(t.task_bytes, 0) + coalesce(f.attached_bytes, 0) AS bytes
      FROM spaces s
      LEFT JOIN space_storage t ON t.space_id = s.space_id
      LEFT JOIN space_file_totals f ON f.space_id = s.space_id
  ),
  sizes AS (
    SELECT m.visibility, z.size, count(*) FILTER (WHERE m.bytes > z.size) AS spaces
      FROM measured m CROSS JOIN unnest(p_sizes) AS z(size)
     GROUP BY m.visibility, z.size
  ),
  live AS (
    SELECT m.visibility, count(*) AS spaces, sum(m.bytes) AS billable, max(m.bytes) AS largest
      FROM measured m
     GROUP BY m.visibility
  ),
  billed AS (
    SELECT s.visibility, count(*) AS over,
           sum(b.post_bytes + b.file_bytes + b.task_bytes - b.allowance_bytes) AS over_bytes,
           sum(b.due_micro) AS due, sum(b.taken_micro) AS taken,
           count(*) FILTER (WHERE b.free) AS free,
           count(*) FILTER (WHERE NOT b.shadow AND NOT b.free AND b.taken_micro < b.due_micro) AS short
      FROM space_bills b JOIN spaces s ON s.space_id = b.space_id
     WHERE b.day = p_day
     GROUP BY s.visibility
  ),
  frozen AS (
    SELECT s.visibility, count(*) AS spaces
      FROM space_credit c JOIN spaces s ON s.space_id = c.space_id
     WHERE c.frozen
     GROUP BY s.visibility
  )
  SELECT jsonb_object_agg(k.visibility, jsonb_build_object(
           'allowance_bytes', space_allowance(k.visibility),
           'spaces', coalesce(l.spaces, 0),
           'over', coalesce(b.over, 0),
           'billable_bytes', coalesce(l.billable, 0),
           'max_billable_bytes', coalesce(l.largest, 0),
           'spaces_over', coalesce((SELECT jsonb_object_agg(z.size::text, coalesce(o.spaces, 0))
                                      FROM unnest(p_sizes) AS z(size)
                                      LEFT JOIN sizes o ON o.visibility = k.visibility AND o.size = z.size), '{}'::jsonb),
           'over_bytes', coalesce(b.over_bytes, 0),
           'due_micro_usd', coalesce(b.due, 0),
           'taken_micro_usd', coalesce(b.taken, 0),
           'free', coalesce(b.free, 0),
           'short', coalesce(b.short, 0),
           'read_only', coalesce(fz.spaces, 0)))
    FROM kinds k
    LEFT JOIN live l ON l.visibility = k.visibility
    LEFT JOIN billed b ON b.visibility = k.visibility
    LEFT JOIN frozen fz ON fz.visibility = k.visibility
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A deposit unfreezes, and the sweep
-- ─────────────────────────────────────────────────────────────────────────────

-- 0149's body, unchanged up to the balance update. After a posting written, not replayed,
-- that adds to the balance, in the same transaction and under the row lock it holds: the
-- frozen flag clears once the balance pays one day of what the SPACE costs now, and the
-- notice is reset once more than 7 days are paid. Leaving read-only with 7 days or fewer
-- sets low without a delivery: whoever deposited knows.
CREATE OR REPLACE FUNCTION schellingaf.credit_post(p_space uuid, p_kind text, p_amount_micro bigint, p_key text, p_note text DEFAULT '')
  RETURNS TABLE (entry_id bigint, balance_after_micro bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_balance bigint; v_after bigint; v_id bigint;
  v_space uuid; v_kind text; v_amount bigint; v_was_after bigint; v_daily bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = p_space) THEN
    RAISE EXCEPTION 'SPACE_NOT_FOUND';
  END IF;
  INSERT INTO space_credit (space_id) VALUES (p_space) ON CONFLICT (space_id) DO NOTHING;
  SELECT c.balance_micro INTO v_balance FROM space_credit c WHERE c.space_id = p_space FOR UPDATE;
  -- Twice at most: the key as the lock found it, then as the insert found it.
  FOR v_try IN 1..2 LOOP
    SELECT l.entry_id, l.space_id, l.kind, l.amount_micro, l.balance_after_micro
      INTO v_id, v_space, v_kind, v_amount, v_was_after
      FROM credit_ledger l WHERE l.idempotency_key = p_key;
    IF FOUND THEN
      IF v_space = p_space AND v_kind = p_kind AND v_amount = p_amount_micro THEN
        entry_id := v_id; balance_after_micro := v_was_after; replayed := true;
        RETURN NEXT;
        RETURN;
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
    END IF;
    -- A guard, unreachable under READ COMMITTED. The insert writes nothing only after the
    -- posting that held the key commits, and this read then finds that row; a rollback of
    -- that posting lets the insert through instead.
    IF v_try = 2 THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    v_after := v_balance + p_amount_micro;
    IF v_after < 0 THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'the balance would fall below zero';
    END IF;
    INSERT INTO credit_ledger AS l (space_id, kind, amount_micro, balance_after_micro, idempotency_key, note)
    VALUES (p_space, p_kind, p_amount_micro, v_after, p_key, coalesce(p_note, ''))
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING l.entry_id INTO v_id;
    IF FOUND THEN
      UPDATE space_credit c SET balance_micro = v_after, updated_at = now() WHERE c.space_id = p_space;
      IF p_amount_micro > 0 THEN
        v_daily := space_daily_due(p_space, 0, billing_today());
        UPDATE space_credit c SET
          frozen       = c.frozen AND v_after < v_daily,
          frozen_since = CASE WHEN c.frozen AND v_after < v_daily THEN c.frozen_since END,
          notice       = CASE WHEN v_daily = 0 OR v_after / v_daily > 7 THEN 'none'
                              WHEN c.frozen AND v_after >= v_daily THEN 'low'
                              ELSE c.notice END
         WHERE c.space_id = p_space;
      END IF;
      entry_id := v_id; balance_after_micro := v_after; replayed := false;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;
END $$;

-- Each tick: every credit row frozen or carrying a notice, locked in space_id order, gets
-- the rule credit_post() applies, with the balance as it stands. So hiding posts, or free
-- days, open a frozen SPACE within the hour without a deposit. Answers how many were
-- unfrozen and how many notices went back to none.
CREATE FUNCTION schellingaf.credit_sweep() RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH flagged AS (
    SELECT c.space_id, c.balance_micro, c.frozen, c.notice
      FROM space_credit c
     WHERE c.frozen OR c.notice <> 'none'
     ORDER BY c.space_id
       FOR UPDATE
  ),
  ruled AS (
    SELECT x.space_id, x.frozen AS was_frozen, x.notice AS was_notice, x.balance_micro AS balance,
           space_daily_due(x.space_id, 0, billing_today()) AS daily
      FROM flagged x
  ),
  wanted AS (
    SELECT r.space_id, r.was_frozen, r.was_notice,
           r.was_frozen AND r.balance < r.daily AS frozen,
           CASE WHEN r.daily = 0 OR r.balance / r.daily > 7 THEN 'none'
                WHEN r.was_frozen AND r.balance >= r.daily THEN 'low'
                ELSE r.was_notice END AS notice
      FROM ruled r
  ),
  changed AS (
    UPDATE space_credit c
       SET frozen = n.frozen,
           frozen_since = CASE WHEN n.frozen THEN c.frozen_since END,
           notice = n.notice
      FROM wanted n
     WHERE c.space_id = n.space_id AND (n.frozen <> n.was_frozen OR n.notice <> n.was_notice)
    RETURNING n.was_frozen, c.frozen, n.was_notice, c.notice
  )
  SELECT jsonb_build_object(
           'unfrozen', count(*) FILTER (WHERE x.was_frozen AND NOT x.frozen),
           'notices_reset', count(*) FILTER (WHERE x.was_notice <> 'none' AND x.notice = 'none'))
    FROM changed x
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION
  schellingaf.billing_first_day(timestamptz),
  schellingaf.billing_rates(),
  schellingaf.space_allowance(text),
  schellingaf.day_due_micro(bigint, bigint),
  schellingaf.space_billable_bytes(uuid),
  schellingaf.billing_today(),
  schellingaf.billing_day_mode(date),
  schellingaf.billing_live(),
  schellingaf.space_billed(uuid),
  schellingaf.space_day_due(uuid, bigint, date),
  schellingaf.space_daily_due(uuid, bigint, date),
  schellingaf.billing_set_mode(text),
  schellingaf.deliver_funding_notice(uuid, date, text),
  schellingaf.bill_candidates(date, uuid, int),
  schellingaf.bill_space_day(uuid, date),
  schellingaf.billing_summary(date, bigint[]),
  schellingaf.credit_sweep()
FROM PUBLIC;
-- billing_day_mode: the job reads a day's mode for its line. The rest is what the job and
-- the service call; billing_rates so a test holds it equal to FUNDING.
GRANT EXECUTE ON FUNCTION
  schellingaf.billing_rates(),
  schellingaf.billing_today(),
  schellingaf.billing_day_mode(date),
  schellingaf.billing_live(),
  schellingaf.billing_set_mode(text),
  schellingaf.bill_candidates(date, uuid, int),
  schellingaf.bill_space_day(uuid, date),
  schellingaf.billing_summary(date, bigint[]),
  schellingaf.credit_sweep()
TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- Free days at release
-- ─────────────────────────────────────────────────────────────────────────────

-- 90 free days from real_from for every SPACE that exists now and is sealed or over its
-- allowance, closed and replaced ones included (an unbilled SPACE never reads it). Set once:
-- no other code writes free_until, so a SPACE made after this, a successor of a later
-- recovery included, has none.
-- free days begin
INSERT INTO schellingaf.space_credit (space_id, free_until) SELECT s.space_id, (SELECT e.real_from FROM schellingaf.billing_epoch e) + 90 FROM schellingaf.spaces s WHERE s.visibility = 'sealed' OR schellingaf.space_billable_bytes(s.space_id) > schellingaf.space_allowance(s.visibility) ON CONFLICT (space_id) DO UPDATE SET free_until = excluded.free_until;
-- free days end
