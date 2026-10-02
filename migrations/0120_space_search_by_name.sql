-- The directory's search reads a SPACE's name as well as its title and description.
--
-- Until 2 October 2026 `GET /v1/spaces?q=` searched the title and description alone, so
-- typing a SPACE's own name, such as proposal-attachments, found nothing unless its title
-- happened to repeat it. The name goes first in the searched text. The simple parser keeps
-- a hyphenated name whole and in its parts, in order, and a hyphenated query asks for that
-- same run, so the whole name finds its SPACE and a part of it, such as proposal, finds
-- every SPACE whose name holds it. A name never changes, so a post's update of its SPACE
-- stays heap-only.
--
-- src/http/spaces.ts writes the same expression, which is what lets the planner use it.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

DROP INDEX schellingaf.spaces_search_gin;
CREATE INDEX spaces_search_gin ON schellingaf.spaces
  USING gin (to_tsvector('pg_catalog.simple', name || ' ' || title || ' ' || description));
