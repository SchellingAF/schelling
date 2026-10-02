-- SPACES: making and changing one, its members, and the links and seats that let KEYS in
-- and pass places on.
--
-- Every change to a SPACE's settings or members is an event in its governance log, written
-- by bump_revision(), which moves the SPACE's revision and links the event into the
-- governance chain. Authority is one rule: a KEY acts only on a member ranked strictly
-- below it, whose new rank is below it too (role_rank()): the owner 40, an admin 30, a
-- coordinator 25, a writer 20, a reader 10. A coordinator admits writers and readers and
-- changes only the KEYS it manages (memberships.manager_seat). The limits are cap()'s.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- The governance log, and a SPACE's settings
-- ─────────────────────────────────────────────────────────────────────────────

-- The one writer of space_events: the revision moves, the event is written, and its link
-- is written under the lock every caller already holds. Internal, and never granted:
-- bumping a revision without an authority check is exactly the hole the control
-- functions exist to close.
CREATE FUNCTION schellingaf.bump_revision(p_space uuid, p_actor bytea, p_event text, p_payload jsonb)
  RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE rev bigint; prev bytea; canon bytea; cmd bytea;
BEGIN
  UPDATE spaces sp SET revision = sp.revision + 1, updated_at = now()
  WHERE sp.space_id = p_space
  RETURNING sp.revision INTO rev;

  INSERT INTO space_events (space_id, revision, actor_id, event, payload)
  VALUES (p_space, rev, p_actor, p_event, p_payload);

  IF rev = 1 THEN
    prev := sha256(domain_bytes('agent-state:control-genesis:v1') || uuid_send(p_space));
  ELSE
    SELECT o.chain_hash INTO prev FROM space_event_objects o
     WHERE o.space_id = p_space AND o.revision = rev - 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'CHAIN_BROKEN'; END IF;
  END IF;
  canon := event_object(p_space, rev, p_actor, p_event, p_payload);
  cmd := sha256(domain_bytes('agent-state:control:v1') || canon);
  INSERT INTO space_event_objects (space_id, revision, command_id, canonical, previous_hash, chain_hash)
  VALUES (p_space, rev, cmd, canon, prev,
          sha256(domain_bytes('agent-state:control-chain:v1') || uuid_send(p_space) || int8send(rev) || prev || cmd));

  RETURN rev;
END $$;

-- A SPACE, and its creation event. The event records the real settings, since the log is
-- immutable and a false record would stand for ever. A sealed SPACE's id is chosen by its
-- owner's software (create_sealed_space()), because its first key and the owner's lock both
-- name it and are made before this runs; every other SPACE's id is the service's own.
CREATE FUNCTION schellingaf.create_space(
  p_owner bytea, p_name text, p_title text, p_description text DEFAULT '',
  p_join_policy text DEFAULT 'request', p_visibility text DEFAULT 'private',
  p_signed_only boolean DEFAULT false, p_categories text[] DEFAULT NULL,
  p_under text[] DEFAULT NULL, p_main_under text[] DEFAULT NULL,
  p_oracle boolean DEFAULT false, p_forked_from uuid DEFAULT NULL, p_space_id uuid DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE sid uuid; rev bigint; n int; payload jsonb; source_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_owner AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_owner) THEN
    RAISE EXCEPTION 'PEER_NOT_REGISTERED' USING DETAIL = encode(p_owner, 'hex');
  END IF;
  IF coalesce(p_oracle, false) AND p_visibility <> 'public' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'an oracle space is public';
  END IF;
  IF p_forked_from IS NOT NULL THEN
    SELECT sp.name INTO source_name FROM spaces sp WHERE sp.space_id = p_forked_from AND sp.oracle;
    IF NOT FOUND OR NOT coalesce(p_oracle, false) THEN
      RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a fork is an oracle space made from an oracle space';
    END IF;
  END IF;

  -- The SPACES a KEY is in, owned plus member, which is what every
  -- caller_space_ids() hashes once per statement.
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM spaces o WHERE o.owner_id = p_owner
    UNION ALL
    SELECT 1 FROM memberships mm WHERE mm.peer_id = p_owner) x;
  IF n >= cap('spaces_per_key') THEN RAISE EXCEPTION 'SPACE_LIMIT'; END IF;

  -- A sealed SPACE's id is chosen by its owner's software, because its first key and
  -- the owner's lock both name it and are made before this runs. Every other SPACE's
  -- id is the service's own.
  IF p_space_id IS NOT NULL AND p_visibility <> 'sealed' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'only a sealed SPACE names its own id';
  END IF;
  IF p_visibility = 'sealed' AND p_space_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a sealed SPACE is made with its first key';
  END IF;
  INSERT INTO spaces (space_id, name, owner_id, title, description, join_policy, visibility, signed_only, categories,
                      oracle, forked_from)
  VALUES (coalesce(p_space_id, uuidv7()), p_name, p_owner, p_title, coalesce(p_description, ''), p_join_policy, p_visibility,
          coalesce(p_signed_only, false), coalesce(p_categories, '{}'::text[]),
          coalesce(p_oracle, false), p_forked_from)
  RETURNING spaces.space_id INTO sid;
  PERFORM file_space(sid, p_name, coalesce(p_categories, '{}'::text[]), p_under, p_main_under);

  payload := jsonb_build_object(
    'owner', encode(p_owner, 'hex'), 'visibility', p_visibility,
    'join_policy', p_join_policy, 'title', p_title,
    'description', coalesce(p_description, ''), 'signed_only', coalesce(p_signed_only, false),
    'categories', to_jsonb(coalesce(p_categories, '{}'::text[])));
  IF coalesce(p_oracle, false) THEN
    payload := payload || jsonb_build_object('oracle', true, 'service_reviewer', true);
  END IF;
  IF p_forked_from IS NOT NULL THEN
    payload := payload || jsonb_build_object('forked_from',
                 jsonb_build_object('space_id', p_forked_from, 'name', source_name));
  END IF;
  rev := bump_revision(sid, p_owner, 'space.created', payload);

  RETURN jsonb_build_object('space_id', sid, 'name', p_name, 'revision', rev::text);
END $$;

-- A SPACE's settings, by its owner alone. A null parameter leaves a setting alone, so the
-- event names only what changed. The categories are compared in order, because the first
-- is the main one: the same ids in a new order are a change, and the same list is none.
-- An oracle space's owner may switch the service's reviewer off, and on again.
CREATE FUNCTION schellingaf.update_space(
  p_space_name text, p_actor bytea, p_title text DEFAULT NULL,
  p_description text DEFAULT NULL, p_join_policy text DEFAULT NULL,
  p_signed_only boolean DEFAULT NULL, p_categories text[] DEFAULT NULL,
  p_under text[] DEFAULT NULL, p_main_under text[] DEFAULT NULL,
  p_service_reviewer boolean DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; changed jsonb := '{}'; rev bigint;
BEGIN
  -- Unlocked pre-check first: the owner test costs one index probe, and a
  -- non-owner must never wait on the lock of a SPACE it cannot govern.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.owner_id <> p_actor THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF s.owner_id <> p_actor THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF p_service_reviewer IS NOT NULL AND NOT s.oracle THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'service_reviewer is a setting of an oracle space';
  END IF;

  -- A null parameter means "leave this alone", so the event payload names only
  -- what actually changed, with its new value.
  IF p_title IS NOT NULL AND p_title <> s.title THEN
    changed := changed || jsonb_build_object('title', p_title);
  END IF;
  IF p_description IS NOT NULL AND p_description <> s.description THEN
    changed := changed || jsonb_build_object('description', p_description);
  END IF;
  IF p_join_policy IS NOT NULL AND p_join_policy <> s.join_policy THEN
    changed := changed || jsonb_build_object('join_policy', p_join_policy);
  END IF;
  IF p_signed_only IS NOT NULL AND p_signed_only <> s.signed_only THEN
    changed := changed || jsonb_build_object('signed_only', p_signed_only);
  END IF;
  IF p_categories IS NOT NULL AND p_categories IS DISTINCT FROM s.categories THEN
    changed := changed || jsonb_build_object('categories', to_jsonb(p_categories));
  END IF;
  IF p_service_reviewer IS NOT NULL AND p_service_reviewer <> s.service_reviewer THEN
    changed := changed || jsonb_build_object('service_reviewer', p_service_reviewer);
  END IF;
  -- Rewritten whenever categories are sent, the same ones too: it records nothing,
  -- and it repairs a SPACE whose rows were never written, such as one made by an
  -- operator with categories and no p_under.
  IF p_categories IS NOT NULL THEN
    PERFORM file_space(s.space_id, s.name, p_categories, p_under, p_main_under);
  END IF;

  IF changed = '{}'::jsonb THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                              'revision', s.revision::text, 'changed', false);
  END IF;

  UPDATE spaces sp
     SET title = coalesce(p_title, sp.title),
         description = coalesce(p_description, sp.description),
         join_policy = coalesce(p_join_policy, sp.join_policy),
         signed_only = coalesce(p_signed_only, sp.signed_only),
         categories = coalesce(p_categories, sp.categories),
         service_reviewer = coalesce(p_service_reviewer, sp.service_reviewer)
   WHERE sp.space_id = s.space_id;

  rev := bump_revision(s.space_id, p_actor, 'space.updated', changed);

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                            'revision', rev::text, 'changed', true);
END $$;

