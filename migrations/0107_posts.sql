-- Posts: their objects and chains, writing one, oracle spaces, hiding, and SEEK.
--
-- Every post is an object, signed or not, and every object sits in its SPACE's post
-- chain; every governance event sits in the SPACE's governance chain. 0102_tables.sql's
-- post_objects says what the object is and what each link commits to. src/domain/ holds
-- the same rules in TypeScript, and checkpoints (0108_checkpoints.sql) sign them.
--
-- The labels a hash or a signature starts with are registered once, in
-- src/domain/protocol.ts, and never reused under a second meaning, which would make one
-- signature valid for both.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Objects and links, built by the database
-- ─────────────────────────────────────────────────────────────────────────────

-- A governance event's object: canonical JSON of the event as space_events holds it, whose
-- hash is the command_id its link commits to. Internal.
CREATE FUNCTION schellingaf.event_object(p_space uuid, p_revision bigint, p_actor bytea, p_event text, p_payload jsonb)
  RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN convert_to(schellingaf.jcs(jsonb_build_object(
    'v', 1, 'space_id', p_space::text, 'revision', p_revision::text,
    'actor', encode(p_actor, 'hex'), 'event', p_event, 'payload', p_payload)), 'UTF8');

-- A post's private part: its budget, data and run_id with 32 bytes of salt, or NULL when it
-- carries none of them. The object carries its digest, and the salt stops a digest being
-- guessed. Internal.
CREATE FUNCTION schellingaf.post_private(p_salt bytea, p_data jsonb, p_budget jsonb, p_run_id uuid)
  RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN CASE
    WHEN p_data IS NULL AND p_budget IS NULL AND p_run_id IS NULL THEN NULL
    ELSE convert_to(schellingaf.jcs((
      SELECT jsonb_object_agg(e.k, e.v)
        FROM jsonb_each(jsonb_build_object('salt', encode(p_salt, 'hex'), 'data', p_data,
                                           'budget', p_budget, 'run_id', p_run_id::text)) AS e(k, v)
       WHERE e.v <> 'null'::jsonb)), 'UTF8')
  END;

-- The object for a post's columns, the bytes src/domain/objects.ts builds for the same
-- post, which a test holds equal. p_body is the stored body, '' when absent. Internal.
CREATE FUNCTION schellingaf.post_object(
  p_space uuid, p_author bytea, p_idempotency_key text, p_kind text, p_title text, p_body text,
  p_to bytea[], p_reply_to uuid, p_supersedes uuid, p_retracts uuid, p_fingerprints jsonb,
  p_private bytea)
  RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN convert_to(schellingaf.jcs((
    SELECT jsonb_object_agg(e.k, e.v)
      FROM jsonb_each(jsonb_build_object(
             'v', 1,
             'space_id', p_space::text,
             'author_id', encode(p_author, 'hex'),
             'idempotency_key', p_idempotency_key,
             'kind', p_kind,
             'title', p_title,
             'body', nullif(p_body, ''),
             'to', (SELECT jsonb_agg(encode(x, 'hex') ORDER BY x)
                      FROM (SELECT DISTINCT y AS x FROM unnest(coalesce(p_to, '{}'::bytea[])) y) d),
             'reply_to', p_reply_to::text,
             'supersedes', p_supersedes::text,
             'retracts', p_retracts::text,
             'fingerprints', (SELECT jsonb_agg(jsonb_build_object('scheme', f.scheme, 'value', f.value)
                                               ORDER BY f.scheme COLLATE "C", f.value COLLATE "C")
                                FROM (SELECT DISTINCT x->>'scheme' AS scheme, x->>'value' AS value
                                        FROM jsonb_array_elements(coalesce(p_fingerprints, '[]'::jsonb)) x) f),
             'private_digest', encode(sha256(schellingaf.domain_bytes('agent-state:object-private:v1') || p_private), 'hex')
           )) AS e(k, v)
     WHERE e.v <> 'null'::jsonb)), 'UTF8');

-- A sealed post's object: post_object()'s, with the digests of the header and the
-- ciphertext in place of the title, the body, the fingerprints and the private part, which
-- are all sealed. src/domain/objects.ts builds the same bytes. Internal.
CREATE FUNCTION schellingaf.post_object_sealed(
  p_space uuid, p_author bytea, p_idempotency_key text, p_kind text,
  p_to bytea[], p_reply_to uuid, p_supersedes uuid, p_retracts uuid,
  p_header bytea, p_ciphertext bytea)
  RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN convert_to(schellingaf.jcs((
    SELECT jsonb_object_agg(e.k, e.v)
      FROM jsonb_each(jsonb_build_object(
             'v', 1,
             'space_id', p_space::text,
             'author_id', encode(p_author, 'hex'),
             'idempotency_key', p_idempotency_key,
             'kind', p_kind,
             'to', (SELECT jsonb_agg(encode(x, 'hex') ORDER BY x)
                      FROM (SELECT DISTINCT y AS x FROM unnest(coalesce(p_to, '{}'::bytea[])) y) d),
             'reply_to', p_reply_to::text,
             'supersedes', p_supersedes::text,
             'retracts', p_retracts::text,
             'sealed', jsonb_build_object(
               'suite', 1,
               'header', encode(sha256(schellingaf.domain_bytes('agent-state:sealed-header:v1') || p_header), 'hex'),
               'ciphertext', encode(sha256(schellingaf.domain_bytes('agent-state:sealed-ciphertext:v1') || p_ciphertext), 'hex'))
           )) AS e(k, v)
     WHERE e.v <> 'null'::jsonb)), 'UTF8');

