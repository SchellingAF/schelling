-- A work space's document: who decides it, named, what a waiting version waits for, and
-- versions accepted by writers' confirmations.
--
-- Until 4 October 2026 a version of a work space's document waited for the owner, an admin
-- or a coordinator, and nothing told a proposer who those were or what its version waited
-- for: in cipher-trial-1 a version waited twenty minutes for a decider nobody could name
-- (proposal-document-decision, task 2; its frozen specification, sections 2, 3, 6 and 8).
-- This file adds:
--
--   spaces.document_confirmations   0 to 5, default 0 everywhere: above 0, that many
--                                   writers' go replying to a waiting version make it
--                                   current, as a decider's go does. Set by the owner or
--                                   an admin (set_document_settings()); switched to 0
--                                   with the document (set_space_document()).
--   oracle_versions.confirmed_by    the KEYS whose go confirmed a version, at most 5, and
--   oracle_versions.by_confirmations whether the confirmations made it current. Written
--                                   by append_post() alone, under the SPACE lock.
--   decider_roles(), version_waits_for()   the roles that decide, and what a waiting
--                                   version waits for, made in one place each.
--   standing_confirmers()           internal: the confirmers that still rank writer or
--                                   above and are blocked neither in the SPACE nor by
--                                   the operator. version_confirmers() is the read of one
--                                   version's, for the routes and for later builds.
--   document_deciders()             who decides, the KEYS by who may see them.
--   version_decision()              internal: a go or a veto replying to a version is a
--                                   decision, a confirmation, or refused.
--   next_version_check(), next_version_answer()   internal: next hands a waiting version
--                                   to a writer as a check, where the setting is above 0.
--
-- And replaces set_space_document() from 0115, append_post() from 0128 and next_job()'s
-- twelve-argument form from 0134, each change marked 0138. A confirmation counts only
-- while its author ranks writer or above in the SPACE: each new one rewrites the list as
-- its standing members plus itself. A stage-setting version waits for a decider. Nothing
-- here changes a SPACE whose document_confirmations is 0, beyond the refusal's detail and
-- the fields added to answers.

-- ─────────────────────────────────────────────────────────────────────────────
-- The setting, and the version's confirmations
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE schellingaf.spaces
  ADD COLUMN document_confirmations smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT spaces_document_confirmations_range CHECK (document_confirmations BETWEEN 0 AND 5);
GRANT SELECT (document_confirmations) ON schellingaf.spaces TO schellingaf_api;

-- Row security (can_read_space()) covers both, and the table's grant is whole-table.
ALTER TABLE schellingaf.oracle_versions
  ADD COLUMN confirmed_by schellingaf.bytes32[] NOT NULL DEFAULT '{}',
  ADD COLUMN by_confirmations boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT oracle_versions_confirmed_by_size CHECK (cardinality(confirmed_by) <= 5);

-- ─────────────────────────────────────────────────────────────────────────────
-- Who decides, and what a waiting version waits for
-- ─────────────────────────────────────────────────────────────────────────────

-- Peer ids as a JSON array of hex, in the order given; [] for none.
CREATE FUNCTION schellingaf.hex_list(p_peers bytea[])
  RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT coalesce(jsonb_agg(encode(g.peer, 'hex') ORDER BY g.i), '[]'::jsonb)
            FROM unnest(coalesce(p_peers, '{}'::bytea[])) WITH ORDINALITY g(peer, i));

-- The roles whose go or veto decides a version, in a fixed order: a work space's owner,
-- admins and coordinators; an oracle space's owner and admins, and the service's reviewer
-- where its owner left it on and the service has one.
CREATE FUNCTION schellingaf.decider_roles(p_oracle boolean, p_reviewer_decides boolean)
  RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN CASE WHEN NOT p_oracle THEN ARRAY['owner', 'admin', 'coordinator']
              WHEN p_reviewer_decides THEN ARRAY['owner', 'admin', 'reviewer']
              ELSE ARRAY['owner', 'admin'] END;

-- What a waiting version waits for: the roles whose decision decides it, and, in a work
-- space whose document_confirmations is above 0, for a version that sets no stage, the
-- confirmations given (p_given, standing confirmers in the order given) and required.
-- From values the caller has in hand.
CREATE FUNCTION schellingaf.version_waits_for(p_oracle boolean, p_reviewer_decides boolean, p_required integer,
                                              p_staged boolean, p_given bytea[])
  RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN jsonb_build_object('decision', to_jsonb(schellingaf.decider_roles(p_oracle, p_reviewer_decides)))
         || CASE WHEN NOT p_oracle AND p_required > 0 AND NOT p_staged
                 THEN jsonb_build_object('confirmations', jsonb_build_object(
                        'given', schellingaf.hex_list(p_given),
                        'required', p_required))
                 ELSE '{}'::jsonb END;

-- The members of p_given, in order, who may still confirm in SPACE p_space now: the
-- owner, or a membership whose role ranks 20 or more, and in either case a KEY neither
-- blocked in the SPACE (space_blocks) nor blocked by the operator (peers.blocked_at), since
-- a blocked KEY may not post a go at all. Each a probe of a primary key, at most 5. Names
-- no role. Internal: append_post() and next call it under the SPACE lock, and
-- version_confirmers() for the routes; later builds call version_confirmers().
CREATE FUNCTION schellingaf.standing_confirmers(p_space uuid, p_owner bytea, p_given bytea[])
  RETURNS bytea[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN ARRAY(SELECT g.peer FROM unnest(coalesce(p_given, '{}'::bytea[])) WITH ORDINALITY g(peer, i)
                WHERE (g.peer = p_owner
                       OR (SELECT schellingaf.role_rank(m.role) FROM schellingaf.memberships m
                            WHERE m.space_id = p_space AND m.peer_id = g.peer) >= 20)
                  AND NOT EXISTS (SELECT 1 FROM schellingaf.space_blocks b
                                   WHERE b.space_id = p_space AND b.peer_id = g.peer)
                  AND NOT EXISTS (SELECT 1 FROM schellingaf.peers pe
                                   WHERE pe.peer_id = g.peer AND pe.blocked_at IS NOT NULL)
                ORDER BY g.i);

-- One version's standing confirmers, for whoever may read its SPACE, and nothing for
-- anybody else. It takes the version, never a list, so nobody learns from it whether a KEY
-- of their choosing ranks writer: the KEYS it can name are those whose go confirmed this
-- version, which are public wherever the go is. Called once a row of a versions page, so
-- it asks about its own SPACE alone (caller_in_space(), space_is_public()).
CREATE FUNCTION schellingaf.version_confirmers(p_version uuid)
  RETURNS bytea[]
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT CASE WHEN cardinality(v.confirmed_by) = 0 THEN '{}'::bytea[]
                      ELSE schellingaf.standing_confirmers(v.space_id, s.owner_id, v.confirmed_by::bytea[]) END
            FROM schellingaf.oracle_versions v
            JOIN schellingaf.spaces s ON s.space_id = v.space_id
           WHERE v.post_id = p_version
             AND (schellingaf.caller_in_space(v.space_id) OR schellingaf.space_is_public(v.space_id)));

