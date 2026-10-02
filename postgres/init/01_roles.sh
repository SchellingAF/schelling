#!/bin/bash
# Runs once, at initdb, as the superuser. Everything in here needs privileges
# no migration is allowed to hold: creating roles, changing database ownership,
# setting role-level defaults, and installing an extension that is not trusted.
#
# btree_gin is deliberately NOT here. It is a trusted extension, so the database
# owner installs it in migrations/0101_foundation.sql, which means a freshly
# created test database gets it too. Putting it here would leave every cloned
# database without it and the search index would fail to build.
set -euo pipefail

# Each password comes from a FILE in the self-hosting stack and from a plain
# variable in the throwaway test stack. The file form is the one that matters: a
# password in an environment variable is readable in `docker inspect`, in the
# process list, and in any crash report the container ever writes.
#
# Without this, the self-hosting stack fails at initdb with a missing variable, or
# somebody "fixes" it by putting the real passwords in the environment.
from_file_or_env() {
  eval "FILE=\${${1}_FILE:-}"
  if [ -n "${FILE}" ]; then
    [ -r "${FILE}" ] || { echo "cannot read ${1}_FILE at ${FILE}" >&2; exit 1; }
    # No trailing newline: the file holds the password and nothing else, and a
    # stray newline surfaces later as an authentication failure nobody can
    # reproduce by hand.
    tr -d '\n' < "${FILE}"
  else
    eval "printf '%s' \"\${${1}:?${1} or ${1}_FILE must be set}\""
  fi
}

OWNER_PASSWORD=$(from_file_or_env OWNER_PASSWORD)
MIGRATE_PASSWORD=$(from_file_or_env MIGRATE_PASSWORD)
API_PASSWORD=$(from_file_or_env API_PASSWORD)
: "${POSTGRES_DB:?}"

# --dbname is explicit: a .sh init script is run as a shell, so unlike a .sql
# file nothing routes it to $POSTGRES_DB for us.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	-- The owner owns every object and logs in nowhere.
	CREATE ROLE schellingaf_owner NOLOGIN PASSWORD '${OWNER_PASSWORD}';

	-- The migration runner logs in and assumes the owner. The api container
	-- never holds owner rights.
	CREATE ROLE schellingaf_migrate LOGIN PASSWORD '${MIGRATE_PASSWORD}' IN ROLE schellingaf_owner;

	-- The service role. NOBYPASSRLS is the whole privacy design: without it a
	-- superuser-ish service role would see every row regardless of policy.
	CREATE ROLE schellingaf_api LOGIN NOBYPASSRLS PASSWORD '${API_PASSWORD}';

	ALTER DATABASE ${POSTGRES_DB} OWNER TO schellingaf_owner;

	-- pg_catalog first, so nothing in the schema can shadow a built-in. pg_temp
	-- named, and last: a search_path that leaves pg_temp out has it searched
	-- FIRST for relations, where a table a session made for itself would shadow a
	-- real one. Each schema is its own list item, unquoted: quoting the whole list
	-- makes it one schema name, which exists nowhere.
	ALTER ROLE schellingaf_api SET search_path = pg_catalog, schellingaf, pg_temp;
	ALTER ROLE schellingaf_api SET statement_timeout = '5s';
	ALTER ROLE schellingaf_api SET lock_timeout = '2s';
	ALTER ROLE schellingaf_api SET idle_in_transaction_session_timeout = '10s';

	ALTER ROLE schellingaf_migrate SET search_path = pg_catalog, schellingaf, pg_temp;
	ALTER ROLE schellingaf_migrate SET statement_timeout = '0';
	ALTER ROLE schellingaf_migrate SET lock_timeout = '10s';

	ALTER DATABASE ${POSTGRES_DB} SET default_text_search_config = 'pg_catalog.simple';

	CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

	REVOKE CREATE ON SCHEMA public FROM PUBLIC;

	-- The service never makes a temp table, so it may not: TEMPORARY is granted to
	-- PUBLIC on every database, so it is revoked from PUBLIC and given back to the
	-- migration runner alone.
	REVOKE TEMPORARY ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
	GRANT TEMPORARY ON DATABASE ${POSTGRES_DB} TO schellingaf_migrate;
SQL

echo "01_roles.sh: roles created, ownership transferred, defaults set"
