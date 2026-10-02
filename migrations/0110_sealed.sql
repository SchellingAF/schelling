-- Sealed SPACES: keepers, stamps, locks and key changes.
--
-- A sealed SPACE holds headers and ciphertexts under one key its whole membership shares,
-- and each member is handed that key in a lock of its own. Keepers hand it over: the owner,
-- and the KEYS the owner names in a keeper list it signs. Only a keeper's own software
-- makes a lock, so the service can never slip in a reader; it can only drop one.
-- Membership is granted as in any SPACE, but membership alone is the service's word, so a
-- keeper hands the key only to a member somebody the owner trusts vouched for
-- (sealed_vouched()). A member with no lock yet is waiting for a keeper, and one nobody
-- vouched for waits for a stamp.
--
-- The key changes in generations, one change at a time: a keeper stages the next with its
-- commitment and a back link to the one before, locks it for every member vouched for, and
-- activates it once all of them hold a lock; the older generations' locks then go, since
-- the chain of back links reaches them, which is how a newcomer reads the history. A
-- removed member stops being served at once, and stops being able to open new posts once
-- the key has changed.
--
-- What the database refuses, since it can open nothing: plain content in a sealed SPACE and
-- sealed parts elsewhere; a header that does not name the SPACE, the author, the kind and
-- the routing the service acts on (check_post_header()); a post under any key but the one
-- in use; a member, owner or successor with no encryption key; any code or link, because
-- whoever holds one gets in; an oracle, or a SPACE that admits by invite; and locks, key
-- changes and keeper lists from anybody who may not make them. The tables and those guards
-- are 0102_tables.sql's; the formats are content/sealed.md.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Keepers and vouching
-- ─────────────────────────────────────────────────────────────────────────────

-- A keeper: the owner; and a KEY the latest keeper list names, while it is a member, if the
-- owner now in place signed that list. After a hand-over a list the old owner signed names
-- nobody, and a keeper that has left keeps nothing of the role.
CREATE FUNCTION schellingaf.is_keeper(p_space uuid, p_peer bytea) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = p_space AND s.owner_id = p_peer)
      OR EXISTS (SELECT 1 FROM sealed_keeper_lists l
                   JOIN spaces s ON s.space_id = l.space_id
                  WHERE l.space_id = p_space AND l.signed_by = s.owner_id AND p_peer = ANY(l.keepers)
                    AND l.revision = (SELECT max(l2.revision) FROM sealed_keeper_lists l2 WHERE l2.space_id = p_space)
                    AND EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = p_space AND mm.peer_id = p_peer))
$$;

-- Whom a SPACE's owner vouches for, by the latest keeper list: its admission, its keepers,
-- and the KEYS whose stamp counts, which are the owner, the keepers and the stampers. With
-- no list, the owner alone, admitting nobody by itself. A list the owner before signed
-- still counts until the owner now in place signs one, if it names that owner among its
-- keepers, which is how a SPACE is handed over (sealed_owner_has_key()), and then its
-- signer's stamps count too: the members it vouched for stay vouched for. Internal.
CREATE FUNCTION schellingaf.sealed_vouching(p_space uuid,
  OUT o_owner bytea, OUT o_admission text, OUT o_keepers bytea[], OUT o_issuers bytea[])
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE l sealed_keeper_lists%ROWTYPE; was bytea;
BEGIN
  SELECT sp.owner_id INTO o_owner FROM spaces sp WHERE sp.space_id = p_space;
  o_admission := 'stamped';
  o_keepers := '{}'::bytea[];
  o_issuers := ARRAY[o_owner];
  SELECT * INTO l FROM sealed_keeper_lists k WHERE k.space_id = p_space ORDER BY k.revision DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF l.signed_by <> o_owner THEN
    SELECT decode(e.payload->>'owner_was', 'hex') INTO was FROM space_events e
     WHERE e.space_id = p_space AND e.event = 'space.handed_over' AND e.payload->>'owner' = encode(o_owner, 'hex')
     ORDER BY e.revision DESC LIMIT 1;
    IF was IS DISTINCT FROM l.signed_by::bytea OR NOT (o_owner = ANY(l.keepers)) THEN RETURN; END IF;
  END IF;
  o_admission := l.admission;
  o_keepers := l.keepers;
  o_issuers := ARRAY[o_owner, l.signed_by::bytea] || l.keepers || l.stampers;
