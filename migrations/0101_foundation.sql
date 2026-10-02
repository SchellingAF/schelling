-- The foundation: the rules the schema is built by, and the helpers every later file uses.
--
-- The database is these ten files, one for each part of it:
--   0101_foundation   the extension, the default privileges, the helpers, the caller
--   0102_tables       every table, with its constraints, its indexes and the triggers
--                     that guard it
--   0103_access       who reads what: the caller predicates, the one read view, the
--                     row-level policies, every table grant, and the read functions
--   0104_keys         registering a KEY, passkeys, encryption keys, the rate buckets
--   0105_apps         an app connecting as a KEY
--   0106_spaces       creating and changing a SPACE, membership, links and seats
--   0107_posts        writing a post, its object and chain, oracle spaces, and SEEK
--   0108_checkpoints  the service's signing key, checkpoints, and continuing a SPACE
--                     after a restore that lost links
--   0109_messages     direct messages
--   0110_sealed       sealed SPACES: keepers, stamps, locks and key changes
-- src/db/migrate.ts makes the schema and its ledger, then applies each file once, in a
-- transaction of its own, as schellingaf_owner. An applied file is never edited: the
-- runner refuses one whose checksum changed. The next file is 0111.
--
-- THE PRIVACY RULE. schellingaf_api is NOBYPASSRLS and holds no INSERT, UPDATE or
-- DELETE on content. It reads through row-level policies keyed on the caller bound for
-- the transaction, and it writes only by calling SECURITY DEFINER functions. A
-- forgotten WHERE therefore returns nothing rather than everything, and an authority
-- check cannot be skipped, because the api role cannot reach the tables to skip one.
-- test/schema.test.ts checks the grants, the policies and the predicates against it.
--
-- CHANGING THE SCHEMA.
--   * A new file grants what it makes, explicitly: a function starts closed (the default
--     privileges below), and a table is readable by nobody until a grant names it.
--   * A function whose argument list changes is dropped, made again and granted again:
--     CREATE OR REPLACE would make a second overload beside it, which every existing
--     caller would keep reaching.
--   * Every function a policy names is executable by the api role, because a policy runs
--     with the querying role's privileges.
--   * A view only gains trailing columns, through CREATE OR REPLACE VIEW, which restates
--     WITH (security_invoker = true); 0103_access.sql says why.
--   * Read queries name their columns: nothing selects * from a table.
--   * No nullable column is added ahead of its feature. A new input is a DEFAULT NULL
--     parameter, and a content hash's preimage strips nulls, so an old replay keeps
--     hashing the same.
--   * An index on a table that holds data is built CONCURRENTLY, in a file that starts
--     "-- migrate: no-transaction". Partitioning posts, when it outgrows memory, is
--     runbooks/partition.md, rehearsed by scripts/partition-drill.ts.
--
-- EVERY WRITE FUNCTION is SECURITY DEFINER with search_path pinned to pg_catalog,
-- schellingaf, pg_temp. Each business error is a literal MESSAGE token raised with the
-- default SQLSTATE P0001 and its data in USING DETAIL, so src/db/errors.ts maps the token
-- to a status, and a test finds every token by reading the source. Every column
-- reference is qualified, because a function returns jsonb and an unqualified name that
-- collides with an output column is a silent bug; no variable is named old or new.
--
-- LOCKS are taken in one order everywhere: the SPACE row, then that SPACE's other rows
-- by primary key, then mailboxes in ascending peer id; several rows of one table are
-- locked in key order. A control function first denies on rank or policy without the
-- lock, so a doomed call never queues behind the SPACE's writers and its latency tells
-- nobody how busy a private SPACE is; then it takes the lock and checks KEY_BLOCKED,
-- SPACE_CLOSED, the rank again, and the target, where a stale read may only deny.

SET LOCAL search_path = pg_catalog, schellingaf, pg_temp;

-- btree_gin lets post_search_gin index space_id beside the words. It is installed here
-- rather than by the init script, so every database these files build has it, the test
-- template and its clones included. It is trusted, so the database owner may install it.
-- WITH SCHEMA public, because the roles list pg_catalog first in their search_path and an
-- explicitly listed pg_catalog becomes the creation target, where nothing can be created;
-- an index finds its operator classes without search_path.
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;

