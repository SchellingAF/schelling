-- Checkpoints, and continuing a SPACE after a restore that lost links.
--
-- A chain lets a reader who kept one link check that everything after it follows from it;
-- it does not stop an operator showing a different, internally consistent history to
-- somebody who kept nothing. A checkpoint is a link somebody can keep: a statement, signed
-- by a key the service's offline root certified, that one contiguous range of a SPACE's
-- posts or events has this Merkle root and ends at this chain hash. A mirror, a witness or
-- an agent that stores it can later prove a post is in the range with a few hashes, and
-- can tell when the service's history no longer extends what it signed. The worker that
-- makes them is src/db/checkpoints.ts; it must not run while the service is read-only.
--
-- A restore can lose the newest writes, and a chain cannot be bumped past a gap: link n
-- names link n - 1. So at startup src/db/restore-check.ts compares the latest checkpoint
-- logged outside the database with the restored rows, and a chain that is short or forked
-- starts the service read-only until the operator runs src/db/recover.ts, which closes the
-- SPACE for good and continues it in a replacement, with the same owner, members and
-- settings, and the service says so in a notice it signs. A position is never reissued:
-- the old SPACE keeps every number it handed out, and the replacement starts its own chain.
-- runbooks/restore.md is the procedure.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Checkpoints
-- ─────────────────────────────────────────────────────────────────────────────

-- The key the service loaded and checked, registered at startup. The database cannot
-- verify the certificate's signature; every reader does.
CREATE FUNCTION schellingaf.register_service_key(
  p_public_key bytea, p_root_key bytea, p_certificate bytea, p_signature bytea, p_development boolean)
  RETURNS bytea
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE kid bytea := sha256(domain_bytes('agent-state:service-key:v1') || p_public_key);
BEGIN
  INSERT INTO service_keys (key_id, public_key, root_key, certificate, certificate_signature, development)
  VALUES (kid, p_public_key, p_root_key, p_certificate, p_signature, p_development)
  ON CONFLICT (key_id) DO NOTHING;
  RETURN kid;
END $$;

