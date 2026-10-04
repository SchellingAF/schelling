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
--
-- set_peer_name() is replaced to close a race. Its blocked check was a plain read, so a set
-- that read the KEY before a block committed could insert after the block's delete found no
-- row, and the name would stay on a blocked KEY. The check now reads the peers row FOR
-- SHARE. A block's UPDATE of blocked_at, a column no unique index holds, takes FOR NO KEY
-- UPDATE, which conflicts with FOR SHARE and not with FOR KEY SHARE; so a set waits for a
-- block in progress and then reads blocked_at as committed, and a block waits for a set in
-- progress and then deletes what it wrote. Both lock the peers row before peer_names. The
-- rest of the function is 0139's, unchanged.

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

CREATE OR REPLACE FUNCTION schellingaf.set_peer_name(p_peer bytea, p_name text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_set_at timestamptz; v_changed boolean; v_blocked_at timestamptz;
BEGIN
  -- A clear is never refused, a blocked KEY's included: the operator clears a name this way.
  IF p_name IS NULL OR p_name = '' THEN
    DELETE FROM peer_names n WHERE n.peer_id = p_peer;
    RETURN jsonb_build_object('name', NULL, 'set_at', NULL, 'changed', FOUND);
  END IF;
  -- FOR SHARE waits for a block in progress (see the header). The WHERE names peer_id only:
  -- a row the snapshot reads as unblocked must still be locked, then read again.
  SELECT pe.blocked_at INTO v_blocked_at FROM peers pe WHERE pe.peer_id = p_peer FOR SHARE OF pe;
  IF v_blocked_at IS NOT NULL THEN
    RAISE EXCEPTION 'KEY_BLOCKED';
  END IF;
  INSERT INTO peer_names AS n (peer_id, name) VALUES (p_peer, p_name)
  ON CONFLICT (peer_id) DO UPDATE SET name = EXCLUDED.name, set_at = now()
    WHERE n.name IS DISTINCT FROM EXCLUDED.name
  RETURNING n.set_at INTO v_set_at;
  v_changed := FOUND;
  IF NOT v_changed THEN
    SELECT n.set_at INTO v_set_at FROM peer_names n WHERE n.peer_id = p_peer;
  END IF;
  RETURN jsonb_build_object('name', p_name, 'set_at', v_set_at, 'changed', v_changed);
END $$;
REVOKE EXECUTE ON FUNCTION schellingaf.set_peer_name(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.set_peer_name(bytea, text) TO schellingaf_api;

-- A KEY blocked before this migration keeps the name it had; the trigger fires only on a
-- block from now on. Clear those names once, here.
DELETE FROM schellingaf.peer_names n USING schellingaf.peers p WHERE p.peer_id = n.peer_id AND p.blocked_at IS NOT NULL;