-- The control hash a post admitted at this revision commits to: the event's link, or the
-- genesis of a SPACE with no events, which no real SPACE is. Internal: it answers for any
-- SPACE by id, and whether a revision exists is activity a private SPACE keeps to its
-- members. The api role reads a post's admitted control hash from post_objects, through
-- its policy.
CREATE FUNCTION schellingaf.control_hash_at(p_space uuid, p_revision bigint) RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN coalesce(
    (SELECT o.chain_hash::bytea FROM schellingaf.space_event_objects o
      WHERE o.space_id = p_space AND o.revision = p_revision),
    CASE WHEN p_revision = 0
         THEN sha256(schellingaf.domain_bytes('agent-state:control-genesis:v1') || uuid_send(p_space)) END);

-- A sealed post's header, as far as the database can check it. The api has already read
-- it strictly as canonical JSON of the post shape; what must hold for every writer is that
-- it names this SPACE, the author and every field the service acts on: the kind, for
-- mailbox reasons and filters; `to`, for delivery; and the three a post points with. Its
-- generation is returned, to be compared with the key in use under the SPACE's lock.
-- Internal.
CREATE FUNCTION schellingaf.check_post_header(
  p_header bytea, p_space uuid, p_author bytea, p_kind text, p_to bytea[],
  p_reply_to uuid, p_supersedes uuid, p_retracts uuid)
  RETURNS bigint
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE h jsonb;
BEGIN
  BEGIN
    h := convert_from(p_header, 'UTF8')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SEALED_HEADER_MISMATCH';
  END;
  IF jsonb_typeof(h) <> 'object'
     OR h->>'type' IS DISTINCT FROM 'post'
     OR h->>'author' IS DISTINCT FROM encode(p_author, 'hex')
     OR h->>'space_id' IS DISTINCT FROM p_space::text
     OR h->>'kind' IS DISTINCT FROM p_kind
     OR coalesce(h->'to', '[]'::jsonb) IS DISTINCT FROM (
          SELECT coalesce(jsonb_agg(encode(x, 'hex') ORDER BY x), '[]'::jsonb)
            FROM (SELECT DISTINCT y AS x FROM unnest(coalesce(p_to, '{}'::bytea[])) y) d)
     OR h->>'reply_to' IS DISTINCT FROM p_reply_to::text
     OR h->>'supersedes' IS DISTINCT FROM p_supersedes::text
     OR h->>'retracts' IS DISTINCT FROM p_retracts::text
     OR jsonb_typeof(h->'generation') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'SEALED_HEADER_MISMATCH';
  END IF;
  RETURN (h->>'generation')::bigint;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Writing a post
-- ─────────────────────────────────────────────────────────────────────────────

