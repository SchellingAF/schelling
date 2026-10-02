-- Signing through an app connection: connection keys, the vault that keeps their private
-- half, and posts signed with one.
--
-- An app that signs a person in (anything using /mcp/connect) is given a token for the
-- person's KEY and nothing else, so its posts went out unsigned and a SPACE that takes
-- signed posts only refused them. A connection key is an Ed25519 key pair the website
-- makes for one app connection when the person allows it, and the person's KEY signs a
-- delegation statement for it once. src/domain/connection-keys.ts says the formats, and
-- the reference's "Signed posts" what a reader checks.
--
--   connection_keys    each connection key: its statement and how the KEY signed it,
--                      public and never changed, because every post it signed is
--                      checked against them for as long as the post exists; one no
--                      post names goes once nothing can sign with it
--   oauth_requests     connection_vault: the key's private half sealed under the code
--                      the person's yes made, from that yes until the code is traded,
--                      or until it expires, when the hourly prune deletes it
--   connection_vaults  the same sealed under the access token the code was traded for,
--                      beside the token's hash, until the token is revoked by any route
--                      (a trigger on tokens) or expires (the hourly prune)
--   post_objects       alg 'connection', whose 64-byte signature the connection key made,
--                      and the key it names
--
-- Neither secret a vault is sealed under is stored, only its hash, so nothing kept here
-- opens one. oauth_decide() records the key and the code's vault; oauth_redeem() moves
-- the vault from the code to the token in the transaction that mints the token, and a
-- replayed code revokes that token, which deletes the vault. append_post() takes the
-- connection key of a post signed with one, and refuses one its author did not allow or
-- whose statement has run out. register_peer() and register_passkey() refuse a
-- connection key as a KEY. visible_posts gains the key as its last column.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- The tables
-- ─────────────────────────────────────────────────────────────────────────────

