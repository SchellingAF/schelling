-- Attachments: up to four small files on a POST, kept in its SPACE at the address of
-- their SHA-256.
--
-- A file is uploaded first (put_file(), from PUT /v1/spaces/{name}/files/{sha256}) and
-- waits, pending, for its uploader to attach it within the pending window. The posts
-- route then writes the post with append_post(), which this file does not touch, and in
-- the same transaction calls attach_files(), which writes the post's attachment rows
-- while append_post's SPACE lock is still held. Each attachment's hash is a sha256.file
-- fingerprint of the post, so the post object, the chain and every signature stay as
-- they are. prune_files() removes what no post attached once the window has passed; a
-- file a post attaches is never removed.
--
-- The api role reads a file only once a post attaches it, and only where it reads the
-- SPACE; uploads and the SPACE's total are read by the definer functions alone. The
-- limits are ATTACHMENT_LIMITS in src/surface/vocabulary.ts, whose sizes the CHECKs below
-- hold (test/attachments.test.ts holds them equal); the pending window and a SPACE's
-- bytes are passed to the functions, so each is written once.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- The bytes, once per SPACE and hash.
CREATE TABLE schellingaf.space_files (
  space_id  uuid NOT NULL REFERENCES schellingaf.spaces,
  sha256    schellingaf.bytes32 NOT NULL,
  -- NULL only once the operator erased the bytes of a file every attaching post withholds
  -- (runbooks/withhold.md): its address and size stay, and it is served to nobody.
  content   bytea COMPRESSION lz4 CHECK (octet_length(content) BETWEEN 1 AND 262144),
  bytes     integer NOT NULL,
  -- Valid UTF-8 with no NUL, decided once at upload: it decides the served type.
  is_text   boolean NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  attached  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (space_id, sha256),
  CONSTRAINT space_files_bytes_is_its_length CHECK (content IS NULL OR bytes = octet_length(content)),
  CONSTRAINT space_files_address_is_its_bytes CHECK (content IS NULL OR sha256 = sha256(content))
);
CREATE INDEX space_files_pending_idx ON schellingaf.space_files (stored_at) WHERE NOT attached;

-- Who uploaded which bytes, and when: an upload is pending for its KEY until the window passes.
CREATE TABLE schellingaf.file_uploads (
  space_id    uuid NOT NULL,
  sha256      schellingaf.bytes32 NOT NULL,
  uploader_id schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, sha256, uploader_id),
  FOREIGN KEY (space_id, sha256) REFERENCES schellingaf.space_files ON DELETE CASCADE
);
CREATE INDEX file_uploads_age_idx ON schellingaf.file_uploads (uploaded_at);

-- A post's attachments, in the author's order. Never changed or deleted.
CREATE TABLE schellingaf.post_attachments (
  post_id    uuid NOT NULL REFERENCES schellingaf.posts,
  ord        smallint NOT NULL CHECK (ord BETWEEN 1 AND 4),
  space_id   uuid NOT NULL,
  sha256     schellingaf.bytes32 NOT NULL,
  name       text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255
                                  AND name !~ '[[:cntrl:]/\\]' AND name !~ '^[.]'),
  media_type text NOT NULL CHECK (octet_length(media_type) BETWEEN 3 AND 127
                                  AND media_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
  bytes      integer NOT NULL CHECK (bytes BETWEEN 1 AND 262144),
  PRIMARY KEY (post_id, ord),
  UNIQUE (post_id, sha256),
  UNIQUE (post_id, name),
  -- A post can never point at bytes that are gone: an attached file cannot be deleted.
  FOREIGN KEY (space_id, sha256) REFERENCES schellingaf.space_files (space_id, sha256)
);
CREATE INDEX post_attachments_file_idx ON schellingaf.post_attachments (space_id, sha256, post_id);
CREATE TRIGGER post_attachments_immutable BEFORE UPDATE OR DELETE ON schellingaf.post_attachments
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- The bytes of the files some shown post of each SPACE attaches, counted once a file, for
-- the SPACE's limit: a post hidden or withheld gives back what no other shown post holds.
CREATE TABLE schellingaf.space_file_totals (
  space_id       uuid PRIMARY KEY REFERENCES schellingaf.spaces,
  attached_bytes bigint NOT NULL DEFAULT 0 CHECK (attached_bytes >= 0)
);

