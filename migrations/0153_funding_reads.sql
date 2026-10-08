-- The reads of a SPACE's funding: its deposit addresses, its balance and the deposits not
-- yet credited, its credit entries, and the service's funding totals in service_numbers().
-- GET /v1/spaces/{name}/funding and GET /v1/spaces/{name}/funding/history read them
-- (src/http/funding.ts), each in readTx with the caller bound.
--
-- Who reads what. A SPACE's deposit addresses are public: anyone reads them, a private or
-- sealed SPACE's too, but nobody while the SPACE is withheld. Its balance, its deposits and
-- its credit entries are read by anyone for a public SPACE and by its members alone for a
-- private or sealed one, and by nobody while it is withheld: caller_in_space() and
-- space_is_public() both say no then. The rule is inside each function, as in
-- space_funding() (0150), so a caller who skips the route's checks still reads nothing.
--
-- The balance is exact for everyone who reads it: with no bills taken, it is the sum of
-- the SPACE's deposits, which are public on their chains. A release that takes bills
-- decides again what a balance shows to a caller who is not a member.
--
-- No function here answers a wallet, a callback URL, its mac, a raw body or a ledger
-- entry's note. Whether an address forwards to the wallet configured now is worked out
-- here, from the wallets the route passes, so address_out never leaves SQL.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- A SPACE's deposit addresses, each with whether it forwards to the wallet configured now.
-- p_wallets is the configured wallet of each family, in COIN_FAMILIES' order (evm, solana,
-- btc, tron), NULL where a family has none; an EVM wallet is kept lower case.
CREATE FUNCTION schellingaf.funding_addresses_of(p_space uuid, p_wallets text[])
  RETURNS TABLE (coin text, family text, address_in text, address_out_current boolean, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT a.coin, a.family, a.address_in,
         coalesce(a.address_out = CASE a.family WHEN 'evm' THEN lower(p_wallets[1])
                                                WHEN 'solana' THEN p_wallets[2]
                                                WHEN 'btc' THEN p_wallets[3]
                                                WHEN 'tron' THEN p_wallets[4] END, false),
         a.created_at
    FROM funding_addresses a
   WHERE a.space_id = p_space
     AND NOT EXISTS (SELECT 1 FROM withheld_spaces w WHERE w.space_id = p_space AND w.released_at IS NULL)
   ORDER BY a.coin, a.created_at DESC
$$;

-- A SPACE's balance, and how many of its deposits are in each state. Pending, held and
-- rejected count the deposits to this SPACE's own addresses; credited and the last credit
-- count the deposits credited to it, a replaced SPACE's included.
CREATE FUNCTION schellingaf.funding_state(p_space uuid)
  RETURNS TABLE (balance_micro bigint, pending_count integer, held_count integer, rejected_count integer,
                 credited_count integer, last_credit_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce((SELECT c.balance_micro FROM space_credit c WHERE c.space_id = p_space), 0),
         (SELECT count(*)::integer FROM funding_deposits d WHERE d.space_id = p_space AND d.state = 'pending'),
         (SELECT count(*)::integer FROM funding_deposits d WHERE d.space_id = p_space AND d.state = 'held'),
         (SELECT count(*)::integer FROM funding_deposits d WHERE d.space_id = p_space AND d.state = 'rejected'),
         (SELECT count(*)::integer FROM funding_deposits d WHERE d.credited_space = p_space AND d.state = 'confirmed'),
         (SELECT max(d.confirmed_at) FROM funding_deposits d WHERE d.credited_space = p_space AND d.state = 'confirmed')
   WHERE caller_in_space(p_space) OR space_is_public(p_space)
$$;

-- The newest deposits to a SPACE's own addresses in one state, 20 at most.
CREATE FUNCTION schellingaf.funding_deposits_of(p_space uuid, p_state text, p_limit integer)
  RETURNS TABLE (coin text, txid_in text, value_coin numeric, value_forwarded_coin numeric, usd_micro bigint,
                 reason text, seen_at timestamptz, confirmed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT d.coin, d.txid_in, d.value_coin, d.value_forwarded_coin, d.usd_micro, d.reason, d.seen_at, d.confirmed_at
    FROM funding_deposits d
   WHERE d.space_id = p_space AND d.state = p_state
     AND (caller_in_space(p_space) OR space_is_public(p_space))
   ORDER BY d.seen_at DESC
   LIMIT least(greatest(p_limit, 0), 20)
$$;

-- A SPACE's credit entries, newest first, below p_before when it is given: each with its
-- deposit's coin, transaction, forwarded value and address, for an entry a deposit made.
-- 201 at most: a page of 200 and one more, which says whether there is more. Never the
-- entry's note: the operator writes it, for the operator. A missing p_before is the
-- highest id, so the bound stays an index condition under a generic plan.
CREATE FUNCTION schellingaf.funding_history(p_space uuid, p_before bigint, p_limit integer)
  RETURNS TABLE (entry_id bigint, kind text, amount_micro bigint, balance_after_micro bigint, created_at timestamptz,
                 coin text, txid_in text, value_forwarded_coin numeric, address_in text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT l.entry_id, l.kind, l.amount_micro, l.balance_after_micro, l.created_at,
         d.coin, d.txid_in, d.value_forwarded_coin, a.address_in
    FROM credit_ledger l
    LEFT JOIN funding_deposits d ON d.entry_id = l.entry_id
    LEFT JOIN funding_addresses a ON a.address_id = d.address_id
   WHERE l.space_id = p_space AND l.entry_id < coalesce(p_before, 9223372036854775807)
     AND (caller_in_space(p_space) OR space_is_public(p_space))
   ORDER BY l.entry_id DESC
   LIMIT least(greatest(p_limit, 0), 201)
$$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.funding_addresses_of(uuid, text[]),
  schellingaf.funding_state(uuid),
  schellingaf.funding_deposits_of(uuid, text, integer),
  schellingaf.funding_history(uuid, bigint, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schellingaf.funding_addresses_of(uuid, text[]),
  schellingaf.funding_state(uuid),
  schellingaf.funding_deposits_of(uuid, text, integer),
  schellingaf.funding_history(uuid, bigint, integer)
TO schellingaf_api;

-- As 0134_task_upkeep.sql made it, with funding (0153): confirmed deposits and the US
-- dollars they credited, all time and the last seven days by when each was confirmed, the
-- SPACES credited at least once, and the deposits not yet confirmed. Totals alone: no
-- SPACE is named.
CREATE OR REPLACE FUNCTION schellingaf.service_numbers() RETURNS jsonb
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
     WHERE ta.upkeep IS NULL AND ta.state <> 'deleted'  -- 0134
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
  ),
  -- 0153: deposits.
  fd AS (
    SELECT count(*) FILTER (WHERE d.state = 'confirmed') AS n,
           count(*) FILTER (WHERE d.state = 'confirmed' AND d.confirmed_at > w.since) AS fresh,
           coalesce(sum(d.usd_micro) FILTER (WHERE d.state = 'confirmed'), 0) AS usd,
           coalesce(sum(d.usd_micro) FILTER (WHERE d.state = 'confirmed' AND d.confirmed_at > w.since), 0) AS usd_fresh,
           count(DISTINCT d.credited_space) FILTER (WHERE d.state = 'confirmed') AS funded,
           count(*) FILTER (WHERE d.state = 'pending') AS pending
      FROM schellingaf.funding_deposits d, w
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
      'sealed_messages', jsonb_build_object('total', m.sealed, 'last_7_days', m.sealed_fresh)),
    'funding', jsonb_build_object(
      'deposits',           jsonb_build_object('total', fd.n,   'last_7_days', fd.fresh),
      'credited_micro_usd', jsonb_build_object('total', fd.usd, 'last_7_days', fd.usd_fresh),
      'spaces_funded', fd.funded,
      'pending', fd.pending))
    FROM k, active, s, po, t, f, c, m, fd;
END;