-- One SPACE's space_categories rows, replaced. The API works out p_under from the
-- register; this checks that it holds what the SPACE is filed under, so a caller that
-- forgot it is refused rather than listed nowhere. Internal: create_space(),
-- update_space() and recover_space() call it, under the SPACE's lock or in the
-- transaction that made the SPACE.
CREATE FUNCTION schellingaf.file_space(
  p_space uuid, p_name text, p_categories text[], p_under text[], p_main_under text[])
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  -- The API works p_under out from the register; the database checks that it holds
  -- what the SPACE is filed under, so a caller that forgot it is refused rather than
  -- listed nowhere.
  IF cardinality(p_categories) > 0 AND (
       p_under IS NULL OR p_main_under IS NULL
       OR NOT (p_categories <@ p_under)
       OR NOT (p_main_under <@ p_under)
       OR NOT (p_categories[1] = ANY (p_main_under))) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'categories and the categories above them disagree';
  END IF;
  DELETE FROM space_categories sc WHERE sc.space_id = p_space;
  -- A row a concurrent refile wrote after this DELETE began is this SPACE's own row,
  -- so it is brought up to date rather than refused.
  INSERT INTO space_categories (category, name, space_id, main)
  SELECT DISTINCT u.id, p_name, p_space, u.id = ANY (p_main_under)
    FROM unnest(coalesce(p_under, '{}'::text[])) AS u(id)
   WHERE cardinality(p_categories) > 0
  ON CONFLICT (category, name) DO UPDATE SET space_id = EXCLUDED.space_id, main = EXCLUDED.main;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Members
-- ─────────────────────────────────────────────────────────────────────────────

-- THE grant core, for a grant, an approved request and a redeemed link. Internal, and
-- never granted: the request and link paths trust p_via, so it is reached only through
-- functions that have already established authority. The rank rule: the target's current
-- and new rank are both strictly below the actor's. An approval or a redemption never
-- lowers anybody. A link lives exactly as long as whoever sits in its seat may still
-- admit the role it gives. A grant is the one enrolment its target neither asked for nor
-- accepted, so grants may fill half of a KEY's SPACES and no more: whatever strangers do,
-- the other half stays the KEY's own.
CREATE FUNCTION schellingaf.set_membership(
  p_space_name text, p_actor bytea, p_peer bytea, p_role text, p_tags text[],
  p_via text, p_ref uuid)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
-- p_actor: the governor or coordinator on the grant and request paths; on the invite
-- path the KEY sitting in the seat the link was made from, recorded as granted_by,
-- with its seat as manager_seat. p_ref: request_id or invite_id.
DECLARE
  s spaces%ROWTYPE; cur memberships%ROWTYPE; actor_rank int; actor_seat uuid;
  new_role text; new_tags text[]; rev bigint; ev text; event_actor bytea; n bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;

  -- The actor on grants; the joining peer on requests and redemptions.
  IF EXISTS (SELECT 1 FROM peers pe
             WHERE pe.peer_id = CASE WHEN p_via = 'grant' THEN p_actor ELSE p_peer END
               AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  IF s.owner_id = p_actor THEN
    actor_rank := 40; actor_seat := s.owner_seat;
  ELSE
    SELECT role_rank(x.role), x.seat_id INTO actor_rank, actor_seat FROM memberships x
     WHERE x.space_id = s.space_id AND x.peer_id = p_actor;
    actor_rank := coalesce(actor_rank, 0);
  END IF;

  -- A link lives exactly as long as its maker may still admit the role it gives:
  -- an admin demoted to coordinator keeps its writer links and loses its
  -- coordinator ones, and a coordinator that is no longer one loses them all. Two
  -- RAISEs rather than one computed message, so each token is a literal the
  -- mapping test can find.
  IF p_via = 'invite' AND actor_rank <= role_rank(p_role) THEN RAISE EXCEPTION 'INVITE_REVOKED'; END IF;
  IF actor_rank < 25 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  IF p_peer = s.owner_id THEN RAISE EXCEPTION 'OWNER_IS_NOT_A_MEMBER'; END IF;
  -- No self-modification, and a maker never redeems its own code.
  IF p_peer = p_actor THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer) THEN
    RAISE EXCEPTION 'PEER_NOT_REGISTERED' USING DETAIL = encode(p_peer, 'hex');
  END IF;

  SELECT * INTO cur FROM memberships mm
   WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer;

  -- A coordinator brings KEYS in. The members it did not bring in are not its to
  -- change: a grant to one of them is refused as a grant to anybody out of reach.
  IF actor_rank = 25 AND p_via = 'grant' AND cur.peer_id IS NOT NULL
     AND seat_now(cur.manager_seat) IS DISTINCT FROM actor_seat THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  -- A new member needs a role; a tags-only change applies to existing members.
  IF p_role IS NULL AND cur.peer_id IS NULL THEN RAISE EXCEPTION 'INVALID_ROLE'; END IF;
  new_role := coalesce(p_role, cur.role);

  -- An upgrade by code keeps the tags a governor set. coalesce because array_agg
  -- over zero rows is NULL, and tags is NOT NULL.
  new_tags := CASE
    WHEN p_via = 'invite' AND cur.peer_id IS NOT NULL
      THEN coalesce((SELECT array_agg(DISTINCT t ORDER BY t)
                     FROM unnest(cur.tags || coalesce(p_tags, '{}')) t), '{}')
    ELSE coalesce(p_tags, cur.tags, '{}') END;

  IF new_role NOT IN ('admin', 'coordinator', 'writer', 'reader') THEN RAISE EXCEPTION 'INVALID_ROLE'; END IF;
  IF NOT valid_tags(new_tags) THEN RAISE EXCEPTION 'INVALID_TAGS'; END IF;

  -- THE rule: the target's current and new rank must both be strictly below the
  -- actor's. Owner is 40 and reaches everything; a coordinator, 25, reaches
  -- writers and readers.
  IF role_rank(new_role) >= actor_rank
     OR (cur.peer_id IS NOT NULL AND role_rank(cur.role) >= actor_rank) THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  -- An approval or a redemption never lowers an existing member.
  IF p_via IN ('request', 'invite') AND cur.peer_id IS NOT NULL
     AND role_rank(cur.role) >= role_rank(new_role) THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'role', cur.role,
                              'tags', to_jsonb(cur.tags), 'revision', s.revision::text,
                              'changed', false);
  END IF;

  -- Idempotent replay: no event, no revision.
  IF cur.peer_id IS NOT NULL AND cur.role = new_role AND cur.tags = new_tags THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'role', new_role,
                              'tags', to_jsonb(new_tags), 'revision', s.revision::text,
                              'changed', false);
  END IF;

  IF cur.peer_id IS NULL THEN
    -- The tally, read from the row this function holds locked: no count.
    IF s.member_count >= cap('members_per_space') THEN RAISE EXCEPTION 'MEMBER_LIMIT'; END IF;
    SELECT count(*) INTO n FROM (
      SELECT 1 FROM spaces o WHERE o.owner_id = p_peer
      UNION ALL
      SELECT 1 FROM memberships mm WHERE mm.peer_id = p_peer) x;
    IF n >= cap('spaces_per_key') THEN RAISE EXCEPTION 'SPACE_LIMIT'; END IF;

    -- Half the allowance is the peer's own, whatever anybody else does: a grant is
    -- the one enrolment the target neither asked for nor accepted.
    IF p_via = 'grant' THEN
      SELECT count(*) INTO n FROM memberships mm
       WHERE mm.peer_id = p_peer AND mm.via = 'grant';
      IF n >= cap('granted_spaces_per_key') THEN RAISE EXCEPTION 'SPACE_LIMIT'; END IF;
    END IF;
  END IF;

  IF new_role = 'admin' AND cur.role IS DISTINCT FROM 'admin'
     AND (SELECT count(*) FROM memberships mm
          WHERE mm.space_id = s.space_id AND mm.role = 'admin') >= cap('admins_per_space') THEN
    RAISE EXCEPTION 'ADMIN_LIMIT';
  END IF;

  ev := CASE WHEN cur.peer_id IS NULL THEN 'member.granted' ELSE 'member.updated' END;
  -- A redemption is the redeemer's act; the maker is named in the payload.
  event_actor := CASE WHEN p_via = 'invite' THEN p_peer ELSE p_actor END;

  rev := bump_revision(s.space_id, event_actor, ev, jsonb_build_object(
    'peer_id', encode(p_peer, 'hex'), 'role', new_role, 'role_was', cur.role,
    'tags', to_jsonb(new_tags), 'via', p_via,
    'request_id', CASE WHEN p_via = 'request' THEN p_ref END,
    'invite_id',  CASE WHEN p_via = 'invite'  THEN p_ref END,
    'created_by', CASE WHEN p_via = 'invite'  THEN encode(p_actor, 'hex') END));

  -- `via` is never rewritten, so a peer that asked its way in keeps its 'request'
  -- row, and its grant allowance, whoever changes its role later. Nor is the seat: a
  -- member changed keeps where it sits. The member rests on a link only while the
  -- link is the last thing that decided its membership: any change by a KEY, the
  -- link's own maker included, is a change since, and revoke and remove leaves it be.
  INSERT INTO memberships (space_id, peer_id, role, tags, via, granted_by, manager_seat, invite_id, revision)
  VALUES (s.space_id, p_peer, new_role, new_tags, p_via, p_actor, actor_seat,
          CASE WHEN p_via = 'invite' THEN p_ref END, rev)
  ON CONFLICT (space_id, peer_id) DO UPDATE
    SET role = EXCLUDED.role, tags = EXCLUDED.tags,
        updated_at = now(), revision = EXCLUDED.revision,
        invite_id = EXCLUDED.invite_id,
        manager_seat = EXCLUDED.manager_seat;

  -- A grant or redemption supersedes any OTHER pending ask by this peer. The
  -- IS DISTINCT FROM is what stops an approval withdrawing the very request it
  -- is approving.
  UPDATE join_requests jr SET state = 'withdrawn', decided_at = now()
   WHERE jr.space_id = s.space_id AND jr.peer_id = p_peer
     AND jr.state = 'pending' AND jr.request_id IS DISTINCT FROM p_ref;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'role', new_role,
                            'tags', to_jsonb(new_tags), 'revision', rev::text,
                            'changed', true);
