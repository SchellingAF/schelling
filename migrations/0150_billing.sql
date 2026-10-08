-- The shadow bill: once a UTC day, every SPACE over the free allowance of its visibility
-- gets one bill row, measured from the two counters (0148, 0121), with the rate and
-- allowance it used. In this release every row is shadow: it records what would be due,
-- takes nothing, and writes no ledger entry, because a ledger entry moves a balance.
-- bill_space_day() refuses a bill that is not shadow.
--
-- The job (src/db/billing.ts) passes every number: the day, the allowances and the rate,
-- from FUNDING in src/surface/vocabulary.ts, so each is written once; nothing here reads
-- now() for a day. A day is begun in billing_runs, its SPACES billed one transaction each,
-- and finished with its summary, the line the job logs. Every step is idempotent: the
-- primary key stops a SPACE being billed twice for a day, and only the call that finishes
-- a day logs it.
--
-- A later release bills for real by passing p_shadow false: its rows take
-- least(due, balance) and write the ledger entry bill:<space_id>:<day> in the same
-- transaction, through credit_post(). Shadow days stay shadow rows.
--
-- The bills and the runs are read by the definer functions alone. space_funding() is what
-- GET /v1/spaces/{name}/funding reads: a row only for a caller who may read the SPACE.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;
-- A REFERENCES to spaces takes SHARE ROW EXCLUSIVE on it, which every POST waits behind,
-- and the api role gives up on a lock after 2 s: wait 1.5 s at most, as 0148 does. A
-- timeout fails the migrate step and the deploy; the next deploy tries again.
SET LOCAL lock_timeout = '1500ms';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE schellingaf.space_bills (
  space_id               uuid NOT NULL REFERENCES schellingaf.spaces,
  day                    date NOT NULL,
  post_bytes             bigint NOT NULL CHECK (post_bytes >= 0),
  file_bytes             bigint NOT NULL CHECK (file_bytes >= 0),
  allowance_bytes        bigint NOT NULL CHECK (allowance_bytes >= 0),
  micro_usd_per_gb_month bigint NOT NULL CHECK (micro_usd_per_gb_month > 0),
  days_per_month         integer NOT NULL CHECK (days_per_month > 0),
  bytes_per_gb           bigint NOT NULL CHECK (bytes_per_gb > 0),
  due_micro              bigint NOT NULL CHECK (due_micro >= 0),
  taken_micro            bigint NOT NULL DEFAULT 0 CHECK (taken_micro BETWEEN 0 AND due_micro),
  shadow                 boolean NOT NULL,
  measured_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, day),
  CONSTRAINT space_bills_over CHECK (post_bytes + file_bytes > allowance_bytes),
  CONSTRAINT space_bills_shadow_takes_nothing CHECK (NOT shadow OR taken_micro = 0)
);
CREATE INDEX space_bills_day_idx ON schellingaf.space_bills (day);
CREATE TRIGGER space_bills_immutable BEFORE UPDATE OR DELETE ON schellingaf.space_bills
  FOR EACH ROW EXECUTE FUNCTION schellingaf.reject_mutation();
CREATE TRIGGER space_bills_no_truncate BEFORE TRUNCATE ON schellingaf.space_bills
  FOR EACH STATEMENT EXECUTE FUNCTION schellingaf.reject_mutation();

-- One row a UTC day the job has begun, finished once its summary is written. Kept because
-- on a day no SPACE is over its allowance there is no bill row to say the day was done.
-- recounted_at is when the job's recount and reconciliation ran for the day, NULL until
-- they have. Only the definer functions write it; billing_day_finish()'s guard is the
-- idempotency, and an operator may set a day back to have it done again.
CREATE TABLE schellingaf.billing_runs (
  day          date PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  recounted_at timestamptz,
  finished_at  timestamptz,
  summary     jsonb CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  CONSTRAINT billing_runs_finished CHECK ((finished_at IS NULL) = (summary IS NULL))
);

ALTER TABLE schellingaf.space_bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_bills_none ON schellingaf.space_bills FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.space_bills FROM schellingaf_api;
ALTER TABLE schellingaf.billing_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_runs_none ON schellingaf.billing_runs FOR SELECT TO schellingaf_api USING (false);
REVOKE ALL ON schellingaf.billing_runs FROM schellingaf_api;

