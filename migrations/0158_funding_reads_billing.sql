-- The funding reads, once billing is real (0155) and a SPACE at zero is read-only (0157):
-- space_funding() answers the task bytes, the last day's bill as taken, free or shadow,
-- and where billing stands (not_started, started or paused, and from which day), the
-- SPACE's free days, whether it is read-only and since when, what a day costs it and its
-- payer, and the SPACES it pays for; funding_history() names the day and the measured
-- SPACE of each bill; funding_notice_view() gives a funding notice's present figures to a
-- member; and service_numbers() adds billing totals. Return types only grow, so a service
-- still running the older code reads these during a deploy.
--
-- Who reads what is unchanged: each read answers a member, or anyone for a public SPACE,
-- by the rule inside it; funding_notice_view() a member only.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- ─────────────────────────────────────────────────────────────────────────────
-- What a SPACE stores and costs
-- ─────────────────────────────────────────────────────────────────────────────

-- Where billing stands: paused while the switch is on shadow, not_started before real_from,
-- started after.
CREATE FUNCTION schellingaf.billing_state() RETURNS TABLE (state text, real_from date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT CASE WHEN e.mode = 'shadow' THEN 'paused'
              WHEN billing_today() < e.real_from THEN 'not_started'
              ELSE 'started' END,
         e.real_from
    FROM billing_epoch e
$$;

-- The SPACES whose replaced_by chain ends at p_payer, each with what a day of it costs now,
-- walked backwards as space_daily_due() walks them; only those with a cost above 0.
CREATE FUNCTION schellingaf.space_pays_for(p_payer uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH RECURSIVE chain (space_id, depth) AS (
    SELECT x.space_id, 1 FROM spaces x WHERE x.replaced_by = p_payer
    UNION ALL
    SELECT x.space_id, c.depth + 1 FROM chain c JOIN spaces x ON x.replaced_by = c.space_id WHERE c.depth < 16
  ),
  due AS (
    SELECT s.name, space_day_due(c.space_id, 0, billing_today()) AS per_day
      FROM chain c JOIN spaces s ON s.space_id = c.space_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('space', d.name, 'per_day_micro_usd', d.per_day) ORDER BY d.name)
                    FILTER (WHERE d.per_day > 0), '[]'::jsonb)
    FROM due d
$$;

DROP FUNCTION schellingaf.space_funding(uuid);

-- What GET /v1/spaces/{name}/funding reads: 0150's columns (the billable bytes of the last
-- day now count its task bytes), then the task counter; the last day's bill as taken, free
-- or shadow (shadow too for a day with no bill row that was not billed for real); where
-- billing stands; this SPACE's free days; whether it is read-only, which for a replaced
-- SPACE is whether its payer is, and since when a bill fell short; what a day of its own
-- storage costs now; what a day costs its payer, its own and every SPACE it pays for, or
-- for a replaced SPACE its own; and the SPACES it pays for with a cost above 0. A row only
-- for a member of the SPACE, or anyone for a public one, as space_counts() filters.
CREATE FUNCTION schellingaf.space_funding(p_space uuid)
  RETURNS TABLE (post_bytes bigint, file_bytes bigint, last_day date, bill_billable bigint, bill_due bigint,
                 bill_allowance bigint, bill_rate bigint, bill_days integer, bill_bytes_per_gb bigint,
                 task_bytes bigint, bill_taken bigint, bill_free boolean, bill_shadow boolean,
                 billing text, billing_from date, free_until date, read_only boolean, read_only_since timestamptz,
                 own_per_day bigint, per_day bigint, pays_for jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0),
         coalesce((SELECT f.attached_bytes FROM space_file_totals f WHERE f.space_id = p_space), 0),
         d.day, b.post_bytes + b.file_bytes + b.task_bytes, b.due_micro,
         b.allowance_bytes, b.micro_usd_per_gb_month, b.days_per_month, b.bytes_per_gb,
         coalesce((SELECT t.task_bytes FROM space_storage t WHERE t.space_id = p_space), 0),
         b.taken_micro, b.free,
         CASE WHEN d.day IS NULL THEN NULL ELSE coalesce(b.shadow, billing_day_mode(d.day) = 'shadow') END,
         st.state, st.real_from,
         (SELECT c.free_until FROM space_credit c WHERE c.space_id = p_space),
         credit_refusal(x.payer, 0) IS NOT NULL,
         CASE WHEN credit_refusal(x.payer, 0) IS NOT NULL
              THEN (SELECT c.frozen_since FROM space_credit c WHERE c.space_id = x.payer) END,
         space_day_due(p_space, 0, billing_today()),
         CASE WHEN x.replaced THEN space_day_due(p_space, 0, billing_today())
              ELSE space_daily_due(p_space, 0, billing_today()) END,
         CASE WHEN x.replaced THEN '[]'::jsonb ELSE space_pays_for(p_space) END
    FROM (SELECT billing_last_day() AS day) d
    CROSS JOIN billing_state() st
    CROSS JOIN (SELECT funding_credited_space(p_space) AS payer,
                       EXISTS (SELECT 1 FROM spaces s WHERE s.space_id = p_space AND s.replaced_by IS NOT NULL) AS replaced) x
    LEFT JOIN space_bills b ON b.space_id = p_space AND b.day = d.day
   WHERE caller_in_space(p_space) OR space_is_public(p_space)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Credit entries
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION schellingaf.funding_history(uuid, bigint, integer);