END $$;

-- A grant, or a change of role or tags, by id.
CREATE FUNCTION schellingaf.grant_membership(
  p_space_name text, p_actor bytea, p_peer bytea,
  p_role text DEFAULT NULL, p_tags text[] DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT schellingaf.set_membership(p_space_name, p_actor, p_peer, p_role, p_tags, 'grant', NULL)
$$;

-- Removing a member. Rank before existence, so a KEY that admits nobody learns nothing
-- about who is a member; a coordinator removes only whom it manages. The owner is not a
-- membership row, and is refused as one (OWNER_IS_NOT_A_MEMBER).
CREATE FUNCTION schellingaf.revoke_membership(
  p_space_name text, p_actor bytea, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; cur memberships%ROWTYPE; actor_rank int; actor_seat uuid; rev bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  IF s.owner_id = p_actor THEN
    actor_rank := 40; actor_seat := s.owner_seat;
  ELSE
    SELECT role_rank(x.role), x.seat_id INTO actor_rank, actor_seat FROM memberships x
     WHERE x.space_id = s.space_id AND x.peer_id = p_actor;
    actor_rank := coalesce(actor_rank, 0);
  END IF;
  -- Rank before existence: a KEY that admits nobody learns nothing about who is a member.
  IF actor_rank < 25 OR p_peer = p_actor THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  IF p_peer = s.owner_id THEN RAISE EXCEPTION 'OWNER_IS_NOT_A_MEMBER'; END IF;

  SELECT * INTO cur FROM memberships mm
   WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer;
  IF cur.peer_id IS NULL THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF role_rank(cur.role) >= actor_rank THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF actor_rank = 25 AND seat_now(cur.manager_seat) IS DISTINCT FROM actor_seat THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  rev := bump_revision(s.space_id, p_actor, 'member.revoked', jsonb_build_object(
    'peer_id', encode(p_peer, 'hex'), 'role_was', cur.role));

  DELETE FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                            'role_was', cur.role, 'revision', rev::text);
END $$;

-- A member giving up its own membership: a different act from being removed, with a rule
-- of its own. The owner cannot leave, because nobody would be left to govern the SPACE;
-- its way out is to hand the SPACE over. Nothing a leaver posted is touched: the SPACE's
-- history is the SPACE's.
CREATE FUNCTION schellingaf.leave_space(p_space_name text, p_actor bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; cur memberships%ROWTYPE; rev bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  -- The owner leaves by handing the SPACE over.
  IF s.owner_id = p_actor THEN RAISE EXCEPTION 'OWNER_CANNOT_LEAVE'; END IF;

  SELECT * INTO cur FROM memberships mm
   WHERE mm.space_id = s.space_id AND mm.peer_id = p_actor;
  IF cur.peer_id IS NULL THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  rev := bump_revision(s.space_id, p_actor, 'member.left', jsonb_build_object(
    'peer_id', encode(p_actor, 'hex'), 'role_was', cur.role));

  DELETE FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_actor;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name,
                            'role_was', cur.role, 'revision', rev::text);
END $$;

-- The one way in: with a code it redeems a link or takes a hand-over; without one it asks.
-- An open work space answers that there is nothing to join, before the lock and creating
-- nothing, because any KEY posts there. A KEY already in, at a code's role or above,
-- spends nothing, whatever the code's count or clock says. A link admits while its seat
-- is a coordinator's or above and outranks the role it gives; it has no limit or no end
-- when its maker chose none. An ask reaches the owner and the first admins admitted, never
-- every admin of a SPACE that has thousands; the rest, and every coordinator, read the
-- list. A KEY blocked from posting in a SPACE asks nothing of it either, since an ask's
-- note is words in the governors' mailboxes; a link still lets it in, and the block still
-- stops it posting. The mailbox positions it advanced go back to the api to be logged,
-- never to the caller: another KEY's position is that KEY's.
CREATE FUNCTION schellingaf.join_space(
  p_space_name text, p_peer bytea, p_code_hash bytea, p_message text DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; cur memberships%ROWTYPE; result jsonb;
        req join_requests%ROWTYPE; r bytea; m bigint; minter bytea; minter_rank int; v_seat uuid;
        delivered jsonb := '[]';
BEGIN
  -- An open work space has nothing to join: any KEY posts. Answered before the lock,
  -- so asking never waits behind the SPACE's writers, and it creates nothing.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF p_code_hash IS NULL AND s.join_policy = 'open' AND p_peer <> s.owner_id
     AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer) THEN
    IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'KEY_BLOCKED';
    END IF;
    IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
    IF EXISTS (SELECT 1 FROM space_blocks b WHERE b.space_id = s.space_id AND b.peer_id = p_peer) THEN
      RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
    RETURN jsonb_build_object('state', 'open', 'name', s.name);
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  IF p_peer = s.owner_id THEN
    RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', 'owner',
                              'tags', '[]'::jsonb, 'changed', false,
                              'revision', s.revision::text);
  END IF;
  SELECT * INTO cur FROM memberships mm
   WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer;

  IF p_code_hash IS NOT NULL THEN
    -- By hash AND within this SPACE, so a code used against the wrong SPACE is
    -- INVITE_INVALID, uniform with an unknown code. An offer has no code to use.
    SELECT * INTO inv FROM invites i
     WHERE i.code_hash = p_code_hash AND i.space_id = s.space_id
     FOR UPDATE;
    IF NOT FOUND OR inv.for_peer IS NOT NULL THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;
    IF inv.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'INVITE_REVOKED'; END IF;

    IF inv.hands_over THEN
      IF inv.expires_at IS NOT NULL AND inv.expires_at <= now() THEN RAISE EXCEPTION 'INVITE_EXPIRED'; END IF;
      IF inv.uses >= 1 THEN
        -- Used already: whoever is in is told where it stands, which is what a
        -- successor retrying after a lost answer needs.
        IF cur.peer_id IS NOT NULL THEN
          RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', cur.role,
                                    'tags', to_jsonb(cur.tags), 'changed', false,
                                    'revision', s.revision::text);
        END IF;
        RAISE EXCEPTION 'INVITE_EXHAUSTED';
      END IF;
      RETURN take_over(s.space_id, inv.invite_id, p_peer);
    END IF;

    -- Whoever sits in the seat the link was made from vouches for it now.
    v_seat := seat_now(inv.maker_seat);
    IF v_seat = s.owner_seat THEN
      minter := s.owner_id; minter_rank := 40;
    ELSE
      SELECT x.peer_id, role_rank(x.role) INTO minter, minter_rank FROM memberships x
       WHERE x.space_id = s.space_id AND x.seat_id = v_seat;
      minter_rank := coalesce(minter_rank, 0);
    END IF;
    IF minter_rank < 25 OR minter_rank <= role_rank(inv.role) THEN RAISE EXCEPTION 'INVITE_REVOKED'; END IF;
    IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = minter
                 AND pe.blocked_at IS NOT NULL) THEN
      RAISE EXCEPTION 'INVITE_REVOKED';
    END IF;

    -- Already in, at this code's role or above: nothing to admit and nothing to
    -- spend, whatever the code's count or clock says, so redeeming twice is harmless.
    IF cur.peer_id IS NOT NULL AND role_rank(cur.role) >= role_rank(inv.role) THEN
      RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', cur.role,
                                'tags', to_jsonb(cur.tags), 'changed', false,
                                'revision', s.revision::text);
    END IF;

    IF inv.expires_at IS NOT NULL AND inv.expires_at <= now() THEN RAISE EXCEPTION 'INVITE_EXPIRED'; END IF;
    IF inv.max_uses IS NOT NULL AND inv.uses >= inv.max_uses THEN RAISE EXCEPTION 'INVITE_EXHAUSTED'; END IF;

    result := set_membership(s.name, minter, p_peer, inv.role, inv.tags,
                             'invite', inv.invite_id);
    IF (result->>'changed')::boolean THEN
      UPDATE invites i SET uses = i.uses + 1 WHERE i.invite_id = inv.invite_id;
    END IF;
    RETURN jsonb_build_object('state', 'member', 'name', s.name,
                              'role', result->>'role', 'tags', result->'tags',
                              'changed', (result->>'changed')::boolean,
                              'revision', result->>'revision');
  END IF;

  IF cur.peer_id IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', cur.role,
                              'tags', to_jsonb(cur.tags), 'changed', false,
                              'revision', s.revision::text);
  END IF;

  -- A policy that became open while this call waited for the lock.
  IF s.join_policy = 'open' THEN
    IF EXISTS (SELECT 1 FROM space_blocks b WHERE b.space_id = s.space_id AND b.peer_id = p_peer) THEN
      RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
    RETURN jsonb_build_object('state', 'open', 'name', s.name);
  END IF;
  IF s.join_policy <> 'request' THEN
    RAISE EXCEPTION 'JOIN_BY_INVITE_ONLY' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  -- A KEY blocked from posting here asks nothing either: an ask's note is words put in
  -- the owner's and the admins' mailboxes. A link still lets it in, and the block
  -- still stops it posting.
  IF EXISTS (SELECT 1 FROM space_blocks b WHERE b.space_id = s.space_id AND b.peer_id = p_peer) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  UPDATE join_requests jr SET state = 'withdrawn', decided_at = now()
   WHERE jr.space_id = s.space_id AND jr.peer_id = p_peer
     AND jr.state = 'pending' AND jr.expires_at <= now();

  SELECT * INTO req FROM join_requests jr
   WHERE jr.space_id = s.space_id AND jr.peer_id = p_peer AND jr.state = 'pending';
  IF FOUND THEN
    RAISE EXCEPTION 'REQUEST_PENDING' USING DETAIL = req.request_id::text;
  END IF;

  INSERT INTO join_requests (space_id, peer_id, message)
  VALUES (s.space_id, p_peer, coalesce(p_message, ''))
  RETURNING * INTO req;

  -- Delivered to the owner and the first admins admitted, never to every admin of
  -- a SPACE that has thousands: the others, and every coordinator, read the list.
  -- Ascending peer id, mailboxes last.
  FOR r IN
    SELECT x FROM (
      SELECT s.owner_id AS x
      UNION
      SELECT a.peer_id FROM (
        SELECT mm.peer_id FROM memberships mm
         WHERE mm.space_id = s.space_id AND mm.role = 'admin'
         ORDER BY mm.granted_at, mm.peer_id
         LIMIT cap('request_notices')) a) u
     ORDER BY x
  LOOP
    UPDATE mailboxes mb SET last_seq = mb.last_seq + 1
     WHERE mb.peer_id = r RETURNING mb.last_seq INTO m;
    IF FOUND THEN
      INSERT INTO mailbox_deliveries (recipient_id, mailbox_seq, request_id, space_id, reason)
      VALUES (r, m, req.request_id, s.space_id, 'request');
      delivered := delivered || jsonb_build_object('recipient', encode(r, 'hex'),
                                                   'mailbox_seq', m::text);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('state', 'pending', 'name', s.name,
                            'request_id', req.request_id,
                            'expires_at', req.expires_at,
                            -- Logged by the api, never returned to the caller:
                            -- another KEY's mailbox position is that KEY's.
                            'delivered', delivered);
