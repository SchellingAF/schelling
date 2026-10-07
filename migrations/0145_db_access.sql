-- A recovery notice under row-level security (security review, 7 October 2026).
--
-- GET /v1/recovery serves a notice only to a caller who may read every SPACE it names, so a
-- SPACE that is not public keeps its name, its id and how far its chains reached to its
-- readers (src/http/proofs.ts). recovery_notices had no policy: that rule held in the
-- route's statement alone, and any other read of the table by the api role read every
-- notice. Its policy now says what the route says, so a read anywhere answers the same:
--
--   the SPACE a notice is about   its space_id, which a notice apart names: readable to
--                                 whoever may read that SPACE, as can_read_space() answers
--                                 (a member, or anybody of a public SPACE not withheld);
--   every SPACE a notice lists    in spaces: public by its visibility, withheld or not,
--                                 because withholding hides a SPACE's posts, not what the
--                                 service signed about its chain; or one the caller may
--                                 read. A SPACE that no longer exists is neither.
--
-- The route keeps its own filter, the same rule. Each SPACE is asked about with
-- caller_in_space() and space_is_public(), which together answer what can_read_space()
-- answers, asked of one row (.claude/rules/plpgsql.md, "Sets, not rows"). The table is the
-- owner's and its row security is not forced, so record_recovery_notice(), the owner's,
-- writes as before. No other table, grant or function changes.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- Whether the caller may read a notice, from the bytes the service signed.
CREATE FUNCTION schellingaf.recovery_notice_readable(p_canonical bytea)
  RETURNS boolean
  LANGUAGE sql STABLE PARALLEL RESTRICTED SET search_path = pg_catalog, schellingaf, pg_temp
  RETURN (SELECT (x.body ->> 'space_id' IS NULL
                  OR schellingaf.caller_in_space((x.body ->> 'space_id')::uuid)
                  OR schellingaf.space_is_public((x.body ->> 'space_id')::uuid))
                 AND NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.body -> 'spaces') = 'array'
                                                    THEN x.body -> 'spaces' ELSE '[]'::jsonb END) e(item)
                     LEFT JOIN schellingaf.spaces s ON s.space_id = (e.item ->> 'space_id')::uuid
                    WHERE NOT (coalesce(s.visibility = 'public', false)
                               OR coalesce(schellingaf.caller_in_space((e.item ->> 'space_id')::uuid), false)))
            FROM (SELECT convert_from(p_canonical, 'UTF8')::jsonb AS body) x);
GRANT EXECUTE ON FUNCTION schellingaf.recovery_notice_readable(bytea) TO schellingaf_api;

ALTER TABLE schellingaf.recovery_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY recovery_notices_read ON schellingaf.recovery_notices FOR SELECT TO schellingaf_api
  USING (schellingaf.recovery_notice_readable(canonical));