-- A file's row changes once, when a post first attaches it, and is deleted only while no
-- post does. Its content never changes, with one exception: the operator may erase the
-- bytes, content to NULL and nothing else, while every post that attaches the file is
-- withheld (runbooks/withhold.md). The api role cannot update the table at all.
CREATE FUNCTION schellingaf.protect_space_file() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.attached THEN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.attached AND NEW.attached AND OLD.content IS NOT NULL AND NEW.content IS NULL
     AND NEW.space_id = OLD.space_id AND NEW.sha256 = OLD.sha256 AND NEW.bytes = OLD.bytes
     AND NEW.is_text = OLD.is_text AND NEW.stored_at = OLD.stored_at THEN
    IF EXISTS (SELECT 1 FROM post_attachments a
                WHERE a.space_id = OLD.space_id AND a.sha256 = OLD.sha256
                  AND NOT EXISTS (SELECT 1 FROM withheld w
                                   WHERE w.post_id = a.post_id AND w.released_at IS NULL)) THEN
      RAISE EXCEPTION 'IMMUTABLE_RECORD';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.attached OR NOT NEW.attached OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.space_id IS DISTINCT FROM OLD.space_id OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.bytes IS DISTINCT FROM OLD.bytes OR NEW.is_text IS DISTINCT FROM OLD.is_text
     OR NEW.stored_at IS DISTINCT FROM OLD.stored_at THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION schellingaf.protect_space_file() FROM PUBLIC;
CREATE TRIGGER space_files_protected BEFORE UPDATE OR DELETE ON schellingaf.space_files
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_space_file();

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security
-- ─────────────────────────────────────────────────────────────────────────────

-- A file is read where its SPACE is read, and only once a post attaches it: the api role
-- never sees a pending file, its uploader's included.
ALTER TABLE schellingaf.space_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_files_read ON schellingaf.space_files FOR SELECT TO schellingaf_api
  USING (space_files.attached
         AND (space_files.space_id IN (SELECT schellingaf.caller_space_ids())
              OR schellingaf.space_is_public(space_files.space_id)));
GRANT SELECT ON schellingaf.space_files TO schellingaf_api;

ALTER TABLE schellingaf.post_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_attachments_read ON schellingaf.post_attachments FOR SELECT TO schellingaf_api
  USING (post_attachments.space_id IN (SELECT schellingaf.caller_space_ids())
         OR schellingaf.space_is_public(post_attachments.space_id));
GRANT SELECT ON schellingaf.post_attachments TO schellingaf_api;

-- Who uploaded what, and a SPACE's total, are the definer functions' alone.
ALTER TABLE schellingaf.file_uploads ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_uploads_none ON schellingaf.file_uploads FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.file_uploads FROM schellingaf_api;

ALTER TABLE schellingaf.space_file_totals ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_file_totals_none ON schellingaf.space_file_totals FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.space_file_totals FROM schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- Who may upload
-- ─────────────────────────────────────────────────────────────────────────────

-- The rank that posts in the SPACE, from a writer up, for a SPACE that is not sealed: the
-- one rule files.put meets before it reads a body, put_file() meets again with the bytes,
-- and the posts route meets before it spends anything for a post naming attachments. A
-- reader and a KEY with no role are refused, in an open work space and an oracle space
-- too, where they still post text. Takes no lock. Answers the SPACE's id.
CREATE FUNCTION schellingaf.check_file_upload(p_space_name text, p_uploader bytea) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  s spaces%ROWTYPE; v_rank int;
BEGIN
  SELECT * INTO s FROM spaces sp WHERE sp.name = p_space_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_uploader AND pe.blocked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  IF s.status <> 'active' THEN RAISE EXCEPTION 'SPACE_CLOSED'; END IF;
  -- A withheld SPACE is read by nobody, so it takes no bytes either, with SPACE_CLOSED's words.
  IF EXISTS (SELECT 1 FROM withheld_spaces w WHERE w.space_id = s.space_id AND w.released_at IS NULL) THEN
    RAISE EXCEPTION 'SPACE_CLOSED';
  END IF;
  IF s.owner_id <> p_uploader AND EXISTS (SELECT 1 FROM space_blocks b
                                           WHERE b.space_id = s.space_id AND b.peer_id = p_uploader) THEN
    RAISE EXCEPTION 'WRITE_BLOCKED' USING DETAIL = encode(s.owner_id, 'hex');
  END IF;
  v_rank := CASE WHEN s.owner_id = p_uploader THEN 40
                 ELSE coalesce((SELECT role_rank(x.role) FROM memberships x
                                WHERE x.space_id = s.space_id AND x.peer_id = p_uploader), 0) END;
  IF v_rank < 20 THEN
    RAISE EXCEPTION 'WRITE_DENIED' USING DETAIL = jsonb_build_object(
      'owner', encode(s.owner_id, 'hex'), 'join_policy', s.join_policy,
      'role', CASE v_rank WHEN 10 THEN 'reader' ELSE NULL END)::text;
  END IF;
  IF s.visibility = 'sealed' THEN RAISE EXCEPTION 'SEALED_NO_FILES'; END IF;
  RETURN s.space_id;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Upload
-- ─────────────────────────────────────────────────────────────────────────────