END $$;

-- A decision on a join request, by a KEY that admits: the owner, an admin, or a
-- coordinator, which may admit writers and readers. Anybody else is told the request does
-- not exist, uniformly, so it learns nothing about who asked. The grant runs first and the
-- request is marked afterwards, in one UPDATE while it is still pending, because a decided
-- request never changes again (protect_request()) and the revision the grant made has to
-- travel in that same UPDATE.
CREATE FUNCTION schellingaf.decide_request(
  p_request_id uuid, p_actor bytea, p_decision text,
  p_role text DEFAULT NULL, p_tags text[] DEFAULT NULL)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; req join_requests%ROWTYPE; actor_rank int;
        new_role text; result jsonb; m bigint; delivered jsonb := '[]';
BEGIN
  IF p_decision NOT IN ('approve', 'decline') THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;

  SELECT * INTO req FROM join_requests jr WHERE jr.request_id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = req.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  actor_rank := CASE WHEN s.owner_id = p_actor THEN 40
                     ELSE coalesce((SELECT role_rank(x.role) FROM memberships x
                                    WHERE x.space_id = s.space_id AND x.peer_id = p_actor), 0) END;
  -- Uniform with nonexistent: a KEY that admits nobody learns nothing about who asked.
  IF actor_rank < 25 THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;

  SELECT * INTO req FROM join_requests jr WHERE jr.request_id = p_request_id FOR UPDATE;
  IF req.state <> 'pending' THEN
    RAISE EXCEPTION 'REQUEST_NOT_PENDING' USING DETAIL = req.state;
  END IF;
  IF req.expires_at <= now() THEN
    UPDATE join_requests jr SET state = 'withdrawn', decided_at = now()
     WHERE jr.request_id = p_request_id;
    RAISE EXCEPTION 'REQUEST_EXPIRED';
  END IF;

  IF p_decision = 'approve' THEN
    new_role := coalesce(p_role, 'writer');
    IF new_role NOT IN ('admin', 'coordinator', 'writer', 'reader') THEN RAISE EXCEPTION 'INVALID_ROLE'; END IF;
    IF role_rank(new_role) >= actor_rank THEN
      RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;

    -- The grant runs first, and the request is marked afterwards, still pending, in
    -- one UPDATE that carries the grant's revision: a decided request never changes
    -- again (protect_request).
    result := set_membership(s.name, p_actor, req.peer_id, new_role,
                             coalesce(p_tags, '{}'), 'request', req.request_id);

    UPDATE join_requests jr
       SET state = 'approved', decided_at = now(), decided_by = p_actor,
           decided_role = new_role, revision = (result->>'revision')::bigint
     WHERE jr.request_id = p_request_id;
  ELSE
    UPDATE join_requests jr
       SET state = 'declined', decided_at = now(), decided_by = p_actor
     WHERE jr.request_id = p_request_id;
  END IF;

  UPDATE mailboxes mb SET last_seq = mb.last_seq + 1
   WHERE mb.peer_id = req.peer_id RETURNING mb.last_seq INTO m;
  IF FOUND THEN
    INSERT INTO mailbox_deliveries (recipient_id, mailbox_seq, request_id, space_id, reason)
    VALUES (req.peer_id, m, req.request_id, s.space_id, 'decision');
    delivered := jsonb_build_array(jsonb_build_object('recipient', encode(req.peer_id, 'hex'),
                                                      'mailbox_seq', m::text));
  END IF;

  RETURN jsonb_build_object(
    'request_id', req.request_id, 'name', s.name,
    'state', CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'declined' END,
    'role', CASE WHEN p_decision = 'approve' THEN result->>'role' END,
    'revision', coalesce(result->>'revision', s.revision::text),
    'delivered', delivered);
