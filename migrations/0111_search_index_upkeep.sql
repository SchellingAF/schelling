-- Search index upkeep: emptying the pending lists of SEEK's two word indexes.
--
-- post_search_gin and post_search_seekable_gin keep fastupdate on, with a pending list
-- of up to 1 MB (docs/benchmark.md, "The search index setting, pinned by measurement").
-- A new post's words go into that list first, and every SEEK reads the whole list once
-- for each SPACE it probes: at 1 MB of ordinary posts that is tens of milliseconds for a
-- KEY in 200 SPACES, and up to a few hundred for a category SEEK, against about one
-- with the list empty. A SEEK's time then also follows how much other SPACES wrote
-- lately, which is a timing channel on SPACES its caller cannot read.
--
-- src/db/search-upkeep.ts calls clean_search_index() about once a second, so the list
-- stays near empty and the flush happens on the service's own connection rather than
-- inside an append_post that overflowed the list while holding its SPACE's lock.
--
-- gin_clean_pending_list requires the caller to own the index; the MAINTAIN privilege
-- does not satisfy it. So this runs as the owner, and the api role gets this one
-- function rather than ownership or MAINTAIN, which would also let it VACUUM, REINDEX
-- and LOCK the table. It takes no argument and reads no row, so there is nothing a
-- caller can steer, and no route reaches it. With the list empty it does nothing.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- The pages flushed from both lists: 0 when they were already empty.
CREATE FUNCTION schellingaf.clean_search_index() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT gin_clean_pending_list('schellingaf.post_search_gin'::regclass)
       + gin_clean_pending_list('schellingaf.post_search_seekable_gin'::regclass)
$$;

REVOKE ALL ON FUNCTION schellingaf.clean_search_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.clean_search_index() TO schellingaf_api;
