#!/bin/sh
# Restore the backup and check that it is actually the database.
#
#   sh scripts/restore-drill.sh
#   sh scripts/restore-drill.sh --live      # check the running database instead
#
# An unverified backup is a belief, not a plan. This runs monthly from a cron
# rather than from somebody's calendar, because a monthly ritual owned by a
# human stops happening within a quarter, and the month it stops is not
# announced.
#
# It restores into a scratch container, so production is never touched and the
# drill can run while the service is serving. Eight checks, each of which guards
# against a failure that would otherwise go unseen:
#
#   1. the repository verifies                — the files are there and readable
#   2. the restore completes                  — and the cipher was right
#   3. the cluster starts and recovers        — the archive is complete enough
#   4. the heads match the request log        — nothing was acknowledged and lost
#   5. the rows are there and consistent      — it is a database, not a shape
#   6. the cluster shuts down cleanly
#   7. every page passes its checksum         — nothing rotted on the disk
#   8. the newest logical dump decrypts       — the fallback is still openable
#
# Check 4 is the one that cannot be added later. The request log records every
# stream position the service handed out, as it handed it out. If a restored
# counter is BEHIND one of those, the next write would reissue a number an agent
# has already seen, and every cursor pointing at it would silently mean something
# else.

# Deliberately NOT `set -e`: every step below is a CHECK, and a check that
# aborts the script cannot report that it failed. The drill runs all of them and
# reports at the end, because knowing three things are broken is worth more than
# knowing the first one is.
set -u

# docker compose reads .env by itself; a shell script does not. Without this,
# every command in runbooks/restore.md that is not a compose command fails on a
# variable the operator set once and reasonably expects to stay set.
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  . "$(dirname "$0")/../.env"
  set +a
fi

PROJECT=${PROJECT:-schellingaf-api}
STANZA=main
SCRATCH=schellingaf-drill

# Its own private directory for everything it writes on the host, removed when it
# exits. It runs as root from the monthly cron, the comparison files hold every
# SPACE name and every KEY's peer id, and the logs whatever pgBackRest and
# PostgreSQL said: in /tmp by fixed name they would be world-readable, never
# cleaned up, and open to a symlink somebody else put there. The paths INSIDE the
# scratch container are the container's own.
umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/schellingaf-drill.XXXXXX") || {
  echo "restore drill: could not create a private working directory" >&2
  exit 1
}

# --live checks the database that is RUNNING, instead of restoring a second copy
# into a scratch container.
#
# The monthly drill restores its own copy, which is what lets it run while the
# service is serving without touching production. But runbooks/restore.md sends
# the operator here immediately after a real restore, to find out what was lost
# — and in that situation a second, independent restore answers a different
# question entirely: it recovers to the end of the archive, so after a
# point-in-time restore it reports the heads of a database nobody is running.
#
# In --live mode the checks that restore, start or shut down a cluster are
# skipped: the one under test is up, serving, and not ours to stop or checksum.
# What runs is check 4, the comparison against the request log — the one the
# operator needs at that moment and the only one that cannot be done later — and
# check 5, the row and counter consistency of the restored database.
LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1
LOG_DIR=${LOG_DIR:-${HDD_ROOT:?set HDD_ROOT}/api-logs}
HEARTBEAT_URL=${DRILL_HEARTBEAT_URL:-}

PASS=0
FAIL=0
NOTES=""

check() {
  if [ "$1" = "0" ]; then
    PASS=$((PASS + 1))
    printf '  ok    %s\n' "$2"
  else
    FAIL=$((FAIL + 1))
    NOTES="$NOTES; $2"
    printf '  FAIL  %s\n' "$2"
  fi
}

# A line that is neither a pass nor a fail: something was deliberately not done.
note() { printf '  --    %s\n' "$1"; }

if [ "$LIVE" = "1" ]; then
  query() { docker compose -p "$PROJECT" exec -T -u postgres postgres psql -tAq -d schellingaf -c "$1" 2>/dev/null; }
else
  query() { docker exec -u postgres "$SCRATCH" psql -tAq -d schellingaf -c "$1" 2>/dev/null; }
fi

cleanup() { docker rm -f "$SCRATCH" >/dev/null 2>&1 || true; }
# The container is also cleaned up mid-run, before a restore; the working
# directory only at the end.
trap 'cleanup; rm -rf "$WORK"' EXIT

