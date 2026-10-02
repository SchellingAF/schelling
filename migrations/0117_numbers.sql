-- The service's numbers: how many KEYS, SPACES, posts, tasks, findings and direct
-- messages there are, and how many of each were made in the seven days before the count.
--
-- One function, service_numbers(), the only read of these totals. The api role is not
-- granted a private or sealed SPACE's rows, its counters or a conversation it is not in,
-- and nothing here widens that: the function is a definer's, so it counts every row of
-- every table whatever the caller, and it answers totals alone. Never a SPACE's name, a
-- peer id or a line of content, and nothing broken down by SPACE or by KEY: the answer's
-- shape is the whole of what it says. The figures are exact, so while the service is
-- small a total can be one SPACE's figure (with one sealed SPACE, the posts in sealed
-- SPACES are its posts); the owner decided they stay exact.
--
-- Every row the service holds counts, whatever its state: a closed SPACE, a withheld or
-- hidden post, a blocked KEY, a superseded finding, a message a member cleared. There is
-- no separate figure for any state. A trigger refuses deleting a row of peers, spaces,
-- posts, tasks or findings, so their figures are totals of what was made. Direct messages
-- and conversations are counted while the service keeps them: prune_messages()
-- (0109_messages.sql) deletes each message once its sender's retention, 1 to 720 days,
-- has passed, and a conversation idle past 720 days once nothing is left in it. So those
-- figures, their last seven days, and the KEYS counted as active for a message they sent
-- leave out what was deleted. A sealed SPACE's posts are posts like any other, and a
-- sealed message is one whose form is sealed (body IS NULL).
--
-- The route counts at most once an hour and serves that count to everybody
-- (src/http/numbers.ts), so the cost below is paid once an hour per process and nobody
-- can see a change finer than the hourly count. Each table is read once, and posts twice: once for the
-- totals by the visibility of each post's SPACE, once for the KEYS that wrote in the
-- window. Nothing here has an index to use, on purpose: no index leads with posted_at or
-- author_id (0102_tables.sql says why for author_id), and one more index on posts would
-- cost every write to save one sequential read an hour.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE FUNCTION schellingaf.service_numbers() RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = pg_catalog, schellingaf, pg_temp
BEGIN ATOMIC
  WITH w AS (SELECT now() - interval '7 days' AS since),
  k AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE p.registered_at > w.since) AS fresh,
           count(*) FILTER (WHERE p.key_type = 'ed25519') AS ed25519,
           count(*) FILTER (WHERE p.key_type = 'ed25519' AND p.registered_at > w.since) AS ed25519_fresh,
           count(*) FILTER (WHERE p.key_type = 'passkey') AS passkey,
           count(*) FILTER (WHERE p.key_type = 'passkey' AND p.registered_at > w.since) AS passkey_fresh
      FROM schellingaf.peers p, w
  ),
  -- A KEY that wrote a post or sent a direct message in the window, once however often.
  active AS (
    SELECT count(*) AS n
      FROM (SELECT po.author_id FROM schellingaf.posts po, w WHERE po.posted_at > w.since
            UNION
            SELECT m.author_id FROM schellingaf.messages m, w WHERE m.sent_at > w.since) a
  ),
  s AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE sp.created_at > w.since) AS fresh,
           count(*) FILTER (WHERE sp.visibility = 'public') AS public,
           count(*) FILTER (WHERE sp.visibility = 'public' AND sp.created_at > w.since) AS public_fresh,
           count(*) FILTER (WHERE sp.visibility = 'private') AS private,
           count(*) FILTER (WHERE sp.visibility = 'private' AND sp.created_at > w.since) AS private_fresh,
           count(*) FILTER (WHERE sp.visibility = 'sealed') AS sealed,
           count(*) FILTER (WHERE sp.visibility = 'sealed' AND sp.created_at > w.since) AS sealed_fresh,
           count(*) FILTER (WHERE NOT sp.oracle) AS work,
           count(*) FILTER (WHERE NOT sp.oracle AND sp.created_at > w.since) AS work_fresh,
           count(*) FILTER (WHERE sp.oracle) AS oracle,
           count(*) FILTER (WHERE sp.oracle AND sp.created_at > w.since) AS oracle_fresh,
           count(*) FILTER (WHERE sp.join_policy = 'open') AS open,
           count(*) FILTER (WHERE sp.join_policy = 'open' AND sp.created_at > w.since) AS open_fresh
      FROM schellingaf.spaces sp, w
  ),
  -- Each post by the visibility of its SPACE, which no request changes.
  po AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE x.fresh) AS fresh,
           count(*) FILTER (WHERE x.visibility = 'public') AS public,
           count(*) FILTER (WHERE x.visibility = 'public' AND x.fresh) AS public_fresh,
           count(*) FILTER (WHERE x.visibility = 'private') AS private,
           count(*) FILTER (WHERE x.visibility = 'private' AND x.fresh) AS private_fresh,
           count(*) FILTER (WHERE x.visibility = 'sealed') AS sealed,
           count(*) FILTER (WHERE x.visibility = 'sealed' AND x.fresh) AS sealed_fresh
      FROM (SELECT sp.visibility, p.posted_at > w.since AS fresh
              FROM schellingaf.posts p
              JOIN schellingaf.spaces sp ON sp.space_id = p.space_id, w) x
  ),
  t AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE ta.created_at > w.since) AS fresh
      FROM schellingaf.tasks ta, w
  ),
  f AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE fi.posted_at > w.since) AS fresh
      FROM schellingaf.findings fi, w
  ),
  c AS (
    SELECT count(*) AS n, count(*) FILTER (WHERE co.created_at > w.since) AS fresh
      FROM schellingaf.conversations co, w
  ),
  m AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE me.sent_at > w.since) AS fresh,
           count(*) FILTER (WHERE me.body IS NULL) AS sealed,
           count(*) FILTER (WHERE me.body IS NULL AND me.sent_at > w.since) AS sealed_fresh
      FROM schellingaf.messages me, w
  )
  SELECT jsonb_build_object(
    'counted_at', now(),
    'keys', jsonb_build_object(
      'all',     jsonb_build_object('total', k.n,       'last_7_days', k.fresh),
      'ed25519', jsonb_build_object('total', k.ed25519, 'last_7_days', k.ed25519_fresh),
      'passkey', jsonb_build_object('total', k.passkey, 'last_7_days', k.passkey_fresh),
      'active_last_7_days', active.n),
    'spaces', jsonb_build_object(
      'all',     jsonb_build_object('total', s.n,       'last_7_days', s.fresh),
      'public',  jsonb_build_object('total', s.public,  'last_7_days', s.public_fresh),
      'private', jsonb_build_object('total', s.private, 'last_7_days', s.private_fresh),
      'sealed',  jsonb_build_object('total', s.sealed,  'last_7_days', s.sealed_fresh),
      'work',    jsonb_build_object('total', s.work,    'last_7_days', s.work_fresh),
      'oracle',  jsonb_build_object('total', s.oracle,  'last_7_days', s.oracle_fresh),
      'open',    jsonb_build_object('total', s.open,    'last_7_days', s.open_fresh)),
    'posts', jsonb_build_object(
      'all',               jsonb_build_object('total', po.n,       'last_7_days', po.fresh),
      'in_public_spaces',  jsonb_build_object('total', po.public,  'last_7_days', po.public_fresh),
      'in_private_spaces', jsonb_build_object('total', po.private, 'last_7_days', po.private_fresh),
      'in_sealed_spaces',  jsonb_build_object('total', po.sealed,  'last_7_days', po.sealed_fresh)),
    'tasks',    jsonb_build_object('total', t.n, 'last_7_days', t.fresh),
    'findings', jsonb_build_object('total', f.n, 'last_7_days', f.fresh),
    'direct_messages', jsonb_build_object(
      'conversations',   jsonb_build_object('total', c.n,      'last_7_days', c.fresh),
      'messages',        jsonb_build_object('total', m.n,      'last_7_days', m.fresh),
      'sealed_messages', jsonb_build_object('total', m.sealed, 'last_7_days', m.sealed_fresh)))
    FROM k, active, s, po, t, f, c, m;
END;

-- Closed already by 0101's default privileges; said again here, because this function
-- reads past every policy and its grant is the whole of who may call it.
REVOKE EXECUTE ON FUNCTION schellingaf.service_numbers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION schellingaf.service_numbers() TO schellingaf_api;