-- 0153's read, and for a bill the day it is for and the name of the SPACE it measured, read
-- from its key, bill:<space_id>:<day>; NULL for any other entry. Never the entry's note.
CREATE FUNCTION schellingaf.funding_history(p_space uuid, p_before bigint, p_limit integer)
  RETURNS TABLE (entry_id bigint, kind text, amount_micro bigint, balance_after_micro bigint, created_at timestamptz,
                 coin text, txid_in text, value_forwarded_coin numeric, address_in text,
                 bill_day date, bill_space text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT l.entry_id, l.kind, l.amount_micro, l.balance_after_micro, l.created_at,
         d.coin, d.txid_in, d.value_forwarded_coin, a.address_in,
         CASE WHEN l.kind = 'bill' THEN split_part(l.idempotency_key, ':', 3)::date END,
         CASE WHEN l.kind = 'bill'
              THEN (SELECT s.name FROM spaces s WHERE s.space_id = split_part(l.idempotency_key, ':', 2)::uuid) END
    FROM credit_ledger l
    LEFT JOIN funding_deposits d ON d.entry_id = l.entry_id
    LEFT JOIN funding_addresses a ON a.address_id = d.address_id
   WHERE l.space_id = p_space AND l.entry_id < coalesce(p_before, 9223372036854775807)
     AND (caller_in_space(p_space) OR space_is_public(p_space))
   ORDER BY l.entry_id DESC
   LIMIT least(greatest(p_limit, 0), 201)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- A funding notice's figures
-- ─────────────────────────────────────────────────────────────────────────────

-- What a funding notice in a mailbox shows now: the SPACE's name, whether it is read-only,
-- its balance, what a day costs it and the days that pays for. A member only: a recipient
-- who left reads the notice as unavailable.
CREATE FUNCTION schellingaf.funding_notice_view(p_space uuid)
  RETURNS TABLE (name text, read_only boolean, balance_micro bigint, per_day bigint, days_left bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT s.name, credit_refusal(p_space, 0) IS NOT NULL, x.balance, x.per_day,
         CASE WHEN x.per_day > 0 THEN x.balance / x.per_day END
    FROM spaces s
    CROSS JOIN (SELECT coalesce((SELECT c.balance_micro FROM space_credit c WHERE c.space_id = p_space), 0) AS balance,
                       space_daily_due(p_space, 0, billing_today()) AS per_day) x
   WHERE s.space_id = p_space AND caller_in_space(p_space)
$$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.billing_state(),
  schellingaf.space_pays_for(uuid),
  schellingaf.space_funding(uuid),
  schellingaf.funding_history(uuid, bigint, integer),
  schellingaf.funding_notice_view(uuid)
FROM PUBLIC;
-- billing_state(): the funding read answers where billing stands to a caller shown the
-- addresses alone; it names no SPACE.
GRANT EXECUTE ON FUNCTION
  schellingaf.billing_state(),
  schellingaf.space_funding(uuid),
  schellingaf.funding_history(uuid, bigint, integer),
  schellingaf.funding_notice_view(uuid)
TO schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- The service's numbers
-- ─────────────────────────────────────────────────────────────────────────────

-- As 0153_funding_reads.sql made it, with billing (0158): where billing stands and from
-- which day; the US dollars taken by real bills, all time and in bills for the last seven
-- days; the SPACES a real bill took something from, the same two ways; the SPACES whose
-- credit row is frozen; and the SPACES whose free days still run. Totals alone: no SPACE is
-- named.
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
  ),
  -- 0158: billing. A bill's last seven days are by the day it is for.
  bs AS (
    SELECT st.state, st.real_from FROM schellingaf.billing_state() st
  ),
  bl AS (
    SELECT coalesce(sum(b.taken_micro), 0) AS taken,
           coalesce(sum(b.taken_micro) FILTER (WHERE b.day >= schellingaf.billing_today() - 7), 0) AS taken_fresh,
           count(DISTINCT b.space_id) FILTER (WHERE b.taken_micro > 0) AS billed,
           count(DISTINCT b.space_id) FILTER (WHERE b.taken_micro > 0 AND b.day >= schellingaf.billing_today() - 7) AS billed_fresh
      FROM schellingaf.space_bills b
     WHERE NOT b.shadow
  ),
  cr AS (
    SELECT count(*) FILTER (WHERE cc.frozen) AS read_only,
           count(*) FILTER (WHERE cc.free_until > schellingaf.billing_today()) AS free_days
      FROM schellingaf.space_credit cc
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
      'pending', fd.pending),
    'billing', jsonb_build_object(
      'state', bs.state,
      'from', bs.real_from,
      'taken_micro_usd', jsonb_build_object('total', bl.taken,  'last_7_days', bl.taken_fresh),
      'spaces_billed',   jsonb_build_object('total', bl.billed, 'last_7_days', bl.billed_fresh),
      'spaces_read_only', cr.read_only,
      'spaces_with_free_days', cr.free_days))
    FROM k, active, s, po, t, f, c, m, fd, bs, bl, cr;
END;