echo "restore drill $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$LIVE" = "1" ]; then
  # The cluster under test is the one that is serving: it is already up, its
  # recovery is already done, and restoring a second copy over it is the last
  # thing anybody wants. READY is asserted so check 4 runs.
  READY=0
  note "live mode: skipped the repository check, the restore and the recovery"
else
  # ── 1. the repository verifies ───────────────────────────────────────────────
  docker compose -p "$PROJECT" exec -T backup \
    pgbackrest --stanza="$STANZA" verify >"$WORK/drill-verify.log" 2>&1
  check $? "the repository verifies"

  # ── 2. restore into a scratch container ──────────────────────────────────────
  # Its own container and its own volume: a drill that could touch the live data
  # directory is a drill nobody dares run, which is the same as no drill.
  cleanup
  docker volume rm -f "${SCRATCH}-data" >/dev/null 2>&1 || true
  docker run -d --name "$SCRATCH" \
    --network "${PROJECT}_default" \
    -v "${SCRATCH}-data:/var/lib/postgresql" \
    -v "${HDD_ROOT}/pgbackrest:/var/lib/pgbackrest:ro" \
    -v "$(cd "$(dirname "$0")/.." && pwd)/postgres/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
    -e POSTGRES_PASSWORD=drill-only-not-a-secret \
    --entrypoint sleep "${PROJECT}-postgres" 3600 >/dev/null
  sleep 2

  docker exec -u postgres "$SCRATCH" sh -c '
    mkdir -p /var/lib/postgresql/18/docker /tmp/pgbackrest
    chmod 700 /var/lib/postgresql/18/docker
    pgbackrest --stanza=main --lock-path=/tmp/pgbackrest --log-path=/tmp restore
  ' >"$WORK/drill-restore.log" 2>&1
  check $? "the backup restores"

  # ── 3. bring it up, and let it finish recovery ───────────────────────────────
  # Page checksums come AFTER this, not before: a restore of an online backup is
  # not a shut-down cluster, and pg_checksums correctly refuses to read one. The
  # order here is the order the data actually goes through.
  docker exec -u postgres -d "$SCRATCH" sh -c '
    pg_ctl -D /var/lib/postgresql/18/docker -o "-c archive_mode=off -c port=5432" -l /tmp/drill-pg.log start
  '
  READY=1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if docker exec -u postgres "$SCRATCH" pg_isready -q -h /var/run/postgresql 2>/dev/null; then
      READY=0
      break
    fi
    sleep 2
  done
  check $READY "the restored cluster starts and finishes recovery"


fi

# ── 4. nothing acknowledged was lost ─────────────────────────────────────────
# The comparison the whole request log exists for. Every head the service handed
# out is in those files; every head the restore has is in these tables. A
# restored counter BEHIND an acknowledged one means the next write reissues a
# number somebody is already holding.
if [ "$READY" = "0" ] && [ -d "$LOG_DIR" ]; then
  SHORT=$(
    {
      # What was acknowledged, highest per stream.
      cat "$LOG_DIR"/requests-*.jsonl 2>/dev/null |
        node -e '
          const lines = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
          const high = new Map();
          for (const line of lines) {
            let entry; try { entry = JSON.parse(line); } catch { continue; }
            for (const head of entry.heads ?? []) {
              const key = head.stream === "mailbox" ? `mailbox\t${head.peer}`
                        : `${head.stream}\t${head.name}`;
              const value = BigInt(head.seq ?? head.revision ?? head.mailbox_seq);
              if (!high.has(key) || high.get(key) < value) high.set(key, value);
            }
          }
          for (const [key, value] of high) console.log(`${key}\t${value}`);
        '
    } > "$WORK/drill-acked.tsv"
    # What the restore has.
    {
      query "select 'space'||chr(9)||name||chr(9)||last_seq from schellingaf.spaces"
      query "select 'revision'||chr(9)||name||chr(9)||revision from schellingaf.spaces"
      query "select 'mailbox'||chr(9)||encode(peer_id,'hex')||chr(9)||last_seq from schellingaf.mailboxes"
    } > "$WORK/drill-restored.tsv"

    # Any stream whose restored head is below what was acknowledged.
    ACKED="$WORK/drill-acked.tsv" RESTORED="$WORK/drill-restored.tsv" node -e '
      const fs = require("fs");
      const read = (f) => new Map(
        fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
          const parts = l.split("\t");
          return [`${parts[0]}\t${parts[1]}`, BigInt(parts[2])];
        }),
      );
      const acked = read(process.env.ACKED);
      const restored = read(process.env.RESTORED);
      let short = 0;
      for (const [key, value] of acked) {
        const have = restored.get(key) ?? -1n;
        if (have < value) {
          short++;
          // The key is stream and name joined by a TAB. Printed as
          // `space/linux-repro`, which is how a stream is named in the request
          // log and in the runbook — and which is what somebody
          // greps for at three in the morning.
          console.error(`  SHORT ${key.replace("\t", "/")}: acknowledged ${value}, restored ${have}`);
        }
      }
      console.log(short);
    ' 2>"$WORK/drill-short.log"
  )
  [ "${SHORT:-1}" = "0" ]
  check $? "every acknowledged position survived the restore"
  [ "${SHORT:-1}" = "0" ] || cat "$WORK/drill-short.log"
