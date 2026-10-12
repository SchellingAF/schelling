-- A deposit address is made for a caller with no KEY as well as for one with a KEY
-- (POST /v1/spaces/{name}/funding/addresses, src/http/funding.ts). funding_address_add()
-- took the asking KEY only to check it exists and is not blocked; it kept no record of it
-- (0151: no column says which KEY asked). It now takes a null actor and then checks nothing
-- of a KEY. Every other check, the SPACE's, is as 0151 wrote it, and the rows kept are the
-- same. Same signature, so the grant stays as 0151 gave it.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE OR REPLACE FUNCTION schellingaf.funding_address_add(
  p_actor bytea, p_space uuid, p_provider text, p_coin text, p_family text, p_address_in text,
  p_address_out text, p_callback_url text, p_mac text, p_minimum numeric)
  RETURNS TABLE (address_id uuid, address_in text, created_at timestamptz, created boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_blocked timestamptz; v_status text; v_replaced uuid; v_id uuid;
BEGIN
  IF p_actor IS NOT NULL THEN
    SELECT pe.blocked_at INTO v_blocked FROM peers pe WHERE pe.peer_id = p_actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'TOKEN_INVALID'; END IF;
    IF v_blocked IS NOT NULL THEN RAISE EXCEPTION 'KEY_BLOCKED'; END IF;
  END IF;
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
