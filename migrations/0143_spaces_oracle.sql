-- SPACES and their documents: what a control function answers, and to whom.
--
-- Each function below is replaced whole, copied from the latest migration that made it,
-- with its change marked 0143. Their argument lists are unchanged, so their grants stand.
--
--   decline_hand_over()   from 0106_spaces.sql. An offer reaches any KEY that knows its
--                         maker, a member of the SPACE or not, and the answer to declining
--                         it named the SPACE's revision, a counter a private SPACE gives
--                         its members alone (space_heads()), each time the KEY declined it
--                         again. The answer marks outside a KEY that is neither the owner
--                         nor a member of a SPACE that is not public, and the decline route
--                         logs the revision and answers it none. A public SPACE's revision,
--                         which every reader reads, is answered to anybody, as before.
--   set_membership(), revoke_membership(), leave_space(), join_space(), decide_request()
--                         from 0106_spaces.sql. Each took the SPACE's lock before it asked
--                         whether the caller may act, so a refused call queued behind the
--                         SPACE's writers, and its wait timed a private SPACE's activity
--                         (.claude/rules/plpgsql.md, "Check order"). Each now asks first,
--                         unlocked, and refuses as it refused under the lock: a grant or a
--                         removal by a KEY that admits nobody, the owner leaving, a KEY that
--                         is no member leaving, a decision by a KEY that admits nobody, a
--                         code that is no link of the SPACE, and an ask where only a link
--                         admits. Every check under the lock stays as it was.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- An offer, declined
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION schellingaf.decline_hand_over(p_invite_id uuid, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; inv invites%ROWTYPE; rev bigint; v_inside boolean;
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
  -- 0143: whether the KEY declining may read the SPACE's revision, as space_heads() gives
  -- it: anybody in a public SPACE, and the owner or a member of any other. For anybody else
  -- the answer says outside, and the api logs the revision, as it logs every write's, and
  -- answers none of it.
  v_inside := s.owner_id = p_peer OR s.visibility = 'public'
              OR EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer);

  SELECT * INTO inv FROM invites i WHERE i.invite_id = p_invite_id FOR UPDATE;
  IF inv.revoked_at IS NOT NULL OR inv.uses >= 1 THEN
    RETURN jsonb_build_object('invite_id', inv.invite_id, 'name', s.name,
                              'revision', s.revision::text, 'changed', false)
           || CASE WHEN v_inside THEN '{}'::jsonb ELSE jsonb_build_object('outside', true) END;  -- 0143
  END IF;
  UPDATE invites i SET revoked_at = now() WHERE i.invite_id = p_invite_id;
  rev := bump_revision(s.space_id, p_peer, 'invite.revoked',
                       jsonb_build_object('invite_id', inv.invite_id, 'cause', 'declined'));
  RETURN jsonb_build_object('invite_id', inv.invite_id, 'name', s.name,
                            'revision', rev::text, 'changed', true)
         || CASE WHEN v_inside THEN '{}'::jsonb ELSE jsonb_build_object('outside', true) END;  -- 0143
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Refused before the SPACE's lock
-- ─────────────────────────────────────────────────────────────────────────────

-- set_membership() as 0106_spaces.sql made it, with one block marked 0143: a grant by a KEY
-- that admits nobody there is refused before the lock.
CREATE OR REPLACE FUNCTION schellingaf.set_membership(
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
  -- 0143: unlocked pre-check. A grant by a KEY that admits nobody here never waits on the
  -- SPACE's lock. The request and link paths reach this holding the lock already.
  IF p_via = 'grant' THEN
    SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
    IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
    IF rank_in_space(s.space_id, s.owner_id, p_actor) < 25 THEN
      RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
  END IF;

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

-- revoke_membership() as 0106_spaces.sql made it, with one block marked 0143: a removal by a
-- KEY that admits nobody there is refused before the lock.
CREATE OR REPLACE FUNCTION schellingaf.revoke_membership(
  p_space_name text, p_actor bytea, p_peer bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; cur memberships%ROWTYPE; actor_rank int; actor_seat uuid; rev bigint;
BEGIN
  -- 0143: unlocked pre-check. A KEY that admits nobody here never waits on the lock.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 25 OR p_peer = p_actor THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

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

-- leave_space() as 0106_spaces.sql made it, with one block marked 0143: the owner, and a KEY
-- that is no member, are refused before the lock.
CREATE OR REPLACE FUNCTION schellingaf.leave_space(p_space_name text, p_actor bytea)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; cur memberships%ROWTYPE; rev bigint;
BEGIN
  -- 0143: unlocked pre-check. The owner, and a KEY that is no member, never wait on the lock.
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.owner_id = p_actor THEN RAISE EXCEPTION 'OWNER_CANNOT_LEAVE'; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_actor) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER';
  END IF;

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

-- join_space() as 0106_spaces.sql made it, with one block marked 0143: a code that is no link
-- of the SPACE, and an ask where only a link admits, are refused before the lock.
CREATE OR REPLACE FUNCTION schellingaf.join_space(
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
  -- 0143: unlocked pre-checks. A code that is no link of this SPACE, and an ask where only
  -- a link admits, never wait on the lock. The owner, told it owns the SPACE whatever it
  -- sends, and a member, told where it stands, are decided under the lock as before.
  IF p_peer <> s.owner_id THEN
    IF p_code_hash IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM invites i
                      WHERE i.code_hash = p_code_hash AND i.space_id = s.space_id AND i.for_peer IS NULL) THEN
        RAISE EXCEPTION 'INVITE_INVALID';
      END IF;
    ELSIF s.join_policy = 'invite'
          AND NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.space_id = s.space_id AND mm.peer_id = p_peer) THEN
      RAISE EXCEPTION 'JOIN_BY_INVITE_ONLY' USING DETAIL = encode(s.owner_id, 'hex');
    END IF;
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

-- decide_request() as 0106_spaces.sql made it, with one block marked 0143: a KEY that admits
-- nobody there is told the request does not exist before the lock.
CREATE OR REPLACE FUNCTION schellingaf.decide_request(
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
  -- 0143: unlocked pre-check. A KEY that admits nobody here never waits on the lock, and is
  -- told the request does not exist, as it is under the lock.
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = req.space_id;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 25 THEN RAISE EXCEPTION 'REQUEST_NOT_FOUND'; END IF;

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