-- Who decides a version of SPACE p_space's document: {roles, you}, and with p_keys the
-- deciding KEYS and how many more. NULL unless the SPACE is an oracle space or keeps a
-- document, and the caller may read it.
--
--   roles  decider_roles(); you, whether the caller decides here, as the profile's
--          access.decide says: compared with =, so no caller reads false.
--   keys   the owner; the service's reviewer as role reviewer where it decides; then, to
--          a member or the owner, admins by peer id and, in a work space, coordinators by
--          peer id, at most 20 together, with more how many were left out, counted to at
--          most 1,000. To anybody else, the profile's contacts (space_contacts()): the
--          owner and up to 8 admins, never a coordinator, and more null. A KEY appears
--          once: a reviewer that is an admin is the reviewer item.
-- With p_keys false it reads no membership beyond the caller's.
CREATE FUNCTION schellingaf.document_deciders(p_space uuid, p_reviewer bytea, p_keys boolean)
  RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE WHEN NOT p_keys THEN b.base
         ELSE b.base || jsonb_build_object(
           'keys', (SELECT jsonb_agg(jsonb_build_object('peer_id', encode(k.peer, 'hex'), 'role', k.role) ORDER BY k.ord, k.peer)
                      FROM (SELECT s.owner_id AS peer, 'owner'::text AS role, 0 AS ord
                            UNION ALL
                            SELECT p_reviewer, 'reviewer', 1 WHERE s.rev AND p_reviewer <> s.owner_id
                            UNION ALL
                            SELECT g.peer, g.role, g.ord
                              FROM ((SELECT a.peer_id::bytea AS peer, 'admin'::text AS role, 2 AS ord
                                       FROM schellingaf.memberships a
                                      WHERE s.full_view AND a.space_id = s.space_id AND a.role = 'admin'
                                        AND NOT (s.rev AND a.peer_id = p_reviewer)
                                      ORDER BY a.peer_id LIMIT 20)
                                    UNION ALL
                                    (SELECT c.peer_id::bytea, 'coordinator'::text, 3
                                       FROM schellingaf.memberships c
                                      WHERE s.full_view AND NOT s.oracle AND c.space_id = s.space_id AND c.role = 'coordinator'
                                      ORDER BY c.peer_id LIMIT 20)
                                    ORDER BY 3, 1 LIMIT 20) g
                            UNION ALL
                            SELECT ct.peer_id, 'admin', 2
                              FROM schellingaf.space_contacts(s.space_id) ct
                             WHERE NOT s.full_view AND ct.role = 'admin' AND NOT (s.rev AND ct.peer_id = p_reviewer)) k),
           'more', CASE WHEN s.full_view
                        THEN (SELECT greatest(0, least(1000, count(*) - 20))::int
                                FROM (SELECT 1 FROM schellingaf.memberships m
                                       WHERE m.space_id = s.space_id AND m.role IN ('admin', 'coordinator')
                                         AND (NOT s.oracle OR m.role = 'admin')
                                         AND NOT (s.rev AND m.peer_id = p_reviewer)
                                       LIMIT 1020) x) END)
         END
    FROM (SELECT sp.space_id, sp.owner_id::bytea AS owner_id, sp.oracle,
                 (sp.oracle AND sp.service_reviewer AND p_reviewer IS NOT NULL) AS rev,
                 schellingaf.caller_in_space(sp.space_id) AS full_view,
                 schellingaf.caller_id() AS me
            FROM schellingaf.spaces sp
           WHERE sp.space_id = p_space AND (sp.oracle OR sp.document)
             AND schellingaf.can_read_space(sp.space_id)) s
   CROSS JOIN LATERAL (
     SELECT jsonb_build_object(
              'roles', to_jsonb(schellingaf.decider_roles(s.oracle, s.rev)),
              'you', coalesce(s.me = s.owner_id, false)
                     OR coalesce(s.rev AND s.me = p_reviewer, false)
                     OR coalesce((SELECT schellingaf.role_rank(mm.role) FROM schellingaf.memberships mm
                                   WHERE mm.space_id = s.space_id AND mm.peer_id = s.me), 0)
                        >= CASE WHEN s.oracle THEN 30 ELSE 25 END) AS base) b
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A go or a veto replying to a version
-- ─────────────────────────────────────────────────────────────────────────────

-- What a go or a veto of KEY p_author, ranked p_rank in SPACE s, replying to version
-- target is: 'go' or 'veto', a decision, or 'confirm', a writer's go counted toward
-- document_confirmations; any other is refused, before anything is written. Internal:
-- append_post() calls it under the SPACE lock, after the replay, SIGNATURE_REQUIRED and the
-- sealed key check. A later build that changes who decides replaces this function alone.
-- No detail carries a peer id: the refusal reaches a KEY with no role, which must not
-- learn the coordinators.
CREATE FUNCTION schellingaf.version_decision(s schellingaf.spaces, target schellingaf.oracle_versions,
                                             p_author bytea, p_rank integer, p_kind text)
  RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_confirms boolean := NOT s.oracle AND s.document_confirmations > 0;
  v_names text := ': GET /v1/spaces/' || s.name || '/document names them';
