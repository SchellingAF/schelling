-- Deposit addresses: one a SPACE, a coin and a receiving wallet, made by the provider on
-- first request (src/http/funding.ts) and kept. Each row holds the callback URL it was made
-- with, byte for byte, and that URL's mac, by which a callback finds its row; the URL is
-- never rebuilt. A new wallet makes a new URL and so a new address; rows made under an
-- older wallet stay, with their own address_out.
--
-- No column says which KEY asked: that would be a record of a KEY's activity, and the rate
-- buckets already hold its limit. minimum_coin is what the provider answered when the
-- address was made, kept for the operator; answers show the coin table's minimum.
--
-- Read by the definer functions alone. Never changed or deleted.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- A REFERENCES to spaces takes SHARE ROW EXCLUSIVE on it, which every POST waits behind,
-- and the api role gives up on a lock after 2 s: wait 1.5 s at most, as 0148 does. A
-- timeout fails the migrate step and the deploy; the next deploy tries again.
SET LOCAL lock_timeout = '1500ms';

CREATE TABLE schellingaf.funding_addresses (
  address_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id     uuid NOT NULL REFERENCES schellingaf.spaces,
  provider     text NOT NULL CHECK (provider IN ('cryptapi')),
  coin         text NOT NULL CHECK (coin ~ '^[a-z0-9.-]{1,24}(/[a-z0-9.-]{1,24})?$'),
  family       text NOT NULL CHECK (family IN ('evm', 'solana', 'btc', 'tron')),
  address_in   text NOT NULL CHECK (address_in ~ '^[A-Za-z0-9]{20,128}$'),
  address_out  text NOT NULL CHECK (address_out ~ '^[A-Za-z0-9]{20,128}$'),
  callback_url text NOT NULL UNIQUE CHECK (octet_length(callback_url) BETWEEN 20 AND 1024),
  callback_mac text NOT NULL UNIQUE CHECK (callback_mac ~ '^[A-Za-z0-9_-]{43}$'),
  minimum_coin numeric NOT NULL CHECK (minimum_coin >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funding_addresses_one UNIQUE (space_id, coin, address_out),
  -- An EVM wallet is kept lower case (src/funding/config.ts), so every lookup, the mac and
  -- `current` read one text.
  CONSTRAINT funding_addresses_evm_lower CHECK (family <> 'evm' OR address_out = lower(address_out))
);
CREATE UNIQUE INDEX funding_addresses_in_idx ON schellingaf.funding_addresses (provider, lower(address_in));
CREATE TRIGGER funding_addresses_immutable BEFORE UPDATE OR DELETE ON schellingaf.funding_addresses
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();
CREATE TRIGGER funding_addresses_no_truncate BEFORE TRUNCATE ON schellingaf.funding_addresses
  FOR EACH STATEMENT EXECUTE FUNCTION schellingaf.reject_mutation();

ALTER TABLE schellingaf.funding_addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY funding_addresses_none ON schellingaf.funding_addresses FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.funding_addresses FROM schellingaf_api;

-- The address already made for this SPACE, coin and wallet, if any. The route asks it before
-- spending an allowance or calling the provider, on the write pool, after its own checks of
-- the SPACE: it takes no caller and checks no access. Addresses are public.
CREATE FUNCTION schellingaf.funding_address_find(p_space uuid, p_coin text, p_address_out text)
  RETURNS TABLE (address_id uuid, address_in text, coin text, family text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT a.address_id, a.address_in, a.coin, a.family, a.created_at
    FROM funding_addresses a
   WHERE a.space_id = p_space AND a.coin = p_coin AND a.address_out = p_address_out
$$;

-- Keeps an address the provider made. The SPACE is checked again here, though the route
-- checked it first, because it can change between the route's read and this write. Two
-- requests at once both reach the provider, which answers both the same address for the
-- same callback URL; the second insert does nothing and the row is read back, created
-- false. No row for this SPACE, coin and wallet after the insert means another unique
-- key matched: the provider answered an address, URL or mac some other row holds.
CREATE FUNCTION schellingaf.funding_address_add(
  p_actor bytea, p_space uuid, p_provider text, p_coin text, p_family text, p_address_in text,
  p_address_out text, p_callback_url text, p_mac text, p_minimum numeric)
  RETURNS TABLE (address_id uuid, address_in text, created_at timestamptz, created boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_blocked timestamptz; v_status text; v_replaced uuid; v_id uuid;
BEGIN
  SELECT pe.blocked_at INTO v_blocked FROM peers pe WHERE pe.peer_id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOKEN_INVALID'; END IF;
  IF v_blocked IS NOT NULL THEN RAISE EXCEPTION 'KEY_BLOCKED'; END IF;
  SELECT s.status, s.replaced_by INTO v_status, v_replaced FROM spaces s WHERE s.space_id = p_space;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM withheld_spaces w WHERE w.space_id = p_space AND w.released_at IS NULL) THEN
    RAISE EXCEPTION 'READ_DENIED';
  END IF;
  IF v_status <> 'active' OR v_replaced IS NOT NULL THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  INSERT INTO funding_addresses AS a (space_id, provider, coin, family, address_in, address_out, callback_url, callback_mac, minimum_coin)
  VALUES (p_space, p_provider, p_coin, p_family, p_address_in, p_address_out, p_callback_url, p_mac, p_minimum)
  ON CONFLICT DO NOTHING
  RETURNING a.address_id INTO v_id;

  RETURN QUERY
    SELECT a.address_id, a.address_in, a.created_at, coalesce(a.address_id = v_id, false)
      FROM funding_addresses a
     WHERE a.space_id = p_space AND a.coin = p_coin AND a.address_out = p_address_out
       AND a.address_in = p_address_in AND a.callback_mac = p_mac;
  IF NOT FOUND THEN RAISE EXCEPTION 'FUNDING_UNAVAILABLE'; END IF;
END $$;

-- Whether a callback URL's three segments are one address's own: its mac, its SPACE and its
-- coin as the URL spells it. A GET to that URL is logged (src/http/funding.ts) only then, so
-- a stranger's GET writes no line.
CREATE FUNCTION schellingaf.funding_callback_known(p_mac text, p_space uuid, p_coin_seg text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM funding_addresses a
                  WHERE a.callback_mac = p_mac AND a.space_id = p_space AND replace(a.coin, '/', '_') = p_coin_seg)
$$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.funding_callback_known(text, uuid, text),
  schellingaf.funding_address_find(uuid, text, text),
  schellingaf.funding_address_add(bytea, uuid, text, text, text, text, text, text, text, numeric)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schellingaf.funding_callback_known(text, uuid, text),
  schellingaf.funding_address_find(uuid, text, text),
  schellingaf.funding_address_add(bytea, uuid, text, text, text, text, text, text, text, numeric)
TO schellingaf_api;
