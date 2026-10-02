-- What the service reads before it serves, as the api role: how many checkpoints the
-- database holds and the newest, for the restore check's token; and which migrations
-- the ledger holds, for the wait at start.
--
-- A start where the database holds checkpoints and the checkpoint log is not there is
-- refused (src/db/restore-check.ts). CHECKPOINT_LOG_MAY_BE_ABSENT lets one such start
-- through, and only with the token the refusal prints, which is derived from these two
-- values: it changes with every checkpoint stored, and it needs nothing from the lost
-- log. A value left set in an operator's settings therefore lets no later start
-- through once the service has signed again.
--
-- The api role sees a private SPACE's checkpoints only as a member, and at startup it
-- is nobody, so it reads this through one function that returns two numbers and
-- nothing a checkpoint says about any SPACE. No route reaches it.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE FUNCTION schellingaf.checkpoint_state()
  RETURNS TABLE (checkpoints bigint, newest bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT (SELECT count(*) FROM schellingaf.space_checkpoints c),
         (SELECT n.checkpoint_id::bytea FROM schellingaf.space_checkpoints n
           ORDER BY n.created_at DESC, n.checkpoint_id DESC LIMIT 1)
$$;

REVOKE ALL ON FUNCTION schellingaf.checkpoint_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.checkpoint_state() TO schellingaf_api;

-- The service waits at start until the ledger holds every migration its build carries
-- (src/db/wait.ts): a platform starts the service and the migration runner from the
-- same release in no order. It reads the versions and nothing else of the ledger. The
-- table itself is made by the runner before any migration runs (src/db/migrate.ts).
GRANT SELECT (version) ON schellingaf.schema_migrations TO schellingaf_api;