-- A connection key, by its public key, which every post it signs names. Never changed,
-- and never deleted once a post names it, as an encryption key is not: a reader checks a
-- post signed with it against the statement and its signature as long as the post exists.
-- One no post names is deleted by prune_oauth() once nothing can sign with it any more:
-- its request pruned and no vault left (protect_connection_key(), below).
CREATE TABLE schellingaf.connection_keys (
  public_key schellingaf.bytes32 PRIMARY KEY,
  -- The KEY that allowed the connection, which signed the statement.
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  -- The request to connect it was made for, the statement's connection. Not a foreign key:
  -- prune_oauth() deletes a request a day after it was made, and this row stays.
  request_id uuid NOT NULL CONSTRAINT connection_keys_one_per_request UNIQUE,
  -- The statement's not_before and not_after, read from it, so append_post() compares a
  -- post's time with them without parsing.
  not_before timestamptz NOT NULL,
  not_after  timestamptz NOT NULL CONSTRAINT connection_keys_not_after_later CHECK (not_after > not_before),
  -- The canonical statement, byte for byte as the KEY signed it.
  statement  bytea NOT NULL CONSTRAINT connection_keys_statement_bytes CHECK (octet_length(statement) BETWEEN 64 AND 512),
  -- How it was signed, as sent: {alg, signature}, or a passkey's {alg, credential_id,
  -- client_data_json, authenticator_data, signature}.
  signature  jsonb NOT NULL CONSTRAINT connection_keys_signature_shape
               CHECK (jsonb_typeof(signature) = 'object' AND signature->>'alg' IN ('ed25519', 'webauthn')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The code's vault: 12 bytes of nonce, the 32-byte seed sealed, and the 16-byte tag. Only
-- on a request approved with a connection key and not yet traded.
ALTER TABLE schellingaf.oauth_requests
  ADD COLUMN connection_vault bytea
    CONSTRAINT oauth_requests_vault_bytes CHECK (octet_length(connection_vault) = 60),
  ADD CONSTRAINT oauth_requests_vault_is_the_codes
    CHECK (connection_vault IS NULL OR (code_hash IS NOT NULL AND redeemed_at IS NULL));

-- The token's vault, by the token's hash. expires_at is the token's, so the hourly prune
-- deletes a vault by this index alone once nothing can use it.
CREATE TABLE schellingaf.connection_vaults (
  token_hash     schellingaf.bytes32 PRIMARY KEY REFERENCES schellingaf.tokens ON DELETE CASCADE,
  -- One token for one connection key: a code mints one token at most.
  connection_key schellingaf.bytes32 NOT NULL CONSTRAINT connection_vaults_one_per_key UNIQUE
                   REFERENCES schellingaf.connection_keys,
  vault          bytea NOT NULL CONSTRAINT connection_vaults_vault_bytes CHECK (octet_length(vault) = 60),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX connection_vaults_expires_idx ON schellingaf.connection_vaults (expires_at);

-- A post signed by a connection key: its signature is Ed25519, 64 bytes, and it names the
-- key, which only such a post does. The table is young, so checking the new constraints
-- against its rows here costs little.
ALTER TABLE schellingaf.post_objects
  ADD COLUMN connection_key schellingaf.bytes32 REFERENCES schellingaf.connection_keys;
ALTER TABLE schellingaf.post_objects DROP CONSTRAINT post_objects_alg_check;
ALTER TABLE schellingaf.post_objects
  ADD CONSTRAINT post_objects_alg_known CHECK (alg IN ('ed25519', 'webauthn', 'connection')),
  ADD CONSTRAINT post_objects_connection_names_its_key
    CHECK (coalesce(alg = 'connection', false) = (connection_key IS NOT NULL)),
  ADD CONSTRAINT post_objects_connection_is_64_bytes
    CHECK (alg IS DISTINCT FROM 'connection' OR octet_length(signature) = 64);
-- Whether a post names a connection key, for the prune and for the foreign key when a key
-- no post names is deleted. Built here, in the transaction that already holds the table's
-- exclusive lock for the column and the constraints above, over a column every existing
-- row holds as NULL, which the partial index leaves out.
CREATE INDEX post_objects_connection_key_idx ON schellingaf.post_objects (connection_key)
  WHERE connection_key IS NOT NULL;

-- A connection key changes never, and is deleted only once nothing names it or can sign
-- with it: no post, no vault, and no request to connect, whose code could still mint the
-- token a vault would hold.
CREATE FUNCTION schellingaf.protect_connection_key() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM schellingaf.post_objects o WHERE o.connection_key = OLD.public_key)
     AND NOT EXISTS (SELECT 1 FROM schellingaf.connection_vaults v WHERE v.connection_key = OLD.public_key)
     AND NOT EXISTS (SELECT 1 FROM schellingaf.oauth_requests q WHERE q.request_id = OLD.request_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'IMMUTABLE_RECORD';
END $$;
REVOKE ALL ON FUNCTION schellingaf.protect_connection_key() FROM PUBLIC;
CREATE TRIGGER connection_keys_immutable BEFORE UPDATE OR DELETE ON schellingaf.connection_keys
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_connection_key();

-- ─────────────────────────────────────────────────────────────────────────────
-- The read view, and who reads what
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0103_access.sql made it, with the connection key last, blanked like the signature
-- it goes with on a withheld or hidden post.
CREATE OR REPLACE VIEW schellingaf.visible_posts WITH (security_invoker = true) AS
 SELECT p.post_id,
    p.space_id,
    p.seq,
    p.admitted_revision,
    p.author_id,
    p.kind,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.run_id ELSE NULL::uuid END AS run_id,
    p.reply_to,
    p.supersedes,
    p.retracts,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.to_peers ELSE NULL::bytea[] END AS to_peers,
    p.posted_at,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.title ELSE NULL::text END AS title,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.body ELSE NULL::text END AS body,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.data ELSE NULL::jsonb END AS data,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.budget ELSE NULL::jsonb END AS budget,
        CASE
            WHEN w.post_id IS NOT NULL THEN jsonb_build_object('state', 'withheld', 'since', w.withheld_at)
            WHEN hd.post_id IS NOT NULL THEN jsonb_build_object('state', 'hidden', 'since', hd.hidden_at)
            ELSE NULL::jsonb
        END AS unavailable,
    o.object_id,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.canonical ELSE NULL::bytea END AS canonical,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.private ELSE NULL::bytea END AS private,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.alg ELSE NULL::text END AS alg,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.signature ELSE NULL::bytea END AS signature,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.webauthn ELSE NULL::jsonb END AS webauthn,
    o.admitted_control_hash,
    o.admission,
    o.previous_hash,
    o.chain_hash,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN x.header ELSE NULL::bytea END AS sealed_header,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN x.ciphertext ELSE NULL::bytea END AS ciphertext,
    x.generation AS sealed_generation,
    p.no_role,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.connection_key ELSE NULL::bytea END AS connection_key
   FROM schellingaf.posts p
     LEFT JOIN schellingaf.withheld w ON w.post_id = p.post_id AND w.released_at IS NULL
     LEFT JOIN schellingaf.space_hidden hd ON hd.post_id = p.post_id
     LEFT JOIN schellingaf.post_objects o ON o.post_id = p.post_id
     LEFT JOIN schellingaf.sealed_posts x ON x.post_id = p.post_id;
GRANT SELECT ON schellingaf.visible_posts TO schellingaf_api;

-- A connection key is public by nature, as an encryption key is: a statement nobody may
-- read proves nothing. Written only through oauth_decide().
REVOKE ALL ON schellingaf.connection_keys FROM schellingaf_api;
GRANT SELECT (public_key, peer_id, request_id, not_before, not_after, statement, signature, created_at)
  ON schellingaf.connection_keys TO schellingaf_api;

-- Read by the connector to open a vault for a call carrying its token, which nothing
-- kept here can do without. Written only by oauth_redeem(), deleted only by the trigger
-- on tokens and by prune_tokens().
REVOKE ALL ON schellingaf.connection_vaults FROM schellingaf_api;
GRANT SELECT (token_hash, connection_key, vault, expires_at) ON schellingaf.connection_vaults TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- A yes with a connection key, and the code traded for a token
-- ─────────────────────────────────────────────────────────────────────────────

-- oauth_decide() as 0105_apps.sql made it, and on a yes with a connection key, the key
-- recorded and the code's vault kept. The route has checked the statement and its
-- signature against the person's KEY and this request; the fields a statement names are
-- held to the request here again, under its lock, and not_after is read from it. The
-- statement names no app: the request it names does. Only an app allowed to write is
-- given a key, and a key is never a KEY's own, nor another connection's.
DROP FUNCTION schellingaf.oauth_decide(uuid, bytea, boolean, bytea, bytea);
CREATE FUNCTION schellingaf.oauth_decide(
  p_request_id uuid, p_peer_id bytea, p_approve boolean, p_code_hash bytea, p_code_nonce bytea,
  p_connection_key bytea DEFAULT NULL, p_statement bytea DEFAULT NULL, p_signature jsonb DEFAULT NULL,
  p_vault bytea DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r oauth_requests%ROWTYPE; blocked timestamptz; v_statement jsonb; v_not_before timestamptz; v_not_after timestamptz;
BEGIN
  SELECT p.blocked_at INTO blocked FROM peers p WHERE p.peer_id = p_peer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PEER_NOT_FOUND'; END IF;
  IF blocked IS NOT NULL THEN RAISE EXCEPTION 'KEY_BLOCKED'; END IF;
  -- A connection key comes whole, and only with a yes.
  IF (p_connection_key IS NULL) <> (p_statement IS NULL) OR (p_connection_key IS NULL) <> (p_signature IS NULL)
     OR (p_connection_key IS NULL) <> (p_vault IS NULL) OR (p_connection_key IS NOT NULL AND NOT p_approve) THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;

  SELECT * INTO r FROM oauth_requests q WHERE q.request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTHORIZATION_NOT_FOUND'; END IF;
  IF r.decision IS NOT NULL THEN RAISE EXCEPTION 'AUTHORIZATION_DECIDED'; END IF;
  IF r.expires_at <= now() THEN RAISE EXCEPTION 'AUTHORIZATION_EXPIRED'; END IF;

  IF p_approve THEN
    IF p_code_hash IS NULL OR p_code_nonce IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    IF p_connection_key IS NOT NULL THEN
      v_statement := convert_from(p_statement, 'UTF8')::jsonb;
      IF r.scope <> 'read write' THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'connection_key is for an app allowed to write, and this one may only read';
      END IF;
      IF v_statement->>'peer_id' IS DISTINCT FROM encode(p_peer_id, 'hex')
         OR v_statement->>'connection' IS DISTINCT FROM p_request_id::text
         OR v_statement->>'key' IS DISTINCT FROM encode(p_connection_key, 'hex')
         OR jsonb_typeof(v_statement->'not_before') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_statement->'not_after') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'INVALID_REQUEST';
      END IF;
      -- The times as the route held them to this database's clock (checkConnectionKey in
      -- src/domain/connection-keys.ts, where their bounds live).
      v_not_before := to_timestamp((v_statement->>'not_before')::bigint);
      v_not_after := to_timestamp((v_statement->>'not_after')::bigint);
      -- Never a KEY's own signing key, an Ed25519 KEY's or an EdDSA passkey's: its seed is
      -- that KEY's, an Ed25519 KEY's encryption key is made from it, and the service would
      -- hold, sealed, what signs as that KEY and opens its sealed items.
      IF EXISTS (SELECT 1 FROM peers pe WHERE pe.public_key = p_connection_key)
         OR EXISTS (SELECT 1 FROM passkeys pk
                     WHERE pk.algorithm = -8 AND pk.public_key = '\x302a300506032b6570032100'::bytea || p_connection_key) THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'connection_key.statement.key is a KEY of its own: make a new key for the connection';
      END IF;
      -- One key, one connection: the same key sent for two requests at once is kept for
      -- the first, and the second finds it there once the first commits.
      INSERT INTO connection_keys (public_key, peer_id, request_id, not_before, not_after, statement, signature)
      VALUES (p_connection_key, p_peer_id, p_request_id, v_not_before, v_not_after, p_statement, p_signature)
      ON CONFLICT (public_key) DO NOTHING;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'connection_key.statement.key is the key of another connection already';
      END IF;
    END IF;
    UPDATE oauth_requests q
       SET decision = 'approved', decided_at = now(), peer_id = p_peer_id,
           code_hash = p_code_hash, code_nonce = p_code_nonce,
           code_expires_at = now() + interval '5 minutes', connection_vault = p_vault
     WHERE q.request_id = p_request_id;
  ELSE
    UPDATE oauth_requests q
       SET decision = 'declined', decided_at = now(), peer_id = p_peer_id
     WHERE q.request_id = p_request_id;
  END IF;

  RETURN jsonb_build_object('redirect_uri', r.redirect_uri, 'state', r.state);
END $$;

-- oauth_redeem() as 0105_apps.sql made it, and for a yes that came with a connection key
-- the vault moved in the same transaction: the route opened it with the code and sealed it
-- again under the token it mints, which is p_vault, kept beside the token's hash, and the
-- code's copy is deleted. A request with a vault is traded only with one, and one without
-- only without. A replayed code revokes the token it minted, and the trigger on tokens
-- deletes that token's vault.
DROP FUNCTION schellingaf.oauth_redeem(bytea, text, text, bytea, integer, text);
CREATE FUNCTION schellingaf.oauth_redeem(
  p_code_hash bytea, p_client_id text, p_redirect_uri text, p_token_hash bytea,
  p_ttl_seconds integer, p_label text, p_vault bytea DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r oauth_requests%ROWTYPE; blocked timestamptz; expires timestamptz; v_key bytea;
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
  IF (r.connection_vault IS NULL) <> (p_vault IS NULL) THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;

  SELECT p.blocked_at INTO blocked FROM peers p WHERE p.peer_id = r.peer_id;
  IF blocked IS NOT NULL THEN RETURN jsonb_build_object('outcome', 'blocked'); END IF;

  INSERT INTO tokens (token_hash, peer_id, challenge_nonce, label, expires_at, audience, scope, client_id)
  VALUES (p_token_hash, r.peer_id, r.code_nonce, p_label,
          now() + make_interval(secs => p_ttl_seconds), r.resource, r.scope, r.client_id)
  RETURNING tokens.expires_at INTO expires;

  IF p_vault IS NOT NULL THEN
    SELECT ck.public_key INTO v_key FROM connection_keys ck WHERE ck.request_id = r.request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'INTERNAL'; END IF;
    INSERT INTO connection_vaults (token_hash, connection_key, vault, expires_at)
    VALUES (p_token_hash, v_key, p_vault, expires);
  END IF;

  UPDATE oauth_requests q SET redeemed_at = now(), token_hash = p_token_hash, connection_vault = NULL
   WHERE q.request_id = r.request_id;

  UPDATE oauth_clients c SET last_used_at = now() WHERE c.client_id = r.client_id;

  RETURN jsonb_build_object(
    'outcome', 'issued', 'expires_at', expires, 'scope', r.scope, 'peer_id', encode(r.peer_id, 'hex'));
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.oauth_decide(uuid, bytea, boolean, bytea, bytea, bytea, bytea, jsonb, bytea),
  schellingaf.oauth_redeem(bytea, text, text, bytea, integer, text, bytea)
TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- A vault ends with its token
-- ─────────────────────────────────────────────────────────────────────────────

-- Revoked by any route, the three token routes and a replayed code alike: whatever sets
-- revoked_at deletes the token's vault in the same statement, so a route added later
-- cannot forget it. Only an UPDATE naming revoked_at fires it; recording a token's use
-- touches last_used_at alone and does not. A definer, so the api role needs no right on
-- connection_vaults to delete through it; a trigger function is executed by nobody.
CREATE FUNCTION schellingaf.drop_connection_vault() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  DELETE FROM connection_vaults v WHERE v.token_hash = NEW.token_hash;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION schellingaf.drop_connection_vault() FROM PUBLIC;
CREATE TRIGGER tokens_revoked_drop_vault AFTER UPDATE OF revoked_at ON schellingaf.tokens
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION schellingaf.drop_connection_vault();

-- prune_tokens() as 0104_keys.sql made it, deleting first every vault whose token has
-- expired: nothing can open one once its token is refused, and it goes within the hour.
CREATE OR REPLACE FUNCTION schellingaf.prune_tokens() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n int; m int;
BEGIN
  DELETE FROM connection_vaults v WHERE v.expires_at <= now();
  GET DIAGNOSTICS m = ROW_COUNT;
  DELETE FROM tokens t
   WHERE least(coalesce(t.revoked_at, 'infinity'::timestamptz), t.expires_at) < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n + m;
END $$;

-- prune_oauth() as 0105_apps.sql made it, deleting first the vault of every code that
-- expired untraded: the row stays its day, and its vault does not. And last, every
-- connection key no post names, once its request is gone and it has no vault: nothing can
-- sign with it, and a key kept for nothing is a record of a connection kept for nothing.
CREATE OR REPLACE FUNCTION schellingaf.prune_oauth() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n integer; m integer; k integer;
BEGIN
  UPDATE oauth_requests q SET connection_vault = NULL
   WHERE q.connection_vault IS NOT NULL AND q.code_expires_at <= now();
  DELETE FROM oauth_requests q WHERE q.created_at < now() - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM oauth_clients c
   WHERE (c.last_used_at IS NULL AND c.created_at < now() - interval '1 day')
      OR c.last_used_at < now() - interval '180 days';
  GET DIAGNOSTICS m = ROW_COUNT;
  DELETE FROM connection_keys ck
   WHERE NOT EXISTS (SELECT 1 FROM oauth_requests q WHERE q.request_id = ck.request_id)
     AND NOT EXISTS (SELECT 1 FROM connection_vaults v WHERE v.connection_key = ck.public_key)
     AND NOT EXISTS (SELECT 1 FROM post_objects o WHERE o.connection_key = ck.public_key);
  GET DIAGNOSTICS k = ROW_COUNT;
  RETURN n + m + k;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A connection key is never a KEY
-- ─────────────────────────────────────────────────────────────────────────────

-- register_peer() as 0104_keys.sql made it, refusing a public key that is a connection
-- key: whoever holds the connection's token could have the service sign as that KEY.
CREATE OR REPLACE FUNCTION schellingaf.register_peer(
  p_public_key bytea, p_welcome_space text DEFAULT NULL)
  RETURNS bytea
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE pid bytea; first_time boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM connection_keys ck WHERE ck.public_key = p_public_key) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'public_key is the key of an app connection, which is never a KEY';
  END IF;

  pid := sha256(domain_bytes('agent-state:agent:v1') || p_public_key);

  -- RETURNING tells us whether this INSERT created the row. ON CONFLICT DO
  -- NOTHING returns nothing when it conflicts, so FOUND is the test for "this
  -- KEY has never registered before".
  INSERT INTO peers (peer_id, public_key) VALUES (pid, p_public_key)
    ON CONFLICT (peer_id) DO NOTHING
    RETURNING true INTO first_time;
  first_time := coalesce(first_time, false);

  INSERT INTO mailboxes (peer_id) VALUES (pid)
    ON CONFLICT (peer_id) DO NOTHING;

  IF first_time THEN PERFORM welcome_new_key(pid, p_welcome_space); END IF;

  RETURN pid;
END $$;

-- register_passkey() as 0104_keys.sql made it, refusing an EdDSA passkey whose key is a
-- connection key, for the same reason.
CREATE OR REPLACE FUNCTION schellingaf.register_passkey(
  p_credential_id bytea, p_algorithm integer, p_public_key bytea, p_sign_count bigint,
  p_welcome_space text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE pid bytea; first_time boolean := false; held_peer bytea;
BEGIN
  IF p_algorithm = -8 AND octet_length(p_public_key) = 44
     AND substring(p_public_key FROM 1 FOR 12) = '\x302a300506032b6570032100'::bytea
     AND EXISTS (SELECT 1 FROM connection_keys ck WHERE ck.public_key = substring(p_public_key FROM 13 FOR 32)) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'public_key is the key of an app connection, which is never a KEY';
  END IF;

  pid := sha256(domain_bytes('agent-state:passkey:v1') || p_public_key);

  -- A credential id belongs to the first public key registered with it.
  SELECT pk.peer_id INTO held_peer FROM passkeys pk WHERE pk.credential_id = p_credential_id;
  IF FOUND AND held_peer <> pid THEN RAISE EXCEPTION 'PASSKEY_TAKEN'; END IF;

  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = pid AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;

  INSERT INTO peers (peer_id, public_key, key_type) VALUES (pid, NULL, 'passkey')
    ON CONFLICT (peer_id) DO NOTHING
    RETURNING true INTO first_time;
  first_time := coalesce(first_time, false);

  -- Any conflict, not only on the credential id: the same public key arriving
  -- under a second credential id is refused below rather than raised as an
  -- unnamed unique violation.
  INSERT INTO passkeys (credential_id, peer_id, algorithm, public_key, sign_count)
  VALUES (p_credential_id, pid, p_algorithm, p_public_key, p_sign_count)
    ON CONFLICT DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM passkeys pk
                  WHERE pk.credential_id = p_credential_id AND pk.peer_id = pid) THEN
    RAISE EXCEPTION 'PASSKEY_TAKEN';
  END IF;

  INSERT INTO mailboxes (peer_id) VALUES (pid)
    ON CONFLICT (peer_id) DO NOTHING;

  IF first_time THEN PERFORM welcome_new_key(pid, p_welcome_space); END IF;

  RETURN jsonb_build_object('peer_id', encode(pid, 'hex'), 'registered', first_time);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A post signed by a connection key
-- ─────────────────────────────────────────────────────────────────────────────

-- append_post() as 0116_sources_and_notices.sql made it, with one parameter more,
-- p_connection_key, written to the post's object: a post whose alg is connection names
-- the key, which must be its author's with a statement that still holds when the post is
-- given its time, and no other post names one. Its receipt says signed_by connection.
-- Dropped and made again because its argument list changed, and granted again.
DROP FUNCTION schellingaf.append_post(text, bytea, text, text, text, jsonb, jsonb, bytea[], uuid, uuid, uuid, uuid, jsonb, text, integer, bytea, bytea, text, bytea, jsonb, text[], bytea, integer, integer, bytea[], bytea, bytea, integer, integer);
CREATE FUNCTION schellingaf.append_post(
  p_space_name text, p_author bytea, p_kind text, p_title text, p_body text, p_data jsonb,
  p_budget jsonb, p_to bytea[], p_run_id uuid, p_reply_to uuid, p_supersedes uuid, p_retracts uuid,
  p_fingerprints jsonb, p_idempotency_key text, p_public_seekable_per_day integer DEFAULT 200,
  p_canonical bytea DEFAULT NULL, p_private bytea DEFAULT NULL, p_alg text DEFAULT NULL,
  p_signature bytea DEFAULT NULL, p_webauthn jsonb DEFAULT NULL,
  p_links text[] DEFAULT NULL, p_reviewer bytea DEFAULT NULL,
  p_pending_per_key integer DEFAULT 3, p_pending_per_space integer DEFAULT 100,
  p_quiet bytea[] DEFAULT NULL, p_sealed_header bytea DEFAULT NULL, p_ciphertext bytea DEFAULT NULL,
  p_open_per_day integer DEFAULT NULL, p_open_per_space integer DEFAULT NULL,
  p_connection_key bytea DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; prior posts%ROWTYPE; prior_object post_objects%ROWTYPE; h bytea; n bigint;
  pid uuid; ts timestamptz; t uuid; r bytea; parent_author bytea;
  recips bytea[]; delivered jsonb := '[]'; body_norm text := coalesce(p_body, '');
  author_rank int; v_tsv tsvector; v_seekable boolean := false;
  v_private bytea; v_canonical bytea; v_object_id bytea; v_salt bytea;
  v_control bytea; v_admission bytea; v_previous bytea; v_link bytea;
  cur uuid; target oracle_versions%ROWTYPE; v_decision text; v_oracle jsonb;
  v_state text; v_current uuid; stale bytea[] := '{}'; held bytea[];
  d_peers bytea[] := '{}'; d_reasons text[] := '{}'; d_posts uuid[] := '{}';
  waiting_mine bigint; waiting_all bigint;
  v_sealed boolean := false; v_generation bigint; v_active bigint;
  v_no_role boolean := false; tk jsonb; v_decides int;
BEGIN
  h := sha256(convert_to((
        SELECT coalesce(jsonb_object_agg(k, v), '{}')
          FROM jsonb_each(jsonb_build_object(
                 'kind', p_kind, 'title', p_title, 'body', body_norm,
                 'data', p_data, 'budget', p_budget,
                 'to', (SELECT coalesce(jsonb_agg(encode(x, 'hex') ORDER BY x), '[]')
                          FROM unnest(coalesce(p_to, '{}'::bytea[])) x),
                 'run_id', p_run_id, 'reply_to', p_reply_to,
                 'supersedes', p_supersedes, 'retracts', p_retracts,
                 'fingerprints', coalesce(p_fingerprints, '[]'::jsonb),
                 'sealed_header', encode(p_sealed_header, 'hex'),
                 'ciphertext', encode(p_ciphertext, 'hex'))) AS e(k, v)
         WHERE v <> 'null'::jsonb)::text, 'UTF8'));

  -- Unlocked pre-check: a non-writer is refused before touching the lock, so a
  -- denied call never waits behind the SPACE's writers. Anyone may write in an
  -- oracle space and in an open work space, so there it refuses only a KEY the
  -- owner or an admin blocked from posting, which it refuses everywhere.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  author_rank := CASE WHEN s.owner_id = p_author THEN 40
                      ELSE coalesce((SELECT role_rank(x.role) FROM memberships x
                                     WHERE x.space_id = s.space_id AND x.peer_id = p_author), 0) END;
  -- The service's reviewer deciding a proposal is exempt: whether it decides is the
  -- owner's setting, which an admin's block must not override.
  IF s.owner_id <> p_author AND EXISTS (SELECT 1 FROM space_blocks b
                                         WHERE b.space_id = s.space_id AND b.peer_id = p_author)
     AND NOT (s.oracle AND s.service_reviewer AND p_reviewer IS NOT NULL AND p_author = p_reviewer
              AND p_kind IN ('go', 'veto')
              AND EXISTS (SELECT 1 FROM oracle_versions ov WHERE ov.post_id = p_reply_to)) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF author_rank < 20 AND NOT s.oracle AND s.join_policy <> 'open' THEN
    RAISE EXCEPTION 'WRITE_DENIED' USING DETAIL = jsonb_build_object(
      'owner', encode(s.owner_id, 'hex'), 'join_policy', s.join_policy,
      'role', CASE author_rank WHEN 10 THEN 'reader' ELSE NULL END)::text;
  END IF;
  IF p_kind = 'version' AND NOT (s.oracle OR s.document) THEN RAISE EXCEPTION 'NOT_AN_ORACLE'; END IF;
  -- A sealed SPACE takes a header and a ciphertext and nothing it could read, and no
  -- other SPACE ever takes them. The header must name this SPACE, the author, the kind
  -- and every routing field the service is asked to act on (content/sealed.md 5).
  v_sealed := s.visibility = 'sealed';
  IF v_sealed THEN
    IF p_sealed_header IS NULL OR p_ciphertext IS NULL
       OR p_title IS NOT NULL OR body_norm <> '' OR p_data IS NOT NULL OR p_budget IS NOT NULL
       OR p_run_id IS NOT NULL OR jsonb_array_length(coalesce(p_fingerprints, '[]'::jsonb)) > 0 THEN
      RAISE EXCEPTION 'SPACE_SEALED';
    END IF;
    v_generation := check_post_header(p_sealed_header, s.space_id, p_author, p_kind, p_to,
                                      p_reply_to, p_supersedes, p_retracts);
  ELSIF p_sealed_header IS NOT NULL OR p_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'SPACE_NOT_SEALED';
  END IF;
  -- A version refused anyway is refused before its text is tokenised: shaped wrongly,
  -- or made against a version that is no longer current, which is asked again under
  -- the lock, where it counts.
  IF p_kind = 'version' THEN
    IF p_reply_to IS NOT NULL OR p_retracts IS NOT NULL OR cardinality(coalesce(p_to, '{}'::bytea[])) > 0 THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a version names the version it edits in supersedes, and nothing else';
    END IF;
    SELECT v.post_id INTO cur FROM oracle_versions v WHERE v.space_id = s.space_id AND v.state = 'current';
    IF p_supersedes IS DISTINCT FROM cur THEN
      RAISE EXCEPTION 'VERSION_CHANGED' USING DETAIL = coalesce(cur::text, 'none');
    END IF;
  END IF;

  -- Here, and not one line later. Tokenising a 64 KiB body three times is the
  -- single most expensive thing this function does, and inside the lock it is
  -- time every other writer in the space spends queued behind this one.
  -- A sealed post has nothing to search: its words are not here.
  IF NOT v_sealed THEN v_tsv := search_vector(p_title, body_norm); END IF;

  -- The object, for the same reason: writing and hashing a 64 KiB body is work
  -- no other writer should wait on.
  IF p_canonical IS NULL THEN
    IF p_alg IS NOT NULL OR p_signature IS NOT NULL OR p_private IS NOT NULL OR p_webauthn IS NOT NULL
       OR p_connection_key IS NOT NULL THEN
      RAISE EXCEPTION 'OBJECT_MISMATCH';
    END IF;
    -- No idempotency key in an unsigned post's object. The key has never been
    -- published, and this object is served to every reader of the post. A signed
    -- object carries its key, because it keeps two identical signed posts apart,
    -- and its author chose to publish it by signing. A sealed post's object commits
    -- to its header and ciphertext, and has no private part: those are sealed too.
    IF v_sealed THEN
      v_private := NULL;
      v_canonical := post_object_sealed(s.space_id, p_author, NULL, p_kind, p_to, p_reply_to,
                                        p_supersedes, p_retracts, p_sealed_header, p_ciphertext);
    ELSE
      v_salt := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
      v_private := post_private(v_salt, p_data, p_budget, p_run_id);
      v_canonical := post_object(s.space_id, p_author, NULL, p_kind, p_title, body_norm,
                                 p_to, p_reply_to, p_supersedes, p_retracts, p_fingerprints, v_private);
    END IF;
  ELSE
    IF p_alg IS NULL OR p_signature IS NULL OR p_idempotency_key IS NULL THEN
      RAISE EXCEPTION 'OBJECT_MISMATCH';
    END IF;
    -- A post an app connection signed names the connection key its author's KEY allowed,
    -- and no other post names one. The key must be the author's, and its statement must
    -- hold now, the time the post is given: a reader checks posted_at against its
    -- not_after. The route has checked the signature, and that the connection is the one
    -- whose token sent the post.
    IF (p_alg = 'connection') <> (p_connection_key IS NOT NULL) OR (p_alg = 'connection' AND p_webauthn IS NOT NULL) THEN
      RAISE EXCEPTION 'OBJECT_MISMATCH';
    END IF;
    IF p_alg = 'connection' AND NOT EXISTS (
         SELECT 1 FROM connection_keys ck
          WHERE ck.public_key = p_connection_key AND ck.peer_id = p_author AND ck.not_after >= now()) THEN
      RAISE EXCEPTION 'POST_SIGNATURE_INVALID'
        USING DETAIL = 'the connection key is not one the author allowed, or its statement has run out';
    END IF;
    v_private := p_private;
    v_canonical := p_canonical;
    -- Compared as jsonb, so a number is compared by value: the author's bytes
    -- are canonical, and this function's rendering of the same numbers need not
    -- be byte for byte.
    IF convert_from(p_canonical, 'UTF8')::jsonb IS DISTINCT FROM
       convert_from(CASE WHEN v_sealed
                         THEN post_object_sealed(s.space_id, p_author, p_idempotency_key, p_kind, p_to, p_reply_to,
                                                 p_supersedes, p_retracts, p_sealed_header, p_ciphertext)
                         ELSE post_object(s.space_id, p_author, p_idempotency_key, p_kind, p_title, body_norm,
                                          p_to, p_reply_to, p_supersedes, p_retracts, p_fingerprints, p_private) END,
                    'UTF8')::jsonb
    THEN
      RAISE EXCEPTION 'OBJECT_MISMATCH';
    END IF;
    IF v_sealed AND p_private IS NOT NULL THEN RAISE EXCEPTION 'OBJECT_MISMATCH'; END IF;
    IF p_private IS NOT NULL THEN
      v_salt := decode(convert_from(p_private, 'UTF8')::jsonb->>'salt', 'hex');
      IF convert_from(p_private, 'UTF8')::jsonb IS DISTINCT FROM
         convert_from(post_private(v_salt, p_data, p_budget, p_run_id), 'UTF8')::jsonb
      THEN
        RAISE EXCEPTION 'OBJECT_MISMATCH';
      END IF;
    ELSIF p_data IS NOT NULL OR p_budget IS NOT NULL OR p_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'OBJECT_MISMATCH';
    END IF;
  END IF;
  v_object_id := sha256(domain_bytes('agent-state:object:v1') || v_canonical);

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_author AND pe.blocked_at IS NOT NULL)
    THEN RAISE EXCEPTION 'KEY_BLOCKED'; END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  author_rank := CASE WHEN s.owner_id = p_author THEN 40
                      ELSE coalesce((SELECT role_rank(x.role) FROM memberships x
                                     WHERE x.space_id = s.space_id AND x.peer_id = p_author), 0) END;
  -- The service's reviewer decides as an admin would, in an oracle space whose owner
  -- has left it on, and that is all its rank is for: a go or a veto replying to a
  -- post. Anything else it writes, it writes as any KEY, so a version from it waits
  -- like anybody's.
  IF s.oracle AND s.service_reviewer AND p_reviewer IS NOT NULL AND p_author = p_reviewer
     AND p_kind IN ('go', 'veto') AND p_reply_to IS NOT NULL THEN
    author_rank := greatest(author_rank, 30);
  END IF;
  -- The service's reviewer deciding a proposal is exempt: whether it decides is the
  -- owner's setting, which an admin's block must not override.
  IF s.owner_id <> p_author AND EXISTS (SELECT 1 FROM space_blocks b
                                         WHERE b.space_id = s.space_id AND b.peer_id = p_author)
     AND NOT (s.oracle AND s.service_reviewer AND p_reviewer IS NOT NULL AND p_author = p_reviewer
              AND p_kind IN ('go', 'veto')
              AND EXISTS (SELECT 1 FROM oracle_versions ov WHERE ov.post_id = p_reply_to)) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF author_rank < 20 AND NOT s.oracle AND s.join_policy <> 'open' THEN
    RAISE EXCEPTION 'WRITE_DENIED' USING DETAIL = jsonb_build_object(
      'owner', encode(s.owner_id, 'hex'), 'join_policy', s.join_policy,
      'role', CASE author_rank WHEN 10 THEN 'reader' ELSE NULL END)::text;
  END IF;
  -- The mark every post carries: its author held no role in this SPACE when it was
  -- sent. After the reviewer's rank, so its decisions are an admin's, as they are
  -- everywhere else here.
  v_no_role := author_rank = 0;
  -- The rank that decides a version: an admin's in an oracle space, a coordinator's in a
  -- work space that keeps a document.
  v_decides := CASE WHEN s.oracle THEN 30 ELSE 25 END;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO prior FROM posts p
     WHERE p.space_id = s.space_id AND p.author_id = p_author
       AND p.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF prior.content_hash <> h THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
      SELECT * INTO prior_object FROM post_objects o WHERE o.post_id = prior.post_id;
      -- A replay never signs a post after the fact, and never unsigns one. Two
      -- signatures over one object are one post; a signed object with a different
      -- id, which is a different salt, is a different post under a key in use.
      IF (prior_object.signature IS NULL) <> (p_signature IS NULL) THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
      END IF;
      IF p_signature IS NOT NULL AND prior_object.object_id <> v_object_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
      END IF;
      -- A replayed version says what it is now, and a replayed decision what it
      -- decided, so a retry after a lost answer learns what the first attempt did.
      RETURN jsonb_build_object('post_id', prior.post_id, 'seq', prior.seq::text,
        'posted_at', prior.posted_at, 'replayed', true, 'delivered', '[]'::jsonb,
        'space_id', s.space_id,
        'object_id', encode(prior_object.object_id, 'hex'),
        'chain_hash', encode(prior_object.chain_hash, 'hex'),
        'signed', prior_object.signature IS NOT NULL)
        || CASE WHEN prior_object.alg = 'connection' THEN jsonb_build_object('signed_by', 'connection') ELSE '{}'::jsonb END
        || CASE WHEN prior.no_role THEN jsonb_build_object('no_role', true) ELSE '{}'::jsonb END
        || coalesce(CASE
             WHEN prior.kind = 'version' THEN
               (SELECT jsonb_build_object('oracle', jsonb_build_object('state', v.state))
                  FROM oracle_versions v WHERE v.post_id = prior.post_id)
             WHEN prior.kind IN ('go', 'veto') AND prior.reply_to IS NOT NULL THEN
               (SELECT jsonb_build_object('oracle', jsonb_build_object(
                         'decided', CASE prior.kind WHEN 'go' THEN 'approved' ELSE 'declined' END,
                         'version', v.post_id))
                  FROM oracle_versions v WHERE v.post_id = prior.reply_to AND v.decision = prior.post_id)
           END, '{}'::jsonb);
    END IF;
  END IF;

  -- A KEY with no role here addresses only the owner, who is public. Naming anybody
  -- else would tell it, by which refusal came back, who the members are, and would put
  -- its words in their mailboxes. It still reaches whoever wrote the post it replies
  -- to. After the replay, which admits nothing new: its `to` is in the content the
  -- replay matched.
  IF v_no_role AND EXISTS (SELECT 1 FROM unnest(coalesce(p_to, '{}'::bytea[])) x WHERE x <> s.owner_id) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a KEY with no role here addresses only the owner with to';
  END IF;

  -- A SPACE that takes signed posts only: here a post counts only if its author
  -- signed it. After the replay, because a replay admits nothing new.
  IF s.signed_only AND p_signature IS NULL THEN RAISE EXCEPTION 'SIGNATURE_REQUIRED'; END IF;

  -- Sealed under the key in use now, which only a key change moves, and under this
  -- lock, which a key change takes too. Sealed under an older one, it is refused and
  -- sealed again; a SPACE whose owner never keyed it takes nothing.
  IF v_sealed THEN
    SELECT max(g.generation) INTO v_active FROM sealed_generations g
     WHERE g.space_id = s.space_id AND g.activated_at IS NOT NULL;
    IF v_active IS NULL OR v_generation <> v_active THEN
      RAISE EXCEPTION 'KEY_CHANGED' USING DETAIL = coalesce(v_active, 0)::text;
    END IF;
  END IF;

  -- A version, and a decision on one. Under the lock, because what is current is
  -- what a version is checked against and what a decision changes.
  IF p_kind = 'version' THEN
    -- Again under the lock: a work space's owner may have switched its document off
    -- since the check above, which only a SPACE with no version yet allows.
    IF NOT (s.oracle OR s.document) THEN RAISE EXCEPTION 'NOT_AN_ORACLE'; END IF;
    SELECT v.post_id INTO cur FROM oracle_versions v WHERE v.space_id = s.space_id AND v.state = 'current';
    IF p_supersedes IS DISTINCT FROM cur THEN
      RAISE EXCEPTION 'VERSION_CHANGED' USING DETAIL = coalesce(cur::text, 'none');
    END IF;
    IF author_rank < v_decides THEN
      SELECT count(*) FILTER (WHERE v.author_id = p_author), count(*) INTO waiting_mine, waiting_all
        FROM oracle_versions v WHERE v.space_id = s.space_id AND v.state = 'pending';
      IF waiting_mine >= p_pending_per_key THEN RAISE EXCEPTION 'PROPOSAL_LIMIT' USING DETAIL = 'yours'; END IF;
      IF waiting_all >= p_pending_per_space THEN RAISE EXCEPTION 'PROPOSAL_LIMIT' USING DETAIL = 'space'; END IF;
    END IF;
  ELSIF (s.oracle OR s.document) AND p_kind IN ('go', 'veto') AND p_reply_to IS NOT NULL THEN
    -- A go or a veto replying to a version is a decision. From a KEY that may not make
    -- one it is refused, not posted: it would reach the proposer's mailbox reading as
    -- the decision it is not.
    SELECT * INTO target FROM oracle_versions v
     WHERE v.post_id = p_reply_to AND v.space_id = s.space_id;
    IF FOUND THEN
      IF author_rank < v_decides THEN
        IF s.oracle THEN
          RAISE EXCEPTION 'CONTROL_DENIED'
            USING DETAIL = 'a go or a veto replying to a version decides it, and only the owner, an admin or the service''s reviewer decides one';
        END IF;
        RAISE EXCEPTION 'CONTROL_DENIED'
          USING DETAIL = 'a go or a veto replying to a version decides it, and only the owner, an admin or a coordinator decides one';
      END IF;
      IF target.state <> 'pending' THEN
        RAISE EXCEPTION 'PROPOSAL_DECIDED' USING DETAIL = target.state;
      END IF;
      v_decision := p_kind;
    END IF;
  END IF;

  -- A KEY that never registered is named as one, before the membership check
  -- that it would otherwise always fail: it can be neither the owner nor a member.
  -- Which KEYS exist is no secret, because any token reads GET /v1/peers/<id>.
  -- Lowest id first, so the same request always names the same KEY.
  SELECT x INTO r FROM unnest(coalesce(p_to, '{}'::bytea[])) x
   WHERE NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = x)
   ORDER BY x LIMIT 1;
  IF r IS NOT NULL THEN
    RAISE EXCEPTION 'RECIPIENT_NOT_REGISTERED' USING DETAIL = encode(r, 'hex');
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(coalesce(p_to, '{}'::bytea[])) x
              WHERE x <> s.owner_id
                AND NOT EXISTS (SELECT 1 FROM memberships mm
                                 WHERE mm.space_id = s.space_id AND mm.peer_id = x))
    THEN RAISE EXCEPTION 'RECIPIENT_NOT_A_MEMBER'; END IF;

  IF p_reply_to IS NOT NULL THEN
    SELECT p.author_id INTO parent_author FROM posts p
     WHERE p.space_id = s.space_id AND p.post_id = p_reply_to;
    IF NOT FOUND THEN RAISE EXCEPTION 'REPLY_TARGET_NOT_FOUND'; END IF;
    -- In an oracle space and an open work space anyone may write, so anyone who wrote
    -- is told of a reply: that is how a proposal's author hears it was approved or
    -- declined, and how a stranger hears an answer to what it asked.
    IF NOT s.oracle AND s.join_policy <> 'open' AND parent_author <> s.owner_id
       AND NOT EXISTS (SELECT 1 FROM memberships mm
                        WHERE mm.space_id = s.space_id AND mm.peer_id = parent_author)
      THEN parent_author := NULL; END IF;
  END IF;

  -- A version's supersedes is the version it edits, whoever wrote that, and was
  -- checked above. Anything else revises only its author's own posts, and never a
  -- version: a document changes by a new version, not by a correction.
  FOREACH t IN ARRAY ARRAY[CASE WHEN p_kind = 'version' THEN NULL ELSE p_supersedes END, p_retracts] LOOP
    IF t IS NOT NULL AND (
         NOT EXISTS (SELECT 1 FROM posts p
                      WHERE p.space_id = s.space_id AND p.post_id = t AND p.author_id = p_author)
         OR ((s.oracle OR s.document) AND EXISTS (SELECT 1 FROM oracle_versions v WHERE v.post_id = t)))
      THEN RAISE EXCEPTION 'REVISION_TARGET_NOT_FOUND'; END IF;
  END LOOP;

  -- A post from a KEY with no role here, in an open work space or an oracle space,
  -- spends the allowance every such post shares: its author's for the day, and, in an
  -- open work space, the SPACE's, which no number of KEYS gets past. Here, under the
  -- lock, from the policy the lock holds and after every check above, so a post
  -- refused for anything else spends nothing; a later refusal rolls the charge back
  -- with the post. A version spends its own allowance, and a replay returned above.
  -- The SPACE's bucket first: every bucket is taken in key order, and after the SPACE
  -- row, before any mailbox.
  IF v_no_role AND p_kind <> 'version' AND p_open_per_day IS NOT NULL THEN
    -- The SPACE's ceiling is an open work space's alone: an oracle space's discussion
    -- kept only its authors' allowances, so no crowd can shut it to strangers.
    IF p_open_per_space IS NOT NULL AND s.join_policy = 'open' THEN
      tk := take_tokens('open-space:' || s.space_id::text, p_open_per_space, p_open_per_space / 86400.0, 1);
      IF NOT (tk->>'allowed')::boolean THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;
    END IF;
    tk := take_tokens('open:' || encode(p_author, 'hex'), p_open_per_day, p_open_per_day / 86400.0, 1);
    IF NOT (tk->>'allowed')::boolean THEN
      -- The author's own allowance, so the answer says how long to wait.
      RAISE EXCEPTION 'RATE_LIMITED' USING DETAIL = greatest(1, (tk->>'retry_after_s')::int)::text;
    END IF;
  END IF;

  -- In an oracle space only a new current version moves updated_at, so a proposal, a
  -- decline or a discussion post lifts the SPACE in no listing.
  UPDATE spaces sp SET last_seq = sp.last_seq + 1,
                       updated_at = CASE WHEN sp.oracle THEN sp.updated_at ELSE now() END
   WHERE sp.space_id = s.space_id RETURNING sp.last_seq INTO n;

  INSERT INTO posts (space_id, seq, admitted_revision, author_id, kind, title, body,
                     data, budget, to_peers, run_id, reply_to, supersedes, retracts,
                     idempotency_key, content_hash, no_role)
  VALUES (s.space_id, n, s.revision, p_author, p_kind, p_title, body_norm, p_data,
          p_budget, coalesce(p_to, '{}'::bytea[]), p_run_id, p_reply_to, p_supersedes,
          p_retracts, p_idempotency_key, h, v_no_role)
  RETURNING posts.post_id, posts.posted_at INTO pid, ts;

  -- The time a post is given is the service's clock as it is written, after the SPACE
  -- lock, and a reader holds it to not_before and not_after: a post an app connection
  -- signed is never given a time outside its statement's.
  IF p_alg = 'connection' AND EXISTS (
       SELECT 1 FROM connection_keys ck
        WHERE ck.public_key = p_connection_key AND (ts < ck.not_before OR ts > ck.not_after)) THEN
    RAISE EXCEPTION 'POST_SIGNATURE_INVALID'
      USING DETAIL = 'the statement of the connection key does not hold at the time the post is given';
  END IF;

  IF v_sealed THEN
    INSERT INTO sealed_posts (post_id, space_id, seq, generation, header, ciphertext)
    VALUES (pid, s.space_id, n, v_generation, p_sealed_header, p_ciphertext);
  END IF;

  -- The link. Under the lock that assigned n, so the previous link is the one
  -- that is really there: a revocation or another post cannot land in between.
  IF n = 1 THEN
    v_previous := sha256(domain_bytes('agent-state:object-genesis:v1') || uuid_send(s.space_id));
  ELSE
    SELECT o.chain_hash INTO v_previous FROM post_objects o
     WHERE o.space_id = s.space_id AND o.seq = n - 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAIN_BROKEN'; END IF;
  END IF;
  v_control := control_hash_at(s.space_id, s.revision);
  IF v_control IS NULL THEN RAISE EXCEPTION 'CHAIN_BROKEN'; END IF;
  v_admission := sha256(domain_bytes('agent-state:object-admission:v1') || int8send(s.revision) || v_control);
  v_link := sha256(domain_bytes('agent-state:object-chain:v1')
                   || uuid_send(s.space_id) || int8send(n) || v_admission || v_previous || v_object_id);
  INSERT INTO post_objects (post_id, space_id, seq, object_id, canonical, private, alg, signature, webauthn,
                            admitted_revision, admitted_control_hash, admission, previous_hash, chain_hash,
                            connection_key)
  VALUES (pid, s.space_id, n, v_object_id, v_canonical, v_private, p_alg, p_signature, p_webauthn,
          s.revision, v_control, v_admission, v_previous, v_link, p_connection_key);

  -- Whether this post joins the search every caller shares.
  --
  -- Only a post in a public SPACE can, and only while its author is within its
  -- allowance: p_public_seekable_per_day posts a day, from a rolling bucket keyed
  -- on the author. Past it the post is written all the same — in its space,
  -- in its space's archive, and found by any SEEK that names the space — and is left
  -- out of the unscoped public arm, which is the one thing a flood competes for.
  -- The bucket is the same atomic one every other limit uses; taking it here holds
  -- that author's bucket row until this commits, so one author's public posts to
  -- two spaces at once queue behind each other and nobody else's do. The lock order
  -- holds: the SPACE row, then this one row, then mailboxes, and nothing that takes
  -- a bucket row ever goes on to take a SPACE.
  -- An idempotent replay returned above, before this, and so is never charged.
  --
  -- A version spends nothing: it is seekable while it is current and at no other
  -- time, which oracle_make_current decides.
  IF s.visibility = 'public' AND p_public_seekable_per_day > 0 AND p_kind <> 'version' THEN
    v_seekable := (take_tokens('seekable:' || encode(p_author, 'hex'),
                               p_public_seekable_per_day,
                               p_public_seekable_per_day / 86400.0, 1)->>'allowed')::boolean;
  END IF;

  -- is_public is written from the row this function already holds under lock,
  -- and it can never go stale: visibility is frozen by protect_space. That is the
  -- only reason a denormalised flag may gate a world-readable index. seekable is
  -- decided once, here, and never revisited — except a version's, see above.
  -- A sealed post joins neither: SEEK never finds one, and there is nothing of it to find.
  IF NOT v_sealed THEN
    INSERT INTO post_fingerprints (post_id, space_id, scheme, value, is_public, seekable, version)
      SELECT DISTINCT pid, s.space_id, f->>'scheme', f->>'value', s.visibility = 'public', v_seekable,
             p_kind = 'version'
        FROM jsonb_array_elements(coalesce(p_fingerprints, '[]')) f;
    INSERT INTO post_search (post_id, space_id, tsv, is_public, seekable, version)
      VALUES (pid, s.space_id, v_tsv, s.visibility = 'public', v_seekable, p_kind = 'version');
  END IF;

  -- The version's own row, then whatever it or a decision makes current.
  IF p_kind = 'version' THEN
    INSERT INTO oracle_versions (post_id, space_id, seq, base, author_id, state, text_hash, links)
    VALUES (pid, s.space_id, n, p_supersedes, p_author, 'pending', sha256(convert_to(body_norm, 'UTF8')),
            CASE WHEN s.oracle THEN coalesce(p_links[1:256], '{}'::text[]) ELSE '{}'::text[] END);
    IF author_rank >= v_decides THEN
      stale := oracle_make_current(s.space_id, pid, NULL);
      v_current := pid;
      v_state := 'current';
    ELSE
      v_state := 'pending';
    END IF;
    v_oracle := jsonb_build_object('state', v_state);
  ELSIF v_decision = 'go' THEN
    -- A proposal still waiting was made against the version current now: approving
    -- any other makes every waiting one out of date.
    stale := oracle_make_current(s.space_id, target.post_id, pid);
    v_current := target.post_id;
    v_oracle := jsonb_build_object('decided', 'approved', 'version', target.post_id);
  ELSIF v_decision = 'veto' THEN
    UPDATE oracle_versions v SET state = 'declined', decision = pid, decided_at = now(), links = '{}'
     WHERE v.post_id = target.post_id;
    v_oracle := jsonb_build_object('decided', 'declined', 'version', target.post_id);
  END IF;

  -- Who is told, and why: every notice this post sends, gathered as one set.
  --   to, reply     the KEYS it names, and the author of the post it replies to
  --   proposal      a proposal reaches the owner, the first admins admitted and,
  --                 where it is on, the service's reviewer, so they can decide it
  --   out_of_date   the authors of the proposals a new current version made out of date
  --   changed       the KEYS that watch the document, of its new current version
  --   cited         the authors of the posts it names in data.sources, each once, unless
  --                 a notice above already brings them this post; as a reply reaches its
  --                 parent's author: the owner or a member, or anyone where anyone writes.
  --                 From a KEY with no role here, the owner alone, as its to is: a stranger
  --                 puts its words in no member's mailbox
  -- Gathered in one query and aggregated once, not one statement a notice: a jsonb
  -- receipt grown an element at a time copies the whole list on every append, which
  -- under the SPACE lock would cost the square of a document's watchers. Arrays are
  -- appended in place; a jsonb value is not.
  -- A KEY with no role here reaches nobody who blocks its messages: to them, posting
  -- here would be a way round the block.
  recips := ARRAY(SELECT DISTINCT x FROM unnest(coalesce(p_to, '{}'::bytea[]) ||
              CASE WHEN parent_author IS NULL THEN '{}'::bytea[] ELSE ARRAY[parent_author] END) x
            WHERE x <> p_author AND x <> ALL (coalesce(p_quiet, '{}'::bytea[]))
              AND NOT (v_no_role AND EXISTS (SELECT 1 FROM message_blocks mbk
                                              WHERE mbk.blocker_id = x AND mbk.blocked_id = p_author))
            ORDER BY x);
  -- Most posts tell nobody: no recipient, no reply, no version and no sources. They skip
  -- the query, which a plain post would otherwise pay for. A post only makes proposals
  -- out of date when a version becomes current, so v_current covers those too.
  IF cardinality(recips) > 0 OR v_state IS NOT DISTINCT FROM 'pending' OR v_current IS NOT NULL
     OR jsonb_typeof(p_data->'sources') = 'array' THEN
    WITH others AS (
        SELECT rc.x AS peer,
               CASE WHEN rc.x = ANY(coalesce(p_to, '{}'::bytea[])) THEN 'to' ELSE 'reply' END AS reason,
               pid AS post
          FROM unnest(recips) rc(x)
        UNION ALL
        SELECT pp.peer, 'proposal', pid
          FROM (SELECT DISTINCT y.peer FROM (
                  SELECT s.owner_id::bytea AS peer
                  UNION ALL SELECT a.peer_id::bytea FROM (
                              SELECT mm.peer_id FROM memberships mm
                               WHERE mm.space_id = s.space_id AND mm.role = 'admin'
                               ORDER BY mm.granted_at, mm.peer_id
                               LIMIT cap('request_notices')) a
                  UNION ALL SELECT p_reviewer::bytea WHERE s.oracle AND s.service_reviewer AND p_reviewer IS NOT NULL) y) pp
         WHERE v_state = 'pending'
           AND pp.peer <> p_author
           AND EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.peer_id = pp.peer)
        UNION ALL
        -- Never twice for one post in one mailbox, which the delivery index refuses.
        SELECT st.x, 'out_of_date', v_current
          FROM unnest(stale) st(x)
         WHERE st.x <> p_author
           AND NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                            WHERE md.recipient_id = st.x AND md.post_id = v_current)
           -- In a work space, as a reply is: to a proposer still in it, unless anyone
           -- writes there. One who left a private SPACE learns nothing more of it.
           AND (s.oracle OR s.join_policy = 'open' OR st.x = s.owner_id
                OR EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = st.x))
        UNION ALL
        SELECT w.peer_id::bytea, 'changed', v_current
          FROM oracle_watches w
         WHERE v_current IS NOT NULL
           AND w.space_id = s.space_id
           AND w.peer_id <> p_author
           AND w.peer_id <> (SELECT v.author_id FROM oracle_versions v WHERE v.post_id = v_current)
           AND NOT EXISTS (SELECT 1 FROM mailbox_deliveries md
                            WHERE md.recipient_id = w.peer_id AND md.post_id = v_current)
           -- One delivery of a post to a mailbox: a watcher this version made out
           -- of date is told above. Nothing else here delivers v_current.
           AND w.peer_id <> ALL (stale)
           AND EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.peer_id = w.peer_id)
    ), cited AS (
      SELECT DISTINCT src.author_id::bytea AS peer, 'cited'::text AS reason, pid AS post
        FROM post_sources ps
        JOIN posts src ON src.post_id = ps.source_id
       WHERE ps.post_id = pid
         AND src.author_id <> p_author
         AND src.author_id <> ALL (coalesce(p_quiet, '{}'::bytea[]))
         AND NOT EXISTS (SELECT 1 FROM others o WHERE o.peer = src.author_id AND o.post = pid)
         AND (s.oracle OR s.join_policy = 'open' OR src.author_id = s.owner_id
              OR EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = src.author_id))
         AND (NOT v_no_role OR src.author_id = s.owner_id)
         AND NOT (v_no_role AND EXISTS (SELECT 1 FROM message_blocks mbk
                                         WHERE mbk.blocker_id = src.author_id AND mbk.blocked_id = p_author))
         AND EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.peer_id = src.author_id)
    )
    SELECT coalesce(array_agg(u.peer ORDER BY u.peer, u.reason), '{}'::bytea[]),
           coalesce(array_agg(u.reason ORDER BY u.peer, u.reason), '{}'::text[]),
           coalesce(array_agg(u.post ORDER BY u.peer, u.reason), '{}'::uuid[])
      INTO d_peers, d_reasons, d_posts
      FROM (SELECT o.peer, o.reason, o.post FROM others o
            UNION ALL
            SELECT c.peer, c.reason, c.post FROM cited c) u;
  END IF;

  IF cardinality(d_peers) > 0 THEN
    -- Every mailbox is locked before any is written, in ascending peer order, which is
    -- the lock order, and the ones locked are the ones checked: a recipient with no
    -- mailbox is refused, the lowest named.
    SELECT coalesce(array_agg(l.peer), '{}'::bytea[]) INTO held
      FROM (SELECT mb.peer_id::bytea AS peer FROM mailboxes mb
             WHERE mb.peer_id = ANY(d_peers) ORDER BY mb.peer_id FOR UPDATE) l;
    IF cardinality(held) < (SELECT count(DISTINCT q.x) FROM unnest(d_peers) q(x)) THEN
      SELECT q.x INTO r FROM unnest(d_peers) q(x) WHERE q.x <> ALL (held) ORDER BY q.x LIMIT 1;
      RAISE EXCEPTION 'RECIPIENT_NOT_REGISTERED' USING DETAIL = encode(r, 'hex');
    END IF;
    -- Each mailbox moves on by as many notices as it takes, numbered in the order
    -- above, so its numbers stay gap-free.
    WITH wanted AS (
      SELECT u.peer, u.reason, u.post,
             row_number() OVER (PARTITION BY u.peer ORDER BY u.i) AS k
        FROM unnest(d_peers, d_reasons, d_posts) WITH ORDINALITY AS u(peer, reason, post, i)
    ), bumped AS (
      UPDATE mailboxes mb SET last_seq = mb.last_seq + x.c
        FROM (SELECT wt.peer, count(*) AS c FROM wanted wt GROUP BY wt.peer) x
       WHERE mb.peer_id = x.peer
      RETURNING mb.peer_id::bytea AS peer, mb.last_seq - x.c AS base
    ), made AS (
      INSERT INTO mailbox_deliveries AS dl (recipient_id, mailbox_seq, post_id, space_id, reason)
      SELECT wt.peer, b.base + wt.k, wt.post, s.space_id, wt.reason
        FROM wanted wt JOIN bumped b ON b.peer = wt.peer
      RETURNING dl.recipient_id::bytea AS recipient, dl.mailbox_seq, dl.reason
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object('recipient', encode(made.recipient, 'hex'),
                                                 'mailbox_seq', made.mailbox_seq::text,
                                                 'reason', made.reason)
                              ORDER BY made.recipient, made.mailbox_seq), '[]'::jsonb)
      INTO delivered FROM made;
  END IF;

  RETURN jsonb_build_object('post_id', pid, 'seq', n::text, 'posted_at', ts,
                            'replayed', false, 'delivered', delivered,
                            'space_id', s.space_id,
                            'object_id', encode(v_object_id, 'hex'),
                            'chain_hash', encode(v_link, 'hex'),
                            'signed', p_signature IS NOT NULL,
                            'sealed', v_sealed)
         || CASE WHEN p_alg = 'connection' THEN jsonb_build_object('signed_by', 'connection') ELSE '{}'::jsonb END
         || CASE WHEN v_no_role THEN jsonb_build_object('no_role', true) ELSE '{}'::jsonb END
         || CASE WHEN v_oracle IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('oracle', v_oracle) END;
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.append_post(text, bytea, text, text, text, jsonb, jsonb, bytea[], uuid, uuid, uuid, uuid, jsonb, text, integer, bytea, bytea, text, bytea, jsonb, text[], bytea, integer, integer, bytea[], bytea, bytea, integer, integer, bytea)
TO schellingaf_api;