BEGIN
  -- 1. A decider: decides at once, whatever the count.
  IF p_rank >= (CASE WHEN s.oracle THEN 30 ELSE 25 END) THEN
    IF target.state <> 'pending' THEN RAISE EXCEPTION 'PROPOSAL_DECIDED' USING DETAIL = target.state; END IF;
    RETURN p_kind;
  END IF;
  -- 2. A veto below a decider, where writers confirm.
  IF p_kind = 'veto' AND v_confirms THEN
    RAISE EXCEPTION 'CONTROL_DENIED'
      USING DETAIL = 'only the owner, an admin or a coordinator declines a version; a writer confirms with go' || v_names;
  END IF;
  -- 3. A veto, or no confirmations here: only a decider decides. Each detail a literal, so
  -- the copy review reads it.
  IF p_kind = 'veto' OR NOT v_confirms THEN
    IF s.oracle THEN
      RAISE EXCEPTION 'CONTROL_DENIED'
        USING DETAIL = 'only the owner, an admin or the service reviewer decides a version here, with go or veto' || v_names;
    END IF;
    RAISE EXCEPTION 'CONTROL_DENIED'
      USING DETAIL = 'only the owner, an admin or a coordinator decides a version here, with go or veto' || v_names;
  END IF;
  -- 4. A reader, or a KEY with no role in an open SPACE: refused, not posted, since posting
  -- here makes no membership and no number of fresh KEYS may reach the count.
  IF p_rank < 20 THEN
    RAISE EXCEPTION 'CONTROL_DENIED'
      USING DETAIL = 'a go on a version counts from a writer, and decides from the owner, an admin or a coordinator' || v_names;
  END IF;
  -- 5. Its own author. Before the state, as a task's own check is.
  IF target.author_id = p_author THEN RAISE EXCEPTION 'PROPOSAL_SELF_CONFIRM'; END IF;
  -- 6.
  IF target.state <> 'pending' THEN RAISE EXCEPTION 'PROPOSAL_DECIDED' USING DETAIL = target.state; END IF;
  -- 7. A version that sets the stage waits for a decider: confirmations never set one.
  IF target.stage_word IS NOT NULL THEN
    RAISE EXCEPTION 'CONTROL_DENIED'
      USING DETAIL = 'this version sets the stage, so only the owner, an admin or a coordinator decides it' || v_names;
  END IF;
  -- 8. Once a KEY. The same idempotency_key again is a replay and never gets here.
  IF p_author = ANY (target.confirmed_by::bytea[]) THEN RAISE EXCEPTION 'PROPOSAL_ALREADY_CONFIRMED'; END IF;
  RETURN 'confirm';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The setting, set
-- ─────────────────────────────────────────────────────────────────────────────

-- document_confirmations of a work space that keeps a document, by its owner or an admin:
-- a coordinator already decides alone, and the setting changes who else accepts. Through
-- the SPACE's settings route, after set_space_document() in the same transaction, and at
-- creation right after it. The change is a space.updated event naming it; the same value
-- again changes nothing. 0 on a work space with no document is no change.
CREATE FUNCTION schellingaf.set_document_settings(p_space_name text, p_actor bytea, p_confirmations integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; rev bigint;
BEGIN
  IF p_confirmations IS NULL OR p_confirmations NOT BETWEEN 0 AND 5 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'document_confirmations is a whole number from 0 to 5';
  END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.oracle THEN
    RAISE EXCEPTION 'INVALID_REQUEST'
      USING DETAIL = 'document_confirmations is a setting of a work space document: an oracle space is decided by its owner, an admin or the service reviewer';
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF p_confirmations > 0 AND NOT s.document THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'document_confirmations needs a document: send document true with it';
  END IF;

  IF p_confirmations = s.document_confirmations THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'revision', s.revision::text,
                              'changed', false, 'document_confirmations', s.document_confirmations);
  END IF;
  UPDATE spaces sp SET document_confirmations = p_confirmations WHERE sp.space_id = s.space_id;
  rev := bump_revision(s.space_id, p_actor, 'space.updated', jsonb_build_object('document_confirmations', p_confirmations));
  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'revision', rev::text,
                            'changed', true, 'document_confirmations', p_confirmations);
END $$;

-- set_space_document() as 0115_documents.sql made it, with one change marked 0138:
-- switching the document off sets document_confirmations to 0 in the same UPDATE, and its
-- one space.updated event names both where the setting was above 0, so no hidden setting
-- comes back when the document is switched on again.
CREATE OR REPLACE FUNCTION schellingaf.set_space_document(p_space_name text, p_actor bytea, p_on boolean)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; rev bigint;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.oracle THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'document is a setting of a work space: an oracle space is one document already';
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  IF p_on = s.document THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'revision', s.revision::text,
                              'changed', false, 'document', s.document);
  END IF;
  IF p_on AND s.visibility = 'sealed' THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'a sealed SPACE keeps no document: the service cannot read its posts';
  END IF;
  -- Under the lock, which every version takes before it is written.
  IF NOT p_on AND EXISTS (SELECT 1 FROM oracle_versions v WHERE v.space_id = s.space_id) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'document stays on once a version is posted: every version is a post, and no post is ever removed';
  END IF;

  -- 0138: off sets document_confirmations to 0 too, and the event names it where it was above 0.
  UPDATE spaces sp SET document = p_on,
                       document_confirmations = CASE WHEN p_on THEN sp.document_confirmations ELSE 0 END
   WHERE sp.space_id = s.space_id;
  rev := bump_revision(s.space_id, p_actor, 'space.updated',
                       jsonb_build_object('document', p_on)
                       || CASE WHEN NOT p_on AND s.document_confirmations > 0
                               THEN jsonb_build_object('document_confirmations', 0) ELSE '{}'::jsonb END);
  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'revision', rev::text,
                            'changed', true, 'document', p_on);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A post
-- ─────────────────────────────────────────────────────────────────────────────

-- append_post() as 0128_post_summary.sql made it, same arguments (its grant stands), with
-- the lines marked 0138 added or changed: a go or a veto replying to a version is judged
-- by version_decision(); a version that stays pending answers waits_for; a writer's
-- confirmation rewrites the version's confirmed_by as its standing confirmers plus itself,
-- and makes the version current once they reach document_confirmations; a replayed
-- version still pending answers waits_for, and a replayed confirmation what it counted.
CREATE OR REPLACE FUNCTION schellingaf.append_post(
  p_space_name text, p_author bytea, p_kind text, p_title text, p_body text, p_data jsonb,
  p_budget jsonb, p_to bytea[], p_run_id uuid, p_reply_to uuid, p_supersedes uuid, p_retracts uuid,
  p_fingerprints jsonb, p_idempotency_key text, p_public_seekable_per_day integer DEFAULT 200,
  p_canonical bytea DEFAULT NULL, p_private bytea DEFAULT NULL, p_alg text DEFAULT NULL,
  p_signature bytea DEFAULT NULL, p_webauthn jsonb DEFAULT NULL,
  p_links text[] DEFAULT NULL, p_reviewer bytea DEFAULT NULL,
  p_pending_per_key integer DEFAULT 3, p_pending_per_space integer DEFAULT 100,
  p_quiet bytea[] DEFAULT NULL, p_sealed_header bytea DEFAULT NULL, p_ciphertext bytea DEFAULT NULL,
  p_open_per_day integer DEFAULT NULL, p_open_per_space integer DEFAULT NULL,
  p_connection_key bytea DEFAULT NULL, p_summary text DEFAULT NULL,
  p_data_json_bytes integer DEFAULT NULL)
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
  v_no_role boolean := false; tk jsonb; v_decides int; v_stage_set jsonb;
  v_given bytea[]; v_by boolean;  -- 0138
