#!/bin/sh
# Everything that has to be true before `docker compose up` works, done once.
#
#   sudo env SSD_ROOT=/srv/ssd HDD_ROOT=/srv/hdd sh scripts/first-run.sh
#
# `sudo env`, and not `SSD_ROOT=... sudo sh ...`: sudo resets the environment by
# default, so variables written in front of it never arrive and this script dies
# on its own guard below. The obvious next move is to drop the sudo, and that is
# the run that cannot chown anything — which is why a failed chown here is fatal
# rather than a warning.
#
# Two jobs, and both of them fail in a way that looks like something else if
# they are skipped.
#
# The directories: Docker creates a missing bind-mount path as root. PostgreSQL
# then cannot write its archive, archiving stops, and the failure surfaces hours
# later as a backup that has silently not existed since the machine was built.
#
# The secrets: generated here, on the machine, so no password ever passes
# through anybody's clipboard, and the backup cipher exists before the first
# backup — it is fixed when the repository is created and can never be changed.

set -eu

: "${SSD_ROOT:?set SSD_ROOT: the fast disk, where the database and the archive spool live}"
: "${HDD_ROOT:?set HDD_ROOT: the slow disk, where backups, dumps and request logs live}"

ROOT=$(cd "$(dirname "$0")/.." && pwd)

# The uids inside the images: postgres is 999 in the official image, node is
# 1000 in node:26-trixie-slim. A bind mount carries host ownership into the
# container, so these have to match or nothing can write.
PG_UID=999
NODE_UID=1000

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "1. Directories, owned by the uids that have to write to them"

install_dir() {
  # -o/-g are not portable to macOS's install; chown afterwards covers both.
  mkdir -p "$1"
  chmod 750 "$1"
  # Fatal, not a warning. A directory left at 0750 owned by the wrong user is a
  # container that cannot write to it, and the two that matter fail quietly: the
  # archive stops and nobody is told, and the request log — the only record a
  # lossy restore can be reconciled against — is never written.
  chown "$2:$2" "$1" 2>/dev/null || {
    echo "  could not chown $1 to uid $2." >&2
    echo "  Run this as root on the real machine:" >&2
    echo "    sudo env SSD_ROOT=\"$SSD_ROOT\" HDD_ROOT=\"$HDD_ROOT\" sh scripts/first-run.sh" >&2
    exit 1
  }
  echo "  $1 (uid $2)"
}

install_dir "$SSD_ROOT/pgdata" "$PG_UID"
install_dir "$SSD_ROOT/pgbackrest-spool" "$PG_UID"
# Shared by the database and the backup container, and owned by neither unless
# somebody says so: a named volume here is created root-owned, and pgBackRest
# then cannot take its lock in either container.
install_dir "$SSD_ROOT/pglock" "$PG_UID"
install_dir "$HDD_ROOT/pgbackrest" "$PG_UID"
install_dir "$HDD_ROOT/pgbackrest-logs" "$PG_UID"
install_dir "$HDD_ROOT/dumps" "$PG_UID"
install_dir "$HDD_ROOT/api-logs" "$NODE_UID"

say "2. Secrets, generated here and never typed"

mkdir -p "$ROOT/secrets"
chmod 700 "$ROOT/secrets"

# Checked on BOTH branches, including the one that leaves an existing file
# alone. An empty secret file is not a shorter secret: an empty CHALLENGE_KEY
# makes the challenge HMAC publicly computable by anybody, and the service
# refuses to start on one. Finding that here costs a second; finding it when the
# stack will not come up costs an evening.
MIN_SECRET_BYTES=16
verify_secret() {
  # Counted the way src/config.ts counts, without surrounding whitespace, so a
  # file this accepts is one the service starts on: counted raw, sixteen spaces
  # would pass here and be refused there.
  SIZE=$(tr -d '[:space:]' < "$ROOT/secrets/$1" | wc -c | tr -d ' ')
  if [ "$SIZE" -lt "$MIN_SECRET_BYTES" ]; then
    echo "  $1 holds $SIZE bytes, and at least $MIN_SECRET_BYTES are required." >&2
    echo "  Delete $ROOT/secrets/$1 and re-run this script." >&2
    exit 1
  fi
  echo "  $1 $2 ($SIZE bytes)"
}

secret() {
  FILE="$ROOT/secrets/$1"
  if [ -f "$FILE" ]; then
    verify_secret "$1" "already exists, left alone"
    return
  fi
  # No trailing newline: a password file read whole would otherwise carry one,
  # and the mismatch only shows up as an authentication failure at 3am.
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48 | tr -d '\n' > "$FILE"
  chmod 640 "$FILE"
  verify_secret "$1" "written"
}

secret postgres_password
secret owner_db_password
secret migrate_db_password
secret api_db_password
secret challenge_key
secret funding_callback_secret
secret backup_cipher

# The database containers read these as uid 999; the api reads challenge_key and
# funding_callback_secret as 1000.
chown "$PG_UID:$PG_UID" "$ROOT/secrets/postgres_password" \
                        "$ROOT/secrets/owner_db_password" \
                        "$ROOT/secrets/backup_cipher" 2>/dev/null || true