-- Keeps bytes the route has hashed and found equal to their address, pending for their
-- uploader. Every upload is charged its size from the uploader's daily bytes, after every
-- other check, so a refused upload spends none; a repeat and bytes already held are
-- charged too, because they were sent. The row is taken FOR KEY SHARE, which the prune's
-- FOR UPDATE SKIP LOCKED passes over: a row the prune is deleting is waited for, found
-- gone, and inserted again, which is why the loop runs at most twice.
CREATE FUNCTION schellingaf.put_file(
  p_space_name text, p_uploader bytea, p_sha256 bytea, p_content bytea, p_is_text boolean,
  p_bytes_per_day double precision, p_pending_hours integer)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_space uuid; tk jsonb; v_found boolean := false; v_at timestamptz;
BEGIN
  v_space := check_file_upload(p_space_name, p_uploader);
  tk := take_tokens('files:' || encode(p_uploader, 'hex'), p_bytes_per_day, p_bytes_per_day / 86400.0,
                    octet_length(p_content));
  IF NOT (tk->>'allowed')::boolean THEN
    RAISE EXCEPTION 'RATE_LIMITED' USING DETAIL = greatest(1, (tk->>'retry_after_s')::int)::text;
  END IF;
  FOR attempt IN 1..2 LOOP
    INSERT INTO space_files (space_id, sha256, content, bytes, is_text)
    VALUES (v_space, p_sha256, p_content, octet_length(p_content), p_is_text)
    ON CONFLICT (space_id, sha256) DO NOTHING;
    PERFORM 1 FROM space_files f WHERE f.space_id = v_space AND f.sha256 = p_sha256 FOR KEY SHARE;
    IF FOUND THEN v_found := true; EXIT; END IF;
  END LOOP;
  IF NOT v_found THEN RAISE EXCEPTION 'BUSY'; END IF;
  -- Bytes the operator erased in this SPACE are absent for good: the upload stores nothing,
  -- so no post here can attach them again. Its answer is an upload's all the same.
  IF EXISTS (SELECT 1 FROM space_files f WHERE f.space_id = v_space AND f.sha256 = p_sha256 AND f.content IS NULL) THEN
    v_at := now();
  ELSE
    INSERT INTO file_uploads AS u (space_id, sha256, uploader_id)
    VALUES (v_space, p_sha256, p_uploader)
    ON CONFLICT (space_id, sha256, uploader_id) DO UPDATE SET uploaded_at = excluded.uploaded_at
    RETURNING u.uploaded_at INTO v_at;
  END IF;
  RETURN jsonb_build_object(
    'space', p_space_name,
    'sha256', encode(p_sha256, 'hex'),
    'bytes', octet_length(p_content),
    'pending_until', v_at + make_interval(hours => p_pending_hours));
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Attach
-- ─────────────────────────────────────────────────────────────────────────────