BEGIN
  h := sha256(convert_to((
        SELECT coalesce(jsonb_object_agg(k, v), '{}')
          FROM jsonb_each(jsonb_build_object(
                 'kind', p_kind, 'title', p_title, 'summary', p_summary, 'body', body_norm,
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
       OR p_title IS NOT NULL OR p_summary IS NOT NULL OR body_norm <> '' OR p_data IS NOT NULL OR p_budget IS NOT NULL
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
  IF NOT v_sealed THEN v_tsv := search_vector(p_title, p_summary, body_norm); END IF;

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
                                 p_to, p_reply_to, p_supersedes, p_retracts, p_fingerprints, v_private, p_summary);
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
                                          p_to, p_reply_to, p_supersedes, p_retracts, p_fingerprints, p_private,
                                          p_summary) END,
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
        'signed', prior_object.signature IS NOT NULL,
        'admitted_revision', prior.admitted_revision::text)
        || CASE WHEN prior_object.alg = 'connection' THEN jsonb_build_object('signed_by', 'connection') ELSE '{}'::jsonb END
        || CASE WHEN prior.no_role THEN jsonb_build_object('no_role', true) ELSE '{}'::jsonb END
        || coalesce(CASE
             WHEN prior.kind = 'version' THEN
               -- 0138: a version still pending says what it waits for, given standing now.
               (SELECT jsonb_build_object('oracle', jsonb_build_object('state', v.state)
                         || CASE WHEN v.state = 'pending'
                                 THEN jsonb_build_object('waits_for', version_waits_for(
                                        s.oracle, s.oracle AND s.service_reviewer AND p_reviewer IS NOT NULL,
                                        s.document_confirmations, v.stage_word IS NOT NULL,
                                        standing_confirmers(s.space_id, s.owner_id, v.confirmed_by::bytea[])))
                                 ELSE '{}'::jsonb END)
                  FROM oracle_versions v WHERE v.post_id = prior.post_id)
             WHEN prior.kind IN ('go', 'veto') AND prior.reply_to IS NOT NULL THEN
               (SELECT CASE WHEN v.decision = prior.post_id THEN
                       jsonb_build_object('oracle', jsonb_build_object(
                         'decided', CASE prior.kind WHEN 'go' THEN 'approved' ELSE 'declined' END,
                         'version', v.post_id)
                         -- 0138: the confirmation that made it current says so, and who counted.
                         || CASE WHEN v.by_confirmations
                                 THEN jsonb_build_object('by', 'confirmations', 'confirmations',
                                        jsonb_build_object('given', hex_list(v.confirmed_by::bytea[]),
                                                           -- 0138: the count at the decision, not today's setting
                                                           'required', cardinality(v.confirmed_by)))
                                 ELSE '{}'::jsonb END)
                       -- The stage it set: a go that decided passed the rank a decision
                       -- takes, 25 or more, unless the reviewer's exemption let it.
                       || CASE WHEN prior.kind = 'go' AND v.stage_word IS NOT NULL
                                    AND prior.author_id::bytea IS DISTINCT FROM p_reviewer
                               THEN jsonb_build_object('stage_set',
                                      jsonb_build_object('word', v.stage_word, 'note', v.stage_note))
                               ELSE '{}'::jsonb END
                       -- 0138: any other go stored on a version of a work space is a
                       -- confirmation, every other being refused, written out of the list
                       -- since or not: what it counts toward, given standing now.
                       WHEN prior.kind = 'go' AND NOT s.oracle THEN
                       jsonb_build_object('oracle', jsonb_build_object(
                         'confirmed', v.post_id,
                         'confirmations', jsonb_build_object(
                           'given', hex_list(standing_confirmers(s.space_id, s.owner_id, v.confirmed_by::bytea[])),
                           'required', s.document_confirmations)))
                       END
                  FROM oracle_versions v WHERE v.post_id = prior.reply_to)
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
    -- 0138: a decision, a writer's confirmation, or refused, by version_decision().
    IF FOUND THEN
      v_decision := version_decision(s, target, p_author, author_rank, p_kind);
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
                     idempotency_key, content_hash, no_role, summary,
                     body_json_bytes, data_json_bytes)
  VALUES (s.space_id, n, s.revision, p_author, p_kind, p_title, body_norm, p_data,
          p_budget, coalesce(p_to, '{}'::bytea[]), p_run_id, p_reply_to, p_supersedes,
          p_retracts, p_idempotency_key, h, v_no_role, p_summary,
          octet_length(to_json(body_norm)::text) - 2,
          CASE WHEN p_data IS NOT NULL THEN coalesce(p_data_json_bytes, octet_length(p_data::text)) END)
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
    -- data.stage, whose shape the API checked, kept for when the version becomes current.
    INSERT INTO oracle_versions (post_id, space_id, seq, base, author_id, state, text_hash, links,
                                 stage_word, stage_note)
    VALUES (pid, s.space_id, n, p_supersedes, p_author, 'pending', sha256(convert_to(body_norm, 'UTF8')),
            CASE WHEN s.oracle THEN coalesce(p_links[1:256], '{}'::text[]) ELSE '{}'::text[] END,
            p_data->'stage'->>'word', p_data->'stage'->>'note');
    IF author_rank >= v_decides THEN
      stale := oracle_make_current(s.space_id, pid, NULL, p_reviewer);
      v_current := pid;
      v_state := 'current';
    ELSE
      v_state := 'pending';
    END IF;
    v_oracle := jsonb_build_object('state', v_state)
                -- 0138: a version that waits says what for; nobody has confirmed it yet.
                || CASE WHEN v_state = 'pending'
                        THEN jsonb_build_object('waits_for', version_waits_for(
                               s.oracle, s.oracle AND s.service_reviewer AND p_reviewer IS NOT NULL,
                               s.document_confirmations, p_data->'stage'->>'word' IS NOT NULL, '{}'::bytea[]))
                        ELSE '{}'::jsonb END;
  ELSIF v_decision = 'go' THEN
    -- A proposal still waiting was made against the version current now: approving
    -- any other makes every waiting one out of date.
    stale := oracle_make_current(s.space_id, target.post_id, pid, p_reviewer);
    v_current := target.post_id;
    v_oracle := jsonb_build_object('decided', 'approved', 'version', target.post_id);
    -- The stage this go set, if it set one: the SPACE's stage now names the version.
    SELECT jsonb_build_object('word', st.word, 'note', st.note) INTO v_stage_set
      FROM space_stages st WHERE st.space_id = s.space_id AND st.post_id = target.post_id;
  ELSIF v_decision = 'confirm' THEN
    -- 0138: a writer's go counted toward document_confirmations. The list is rewritten as
    -- its confirmers that still rank writer or above, then this one, and counted; at the
    -- setting, the version becomes current as a decider's go makes it, and this go is its
    -- decision.
    v_given := standing_confirmers(s.space_id, s.owner_id, target.confirmed_by::bytea[]) || p_author;
    v_by := cardinality(v_given) >= s.document_confirmations;
    UPDATE oracle_versions v SET confirmed_by = v_given, by_confirmations = v_by
     WHERE v.post_id = target.post_id;
    IF v_by THEN
      stale := oracle_make_current(s.space_id, target.post_id, pid, p_reviewer);
      v_current := target.post_id;
      v_oracle := jsonb_build_object('decided', 'approved', 'version', target.post_id, 'by', 'confirmations',
                                     'confirmations', jsonb_build_object('given', hex_list(v_given),
                                                                         -- 0138: the count at the decision, as a resend answers
                                                                         'required', cardinality(v_given)));
    ELSE
      v_oracle := jsonb_build_object('confirmed', target.post_id,
                                     'confirmations', jsonb_build_object('given', hex_list(v_given),
                                                                         'required', s.document_confirmations));
    END IF;
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
                            'sealed', v_sealed,
                            'admitted_revision', s.revision::text)
         || CASE WHEN p_alg = 'connection' THEN jsonb_build_object('signed_by', 'connection') ELSE '{}'::jsonb END
         || CASE WHEN v_no_role THEN jsonb_build_object('no_role', true) ELSE '{}'::jsonb END
         || CASE WHEN v_oracle IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('oracle', v_oracle) END
         || CASE WHEN v_stage_set IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stage_set', v_stage_set) END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- next hands a waiting version as a check
-- ─────────────────────────────────────────────────────────────────────────────

-- The waiting version next hands KEY p_actor, ranked p_rank, as a check in SPACE s: the
-- lowest-numbered pending version, where s keeps a work space's document and
-- document_confirmations is above 0, that a member posted (a stranger's version waits for
-- a decider, and next never pushes it), that p_actor did not write, did not confirm and
-- did not reply to, and that sets no stage unless p_actor decides. Its fields are null
-- when there is none. Internal: next_job() calls it under the SPACE lock. Probes
-- oracle_versions_pending (at most 100 rows a SPACE), the posts primary key and
-- posts_reply_idx.
CREATE FUNCTION schellingaf.next_version_check(s schellingaf.spaces, p_actor bytea, p_rank integer)
  RETURNS schellingaf.oracle_versions
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE r oracle_versions%ROWTYPE;
BEGIN
  IF NOT (s.document AND NOT s.oracle AND s.document_confirmations > 0) OR p_rank < 20 THEN RETURN r; END IF;
  SELECT * INTO r FROM oracle_versions v
   WHERE v.space_id = s.space_id AND v.state = 'pending'
     AND v.author_id <> p_actor
     AND p_actor <> ALL (v.confirmed_by::bytea[])
     AND (v.stage_word IS NULL OR p_rank >= 25)
     AND NOT (SELECT p.no_role FROM posts p WHERE p.post_id = v.post_id)
     AND NOT EXISTS (SELECT 1 FROM posts rp WHERE rp.reply_to = v.post_id AND rp.author_id = p_actor)
   ORDER BY v.seq
   LIMIT 1;
  RETURN r;
END $$;

-- What next answers for a waiting version v handed as a check, case p_case
-- (check_version, or check_version_decide for a KEY whose go decides): job check, task
-- null, and the version with what it waits for, given standing now. Its summary is the
-- version post's title, null while the post is hidden or withheld; its stage only where it
-- sets one, which only a decider is handed. No offer is written. Internal: next_job().
CREATE FUNCTION schellingaf.next_version_answer(s schellingaf.spaces, v schellingaf.oracle_versions,
                                                p_words jsonb, p_case text)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_given bytea[]; v_post posts%ROWTYPE; v_shown boolean;
BEGIN
  v_given := standing_confirmers(s.space_id, s.owner_id, v.confirmed_by::bytea[]);
  SELECT * INTO v_post FROM posts p WHERE p.post_id = v.post_id;
  v_shown := NOT EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = v.post_id AND w.released_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM space_hidden hd WHERE hd.post_id = v.post_id);
  RETURN jsonb_build_object(
    'space', s.name, 'job', 'check',
    'why', next_why(p_words, p_case, jsonb_build_object('seq', v.seq, 'given', cardinality(v_given),
                                                        'required', s.document_confirmations)),
    'verify', true, 'renewed', false, 'task', NULL::jsonb,
    'version', jsonb_build_object(
                 'post_id', v.post_id, 'seq', v.seq::text, 'author', encode(v.author_id, 'hex'),
                 'posted_at', v_post.posted_at, 'summary', CASE WHEN v_shown THEN v_post.title END)
               || CASE WHEN v.stage_word IS NOT NULL
                       THEN jsonb_build_object('stage', jsonb_build_object('word', v.stage_word, 'note', v.stage_note))
                       ELSE '{}'::jsonb END
               || jsonb_build_object('waits_for', version_waits_for(false, false, s.document_confirmations,
                                                                    v.stage_word IS NOT NULL, v_given)));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The next job, with a waiting version