END $$;

-- Whether a keeper may hand a SPACE's key to a KEY: the owner; a keeper of the list above;
-- anybody, under a list that admits every request; otherwise a KEY whose stamp comes from a
-- KEY whose stamp counts and has not run out. Membership alone is not enough: an admin or a
-- coordinator can grant it, and so can the operator, and none of them is anybody the owner
-- signed for. This is what the api read out of lists and stamps; a keeper's own software
-- checks every signature itself before it locks, and hands nothing to a KEY this refuses.
-- Internal: it answers for any KEY in any sealed SPACE, and hand_locks() and
-- sealed_unlocked() ask it for their callers.
CREATE FUNCTION schellingaf.sealed_vouched(p_space uuid, p_peer bytea) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM sealed_vouching(p_space);
  IF p_peer = v.o_owner OR v.o_admission = 'open' OR p_peer = ANY(v.o_keepers) THEN RETURN true; END IF;
  RETURN EXISTS (SELECT 1 FROM sealed_stamps st
                  WHERE st.space_id = p_space AND st.peer_id = p_peer
                    AND (st.not_after IS NULL OR st.not_after >= now())
                    AND st.issuer = ANY(v.o_issuers));
END $$;

-- The owner and every member, each with the rule above, in one pass: what a key change must
-- reach, which at a hundred thousand members is no place for a call per member. The same
-- rule as sealed_vouched(), and test/sealed-spaces.test.ts holds the two to it. Internal.
CREATE FUNCTION schellingaf.sealed_members(p_space uuid)
  RETURNS TABLE (peer_id bytea, vouched boolean)
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v record;
BEGIN
  SELECT * INTO v FROM sealed_vouching(p_space);
  RETURN QUERY
    SELECT m.member::bytea,
           (m.member = v.o_owner OR v.o_admission = 'open' OR m.member = ANY(v.o_keepers)
            OR EXISTS (SELECT 1 FROM sealed_stamps st
                        WHERE st.space_id = p_space AND st.peer_id = m.member
                          AND (st.not_after IS NULL OR st.not_after >= now())
                          AND st.issuer = ANY(v.o_issuers)))
      FROM (SELECT v.o_owner AS member UNION SELECT mm.peer_id::bytea FROM memberships mm WHERE mm.space_id = p_space) m;
END $$;

-- A keeper acted: every member is shown when that last happened. Internal.
CREATE FUNCTION schellingaf.keeper_acted(p_space uuid, p_peer bytea) RETURNS void
  LANGUAGE sql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  INSERT INTO sealed_keeping (space_id, acted_at, acted_by) VALUES (p_space, now(), p_peer)
    ON CONFLICT (space_id) DO UPDATE SET acted_at = EXCLUDED.acted_at, acted_by = EXCLUDED.acted_by
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- What keepers do
-- ─────────────────────────────────────────────────────────────────────────────

-- A sealed SPACE and its first key, in one step: the owner's software chose its id, made
-- generation 1's secret, and locked it for the owner. A keeper list comes later, when the
-- owner names keepers; until then the owner is the one keeper.
CREATE FUNCTION schellingaf.create_sealed_space(
  p_owner bytea, p_space_id uuid, p_name text, p_title text, p_description text,
  p_signed_only boolean, p_categories text[], p_under text[], p_main_under text[],
  p_commitment bytea, p_lock bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_owner AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF p_space_id IS NULL OR octet_length(p_commitment) IS DISTINCT FROM 32 OR octet_length(p_lock) IS DISTINCT FROM 80 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a sealed SPACE is made with its id, its first commitment and the owner''s lock';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM encryption_keys ek WHERE ek.peer_id = p_owner) THEN
    RAISE EXCEPTION 'ENCRYPTION_KEY_MISSING' USING DETAIL = encode(p_owner, 'hex');
  END IF;
  IF EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = p_space_id) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'space_id is taken: choose another';
  END IF;
  r := create_space(p_owner, p_name, p_title, p_description, 'request', 'sealed', p_signed_only,
                    p_categories, p_under, p_main_under, false, NULL, p_space_id);
  INSERT INTO sealed_generations (space_id, generation, commitment, back, created_by, staged_revision, activated_at, activated_revision)
  VALUES (p_space_id, 1, p_commitment, NULL, p_owner, (r->>'revision')::bigint, now(), (r->>'revision')::bigint);
  INSERT INTO sealed_locks (space_id, generation, peer_id, sender_id, lock)
  VALUES (p_space_id, 1, p_owner, p_owner, p_lock);
  INSERT INTO sealed_lock_senders (space_id, generation, sender_id) VALUES (p_space_id, 1, p_owner);
  RETURN r || jsonb_build_object('sealed', jsonb_build_object('generation', '1'));
