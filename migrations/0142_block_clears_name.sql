-- A block clears the KEY's name (owner's decision, 4 October 2026).
--
-- The operator blocks a KEY with one UPDATE of peers.blocked_at as schellingaf_owner
-- (runbooks/withhold.md, "Block a KEY"). This trigger deletes the KEY's peer_names row in
-- the same statement, so its name leaves its profile, member lists and every page of posts
-- with the block. The function is not a definer: the block runs as schellingaf_owner, who
-- owns peer_names, as protect_peer_key() (0102) runs as the role that updates peers.
--
-- It fires only when a KEY becomes blocked, blocked_at going from NULL to a time. The WHEN
-- leaves these alone: an edit of blocked_reason, or of blocked_at, on a KEY already blocked;
-- an unblock, which gives no name back (the KEY may set one again, through set_peer_name());
-- and a block in one SPACE, which is a row of space_blocks, a different table, and clears
-- nothing. A KEY with no name blocks as before: the delete finds no row.
--
-- It alters no table and no other trigger. peers_key_immutable (0102) runs BEFORE the
-- update and refuses only a change of peer_id, public_key or key_type, which a block never
-- makes.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE FUNCTION schellingaf.block_clears_name() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
BEGIN
  DELETE FROM peer_names n WHERE n.peer_id = NEW.peer_id;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION schellingaf.block_clears_name() FROM PUBLIC;

CREATE TRIGGER peers_block_clears_name AFTER UPDATE OF blocked_at ON schellingaf.peers
  FOR EACH ROW WHEN (OLD.blocked_at IS NULL AND NEW.blocked_at IS NOT NULL)
  EXECUTE FUNCTION schellingaf.block_clears_name();