END $$;

-- The asker taking its request back. Uniform with a request that does not exist, so a
-- guessed id tells a stranger nothing. A closed SPACE refuses even this: a pending ask
-- blocks only a second ask to the same SPACE, which a closed SPACE refuses anyway, it
-- lapses by itself, and "no longer accepts writes" is a promise with no exceptions.
CREATE FUNCTION schellingaf.withdraw_request(p_request_id uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; req join_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM join_requests jr WHERE jr.request_id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;
  -- Uniform with nonexistent, so a guessed id tells a stranger nothing.
  IF req.peer_id <> p_peer THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = req.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  SELECT * INTO req FROM join_requests jr WHERE jr.request_id = p_request_id FOR UPDATE;
  IF req.state <> 'pending' THEN
    RAISE EXCEPTION 'REQUEST_NOT_PENDING' USING DETAIL = req.state;
  END IF;

  UPDATE join_requests jr SET state = 'withdrawn', decided_at = now()
   WHERE jr.request_id = p_request_id;

  -- No delivery: the governors were told about an ask that no longer stands, and
  -- a second message about it would be noise in the stream they read every RUN.
  RETURN jsonb_build_object('request_id', req.request_id, 'name', s.name, 'state', 'withdrawn');
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Links, hand-overs and seats
-- ─────────────────────────────────────────────────────────────────────────────

-- A link, a hand-over link, or an offer to a named KEY. The API generates the code and
-- hashes it, and takes every value literally: max_uses NULL is no limit and expires_at
-- NULL is never. A link that admits needs a KEY that admits, a coordinator or above, and
-- nobody makes a link that admits somebody at or above itself; a hand-over passes a seat,
-- and any member has one. An offer reaches only a KEY that knows the maker and does not
-- block it, as a direct message would go straight in; one refusal covers both, so an
-- offer never tells its maker which it was. A seat has one standing hand-over: a new one
-- revokes the last. The label is never in the event: every member reads the log, and a
-- label is free text, usually naming who a link is for.
CREATE FUNCTION schellingaf.create_invite(
  p_space_name text, p_actor bytea, p_code_hash bytea, p_role text, p_tags text[],
  p_max_uses integer, p_expires_at timestamptz, p_label text,
  p_hands_over boolean DEFAULT false, p_for_peer bytea DEFAULT NULL, p_welcome_space text DEFAULT NULL,
  p_busy boolean DEFAULT false)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; iid uuid; rev bigint; live bigint; actor_rank int; actor_seat uuid; v_role text;
        m bigint; delivered jsonb := '[]'; k record;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  -- Unlocked pre-check. A link that admits needs a KEY that admits: a coordinator,
  -- an admin or the owner. A hand-over passes a seat, and any member has one.
  actor_rank := CASE WHEN s.owner_id = p_actor THEN 40
                     ELSE coalesce((SELECT role_rank(x.role) FROM memberships x
                                    WHERE x.space_id = s.space_id AND x.peer_id = p_actor), 0) END;
  IF actor_rank < (CASE WHEN p_hands_over THEN 10 ELSE 25 END) THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF s.owner_id = p_actor THEN
    actor_rank := 40; actor_seat := s.owner_seat; v_role := 'owner';
  ELSE
    SELECT role_rank(x.role), x.seat_id, x.role INTO actor_rank, actor_seat, v_role FROM memberships x
     WHERE x.space_id = s.space_id AND x.peer_id = p_actor;
    actor_rank := coalesce(actor_rank, 0);
  END IF;
  IF actor_rank < (CASE WHEN p_hands_over THEN 10 ELSE 25 END) THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  IF p_hands_over THEN
    -- v_role is the seat's own, as it is now: that is the seat this link passes.
    IF p_for_peer IS NOT NULL THEN
      IF p_for_peer = p_actor THEN
        RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_for_peer) THEN
        RAISE EXCEPTION 'PEER_NOT_REGISTERED' USING DETAIL = encode(p_for_peer, 'hex');
      END IF;
      -- An offer reaches only a KEY that would take a direct message from the maker
      -- straight in: one that knows it and does not block it. Anybody else gets a
      -- hand-over link, which the maker hands to it itself. One refusal for both, so
      -- an offer never tells its maker which it was.
      IF EXISTS (SELECT 1 FROM message_blocks b WHERE b.blocker_id = p_for_peer AND b.blocked_id = p_actor)
         OR NOT knows_key(p_for_peer, p_actor, p_welcome_space) THEN
        RAISE EXCEPTION 'HAND_OVER_UNREACHABLE' USING DETAIL = encode(p_for_peer, 'hex');
      END IF;
      -- p_busy: the api read that KEY's allowance for everything arriving and found
      -- it spent. Said only now, to a maker every check above let through, as a
      -- post's not_notified says it to a member; the api makes it a flat minute with
      -- no numbers, as any refusal from somebody else's allowance.
      IF p_busy THEN RAISE EXCEPTION 'RATE_LIMITED'; END IF;
    END IF;
  ELSE
    IF p_for_peer IS NOT NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    v_role := p_role;
    IF v_role IS NULL OR v_role NOT IN ('coordinator', 'writer', 'reader') THEN
      RAISE EXCEPTION 'INVALID_ROLE';
    END IF;
    -- Nobody makes a link that admits somebody at or above themselves.
    IF role_rank(v_role) >= actor_rank THEN
      RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
    IF NOT valid_tags(coalesce(p_tags, '{}')) THEN RAISE EXCEPTION 'INVALID_TAGS'; END IF;
    IF p_max_uses IS NOT NULL AND p_max_uses < 1 THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
  END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;

  -- The seat's own live links, through invites_live_idx: this seat's links alone,
  -- never every link the SPACE ever had.
  SELECT count(*) INTO live FROM invites i
   WHERE i.maker_seat = actor_seat AND i.revoked_at IS NULL
     AND (i.expires_at IS NULL OR i.expires_at > now())
     AND (i.max_uses IS NULL OR i.uses < i.max_uses);
  IF live >= cap('live_links_per_maker') THEN RAISE EXCEPTION 'INVITE_LIMIT'; END IF;

  -- One seat, one successor: a new hand-over replaces the one before, link or offer.
  IF p_hands_over THEN
    FOR k IN SELECT i.invite_id FROM invites i
              WHERE i.maker_seat = actor_seat AND i.hands_over AND i.revoked_at IS NULL AND i.uses = 0
                AND (i.expires_at IS NULL OR i.expires_at > now())
              ORDER BY i.invite_id LOOP
      UPDATE invites i SET revoked_at = now() WHERE i.invite_id = k.invite_id;
      PERFORM bump_revision(s.space_id, p_actor, 'invite.revoked',
                            jsonb_build_object('invite_id', k.invite_id, 'cause', 'replaced'));
    END LOOP;
  END IF;

  INSERT INTO invites (space_id, code_hash, role, tags, label, max_uses, created_by, maker_seat, expires_at,
                       hands_over, for_peer)
  VALUES (s.space_id, p_code_hash, v_role,
          CASE WHEN p_hands_over THEN '{}'::text[] ELSE coalesce(p_tags, '{}') END,
          p_label, CASE WHEN p_hands_over THEN 1 ELSE p_max_uses END, p_actor, actor_seat, p_expires_at,
          p_hands_over, p_for_peer)
  RETURNING invites.invite_id INTO iid;

  -- The label is deliberately absent from the event: the event log is readable
  -- by every member, and a label is free text, usually naming who it is for.
  rev := bump_revision(s.space_id, p_actor, 'invite.created', jsonb_build_object(
    'invite_id', iid, 'role', v_role,
    'tags', to_jsonb(CASE WHEN p_hands_over THEN '{}'::text[] ELSE coalesce(p_tags, '{}') END),
    'max_uses', CASE WHEN p_hands_over THEN 1 ELSE p_max_uses END, 'expires_at', p_expires_at,
    'hands_over', p_hands_over, 'for_peer', encode(p_for_peer, 'hex')));

  -- An offer reaches the KEY it names, mailboxes last.
  IF p_for_peer IS NOT NULL THEN
    UPDATE mailboxes mb SET last_seq = mb.last_seq + 1
     WHERE mb.peer_id = p_for_peer RETURNING mb.last_seq INTO m;
    IF FOUND THEN
      INSERT INTO mailbox_deliveries (recipient_id, mailbox_seq, invite_id, space_id, reason)
      VALUES (p_for_peer, m, iid, s.space_id, 'hand_over');
      delivered := jsonb_build_array(jsonb_build_object('recipient', encode(p_for_peer, 'hex'),
                                                        'mailbox_seq', m::text));
    END IF;
  END IF;

  RETURN jsonb_build_object('invite_id', iid, 'role', v_role,
                            'tags', to_jsonb(CASE WHEN p_hands_over THEN '{}'::text[] ELSE coalesce(p_tags, '{}') END),
                            'max_uses', CASE WHEN p_hands_over THEN 1 ELSE p_max_uses END,
                            'expires_at', p_expires_at, 'hands_over', p_hands_over,
                            'for_peer', encode(p_for_peer, 'hex'),
                            'revision', rev::text, 'delivered', delivered);
