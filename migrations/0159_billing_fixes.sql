-- Fixes to the bill (0155) and to read-only at zero (0157):
--   bill_space_day() bills only a day the job has begun and not finished, so the api role
--     can bill only what the job is billing;
--   a replaced SPACE's balance follows replaced_by: at recovery, in its transaction, the
--     balance moves to the successor by two adjustment entries, keyed
--     adjustment:recovery:<space_id>:out and adjustment:recovery:<space_id>:in, and a frozen
--     flag or a notice moves with it. The SPACES replaced already move theirs once here, to
--     their payer, under the same keys;
--   a predecessor's day is billed only to a payer that existed on that day. A recovery
--     after a day ended and before the job billed it leaves that day unbilled: no_payer;
--   a replaced SPACE owes 0 a day itself: its payer pays for it. So the sweep unfreezes
--     its old credit row, and it is never read-only;
--   billing_set_mode(NULL) reads the mode and writes nothing: BILLING unset leaves the
--     database's mode.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- The trigger below takes SHARE ROW EXCLUSIVE on spaces, which every POST waits behind.
-- 1.5 s at most, under the api role's 2 s, as 0148 waits; a timeout fails the deploy, and
-- the next one tries again.
SET LOCAL lock_timeout = '1500ms';

-- ─────────────────────────────────────────────────────────────────────────────
-- A replaced SPACE owes nothing itself
-- ─────────────────────────────────────────────────────────────────────────────

-- 0155's sum, and 0 for a SPACE with replaced_by: what it stores is its payer's to pay.
CREATE OR REPLACE FUNCTION schellingaf.space_daily_due(p_payer uuid, p_add bigint, p_day date) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH RECURSIVE chain (space_id, depth) AS (
    SELECT x.space_id, 1 FROM spaces x WHERE x.replaced_by = p_payer
    UNION ALL
    SELECT x.space_id, c.depth + 1 FROM chain c JOIN spaces x ON x.replaced_by = c.space_id WHERE c.depth < 16
  )
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = p_payer AND s.replaced_by IS NOT NULL) THEN 0
           ELSE space_day_due(p_payer, p_add, p_day)
                + coalesce((SELECT sum(space_day_due(c.space_id, 0, p_day)) FROM chain c), 0)::bigint
         END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The balance follows replaced_by
-- ─────────────────────────────────────────────────────────────────────────────