-- ─────────────────────────────────────────────────────────────────────────────
-- The days
-- ─────────────────────────────────────────────────────────────────────────────

-- The latest finished day, NULL before the first.
CREATE FUNCTION schellingaf.billing_last_day() RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT max(r.day) FROM billing_runs r WHERE r.finished_at IS NOT NULL
$$;

-- The first day to do: the oldest begun and not finished, so a run that stopped part way
-- is finished later, never left behind; else the day after the latest finished; NULL
-- before the first run, when the job takes yesterday alone.
CREATE FUNCTION schellingaf.billing_next_day() RETURNS date
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce((SELECT min(r.day) FROM billing_runs r WHERE r.finished_at IS NULL),
                  (SELECT max(r.day) + 1 FROM billing_runs r WHERE r.finished_at IS NOT NULL))
$$;

-- Begins a day, and answers what it was: 'begun' by this call, 'open' when an earlier
-- call began it and none finished it, 'finished' when it is done and must not be billed
-- again; and whether the day's recount is recorded. The job recounts for its first open
-- day only while that is false, so a day begun by a tick that died still gets its recount,
-- and a day that keeps failing is not recounted every hour.
CREATE FUNCTION schellingaf.billing_day_begin(p_day date) RETURNS TABLE (state text, recounted boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_finished timestamptz; v_recounted timestamptz;
BEGIN
  INSERT INTO billing_runs (day) VALUES (p_day) ON CONFLICT (day) DO NOTHING;
  IF FOUND THEN
    state := 'begun'; recounted := false;
    RETURN NEXT;
    RETURN;
  END IF;
  SELECT r.finished_at, r.recounted_at INTO v_finished, v_recounted FROM billing_runs r WHERE r.day = p_day;
  state := CASE WHEN v_finished IS NULL THEN 'open' ELSE 'finished' END;
  recounted := v_recounted IS NOT NULL;
  RETURN NEXT;
END $$;

-- Records that the day's recount and reconciliation ran, once: true for the call that
-- recorded it. Called after both ran, so a tick that dies part way leaves it unrecorded
-- and the next tick runs them again.
CREATE FUNCTION schellingaf.billing_day_recounted(p_day date) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH recorded AS (
    UPDATE billing_runs r SET recounted_at = now()
     WHERE r.day = p_day AND r.recounted_at IS NULL
    RETURNING r.day
  )
  SELECT EXISTS (SELECT 1 FROM recorded)
$$;

-- Finishes a begun day with its summary. True for the one call that finished it, which
-- alone logs the day, so two processes never log one day twice.
CREATE FUNCTION schellingaf.billing_day_finish(p_day date, p_summary jsonb) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH finished AS (
    UPDATE billing_runs r SET finished_at = now(), summary = p_summary
     WHERE r.day = p_day AND r.finished_at IS NULL
    RETURNING r.day
  )
  SELECT EXISTS (SELECT 1 FROM finished)
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The bills
-- ─────────────────────────────────────────────────────────────────────────────

-- The SPACES over the allowance of their visibility, made before the day ended and not
-- yet billed for it, by space_id after the cursor, at most a thousand a call. Every
-- visibility and every status: a closed, replaced or withheld SPACE still stores its
-- bytes, so it is measured. The missing bound is the lowest uuid, taken with the cursor's
-- own test, as checkpoints_due() writes it.
CREATE FUNCTION schellingaf.bill_candidates(p_day date, p_after uuid, p_limit int,
                                            p_public bigint, p_private bigint, p_sealed bigint) RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce(array_agg(x.space_id ORDER BY x.space_id), '{}'::uuid[])
    FROM (SELECT s.space_id
            FROM spaces s
            LEFT JOIN space_storage t ON t.space_id = s.space_id
            LEFT JOIN space_file_totals f ON f.space_id = s.space_id
           WHERE s.space_id >= coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
             AND s.space_id IS DISTINCT FROM p_after
             AND s.created_at < (p_day + 1)::timestamp AT TIME ZONE 'UTC'
             AND coalesce(t.post_bytes, 0) + coalesce(f.attached_bytes, 0)
                 > CASE s.visibility WHEN 'public' THEN p_public WHEN 'private' THEN p_private ELSE p_sealed END
             AND NOT EXISTS (SELECT 1 FROM space_bills b WHERE b.space_id = s.space_id AND b.day = p_day)
           ORDER BY s.space_id
           LIMIT least(p_limit, 1000)) x
$$;

-- One SPACE's bill for one day, its own transaction. A SPACE whose credit is in fault is
-- skipped ('fault'); one at or under its allowance gets no row ('under'); otherwise one
-- row, 'billed', or 'already' when the day has one. The counters are read without a lock:
-- a reading a moment either side of a post is the same day's measure. A day's due is the
-- bytes over the allowance at a thirtieth of the monthly rate, in micro-dollars, rounded
-- down.
CREATE FUNCTION schellingaf.bill_space_day(p_space uuid, p_day date, p_public bigint, p_private bigint, p_sealed bigint,
                                           p_rate bigint, p_days int, p_bytes_per_gb bigint, p_shadow boolean) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE
  v_visibility text; v_posts bigint; v_files bigint; v_allowance bigint; v_due bigint;
BEGIN
  IF NOT p_shadow THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING DETAIL = 'billing has not started';
  END IF;
  IF EXISTS (SELECT 1 FROM credit_faults cf WHERE cf.space_id = p_space) THEN RETURN 'fault'; END IF;
  SELECT s.visibility,
         coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = s.space_id), 0),
         coalesce((SELECT f.attached_bytes FROM space_file_totals f WHERE f.space_id = s.space_id), 0)
    INTO v_visibility, v_posts, v_files
    FROM spaces s WHERE s.space_id = p_space;
  IF NOT FOUND THEN RAISE EXCEPTION 'SPACE_NOT_FOUND'; END IF;
  v_allowance := CASE v_visibility WHEN 'public' THEN p_public WHEN 'private' THEN p_private ELSE p_sealed END;
  IF v_posts + v_files <= v_allowance THEN RETURN 'under'; END IF;
  v_due := floor((v_posts + v_files - v_allowance)::numeric * p_rate / (p_days::numeric * p_bytes_per_gb))::bigint;
  INSERT INTO space_bills (space_id, day, post_bytes, file_bytes, allowance_bytes, micro_usd_per_gb_month,
                           days_per_month, bytes_per_gb, due_micro, taken_micro, shadow)
  VALUES (p_space, p_day, v_posts, v_files, v_allowance, p_rate, p_days, p_bytes_per_gb, v_due, 0, true)
  ON CONFLICT (space_id, day) DO NOTHING;
  IF FOUND THEN RETURN 'billed'; END IF;
  RETURN 'already';