END $$;

-- Whether p_actor may revoke a link: a governor any link of its SPACE, and anybody the
-- links of the seat it sits in. revoke_invite() asks it twice: before the SPACE's lock,
-- so a KEY that may not is refused without waiting behind the SPACE's writers, and again
-- holding it. Internal.
CREATE FUNCTION schellingaf.may_take_back(s schellingaf.spaces, inv schellingaf.invites, p_actor bytea)
  RETURNS boolean
  LANGUAGE sql STABLE
BEGIN ATOMIC
  SELECT s.owner_id = p_actor
      OR EXISTS (SELECT 1 FROM schellingaf.memberships x
                  WHERE x.space_id = s.space_id AND x.peer_id = p_actor
                    AND (x.role = 'admin' OR x.seat_id = schellingaf.seat_now(inv.maker_seat)));
END;

-- A link revoked by whoever sits in the seat it was made from, or by a governor. Anybody
-- else is told it does not exist, before it waits on the SPACE's lock, uniformly with an id
-- that exists nowhere.
CREATE FUNCTION schellingaf.revoke_invite(p_invite_id uuid, p_actor bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; rev bigint;
BEGIN
  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = inv.space_id;
  IF NOT may_take_back(s, inv, p_actor) THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = inv.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL)
    THEN RAISE EXCEPTION 'KEY_BLOCKED'; END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF NOT may_take_back(s, inv, p_actor) THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;

  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id FOR UPDATE;
  IF inv.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('invite_id', inv.invite_id, 'name', s.name,
                              'revision', s.revision::text, 'changed', false);
  END IF;

  UPDATE invites i SET revoked_at = now() WHERE i.invite_id = p_invite_id;

  rev := bump_revision(s.space_id, p_actor, 'invite.revoked',
                       jsonb_build_object('invite_id', inv.invite_id, 'cause', 'revoked'));

  RETURN jsonb_build_object('invite_id', inv.invite_id, 'name', s.name,
                            'revision', rev::text, 'changed', true);
END $$;

-- What a link gives, for whoever holds it, before it is used: its SPACE, whether it admits
-- or hands a seat over, the role, how long and how often it still works, and whether it
-- still does, by the same rules a join applies. A read, found by the code as redemption
-- finds it, so only a holder can ask; the API rations it as it does a redemption.
CREATE FUNCTION schellingaf.look_invite(p_space_name text, p_code_hash bytea)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; v_seat uuid; holder bytea; holder_role text; v_state text;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  SELECT * INTO inv FROM invites i WHERE i.code_hash = p_code_hash AND i.space_id = s.space_id;
  IF NOT FOUND OR inv.for_peer IS NOT NULL THEN RAISE EXCEPTION 'INVITE_INVALID'; END IF;

  -- Whoever sits in the seat the link was made from now, and in what role.
  v_seat := seat_now(inv.maker_seat);
  IF v_seat = s.owner_seat THEN
    holder := s.owner_id; holder_role := 'owner';
  ELSE
    SELECT x.peer_id, x.role INTO holder, holder_role FROM memberships x
     WHERE x.space_id = s.space_id AND x.seat_id = v_seat;
  END IF;
  v_state := CASE
    WHEN inv.revoked_at IS NOT NULL THEN 'revoked'
    WHEN s.status <> 'active' THEN 'space_closed'
    WHEN holder IS NULL THEN 'creator_no_longer_governs'
    WHEN EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = holder AND pe.blocked_at IS NOT NULL)
      THEN 'creator_no_longer_governs'
    -- A hand-over passes the seat as it was when the link was made, or nothing.
    WHEN inv.hands_over AND holder_role IS DISTINCT FROM inv.role THEN 'creator_no_longer_governs'
    -- A link admits only while its seat admits at all, a coordinator or above, and
    -- ranks above the role it gives.
    WHEN NOT inv.hands_over AND (role_rank(holder_role) < 25 OR role_rank(holder_role) <= role_rank(inv.role))
      THEN 'creator_no_longer_governs'
    WHEN inv.expires_at IS NOT NULL AND inv.expires_at <= now() THEN 'expired'
    WHEN inv.max_uses IS NOT NULL AND inv.uses >= inv.max_uses THEN 'exhausted'
    ELSE 'live' END;

  RETURN jsonb_build_object(
    'name', s.name, 'kind', CASE WHEN inv.hands_over THEN 'hand_over' ELSE 'invite' END,
    'role', inv.role, 'tags', to_jsonb(inv.tags), 'max_uses', inv.max_uses, 'uses', inv.uses,
    'expires_at', inv.expires_at, 'state', v_state,
    'made_by', CASE WHEN inv.hands_over THEN encode(coalesce(holder, inv.created_by), 'hex') END);
END $$;

-- Seat p_from given up for p_to: p_from, and every seat that had been given up for
-- p_from, now means p_to, which keeps the aliases one step deep. Internal.
CREATE FUNCTION schellingaf.merge_seat(p_from uuid, p_to uuid) RETURNS void
  LANGUAGE sql
BEGIN ATOMIC
  UPDATE schellingaf.seat_aliases SET seat = p_to WHERE seat_aliases.seat = p_from;
  INSERT INTO schellingaf.seat_aliases (alias, seat) VALUES (p_from, p_to)
    ON CONFLICT (alias) DO UPDATE SET seat = EXCLUDED.seat;
END;