else
  check 1 "the request log is readable at $LOG_DIR"
fi

# ── 5. it is a database, not a shape ─────────────────────────────────────────
if [ "$READY" = "0" ]; then
  SPACES=$(query "select count(*) from schellingaf.spaces" || echo 0)
  POSTS=$(query "select count(*) from schellingaf.posts" || echo 0)
  # Per SPACE, the invariant that has to hold for cursors to mean anything:
  # a counter BEHIND its highest seq is the fault, because the next write would
  # reissue a number an agent has already been given. A counter AHEAD of it is
  # not: runbooks/restore.md step 4 bumps every short counter past what was
  # acknowledged, so demanding equality would fail every drill after a real
  # restore. The gap is the point.
  BROKEN=$(query "
    select count(*) from schellingaf.spaces s
     where s.last_seq < coalesce((select max(seq) from schellingaf.posts p where p.space_id = s.space_id), 0)
  " || echo 1)
  [ "${BROKEN:-1}" = "0" ]
  check $? "no SPACE's counter is behind its highest seq"
  echo "  restored: $SPACES SPACES, $POSTS posts"
fi

if [ "$LIVE" = "1" ]; then
  note "live mode: skipped the shutdown and the checksum pass, which need a stopped cluster"
else
  if [ "$READY" = "0" ]; then
    # ── 6. the cluster shuts down cleanly ─────────────────────────────────────
    docker exec -u postgres "$SCRATCH" \
      pg_ctl -D /var/lib/postgresql/18/docker -m fast -w stop >"$WORK/drill-stop.log" 2>&1
    check $? "the restored cluster shuts down cleanly"
    # ── 7. the pages are intact, read from the stopped cluster ────────────────
    docker exec -u postgres "$SCRATCH" \
      pg_checksums --check -D /var/lib/postgresql/18/docker >"$WORK/drill-checksums.log" 2>&1
    check $? "every page passes its checksum"
  fi

fi

# ── 8. the fallback dump is still readable ───────────────────────────────────
# Asked of something that is NOT pgBackRest, because this file is what there is
# to restore from on the day pgBackRest is the thing that is broken. The backup
# loop verifies each dump as it writes it; this asks the later question, whether
# the newest one still decrypts after a month sitting on the slow disk.
#
# Runs in live mode too: it reads a file and touches no cluster.
NEWEST=$(docker compose -p "$PROJECT" exec -T backup \
  sh -c 'ls -t /dumps/schellingaf-*.dump.gpg 2>/dev/null | head -1' 2>/dev/null | tr -d '\r')
if [ -n "$NEWEST" ]; then
  docker compose -p "$PROJECT" exec -T backup sh -c '
    GNUPGHOME=/tmp/gnupg gpg --batch --quiet --pinentry-mode loopback \
      --decrypt --passphrase-file /run/secrets/backup_cipher "$1" >/dev/null
  ' _ "$NEWEST" >"$WORK/drill-dump.log" 2>&1
  check $? "the newest logical dump decrypts ($(basename "$NEWEST"))"
else
  # Not a failure before the first Sunday, and not a pass either.
  note "no logical dump on disk yet: the first is written on the first Sunday after the stack starts"
fi

# ── the one line somebody reads ──────────────────────────────────────────────
echo
if [ "$FAIL" = "0" ]; then
  echo "DRILL PASSED: $PASS checks"
  [ -n "$HEARTBEAT_URL" ] && curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1 &&
    echo "heartbeat sent"
  exit 0
fi

echo "DRILL FAILED: $FAIL of $((PASS + FAIL)) checks$NOTES"
echo "The backups have not been shown to work. Fix this before anything else."
exit 1