-- Moves a replaced SPACE's credit to p_to: the whole balance, by two adjustment entries,
-- and its frozen flag and notice, merged with what p_to has. The flag moves first, so the
-- entry in clears it only when the balance pays a day of all p_to pays for, as a deposit
-- would. The keys say what each entry is; no note. The replaced SPACE is left at 0, not
-- frozen and with no notice. Idempotent: a
-- second call finds a balance of 0 and moves nothing.
CREATE FUNCTION schellingaf.move_replaced_credit(p_from uuid, p_to uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_balance bigint; v_frozen boolean; v_since timestamptz; v_notice text;
BEGIN
  IF p_to IS NULL OR p_to = p_from THEN RETURN; END IF;
  SELECT c.balance_micro, c.frozen, c.frozen_since, c.notice INTO v_balance, v_frozen, v_since, v_notice
    FROM space_credit c WHERE c.space_id = p_from FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_frozen OR v_notice <> 'none' THEN
    INSERT INTO space_credit (space_id) VALUES (p_to) ON CONFLICT (space_id) DO NOTHING;
    UPDATE space_credit c
       SET frozen = c.frozen OR v_frozen,
           frozen_since = CASE WHEN c.frozen OR v_frozen THEN least(c.frozen_since, v_since) END,
           notice = CASE WHEN 'read_only' IN (c.notice, v_notice) THEN 'read_only'
                         WHEN 'low' IN (c.notice, v_notice) THEN 'low'
                         ELSE 'none' END
     WHERE c.space_id = p_to;
  END IF;
  IF v_balance > 0 THEN
    PERFORM credit_post(p_from, 'adjustment', -v_balance, 'adjustment:recovery:' || p_from::text || ':out', '');
    PERFORM credit_post(p_to, 'adjustment', v_balance, 'adjustment:recovery:' || p_from::text || ':in', '');
  END IF;
  UPDATE space_credit c SET frozen = false, frozen_since = NULL, notice = 'none'
   WHERE c.space_id = p_from AND (c.frozen OR c.notice <> 'none');
END $$;

-- At recovery: recover_space() sets replaced_by once, in its own transaction.
CREATE FUNCTION schellingaf.credit_follows_replacement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  PERFORM move_replaced_credit(NEW.space_id, NEW.replaced_by);
  RETURN NULL;
END $$;

CREATE TRIGGER spaces_replaced_credit
  AFTER UPDATE OF replaced_by ON schellingaf.spaces
  FOR EACH ROW WHEN (OLD.replaced_by IS NULL AND NEW.replaced_by IS NOT NULL)
  EXECUTE FUNCTION schellingaf.credit_follows_replacement();

-- ─────────────────────────────────────────────────────────────────────────────
-- The bill
-- ─────────────────────────────────────────────────────────────────────────────

-- 0155's bill, with two refusals before it reads anything else, and one more state:
--   a day the job has not begun, or has finished, is refused INVALID_REQUEST;
--   no_payer  a predecessor's day whose payer was made after the day ended: nobody that
--             existed that day holds the credit now, so nothing is billed.
-- And the payer is read again once its credit row is locked: a recovery that commits while
-- the bill waits for that lock has moved the credit on, so the bill locks the new payer's
-- row instead. The old payer's row is locked first, as the recovery locks it first.
CREATE OR REPLACE FUNCTION schellingaf.bill_space_day(p_space uuid, p_day date) RETURNS TABLE (state text, delivered jsonb)
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
  IF NOT EXISTS (SELECT 1 FROM billing_runs r WHERE r.day = p_day AND r.finished_at IS NULL) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'the day is not being billed';
  END IF;
  SELECT s.visibility, s.created_at INTO v_visibility, v_created FROM spaces s WHERE s.space_id = p_space;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF v_created >= (p_day + 1)::timestamp AT TIME ZONE 'UTC' THEN
    state := 'young'; RETURN NEXT; RETURN;
  END IF;
  v_mode := billing_day_mode(p_day);
  -- At most 16 passes, as funding_credited_space() follows at most 16 steps.
  FOR v_pass IN 1..16 LOOP
    v_payer := funding_credited_space(p_space);
    IF NOT space_billed(p_space) THEN
      state := 'closed'; RETURN NEXT; RETURN;
    END IF;
    IF v_payer <> p_space
       AND (SELECT s.created_at FROM spaces s WHERE s.space_id = v_payer) >= (p_day + 1)::timestamp AT TIME ZONE 'UTC' THEN
      state := 'no_payer'; RETURN NEXT; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM credit_faults cf WHERE cf.space_id = v_payer) THEN
      state := 'fault'; RETURN NEXT; RETURN;
    END IF;
    EXIT WHEN v_mode <> 'real';
    INSERT INTO space_credit (space_id) VALUES (v_payer) ON CONFLICT (space_id) DO NOTHING;
    SELECT c.balance_micro, c.frozen, c.notice INTO v_balance, v_frozen, v_notice
      FROM space_credit c WHERE c.space_id = v_payer FOR UPDATE;
    EXIT WHEN funding_credited_space(p_space) = v_payer;
  END LOOP;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- The switch
-- ─────────────────────────────────────────────────────────────────────────────

-- 0155's switch; NULL reads the mode and writes nothing, for a start with BILLING unset.
CREATE OR REPLACE FUNCTION schellingaf.billing_set_mode(p_mode text) RETURNS TABLE (mode text, real_from date)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF p_mode IS NOT NULL AND p_mode NOT IN ('real', 'shadow') THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'billing mode is real or shadow';
  END IF;
  IF p_mode IS NOT NULL THEN
    UPDATE billing_epoch e SET mode = p_mode, mode_at = now() WHERE e.one AND e.mode <> p_mode;
  END IF;
  RETURN QUERY SELECT e.mode, e.real_from FROM billing_epoch e;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────

-- Neither is called by the api role: recover_space() runs as the owner role.
REVOKE EXECUTE ON FUNCTION
  schellingaf.move_replaced_credit(uuid, uuid),
  schellingaf.credit_follows_replacement()
FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- The SPACES replaced already
-- ─────────────────────────────────────────────────────────────────────────────

-- Each moves its balance, flag and notice once to its payer, oldest first.
SELECT schellingaf.move_replaced_credit(s.space_id, schellingaf.funding_credited_space(s.space_id))
  FROM schellingaf.spaces s
 WHERE s.replaced_by IS NOT NULL
 ORDER BY s.created_at, s.space_id;