END $$;

-- A new keeper list: only the owner, only the next revision, and the api has checked the
-- owner's signature over the list's exact bytes and read these fields out of it.
CREATE FUNCTION schellingaf.set_keeper_list(
  p_space_name text, p_caller bytea, p_revision bigint, p_list bytea, p_signature jsonb,
  p_keepers bytea[], p_admission text, p_stampers bytea[], p_change_every integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; latest bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF s.owner_id <> p_caller THEN RAISE EXCEPTION 'NOT_A_KEEPER' USING DETAIL = 'only the owner signs the keeper list'; END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_caller AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF s.owner_id <> p_caller THEN RAISE EXCEPTION 'NOT_A_KEEPER' USING DETAIL = 'only the owner signs the keeper list'; END IF;
  IF p_caller = ANY(p_keepers) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'the owner is always a keeper and never listed';
  END IF;
  SELECT coalesce(max(l.revision), 0) INTO latest FROM sealed_keeper_lists l WHERE l.space_id = s.space_id;
  IF p_revision <> latest + 1 THEN
    RAISE EXCEPTION 'KEEPER_LIST_STALE' USING DETAIL = (latest + 1)::text;
  END IF;
  INSERT INTO sealed_keeper_lists (space_id, revision, list, signature, signed_by, keepers, admission, stampers, change_every)
  VALUES (s.space_id, p_revision, p_list, p_signature, p_caller, p_keepers, p_admission, p_stampers, p_change_every);
  RETURN jsonb_build_object('space', s.name, 'revision', p_revision::text);
END $$;

-- A stamp for a SPACE, for its keepers to read: put by the KEY it names before it asks to
-- join, or by a keeper that stamped a KEY itself, which is how a keeper admits by hand. A
-- newer one replaces it; the api has checked who signed it, and read the issuer and the
-- time it runs out from it.
CREATE FUNCTION schellingaf.put_stamp(
  p_space_name text, p_caller bytea, p_peer bytea, p_stamp bytea, p_signature jsonb, p_issuer bytea,
  p_not_after timestamptz)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_caller AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  -- Another KEY's stamp only from the keeper that issued it: anybody else could replace
  -- a member's good stamp with one that counts for nothing.
  IF p_peer <> p_caller AND (p_issuer <> p_caller OR NOT is_keeper(s.space_id, p_caller)) THEN
    RAISE EXCEPTION 'NOT_A_KEEPER' USING DETAIL = 'a stamp is put by the KEY it names, or by the keeper that issued it';
  END IF;
  -- And a keeper never replaces another issuer's stamp that still vouches for the KEY:
  -- that one is kept, and the KEY stays vouched for by it, which is all the keeper was
  -- after.
  IF p_peer <> p_caller AND EXISTS (
       SELECT 1 FROM sealed_stamps st, sealed_vouching(s.space_id) v
        WHERE st.space_id = s.space_id AND st.peer_id = p_peer AND st.issuer <> p_caller
          AND (st.not_after IS NULL OR st.not_after >= now()) AND st.issuer::bytea = ANY(v.o_issuers)) THEN
    RETURN jsonb_build_object('space', s.name, 'stamped', false, 'kept', 'another issuer''s stamp, which still vouches for that KEY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_issuer) THEN
    RAISE EXCEPTION 'PEER_NOT_FOUND' USING DETAIL = encode(p_issuer, 'hex');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer) THEN
    RAISE EXCEPTION 'PEER_NOT_FOUND' USING DETAIL = encode(p_peer, 'hex');
  END IF;
  INSERT INTO sealed_stamps (space_id, peer_id, stamp, signature, issuer, not_after)
  VALUES (s.space_id, p_peer, p_stamp, p_signature, p_issuer, p_not_after)
    ON CONFLICT (space_id, peer_id) DO UPDATE
      SET stamp = EXCLUDED.stamp, signature = EXCLUDED.signature, issuer = EXCLUDED.issuer,
          not_after = EXCLUDED.not_after, created_at = now();
  IF p_peer <> p_caller THEN PERFORM keeper_acted(s.space_id, p_caller); END IF;
  RETURN jsonb_build_object('space', s.name, 'stamped', true);
END $$;

-- Locks from a keeper, for the generation in use or the one staged: for the owner, for
-- members, and for the KEY a standing hand-over of the SPACE is offered to. A member
-- already holding one for that generation keeps it, and a retry changes nothing. The locks
-- name the commitment they were made for: a change abandoned and staged again takes the
-- same number, and a keeper's chunk for the abandoned one, arriving late, would otherwise
-- be kept in place of the right lock. Refused for a KEY nobody vouched for.
CREATE FUNCTION schellingaf.hand_locks(
  p_space_name text, p_caller bytea, p_generation bigint, p_commitment bytea, p_peers bytea[], p_locks bytea[])
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; g sealed_generations%ROWTYPE; active bigint; i int; added int := 0;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  -- Unlocked pre-check, so a KEY that may not lock waits behind nobody.
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  IF p_peers IS NULL OR p_locks IS NULL OR cardinality(p_peers) <> cardinality(p_locks)
     OR cardinality(p_peers) < 1 OR cardinality(p_peers) > 1000 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'one to 1000 locks, one for each KEY named';
  END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_caller AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  SELECT max(x.generation) INTO active FROM sealed_generations x
   WHERE x.space_id = s.space_id AND x.activated_at IS NOT NULL;
  SELECT * INTO g FROM sealed_generations sg WHERE sg.space_id = s.space_id AND sg.generation = p_generation;
  IF NOT FOUND OR (g.activated_at IS NOT NULL AND p_generation IS DISTINCT FROM active)
     OR p_commitment IS DISTINCT FROM g.commitment::bytea THEN
    RAISE EXCEPTION 'KEY_CHANGED' USING DETAIL = coalesce(active, 0)::text;
  END IF;
  FOR i IN 1 .. cardinality(p_peers) LOOP
    IF octet_length(p_locks[i]) IS DISTINCT FROM 80 OR octet_length(p_peers[i]) IS DISTINCT FROM 32 THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a lock is 80 bytes, for a peer id of 32';
    END IF;
    -- Never for anyone else: a lock for a KEY the SPACE never admitted would hand it
    -- the key, and the service would have let a keeper's mistake through.
    IF p_peers[i] <> s.owner_id
       AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_peers[i])
       AND NOT EXISTS (SELECT 1 FROM invites iv
                        WHERE iv.space_id = s.space_id AND iv.for_peer = p_peers[i] AND iv.hands_over
                          AND iv.role = 'owner' AND iv.revoked_at IS NULL AND iv.uses = 0
                          AND (iv.expires_at IS NULL OR iv.expires_at > now())) THEN
      RAISE EXCEPTION 'LOCK_RECIPIENT_NOT_A_MEMBER' USING DETAIL = encode(p_peers[i], 'hex');
    END IF;
    -- Nor for a member nobody the owner trusts vouched for: the keeper's own software
    -- refuses first, and this says so for one that did not.
    IF NOT sealed_vouched(s.space_id, p_peers[i]) THEN
      RAISE EXCEPTION 'LOCK_RECIPIENT_NOT_VOUCHED' USING DETAIL = encode(p_peers[i], 'hex');
    END IF;
    INSERT INTO sealed_locks (space_id, generation, peer_id, sender_id, lock)
    VALUES (s.space_id, p_generation, p_peers[i], p_caller, p_locks[i])
      ON CONFLICT DO NOTHING;
    IF FOUND THEN added := added + 1; END IF;
  END LOOP;
  IF added > 0 THEN
    INSERT INTO sealed_lock_senders (space_id, generation, sender_id)
    VALUES (s.space_id, p_generation, p_caller) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM keeper_acted(s.space_id, p_caller);
  RETURN jsonb_build_object('space', s.name, 'generation', p_generation::text, 'added', added);