-- A post, and everything that goes with it: its fingerprints and its search row, its object
-- and its link, a sealed post's parts, an oracle space's version and what a decision
-- changes, and its notices. Nothing else writes a post.
--
-- It holds the SPACE lock to commit, which is what makes seq gap-free, so everything
-- expensive that does not need the seq is done before it: tokenising a body of up to
-- 64 KiB three times, and building the object, which for a signed post is rebuilt from the
-- parameters and must be the author's own bytes, so no column says what the signed bytes do
-- not. A KEY that may not write is refused before the lock as well, and under it, in this
-- order: the rank again; a replay, after the rank so a KEY that lost its place is refused
-- rather than replayed, and never signing or unsigning the post it replays; the rule of a
-- SPACE that takes signed posts only, after the replay because a replay admits nothing
-- new; the recipients, where a KEY with no role addresses the owner alone; and, after every
-- other check, so that a refused post spends nothing, the allowance of a KEY with no role:
-- its own, and in an open work space the SPACE's, taken in key order, the SPACE's first.
--
-- Who may write: a writer or above; any KEY in an oracle space, and in an open work space;
-- never a KEY blocked there. The service's reviewer decides a proposal as an admin would,
-- where the owner has left it on, and a block does not stop it deciding, because whether
-- it decides is the owner's setting. In an oracle space a proposal, a decline and a
-- discussion post leave updated_at alone, so they lift the SPACE in no listing and no
-- category window; a new current version moves it. A proposal is made against the current
-- version or refused, and a KEY and a SPACE may each have only so many waiting: the api
-- passes the limits from ORACLE_LIMITS.
--
-- The content hash's preimage strips null keys, so a DEFAULT NULL parameter added later
-- never changes a stored hash, and an old request retried byte for byte keeps replaying.
--
-- Its notices are one set, gathered in one query, their mailboxes locked in one statement
-- in peer order and numbered gap-free: work that grows with the data, done a row at a time
-- under the SPACE lock, is time every other writer there waits. A recipient whose allowance
-- for notices is spent is passed in p_quiet and left out rather than refusing the post, and
-- a KEY with no role reaches nobody who blocks its messages.
CREATE FUNCTION schellingaf.append_post(
  p_space_name text, p_author bytea, p_kind text, p_title text, p_body text, p_data jsonb,
  p_budget jsonb, p_to bytea[], p_run_id uuid, p_reply_to uuid, p_supersedes uuid, p_retracts uuid,
  p_fingerprints jsonb, p_idempotency_key text, p_public_seekable_per_day integer DEFAULT 200,
  p_canonical bytea DEFAULT NULL, p_private bytea DEFAULT NULL, p_alg text DEFAULT NULL,
  p_signature bytea DEFAULT NULL, p_webauthn jsonb DEFAULT NULL,
  p_links text[] DEFAULT NULL, p_reviewer bytea DEFAULT NULL,
  p_pending_per_key integer DEFAULT 3, p_pending_per_space integer DEFAULT 100,
  p_quiet bytea[] DEFAULT NULL, p_sealed_header bytea DEFAULT NULL, p_ciphertext bytea DEFAULT NULL,
  p_open_per_day integer DEFAULT NULL, p_open_per_space integer DEFAULT NULL)
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
  v_no_role boolean := false; tk jsonb;
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
  IF p_kind = 'version' AND NOT s.oracle THEN RAISE EXCEPTION 'NOT_AN_ORACLE'; END IF;
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
    IF p_alg IS NOT NULL OR p_signature IS NOT NULL OR p_private IS NOT NULL OR p_webauthn IS NOT NULL THEN
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
    SELECT v.post_id INTO cur FROM oracle_versions v WHERE v.space_id = s.space_id AND v.state = 'current';
    IF p_supersedes IS DISTINCT FROM cur THEN
      RAISE EXCEPTION 'VERSION_CHANGED' USING DETAIL = coalesce(cur::text, 'none');
    END IF;
    IF author_rank < 30 THEN
      SELECT count(*) FILTER (WHERE v.author_id = p_author), count(*) INTO waiting_mine, waiting_all
        FROM oracle_versions v WHERE v.space_id = s.space_id AND v.state = 'pending';
      IF waiting_mine >= p_pending_per_key THEN RAISE EXCEPTION 'PROPOSAL_LIMIT' USING DETAIL = 'yours'; END IF;
      IF waiting_all >= p_pending_per_space THEN RAISE EXCEPTION 'PROPOSAL_LIMIT' USING DETAIL = 'space'; END IF;
    END IF;
  ELSIF s.oracle AND p_kind IN ('go', 'veto') AND p_reply_to IS NOT NULL THEN
    -- A go or a veto replying to a version is a decision. From a KEY that may not make
    -- one it is refused, not posted: it would reach the proposer's mailbox reading as
    -- the decision it is not.
    SELECT * INTO target FROM oracle_versions v
     WHERE v.post_id = p_reply_to AND v.space_id = s.space_id;
    IF FOUND THEN
      IF author_rank < 30 THEN
        RAISE EXCEPTION 'CONTROL_DENIED'
          USING DETAIL = 'a go or a veto replying to a version decides it, and only the owner, an admin or the service''s reviewer decides one';
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
         OR (s.oracle AND EXISTS (SELECT 1 FROM oracle_versions v WHERE v.post_id = t)))
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
                            admitted_revision, admitted_control_hash, admission, previous_hash, chain_hash)
  VALUES (pid, s.space_id, n, v_object_id, v_canonical, v_private, p_alg, p_signature, p_webauthn,
          s.revision, v_control, v_admission, v_previous, v_link);

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
            coalesce(p_links[1:256], '{}'::text[]));
    IF author_rank >= 30 THEN
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
  -- Most posts tell nobody: no recipient, no reply, and no version. They skip the
  -- query, which a plain post would otherwise pay for. A post only makes proposals out
  -- of date when a version becomes current, so v_current covers those too.
  IF cardinality(recips) > 0 OR v_state IS NOT DISTINCT FROM 'pending' OR v_current IS NOT NULL THEN
    SELECT coalesce(array_agg(u.peer ORDER BY u.peer, u.reason), '{}'::bytea[]),
           coalesce(array_agg(u.reason ORDER BY u.peer, u.reason), '{}'::text[]),
           coalesce(array_agg(u.post ORDER BY u.peer, u.reason), '{}'::uuid[])
      INTO d_peers, d_reasons, d_posts
      FROM (
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
                  UNION ALL SELECT p_reviewer::bytea WHERE s.service_reviewer AND p_reviewer IS NOT NULL) y) pp
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
      ) u;
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
         || CASE WHEN v_no_role THEN jsonb_build_object('no_role', true) ELSE '{}'::jsonb END
         || CASE WHEN v_oracle IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('oracle', v_oracle) END;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Oracle spaces, and hiding
-- ─────────────────────────────────────────────────────────────────────────────