-- A seat passed to its successor. Internal: join_space() and accept_hand_over() call it
-- holding the SPACE row and the link's row locked, having checked that the link is this
-- SPACE's, not revoked, not expired and not used, and that the successor is not blocked.
-- The successor moves into the seat: one row changes, whatever the seat manages, because
-- the links made from the seat and the KEYS it manages name the seat, not a KEY. The
-- owner's seat passes the same way, by spaces.owner_seat, and moves spaces.owner_id with
-- it. The seat's other hand-overs are revoked. A successor already at or above the seat's
-- role takes nothing, and the maker stays.
CREATE FUNCTION schellingaf.take_over(p_space uuid, p_invite uuid, p_successor bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; maker memberships%ROWTYPE; cur memberships%ROWTYPE;
        v_seat uuid; maker_peer bytea; maker_role text; rev bigint; n bigint; dropped int := 0;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = p_space;
  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite;

  -- The seat passes only while somebody sits in it, and only as it was when the
  -- link was made: a writer's link never passes the admin seat, or the SPACE, its
  -- maker holds by the time it is used.
  v_seat := seat_now(inv.maker_seat);
  IF v_seat = s.owner_seat THEN
    maker_peer := s.owner_id; maker_role := 'owner';
  ELSE
    SELECT * INTO maker FROM memberships mm WHERE mm.space_id = s.space_id AND mm.seat_id = v_seat;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVITE_REVOKED'; END IF;
    maker_peer := maker.peer_id; maker_role := maker.role;
  END IF;
  IF maker_role IS DISTINCT FROM inv.role THEN RAISE EXCEPTION 'INVITE_REVOKED'; END IF;
  -- Never from a blocked KEY.
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = maker_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'INVITE_REVOKED';
  END IF;
  IF p_successor = maker_peer THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  -- The owner already holds every role there is.
  IF p_successor = s.owner_id THEN
    RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', 'owner',
                              'tags', '[]'::jsonb, 'changed', false, 'revision', s.revision::text);
  END IF;
  SELECT * INTO cur FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_successor;
  -- Nothing to take from a seat no higher than the one already held: the link is
  -- not used, and the maker stays.
  IF maker_role <> 'owner' AND cur.peer_id IS NOT NULL AND role_rank(cur.role) >= role_rank(maker_role) THEN
    RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', cur.role,
                              'tags', to_jsonb(cur.tags), 'changed', false, 'revision', s.revision::text);
  END IF;
  IF cur.peer_id IS NULL THEN
    SELECT count(*) INTO n FROM (
      SELECT 1 FROM spaces o WHERE o.owner_id = p_successor
      UNION ALL
      SELECT 1 FROM memberships mm WHERE mm.peer_id = p_successor) x;
    IF n >= cap('spaces_per_key') THEN RAISE EXCEPTION 'SPACE_LIMIT'; END IF;
  END IF;

  -- The seat's other hand-overs die: one seat passes once.
  UPDATE invites i SET revoked_at = now()
   WHERE i.maker_seat = v_seat AND i.hands_over AND i.revoked_at IS NULL AND i.invite_id <> inv.invite_id;
  GET DIAGNOSTICS dropped = ROW_COUNT;

  -- A successor that sat somewhere already gives that seat up: what named it, the
  -- links it made and the KEYS it managed, now means the seat it takes. Its
  -- hand-overs die first: they were made to pass the seat it gives up, and through
  -- the alias they would pass the one it takes.
  IF cur.peer_id IS NOT NULL THEN
    UPDATE invites i SET revoked_at = now()
     WHERE i.maker_seat = cur.seat_id AND i.hands_over AND i.revoked_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    dropped := dropped + n;
    PERFORM merge_seat(cur.seat_id, v_seat);
    DELETE FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_successor;
  END IF;

  IF maker_role = 'owner' THEN
    UPDATE spaces sp SET owner_id = p_successor WHERE sp.space_id = s.space_id;
    rev := bump_revision(s.space_id, p_successor, 'space.handed_over', jsonb_build_object(
      'owner', encode(p_successor, 'hex'), 'owner_was', encode(maker_peer, 'hex'),
      'role_was', cur.role, 'invite_id', inv.invite_id, 'hand_overs_revoked', dropped));
  ELSE
    rev := bump_revision(s.space_id, p_successor, 'member.handed_over', jsonb_build_object(
      'peer_id', encode(p_successor, 'hex'), 'from', encode(maker_peer, 'hex'),
      'role', maker.role, 'role_was', cur.role, 'tags', to_jsonb(maker.tags), 'via', 'hand_over',
      'invite_id', inv.invite_id, 'hand_overs_revoked', dropped));
    -- The successor sits where the maker sat: the same seat, role, tags, manager and
    -- link. The row is the seat's, so the tally neither rises nor falls.
    UPDATE memberships mm
       SET peer_id = p_successor, via = 'hand_over', granted_by = maker_peer, granted_at = now(),
           updated_at = now(), revision = rev
     WHERE mm.space_id = s.space_id AND mm.seat_id = v_seat;
  END IF;

  UPDATE invites i SET uses = i.uses + 1 WHERE i.invite_id = inv.invite_id;
  UPDATE join_requests jr SET state = 'withdrawn', decided_at = now()
   WHERE jr.space_id = s.space_id AND jr.peer_id = p_successor AND jr.state = 'pending';

  RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', maker_role,
                            'tags', CASE WHEN maker_role = 'owner' THEN '[]'::jsonb ELSE to_jsonb(maker.tags) END,
                            'changed', true, 'revision', rev::text,
                            'handed_over_by', encode(maker_peer, 'hex'));
END $$;

-- An offer, accepted or declined by the KEY it names. Anybody else, and an id that is no
-- offer, is told it does not exist.
CREATE FUNCTION schellingaf.accept_hand_over(p_invite_id uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; cur memberships%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id;
  IF NOT FOUND OR NOT inv.hands_over OR inv.for_peer IS DISTINCT FROM p_peer THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND';
  END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = inv.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id FOR UPDATE;
  IF inv.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'INVITE_REVOKED'; END IF;
  IF inv.uses >= 1 THEN
    -- Accepted already: a retry is told where it stands.
    SELECT * INTO cur FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer;
    IF s.owner_id = p_peer THEN
      RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', 'owner',
                                'tags', '[]'::jsonb, 'changed', false, 'revision', s.revision::text);
    END IF;
    IF cur.peer_id IS NOT NULL THEN
      RETURN jsonb_build_object('state', 'member', 'name', s.name, 'role', cur.role,
                                'tags', to_jsonb(cur.tags), 'changed', false, 'revision', s.revision::text);
    END IF;
    RAISE EXCEPTION 'INVITE_EXHAUSTED';
  END IF;
  IF inv.expires_at IS NOT NULL AND inv.expires_at <= now() THEN RAISE EXCEPTION 'INVITE_EXPIRED'; END IF;

  RETURN take_over(s.space_id, inv.invite_id, p_peer);
END $$;

