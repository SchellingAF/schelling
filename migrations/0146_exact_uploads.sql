-- Exact uploads: one rule for which bytes a KEY may attach, and one-use upload
-- authorizations for a client with a shell and no token of its own.
--
-- file_attachable() is the rule: bytes held and not erased, and either the caller's own
-- upload within the pending window or a POST of the SPACE attaching them that is neither
-- hidden nor withheld. attach_files() and grant_file_uploads() both read it, so "held"
-- and "attaches" never disagree. Rank, blocks and sealing are checked by their callers
-- first, as before.
--
-- An upload authorization ("grant") lets its holder upload one file, named by its sha256,
-- to one SPACE, once, as the KEY whose token asked for it, within 15 minutes and while
-- that token lives. Node makes the secret and passes only its hash; the secret is never
-- kept. A grant is never a token: it reads nothing, posts nothing, and only the file PUT
-- takes it (src/http/files.ts, src/http/auth.ts).

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- The rule
-- ─────────────────────────────────────────────────────────────────────────────

-- Whether p_peer may attach p_sha256 in p_space: bytes held and not erased, and either
-- its own upload within the window or a POST of the SPACE attaching them that is neither
-- hidden nor withheld. Rank, blocks and sealing are checked by the callers first.
CREATE FUNCTION schellingaf.file_attachable(p_space uuid, p_peer bytea, p_sha256 bytea,
                                            p_pending_hours integer) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM space_files f
                  WHERE f.space_id = p_space AND f.sha256 = p_sha256 AND f.content IS NOT NULL)
     AND (EXISTS (SELECT 1 FROM file_uploads u
                   WHERE u.space_id = p_space AND u.sha256 = p_sha256 AND u.uploader_id = p_peer
                     AND u.uploaded_at > now() - make_interval(hours => p_pending_hours))
          OR file_shown(p_space, p_sha256, NULL))
$$;

-- attach_files() as 0121 wrote it, with its two "missing" probes made one: each hash, in
-- the author's order, must be one file_attachable() allows.
CREATE OR REPLACE FUNCTION schellingaf.attach_files(
  p_post uuid, p_author bytea, p_attachments jsonb, p_replayed boolean,
  p_pending_hours integer, p_space_bytes bigint)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_space uuid; s spaces%ROWTYPE; v_rank int; v_given jsonb; v_stored jsonb;
  v_hashes bytea[]; v_missing bytea; v_new bigint; v_total bigint;