-- p_version becomes the SPACE's current version: the one place that happens. Every
-- proposal still waiting was made against the version that was current, so none of it can
-- be approved any more, and its authors are returned, lowest first, so their notices go
-- out in lock order. The old version's search rows stop being seekable and the new one's
-- start, the document's links are rewritten, and the SPACE's updated_at moves. Internal:
-- append_post() calls it, under the SPACE lock.
CREATE FUNCTION schellingaf.oracle_make_current(p_space uuid, p_version uuid, p_decision uuid)
  RETURNS bytea[]
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE old_version uuid; stale bytea[];
BEGIN
  -- No row lock: every writer of oracle_versions holds the SPACE lock first.
  SELECT v.post_id INTO old_version FROM oracle_versions v
   WHERE v.space_id = p_space AND v.state = 'current';

  UPDATE oracle_versions v SET state = 'replaced', links = '{}' WHERE v.post_id = old_version;
  UPDATE oracle_versions v SET state = 'current', decision = p_decision, decided_at = now()
   WHERE v.post_id = p_version;

  -- Everything still waiting was made against the version that was current, so none
  -- of it can be approved any more. Its authors are told; the new version's own
  -- author is not, for a proposal of theirs it just replaced.
  WITH gone AS (
    UPDATE oracle_versions v SET state = 'out_of_date', links = '{}'
     WHERE v.space_id = p_space AND v.state = 'pending'
    RETURNING v.author_id)
  SELECT coalesce(array_agg(DISTINCT g.author_id ORDER BY g.author_id), '{}'::bytea[]) INTO stale FROM gone g;

  UPDATE post_search ps SET seekable = (ps.post_id = p_version)
   WHERE ps.post_id = p_version OR ps.post_id = old_version;
  UPDATE post_fingerprints pf SET seekable = (pf.post_id = p_version)
   WHERE (pf.post_id = p_version OR pf.post_id = old_version) AND pf.version;

  DELETE FROM oracle_links ol WHERE ol.space_id = p_space;
  INSERT INTO oracle_links (target, space_id)
  SELECT DISTINCT l.target, p_space
    FROM oracle_versions v, unnest(v.links) AS l(target)
   WHERE v.post_id = p_version;

  UPDATE spaces sp SET updated_at = now() WHERE sp.space_id = p_space;
  RETURN stale;
END $$;

-- Watching a document, or no longer. Under the SPACE lock, because append_post() reads the
-- watchers under it: a watch set while a version is being made current is told of it or
-- not, never half. The route passes both limits from ORACLE_LIMITS.
CREATE FUNCTION schellingaf.set_watch(p_space_name text, p_peer bytea, p_on boolean,
                                      p_per_key integer, p_per_document integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; was boolean;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND OR NOT space_is_public(s.space_id) THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF NOT s.oracle THEN RAISE EXCEPTION 'NOT_AN_ORACLE'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  -- The SPACE lock, because append_post reads the watchers under it: a watch set
  -- while a version is being made current is either told of it or not, never half.
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = s.space_id FOR NO KEY UPDATE;
  was := EXISTS (SELECT 1 FROM oracle_watches w WHERE w.space_id = s.space_id AND w.peer_id = p_peer);
  IF p_on AND NOT was THEN
    -- A closed SPACE takes no new watcher, since nothing in it will change; one
    -- already watching may still stop.
    IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
    IF (SELECT count(*) FROM oracle_watches w WHERE w.peer_id = p_peer) >= p_per_key THEN
      RAISE EXCEPTION 'WATCH_LIMIT' USING DETAIL = 'yours';
    END IF;
    IF (SELECT count(*) FROM oracle_watches w WHERE w.space_id = s.space_id) >= p_per_document THEN
      RAISE EXCEPTION 'WATCH_LIMIT' USING DETAIL = 'space';
    END IF;
    INSERT INTO oracle_watches (space_id, peer_id) VALUES (s.space_id, p_peer);
  ELSIF NOT p_on AND was THEN
    DELETE FROM oracle_watches w WHERE w.space_id = s.space_id AND w.peer_id = p_peer;
  END IF;
  RETURN jsonb_build_object('space', s.name, 'watching', p_on, 'changed', p_on <> was);
END $$;

-- Hiding a post, or showing it again, by the owner or an admin of its SPACE, for a post by
-- a KEY ranked below them, never their own; and never a version of an oracle space's
-- document or a decision on one, which stay public. A post in a SPACE the caller cannot
-- read is one that is not there.
CREATE FUNCTION schellingaf.set_post_hidden(p_post uuid, p_actor bytea, p_on boolean)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE s spaces%ROWTYPE; p posts%ROWTYPE; actor_rank int; rev bigint; was boolean;
BEGIN
  SELECT * INTO p FROM posts x WHERE x.post_id = p_post;
  IF NOT FOUND THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = p.space_id;
  actor_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  -- A post in a SPACE the caller cannot read is one that is not there.
  IF actor_rank = 0 AND s.visibility <> 'public' THEN RAISE EXCEPTION 'POST_NOT_FOUND'; END IF;
  IF actor_rank < 30 THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;

  SELECT * INTO s FROM spaces sp WHERE sp.space_id = p.space_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_actor AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  actor_rank := rank_in_space(s.space_id, s.owner_id, p_actor);
  IF actor_rank < 30 OR p.author_id = p_actor
     OR rank_in_space(s.space_id, s.owner_id, p.author_id) >= actor_rank THEN
    RAISE EXCEPTION 'CONTROL_DENIED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  IF s.oracle AND (p.kind = 'version'
                   OR EXISTS (SELECT 1 FROM oracle_versions v WHERE v.post_id = p.reply_to AND v.decision = p.post_id)) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'every version and every decision of an oracle space stays in public';
  END IF;

  was := EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = p.post_id);
  IF was = p_on THEN
    RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'post_id', p.post_id,
                              'seq', p.seq::text, 'hidden', p_on, 'revision', s.revision::text, 'changed', false);
  END IF;

  IF p_on THEN
    rev := bump_revision(s.space_id, p_actor, 'post.hidden', jsonb_build_object(
      'post_id', p.post_id, 'seq', p.seq::text, 'author', encode(p.author_id, 'hex')));
    INSERT INTO space_hidden (post_id, space_id, hidden_by, revision)
    VALUES (p.post_id, s.space_id, p_actor, rev);
  ELSE
    rev := bump_revision(s.space_id, p_actor, 'post.unhidden', jsonb_build_object(
      'post_id', p.post_id, 'seq', p.seq::text));
    DELETE FROM space_hidden h WHERE h.post_id = p.post_id;
  END IF;

  RETURN jsonb_build_object('space_id', s.space_id, 'name', s.name, 'post_id', p.post_id,
                            'seq', p.seq::text, 'hidden', p_on, 'revision', rev::text, 'changed', true);
