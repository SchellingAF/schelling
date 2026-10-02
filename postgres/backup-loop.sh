#!/bin/bash
# Takes the backups, checks them, and tells somebody when it has stopped.
#
# The last part is the point. A backup loop that logs its failures to stdout has
# failed silently: nobody reads container logs on the morning nothing went wrong,
# and by the time anyone looks the archive has been broken for six weeks.
#
# So this pings a hosted dead-man's-switch after every successful pass. The
# switch mails or texts when the expected ping does not arrive, which means the
# alert fires for the cases a self-report cannot cover: the loop crashed, the
# container did not restart, the machine is gone.
set -uo pipefail

STANZA=main
HEARTBEAT_URL="${HEARTBEAT_URL:-}"

say() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# No switch, no loop. Without one, backups run and checks pass with nothing
# anywhere able to tell a person when they stopped, which is the one state this
# whole file exists to prevent. A loop that cannot alert is indistinguishable
# from a loop that works, right up to the night somebody reaches for a backup.
#
# Refused at START rather than at the first failure, because at start there is
# nothing to lose and the fix takes a minute; and only this container, so every
# other compose command in every runbook still works when the value is missing.
case "${HEARTBEAT_URL}" in
  "" | REPLACE_WITH_*)
    say "REFUSING TO START: HEARTBEAT_URL is not set."
    say "  It is the hosted dead-man's switch this loop pings after every good pass."
    say "  Without it nothing tells a person when backups stop. Set it in .env and"
    say "  bring this container back up."
    exit 1
    ;;
esac

# An alert withholds the next heartbeat, so the switch fires.
#
# Printing is not enough: the conditions checked below are the ones that make
# tomorrow's backup fail while today's still succeeds — a broken archiver, a
# transaction holding the log open, a disk running out — and a line in a
# container log is read by nobody on the morning nothing went wrong. They are
# precisely the failures a dead-man's switch cannot see for itself, which is why
# they have to reach it by suppressing a beat.
#
# The flag is cleared at the top of every hourly check, so a condition that
# clears stops suppressing within the hour rather than latching until somebody
# restarts the container.
ALERTS=0
alert() { ALERTS=1; say "ALERT: $*"; }

# Percent free on the filesystem holding $1, or nothing at all when that cannot be
# read. The capacity column is checked for digits rather than trusted, so a
# filesystem that reports `-`, a df that prints only its header and a df that fails
# outright all print nothing, which check_disk reports rather than compares.
free_pct() {
  df -P "$1" 2>/dev/null | awk 'NR == 2 { used = $5; sub(/%$/, "", used); if (used ~ /^[0-9]+$/) print 100 - used }'
}

# An alert when the disk holding $1 is under 15% free — and an alert when how free
# it is cannot be read at all. A fallback to "100% free" would make an unmounted
# volume, a missing df or a filesystem with no capacity figure each look exactly
# like a healthy disk.
check_disk() {
  PCT=$(free_pct "$1")
  case "$PCT" in
    "" | *[!0-9]*) alert "cannot read how much of the $2 is free ($1)" ;;
    *) if [ "$PCT" -lt 15 ]; then alert "the $2 is ${PCT}% free"; fi ;;
  esac
  return 0
}

# ── the weekly logical dump, and why it goes through gpg ─────────────────────
#
# The dump is a complete copy of everything: every private space's posts, and
# in the globals file every role's password hash. Written with a plain shell
# redirect, both would be readable by anyone who can read the disk, for the whole
# 35 days retention keeps them, beside a pgBackRest repository that is encrypted.
#
# So it goes through gpg, with the SAME passphrase as the repository. One
# secret, deliberately, for the same reason repo1 and repo2 share one: a second
# key is a second key to lose, and losing this one would break the fallback in
# precisely the situation the fallback exists for.
CIPHER_FILE=/run/secrets/backup_cipher

# gpg will not encrypt anything until it can write its keybox, and $HOME here
# is the database directory, which this container mounts READ-ONLY. Without
# this the dump dies with `can't create directory ... Read-only file system` on
# the real machine and nowhere else, which is the worst place to find it.
export GNUPGHOME=/tmp/gnupg
mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"

# -z 0 because a custom-format dump is already compressed, so gpg's own
# compression is pure CPU on incompressible input. --no-symkey-cache keeps the
# passphrase out of the agent gpg starts behind it.
gpg_batch() {
  gpg --batch --quiet --no-symkey-cache --pinentry-mode loopback \
      --passphrase-file "$CIPHER_FILE" "$@"
}

