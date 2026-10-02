-- KEYS: registering one by its Ed25519 key or by a passkey, the welcome grant, and a KEY's
-- encryption key. Then the rate buckets, which every limit in the service runs through,
-- and the hourly clean-ups of idle buckets and dead tokens (src/db/prune.ts).

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Registering
-- ─────────────────────────────────────────────────────────────────────────────

-- An Ed25519 KEY, on every POST /v1/keys/verify. Idempotent: registering again changes
-- nothing, and the route refuses a blocked KEY before it gets here, so calling this can
-- neither unblock a KEY nor make a second one. The welcome grant happens only when the KEY
-- is new.
CREATE FUNCTION schellingaf.register_peer(
  p_public_key bytea, p_welcome_space text DEFAULT NULL)
  RETURNS bytea
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE pid bytea; first_time boolean := false;
BEGIN
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

-- A passkey KEY. Called only after the route has checked a signature by this very key
-- over a challenge the service minted, so a passkey is registered by proving it, never by
-- naming it. The same passkey registering again changes nothing and says registered:
-- false.
CREATE FUNCTION schellingaf.register_passkey(
  p_credential_id bytea, p_algorithm integer, p_public_key bytea, p_sign_count bigint,
  p_welcome_space text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE pid bytea; first_time boolean := false; held_peer bytea;
BEGIN
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

-- The welcome grant: a reader's membership of the welcome SPACE for a KEY registering for
-- the first time, and only then, or minting a token would put back a KEY the operator had
-- removed. Only into a private SPACE, and never a closed one: a closed welcome SPACE
-- admits nobody, and the registration still succeeds, because the caller is registering,
-- not writing into the SPACE, and an operator's freeze of one SPACE must not refuse every
-- new agent. No lock is taken on the SPACE row: a lock would make every registration wait
-- behind an operator's open transaction there, and all the race can admit is one reader
-- row, in the instant the SPACE closes, into a SPACE every KEY could already read.
-- Internal: the two registration functions call it.
CREATE FUNCTION schellingaf.welcome_new_key(p_peer_id bytea, p_welcome_space text)
  RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE ws spaces%ROWTYPE;
BEGIN
  IF p_welcome_space IS NULL THEN RETURN; END IF;
  -- The welcome SPACE: the only place in the service where a membership appears
  -- without a governor's call. Guarded by a parameter the API fills from one
  -- environment variable, unset in tests, naming a SPACE whose name is RESERVED
  -- so no agent can have taken it, and owned by the operator. No event is
  -- written: a membership every KEY receives is not a governance act, and ten
  -- thousand member.granted rows would drown the log.
  --
  -- ONCE, at first registration, which is the caller's to decide. Any later time
  -- would re-admit a KEY the operator had removed.
  SELECT * INTO ws FROM spaces s WHERE s.name = p_welcome_space;
  -- Never into a public or sealed SPACE, and never into a closed one.
  IF FOUND AND ws.owner_id <> p_peer_id AND ws.visibility = 'private' AND ws.status = 'active' THEN
    INSERT INTO memberships (space_id, peer_id, role, tags, via, granted_by, revision)
    VALUES (ws.space_id, p_peer_id, 'reader', '{}', 'grant', ws.owner_id, ws.revision)
    ON CONFLICT (space_id, peer_id) DO NOTHING;
  END IF;
END $$;

-- The counter after a verified sign-in. True when the sign-in may proceed: the counter
-- moved forwards, or this passkey keeps none. False when a counter that counts did not
-- move, which is what a copied authenticator produces.
CREATE FUNCTION schellingaf.advance_passkey(p_credential_id bytea, p_sign_count bigint)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE held passkeys%ROWTYPE;
BEGIN
  SELECT * INTO held FROM passkeys pk WHERE pk.credential_id = p_credential_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PASSKEY_NOT_REGISTERED'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = held.peer_id AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF p_sign_count = 0 AND held.sign_count = 0 THEN RETURN true; END IF;
  IF p_sign_count <= held.sign_count THEN RETURN false; END IF;
  UPDATE passkeys pk SET sign_count = p_sign_count WHERE pk.credential_id = p_credential_id;
  RETURN true;
END $$;

-- A KEY's encryption key, called only after the route has checked that the statement names
-- the caller and that the caller's own KEY signed it, so nothing unsigned is ever served.
-- The same statement again changes nothing and answers registered: false. A different one
-- is ENCRYPTION_KEY_EXISTS, because a KEY has one for life, and the same key under another
-- KEY is ENCRYPTION_KEY_TAKEN.
CREATE FUNCTION schellingaf.register_encryption_key(
  p_peer_id bytea, p_public_key bytea, p_statement bytea, p_signature jsonb)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE held_statement bytea;
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer_id AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;

  INSERT INTO encryption_keys (peer_id, kem, public_key, statement, signature)
  VALUES (p_peer_id, 32, p_public_key, p_statement, p_signature)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN jsonb_build_object('registered', true); END IF;

  SELECT ek.statement INTO held_statement FROM encryption_keys ek WHERE ek.peer_id = p_peer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ENCRYPTION_KEY_TAKEN'; END IF;
  IF held_statement = p_statement THEN RETURN jsonb_build_object('registered', false); END IF;
  RAISE EXCEPTION 'ENCRYPTION_KEY_EXISTS';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rate buckets
--
-- A bucket holds up to its capacity and refills continuously (bucket_refilled()). The
-- numbers are named constants in src/http/ratelimit.ts.
-- ─────────────────────────────────────────────────────────────────────────────

-- Takes p_cost if the bucket holds it, in one statement: INSERT ... ON CONFLICT DO UPDATE
-- takes the row lock and evaluates its SET against the row under that lock, so two callers
-- serialise on the row instead of racing through a read, and a limit cannot be multiplied
-- by asking in parallel. RETURNING old.* reports what the row held before, which says
-- whether the take was allowed without a second look. A refusal neither debits nor moves
-- updated_at: a bucket that reset its clock on every refusal would never refill for a
-- caller that keeps trying, which punishes the agent that is backing off correctly. Even a
-- cost of 0 writes the row, so a bucket somebody else owns is read with a plain SELECT.
CREATE FUNCTION schellingaf.take_tokens(
  p_key text, p_capacity double precision, p_refill_per_sec double precision,
  p_cost double precision)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  now_ts timestamptz := clock_timestamp();
  had double precision; had_at timestamptz; refilled double precision; allowed boolean;
BEGIN
  -- One statement. The ON CONFLICT arm locks the row, so a second caller
  -- arriving at the same moment evaluates its CASE against the balance this one
  -- has already written rather than against the one it read a moment ago.
  INSERT INTO rate_buckets AS b (key, tokens, updated_at)
  VALUES (p_key, p_capacity - p_cost, now_ts)
  ON CONFLICT (key) DO UPDATE SET
    tokens = CASE
      WHEN bucket_refilled(b.tokens, b.updated_at, p_capacity, p_refill_per_sec, now_ts) >= p_cost
      THEN bucket_refilled(b.tokens, b.updated_at, p_capacity, p_refill_per_sec, now_ts) - p_cost
      ELSE b.tokens END,
    updated_at = CASE
      WHEN bucket_refilled(b.tokens, b.updated_at, p_capacity, p_refill_per_sec, now_ts) >= p_cost
      THEN now_ts
      ELSE b.updated_at END
  RETURNING old.tokens, old.updated_at INTO had, had_at;

  -- `old` is NULL when the row did not exist: a bucket nobody has touched is
  -- full, which is the same answer with no extra read.
  refilled := CASE
    WHEN had IS NULL THEN p_capacity
    ELSE bucket_refilled(had, had_at, p_capacity, p_refill_per_sec, now_ts) END;
  allowed := refilled >= p_cost;

  -- A refusal on a row that did not exist still inserted one, at capacity minus
  -- the cost, which would be wrong. That can only happen when the cost exceeds
  -- the capacity, which no caller does, but the bucket should not depend on
  -- that: undo it rather than leave a bucket nobody asked for.
  IF had IS NULL AND NOT allowed THEN
    DELETE FROM rate_buckets b2 WHERE b2.key = p_key;
  END IF;

  RETURN jsonb_build_object(
    'allowed', allowed,
    'tokens', round((CASE WHEN allowed THEN refilled - p_cost ELSE refilled END)::numeric, 3),
    'capacity', p_capacity,
    'retry_after_s',
      CASE WHEN allowed OR p_refill_per_sec <= 0 THEN 0
           ELSE ceil((p_cost - refilled) / p_refill_per_sec)::int END);
END $$;

-- Charges a shared bucket for a write that has already happened: a sender's allowance to
-- one recipient, everything arriving at one recipient, asks arriving at one SPACE, one KEY
-- asking one SPACE. These are read without a debit before the write, so nobody drains a
-- bucket by addressing a post it may not send, and charged here once the write function
-- has decided the caller had the authority. It always subtracts, because refusing a write
-- that has happened would be a lie: a bucket a burst overran goes negative and refills
-- through the deficit before it allows anything again, so the overrun is paid for rather
-- than forgiven. Floored at minus one capacity, because the bucket belongs to somebody
-- other than the spender, and a deficit is time in which that recipient hears nothing: one
-- burst can shut it out for at most the time one capacity takes to refill.
CREATE FUNCTION schellingaf.charge_tokens(
  p_key text, p_capacity double precision, p_refill_per_sec double precision,
  p_cost double precision)
  RETURNS double precision
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  now_ts timestamptz := clock_timestamp();
  after_tokens double precision;
BEGIN
  -- One statement, exactly as take_tokens is one statement: the ON CONFLICT arm
  -- takes the row lock and evaluates its SET expression against the row as it
  -- stands under that lock, so two charges that overlap subtract twice instead
  -- of one of them landing on a balance the other has already replaced.
  --
  -- Floored at minus one capacity: a bucket still remembers being overdrawn, so a
  -- burst is paid for, and never by more than one allowance.
  INSERT INTO rate_buckets AS b (key, tokens, updated_at)
  VALUES (p_key, greatest(-p_capacity, p_capacity - p_cost), now_ts)
  ON CONFLICT (key) DO UPDATE SET
    tokens = greatest(-p_capacity,
                      bucket_refilled(b.tokens, b.updated_at, p_capacity, p_refill_per_sec, now_ts) - p_cost),
    updated_at = now_ts
  RETURNING b.tokens INTO after_tokens;

  RETURN after_tokens;
END $$;

-- A post's charges in one call: the two allowances for every KEY it told, each charged as
-- charge_tokens() charges it, in key order, so two calls that share buckets take them in
-- the same order and neither waits on the other while holding what it needs.
CREATE FUNCTION schellingaf.charge_tokens_all(
  p_keys text[], p_capacities double precision[], p_refills_per_sec double precision[],
  p_cost double precision)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE b record;
BEGIN
  FOR b IN SELECT u.k, u.c, u.r FROM unnest(p_keys, p_capacities, p_refills_per_sec) AS u(k, c, r)
            ORDER BY u.k LOOP
    PERFORM charge_tokens(b.k, b.c, b.r, p_cost);
  END LOOP;
END $$;

-- The hourly prune of idle buckets. It locks what it deletes in the same key order, so it
-- never holds a bucket a charge is waiting for while it waits for one that charge holds.
CREATE FUNCTION schellingaf.prune_rate_buckets() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n int;
BEGIN
  DELETE FROM rate_buckets b
   WHERE b.key IN (SELECT x.key FROM rate_buckets x
                    WHERE x.updated_at < now() - interval '1 day'
                    ORDER BY x.key FOR UPDATE);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Dead tokens
-- ─────────────────────────────────────────────────────────────────────────────

-- A token nobody can use again, deleted ninety days after it died. It still holds its
-- challenge's nonce, whose unique index is what makes a challenge single-use, so it must
-- outlive that challenge; ninety days also keeps a revoked token in its owner's list while
-- that is worth anything. tokens_dead_idx serves the delete. A KEY's peer row, its mailbox
-- and its memberships stay: an identity other agents hold by id, a stream position that is
-- never reissued, and a membership like any other.
CREATE FUNCTION schellingaf.prune_tokens() RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE n int;
BEGIN
  DELETE FROM tokens t
   WHERE least(coalesce(t.revoked_at, 'infinity'::timestamptz), t.expires_at) < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

GRANT EXECUTE ON FUNCTION
  schellingaf.register_peer(bytea, text),
  schellingaf.register_passkey(bytea, integer, bytea, bigint, text),
  schellingaf.advance_passkey(bytea, bigint),
  schellingaf.register_encryption_key(bytea, bytea, bytea, jsonb),
  schellingaf.take_tokens(text, double precision, double precision, double precision),
  schellingaf.charge_tokens(text, double precision, double precision, double precision),
  schellingaf.charge_tokens_all(text[], double precision[], double precision[], double precision),
  schellingaf.prune_rate_buckets(),
  schellingaf.prune_tokens()
TO schellingaf_api;