END $$;

-- The next generation, staged by a keeper, with its commitment and its back link, while no
-- other change is staged. Generation 1 of a SPACE that has none, which is how the
-- replacement recover_space() made for a sealed SPACE gets its first key.
CREATE FUNCTION schellingaf.stage_generation(
  p_space_name text, p_caller bytea, p_generation bigint, p_commitment bytea, p_back bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; active bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  IF octet_length(p_commitment) IS DISTINCT FROM 32
     OR (p_generation = 1 AND p_back IS NOT NULL)
     OR (p_generation > 1 AND octet_length(p_back) IS DISTINCT FROM 48) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a commitment is 32 bytes, and a back link 48, from generation 2 on';
  END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_caller AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  IF EXISTS (SELECT 1 FROM sealed_generations g WHERE g.space_id = s.space_id AND g.activated_at IS NULL) THEN
    RAISE EXCEPTION 'KEY_CHANGE_STAGED';
  END IF;
  SELECT max(g.generation) INTO active FROM sealed_generations g WHERE g.space_id = s.space_id AND g.activated_at IS NOT NULL;
  IF p_generation IS DISTINCT FROM coalesce(active, 0) + 1 THEN
    RAISE EXCEPTION 'KEY_CHANGED' USING DETAIL = coalesce(active, 0)::text;
  END IF;
  INSERT INTO sealed_generations (space_id, generation, commitment, back, created_by, staged_revision)
  VALUES (s.space_id, p_generation, p_commitment, p_back, p_caller, s.revision);
  PERFORM keeper_acted(s.space_id, p_caller);
  RETURN jsonb_build_object('space', s.name, 'generation', p_generation::text, 'staged', true);
END $$;

-- The staged generation, activated, only once the owner and every member vouched for hold a
-- lock for it. Then the older generations' locks go, since the back links reach them, and
-- so do the new one's locks for KEYS that left while it was staged; a post sealed under the
-- old key is refused from here on (KEY_CHANGED). The new key counts who has left from the
-- revision it was staged at, since a KEY that left meanwhile may already have opened its
-- lock: the next change is due for it.
CREATE FUNCTION schellingaf.activate_generation(p_space_name text, p_caller bytea, p_generation bigint)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; missing bigint; pruned bigint; dropped bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_caller AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sealed_generations g
                  WHERE g.space_id = s.space_id AND g.generation = p_generation AND g.activated_at IS NULL) THEN
    RAISE EXCEPTION 'KEY_CHANGED' USING DETAIL = coalesce((
      SELECT max(x.generation) FROM sealed_generations x WHERE x.space_id = s.space_id AND x.activated_at IS NOT NULL), 0)::text;
  END IF;
  SELECT count(*) INTO missing FROM sealed_members(s.space_id) m
   WHERE m.vouched
     AND NOT EXISTS (SELECT 1 FROM sealed_locks l
                      WHERE l.space_id = s.space_id AND l.generation = p_generation AND l.peer_id = m.peer_id);
  IF missing > 0 THEN RAISE EXCEPTION 'LOCKS_MISSING' USING DETAIL = missing::text; END IF;
  UPDATE sealed_generations g SET activated_at = now(), activated_revision = g.staged_revision
   WHERE g.space_id = s.space_id AND g.generation = p_generation;
  DELETE FROM sealed_locks l
   WHERE l.space_id = s.space_id AND l.generation = p_generation AND l.peer_id <> s.owner_id
     AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = l.peer_id)
     AND NOT EXISTS (SELECT 1 FROM invites iv
                      WHERE iv.space_id = s.space_id AND iv.for_peer = l.peer_id AND iv.hands_over
                        AND iv.role = 'owner' AND iv.revoked_at IS NULL AND iv.uses = 0
                        AND (iv.expires_at IS NULL OR iv.expires_at > now()));
  GET DIAGNOSTICS dropped = ROW_COUNT;
  DELETE FROM sealed_locks l WHERE l.space_id = s.space_id AND l.generation < p_generation;
  GET DIAGNOSTICS pruned = ROW_COUNT;
  DELETE FROM sealed_lock_senders ls WHERE ls.space_id = s.space_id AND ls.generation < p_generation;
  PERFORM keeper_acted(s.space_id, p_caller);
  RETURN jsonb_build_object('space', s.name, 'generation', p_generation::text, 'activated', true,
                            'locks_pruned', pruned, 'locks_of_leavers', dropped);