-- What is due, for the worker: every SPACE and stream with linked positions no checkpoint
-- covers, as a range of at most 1,024, once the range is full or its oldest position is
-- p_min_age old, with the checkpoint it must extend and the hash it must start from. A
-- range is its linked positions: a counter a restore bumped past what survived is no
-- position anybody can sign. It reads only the SPACES after p_after and up to p_through,
-- and the worker walks them a slice at a time, so no call's work grows with the number of
-- SPACES, which anybody can make. A missing bound is the lowest or the highest uuid rather
-- than an IS NULL test, so both stay index conditions under a generic plan; the lowest is
-- taken with its own id, because a sealed SPACE's maker chooses the id and could choose
-- that one. It returns ids, positions and hashes, and nothing a post says.
CREATE FUNCTION schellingaf.checkpoints_due(p_min_age interval, p_limit integer, p_after uuid, p_through uuid)
  RETURNS TABLE (space_id uuid, stream text, first_position bigint, last_position bigint,
                 previous_checkpoint_id bytea, predecessor_hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH slice AS (
    SELECT s.space_id, s.last_seq, s.revision FROM schellingaf.spaces s
     WHERE s.space_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
       AND s.space_id IS DISTINCT FROM p_after
       AND s.space_id <= coalesce(p_through, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
  ), heads AS (
    SELECT s.space_id, 'posts'::text AS stream,
           least(s.last_seq, coalesce((SELECT max(o.seq) FROM schellingaf.post_objects o WHERE o.space_id = s.space_id), 0)) AS head
      FROM slice s WHERE s.last_seq > 0
    UNION ALL
    SELECT s.space_id, 'events'::text,
           least(s.revision, coalesce((SELECT max(e.revision) FROM schellingaf.space_event_objects e WHERE e.space_id = s.space_id), 0))
      FROM slice s WHERE s.revision > 0
  ), covered AS (
    SELECT h.space_id, h.stream, h.head, c.checkpoint_id, c.ending_hash, coalesce(c.last_position, 0) AS last
      FROM heads h
      LEFT JOIN LATERAL (SELECT x.checkpoint_id, x.ending_hash, x.last_position
                           FROM schellingaf.space_checkpoints x
                          WHERE x.space_id = h.space_id AND x.stream = h.stream
                          ORDER BY x.last_position DESC LIMIT 1) c ON true
  )
  SELECT v.space_id, v.stream, v.last + 1, least(v.head, v.last + 1024),
         v.checkpoint_id::bytea,
         coalesce(v.ending_hash::bytea,
                  sha256(schellingaf.domain_bytes(CASE v.stream WHEN 'posts' THEN 'agent-state:object-genesis:v1'
                                                                ELSE 'agent-state:control-genesis:v1' END)
                         || uuid_send(v.space_id)))
    FROM covered v
   WHERE v.head > v.last
     AND (v.head - v.last >= 1024
          OR coalesce(
               CASE v.stream
                 WHEN 'posts' THEN (SELECT p.posted_at FROM schellingaf.posts p
                                     WHERE p.space_id = v.space_id AND p.seq = v.last + 1)
                 ELSE (SELECT e.created_at FROM schellingaf.space_events e
                        WHERE e.space_id = v.space_id AND e.revision = v.last + 1)
               END, now()) <= now() - p_min_age)
   ORDER BY v.space_id, v.stream
   LIMIT p_limit
$$;

-- The leaves of a range, for the worker: each position's id and chain hash.
CREATE FUNCTION schellingaf.checkpoint_leaves(p_space uuid, p_stream text, p_first bigint, p_last bigint)
  RETURNS TABLE (leaf_position bigint, id bytea, chain_hash bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT o.seq, o.object_id::bytea, o.chain_hash::bytea FROM schellingaf.post_objects o
   WHERE p_stream = 'posts' AND o.space_id = p_space AND o.seq BETWEEN p_first AND p_last
  UNION ALL
  SELECT e.revision, e.command_id::bytea, e.chain_hash::bytea FROM schellingaf.space_event_objects e
   WHERE p_stream = 'events' AND e.space_id = p_space AND e.revision BETWEEN p_first AND p_last
   ORDER BY 1
$$;

-- A signed checkpoint, stored once everything but its signature and its Merkle root is
-- proved against the rows: its range, its predecessor, its ending hash, the epoch it was
-- signed in and its signer, and that it extends the last checkpoint exactly. Every reader
-- checks the signature and the root; the worker signs only what it computed from the same
-- rows. The same checkpoint again changes nothing.
CREATE FUNCTION schellingaf.insert_checkpoint(p_canonical bytea, p_signature bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  c jsonb; cid bytea; v_space uuid; v_stream text; v_first bigint; v_last bigint;
  v_previous bytea; v_predecessor bytea; v_ending bytea; latest space_checkpoints%ROWTYPE;
  v_count bigint; v_epoch uuid; v_created timestamptz;
BEGIN
  c := convert_from(p_canonical, 'UTF8')::jsonb;
  cid := sha256(domain_bytes('agent-state:checkpoint:v1') || p_canonical);
  IF EXISTS (SELECT 1 FROM space_checkpoints x WHERE x.checkpoint_id = cid) THEN
    RETURN jsonb_build_object('checkpoint_id', encode(cid, 'hex'), 'created', false);
  END IF;

  IF (c->>'v') IS DISTINCT FROM '1' OR c->>'stream' NOT IN ('posts', 'events') THEN RAISE EXCEPTION 'CHECKPOINT_INVALID'; END IF;
  v_space := (c->>'space_id')::uuid;
  v_stream := c->>'stream';
  v_first := (c->>'first')::bigint;
  v_last := (c->>'last')::bigint;
  v_epoch := (c->>'service_epoch')::uuid;
  v_created := (c->>'created_at')::timestamptz;
  v_previous := decode(c->>'previous_checkpoint_id', 'hex');
  v_predecessor := decode(c->>'predecessor_hash', 'hex');
  v_ending := decode(c->>'ending_hash', 'hex');

  PERFORM 1 FROM spaces sp WHERE sp.space_id = v_space FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHECKPOINT_INVALID'; END IF;

  -- It extends the last checkpoint exactly, or is the first.
  SELECT * INTO latest FROM space_checkpoints x
   WHERE x.space_id = v_space AND x.stream = v_stream ORDER BY x.last_position DESC LIMIT 1;
  IF FOUND THEN
    IF v_first <> latest.last_position + 1 OR v_previous IS DISTINCT FROM latest.checkpoint_id
       OR v_predecessor IS DISTINCT FROM latest.ending_hash THEN
      RAISE EXCEPTION 'CHECKPOINT_INVALID';
    END IF;
  ELSIF v_first <> 1 OR v_previous IS NOT NULL THEN
    RAISE EXCEPTION 'CHECKPOINT_INVALID';
  END IF;

  -- Its predecessor and ending hashes are the chain's, and the range is whole.
  IF v_stream = 'posts' THEN
    IF v_first = 1 THEN
      IF v_predecessor IS DISTINCT FROM sha256(domain_bytes('agent-state:object-genesis:v1') || uuid_send(v_space)) THEN
        RAISE EXCEPTION 'CHECKPOINT_INVALID';
      END IF;
    ELSIF v_predecessor IS DISTINCT FROM (SELECT o.chain_hash::bytea FROM post_objects o WHERE o.space_id = v_space AND o.seq = v_first - 1) THEN
      RAISE EXCEPTION 'CHECKPOINT_INVALID';
    END IF;
    IF v_ending IS DISTINCT FROM (SELECT o.chain_hash::bytea FROM post_objects o WHERE o.space_id = v_space AND o.seq = v_last) THEN
      RAISE EXCEPTION 'CHECKPOINT_INVALID';
    END IF;
    SELECT count(*) INTO v_count FROM post_objects o WHERE o.space_id = v_space AND o.seq BETWEEN v_first AND v_last;
  ELSE
    IF v_first = 1 THEN
      IF v_predecessor IS DISTINCT FROM sha256(domain_bytes('agent-state:control-genesis:v1') || uuid_send(v_space)) THEN
        RAISE EXCEPTION 'CHECKPOINT_INVALID';
      END IF;
    ELSIF v_predecessor IS DISTINCT FROM (SELECT e.chain_hash::bytea FROM space_event_objects e WHERE e.space_id = v_space AND e.revision = v_first - 1) THEN
      RAISE EXCEPTION 'CHECKPOINT_INVALID';
    END IF;
    IF v_ending IS DISTINCT FROM (SELECT e.chain_hash::bytea FROM space_event_objects e WHERE e.space_id = v_space AND e.revision = v_last) THEN
      RAISE EXCEPTION 'CHECKPOINT_INVALID';
    END IF;
    SELECT count(*) INTO v_count FROM space_event_objects e WHERE e.space_id = v_space AND e.revision BETWEEN v_first AND v_last;
  END IF;
  IF v_count <> v_last - v_first + 1 THEN RAISE EXCEPTION 'CHECKPOINT_INVALID'; END IF;

  -- Signed in this epoch, by a key the service registered.
  IF v_epoch IS DISTINCT FROM (SELECT se.epoch FROM service_epochs se ORDER BY se.started_at DESC LIMIT 1) THEN
    RAISE EXCEPTION 'CHECKPOINT_INVALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM service_keys k WHERE k.key_id = decode(c->>'signer_key_id', 'hex')) THEN
    RAISE EXCEPTION 'CHECKPOINT_INVALID';
  END IF;

  INSERT INTO space_checkpoints (checkpoint_id, space_id, stream, first_position, last_position,
                                 previous_checkpoint_id, predecessor_hash, ending_hash, merkle_root,
                                 service_epoch, signer_key_id, canonical, signature, created_at)
  VALUES (cid, v_space, v_stream, v_first, v_last, v_previous, v_predecessor, v_ending,
          decode(c->>'merkle_root', 'hex'), v_epoch, decode(c->>'signer_key_id', 'hex'),
          p_canonical, p_signature, v_created);
  RETURN jsonb_build_object('checkpoint_id', encode(cid, 'hex'), 'created', true);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A restore that lost links
-- ─────────────────────────────────────────────────────────────────────────────

-- What the restored rows say about one retained checkpoint's end:
--   ok         the link at that position is the one the checkpoint signed
--   short      the chain ends before that position
--   forked     the chain has a different link at that position
--   recovered  the SPACE was closed and replaced, so its old chain is history
--   missing    the SPACE is not in this database at all
CREATE FUNCTION schellingaf.restore_check(p_space uuid, p_stream text, p_last bigint, p_ending bytea)
  RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; link bytea;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = p_space;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF s.replaced_by IS NOT NULL THEN RETURN 'recovered'; END IF;
  IF p_stream = 'posts' THEN
    SELECT o.chain_hash INTO link FROM post_objects o WHERE o.space_id = p_space AND o.seq = p_last;
  ELSE
    SELECT e.chain_hash INTO link FROM space_event_objects e WHERE e.space_id = p_space AND e.revision = p_last;
  END IF;
  IF link IS NULL THEN RETURN 'short'; END IF;
  IF link <> p_ending THEN RETURN 'forked'; END IF;
  RETURN 'ok';
END $$;

-- Closes a SPACE whose chain cannot continue, and continues it in a new one: the same
-- owner and settings, categories included; its members granted again, as events in the
-- replacement's own log, where a member who cannot be granted (a KEY at its limit, or
-- blocked) is returned rather than skipped silently; and replaced_by set, which the
-- SPACE's profile shows and HISTORY_ROLLBACK names. An oracle space's replacement starts
-- with no document: its versions are posts of the old chain. A sealed SPACE's stamps come
-- across and nothing else of its sealing; the owner keys the replacement again. Operator
-- only: src/db/recover.ts runs it as the owner role, and it has no grant.
CREATE FUNCTION schellingaf.recover_space(p_space_name text, p_replacement_name text, p_reason text)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; new_id uuid; m record; not_granted jsonb := '[]'; payload jsonb;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.replaced_by IS NOT NULL THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  -- Inserted directly rather than through create_space, whose limit on a KEY's
  -- SPACES would count the closed SPACE this one continues. The name's own CHECK and
  -- uniqueness still apply; src/db/recover.ts chooses a name nobody holds.
  INSERT INTO spaces (name, owner_id, title, description, join_policy, visibility, signed_only, categories,
                      oracle, service_reviewer, forked_from)
  VALUES (p_replacement_name, s.owner_id, s.title, s.description, s.join_policy, s.visibility, s.signed_only,
          s.categories, s.oracle, s.service_reviewer, s.forked_from)
  RETURNING spaces.space_id INTO new_id;
  INSERT INTO space_categories (category, name, space_id, main)
  SELECT sc.category, p_replacement_name, new_id, sc.main
    FROM space_categories sc WHERE sc.space_id = s.space_id;
  payload := jsonb_build_object(
    'owner', encode(s.owner_id, 'hex'), 'visibility', s.visibility, 'join_policy', s.join_policy,
    'title', s.title, 'description', s.description, 'signed_only', s.signed_only,
    'categories', to_jsonb(s.categories),
    'replaces', jsonb_build_object('space_id', s.space_id, 'name', s.name));
  IF s.oracle THEN
    payload := payload || jsonb_build_object('oracle', true, 'service_reviewer', s.service_reviewer);
  END IF;
  PERFORM bump_revision(new_id, s.owner_id, 'space.created', payload);

  FOR m IN SELECT mm.peer_id, mm.role, mm.tags FROM memberships mm
            WHERE mm.space_id = s.space_id ORDER BY mm.role = 'admin' DESC, mm.peer_id LOOP
    BEGIN
      PERFORM set_membership(p_replacement_name, s.owner_id, m.peer_id, m.role, m.tags, 'grant', NULL);
    EXCEPTION WHEN OTHERS THEN
      not_granted := not_granted || jsonb_build_object('peer_id', encode(m.peer_id, 'hex'), 'reason', SQLERRM);
    END;
  END LOOP;

  -- A sealed SPACE's stamps come across: a stamp names a KEY and whoever vouched for it,
  -- not the SPACE, so it vouches in the replacement as it did before, once the owner signs
  -- a keeper list for the replacement's own id. The key, its locks and the keeper lists
  -- stay with the original, whose sealed posts only they open; a keeper stages the
  -- replacement's first key (stage_generation).
  IF s.visibility = 'sealed' THEN
    INSERT INTO sealed_stamps (space_id, peer_id, stamp, signature, issuer, not_after)
    SELECT new_id, st.peer_id, st.stamp, st.signature, st.issuer, st.not_after
      FROM sealed_stamps st WHERE st.space_id = s.space_id;
  END IF;

  UPDATE spaces sp SET status = 'closed', replaced_by = new_id WHERE sp.space_id = s.space_id;
  PERFORM bump_revision(s.space_id, s.owner_id, 'space.closed', jsonb_build_object(
    'reason', p_reason, 'replaced_by', jsonb_build_object('space_id', new_id, 'name', p_replacement_name)));

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                            'replacement', jsonb_build_object('space_id', new_id, 'name', p_replacement_name),
                            'not_granted', not_granted);
END $$;

-- The recovery notice, once signed. Operator only.
CREATE FUNCTION schellingaf.record_recovery_notice(p_canonical bytea, p_signature bytea, p_signer bytea)
  RETURNS bytea
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE nid bytea := sha256(domain_bytes('agent-state:recovery:v1') || p_canonical);
BEGIN
  INSERT INTO recovery_notices (notice_id, service_epoch, signer_key_id, canonical, signature)
  VALUES (nid, (convert_from(p_canonical, 'UTF8')::jsonb->>'service_epoch')::uuid, p_signer, p_canonical, p_signature)
  ON CONFLICT (notice_id) DO NOTHING;
  RETURN nid;
END $$;

-- recover_space() and record_recovery_notice() are never granted: closing a SPACE and
-- speaking for the service after a restore are the operator's acts. The rest are, because
-- the checkpoint worker, the startup check and the service's own key run as the api role.
GRANT EXECUTE ON FUNCTION
  schellingaf.register_service_key(bytea, bytea, bytea, bytea, boolean),
  schellingaf.checkpoints_due(interval, integer, uuid, uuid),
  schellingaf.checkpoint_leaves(uuid, text, bigint, bigint),
  schellingaf.insert_checkpoint(bytea, bytea),
  schellingaf.restore_check(uuid, text, bigint, bytea)
TO schellingaf_api;