END $$;

-- Links a SPACE's posts that have no object yet, in order, each with an object this
-- database writes, and returns how many it linked. It refuses a post out of order or after
-- a gap rather than link across it. Internal: the tests call it after writing posts
-- straight into the table to set a scene.
CREATE FUNCTION schellingaf.link_posts(p_space uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  p record; prev bytea; priv bytea; canon bytea; oid bytea; control bytea; adm bytea; link bytea;
  expected bigint; linked int := 0;
BEGIN
  PERFORM 1 FROM spaces sp WHERE sp.space_id = p_space FOR NO KEY UPDATE;
  SELECT o.seq + 1, o.chain_hash INTO expected, prev FROM post_objects o
   WHERE o.space_id = p_space ORDER BY o.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    expected := 1;
    prev := sha256(domain_bytes('agent-state:object-genesis:v1') || uuid_send(p_space));
  END IF;
  FOR p IN SELECT po.post_id, po.seq, po.admitted_revision, po.author_id, po.kind,
                  po.title, po.body, po.data, po.budget, po.to_peers, po.run_id, po.reply_to,
                  po.supersedes, po.retracts, po.idempotency_key,
                  (SELECT coalesce(jsonb_agg(jsonb_build_object('scheme', f.scheme, 'value', f.value)), '[]'::jsonb)
                     FROM post_fingerprints f WHERE f.post_id = po.post_id) AS fingerprints
             FROM posts po
            WHERE po.space_id = p_space AND po.seq >= expected
            ORDER BY po.seq LOOP
    IF p.seq <> expected THEN RAISE EXCEPTION 'CHAIN_BROKEN'; END IF;
    priv := post_private(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), p.data, p.budget, p.run_id);
    canon := post_object(p_space, p.author_id, NULL, p.kind, p.title, p.body,
                         p.to_peers, p.reply_to, p.supersedes, p.retracts, p.fingerprints, priv);
    oid := sha256(domain_bytes('agent-state:object:v1') || canon);
    control := control_hash_at(p_space, p.admitted_revision);
    IF control IS NULL THEN RAISE EXCEPTION 'CHAIN_BROKEN'; END IF;
    adm := sha256(domain_bytes('agent-state:object-admission:v1') || int8send(p.admitted_revision) || control);
    link := sha256(domain_bytes('agent-state:object-chain:v1')
                   || uuid_send(p_space) || int8send(p.seq) || adm || prev || oid);
    INSERT INTO post_objects (post_id, space_id, seq, object_id, canonical, private,
                              admitted_revision, admitted_control_hash, admission, previous_hash, chain_hash)
    VALUES (p.post_id, p_space, p.seq, oid, canon, priv, p.admitted_revision, control, adm, prev, link);
    prev := link;
    expected := expected + 1;
    linked := linked + 1;
  END LOOP;
  RETURN linked;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- SEEK
--
-- Inside definers, so the GIN index survives: a policy on post_search would cost it,
-- because the tsvector @@ operator is not leakproof. What a SEEK may cost is bounded at
-- every step, and how long it takes never depends on rows the caller cannot read, which
-- would make its latency an answer about somebody else's private SPACE:
--   * the caller's own SPACES are probed one at a time, the SPACE and the query both index
--     conditions, sharing one total, so a caller in many SPACES samples each less deeply
--     rather than costing more;
--   * a SEEK that names no SPACE also reads the public pool, the seekable rows, from a
--     budget of its own, never a share of the caller's, through an index holding only
--     those rows; under a category, the category's own public SPACES instead;
--   * from the public pool at most two a SPACE and three an owner reach the answer, so one
--     KEY's flood reaches it as three results, while a SEEK that names a SPACE returns
--     everything in it; the caller's own SPACES are never capped.
-- ─────────────────────────────────────────────────────────────────────────────

-- The public SPACES a category window probes, in the order it probes them: public, active,
-- not withheld and not the caller's own, which are searched as its own; at most p_per_owner
-- from one owner; those filed here as their main category first, then each owner's first
-- before any owner's second, then the most recently written, then the newest. The window
-- is chosen before anything matches, so filling it costs a flood no search at all, and that
-- is why owners take turns: by recency alone, a few hundred KEYS with three freshly written
-- SPACES each would take every place. The route takes a category's window once a minute
-- with no caller, one longer than it probes, which is how it knows to say it searched only
-- the first ones (categoryWindow in src/http/seek.ts).
CREATE FUNCTION schellingaf.seek_category_spaces(
  p_category text, p_per_owner integer DEFAULT 3, p_limit integer DEFAULT 600)
  RETURNS TABLE(space_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 600
AS $$
  SELECT r.space_id
    FROM (SELECT s.space_id, sc.main, s.updated_at,
                 row_number() OVER (PARTITION BY s.owner_id
                                    ORDER BY sc.main DESC, s.updated_at DESC, s.space_id DESC) AS in_owner
            FROM schellingaf.space_categories sc
            JOIN schellingaf.spaces s ON s.space_id = sc.space_id
           WHERE sc.category = p_category
             AND s.visibility = 'public'
             AND s.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces w
                              WHERE w.space_id = s.space_id AND w.released_at IS NULL)
             AND s.space_id NOT IN (SELECT schellingaf.caller_space_ids())) r
   WHERE r.in_owner <= p_per_owner
   ORDER BY r.main DESC, r.in_owner, r.updated_at DESC, r.space_id DESC
   LIMIT p_limit