END $$;

-- A change still staged, abandoned by a keeper: its locks and itself go, since nothing was
-- ever sealed under it. A keeper whose software stopped halfway, or lost the new secret,
-- would otherwise leave a change nobody can finish, and every later one waits behind it
-- (KEY_CHANGE_STAGED).
CREATE FUNCTION schellingaf.abandon_generation(p_space_name text, p_caller bytea, p_generation bigint)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; dropped bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_caller AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sealed_generations g
                  WHERE g.space_id = s.space_id AND g.generation = p_generation AND g.activated_at IS NULL) THEN
    RAISE EXCEPTION 'KEY_CHANGED' USING DETAIL = coalesce((
      SELECT max(x.generation) FROM sealed_generations x WHERE x.space_id = s.space_id AND x.activated_at IS NOT NULL), 0)::text;
  END IF;
  DELETE FROM sealed_locks l WHERE l.space_id = s.space_id AND l.generation = p_generation;
  GET DIAGNOSTICS dropped = ROW_COUNT;
  DELETE FROM sealed_lock_senders ls WHERE ls.space_id = s.space_id AND ls.generation = p_generation;
  DELETE FROM sealed_generations g WHERE g.space_id = s.space_id AND g.generation = p_generation;
  PERFORM keeper_acted(s.space_id, p_caller);
  RETURN jsonb_build_object('space', s.name, 'generation', p_generation::text, 'abandoned', true, 'locks_dropped', dropped);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- What keepers read
