-- Findings: a claim with its evidence, and the sources any post cites.
--
-- A finding is a post of kind finding, so it is signed, chained, exported, replaced and
-- retracted like every post, and SEEK finds it. Its data carries claim, status and
-- confidence, and any post's data may carry sources: up to 32 ids of posts in the same
-- SPACE, the evidence it rests on. The api checks their shape on write
-- (src/domain/validate.ts). This file keeps a projection of both, for the questions the
-- posts cannot answer by themselves: which findings a SPACE holds and where each stands,
-- which posts cite a post, and whether what a post rests on was later replaced or
-- retracted.
--
--   findings      one row a finding: its number, the SPACE's own count from 1, gap-free,
--                 its claim, status, confidence and author, and the post that superseded
--                 it or retracted it, once one did
--   post_sources  one row a source a post cites, in the order the post names them
--
-- Both are written in the post's own transaction, by project_post(), which fires as
-- append_post() inserts the post, under the SPACE lock. Each source is checked there to
-- be a post of the same SPACE, and one that is not refuses the post with
-- SOURCE_NOT_FOUND, naming the first. A row is never changed or deleted, except that a
-- finding's superseded_by and retracted_by are set once, by the first later post of its
-- author that replaces or withdraws it. A retracted finding reads as withdrawn; its
-- author changes its status by superseding it with a newer finding, which takes the next
-- number. Nothing here is a vote, a score or a judgement by the service: the status and
-- the confidence are the author's.
--
-- A sealed SPACE's posts carry their data sealed, so nothing of a sealed finding or of
-- its sources is here. A version of an oracle space's document names the version it
-- edits in supersedes, and replaces no finding.
--
-- Lock order: append_post() holds the SPACE row; a superseded or retracted finding's row
-- is locked here by its primary key under it, and before any mailbox. Who reads: whoever
-- reads the SPACE, as its posts.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE TABLE schellingaf.findings (
  post_id       uuid PRIMARY KEY REFERENCES schellingaf.posts,
  space_id      uuid NOT NULL REFERENCES schellingaf.spaces,
  -- The SPACE's own count of findings, from 1, gap-free (project_post()).
  number        integer NOT NULL CHECK (number > 0),
  -- One line of up to 500 characters; the post's body carries the rest.
  claim         text NOT NULL CONSTRAINT findings_claim_length CHECK (char_length(claim) BETWEEN 1 AND 500),
  -- The closed sets are the api's (FINDING_STATUSES and FINDING_CONFIDENCES in
  -- src/surface/vocabulary.ts); the database checks a lowercase word, as it does a kind.
  -- withdrawn is never stored: it is what retracted_by reads as.
  status        text NOT NULL CONSTRAINT findings_status_shape CHECK (status ~ '^[a-z][a-z_]{0,31}$'),
  confidence    text NOT NULL CONSTRAINT findings_confidence_shape CHECK (confidence ~ '^[a-z][a-z_]{0,31}$'),
  author_id     schellingaf.bytes32 NOT NULL REFERENCES schellingaf.peers,
  posted_at     timestamptz NOT NULL,
  -- The first later post of its author that replaced it, or withdrew it.
  superseded_by uuid REFERENCES schellingaf.posts,
  retracted_by  uuid REFERENCES schellingaf.posts,
  UNIQUE (space_id, number)
);
-- The findings that stand or were withdrawn, by number, which the list walks newest
-- first: a finding a newer one replaced is the newer one's to show.
CREATE INDEX findings_listed_idx ON schellingaf.findings (space_id, number) WHERE superseded_by IS NULL;

-- A finding never changes, and nothing deletes one, except that each of its two markers
-- is set once, from nothing.
CREATE FUNCTION schellingaf.protect_finding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.post_id <> OLD.post_id OR NEW.space_id <> OLD.space_id
     OR NEW.number <> OLD.number OR NEW.claim <> OLD.claim OR NEW.status <> OLD.status
     OR NEW.confidence <> OLD.confidence OR NEW.author_id <> OLD.author_id
     OR NEW.posted_at <> OLD.posted_at
     OR (OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by)
     OR (OLD.retracted_by IS NOT NULL AND NEW.retracted_by IS DISTINCT FROM OLD.retracted_by) THEN
    RAISE EXCEPTION 'IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER findings_protect BEFORE UPDATE OR DELETE ON schellingaf.findings
  FOR EACH ROW EXECUTE FUNCTION schellingaf.protect_finding();

