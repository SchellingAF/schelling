-- A SPACE's credit: one balance a SPACE, in micro-dollars, and the ledger every change to
-- it writes. Nothing here moves money: in this release nothing is deposited and nothing is
-- billed, and credit_post() is granted to nobody, so only the owner role posts an entry
-- (the tests, and runbooks/credit.md). An api role that could call it could mint credit.
--
-- Not double-entry: one account a SPACE, and no transfers. Each entry is keyed, so a
-- posting sent twice is written once: deposit:<provider id>, bill:<space_id>:<YYYY-MM-DD>,
-- free_grant:<space_id>:<label>, adjustment:<label>. Entries are never changed or deleted.
-- credit_reconcile() compares each balance with its ledger and records a SPACE whose two
-- disagree in credit_faults; billing skips such a SPACE until the runbook clears it.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- A REFERENCES to spaces takes SHARE ROW EXCLUSIVE on it, which every POST waits behind,
-- and the api role gives up on a lock after 2 s: wait 1.5 s at most, as 0148 does. A
-- timeout fails the migrate step and the deploy; the next deploy tries again.
SET LOCAL lock_timeout = '1500ms';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.space_credit (
  space_id      uuid PRIMARY KEY REFERENCES schellingaf.spaces,
  balance_micro bigint NOT NULL DEFAULT 0 CHECK (balance_micro >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schellingaf.credit_ledger (
  entry_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  space_id            uuid NOT NULL REFERENCES schellingaf.space_credit,
  kind                text NOT NULL CHECK (kind IN ('deposit', 'bill', 'free_grant', 'adjustment')),
  amount_micro        bigint NOT NULL,
  balance_after_micro bigint NOT NULL CHECK (balance_after_micro >= 0),
  idempotency_key     text NOT NULL UNIQUE CHECK (octet_length(idempotency_key) BETWEEN 3 AND 200),
  note                text NOT NULL DEFAULT '' CHECK (octet_length(note) <= 1024),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Zero only for an adjustment: the runbook's way to write a true balance_after.
  CONSTRAINT credit_ledger_nonzero CHECK (amount_micro <> 0 OR kind = 'adjustment'),
  CONSTRAINT credit_ledger_sign CHECK (CASE kind WHEN 'bill' THEN amount_micro < 0
                                                 WHEN 'adjustment' THEN true
                                                 ELSE amount_micro > 0 END),
  CONSTRAINT credit_ledger_key_kind CHECK (starts_with(idempotency_key, kind || ':'))
);
CREATE INDEX credit_ledger_space_idx ON schellingaf.credit_ledger (space_id, entry_id);
CREATE TRIGGER credit_ledger_immutable BEFORE UPDATE OR DELETE ON schellingaf.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();
CREATE TRIGGER credit_ledger_no_truncate BEFORE TRUNCATE ON schellingaf.credit_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION schellingaf.reject_mutation();

-- A SPACE whose balance disagreed with its ledger when credit_reconcile() looked: the
-- balance, the ledger's sum and its newest entry's balance_after, as found. Cleared only
-- by hand (runbooks/credit.md).
CREATE TABLE schellingaf.credit_faults (
  space_id      uuid PRIMARY KEY REFERENCES schellingaf.space_credit,
  found_at      timestamptz NOT NULL DEFAULT now(),
  balance_micro bigint NOT NULL,
  ledger_micro  bigint NOT NULL,
  last_after    bigint
);

-- Read by the definer functions alone.
ALTER TABLE schellingaf.space_credit ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_credit_none ON schellingaf.space_credit FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.space_credit FROM schellingaf_api;
ALTER TABLE schellingaf.credit_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_none ON schellingaf.credit_ledger FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.credit_ledger FROM schellingaf_api;
ALTER TABLE schellingaf.credit_faults ENABLE ROW LEVEL SECURITY;
CREATE POLICY credit_faults_none ON schellingaf.credit_faults FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.credit_faults FROM schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- Posting an entry
-- ─────────────────────────────────────────────────────────────────────────────

-- One entry and the balance it leaves, in one transaction. The SPACE's credit row is made
-- if missing and locked, and the key is looked up after the lock, so a second posting with
-- the same key waits and then replays: the same SPACE, kind and amount answer the first
-- entry with replayed true; anything else is IDEMPOTENCY_CONFLICT. A balance never falls
-- below zero. A fault row does not stop a posting: a deposit that arrived is recorded
-- whatever the state.
--
-- The same key posted to another SPACE at the same moment is not serialised by the lock:
-- the insert waits for that posting. If it commits, the insert writes nothing and the key
-- is read again and answered as above; if it rolls back, the insert goes through. No
-- subtransaction: ON CONFLICT DO NOTHING, not an exception block.
CREATE FUNCTION schellingaf.credit_post(p_space uuid, p_kind text, p_amount_micro bigint, p_key text, p_note text DEFAULT '')
  RETURNS TABLE (entry_id bigint, balance_after_micro bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_balance bigint; v_after bigint; v_id bigint;
  v_space uuid; v_kind text; v_amount bigint; v_was_after bigint;
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
      entry_id := v_id; balance_after_micro := v_after; replayed := false;
      RETURN NEXT;
      RETURN;
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reconciling
-- ─────────────────────────────────────────────────────────────────────────────

-- Records every SPACE whose balance differs from the sum of its ledger, or from its newest
-- entry's balance_after (0 with none). One statement, one snapshot, in which a posting's
-- entry and balance are both committed or neither. Answers the fault rows now held.
CREATE FUNCTION schellingaf.credit_reconcile() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_held integer;
BEGIN
  INSERT INTO credit_faults (space_id, balance_micro, ledger_micro, last_after)
  SELECT c.space_id, c.balance_micro, coalesce(t.total, 0), n.after
    FROM space_credit c
    LEFT JOIN LATERAL (SELECT sum(l.amount_micro)::bigint AS total
                         FROM credit_ledger l WHERE l.space_id = c.space_id) t ON true
    LEFT JOIN LATERAL (SELECT l.balance_after_micro AS after
                         FROM credit_ledger l WHERE l.space_id = c.space_id
                        ORDER BY l.entry_id DESC LIMIT 1) n ON true
   WHERE c.balance_micro <> coalesce(t.total, 0) OR c.balance_micro <> coalesce(n.after, 0)
  ON CONFLICT (space_id) DO NOTHING;
  SELECT count(*)::int INTO v_held FROM credit_faults f;
  RETURN v_held;
END $$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.credit_post(uuid, text, bigint, text, text),
  schellingaf.credit_reconcile()
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.credit_reconcile() TO schellingaf_api;