# Writes a .part and renames only after reading the file back through gpg. A
# dump that cannot be decrypted is worse than no dump, because it looks like
# one; and a half-written file must never wear the name of a good backup.
write_dump() {
  NAME=$1
  shift
  TMP="/dumps/$NAME.part"
  rm -f "$TMP"

  if ! "$@" 2>/tmp/dump.err |
       gpg_batch --symmetric --cipher-algo AES256 -z 0 --yes --output "$TMP"; then
    say "DUMP FAILED: $NAME was not written"
    sed 's/^/  /' /tmp/dump.err
    rm -f "$TMP"
    return 1
  fi

  # Reads the whole file, so this is the integrity check as much as the
  # can-anyone-open-it check.
  if ! gpg_batch --decrypt "$TMP" >/dev/null 2>/tmp/dump.err; then
    say "DUMP UNREADABLE: $NAME did not decrypt, and was discarded"
    sed 's/^/  /' /tmp/dump.err
    rm -f "$TMP"
    return 1
  fi

  mv "$TMP" "/dumps/$NAME"
  say "wrote $NAME ($(du -h "/dumps/$NAME" | cut -f1))"
}

# Only on success, and only after the check. Pinging before verifying would turn
# the switch into a report that the loop is running, which nobody needs.
beat() {
  # The same rule as the weekly dump: report healthy only when everything that
  # was checked was healthy. An outstanding alert means the switch should fire.
  if [ "$ALERTS" != "0" ]; then
    say "WITHHOLDING THE HEARTBEAT: the last hourly check reported an alert"
    return
  fi
  if curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1; then
    say "heartbeat sent"
  else
    say "HEARTBEAT FAILED: the switch was not reachable"
  fi
}

# Said once at boot rather than only on the Sunday it bites, because a missing
# passphrase means no dump at all and nothing else here would mention it until
# the week somebody needs one.
[ -r "$CIPHER_FILE" ] ||
  say "no readable $CIPHER_FILE: the weekly dump will be SKIPPED, never written in the clear"

# Wait for the cluster. On a cold boot the database is still running initdb, and
# stanza-create against a cluster that does not exist yet fails in a way that
# reads like a configuration error.
until pg_isready -q -h /var/run/postgresql -U postgres; do
  say "waiting for the cluster"
  sleep 5
done

# Idempotent: it succeeds on an existing stanza and creates one on a new machine,
# so the first boot and the thousandth take the same path. The cipher is fixed
# here, at creation, and can never be changed afterwards.
if pgbackrest --stanza="$STANZA" stanza-create 2>&1 | sed 's/^/  /'; then
  say "stanza ready"
else
  say "STANZA CREATE FAILED"
fi

