-- Deposits: one row a payment into a deposit address, recorded from the provider's signed
-- callbacks (src/http/funding.ts) and credited to the SPACE once confirmed.
--
-- A payment is (address, txid_in, coin). A pending callback records it and never credits.
-- A confirmed one credits it once, through credit_post() with the key
-- deposit:cryptapi:<deposit_id>, or holds it with a reason for the operator, or, when the
-- callback names another address or wallet, rejects it. Each callback's uuid is kept,
-- pending and confirmed apart, so a replay changes nothing. A confirmed callback under a
-- new uuid for a payment already decided, naming another forwarded value or forwarding
-- transaction, is a second payment in one transaction: it gets a row of its own, held as
-- conflict, for the operator. The raw body and its signature are kept, so every credit can
-- be checked again offline (scripts/funding-audit.ts), and funding_callback() refuses
-- fields that are not its body's own.
--
-- funding_callback() is the only way a deposit reaches the ledger from the api role: it
-- posts kind deposit and nothing else. funding_release_held() credits a held deposit and
-- is granted to nobody: the operator runs it (runbooks/credit.md).
--
-- Lock order: the address row, then the deposit row, then the SPACE's credit row (inside
-- credit_post). Nothing takes these in another order.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- A REFERENCES to spaces takes SHARE ROW EXCLUSIVE on it, which every POST waits behind,
-- and the api role gives up on a lock after 2 s: wait 1.5 s at most, as 0148 does. A
-- timeout fails the migrate step and the deploy; the next deploy tries again.
SET LOCAL lock_timeout = '1500ms';

CREATE TABLE schellingaf.funding_deposits (
  deposit_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id      uuid NOT NULL REFERENCES schellingaf.funding_addresses,
  -- The address's SPACE, and the SPACE credited: the end of its replaced_by chain.
  space_id        uuid NOT NULL REFERENCES schellingaf.spaces,
  credited_space  uuid REFERENCES schellingaf.spaces,
  txid_in         text NOT NULL CHECK (octet_length(txid_in) BETWEEN 1 AND 200),
  -- As the callback spelled it.
  coin            text NOT NULL CHECK (octet_length(coin) BETWEEN 1 AND 64),
  state           text NOT NULL CHECK (state IN ('pending', 'confirmed', 'held', 'rejected')),
  reason          text CHECK (reason IN ('unknown_coin', 'wrong_family', 'no_usd_value', 'zero_value',
                                         'txid_credited', 'review', 'conflict', 'address_in_mismatch', 'address_out_mismatch')),
  -- A second payment in a transaction already recorded under this address and coin: kept
  -- beside the first, outside the one-row-a-payment rule, and never credited automatically.
  conflict        boolean NOT NULL DEFAULT false,
  value_coin            numeric CHECK (value_coin >= 0),
  value_forwarded_coin  numeric CHECK (value_forwarded_coin >= 0),
  fee_coin              numeric CHECK (fee_coin >= 0),
  -- What was, or would be, credited.
  usd_micro             bigint CHECK (usd_micro >= 0),
  price_usd             numeric,
  confirmations   integer CHECK (confirmations >= 0),
  txid_out        text CHECK (octet_length(txid_out) <= 200),
  pending_uuid    uuid UNIQUE,
  confirmed_uuid  uuid UNIQUE,
  entry_id        bigint UNIQUE REFERENCES schellingaf.credit_ledger,
  raw_pending     bytea CHECK (octet_length(raw_pending) <= 16384),
  sig_pending     text  CHECK (octet_length(sig_pending) <= 512),
  raw_confirmed   bytea CHECK (octet_length(raw_confirmed) <= 16384),
  sig_confirmed   text  CHECK (octet_length(sig_confirmed) <= 512),
  seen_at         timestamptz NOT NULL DEFAULT now(),
  confirmed_at    timestamptz,
  released_at     timestamptz,
  CONSTRAINT funding_deposits_reason CHECK ((state IN ('held', 'rejected')) = (reason IS NOT NULL)),
  CONSTRAINT funding_deposits_credit CHECK ((entry_id IS NOT NULL) = (state = 'confirmed'))
);
-- One row a payment: (address, txid_in, coin), a conflict row aside.
CREATE UNIQUE INDEX funding_deposits_one ON schellingaf.funding_deposits (address_id, txid_in, coin) WHERE NOT conflict;
CREATE INDEX funding_deposits_space_idx ON schellingaf.funding_deposits (space_id, state, seen_at DESC);
CREATE INDEX funding_deposits_credited_idx ON schellingaf.funding_deposits (credited_space, confirmed_at DESC);