BEGIN
  SELECT p.space_id INTO v_space FROM posts p WHERE p.post_id = p_post AND p.author_id = p_author;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTERNAL'; END IF;

  -- The list as given, and as stored, in the same shape and order.
  SELECT coalesce(jsonb_agg(jsonb_build_object('sha256', x.e->>'sha256', 'name', x.e->>'name',
                                               'media_type', x.e->>'media_type') ORDER BY x.o), '[]'::jsonb)
    INTO v_given
    FROM jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) WITH ORDINALITY AS x(e, o);

  IF p_replayed THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('sha256', encode(a.sha256, 'hex'), 'name', a.name,
                                                 'media_type', a.media_type) ORDER BY a.ord), '[]'::jsonb)
      INTO v_stored
      FROM post_attachments a WHERE a.post_id = p_post;
    IF v_stored IS DISTINCT FROM v_given THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('sha256', encode(a.sha256, 'hex'), 'name', a.name,
                                                         'media_type', a.media_type, 'bytes', a.bytes)
                                      ORDER BY a.ord), '[]'::jsonb)
              FROM post_attachments a WHERE a.post_id = p_post);
  END IF;
  IF jsonb_array_length(v_given) = 0 THEN RETURN '[]'::jsonb; END IF;

  -- The rank that may attach, again: the owner, or an admin, a coordinator or a writer.
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_author AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  SELECT * INTO s FROM spaces sp WHERE sp.space_id = v_space;
  IF EXISTS (SELECT 1 FROM withheld_spaces w WHERE w.space_id = v_space AND w.released_at IS NULL) THEN
    RAISE EXCEPTION 'SPACE_CLOSED';
  END IF;
  v_rank := CASE WHEN s.owner_id = p_author THEN 40
                 ELSE coalesce((SELECT role_rank(m.role) FROM memberships m
                                WHERE m.space_id = s.space_id AND m.peer_id = p_author), 0) END;
  IF v_rank < 20 THEN
    RAISE EXCEPTION 'WRITE_DENIED' USING DETAIL = jsonb_build_object(
      'owner', encode(s.owner_id, 'hex'), 'join_policy', s.join_policy,
      'role', CASE v_rank WHEN 10 THEN 'reader' ELSE NULL END)::text;
  END IF;
  IF s.visibility = 'sealed' THEN RAISE EXCEPTION 'SEALED_NO_FILES'; END IF;

  -- Each hash a sha256.file fingerprint of the post: the floor under the route's own check.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_given) x(e)
              WHERE NOT EXISTS (SELECT 1 FROM post_fingerprints f
                                 WHERE f.post_id = p_post AND f.scheme = 'sha256.file'
                                   AND f.value = x.e->>'sha256')) THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'each sha256 in attachments is a sha256.file fingerprint of the post';
  END IF;

  v_hashes := ARRAY(SELECT decode(x.e->>'sha256', 'hex') FROM jsonb_array_elements(v_given) x(e));

  -- The files, locked in key order.
  PERFORM 1 FROM space_files f
   WHERE f.space_id = v_space AND f.sha256 = ANY (v_hashes)
   ORDER BY f.sha256 FOR NO KEY UPDATE;

  -- Each one the author may attach, in the author's order: its own upload here within the
  -- window, or a file a shown POST of this SPACE attaches; never erased bytes. Every case
  -- it refuses answers the same, with the hash alone.
  SELECT k.h INTO v_missing FROM unnest(v_hashes) WITH ORDINALITY AS k(h, o)
   WHERE NOT file_attachable(v_space, p_author, k.h, p_pending_hours)
   ORDER BY k.o LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'ATTACHMENT_NOT_FOUND' USING DETAIL = encode(v_missing, 'hex'); END IF;

  -- The bytes of the files no shown post of the SPACE attaches yet, counted once a file: a
  -- file whose every post is hidden or withheld gave its bytes back, and counts again.
  SELECT coalesce(sum(f.bytes), 0) INTO v_new FROM space_files f
   WHERE f.space_id = v_space AND f.sha256 = ANY (v_hashes)
     AND NOT file_shown(f.space_id, f.sha256, p_post);
  IF v_new > 0 THEN
    INSERT INTO space_file_totals AS t (space_id, attached_bytes) VALUES (v_space, v_new)
    ON CONFLICT (space_id) DO UPDATE SET attached_bytes = t.attached_bytes + excluded.attached_bytes
    RETURNING t.attached_bytes INTO v_total;
    IF v_total > p_space_bytes THEN RAISE EXCEPTION 'FILE_LIMIT'; END IF;
  END IF;
  UPDATE space_files f SET attached = true
   WHERE f.space_id = v_space AND f.sha256 = ANY (v_hashes) AND NOT f.attached;

  -- Each file's size by its key, one probe an attachment: as a join, a generic plan can
  -- read every file of the SPACE to find four.
  INSERT INTO post_attachments (post_id, ord, space_id, sha256, name, media_type, bytes)
  SELECT p_post, x.o, v_space, decode(x.e->>'sha256', 'hex'), x.e->>'name', x.e->>'media_type',
         (SELECT f.bytes FROM space_files f
           WHERE f.space_id = v_space AND f.sha256 = decode(x.e->>'sha256', 'hex'))
    FROM jsonb_array_elements(v_given) WITH ORDINALITY AS x(e, o);

  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('sha256', encode(a.sha256, 'hex'), 'name', a.name,
                                                       'media_type', a.media_type, 'bytes', a.bytes)
                                    ORDER BY a.ord), '[]'::jsonb)
            FROM post_attachments a WHERE a.post_id = p_post);
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Upload authorizations
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.file_upload_grants (
  -- The sha256 of the secret; the secret is never kept.
  grant_hash schellingaf.bytes32 PRIMARY KEY,
  -- The token that asked for it: the grant dies with it.
  token_hash schellingaf.bytes32 NOT NULL REFERENCES schellingaf.tokens ON DELETE CASCADE,
  peer_id    schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  space_id   uuid NOT NULL REFERENCES schellingaf.spaces,
  sha256     schellingaf.bytes32 NOT NULL,
  expires_at timestamptz NOT NULL,
  -- When it was spent: by an upload it carried, or by a body whose hash was not its sha256.
  used_at    timestamptz,
  -- Whether that spend was an upload put_file() answered.
  uploaded   boolean NOT NULL DEFAULT false,
  CONSTRAINT file_upload_grants_uploaded_is_used CHECK (NOT uploaded OR used_at IS NOT NULL)
);
CREATE INDEX file_upload_grants_token_idx ON schellingaf.file_upload_grants (token_hash);
CREATE INDEX file_upload_grants_expiry_idx ON schellingaf.file_upload_grants (expires_at);
-- A KEY's grants for one file of one SPACE: what grant_file_uploads() asks of an upload it
-- carried before.
CREATE INDEX file_upload_grants_file_idx ON schellingaf.file_upload_grants (space_id, sha256, peer_id);