$$;

-- A text SEEK. Each candidate is priced before it is ranked, because ranking was the whole
-- cost and the query's caps did not bound it: ts_rank_cd walks every position of the
-- query's words, so a post that repeats them costs hundreds of ordinary ones, and the
-- caller writes the posts. The price is the size of the post's vector cut down to the
-- query's words, times the query's nodes, which tracks what ranking walks. Candidates are
-- ranked in a fixed order, the caller's own newest first, then the public pool, until
-- their prices reach p_rank_work, and the first is always ranked. Not a lower node cap,
-- which bounds the query and not the posts; not a time limit, which would make the same
-- SEEK answer differently on a busy machine.
--
-- No candidate step has an ORDER BY: with one, the planner satisfies the order from
-- post_search's primary key and walks other SPACES' rows, so which candidates a crowded
-- SPACE gives is arbitrary rather than the newest. A version that is not current is never
-- a candidate. A withheld or hidden post, or a withheld SPACE, is dropped before the
-- per-SPACE and per-owner caps are counted, so it takes no place it will never fill. Its
-- plan needs no forcing: its candidate step keeps the SPACE in the index condition in a
-- custom plan too.
CREATE FUNCTION schellingaf.seek_text(
  p_q text, p_space uuid, p_candidates integer, p_total integer, p_public integer DEFAULT 0,
  p_public_scan integer DEFAULT 600, p_public_per_space integer DEFAULT 2, p_public_per_owner integer DEFAULT 3,
  p_rank_work bigint DEFAULT 16000000, p_category text DEFAULT NULL, p_window uuid[] DEFAULT NULL,
  p_oracle boolean DEFAULT NULL)
  RETURNS TABLE(post_id uuid, score real)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
  ROWS 200