-- A deposit moves forward only: pending to any state, held to confirmed (a release).
-- Confirmed and rejected never change, and no row is deleted.
CREATE FUNCTION schellingaf.funding_deposits_follow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.state = 'pending' OR (OLD.state = 'held' AND NEW.state = 'confirmed')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_RECORD' USING DETAIL = 'a decided deposit never changes, and none is deleted';
END $$;
CREATE TRIGGER funding_deposits_follow BEFORE UPDATE OR DELETE ON schellingaf.funding_deposits
  FOR EACH ROW EXECUTE FUNCTION schellingaf.funding_deposits_follow();
CREATE TRIGGER funding_deposits_no_truncate BEFORE TRUNCATE ON schellingaf.funding_deposits
  FOR EACH STATEMENT EXECUTE FUNCTION schellingaf.reject_mutation();

ALTER TABLE schellingaf.funding_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY funding_deposits_none ON schellingaf.funding_deposits FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.funding_deposits FROM schellingaf_api;

-- The SPACE a deposit to `p_space`'s address credits: the end of its replaced_by chain,
-- 16 steps at most. Credit follows a recovery. It reads no word of a SPACE, and checks no
-- access: the chain is public.
CREATE FUNCTION schellingaf.funding_credited_space(p_space uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_space uuid := p_space; v_next uuid;
BEGIN
  FOR v_step IN 1..16 LOOP
    SELECT s.replaced_by INTO v_next FROM spaces s WHERE s.space_id = v_space;
    EXIT WHEN v_next IS NULL;
    v_space := v_next;
  END LOOP;
  RETURN v_space;
END $$;

-- One callback, already verified, in one transaction. p_mac finds the address; p_space
-- and p_coin_seg, the URL's other segments, must be the address's. p_family is the
-- callback coin's family in the table, NULL when the table has no such coin; p_usd_micro
-- and p_hold are creditOf()'s answer (src/funding/callback.ts), and p_stable whether the
-- table counts the coin one for one, NULL when it has no such coin. p_address_out NULL means
-- the callback named several wallets. The fields are checked against p_raw, the signed
-- body, first: a field that is not the body's own, or no review ceiling, is refused
-- INTERNAL and nothing is written. Outcomes:
--   no_match          no address has this mac, or the SPACE or coin segment is not its own
--   replay            this uuid was seen, or the payment is already decided with the same
--                     forwarded value and forwarding transaction
--   conflict          the payment is already decided, and this callback names another
--                     forwarded value or forwarding transaction: held in a row of its own
--   rejected          the callback names another address or wallet than the row's
--   pending_recorded  a new payment, not yet confirmed; pending_ignored, one already known
--   credited          confirmed and posted to the ledger; held, confirmed and kept back
CREATE FUNCTION schellingaf.funding_callback(
  p_mac text, p_space uuid, p_coin_seg text, p_uuid uuid, p_pending boolean,
  p_address_in text, p_address_out text, p_txid_in text, p_coin text,
  p_family text, p_stable boolean, p_usd_micro bigint, p_hold text,
  p_value_coin numeric, p_value_forwarded numeric, p_fee numeric, p_price numeric,
  p_confirmations integer, p_txid_out text, p_raw bytea, p_sig text, p_review_micro bigint)
  RETURNS TABLE (outcome text, deposit_id uuid, space_id uuid, credited_micro bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_address uuid; v_space uuid; v_coin text; v_family text; v_in text; v_out text;
  v_id uuid; v_state text; v_reason text; v_credit uuid; v_entry bigint;
  v_body jsonb; v_convert jsonb; v_forwarded numeric; v_txid_out text; v_amount numeric;
BEGIN
  -- Without a ceiling no deposit would be held for review.
  IF p_review_micro IS NULL THEN
    RAISE EXCEPTION 'INTERNAL' USING DETAIL = 'funding_callback needs a review ceiling';
  END IF;
  -- Every field is the signed body's own, so what is recorded and credited is what the
  -- provider signed. The amount is creditOf()'s: nothing forwarded is 0; a stablecoin's is
  -- the forwarded value, any other coin's its USD, each rounded down to the micro-dollar.
  v_body := ltrim(convert_from(p_raw, 'UTF8'), chr(65279))::jsonb;
  IF jsonb_typeof(v_body) IS DISTINCT FROM 'object'
     OR lower(v_body->>'uuid') IS DISTINCT FROM p_uuid::text
     OR (v_body->>'pending' = '1') IS DISTINCT FROM p_pending
     OR v_body->>'address_in' IS DISTINCT FROM p_address_in
     OR (CASE WHEN jsonb_typeof(v_body->'address_out') = 'string' THEN v_body->>'address_out' END) IS DISTINCT FROM p_address_out
     OR v_body->>'txid_in' IS DISTINCT FROM p_txid_in
     OR v_body->>'coin' IS DISTINCT FROM p_coin
     OR (NOT p_pending AND ((v_body->>'value_forwarded_coin')::numeric IS DISTINCT FROM p_value_forwarded
                            OR v_body->>'txid_out' IS DISTINCT FROM p_txid_out)) THEN
    RAISE EXCEPTION 'INTERNAL' USING DETAIL = 'a callback field is not its signed body''s';
  END IF;
  IF p_usd_micro IS NOT NULL THEN
    IF coalesce(p_value_forwarded, 0) = 0 THEN
      v_amount := 0;
    ELSIF p_stable THEN
      v_amount := floor(p_value_forwarded * 1000000);
    ELSIF p_stable IS NOT NULL THEN
      v_convert := v_body->'value_forwarded_coin_convert';
      IF jsonb_typeof(v_convert) = 'string' THEN
        v_convert := (v_convert #>> '{}')::jsonb;
      END IF;
      IF jsonb_typeof(v_convert) = 'object' THEN
        v_amount := floor((v_convert->>'USD')::numeric * 1000000);
      END IF;
    END IF;
    -- No amount here (a coin the table lacks, or no USD) is a refusal too.
    IF p_usd_micro::numeric IS DISTINCT FROM v_amount THEN
      RAISE EXCEPTION 'INTERNAL' USING DETAIL = 'the amount is not its signed body''s';
    END IF;
  END IF;

  SELECT a.address_id, a.space_id, a.coin, a.family, a.address_in, a.address_out
    INTO v_address, v_space, v_coin, v_family, v_in, v_out
    FROM funding_addresses a WHERE a.callback_mac = p_mac
     FOR NO KEY UPDATE;
  IF NOT FOUND OR v_space <> p_space OR replace(v_coin, '/', '_') <> p_coin_seg THEN
    outcome := 'no_match';
    RETURN NEXT;
    RETURN;
  END IF;
  space_id := v_space;

  -- A uuid seen before. A confirmed callback under its pending callback's uuid is the same
  -- payment confirming, not a replay.
  SELECT d.deposit_id INTO v_id FROM funding_deposits d WHERE d.confirmed_uuid = p_uuid;
  IF NOT FOUND AND p_pending THEN
    SELECT d.deposit_id INTO v_id FROM funding_deposits d WHERE d.pending_uuid = p_uuid;
  END IF;
  IF FOUND THEN
    outcome := 'replay'; deposit_id := v_id;
    RETURN NEXT;
    RETURN;
  END IF;

  IF (CASE WHEN v_family = 'evm' THEN lower(p_address_in) <> lower(v_in) ELSE p_address_in <> v_in END) THEN
    v_reason := 'address_in_mismatch';
  ELSIF p_address_out IS NULL
        OR (CASE WHEN v_family = 'evm' THEN lower(p_address_out) <> lower(v_out) ELSE p_address_out <> v_out END) THEN
    v_reason := 'address_out_mismatch';
  END IF;
  IF v_reason IS NOT NULL THEN
    INSERT INTO funding_deposits AS d (address_id, space_id, txid_in, coin, state, reason, value_coin,
      value_forwarded_coin, fee_coin, price_usd, confirmations, txid_out,
      pending_uuid, confirmed_uuid, raw_pending, sig_pending, raw_confirmed, sig_confirmed)
    VALUES (v_address, v_space, p_txid_in, p_coin, 'rejected', v_reason, p_value_coin,
      p_value_forwarded, p_fee, p_price, p_confirmations, p_txid_out,
      CASE WHEN p_pending THEN p_uuid END, CASE WHEN NOT p_pending THEN p_uuid END,
      CASE WHEN p_pending THEN p_raw END, CASE WHEN p_pending THEN p_sig END,
      CASE WHEN NOT p_pending THEN p_raw END, CASE WHEN NOT p_pending THEN p_sig END)
    ON CONFLICT DO NOTHING
    RETURNING d.deposit_id INTO v_id;
    outcome := 'rejected'; deposit_id := v_id;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_pending THEN
    -- A pending callback records a new payment and never changes one already known.
    INSERT INTO funding_deposits AS d (address_id, space_id, txid_in, coin, state, value_coin, price_usd,
      pending_uuid, raw_pending, sig_pending)
    VALUES (v_address, v_space, p_txid_in, p_coin, 'pending', p_value_coin, p_price, p_uuid, p_raw, p_sig)
    ON CONFLICT DO NOTHING
    RETURNING d.deposit_id INTO v_id;
    IF FOUND THEN
      outcome := 'pending_recorded';
    ELSE
      outcome := 'pending_ignored';
      SELECT d.deposit_id INTO v_id FROM funding_deposits d
       WHERE d.address_id = v_address AND d.txid_in = p_txid_in AND d.coin = p_coin AND NOT d.conflict;
    END IF;
    deposit_id := v_id;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Confirmed: the payment's row, made now if no pending callback came first. Its uuid is
  -- this callback's, kept in confirmed_uuid alone.
  INSERT INTO funding_deposits AS d (address_id, space_id, txid_in, coin, state)
  VALUES (v_address, v_space, p_txid_in, p_coin, 'pending')
  ON CONFLICT DO NOTHING;
  SELECT d.deposit_id, d.state, d.value_forwarded_coin, d.txid_out INTO v_id, v_state, v_forwarded, v_txid_out
    FROM funding_deposits d
   WHERE d.address_id = v_address AND d.txid_in = p_txid_in AND d.coin = p_coin AND NOT d.conflict
     FOR UPDATE;
  IF NOT FOUND OR (v_state <> 'pending' AND v_forwarded IS NOT DISTINCT FROM p_value_forwarded
                   AND v_txid_out IS NOT DISTINCT FROM p_txid_out) THEN
    outcome := 'replay'; deposit_id := v_id;
    RETURN NEXT;
    RETURN;
  END IF;
  -- Decided already, and this callback names another forwarded value or forwarding
  -- transaction: a second payment in one transaction. It is kept, held, never credited
  -- here; the operator checks the chain and releases it (runbooks/credit.md).
  IF v_state <> 'pending' THEN
    INSERT INTO funding_deposits AS d (address_id, space_id, txid_in, coin, state, reason, conflict, value_coin,
      value_forwarded_coin, fee_coin, usd_micro, price_usd, confirmations, txid_out,
      confirmed_uuid, raw_confirmed, sig_confirmed, confirmed_at)
    VALUES (v_address, v_space, p_txid_in, p_coin, 'held', 'conflict', true, p_value_coin,
      p_value_forwarded, p_fee, p_usd_micro, p_price, p_confirmations, p_txid_out,
      p_uuid, p_raw, p_sig, now())
    RETURNING d.deposit_id INTO v_id;
    outcome := 'conflict'; deposit_id := v_id;
    RETURN NEXT;
    RETURN;
  END IF;
  deposit_id := v_id;

  v_reason := p_hold;
  IF v_reason IS NULL AND p_family IS DISTINCT FROM v_family THEN
    v_reason := 'wrong_family';
  END IF;
  -- Never two credits for one transaction into one address, however its coin is spelled.
  IF v_reason IS NULL AND EXISTS (SELECT 1 FROM funding_deposits o
                                   WHERE o.address_id = v_address AND o.txid_in = p_txid_in
                                     AND o.state = 'confirmed' AND o.deposit_id <> v_id) THEN
    v_reason := 'txid_credited';
  END IF;
  IF v_reason IS NULL AND (p_usd_micro IS NULL OR p_usd_micro <= 0) THEN
    v_reason := 'zero_value';
  END IF;
  IF v_reason IS NULL AND p_usd_micro > p_review_micro THEN
    v_reason := 'review';
  END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE funding_deposits d
       SET state = 'held', reason = v_reason, usd_micro = p_usd_micro,
           value_coin = coalesce(p_value_coin, d.value_coin), value_forwarded_coin = p_value_forwarded,
           fee_coin = p_fee, price_usd = coalesce(p_price, d.price_usd), confirmations = p_confirmations,
           txid_out = p_txid_out, confirmed_uuid = p_uuid, raw_confirmed = p_raw, sig_confirmed = p_sig,
           confirmed_at = now()
     WHERE d.deposit_id = v_id;
    outcome := 'held';
    RETURN NEXT;
    RETURN;
  END IF;

  v_credit := funding_credited_space(v_space);
  SELECT c.entry_id INTO v_entry
    FROM credit_post(v_credit, 'deposit', p_usd_micro, 'deposit:cryptapi:' || v_id::text, p_coin) c;
  UPDATE funding_deposits d
     SET state = 'confirmed', credited_space = v_credit, entry_id = v_entry, usd_micro = p_usd_micro,
         value_coin = coalesce(p_value_coin, d.value_coin), value_forwarded_coin = p_value_forwarded,
         fee_coin = p_fee, price_usd = coalesce(p_price, d.price_usd), confirmations = p_confirmations,
         txid_out = p_txid_out, confirmed_uuid = p_uuid, raw_confirmed = p_raw, sig_confirmed = p_sig,
         confirmed_at = now()
   WHERE d.deposit_id = v_id;
  outcome := 'credited'; credited_micro := p_usd_micro;
  RETURN NEXT;
END $$;

-- A held deposit credited by the operator, at an amount the operator decides, with a note.
-- The ledger key is the one an automatic credit would use, so a deposit is never credited
-- twice; a deposit that is not held is refused. So is one whose transaction already
-- credited another deposit to its address, unless p_force: the operator checked the chain
-- and found two payments. Granted to nobody: runbooks/credit.md.
CREATE FUNCTION schellingaf.funding_release_held(p_deposit uuid, p_usd_micro bigint, p_note text, p_force boolean DEFAULT false)
  RETURNS TABLE (entry_id bigint, balance_after_micro bigint, credited_space uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_address uuid; v_space uuid; v_state text; v_txid text; v_credit uuid; v_entry bigint; v_after bigint;
BEGIN
  IF p_usd_micro IS NULL OR p_usd_micro <= 0 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a release credits more than zero';
  END IF;
  SELECT d.address_id INTO v_address FROM funding_deposits d WHERE d.deposit_id = p_deposit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'no such deposit';
  END IF;
  -- The address row first, as funding_callback() takes it.
  PERFORM 1 FROM funding_addresses a WHERE a.address_id = v_address FOR NO KEY UPDATE;
  SELECT d.space_id, d.state, d.txid_in INTO v_space, v_state, v_txid FROM funding_deposits d WHERE d.deposit_id = p_deposit FOR UPDATE;
  IF v_state <> 'held' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'the deposit is not held';
  END IF;
  IF NOT coalesce(p_force, false) AND EXISTS (
       SELECT 1 FROM funding_deposits o
        WHERE o.address_id = v_address AND o.txid_in = v_txid AND o.state = 'confirmed' AND o.deposit_id <> p_deposit) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'this transaction already credited a deposit to this address: check the chain, then release with p_force true';
  END IF;
  v_credit := funding_credited_space(v_space);
  SELECT c.entry_id, c.balance_after_micro INTO v_entry, v_after
    FROM credit_post(v_credit, 'deposit', p_usd_micro, 'deposit:cryptapi:' || p_deposit::text, p_note) c;
  UPDATE funding_deposits d
     SET state = 'confirmed', reason = NULL, credited_space = v_credit, entry_id = v_entry,
         usd_micro = p_usd_micro, released_at = now()
   WHERE d.deposit_id = p_deposit;
  entry_id := v_entry; balance_after_micro := v_after; credited_space := v_credit;
  RETURN NEXT;
END $$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.funding_deposits_follow(),
  schellingaf.funding_credited_space(uuid),
  schellingaf.funding_callback(text, uuid, text, uuid, boolean, text, text, text, text, text, boolean, bigint, text,
                               numeric, numeric, numeric, numeric, integer, text, bytea, text, bigint),
  schellingaf.funding_release_held(uuid, bigint, text, boolean)
FROM PUBLIC;
-- funding_credited_space() too: GET /v1/spaces/{name}/funding names the SPACE a replaced
-- SPACE's addresses credit, which GET /v1/spaces/{name} shows link by link to anyone.
GRANT EXECUTE ON FUNCTION
  schellingaf.funding_credited_space(uuid),
  schellingaf.funding_callback(text, uuid, text, uuid, boolean, text, text, text, text, text, boolean, bigint, text,
                               numeric, numeric, numeric, numeric, integer, text, bytea, text, bigint)
TO schellingaf_api;