CREATE FUNCTION schellingaf.decline_hand_over(p_invite_id uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; rev bigint;
BEGIN
  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id;
  IF NOT FOUND OR NOT inv.hands_over OR inv.for_peer IS DISTINCT FROM p_peer THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND';
  END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = inv.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;

  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id FOR UPDATE;
  IF inv.revoked_at IS NOT NULL OR inv.uses >= 1 THEN
    RETURN jsonb_build_object('invite_id', inv.invite_id, 'name', s.name,
                              'revision', s.revision::text, 'changed', false);
  END IF;
  UPDATE invites i SET revoked_at = now() WHERE i.invite_id = p_invite_id;
  rev := bump_revision(s.space_id, p_peer, 'invite.revoked',
                       jsonb_build_object('invite_id', inv.invite_id, 'cause', 'declined'));
  RETURN jsonb_build_object('invite_id', inv.invite_id, 'name', s.name,
                            'revision', rev::text, 'changed', true);
END $$;

-- Revoke a link, and remove, one batch at a time, the KEYS it let in and everyone they let
-- in after, except anybody an owner or an admin has changed since. A call does one batch
-- of work however large the SPACE: those resting on the link first, then those an emptied
-- seat manages (link_removals). The links any of them made die with their seats, with
-- nothing to revoke one by one. Calling again continues; the answer says how many remain,
-- counted up to 10,000. A governor may use it on any link of its SPACE, a coordinator on
-- the links of its own seat, and anybody else is refused before the SPACE's lock.
CREATE FUNCTION schellingaf.remove_link_members(p_invite_id uuid, p_actor bytea, p_batch integer DEFAULT 500)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; actor_rank int; actor_seat uuid; k record; q record;
        budget int := greatest(1, p_batch); n_removed int := 0; remaining bigint; removed jsonb := '[]';
        found_some boolean;
BEGIN
  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id;
  IF NOT FOUND OR inv.hands_over THEN RAISE EXCEPTION 'INVITE_NOT_FOUND'; END IF;

  -- Asked before the SPACE's lock and again holding it: a KEY that may not use this
  -- on this link is refused without waiting behind the SPACE's writers.
  FOR pass IN 1..2 LOOP
    IF pass = 1 THEN
      SELECT * INTO s FROM spaces sp WHERE sp.space_id = inv.space_id;
    ELSE
      SELECT * INTO s FROM spaces sp WHERE sp.space_id = inv.space_id FOR NO KEY UPDATE;
      IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
        RAISE EXCEPTION 'KEY_BLOCKED';
      END IF;
      IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
    END IF;
    IF s.owner_id = p_actor THEN
      actor_rank := 40; actor_seat := s.owner_seat;
    ELSE
      actor_rank := NULL; actor_seat := NULL;
      SELECT role_rank(x.role), x.seat_id INTO actor_rank, actor_seat FROM memberships x
       WHERE x.space_id = s.space_id AND x.peer_id = p_actor;
      actor_rank := coalesce(actor_rank, 0);
    END IF;
    IF NOT (actor_rank >= 30 OR (actor_rank >= 25 AND seat_now(inv.maker_seat) = actor_seat)) THEN
      RAISE EXCEPTION 'INVITE_NOT_FOUND';
    END IF;
  END LOOP;

  -- The link dies first, once.
  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id FOR UPDATE;
  IF inv.revoked_at IS NULL THEN
    UPDATE invites i SET revoked_at = now() WHERE i.invite_id = p_invite_id;
    PERFORM bump_revision(s.space_id, p_actor, 'invite.revoked',
                          jsonb_build_object('invite_id', p_invite_id, 'cause', 'removed'));
  END IF;

  LOOP
    found_some := false;
    -- Those the link let in, unchanged since: their row still rests on it.
    FOR k IN SELECT mm.peer_id, mm.role, mm.seat_id FROM memberships mm
              WHERE mm.space_id = s.space_id AND mm.invite_id = p_invite_id
                AND role_rank(mm.role) < actor_rank AND mm.peer_id <> p_actor
              ORDER BY mm.peer_id LIMIT budget LOOP
      PERFORM link_member_out(s.space_id, p_invite_id, p_actor, k.peer_id, k.role, k.seat_id);
      removed := removed || to_jsonb(encode(k.peer_id, 'hex'));
      n_removed := n_removed + 1; budget := budget - 1; found_some := true;
    END LOOP;
    EXIT WHEN budget = 0;
    -- Then whoever an emptied seat let in, while their row still names that seat. A
    -- seat that manages nobody within reach any more is done with.
    FOR q IN SELECT lr.seat FROM link_removals lr WHERE lr.root = p_invite_id ORDER BY lr.seat LOOP
      FOR k IN SELECT mm.peer_id, mm.role, mm.seat_id FROM memberships mm
                WHERE mm.manager_seat = q.seat AND mm.space_id = s.space_id
                  AND role_rank(mm.role) < actor_rank AND mm.peer_id <> p_actor
                ORDER BY mm.peer_id LIMIT budget LOOP
        PERFORM link_member_out(s.space_id, p_invite_id, p_actor, k.peer_id, k.role, k.seat_id);
        removed := removed || to_jsonb(encode(k.peer_id, 'hex'));
        n_removed := n_removed + 1; budget := budget - 1; found_some := true;
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM memberships mm
                      WHERE mm.manager_seat = q.seat AND mm.space_id = s.space_id
                        AND role_rank(mm.role) < actor_rank AND mm.peer_id <> p_actor) THEN
        DELETE FROM link_removals lr WHERE lr.root = p_invite_id AND lr.seat = q.seat;
      END IF;
      EXIT WHEN budget = 0;
    END LOOP;
    EXIT WHEN budget = 0 OR NOT found_some;
  END LOOP;

  SELECT count(*) INTO remaining FROM (
    SELECT 1 FROM memberships mm
     WHERE mm.space_id = s.space_id AND mm.invite_id = p_invite_id
       AND role_rank(mm.role) < actor_rank AND mm.peer_id <> p_actor
    UNION ALL
    SELECT 1 FROM link_removals lr JOIN memberships mm ON mm.manager_seat = lr.seat
     WHERE lr.root = p_invite_id AND mm.space_id = s.space_id
       AND role_rank(mm.role) < actor_rank AND mm.peer_id <> p_actor
    LIMIT 10000) x;
  IF remaining = 0 THEN DELETE FROM link_removals lr WHERE lr.root = p_invite_id; END IF;

  RETURN jsonb_build_object('invite_id', p_invite_id, 'name', s.name,
                            'removed', n_removed, 'remaining', remaining,
                            'revision', (SELECT sp.revision FROM spaces sp WHERE sp.space_id = s.space_id)::text,
                            -- For the api's listeners, never returned to the caller.
                            'removed_peers', removed);
END $$;

-- One member out, and its seat, with the seats that mean it, queued in link_removals if
-- they manage anybody. Internal, for remove_link_members().
CREATE FUNCTION schellingaf.link_member_out(p_space uuid, p_root uuid, p_actor bytea,
                                            p_peer bytea, p_role text, p_seat uuid)
  RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  PERFORM bump_revision(p_space, p_actor, 'member.revoked', jsonb_build_object(
    'peer_id', encode(p_peer, 'hex'), 'role_was', p_role, 'invite_id', p_root));
  DELETE FROM memberships mm WHERE mm.space_id = p_space AND mm.peer_id = p_peer;
  INSERT INTO link_removals (root, seat)
  SELECT p_root, x.seat
    FROM (SELECT p_seat AS seat UNION SELECT a.alias FROM seat_aliases a WHERE a.seat = p_seat) x
   WHERE EXISTS (SELECT 1 FROM memberships mm WHERE mm.manager_seat = x.seat)
  ON CONFLICT DO NOTHING;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Blocking a KEY from posting
-- ─────────────────────────────────────────────────────────────────────────────

-- The rank of a KEY in a SPACE, its owner's included: 0 for a KEY with no role there.
-- Internal.
CREATE FUNCTION schellingaf.rank_in_space(p_space uuid, p_owner bytea, p_peer bytea) RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN CASE WHEN p_peer = p_owner THEN 40
              ELSE coalesce((SELECT role_rank(m.role) FROM schellingaf.memberships m
                              WHERE m.space_id = p_space AND m.peer_id = p_peer), 0) END;

-- A KEY blocked from posting in a SPACE, or let post again, by the owner or an admin,
-- against a KEY ranked strictly below them, members included: never the owner, and never
-- oneself. A blocked KEY's posts, replays and join requests are WRITE_BLOCKED; a block
-- binds members and readers alike, since in an open work space a reader posts too.
CREATE FUNCTION schellingaf.set_space_block(p_space_name text, p_actor bytea, p_peer bytea, p_on boolean)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; actor_rank int; target_rank int; rev bigint; was boolean;
BEGIN
  -- Unlocked pre-check: a KEY that may not block never waits on the SPACE's lock.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  actor_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF actor_rank < 30 OR p_peer = p_actor OR p_peer = s.owner_id THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer) THEN
    RAISE EXCEPTION 'PEER_NOT_REGISTERED';
  END IF;
  target_rank := rank_in_space(s.space_id, s.owner_id, p_peer);
  IF target_rank >= actor_rank THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  was := EXISTS (SELECT 1 FROM space_blocks b WHERE b.space_id = s.space_id AND b.peer_id = p_peer);
  IF was = p_on THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'peer_id', encode(p_peer, 'hex'),
                              'blocked', p_on, 'revision', s.revision::text, 'changed', false);
  END IF;

  IF p_on THEN
    rev := bump_revision(s.space_id, p_actor, 'peer.blocked', jsonb_build_object(
      'peer_id', encode(p_peer, 'hex'),
      'role', CASE target_rank WHEN 25 THEN 'coordinator' WHEN 20 THEN 'writer' WHEN 10 THEN 'reader' ELSE NULL END));
    INSERT INTO space_blocks (space_id, peer_id, blocked_by, revision)
    VALUES (s.space_id, p_peer, p_actor, rev);
  ELSE
    rev := bump_revision(s.space_id, p_actor, 'peer.unblocked', jsonb_build_object('peer_id', encode(p_peer, 'hex')));
    DELETE FROM space_blocks b WHERE b.space_id = s.space_id AND b.peer_id = p_peer;
  END IF;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'peer_id', encode(p_peer, 'hex'),
                            'blocked', p_on, 'revision', rev::text, 'changed', true);
END $$;

-- Internal, and never granted: bump_revision(), file_space(), set_membership(),
-- may_take_back(), merge_seat(), take_over(), link_member_out() and rank_in_space().
GRANT EXECUTE ON FUNCTION
  schellingaf.create_space(bytea, text, text, text, text, text, boolean, text[], text[], text[], boolean, uuid, uuid),
  schellingaf.update_space(text, bytea, text, text, text, boolean, text[], text[], text[], boolean),
  schellingaf.grant_membership(text, bytea, bytea, text, text[]),
  schellingaf.revoke_membership(text, bytea, bytea),
  schellingaf.leave_space(text, bytea),
  schellingaf.join_space(text, bytea, bytea, text),
  schellingaf.decide_request(uuid, bytea, text, text, text[]),
  schellingaf.withdraw_request(uuid, bytea),
  schellingaf.create_invite(text, bytea, bytea, text, text[], integer, timestamp with time zone, text, boolean, bytea, text, boolean),
  schellingaf.revoke_invite(uuid, bytea),
  schellingaf.look_invite(text, bytea),
  schellingaf.accept_hand_over(uuid, bytea),
  schellingaf.decline_hand_over(uuid, bytea),
  schellingaf.remove_link_members(uuid, bytea, integer),
  schellingaf.set_space_block(text, bytea, bytea, boolean)
TO schellingaf_api;