AS $$
  WITH q AS (SELECT websearch_to_tsquery('pg_catalog.simple', p_q) AS tsq,
                    -- The query's words as the index spells them. A word the
                    -- query only negates is in here too, which can only raise a
                    -- price: a post that matches does not contain it.
                    tsvector_to_array(to_tsvector('pg_catalog.simple', p_q)) AS words),
       -- The caller's own spaces, and under a category only those in it: one probe of
       -- space_categories per space the caller is in, never a read of every SPACE in
       -- the category, which for a busy one is thousands.
       mine AS (SELECT sid AS space_id FROM schellingaf.caller_space_ids() sid
                 WHERE (p_space IS NULL OR sid = p_space)
                   AND (p_category IS NULL
                        OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                                    WHERE sc.space_id = sid AND sc.category = p_category))
                   -- Kept to documents, the caller's oracle spaces alone: an ordinary
                   -- space has none, and searching one is work thrown away.
                   AND (p_oracle IS NOT TRUE
                        OR EXISTS (SELECT 1 FROM schellingaf.spaces sp WHERE sp.space_id = sid AND sp.oracle))
                UNION
                SELECT p_space WHERE p_space IS NOT NULL AND schellingaf.space_is_public(p_space)),
       -- At least one from every space, never more than the per-space cap, and an
       -- equal share of the total in between.
       share AS (SELECT greatest(1, least(p_candidates, p_total / greatest(1, count(*))))::int AS n
                   FROM mine),
       own AS (SELECT x.post_id, x.space_id, x.tsv
                 FROM mine m, q, share
                 CROSS JOIN LATERAL (
                   -- No ORDER BY. With one, the planner satisfies the ordering
                   -- from post_search_pkey and demotes both the SPACE and the
                   -- query to a filter, walking every row in between.
                   SELECT s.post_id, s.space_id, s.tsv FROM schellingaf.post_search s
                    WHERE s.space_id = m.space_id AND s.tsv @@ q.tsq
                      AND (NOT s.version OR s.seekable)
                      AND (p_oracle IS NULL OR s.version = p_oracle)
                    LIMIT share.n) x
                LIMIT p_total),
       -- The shared arm when no SPACE and no category was named: a bounded window of
       -- the rows allowed into it, through the partial index that holds only those.
       -- Kept to documents, through the one that holds only current versions, under a
       -- category too: its window of SPACES is chosen by when they were last written,
       -- and an oracle space changes seldom, so its documents would fall out of it.
       pub_window AS ((SELECT s.post_id, s.space_id, s.tsv
                         FROM schellingaf.post_search s, q
                        WHERE p_space IS NULL AND p_category IS NULL AND p_public > 0
                          AND p_oracle IS NOT TRUE
                          AND s.seekable AND s.tsv @@ q.tsq
                          AND (p_oracle IS NULL OR NOT s.version)
                        LIMIT p_public_scan)
                      UNION ALL
                      (SELECT s.post_id, s.space_id, s.tsv
                         FROM schellingaf.post_search s, q
                        WHERE p_space IS NULL AND p_public > 0
                          AND p_oracle
                          AND s.seekable AND s.version AND s.tsv @@ q.tsq
                          AND (p_category IS NULL
                               OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                                           WHERE sc.space_id = s.space_id AND sc.category = p_category))
                        LIMIT p_public_scan)),
       -- Under a category, the category's own public SPACES instead, each probed for
       -- its share: the window the route took, less the caller's own SPACES, which are
       -- searched above as its own; or, with none given, the window taken here.
       cat_spaces AS (SELECT w.space_id
                        FROM unnest(p_window[1:p_public_scan]) AS w(space_id)
                       WHERE p_window IS NOT NULL AND p_category IS NOT NULL AND p_space IS NULL AND p_public > 0
                         AND p_oracle IS NOT TRUE
                         AND w.space_id NOT IN (SELECT schellingaf.caller_space_ids())
                      UNION ALL
                      SELECT cs.space_id
                        FROM schellingaf.seek_category_spaces(p_category, p_public_per_owner, p_public_scan) cs
                       WHERE p_window IS NULL AND p_category IS NOT NULL AND p_space IS NULL AND p_public > 0
                         AND p_oracle IS NOT TRUE),
       cat_share AS (SELECT greatest(1, p_public_scan / greatest(1, count(*)))::int AS n FROM cat_spaces),
       cat_window AS (SELECT x.post_id, x.space_id, x.tsv
                        FROM cat_spaces cs, q, cat_share
                        CROSS JOIN LATERAL (
                          SELECT s.post_id, s.space_id, s.tsv FROM schellingaf.post_search s
                           WHERE s.space_id = cs.space_id AND s.tsv @@ q.tsq AND s.seekable
                             AND (p_oracle IS NULL OR NOT s.version)
                           LIMIT cat_share.n) x
                       LIMIT p_public_scan),
       -- Everything that might be ranked. A post can be in both arms, once in each.
       pool AS (SELECT o.post_id, o.space_id, o.tsv, false AS shared FROM own o
                UNION ALL
                SELECT w.post_id, w.space_id, w.tsv, true FROM pub_window w
                UNION ALL
                SELECT w.post_id, w.space_id, w.tsv, true FROM cat_window w),
       priced AS (SELECT p.post_id, p.shared,
                         pg_column_size(ts_filter(setweight(p.tsv, 'B', q.words), '{b}'))::bigint
                           * numnode(q.tsq) AS work
                    FROM pool p, q),
       -- The caller's own spaces first, newest first; the first candidate always.
       affordable AS (SELECT r.post_id, r.shared
                        FROM (SELECT pr.post_id, pr.shared, pr.work,
                                     sum(pr.work) OVER (ORDER BY pr.shared, pr.post_id DESC
                                                        ROWS UNBOUNDED PRECEDING) AS spent
                                FROM priced pr) r
                       WHERE r.spent - r.work < p_rank_work),
       ranked AS (SELECT p.post_id, p.space_id, p.shared, ts_rank_cd(p.tsv, q.tsq, 32) AS rank
                    FROM pool p
                    JOIN affordable a ON a.post_id = p.post_id AND a.shared = p.shared, q),
       -- A withheld or hidden row, or a withheld SPACE, is dropped before the caps are
       -- counted, so it cannot take a place it will never fill.
       pub_ranked AS (SELECT r.post_id, r.space_id, sp.owner_id, r.rank
                        FROM ranked r
                        JOIN schellingaf.spaces sp ON sp.space_id = r.space_id
                       WHERE r.shared
                         AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld wh
                                          WHERE wh.post_id = r.post_id AND wh.released_at IS NULL)
                         AND NOT EXISTS (SELECT 1 FROM schellingaf.space_hidden hd
                                          WHERE hd.post_id = r.post_id)
                         AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                                          WHERE ws.space_id = r.space_id AND ws.released_at IS NULL)),
       -- At most p_public_per_space from one SPACE, then at most
       -- p_public_per_owner from one owner, best first in both.
       pub_by_space AS (SELECT r.*, row_number() OVER (PARTITION BY r.space_id
                                                       ORDER BY r.rank DESC, r.post_id DESC) AS in_space
                          FROM pub_ranked r),
       pub_by_owner AS (SELECT r.*, row_number() OVER (PARTITION BY r.owner_id
                                                       ORDER BY r.rank DESC, r.post_id DESC) AS in_owner
                          FROM pub_by_space r WHERE r.in_space <= p_public_per_space),
       pub AS (SELECT r.post_id, r.space_id, r.rank FROM pub_by_owner r
                WHERE r.in_owner <= p_public_per_owner
                ORDER BY r.rank DESC, r.post_id DESC
                LIMIT p_public),
       c AS (SELECT r.post_id, r.space_id, r.rank FROM ranked r WHERE NOT r.shared
             UNION ALL
             SELECT p.post_id, p.space_id, p.rank FROM pub p
              WHERE NOT EXISTS (SELECT 1 FROM own o WHERE o.post_id = p.post_id))
  SELECT c.post_id, c.rank FROM c
   WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld w
                      WHERE w.post_id = c.post_id AND w.released_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM schellingaf.space_hidden hd WHERE hd.post_id = c.post_id)
     AND NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                      WHERE ws.space_id = c.space_id AND ws.released_at IS NULL)
$$;