while true; do
  NOW=$(date -u +%H%M)
  DOW=$(date -u +%u)

  if [ "$NOW" = "0300" ]; then
    if [ "$DOW" = "7" ]; then
      say "full backup"
      pgbackrest --stanza="$STANZA" --type=full backup 2>&1 | sed 's/^/  /'
    else
      say "differential backup"
      pgbackrest --stanza="$STANZA" --type=diff backup 2>&1 | sed 's/^/  /'
    fi
    STATUS=$?

    # A logical dump beside the physical backups. It restores into a different
    # major version, which a physical backup cannot, and it is the fallback if
    # pgBackRest itself is ever the thing that is broken. Encrypted, because it
    # is a complete copy of every private space.
    DUMP_OK=0
    if [ "$DOW" = "7" ]; then
      if [ ! -r "$CIPHER_FILE" ]; then
        # Never the obvious fallback. A dump written in the clear because the
        # passphrase was missing would be a silent exposure.
        say "NO DUMP: $CIPHER_FILE is unreadable, and a dump is never written in the clear"
        DUMP_OK=1
      else
        say "weekly dump"
        DATE=$(date -u +%Y%m%d)
        write_dump "schellingaf-$DATE.dump.gpg" \
          pg_dump -h /var/run/postgresql -U postgres -Fc schellingaf || DUMP_OK=1
        write_dump "globals-$DATE.sql.gpg" \
          pg_dumpall -h /var/run/postgresql -U postgres --globals-only || DUMP_OK=1

        # Retention has to name the encrypted files: a pattern ending in .dump or
        # .sql matches nothing, keeps every dump for ever, and still looks like it
        # prunes.
        find /dumps -name '*.dump.gpg' -mtime +35 -delete 2>/dev/null
        find /dumps -name 'globals-*.sql.gpg' -mtime +35 -delete 2>/dev/null
        # The wreckage of a dump that died halfway. A day is generous.
        find /dumps -name '*.part' -mtime +1 -delete 2>/dev/null
      fi
    fi

    if [ "$STATUS" -eq 0 ]; then
      # check reads the repository AND pushes a test segment through the
      # archive command, so it fails when archiving is broken even though
      # backup succeeded.
      if pgbackrest --stanza="$STANZA" check 2>&1 | sed 's/^/  /'; then
        if [ "$DUMP_OK" = "0" ]; then
          say "backup and check passed"
          beat
        else
          # Deliberate: the switch fires. A fallback that quietly stops being
          # written is indistinguishable from one that is there, right up to
          # the night somebody reaches for it.
          say "backup and check passed but THE DUMP DID NOT: withholding the heartbeat"
        fi
      else
        say "CHECK FAILED after a successful backup"
      fi
    else
      say "BACKUP FAILED"
    fi
    sleep 60
    continue
  fi

  # Hourly, between backups: the conditions that mean a backup will fail
  # tomorrow, reported today.
  #
  # `${NOW#??}` is the minutes. `#` strips the SHORTEST matching prefix, so a
  # wider pattern such as `${NOW#*[0-5][0-9]}` strips only the hour and is never
  # empty; test/deployment.test.ts runs this guard over every minute of a day.
  if [ "${NOW#??}" = "07" ]; then
    ALERTS=0
    FAILED=$(psql -h /var/run/postgresql -U postgres -tAc \
      "select failed_count from pg_stat_archiver" 2>/dev/null || echo "?")
    LAST_FAIL=$(psql -h /var/run/postgresql -U postgres -tAc \
      "select coalesce(extract(epoch from now() - last_failed_time)::int, -1) from pg_stat_archiver" 2>/dev/null || echo "-1")
    OLDEST_TX=$(psql -h /var/run/postgresql -U postgres -tAc \
      "select coalesce(max(extract(epoch from now() - xact_start))::int, 0) from pg_stat_activity where xact_start is not null" 2>/dev/null || echo 0)

    [ "$FAILED" != "0" ] && [ "$FAILED" != "?" ] && alert "pg_stat_archiver reports $FAILED failures"
    [ "$LAST_FAIL" -ge 0 ] && [ "$LAST_FAIL" -lt 900 ] && alert "archiving failed ${LAST_FAIL}s ago"
    [ "$OLDEST_TX" -gt 300 ] && alert "a transaction has been open for ${OLDEST_TX}s, which holds the log"
    check_disk /var/lib/pgbackrest "backup disk"
    # The OTHER disk. The one above holds the backup repository; this one holds
    # pgdata and pg_wal, and filling it stops the database rather than the
    # backups.
    check_disk /var/lib/postgresql "database disk"

    AGE=$(pgbackrest --stanza="$STANZA" --output=json info 2>/dev/null \
      | grep -o '"stop":[0-9]*' | tail -1 | cut -d: -f2)
    if [ -n "$AGE" ]; then
      HOURS=$(( ( $(date +%s) - AGE ) / 3600 ))
      [ "$HOURS" -gt 26 ] && alert "the newest backup is ${HOURS} hours old"
    else
      # Deliberately NOT an alert. Before the first 03:00 this is true on every
      # freshly installed machine, and latching it would withhold the very first
      # heartbeat — reporting a failure for a backup that then worked. It is also
      # the one condition the dead-man's switch already covers by construction:
      # a switch that has never been pinged is exactly "no backup exists yet".
      say "no backup exists yet"
    fi
    # And beat here, not only after the nightly backup.
    #
    # The alert flag is cleared at the top of every hourly check, so with the only
    # beat at 03:00 a condition raised at 07:07 would be gone by 08:07 unheard, and
    # one that appeared at 02:30 would be raised at 03:07, minutes after the day's
    # one beat had reported healthy.
    #
    # Beating after every hourly check makes the switch's silence mean what this
    # file claims it means, within the hour. The hosted switch must therefore
    # expect a ping ROUGHLY HOURLY rather than daily — about ninety minutes of
    # grace — which is said beside the URL in .env.example, because a switch
    # configured for a daily ping would fire every hour and be turned off inside
    # a week.
    beat
    sleep 60
    continue
  fi

  sleep 30
done