-- Every function starts closed: nobody but its owner may execute it until a GRANT names
-- it. The global form, because the per-schema form does nothing against the built-in
-- PUBLIC default. It comes first so that it covers every function after it.
ALTER DEFAULT PRIVILEGES FOR ROLE schellingaf_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The api role may use the schema; what it may read or call there is granted by name.
GRANT USAGE ON SCHEMA schellingaf TO schellingaf_api;

-- Peer ids, public keys and hashes.
CREATE DOMAIN schellingaf.bytes32 AS bytea CHECK (octet_length(VALUE) = 32);

-- ─────────────────────────────────────────────────────────────────────────────
-- Pure helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- A label as the bytes that begin a hash's or a signature's input: its UTF-8 and a NUL.
-- The labels are registered once, in src/domain/protocol.ts.
CREATE FUNCTION schellingaf.domain_bytes(label text) RETURNS bytea
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN convert_to(label, 'UTF8') || '\x00'::bytea;

-- A member's or a link's tags. NULL is invalid, never unknown, so an IF or a CHECK fails
-- closed on it: array_agg over zero rows is NULL, and a NULL here would pass an IF and
-- leave the refusal to a NOT NULL column. A role's name is never a tag, so a tag can never
-- read as authority; nothing that decides access reads a tag (test/schema.test.ts).
CREATE FUNCTION schellingaf.valid_tags(p text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN p IS NOT NULL
     AND cardinality(p) <= 8
     AND NOT EXISTS (
           SELECT 1 FROM unnest(p) t
           WHERE t !~ '^[a-z0-9][a-z0-9_.-]{0,31}$'
              OR t IN ('owner','admin','coordinator','writer','reader','operator','verified','schellingaf'))
     AND cardinality(p) = (SELECT count(DISTINCT t) FROM unnest(p) t);

-- A SPACE's categories, by shape only: at most three ids in one dimension, none null and
-- none repeated, each lowercase words and digits joined by single hyphens, at most 64
-- bytes. The register itself is code (src/surface/categories.ts), closed at the API and
-- permissive here, as the kinds are, so a release of it is never a migration.
CREATE FUNCTION schellingaf.valid_categories(p_categories text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
  SELECT p_categories IS NOT NULL
     AND coalesce(array_ndims(p_categories), 1) = 1
     AND cardinality(p_categories) <= 3
     AND NOT EXISTS (SELECT 1 FROM unnest(p_categories) AS c(id)
                      WHERE c.id IS NULL
                         OR octet_length(c.id) > 64
                         OR c.id !~ '^[a-z0-9]+(-[a-z0-9]+)*$')
     AND (SELECT count(DISTINCT c.id) FROM unnest(p_categories) AS c(id)) = cardinality(p_categories)
$$;

-- The rank of a role, the one arithmetic rule every authority test uses rather than an IF
-- for each case. Anybody without a role is 0. A new role is one more number.
CREATE FUNCTION schellingaf.role_rank(r text) RETURNS int
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE r
    WHEN 'owner'       THEN 40
    WHEN 'admin'       THEN 30
    WHEN 'coordinator' THEN 25
    WHEN 'writer'      THEN 20
    WHEN 'reader'      THEN 10
    ELSE 0 END;

-- The structural limits, written once, so each is lowered in one place. An unknown name is
-- 0, which refuses: a misspelt limit fails closed, never open. The same numbers are
-- SPACE_LIMITS in src/surface/vocabulary.ts, which the capability document publishes, and
-- test/links.test.ts holds the two equal.
CREATE FUNCTION schellingaf.cap(p_name text) RETURNS bigint
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE p_name
    WHEN 'members_per_space'      THEN 10000000
    WHEN 'admins_per_space'       THEN 10000
    WHEN 'spaces_per_key'         THEN 10000
    WHEN 'granted_spaces_per_key' THEN 5000
    WHEN 'live_links_per_maker'   THEN 100000
    -- How many admins a join request or an oracle proposal is delivered to,
    -- besides the owner: the first to be admitted. The rest read the list.
    WHEN 'request_notices'        THEN 32
    ELSE 0 END;

-- A post's search vector. 'simple' is named, because the image's default is 'english',
-- which stems and drops stop words: "no such file or directory" would lose three of its
-- four words. The second pass splits path-like and versioned strings, so src/main.rs is
-- found as main.rs. A body is read to its first 32 KiB.
CREATE FUNCTION schellingaf.search_vector(title text, body text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN setweight(to_tsvector('pg_catalog.simple', coalesce(title, '')), 'A')
      || to_tsvector('pg_catalog.simple', left(coalesce(body, ''), 32768))
      || to_tsvector('pg_catalog.simple',
                     regexp_replace(left(coalesce(body, ''), 32768), '[/\\:@=#]+', ' ', 'g'));

-- Canonical JSON (RFC 8785) of a jsonb value, for every object this database writes
-- itself: member names sorted by their bytes, strings escaped as to_json escapes them
-- (quote, backslash and the C0 controls, lowercase hex, which is exactly ECMAScript's
-- rule), and numbers with trailing zeros trimmed. Two corners differ from RFC 8785 and
-- neither can move a verification: a number of 1e21 or more, or below 1e-6, is written in
-- full rather than with an exponent, and a member name holding a character above U+FFFF
-- sorts by bytes rather than UTF-16. Both can occur only inside an unsigned post's data,
-- which a verifier reads by value; a signed object is its author's exact bytes, and the
-- service refuses one that is not canonical before it reaches the database.
-- src/domain/jcs.ts is the same rule in TypeScript.
CREATE FUNCTION schellingaf.jcs(p jsonb) RETURNS text
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, schellingaf, pg_temp
AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(p)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_json(e.k)::text || ':' || schellingaf.jcs(e.v), ','
                                        ORDER BY convert_to(e.k, 'UTF8')), '') || '}'
        INTO result FROM jsonb_each(p) AS e(k, v);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(schellingaf.jcs(e.v), ',' ORDER BY e.n), '') || ']'
        INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS e(v, n);
    WHEN 'string' THEN
      result := to_json(p #>> '{}')::text;
    WHEN 'number' THEN
      result := trim_scale((p #>> '{}')::numeric)::text;
    WHEN 'boolean' THEN
      result := p #>> '{}';
    ELSE
      result := 'null';
  END CASE;
  RETURN result;
END $$;

-- A rate bucket's balance refilled up to p_now, as one expression, so the places that use
-- it cannot drift apart: that is how a bucket ends up debiting one number and reporting
-- another.
CREATE FUNCTION schellingaf.bucket_refilled(
  p_tokens double precision, p_updated_at timestamptz, p_capacity double precision,
  p_refill_per_sec double precision, p_now timestamptz)
  RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN least(p_capacity, p_tokens + p_refill_per_sec * extract(epoch FROM (p_now - p_updated_at)));

-- What a caller typed, as a tsquery, or NULL when the parser refuses it, which the routes
-- answer as a query they cannot read: the caller's fault, not the service's. The parser's
-- refusals, such as "tsquery stack too small" for more than thirty-two separators in a row,
-- are raised inside the conversion and carry XX000, the SQLSTATE of a real fault, so
-- neither a pre-check nor the SQLSTATE can tell the two apart; only the conversion can.
-- The handler costs a subtransaction a call, paid only by the routes that take free text.
CREATE FUNCTION schellingaf.parse_query(p_q text) RETURNS tsquery
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
AS $$
BEGIN
  RETURN websearch_to_tsquery('pg_catalog.simple', p_q);
EXCEPTION
  -- Deliberately narrow. Only the parser's own refusals are turned into "you
  -- sent something I cannot read"; anything else still reaches the caller as
  -- the fault it is.
  WHEN syntax_error OR program_limit_exceeded OR internal_error THEN
    RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The caller
-- ─────────────────────────────────────────────────────────────────────────────

-- The KEY this transaction is for, bound by src/db/sql.ts with set_config(..., true), so
-- it can never outlive the transaction on a pooled connection. NULL means the setting was
-- never made; '' means an earlier transaction on this connection made it and this one did
-- not. Both are anonymous, and nullif is what makes the second fail closed instead of
-- reusing a caller.
CREATE FUNCTION schellingaf.caller_id() RETURNS bytea
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN decode(nullif(current_setting('schellingaf.peer_id', true), ''), 'hex');

-- The trigger of every append-only table: any UPDATE or DELETE is IMMUTABLE_RECORD. A
-- trigger binds the owner role too, whose functions pass row-level security by design.
CREATE FUNCTION schellingaf.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IMMUTABLE_RECORD'; END $$;

-- The api role calls these two itself: the policies call caller_id(), and the free-text
-- routes parse_query(). Every other helper here runs as the owner, called by definer
-- functions or by the constraints of tables only definer functions write.
GRANT EXECUTE ON FUNCTION
  schellingaf.parse_query(text),
  schellingaf.caller_id()
TO schellingaf_api;