-- ─────────────────────────────────────────────────────────────────────────────

-- The KEYS a generation's lock is still missing for, with what a keeper checks before it
-- locks anything for them: the signing key their peer id names, their encryption key's
-- statement and signature, whether somebody the owner trusts vouched for them, and, for a
-- keeper, the stamp that says so. For any member, a page at a time by peer id: who is
-- waiting for a keeper is no secret from the people already inside. The page starts at its
-- cursor, a bound the index starts from rather than a "p_after IS NULL OR" test, which a
-- generic plan cannot use; the owner, never a member, is left out of the members by id.
CREATE FUNCTION schellingaf.sealed_unlocked(
  p_space_name text, p_caller bytea, p_generation bigint, p_after bytea, p_limit integer)
  RETURNS TABLE (peer_id bytea, public_key bytea, key_type text, passkey_algorithm integer, passkey_key bytea,
                 encryption_public_key bytea, encryption_statement bytea, encryption_signature jsonb,
                 vouched boolean, stamp bytea, stamp_signature jsonb, stamp_issuer bytea)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; v_keeper boolean;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF s.owner_id <> p_caller
     AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_caller) THEN
    RAISE EXCEPTION 'READ_DENIED';
  END IF;
  v_keeper := is_keeper(s.space_id, p_caller);
  RETURN QUERY
    SELECT m.peer_id::bytea, pe.public_key::bytea, pe.key_type, pk.algorithm, pk.public_key,
           ek.public_key::bytea, ek.statement, ek.signature,
           sealed_vouched(s.space_id, m.peer_id),
           CASE WHEN v_keeper THEN st.stamp END, CASE WHEN v_keeper THEN st.signature END,
           CASE WHEN v_keeper THEN st.issuer::bytea END
      FROM (SELECT s.owner_id::bytea AS peer_id
             WHERE s.owner_id::bytea > coalesce(p_after, '\x'::bytea)
            UNION ALL
            SELECT mm.peer_id::bytea FROM memberships mm
             WHERE mm.space_id = s.space_id AND mm.peer_id > coalesce(p_after, '\x'::bytea)
               AND mm.peer_id <> s.owner_id) m
      JOIN peers pe ON pe.peer_id = m.peer_id
      JOIN encryption_keys ek ON ek.peer_id = m.peer_id
      LEFT JOIN passkeys pk ON pk.peer_id = m.peer_id
      LEFT JOIN sealed_stamps st ON st.space_id = s.space_id AND st.peer_id = m.peer_id
     WHERE NOT EXISTS (SELECT 1 FROM sealed_locks l
                        WHERE l.space_id = s.space_id AND l.generation = p_generation AND l.peer_id = m.peer_id)
     ORDER BY m.peer_id
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
END $$;

