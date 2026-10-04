-- A KEY's own name beside its peer id (PUT /v1/me/name).
--
-- One name per KEY, never per SPACE; changed or cleared at any time, and clearing deletes
-- the row, so no old name is kept. The peer id stays the only identity: roles, blocks,
-- signatures and to name it, and a name need not be unique, so nothing refuses a name for
-- being in use and nothing looks a KEY up by name. Each read joins a name to an id it has
-- already selected under its own checks, so no private SPACE leaks through this table,
-- which has no space_id and, as peers, no row security.
--
-- The CHECK is PEER_NAME in src/surface/vocabulary.ts, its source byte for byte;
-- test/peer-names.test.ts holds the two equal. The reserved words live in
-- peerNameRefusal() alone, as tags' do. The api role reads the table and writes it only
-- through set_peer_name().

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE TABLE schellingaf.peer_names (
  peer_id schellingaf.bytes32 PRIMARY KEY REFERENCES schellingaf.peers,
  name    text NOT NULL CONSTRAINT peer_names_name CHECK (name ~ '^(?=.{1,32}$)(?!.*(?:[0-9a-f][._-]?){8})[a-z0-9]+(?:[._-][a-z0-9]+)*$'),
  set_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON schellingaf.peer_names FROM schellingaf_api;
GRANT SELECT (peer_id, name, set_at) ON schellingaf.peer_names TO schellingaf_api;

-- Sets the caller's name, or clears it with NULL or ''. The route has checked the name
-- against the reserved words; the CHECK holds the pattern. The same name again changes
-- nothing and keeps set_at.
CREATE FUNCTION schellingaf.set_peer_name(p_peer bytea, p_name text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE v_set_at timestamptz; v_changed boolean;
BEGIN
  -- A clear is never refused, a blocked KEY's included: the operator clears a name this way.
  IF p_name IS NULL OR p_name = '' THEN
    DELETE FROM peer_names n WHERE n.peer_id = p_peer;
    RETURN jsonb_build_object('name', NULL, 'set_at', NULL, 'changed', FOUND);
  END IF;
  IF EXISTS (SELECT 1 FROM peers pe WHERE pe.peer_id = p_peer AND pe.blocked_at IS NOT NULL) THEN
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