-- The definer functions' alone, as file_uploads.
ALTER TABLE schellingaf.file_upload_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_upload_grants_none ON schellingaf.file_upload_grants FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.file_upload_grants FROM schellingaf_api;

-- Grants for a token's KEY to upload each named file to a SPACE, one row a file it may not
-- attach yet. The token must be the KEY's own, not revoked and not expired. Each lasts
-- p_minutes, never past its token. p_grants holds the hashes of the secrets Node made, in
-- the order of p_hashes; nothing else of them reaches the database. A file the KEY may
-- attach is answered held, with none; one it uploaded here with a grant within the window
-- and still may not attach (bytes the operator erased) is answered uploaded, with none, so
-- a client asks no more for it and the POST answers ATTACHMENT_NOT_FOUND. The write
-- allowance is the route's to spend, in the same transaction, when one was made.
CREATE FUNCTION schellingaf.grant_file_uploads(
  p_space_name text, p_peer bytea, p_token bytea, p_hashes bytea[], p_grants bytea[],
  p_minutes integer, p_pending_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_space uuid; v_token_expires timestamptz; v_expires timestamptz; v_out jsonb[] := '{}';
  v_made integer := 0;
BEGIN
  SELECT t.expires_at INTO v_token_expires FROM tokens t
   WHERE t.token_hash = p_token AND t.peer_id = p_peer AND t.revoked_at IS NULL AND t.expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'TOKEN_INVALID'; END IF;
  -- Blocks, the SPACE's state, the rank and sealing, as an upload meets them.
  v_space := check_file_upload(p_space_name, p_peer);
  v_expires := least(now() + make_interval(mins => p_minutes), v_token_expires);
  FOR i IN 1 .. coalesce(array_length(p_hashes, 1), 0) LOOP
    IF file_attachable(v_space, p_peer, p_hashes[i], p_pending_hours) THEN
      v_out := v_out || jsonb_build_object('sha256', encode(p_hashes[i], 'hex'), 'held', true);
    ELSIF EXISTS (SELECT 1 FROM file_upload_grants g
                   WHERE g.space_id = v_space AND g.sha256 = p_hashes[i] AND g.peer_id = p_peer
                     AND g.uploaded AND g.used_at > now() - make_interval(hours => p_pending_hours)) THEN
      v_out := v_out || jsonb_build_object('sha256', encode(p_hashes[i], 'hex'), 'held', false, 'uploaded', true);
    ELSE
      INSERT INTO file_upload_grants (grant_hash, token_hash, peer_id, space_id, sha256, expires_at)
      VALUES (p_grants[i], p_token, p_peer, v_space, p_hashes[i], v_expires);
      v_made := v_made + 1;
      v_out := v_out || jsonb_build_object('sha256', encode(p_hashes[i], 'hex'), 'held', false, 'grant', i);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('made', v_made, 'expires_at', CASE WHEN v_made > 0 THEN v_expires END,
                            'uploads', to_jsonb(v_out));
END $$;

-- A grant as the file PUT's bearer: by its hash, one probe by the primary key. valid while
-- unused, unexpired and its token neither revoked nor expired; dead otherwise; no row for
-- a hash no grant has. Its KEY's block and registration come with it, and its SPACE's
-- name, which the file PUT compares with the address before it reads anything of that SPACE.
CREATE FUNCTION schellingaf.upload_grant(p_grant bytea)
  RETURNS TABLE (state text, peer_id bytea, blocked_at timestamptz, registered_at timestamptz,
                 space_id uuid, sha256 bytea, space_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE WHEN g.used_at IS NULL AND g.expires_at > now()
                   AND t.revoked_at IS NULL AND t.expires_at > now()
              THEN 'valid' ELSE 'dead' END,
         g.peer_id::bytea, p.blocked_at, p.registered_at, g.space_id, g.sha256::bytea, sp.name
    FROM file_upload_grants g
    JOIN tokens t ON t.token_hash = g.token_hash
    JOIN peers p ON p.peer_id = g.peer_id
    JOIN spaces sp ON sp.space_id = g.space_id
   WHERE g.grant_hash = p_grant
$$;

-- An upload under a grant: the grant taken FOR UPDATE, so a second upload at once waits
-- and finds it used; checked again, with its token; then put_file() as a token's upload
-- is, as the grant's KEY, and the grant spent in the same transaction. A refusal of
-- put_file() rolls back and leaves the grant unspent.
CREATE FUNCTION schellingaf.put_file_granted(
  p_grant bytea, p_space_name text, p_sha256 bytea, p_content bytea, p_is_text boolean,
  p_bytes_per_day double precision, p_pending_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  g file_upload_grants%ROWTYPE; v_live boolean; v_put jsonb;
BEGIN
  SELECT * INTO g FROM file_upload_grants x WHERE x.grant_hash = p_grant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOKEN_INVALID'; END IF;
  SELECT g.used_at IS NULL AND g.expires_at > now() AND t.revoked_at IS NULL AND t.expires_at > now()
         AND t.peer_id = g.peer_id
    INTO v_live
    FROM tokens t WHERE t.token_hash = g.token_hash;
  IF NOT coalesce(v_live, false) THEN RAISE EXCEPTION 'UPLOAD_EXPIRED'; END IF;
  IF g.sha256 <> p_sha256
     OR NOT EXISTS (SELECT 1 FROM spaces sp WHERE sp.name = p_space_name AND sp.space_id = g.space_id) THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  -- check_file_upload() first in put_file(): KEY_BLOCKED, SPACE_CLOSED, WRITE_BLOCKED,
  -- WRITE_DENIED, SEALED_NO_FILES, as for a token.
  v_put := put_file(p_space_name, g.peer_id, p_sha256, p_content, p_is_text, p_bytes_per_day, p_pending_hours);
  UPDATE file_upload_grants x SET used_at = now(), uploaded = true WHERE x.grant_hash = p_grant;
  RETURN v_put;
END $$;

-- A grant whose body did not hash to its sha256 is spent: a leaked grant is worth one try.
CREATE FUNCTION schellingaf.spend_upload_grant(p_grant bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  UPDATE file_upload_grants g SET used_at = now() WHERE g.grant_hash = p_grant AND g.used_at IS NULL
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The prune's fifth step, grants first
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0121 wrote it, after removing grants past their expiry by the pending window: a
-- spent grant is kept that long, so grant_file_uploads() can tell an upload it carried.
CREATE OR REPLACE FUNCTION schellingaf.prune_files(p_pending_hours integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_spaces uuid[]; v_hashes bytea[]; n integer;
BEGIN
  DELETE FROM file_upload_grants g WHERE g.expires_at < now() - make_interval(hours => p_pending_hours);
  DELETE FROM file_uploads u WHERE u.uploaded_at < now() - make_interval(hours => p_pending_hours);
  SELECT coalesce(array_agg(c.space_id ORDER BY c.space_id, c.sha256), '{}'),
         coalesce(array_agg(c.sha256::bytea ORDER BY c.space_id, c.sha256), '{}')
    INTO v_spaces, v_hashes
    FROM (SELECT f.space_id, f.sha256 FROM space_files f
           WHERE NOT f.attached
             AND NOT EXISTS (SELECT 1 FROM file_uploads u WHERE u.space_id = f.space_id AND u.sha256 = f.sha256)
           ORDER BY f.space_id, f.sha256
           LIMIT 10000
           FOR UPDATE SKIP LOCKED) c;
  DELETE FROM space_files f
   USING unnest(v_spaces, v_hashes) AS k(space_id, sha256)
   WHERE f.space_id = k.space_id AND f.sha256 = k.sha256
     AND NOT f.attached
     AND NOT EXISTS (SELECT 1 FROM file_uploads u WHERE u.space_id = f.space_id AND u.sha256 = f.sha256);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.file_attachable(uuid, bytea, bytea, integer),
  schellingaf.grant_file_uploads(text, bytea, bytea, bytea[], bytea[], integer, integer),
  schellingaf.upload_grant(bytea),
  schellingaf.put_file_granted(bytea, text, bytea, bytea, boolean, double precision, integer),
  schellingaf.spend_upload_grant(bytea)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schellingaf.grant_file_uploads(text, bytea, bytea, bytea[], bytea[], integer, integer),
  schellingaf.upload_grant(bytea),
  schellingaf.put_file_granted(bytea, text, bytea, bytea, boolean, double precision, integer),
  schellingaf.spend_upload_grant(bytea)
TO schellingaf_api;