-- Join requests waiting in a sealed SPACE, for a keeper deciding them by the owner's rule:
-- each with what it checks, the requester's signing key, its encryption key's statement and
-- signature, and the stamp it put, if any. Oldest first, from its cursor, as above.
CREATE FUNCTION schellingaf.sealed_requests(
  p_space_name text, p_caller bytea, p_after uuid, p_limit integer)
  RETURNS TABLE (request_id uuid, created_at timestamptz, peer_id bytea, public_key bytea, key_type text,
                 passkey_algorithm integer, passkey_key bytea,
                 encryption_public_key bytea, encryption_statement bytea, encryption_signature jsonb,
                 stamp bytea, stamp_signature jsonb, stamp_issuer bytea)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  RETURN QUERY
    SELECT jr.request_id, jr.created_at, jr.peer_id::bytea, pe.public_key::bytea, pe.key_type,
           pk.algorithm, pk.public_key, ek.public_key::bytea, ek.statement, ek.signature,
           st.stamp, st.signature, st.issuer::bytea
      FROM join_requests jr
      JOIN peers pe ON pe.peer_id = jr.peer_id
      JOIN encryption_keys ek ON ek.peer_id = jr.peer_id
      LEFT JOIN passkeys pk ON pk.peer_id = jr.peer_id
      LEFT JOIN sealed_stamps st ON st.space_id = jr.space_id AND st.peer_id = jr.peer_id
     WHERE jr.space_id = s.space_id AND jr.state = 'pending' AND jr.expires_at > now()
       AND jr.request_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
     ORDER BY jr.request_id
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
END $$;