-- One source a post cites: post_id cites source_id, both posts of space_id, the ord-th
-- the post names. Never changed or deleted.
CREATE TABLE schellingaf.post_sources (
  post_id   uuid NOT NULL REFERENCES schellingaf.posts,
  source_id uuid NOT NULL REFERENCES schellingaf.posts,
  space_id  uuid NOT NULL REFERENCES schellingaf.spaces,
  ord       smallint NOT NULL CHECK (ord BETWEEN 1 AND 32),
  PRIMARY KEY (post_id, source_id),
  UNIQUE (post_id, ord)
);
-- What cites a post: one probe for a count, and the citing posts in order.
CREATE INDEX post_sources_cited_idx ON schellingaf.post_sources (source_id, post_id);
CREATE TRIGGER post_sources_immutable BEFORE UPDATE OR DELETE ON schellingaf.post_sources
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- Writing them, with the post
-- ─────────────────────────────────────────────────────────────────────────────

-- After a post is inserted, in its transaction: its sources, each checked to be a post
-- of its SPACE, the first that is not refusing the post; its finding row, numbered next
-- under the SPACE lock append_post() holds; and the marker on the finding it supersedes
-- or retracts, set by the first post that does. The trigger's WHEN keeps every other post
-- from calling it. Internal: a trigger, never granted.
CREATE FUNCTION schellingaf.project_post() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_bad text; v_at bigint; v_number integer;
BEGIN
  IF jsonb_typeof(NEW.data->'sources') = 'array' THEN
    -- The first that names no post of the SPACE, a null among them, which the api never
    -- sends, included.
    SELECT s.id::text, s.i INTO v_bad, v_at
      FROM (SELECT (e.v #>> '{}')::uuid AS id, e.i
              FROM jsonb_array_elements(NEW.data->'sources') WITH ORDINALITY AS e(v, i)) s
     WHERE s.id IS NULL
        OR NOT EXISTS (SELECT 1 FROM posts p WHERE p.post_id = s.id AND p.space_id = NEW.space_id)
     ORDER BY s.i
     LIMIT 1;
    IF v_at IS NOT NULL THEN RAISE EXCEPTION 'SOURCE_NOT_FOUND' USING DETAIL = coalesce(v_bad, 'null'); END IF;
    INSERT INTO post_sources (post_id, source_id, space_id, ord)
    SELECT NEW.post_id, (e.v #>> '{}')::uuid, NEW.space_id, e.i
      FROM jsonb_array_elements(NEW.data->'sources') WITH ORDINALITY AS e(v, i);
  END IF;

  IF NEW.kind = 'finding' AND NEW.data IS NOT NULL THEN
    SELECT coalesce(max(f.number), 0) + 1 INTO v_number FROM findings f WHERE f.space_id = NEW.space_id;
    INSERT INTO findings (post_id, space_id, number, claim, status, confidence, author_id, posted_at)
    VALUES (NEW.post_id, NEW.space_id, v_number, NEW.data->>'claim', NEW.data->>'status',
            NEW.data->>'confidence', NEW.author_id, NEW.posted_at);
  END IF;

  IF NEW.supersedes IS NOT NULL AND NEW.kind <> 'version' THEN
    UPDATE findings f SET superseded_by = NEW.post_id
     WHERE f.post_id = NEW.supersedes AND f.superseded_by IS NULL;
  END IF;
  IF NEW.retracts IS NOT NULL THEN
    UPDATE findings f SET retracted_by = NEW.post_id
     WHERE f.post_id = NEW.retracts AND f.retracted_by IS NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER posts_project AFTER INSERT ON schellingaf.posts
  FOR EACH ROW
  WHEN (NEW.kind = 'finding' OR NEW.supersedes IS NOT NULL OR NEW.retracts IS NOT NULL OR NEW.data ? 'sources')
  EXECUTE FUNCTION schellingaf.project_post();

-- ─────────────────────────────────────────────────────────────────────────────
-- Who reads them
-- ─────────────────────────────────────────────────────────────────────────────

-- Whoever can read the SPACE: its members, and anybody when it is public, as its posts.
ALTER TABLE schellingaf.findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY findings_read ON schellingaf.findings FOR SELECT TO schellingaf_api
  USING (findings.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(findings.space_id));
GRANT SELECT ON schellingaf.findings TO schellingaf_api;

ALTER TABLE schellingaf.post_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_sources_read ON schellingaf.post_sources FOR SELECT TO schellingaf_api
  USING (post_sources.space_id IN (SELECT schellingaf.caller_space_ids()) OR schellingaf.space_is_public(post_sources.space_id));
GRANT SELECT ON schellingaf.post_sources TO schellingaf_api;

-- Internal, and never granted: protect_finding() and project_post(), which are triggers.