-- ─────────────────────────────────────────────────────────────────────────────

-- next_job()'s twelve-argument form as 0134_task_upkeep.sql made it (its grant stands, and
-- the nine-argument wrapper is unchanged), with three blocks marked "version check (0138)",
-- each self-contained, so a later build of next_job() carries them verbatim. They run only
-- when the words name check_version, so a caller that sends no words, or older words,
-- never gets a reshaped answer:
--
--   V1  for job any with no tag, after step 2 (a check that waited) and before upkeep and
--       work: a waiting version next_version_check() hands this KEY. Before work tasks;
--       job work is the way past it.
--   V2  for job check with no tag, when no done task waits for this KEY's check.
--   V3  before the offers insert: the version's answer, next_version_answer(). No offer
--       row is written.
CREATE OR REPLACE FUNCTION schellingaf.next_job(p_space_name text, p_actor bytea, p_job text, p_tag text, p_number integer,
                                     p_words jsonb, p_held_max integer, p_check_first_minutes integer,
                                     p_offer_minutes integer, p_not_accepted_max integer,
                                     p_document_gap_hours integer, p_review_gap_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; t tasks%ROWTYPE; v_rank int; v_check_rank int; v_checks boolean;
        v_job text; v_case text; v_values jsonb := '{}'; v_renewed boolean := false; v_out jsonb;
        v_kind text; v_due jsonb; v_full boolean; u task_upkeep%ROWTYPE;
        v_version schellingaf.oracle_versions%ROWTYPE;  -- 0138
BEGIN
  IF p_job IS NULL OR p_job NOT IN ('any', 'work', 'check', 'upkeep') THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;

  -- With a number, that task, as take_task() takes it; it checks who may and takes the
  -- SPACE lock, so the caller's offers are dropped under it.
  IF p_number IS NOT NULL THEN
    IF p_job NOT IN ('any', 'work') OR p_tag IS NOT NULL THEN RAISE EXCEPTION 'INVALID_REQUEST'; END IF;
    v_out := take_task(p_space_name, p_actor, p_number, p_held_max);
    DELETE FROM task_check_offers o
     WHERE o.space_id = (SELECT sp.space_id FROM spaces sp WHERE sp.name = p_space_name) AND o.peer_id = p_actor;
    RETURN v_out || jsonb_build_object(
      'job', 'work',
      'why', next_why(p_words,
                      CASE WHEN v_out ? 'changed_since_claim' THEN 'renewed_changed'
                           WHEN (v_out ->> 'renewed')::boolean THEN 'renewed' ELSE 'number' END,
                      jsonb_build_object('number', p_number, 'from', v_out -> 'changed_since_claim' -> 'from',
                                         'to', v_out -> 'changed_since_claim' -> 'to')));
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF s.oracle THEN RAISE EXCEPTION 'ORACLE_HAS_NO_TASKS'; END IF;
  -- A check takes a coordinator or above where the SPACE says so; every other job a writer.
  v_check_rank := CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END;
  IF rank_in_space(s.space_id, s.owner_id, p_actor) < (CASE WHEN p_job = 'check' THEN v_check_rank ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  v_check_rank := CASE WHEN s.task_confirmers = 'coordinators' THEN 25 ELSE 20 END;
  v_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF v_rank < (CASE WHEN p_job = 'check' THEN v_check_rank ELSE 20 END) THEN
    RAISE EXCEPTION 'TASK_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.owner_id <> p_actor AND EXISTS (SELECT 1 FROM space_blocks b
                                        WHERE b.space_id = s.space_id AND b.peer_id = p_actor) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  -- Whether job any may hand this caller a check: a writer is passed over where only
  -- coordinators check.
  v_checks := p_job = 'any' AND v_rank >= v_check_rank;

  -- Every next drops the caller's offers in this SPACE: one it did not use is no longer
  -- held for it, so the next KEY may be sent.
  DELETE FROM task_check_offers o WHERE o.space_id = s.space_id AND o.peer_id = p_actor;

  -- 1. Renew a task the caller holds, of the tag asked when one is, and of the job asked
  -- (0134): job work never an upkeep task, job upkeep only one, and an upkeep task only
  -- while its claim lasts.
  IF p_job IN ('any', 'work', 'upkeep') THEN
    SELECT * INTO t FROM tasks m
     WHERE m.space_id = s.space_id AND m.state = 'claimed' AND m.claimed_by = p_actor
       AND (p_tag IS NULL OR m.tag = p_tag)
       AND (p_job <> 'work' OR m.upkeep IS NULL) AND (p_job <> 'upkeep' OR m.upkeep IS NOT NULL)
       AND (m.upkeep IS NULL OR m.claimed_until > now())
     ORDER BY m.number
     LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
      v_job := CASE WHEN t.upkeep IS NULL THEN 'work' ELSE 'upkeep' END;
      v_values := jsonb_build_object('from', t.claim_revision, 'to', t.revision);
      -- 0134: an upkeep claim ends at most twice the claim hours after it was taken.
      IF t.upkeep IS NOT NULL AND t.claimed_until >= t.claimed_at + make_interval(hours => 2 * s.task_claim_hours) THEN
        v_case := 'held_upkeep';
        v_values := v_values || jsonb_build_object('hours', 2 * s.task_claim_hours);
      ELSE
        UPDATE tasks h
           SET claimed_until = CASE WHEN h.upkeep IS NULL THEN now() + make_interval(hours => s.task_claim_hours)
                                    ELSE least(now() + make_interval(hours => s.task_claim_hours),
                                               h.claimed_at + make_interval(hours => 2 * s.task_claim_hours)) END
         WHERE h.task_id = t.task_id
        RETURNING * INTO t;
        v_renewed := true;
        v_case := CASE WHEN t.claim_revision < t.revision THEN 'renewed_changed' ELSE 'renewed' END;
      END IF;
    END IF;
  END IF;

  -- 2. Check first: a done task that has waited, oldest done first, under the offer cap.
  IF v_job IS NULL AND v_checks THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.upkeep IS NULL  -- 0134
       AND d.claimed_by <> p_actor
       AND (p_tag IS NULL OR d.tag = p_tag)
       AND d.done_at <= now() - make_interval(mins => p_check_first_minutes)
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.peer_id = p_actor)
       -- The offer cap: confirmations given, and live offers to KEYs that have not checked
       -- it, fewer than it needs. A task needs one at least: lowering the setting accepts no
       -- done task by itself, and the next confirmation does.
       AND (SELECT count(*) FROM task_checks g
             WHERE g.task_id = d.task_id AND g.cycle = d.cycle AND g.verdict = 'confirm')
         + (SELECT count(*) FROM task_check_offers o
             WHERE o.task_id = d.task_id AND o.cycle = d.cycle
               AND o.offered_at > now() - make_interval(mins => p_offer_minutes)
               AND NOT EXISTS (SELECT 1 FROM task_checks k
                                WHERE k.task_id = o.task_id AND k.cycle = o.cycle AND k.peer_id = o.peer_id))
         < greatest(s.task_confirmations, 1)
     ORDER BY d.done_at, d.number
     LIMIT 1;
    IF FOUND THEN
      v_job := 'check';
      v_case := 'check_first';
      v_values := jsonb_build_object('minutes', floor(extract(epoch FROM now() - t.done_at) / 60)::int);
    END IF;
  END IF;

  -- version check (0138) begin
  -- V1: a waiting version of the document, for job any with no tag, before upkeep and work.
  IF v_job IS NULL AND p_job = 'any' AND p_tag IS NULL AND (p_words -> 'why') ? 'check_version' THEN
    v_version := next_version_check(s, p_actor, v_rank);
    IF v_version.post_id IS NOT NULL THEN
      v_job := 'check';
      v_case := CASE WHEN v_rank >= 25 THEN 'check_version_decide' ELSE 'check_version' END;
    END IF;
  END IF;
  -- version check (0138) end

  -- 3. and 4. Upkeep (0134): the task list's review for a coordinator or above, then the
  -- document's, each when upkeep_due() calls for it. Never with a tag, which narrows work
  -- and checks, and never without words, which a caller from before upkeep sends none of.
  IF v_job IS NULL AND p_job IN ('any', 'upkeep') AND p_tag IS NULL AND p_words ? 'upkeep' THEN
    SELECT * INTO u FROM task_upkeep k WHERE k.space_id = s.space_id;
    FOREACH v_kind IN ARRAY ARRAY['tasks', 'document'] LOOP
      CONTINUE WHEN v_job IS NOT NULL OR (v_kind = 'tasks' AND v_rank < 25);
      -- The live one of its kind, if any: one a SPACE.
      SELECT * INTO t FROM tasks k
       WHERE k.space_id = s.space_id AND k.upkeep = v_kind AND k.state IN ('open', 'claimed', 'done')
       FOR UPDATE;
      IF FOUND THEN
        -- Held, or done and waiting for its version: nobody else gets one.
        CONTINUE WHEN t.state = 'done' OR (t.state = 'claimed' AND t.claimed_until > now());
        -- Open, or its claim passed: retired when no longer due, else claimed afresh for
        -- any KEY but the one whose claim passed or that released it itself, and never by
        -- a KEY below an admin that gave it back within the claim hours.
        v_due := upkeep_due(s, v_kind, p_words);
        IF v_due IS NULL THEN
          UPDATE tasks k SET state = 'retired', claimed_by = NULL, claimed_until = NULL,
                             closed_by = NULL, closed_at = now(), close_reason = 'no longer due'
           WHERE k.task_id = t.task_id;
          CONTINUE;
        END IF;
        CONTINUE WHEN t.state = 'claimed' AND t.claimed_by = p_actor;
        -- Nor to the KEY that released it, which would get a fresh claim on the same row.
        CONTINUE WHEN t.state = 'open' AND t.left_by IS NOT DISTINCT FROM p_actor;
        CONTINUE WHEN v_rank < 30 AND t.released_by IS NOT DISTINCT FROM p_actor
                      AND t.released_at > now() - make_interval(hours => s.task_claim_hours);
        UPDATE tasks k SET state = 'claimed', claimed_by = p_actor,
                           claimed_until = now() + make_interval(hours => s.task_claim_hours),
                           claim_revision = k.revision, claimed_at = now(), takes = k.takes + 1
         WHERE k.task_id = t.task_id
        RETURNING * INTO t;
      ELSE
        -- A new one: the cheap tests first, then the counts.
        CONTINUE WHEN v_kind = 'document' AND (NOT s.document OR s.upkeep_document_after = 0
                        OR now() < u.document_handed_at + make_interval(hours => p_document_gap_hours));
        CONTINUE WHEN v_kind = 'tasks' AND (s.upkeep_tasks_hours = 0
                        OR now() < u.last_review_at + make_interval(hours => p_review_gap_hours));
        -- None while the SPACE holds as many tasks not yet accepted as it may, counted in
        -- the two waiting indexes up to the limit and no further.
        IF v_full IS NULL THEN
          v_full := (SELECT count(*) FROM (SELECT 1 FROM tasks w
                                            WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed')
                                            LIMIT p_not_accepted_max) a)
                  + (SELECT count(*) FROM (SELECT 1 FROM tasks d
                                            WHERE d.space_id = s.space_id AND d.state = 'done'
                                            LIMIT p_not_accepted_max) b) >= p_not_accepted_max;
        END IF;
        CONTINUE WHEN v_full;
        v_due := upkeep_due(s, v_kind, p_words);
        CONTINUE WHEN v_due IS NULL;
        INSERT INTO tasks (space_id, number, title, body, upkeep, state, claimed_by, claimed_until,
                           claim_revision, claimed_at, takes)
        VALUES (s.space_id, (SELECT coalesce(max(m.number), 0) + 1 FROM tasks m WHERE m.space_id = s.space_id),
                v_due ->> 'title', v_due ->> 'body', v_kind, 'claimed', p_actor,
                now() + make_interval(hours => s.task_claim_hours), 1, now(), 1)
        RETURNING * INTO t;
        IF v_kind = 'document' THEN
          INSERT INTO task_upkeep AS k (space_id, document_handed_at) VALUES (s.space_id, now())
          ON CONFLICT (space_id) DO UPDATE SET document_handed_at = EXCLUDED.document_handed_at;
        END IF;
      END IF;
      v_job := 'upkeep';
      v_case := v_due ->> 'case';
      v_values := v_due -> 'values';
    END LOOP;
  END IF;

  -- 5. Work: the lowest-numbered task that is open, or whose claim passed, whose after are
  -- all accepted or retired, never one the caller gave back below an admin within the
  -- SPACE's claim hours, and never an upkeep task.
  IF v_job IS NULL AND p_job IN ('any', 'work') THEN
    UPDATE tasks c SET state = 'claimed', claimed_by = p_actor,
                       claimed_until = now() + make_interval(hours => s.task_claim_hours),
                       claim_revision = c.revision, claimed_at = now(), takes = c.takes + 1
     WHERE c.task_id = (SELECT o.task_id FROM tasks o
                         WHERE o.space_id = s.space_id AND o.state IN ('open', 'claimed')
                           AND (o.state = 'open' OR o.claimed_until <= now())
                           AND o.upkeep IS NULL  -- 0134
                           AND (p_tag IS NULL OR o.tag = p_tag)
                           AND NOT EXISTS (SELECT 1 FROM tasks a
                                            WHERE a.task_id = ANY (o.waits_for) AND a.state NOT IN ('accepted', 'retired'))
                           AND NOT (v_rank < 30 AND o.released_by IS NOT DISTINCT FROM p_actor
                                    AND o.released_at > now() - make_interval(hours => s.task_claim_hours))
                         ORDER BY o.number
                         LIMIT 1
                         FOR UPDATE SKIP LOCKED)
    RETURNING * INTO t;
    IF FOUND THEN
      v_job := 'work';
      v_case := 'work';
    END IF;
  END IF;

  -- 6. Check when idle, under the cap; or job check, the lowest-numbered with no cap.
  IF v_job IS NULL AND (v_checks OR p_job = 'check') THEN
    SELECT * INTO t FROM tasks d
     WHERE d.space_id = s.space_id AND d.state = 'done'
       AND d.upkeep IS NULL  -- 0134
       AND d.claimed_by <> p_actor
       AND (p_tag IS NULL OR d.tag = p_tag)
       AND NOT EXISTS (SELECT 1 FROM task_checks c
                        WHERE c.task_id = d.task_id AND c.cycle = d.cycle AND c.peer_id = p_actor)
       AND (p_job = 'check'
            OR (SELECT count(*) FROM task_checks g
                 WHERE g.task_id = d.task_id AND g.cycle = d.cycle AND g.verdict = 'confirm')
             + (SELECT count(*) FROM task_check_offers o
                 WHERE o.task_id = d.task_id AND o.cycle = d.cycle
                   AND o.offered_at > now() - make_interval(mins => p_offer_minutes)
                   AND NOT EXISTS (SELECT 1 FROM task_checks k
                                    WHERE k.task_id = o.task_id AND k.cycle = o.cycle AND k.peer_id = o.peer_id))
             < greatest(s.task_confirmations, 1))
     ORDER BY d.number
     LIMIT 1;
    IF FOUND THEN
      v_job := 'check';
      v_case := CASE WHEN p_job = 'check' THEN 'check_asked' ELSE 'check_idle' END;
    END IF;
  END IF;

  -- version check (0138) begin
  -- V2: job check with no tag and no done task waiting for this KEY: a waiting version.
  IF v_job IS NULL AND p_job = 'check' AND p_tag IS NULL AND (p_words -> 'why') ? 'check_version' THEN
    v_version := next_version_check(s, p_actor, v_rank);
    IF v_version.post_id IS NOT NULL THEN
      v_job := 'check';
      v_case := CASE WHEN v_rank >= 25 THEN 'check_version_decide' ELSE 'check_version' END;
    END IF;
  END IF;
  -- version check (0138) end

  -- version check (0138) begin
  -- V3: a waiting version's answer. No offer is written for it.
  IF v_version.post_id IS NOT NULL THEN
    RETURN next_version_answer(s, v_version, p_words, v_case);
  END IF;
  -- version check (0138) end

  -- A check claims nothing: the offer holds a place under the cap for p_offer_minutes, or
  -- until this KEY's next next here.
  IF v_job = 'check' THEN
    INSERT INTO task_check_offers (space_id, task_id, cycle, peer_id)
    VALUES (s.space_id, t.task_id, t.cycle, p_actor)
    ON CONFLICT (task_id, cycle, peer_id) DO UPDATE SET offered_at = now();
  END IF;

  -- 7. Stop.
  IF v_job IS NULL THEN
    v_job := 'stop';
    v_case := CASE p_job
                WHEN 'check' THEN 'stop_check'
                WHEN 'upkeep' THEN 'stop_upkeep'
                ELSE CASE WHEN EXISTS (SELECT 1 FROM tasks w
                                        WHERE w.space_id = s.space_id AND w.state IN ('open', 'claimed')
                                          AND (w.state = 'open' OR w.claimed_until <= now())
                                          AND w.upkeep IS NULL  -- 0134
                                          AND (p_tag IS NULL OR w.tag = p_tag)
                                          AND EXISTS (SELECT 1 FROM tasks a
                                                       WHERE a.task_id = ANY (w.waits_for)
                                                         AND a.state NOT IN ('accepted', 'retired')))
                          THEN 'stop_waiting' ELSE 'stop' END
              END;
  END IF;

  RETURN jsonb_build_object(
           'space', s.name, 'job', v_job,
           'why', next_why(p_words, v_case, v_values || CASE WHEN v_job = 'stop' THEN '{}'::jsonb
                                                          ELSE jsonb_build_object('number', t.number) END),
           -- 0138: verify is true for a check, a waiting version's included (task null), and
           -- for a check asked even when none waits; with no version check it answers as 0.3 did.
           'verify', v_job = 'check' OR p_job = 'check',
           'renewed', v_renewed,
           'task', CASE WHEN v_job <> 'stop' THEN task_item(t, s.task_confirmations) END)
         || CASE WHEN v_renewed AND t.claim_revision < t.revision
                 THEN jsonb_build_object('changed_since_claim', jsonb_build_object('from', t.claim_revision, 'to', t.revision))
                 ELSE '{}'::jsonb END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────────────

-- The routes read who decides, what a version waits for, one version's standing
-- confirmers, and set the setting. standing_confirmers(), version_decision(),
-- next_version_check() and next_version_answer() are internal and never granted.
-- append_post(), set_space_document() and next_job() keep their grants.
GRANT EXECUTE ON FUNCTION
  schellingaf.hex_list(bytea[]),
  schellingaf.decider_roles(boolean, boolean),
  schellingaf.version_waits_for(boolean, boolean, integer, boolean, bytea[]),
  schellingaf.version_confirmers(uuid),
  schellingaf.document_deciders(uuid, bytea, boolean),
  schellingaf.set_document_settings(text, bytea, integer)
TO schellingaf_api;