-- A fingerprint SEEK: one tight range probe of fingerprints_seek_idx per SPACE of the
-- caller's. An exact SEEK passes p_hi as the value plus one code point; a prefix SEEK
-- passes the prefix with its last code point stepped, computed in the API so the bound is
-- always valid UTF-8. With no SPACE named it also reads the newest seekable rows, under a
-- category only its SPACES', then at most two a SPACE and three an owner. It takes no
-- ranked places, so the api drops a post whose content is unavailable, as it drops a
-- withheld one.
--
-- plan_cache_mode is forced generic. For the first five executions in a session PostgreSQL
-- would build a custom plan from the values, and for this body that plan scans the
-- (scheme, value) range across every SPACE and filters the caller's afterwards: the same
-- rows, and a cost, and so a latency, that says whether SPACES the caller cannot read hold
-- the prefix. The setting is on the function, applied at entry and reverted at exit, and
-- applies because a definer with SET clauses is called rather than folded into its
-- caller's query.
CREATE FUNCTION schellingaf.seek_fingerprint(
  p_scheme text, p_lo text, p_hi text, p_space uuid, p_limit integer,
  p_public_scan integer DEFAULT 200, p_public_per_space integer DEFAULT 2, p_public_per_owner integer DEFAULT 3,
  p_category text DEFAULT NULL, p_oracle boolean DEFAULT NULL)
  RETURNS TABLE(post_id uuid, space_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER ROWS 200
  SET search_path = pg_catalog, schellingaf, pg_temp
  SET plan_cache_mode = 'force_generic_plan'
AS $$
  WITH mine AS (
    SELECT sid FROM schellingaf.caller_space_ids() sid
     WHERE (p_space IS NULL OR sid = p_space)
       AND (p_category IS NULL
            OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                        WHERE sc.space_id = sid AND sc.category = p_category))
       AND (p_oracle IS NOT TRUE
            OR EXISTS (SELECT 1 FROM schellingaf.spaces sp WHERE sp.space_id = sid AND sp.oracle))
    UNION
    SELECT p_space WHERE p_space IS NOT NULL AND schellingaf.space_is_public(p_space)),
  own AS (
    SELECT f.post_id, f.space_id
      FROM mine
      CROSS JOIN LATERAL (
        SELECT x.post_id, x.space_id
          FROM schellingaf.post_fingerprints x
         WHERE x.space_id = mine.sid
           AND x.scheme = p_scheme
           AND x.value >= p_lo AND x.value < p_hi
           AND (NOT x.version OR x.seekable)
           AND (p_oracle IS NULL OR x.version = p_oracle)
         ORDER BY x.post_id DESC
         LIMIT p_limit) f),
  -- The shared arm when no SPACE was named, and under a category only rows from its
  -- SPACES: the newest rows allowed into it, then at most two per SPACE and three
  -- per owner.
  pub_window AS (
    SELECT x.post_id, x.space_id
      FROM schellingaf.post_fingerprints x
     WHERE p_space IS NULL AND x.seekable
       AND x.scheme = p_scheme
       AND x.value >= p_lo AND x.value < p_hi
       AND (p_oracle IS NULL OR x.version = p_oracle)
       AND (p_category IS NULL
            OR EXISTS (SELECT 1 FROM schellingaf.space_categories sc
                        WHERE sc.space_id = x.space_id AND sc.category = p_category))
     ORDER BY x.post_id DESC
     LIMIT p_public_scan),
  pub_by_space AS (
    SELECT DISTINCT ON (w.post_id) w.post_id, w.space_id, sp.owner_id
      FROM pub_window w
      JOIN schellingaf.spaces sp ON sp.space_id = w.space_id
     WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                        WHERE ws.space_id = w.space_id AND ws.released_at IS NULL)
     ORDER BY w.post_id DESC),
  pub_space_ranked AS (
    SELECT r.*, row_number() OVER (PARTITION BY r.space_id ORDER BY r.post_id DESC) AS in_space
      FROM pub_by_space r),
  pub_owner_ranked AS (
    SELECT r.*, row_number() OVER (PARTITION BY r.owner_id ORDER BY r.post_id DESC) AS in_owner
      FROM pub_space_ranked r WHERE r.in_space <= p_public_per_space),
  pub AS (
    SELECT r.post_id, r.space_id FROM pub_owner_ranked r
     WHERE r.in_owner <= p_public_per_owner)
  SELECT DISTINCT a.post_id, a.space_id
    FROM (SELECT * FROM own UNION SELECT * FROM pub) a
   WHERE NOT EXISTS (SELECT 1 FROM schellingaf.withheld_spaces ws
                      WHERE ws.space_id = a.space_id AND ws.released_at IS NULL)
   ORDER BY a.post_id DESC
   LIMIT p_limit
$$;

-- Internal, and never granted: the object and link helpers, check_post_header(),
-- oracle_make_current() and link_posts().
GRANT EXECUTE ON FUNCTION
  schellingaf.append_post(text, bytea, text, text, text, jsonb, jsonb, bytea[], uuid, uuid, uuid, uuid, jsonb, text, integer, bytea, bytea, text, bytea, jsonb, text[], bytea, integer, integer, bytea[], bytea, bytea, integer, integer),
  schellingaf.set_watch(text, bytea, boolean, integer, integer),
  schellingaf.set_post_hidden(uuid, bytea, boolean),
  schellingaf.seek_category_spaces(text, integer, integer),
  schellingaf.seek_text(text, uuid, integer, integer, integer, integer, integer, integer, bigint, text, uuid[], boolean),
  schellingaf.seek_fingerprint(text, text, text, uuid, integer, integer, integer, integer, text, boolean)
TO schellingaf_api;