-- What a keeper needs to know to keep a SPACE, and nobody else is told: how many members
-- vouched for still wait for the key in use, how many nobody vouched for wait for a stamp,
-- how many hold the key with nobody vouching for them now, who has left since the key was
-- made, and whether a KEY that sent locks keeps nothing now, which makes the next change
-- due at once, since a member's software accepts a lock only from a keeper in force. After
-- somebody leaves, a change is due on the owner's change_every, a day unless the owner's
-- list says otherwise.
CREATE FUNCTION schellingaf.sealed_upkeep(p_space_name text, p_caller bytea)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; a sealed_generations%ROWTYPE; l sealed_keeper_lists%ROWTYPE;
        waiting bigint := 0; unvouched bigint := 0; lapsed bigint := 0; departed bigint := 0; first_at timestamptz;
        keeper_left boolean := false; every integer := 86400; progressed timestamptz; keyed boolean;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.visibility <> 'sealed' THEN RAISE EXCEPTION 'SPACE_NOT_SEALED'; END IF;
  IF NOT is_keeper(s.space_id, p_caller) THEN RAISE EXCEPTION 'NOT_A_KEEPER'; END IF;
  SELECT * INTO l FROM sealed_keeper_lists k WHERE k.space_id = s.space_id ORDER BY k.revision DESC LIMIT 1;
  IF FOUND AND l.signed_by = s.owner_id THEN every := l.change_every; END IF;
  SELECT * INTO a FROM sealed_generations g
   WHERE g.space_id = s.space_id AND g.activated_at IS NOT NULL ORDER BY g.generation DESC LIMIT 1;
  keyed := FOUND;
  -- One pass over the members, which may be a hundred thousand: nobody vouches for them;
  -- vouched for and waiting for the key in use; and holding the key in use with nobody
  -- vouching for them now, because a stamp ran out or its stamper was dropped, so they
  -- must lose it as a leaver does.
  SELECT count(*) FILTER (WHERE NOT m.vouched),
         count(*) FILTER (WHERE keyed AND m.vouched AND x.peer_id IS NULL),
         count(*) FILTER (WHERE keyed AND NOT m.vouched AND x.peer_id IS NOT NULL)
    INTO unvouched, waiting, lapsed
    FROM sealed_members(s.space_id) m
    LEFT JOIN sealed_locks x ON x.space_id = s.space_id AND x.generation = a.generation AND x.peer_id = m.peer_id;
  IF keyed THEN
    SELECT count(*), min(e.created_at),
           coalesce(bool_or(e.event = 'space.handed_over'
                            OR decode(CASE e.event WHEN 'member.handed_over' THEN e.payload->>'from'
                                                   ELSE e.payload->>'peer_id' END, 'hex') = ANY(coalesce(l.keepers, '{}'::bytea[]))),
                    false)
      INTO departed, first_at, keeper_left
      FROM space_events e
     WHERE e.space_id = s.space_id AND e.revision > a.activated_revision
       AND e.event IN ('member.revoked', 'member.left', 'member.handed_over', 'space.handed_over');
    IF EXISTS (SELECT 1 FROM sealed_lock_senders ls
                WHERE ls.space_id = s.space_id AND ls.generation = a.generation
                  AND NOT is_keeper(s.space_id, ls.sender_id)) THEN
      keeper_left := true;
      first_at := coalesce(first_at, now());
    END IF;
    IF lapsed > 0 THEN first_at := least(coalesce(first_at, now()), now()); END IF;
  END IF;
  -- When a change under way last moved: a keeper's software abandons one that has not
  -- moved for a while, and never one still being handed out.
  SELECT greatest(g.staged_at, (SELECT max(x.created_at) FROM sealed_locks x
                                 WHERE x.space_id = g.space_id AND x.generation = g.generation))
    INTO progressed
    FROM sealed_generations g WHERE g.space_id = s.space_id AND g.activated_at IS NULL;
  RETURN jsonb_build_object(
    'waiting', waiting,
    'unvouched', unvouched,
    'lapsed', lapsed,
    'departed', departed,
    'keeper_departed', keeper_left,
    'change_every', every,
    'change_due_at', CASE WHEN departed = 0 AND lapsed = 0 AND NOT keeper_left THEN NULL
                          WHEN keeper_left THEN first_at
                          ELSE greatest(first_at, a.activated_at + make_interval(secs => every)) END,
    'staged_progressed_at', progressed,
    -- After a hand-over, until the owner now in place signs a keeper list of its own, the
    -- list of the owner before goes on vouching, that owner's stamps included.
    'list_needed', l.space_id IS NOT NULL AND l.signed_by <> s.owner_id);
END $$;

-- Internal, and never granted: sealed_vouching(), sealed_vouched(), sealed_members() and
-- keeper_acted().
GRANT EXECUTE ON FUNCTION
  schellingaf.is_keeper(uuid, bytea),
  schellingaf.create_sealed_space(bytea, uuid, text, text, text, boolean, text[], text[], text[], bytea, bytea),
  schellingaf.set_keeper_list(text, bytea, bigint, bytea, jsonb, bytea[], text, bytea[], integer),
  schellingaf.put_stamp(text, bytea, bytea, bytea, jsonb, bytea, timestamp with time zone),
  schellingaf.hand_locks(text, bytea, bigint, bytea, bytea[], bytea[]),
  schellingaf.stage_generation(text, bytea, bigint, bytea, bytea),
  schellingaf.activate_generation(text, bytea, bigint),
  schellingaf.abandon_generation(text, bytea, bigint),
  schellingaf.sealed_unlocked(text, bytea, bigint, bytea, integer),
  schellingaf.sealed_requests(text, bytea, uuid, integer),
  schellingaf.sealed_upkeep(text, bytea)
TO schellingaf_api;