END $$;

-- What a day measured, by visibility: every SPACE of it, the bytes its two counters hold
-- now, together and the largest, how many SPACES hold more than each size in p_sizes
-- (spaces_over, keyed by the size), and from the day's bill rows how many were over, by
-- how many bytes, and what would be due. One statement; no SPACE's name or id leaves it.
CREATE FUNCTION schellingaf.billing_summary(p_day date, p_public bigint, p_private bigint, p_sealed bigint,
                                            p_sizes bigint[]) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  WITH kinds (visibility, allowance) AS (
    VALUES ('public', p_public), ('private', p_private), ('sealed', p_sealed)
  ),
  sizes AS (
    SELECT s.visibility, z.size,
           count(*) FILTER (WHERE coalesce(t.post_bytes, 0) + coalesce(f.attached_bytes, 0) > z.size) AS spaces
      FROM spaces s
      LEFT JOIN space_storage t ON t.space_id = s.space_id
      LEFT JOIN space_file_totals f ON f.space_id = s.space_id
      CROSS JOIN unnest(p_sizes) AS z(size)
     GROUP BY s.visibility, z.size
  ),
  live AS (
    SELECT s.visibility, count(*) AS spaces,
           sum(coalesce(t.post_bytes, 0) + coalesce(f.attached_bytes, 0)) AS billable,
           max(coalesce(t.post_bytes, 0) + coalesce(f.attached_bytes, 0)) AS largest
      FROM spaces s
      LEFT JOIN space_storage t ON t.space_id = s.space_id
      LEFT JOIN space_file_totals f ON f.space_id = s.space_id
     GROUP BY s.visibility
  ),
  billed AS (
    SELECT s.visibility, count(*) AS over,
           sum(b.post_bytes + b.file_bytes - b.allowance_bytes) AS over_bytes,
           sum(b.due_micro) AS due
      FROM space_bills b JOIN spaces s ON s.space_id = b.space_id
     WHERE b.day = p_day
     GROUP BY s.visibility
  )
  SELECT jsonb_object_agg(k.visibility, jsonb_build_object(
           'allowance_bytes', k.allowance,
           'spaces', coalesce(l.spaces, 0),
           'over', coalesce(b.over, 0),
           'billable_bytes', coalesce(l.billable, 0),
           'max_billable_bytes', coalesce(l.largest, 0),
           'spaces_over', coalesce((SELECT jsonb_object_agg(z.size::text, coalesce(o.spaces, 0))
                                      FROM unnest(p_sizes) AS z(size)
                                      LEFT JOIN sizes o ON o.visibility = k.visibility AND o.size = z.size), '{}'::jsonb),
           'over_bytes', coalesce(b.over_bytes, 0),
           'due_micro_usd', coalesce(b.due, 0)))
    FROM kinds k
    LEFT JOIN live l ON l.visibility = k.visibility
    LEFT JOIN billed b ON b.visibility = k.visibility
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The read
-- ─────────────────────────────────────────────────────────────────────────────

