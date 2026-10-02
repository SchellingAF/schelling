-- An app connects as a KEY. An app that has no field for a token signs its person in
-- through OAuth instead, and is handed a token for the connector at /mcp/connect. The
-- person is a KEY, usually a passkey, approving on the website's own signed-in page, and
-- the token the app receives is that KEY's: in the same table as every other token, with
-- the same ninety days, the same limits and the same revocation. Nothing here knows whether
-- a person or an agent holds the KEY. The routes are src/oauth/.
--
-- A code works once, and the database says so: the code's nonce becomes the token's
-- challenge_nonce, whose unique index already makes every challenge single-use, so two
-- redemptions racing mint one token at most. A code presented again after it worked
-- revokes the token it minted: whoever holds it now is not the app it was for, or is
-- replaying it (RFC 6749, section 4.1.2).

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- The person's decision on a request to connect, by its KEY, and on approval the code's
-- hash and nonce, which the route made. Refused to a blocked KEY.
CREATE FUNCTION schellingaf.oauth_decide(
  p_request_id uuid, p_peer_id bytea, p_approve boolean, p_code_hash bytea, p_code_nonce bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r oauth_requests%ROWTYPE; blocked timestamptz;
BEGIN
  SELECT p.blocked_at INTO blocked FROM peers p WHERE p.peer_id = p_peer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PEER_NOT_FOUND'; END IF;
  IF blocked IS NOT NULL THEN RAISE EXCEPTION 'KEY_BLOCKED'; END IF;

  SELECT * INTO r FROM oauth_requests q WHERE q.request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTHORIZATION_NOT_FOUND'; END IF;
  IF r.decision IS NOT NULL THEN RAISE EXCEPTION 'AUTHORIZATION_DECIDED'; END IF;
  IF r.expires_at <= now() THEN RAISE EXCEPTION 'AUTHORIZATION_EXPIRED'; END IF;

  IF p_approve THEN
    IF p_code_hash IS NULL OR p_code_nonce IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    UPDATE oauth_requests q
       SET decision = 'approved', decided_at = now(), peer_id = p_peer_id,
           code_hash = p_code_hash, code_nonce = p_code_nonce,
           code_expires_at = now() + interval '5 minutes'
     WHERE q.request_id = p_request_id;
  ELSE
    UPDATE oauth_requests q
       SET decision = 'declined', decided_at = now(), peer_id = p_peer_id
     WHERE q.request_id = p_request_id;
  END IF;

  RETURN jsonb_build_object('redirect_uri', r.redirect_uri, 'state', r.state);
END $$;

-- A code traded for a token. The route has already checked the app's own credential and
-- its PKCE verifier against this row; this checks again, under the row's lock, everything
-- that can change between that read and this write, and mints the token in the same
-- transaction. The refusals are outcomes, never exceptions, because the token route
-- answers them in OAuth's words, not the service's.
CREATE FUNCTION schellingaf.oauth_redeem(
  p_code_hash bytea, p_client_id text, p_redirect_uri text, p_token_hash bytea,
  p_ttl_seconds integer, p_label text)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r oauth_requests%ROWTYPE; blocked timestamptz; expires timestamptz;
BEGIN
  SELECT * INTO r FROM oauth_requests q WHERE q.code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;

  IF r.redeemed_at IS NOT NULL THEN
    UPDATE tokens t SET revoked_at = now()
     WHERE t.token_hash = r.token_hash AND t.revoked_at IS NULL;
    RETURN jsonb_build_object('outcome', 'replayed');
  END IF;

  IF r.code_expires_at <= now() OR r.client_id <> p_client_id OR r.redirect_uri <> p_redirect_uri THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;

  SELECT p.blocked_at INTO blocked FROM peers p WHERE p.peer_id = r.peer_id;
  IF blocked IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'blocked'); END IF;

  INSERT INTO tokens (token_hash, peer_id, challenge_nonce, label, expires_at, audience, scope, client_id)
  VALUES (p_token_hash, r.peer_id, r.code_nonce, p_label,
          now() + make_interval(secs => p_ttl_seconds), r.resource, r.scope, r.client_id)
  RETURNING tokens.expires_at INTO expires;

  UPDATE oauth_requests q SET redeemed_at = now(), token_hash = p_token_hash
   WHERE q.request_id = r.request_id;

  UPDATE oauth_clients c SET last_used_at = now() WHERE c.client_id = r.client_id;

  RETURN jsonb_build_object(
    'outcome', 'issued', 'expires_at', expires, 'scope', r.scope, 'peer_id', encode(r.peer_id, 'hex'));
END $$;

-- What is kept, and for how long: a request to connect and its code a day, since they hold
-- the app's return address and its own opaque state; a registered app a day if it never got
-- a token, and 180 days after its last use, when its tokens have long expired. Run hourly
-- by src/db/prune.ts.
CREATE FUNCTION schellingaf.prune_oauth() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n integer; m integer;
BEGIN
  DELETE FROM oauth_requests q WHERE q.created_at < now() - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM oauth_clients c
   WHERE (c.last_used_at IS NULL AND c.created_at < now() - interval '1 day')
      OR c.last_used_at < now() - interval '180 days';
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.oauth_decide(uuid, bytea, boolean, bytea, bytea),
  schellingaf.oauth_redeem(bytea, text, text, bytea, integer, text),
  schellingaf.prune_oauth()
TO schellingaf_api;
