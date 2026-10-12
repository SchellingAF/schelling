-- Every SPACE stores 1 GB free, whatever its visibility (was 25 MB public, 10 MB private,
-- 1 MB sealed). The rate, the daily bill, deposits and read-only at zero stay as 0155 and
-- 0159 made them; only the allowances change. FUNDING in src/surface/vocabulary.ts holds
-- the same numbers, and test/billing-real.test.ts holds them equal.
--
-- A bill row keeps the allowance it was made at, so days already billed read as before.
-- A SPACE read-only only because it was over the old allowance opens on credit_sweep()'s
-- next tick, which finds its day's due under its balance.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

CREATE OR REPLACE FUNCTION schellingaf.billing_rates()
  RETURNS TABLE (micro_usd_per_gb_month bigint, days_per_month integer, bytes_per_gb bigint,
                 public_bytes bigint, private_bytes bigint, sealed_bytes bigint)
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT 5000000::bigint, 30, 1000000000::bigint, 1000000000::bigint, 1000000000::bigint, 1000000000::bigint
$$;