-- What GET /v1/spaces/{name}/funding reads: the two counters (0 when missing), the latest
-- finished day, and that day's bill row if the SPACE has one, with the allowance and rate
-- it used, so the route can work a stranger's figure from rounded bytes. A row only for a
-- member of the SPACE, or anyone for a public one, as space_counts() filters.
CREATE FUNCTION schellingaf.space_funding(p_space uuid)
  RETURNS TABLE (post_bytes bigint, file_bytes bigint, last_day date, bill_billable bigint, bill_due bigint,
                 bill_allowance bigint, bill_rate bigint, bill_days integer, bill_bytes_per_gb bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT coalesce((SELECT t.post_bytes FROM space_storage t WHERE t.space_id = p_space), 0),
         coalesce((SELECT f.attached_bytes FROM space_file_totals f WHERE f.space_id = p_space), 0),
         d.day, b.post_bytes + b.file_bytes, b.due_micro,
         b.allowance_bytes, b.micro_usd_per_gb_month, b.days_per_month, b.bytes_per_gb
    FROM (SELECT billing_last_day() AS day) d
    LEFT JOIN space_bills b ON b.space_id = p_space AND b.day = d.day
   WHERE caller_in_space(p_space) OR space_is_public(p_space)
$$;

REVOKE EXECUTE ON FUNCTION
  schellingaf.billing_last_day(),
  schellingaf.billing_next_day(),
  schellingaf.billing_day_begin(date),
  schellingaf.billing_day_recounted(date),
  schellingaf.billing_day_finish(date, jsonb),
  schellingaf.bill_candidates(date, uuid, int, bigint, bigint, bigint),
  schellingaf.bill_space_day(uuid, date, bigint, bigint, bigint, bigint, int, bigint, boolean),
  schellingaf.billing_summary(date, bigint, bigint, bigint, bigint[]),
  schellingaf.space_funding(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  schellingaf.billing_last_day(),
  schellingaf.billing_next_day(),
  schellingaf.billing_day_begin(date),
  schellingaf.billing_day_recounted(date),
  schellingaf.billing_day_finish(date, jsonb),
  schellingaf.bill_candidates(date, uuid, int, bigint, bigint, bigint),
  schellingaf.bill_space_day(uuid, date, bigint, bigint, bigint, bigint, int, bigint, boolean),
  schellingaf.billing_summary(date, bigint, bigint, bigint, bigint[]),
  schellingaf.space_funding(uuid)
TO schellingaf_api;