chown "$NODE_UID:$NODE_UID" "$ROOT/secrets/challenge_key" "$ROOT/secrets/funding_callback_secret" 2>/dev/null || true
# migrate_db_password and api_db_password are each read by the database at initdb
# (as 999) and by a service container (as 1000), so they are readable by both
# rather than owned by either. The secrets folder is 0700, which keeps the host's
# other users out.
chmod 644 "$ROOT/secrets/migrate_db_password" "$ROOT/secrets/api_db_password" 2>/dev/null || true

# The service's signing key and certificate are the one secret this script must
# NOT make: the certificate is signed by a root key that never touches this
# machine. Checked here so a missing pair is found now, not at the first start.
if [ -f "$ROOT/secrets/service_signing_key.pem" ] && [ -f "$ROOT/secrets/service_certificate.json" ]; then
  chown "$NODE_UID:$NODE_UID" "$ROOT/secrets/service_signing_key.pem" "$ROOT/secrets/service_certificate.json" 2>/dev/null || true
  chmod 600 "$ROOT/secrets/service_signing_key.pem"
  echo "  service_signing_key.pem and service_certificate.json present"
else
  echo "  service_signing_key.pem and service_certificate.json are missing. Make them on your own machine:" >&2
  echo "    node scripts/service-key.ts root /path/to/offline-root" >&2
  echo "    node scripts/service-key.ts online ./out --root /path/to/offline-root/root.pem" >&2
  echo "  and copy the two files from out/ into $ROOT/secrets/. The service will not start without them." >&2
fi

say "3. The backup configuration, with its passphrase"

# pgBackRest has no cipher-pass-file option, so the passphrase goes into the
# config file, which is therefore generated here and never committed.
# Substituted by awk from the environment, never by sed from the command line: a
# passphrase an operator brought with an & or a | or a backslash in it would be
# read by sed as part of its own syntax, and pgBackRest would be given a different
# passphrase from the one the weekly dump is encrypted with.
write_backup_conf() {
  # In a subshell under umask 077, so the file never exists readable by others.
  # Each marker is replaced once, and the search goes on after the inserted text.
  (
    umask 077
    CIPHER=$(cat "$1") awk '{
      out = ""
      while ((at = index($0, "__BACKUP_CIPHER__")) > 0) {
        out = out substr($0, 1, at - 1) ENVIRON["CIPHER"]
        $0 = substr($0, at + 17)
      }
      print out $0
    }' "$2" > "$3"
  )
}
write_backup_conf "$ROOT/secrets/backup_cipher" "$ROOT/postgres/pgbackrest.conf.template" \
  "$ROOT/postgres/pgbackrest.conf"
chmod 640 "$ROOT/postgres/pgbackrest.conf"
chown "$PG_UID:$PG_UID" "$ROOT/postgres/pgbackrest.conf" 2>/dev/null || true
echo "  postgres/pgbackrest.conf written (holds the repository passphrase)"

say "4. Database settings, from this machine's real memory and cores"
sh "$ROOT/scripts/size-postgres.sh" --write

say "5. The environment file, so no command has to carry these again"
# Every docker compose command in every runbook omits these three variables,
# and docker-compose.yml refuses to start without them. Written here once, they
# are picked up automatically by compose from this directory for ever after —
# which is what makes runbooks/restore.md work when it is read in a hurry.
ENV_FILE="$ROOT/.env"
if [ -f "$ENV_FILE" ] && grep -q '^SSD_ROOT=' "$ENV_FILE"; then
  echo "  $ENV_FILE already sets the storage roots; leaving it alone"
else
  {
    echo "# Written by scripts/first-run.sh. Read automatically by docker compose."
    echo "SSD_ROOT=$SSD_ROOT"
    echo "HDD_ROOT=$HDD_ROOT"
    [ -n "${API_HOST:-}" ] && echo "API_HOST=$API_HOST"
    [ -n "${SITE_HOST:-}" ] && echo "SITE_HOST=$SITE_HOST"
  } >> "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "  wrote $ENV_FILE"
fi
[ -n "${API_HOST:-}" ] || echo "  API_HOST was not set: add it to $ENV_FILE before starting"
[ -n "${SITE_HOST:-}" ] || echo "  SITE_HOST was not set: add it to $ENV_FILE before starting"

say "Done. Before starting the stack:"
cat <<'NOTES'
  - In DNS, point the API hostname, the site's hostname and its www name at
    this machine. Do not put a content delivery network in front of the API:
    it would put every agent behind a handful of edge addresses and defeat
    both the per-key limits and the challenge flow.
  - Clone the website beside this one, into ../SchellingAF:
    git clone https://github.com/SchellingAF/website.git ../SchellingAF
    The site container is built from it.
  - Add repo2 to postgres/pgbackrest.conf: a bucket at a different provider,
    so the backups survive the machine.
  - Put HEARTBEAT_URL in .env: a hosted dead-man's-switch. The backup container
    REFUSES TO START without one, because backups nobody would be told had
    stopped are worth what they cost to take.
  - Approve the words agents read: npm run copy. The service will not start
    without it.
  - Put the service's signing key and certificate in secrets/, made on your own
    machine with scripts/service-key.ts, and SERVICE_ROOT_KEY in .env. The
    service will not start without them.

  Then: docker compose up -d
  (the storage roots and the hostname are in .env now, so no command needs them)
NOTES
