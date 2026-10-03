-- A POST's summary: what a reader needs before its body, in a few sentences, written by its
-- author beside the title and the body. A read at snippets shows it in place of the first
-- 280 characters, at full beside the body, and a headline flags it, so a reader decides
-- whether to open a POST from words its author chose (src/http/postview.ts).
--
-- 1 to 4,096 bytes, or none; src/http/posts.ts refuses one on a version, whose title says
-- what changed, and beside a sealed POST, whose title and body are sealed together, and
-- append_post() refuses it in a sealed SPACE as it refuses every word it could read.
-- Old posts have none: posts is immutable, and nothing is backfilled.
--
-- Signed: summary is a key of the v1 object (OBJECT_FIELDS in src/domain/objects.ts), so
-- a signature covers it; an object without one is byte for byte what it was. The content
-- hash a replay is compared by carries it the same way, null left out, so a replay of a
-- POST written before this file hashes as it did, and a replay with another summary is
-- IDEMPOTENCY_CONFLICT. SEEK finds a summary's words, weighted B, between the title's and
-- the body's.
--
-- What opening a POST costs is priced, in its headline's `open`, from the bytes its body
-- and its data take in an answer's JSON, which neither the body's stored length (escapes
-- such as a quote or a line end take two bytes in JSON) nor data's stored size (compressed)
-- gives. So posts gains body_json_bytes and data_json_bytes, written once with the POST:
-- the body's from its JSON string, quotes left out; the data's from p_data_json_bytes, the
-- length of the JSON the service serialised it as, or else from its stored text. Old posts
-- have neither, and their `open` is an estimate from the stored sizes.
--
-- post_object() gains p_summary, last, and so is dropped and made again; link_posts() and
-- append_post(), its two callers, are replaced with it. append_post() is 0123's, with
-- p_summary text DEFAULT NULL and p_data_json_bytes integer DEFAULT NULL last: dropped by
-- 0118's argument list, made again and granted again to schellingaf_api alone. Its answer
-- also names the POST's admitted_revision, which the posts route prices read_cost with and
-- answers nobody. visible_posts gains summary, body_json_bytes and data_json_bytes as its
-- last columns, each blanked like the title on a hidden or withheld POST.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- The column
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE schellingaf.posts ADD COLUMN summary text;
ALTER TABLE schellingaf.posts ADD CONSTRAINT posts_summary_bytes
  CHECK (summary IS NULL OR octet_length(summary) BETWEEN 1 AND 4096) NOT VALID;
ALTER TABLE schellingaf.posts VALIDATE CONSTRAINT posts_summary_bytes;
ALTER TABLE schellingaf.posts ADD COLUMN body_json_bytes integer, ADD COLUMN data_json_bytes integer;

-- ─────────────────────────────────────────────────────────────────────────────
-- What SEEK reads
-- ─────────────────────────────────────────────────────────────────────────────

-- search_vector(title, body) of 0101_foundation.sql, with the summary between them,
-- weighted B and split as the body is. With no summary it is the two-argument one's
-- vector exactly, which scripts/seed.ts and scripts/seek-ceiling.ts still call.
CREATE FUNCTION schellingaf.search_vector(title text, summary text, body text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN setweight(to_tsvector('pg_catalog.simple', coalesce(title, '')), 'A')
      || setweight(to_tsvector('pg_catalog.simple', coalesce(summary, ''))
                   || to_tsvector('pg_catalog.simple',
                                  regexp_replace(coalesce(summary, ''), '[/\\:@=#]+', ' ', 'g')), 'B')
      || to_tsvector('pg_catalog.simple', left(coalesce(body, ''), 32768))
      || to_tsvector('pg_catalog.simple',
                     regexp_replace(left(coalesce(body, ''), 32768), '[/\\:@=#]+', ' ', 'g'));

-- ─────────────────────────────────────────────────────────────────────────────
-- The object
-- ─────────────────────────────────────────────────────────────────────────────

-- post_object() of 0107_posts.sql, with p_summary last: the object carries it when there
-- is one, and is otherwise byte for byte what it was. Internal.
DROP FUNCTION schellingaf.post_object(uuid, bytea, text, text, text, text, bytea[], uuid, uuid, uuid, jsonb, bytea);
CREATE FUNCTION schellingaf.post_object(
  p_space uuid, p_author bytea, p_idempotency_key text, p_kind text, p_title text, p_body text,
  p_to bytea[], p_reply_to uuid, p_supersedes uuid, p_retracts uuid, p_fingerprints jsonb,
  p_private bytea, p_summary text)
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
             'summary', p_summary,
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

-- link_posts() of 0107_posts.sql, passing each post's summary to post_object().
CREATE OR REPLACE FUNCTION schellingaf.link_posts(p_space uuid) RETURNS integer
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
                  po.supersedes, po.retracts, po.idempotency_key, po.summary,
                  (SELECT coalesce(jsonb_agg(jsonb_build_object('scheme', f.scheme, 'value', f.value)), '[]'::jsonb)
                     FROM post_fingerprints f WHERE f.post_id = po.post_id) AS fingerprints
             FROM posts po
            WHERE po.space_id = p_space AND po.seq >= expected
            ORDER BY po.seq LOOP
    IF p.seq <> expected THEN RAISE EXCEPTION 'CHAIN_BROKEN'; END IF;
    priv := post_private(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), p.data, p.budget, p.run_id);
    canon := post_object(p_space, p.author_id, NULL, p.kind, p.title, p.body,
                         p.to_peers, p.reply_to, p.supersedes, p.retracts, p.fingerprints, priv, p.summary);
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
-- A post
-- ─────────────────────────────────────────────────────────────────────────────