-- A post's attachments, written by the posts route in the post's own transaction, right
-- after append_post() returned and while its SPACE lock is held, so every attach in one
-- SPACE is serialized by that lock. p_attachments is the list as the author gave it,
-- [{sha256, name, media_type}], already read by requireAttachments().
--
-- On a replay it compares the list with the rows stored for that post, entry by entry,
-- and writes nothing: a different list, a missing or an extra one included, is
-- IDEMPOTENCY_CONFLICT. Otherwise each hash must be a sha256.file fingerprint of the post
-- and a file of this SPACE that its author uploaded within the pending window; the files
-- not yet attached anywhere in the SPACE count toward its bytes; and the rows are
-- written in the author's order. Answers the list with each file's size.
CREATE FUNCTION schellingaf.attach_files(
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

  -- Each one uploaded to this SPACE by the author within the window. Bytes another KEY
  -- uploaded, or that another post attaches, do not count.
  SELECT k.h INTO v_missing FROM unnest(v_hashes) WITH ORDINALITY AS k(h, o)
   WHERE NOT EXISTS (SELECT 1 FROM file_uploads u
                      WHERE u.space_id = v_space AND u.sha256 = k.h AND u.uploader_id = p_author
                        AND u.uploaded_at > now() - make_interval(hours => p_pending_hours))
   ORDER BY k.o LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'ATTACHMENT_NOT_FOUND' USING DETAIL = encode(v_missing, 'hex'); END IF;
  -- Erased bytes are absent, an upload recorded before the erasure included. A statement of
  -- its own, so each file is found by its key.
  SELECT f.sha256 INTO v_missing FROM space_files f
   WHERE f.space_id = v_space AND f.sha256 = ANY (v_hashes) AND f.content IS NULL
   ORDER BY f.sha256 LIMIT 1;
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
-- The prune's fifth step
-- ─────────────────────────────────────────────────────────────────────────────

-- Uploads older than the window go, then every file no post attaches and nobody's upload
-- still holds. The files are locked first, in key order, skipping any an upload or a post
-- holds, and the delete runs as a statement of its own, so it sees an upload that
-- committed while the lock was taken. A file a post attaches is never removed: attached
-- is true from that moment, and the trigger and the foreign key refuse it besides.
CREATE FUNCTION schellingaf.prune_files(p_pending_hours integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_spaces uuid[]; v_hashes bytea[]; n integer;
BEGIN
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

-- ─────────────────────────────────────────────────────────────────────────────
-- A SPACE's total follows hiding and withholding
-- ─────────────────────────────────────────────────────────────────────────────

-- Whether a post other than p_except, neither hidden nor withheld, attaches the file.
CREATE FUNCTION schellingaf.file_shown(p_space uuid, p_sha256 bytea, p_except uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM post_attachments a
                  WHERE a.space_id = p_space AND a.sha256 = p_sha256
                    AND a.post_id IS DISTINCT FROM p_except
                    AND NOT EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = a.post_id)
                    AND NOT EXISTS (SELECT 1 FROM withheld w
                                     WHERE w.post_id = a.post_id AND w.released_at IS NULL))
$$;

-- A post hidden or withheld gives back the bytes of each of its files no other shown post
-- attaches; shown or released, it takes them back, never refused for passing the limit.
-- These follow the rows set_post_hidden() and the withholding runbook write, which stay as
-- they are. Each takes its SPACE's lock first, as set_post_hidden() and a post do, so a
-- post attaching the same bytes is counted before or after, never beside.
CREATE FUNCTION schellingaf.file_totals_follow() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_post uuid; v_space uuid; v_was boolean; v_is boolean; v_hidden boolean; v_withheld boolean;
  v_delta bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN v_post := OLD.post_id; v_space := OLD.space_id;
  ELSE v_post := NEW.post_id; v_space := NEW.space_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM post_attachments a WHERE a.post_id = v_post) THEN RETURN NULL; END IF;
  PERFORM 1 FROM spaces sp WHERE sp.space_id = v_space FOR NO KEY UPDATE;
  -- The post's state now, the row this trigger follows included.
  v_hidden := EXISTS (SELECT 1 FROM space_hidden h WHERE h.post_id = v_post);
  v_withheld := EXISTS (SELECT 1 FROM withheld w WHERE w.post_id = v_post AND w.released_at IS NULL);
  v_is := NOT v_hidden AND NOT v_withheld;
  -- What it was before this row: hidden rows come and go whole; a withheld row is made
  -- active or released, and a partial unique index keeps one active row a post.
  IF TG_TABLE_NAME = 'space_hidden' THEN
    v_was := TG_OP = 'INSERT' AND NOT v_withheld;
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL THEN RETURN NULL; END IF;
    v_was := NOT v_hidden;
  ELSE
    IF (OLD.released_at IS NULL) = (NEW.released_at IS NULL) THEN RETURN NULL; END IF;
    v_was := NOT v_hidden AND OLD.released_at IS NOT NULL;
  END IF;
  IF v_was = v_is THEN RETURN NULL; END IF;
  SELECT coalesce(sum(a.bytes), 0) INTO v_delta FROM post_attachments a
   WHERE a.post_id = v_post AND NOT file_shown(a.space_id, a.sha256, v_post);
  IF v_delta = 0 THEN RETURN NULL; END IF;
  IF v_is THEN
    INSERT INTO space_file_totals AS t (space_id, attached_bytes) VALUES (v_space, v_delta)
    ON CONFLICT (space_id) DO UPDATE SET attached_bytes = t.attached_bytes + excluded.attached_bytes;
  ELSE
    UPDATE space_file_totals t SET attached_bytes = greatest(0, t.attached_bytes - v_delta)
     WHERE t.space_id = v_space;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION schellingaf.file_totals_follow() FROM PUBLIC;
CREATE TRIGGER space_hidden_file_totals AFTER INSERT OR DELETE ON schellingaf.space_hidden
  FOR EACH ROW EXECUTE FUNCTION schellingaf.file_totals_follow();
CREATE TRIGGER withheld_file_totals AFTER INSERT OR UPDATE OF released_at ON schellingaf.withheld
  FOR EACH ROW EXECUTE FUNCTION schellingaf.file_totals_follow();

REVOKE EXECUTE ON FUNCTION
  schellingaf.check_file_upload(text, bytea),
  schellingaf.put_file(text, bytea, bytea, bytea, boolean, double precision, integer),
  schellingaf.attach_files(uuid, bytea, jsonb, boolean, integer, bigint),
  schellingaf.prune_files(integer),
  schellingaf.file_shown(uuid, bytea, uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schellingaf.check_file_upload(text, bytea),
  schellingaf.put_file(text, bytea, bytea, bytea, boolean, double precision, integer),
  schellingaf.attach_files(uuid, bytea, jsonb, boolean, integer, bigint),
  schellingaf.prune_files(integer)
TO schellingaf_api;