-- append_post() as 0123_space_stages.sql made it, with one parameter more, p_summary,
-- last: in the content hash, refused in a sealed SPACE, in the search vector, in both
-- post_object() calls and written to its column. Dropped and made again because its
-- argument list changed, and granted again.
DROP FUNCTION schellingaf.append_post(text, bytea, text, text, text, jsonb, jsonb, bytea[], uuid, uuid, uuid, uuid, jsonb, text, integer, bytea, bytea, text, bytea, jsonb, text[], bytea, integer, integer, bytea[], bytea, bytea, integer, integer, bytea);
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
               (SELECT jsonb_build_object('oracle', jsonb_build_object('state', v.state))
                  FROM oracle_versions v WHERE v.post_id = prior.post_id)
             WHEN prior.kind IN ('go', 'veto') AND prior.reply_to IS NOT NULL THEN
               (SELECT jsonb_build_object('oracle', jsonb_build_object(
                         'decided', CASE prior.kind WHEN 'go' THEN 'approved' ELSE 'declined' END,
                         'version', v.post_id))
                       -- The stage it set: a go that decided passed the rank a decision
                       -- takes, 25 or more, unless the reviewer's exemption let it.
                       || CASE WHEN prior.kind = 'go' AND v.stage_word IS NOT NULL
                                    AND prior.author_id::bytea IS DISTINCT FROM p_reviewer
                               THEN jsonb_build_object('stage_set',
                                      jsonb_build_object('word', v.stage_word, 'note', v.stage_note))
                               ELSE '{}'::jsonb END
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
    v_oracle := jsonb_build_object('state', v_state);
  ELSIF v_decision = 'go' THEN
    -- A proposal still waiting was made against the version current now: approving
    -- any other makes every waiting one out of date.
    stale := oracle_make_current(s.space_id, target.post_id, pid, p_reviewer);
    v_current := target.post_id;
    v_oracle := jsonb_build_object('decided', 'approved', 'version', target.post_id);
    -- The stage this go set, if it set one: the SPACE's stage now names the version.
    SELECT jsonb_build_object('word', st.word, 'note', st.note) INTO v_stage_set
      FROM space_stages st WHERE st.space_id = s.space_id AND st.post_id = target.post_id;
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

GRANT EXECUTE ON FUNCTION
  schellingaf.append_post(text, bytea, text, text, text, jsonb, jsonb, bytea[], uuid, uuid, uuid, uuid, jsonb, text, integer, bytea, bytea, text, bytea, jsonb, text[], bytea, integer, integer, bytea[], bytea, bytea, integer, integer, bytea, text, integer)
TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- The read view
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0118_connection_keys.sql made it, with the summary and the JSON sizes of the body and
-- the data last, each blanked like the title on a withheld or hidden post.
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
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN o.connection_key ELSE NULL::bytea END AS connection_key,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.summary ELSE NULL::text END AS summary,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.body_json_bytes ELSE NULL::integer END AS body_json_bytes,
        CASE WHEN w.post_id IS NULL AND hd.post_id IS NULL THEN p.data_json_bytes ELSE NULL::integer END AS data_json_bytes
   FROM schellingaf.posts p
     LEFT JOIN schellingaf.withheld w ON w.post_id = p.post_id AND w.released_at IS NULL
     LEFT JOIN schellingaf.space_hidden hd ON hd.post_id = p.post_id
     LEFT JOIN schellingaf.post_objects o ON o.post_id = p.post_id
     LEFT JOIN schellingaf.sealed_posts x ON x.post_id = p.post_id;
