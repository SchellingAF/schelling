#!/usr/bin/env bash
# The hot-space benchmark: the three shapes that serialise, at rising client
# counts, against a seeded database.
#
#   scripts/bench.sh                  # the full sweep, about twelve minutes
#   CLIENTS="1 8" DURATION=10 scripts/bench.sh hot     # one scenario, quickly
#
# Scenarios: hot, to, join, all (the default).
#
# What it measures is CONTENTION, not throughput. The local Postgres keeps its
# data in memory, so a commit costs nothing like it does on a real disk and the
# transactions-per-second figures are far higher than any machine will produce.
# The shape of the curve as clients rise is the finding; the absolute number is
# not, and must never be quoted as capacity.
set -uo pipefail
cd "$(dirname "$0")/.."

DB=${DB_NAME:-schellingaf_bench}
PORT=${DB_PORT:-5439}

# The target has to be a benchmark database; that is checked, not assumed.
#
# reset_db below reaches PAST the immutability triggers. It is the only thing in
# this repository that does and the only thing that may — but which database it
# reaches into was decided by an environment variable whose documented
# production value is `schellingaf` (.env.example), and scripts/restore-drill.sh
# exports the whole of .env with `set -a`. An operator one sourced .env away from
# a production name should not be one command away from deleting rows the
# service itself has no path to delete.
case "$DB" in
  *bench*) ;;
  *)
    echo "refusing: DB_NAME is \"$DB\", which is not a benchmark database." >&2
    echo "This script disables five immutability triggers and then deletes rows." >&2
    echo "Set DB_NAME to a name containing 'bench', and run scripts/bench-setup.ts" >&2
    echo "against the same database first." >&2
    exit 1
    ;;
esac
CLIENTS=${CLIENTS:-"1 4 8 16 32"}
DURATION=${DURATION:-20}
ONLY=${1:-all}

export PGPASSWORD=${DB_PASSWORD:-test_api_password_not_a_secret}
# Unquoted on purpose wherever it is used, as are $extra and $pct below: each is
# a word list that has to split into separate arguments.
PG="-h 127.0.0.1 -p $PORT -U ${DB_USER:-schellingaf_api} -d $DB"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Every run starts from the same table, or the later ones are measuring a bigger
# index rather than more clients — and a sweep that appends for two minutes at
# eight thousand a second fills the throwaway data directory besides.
#
# This reaches past the immutability triggers, which is acceptable only because
# the benchmark database is disposable — checked above, not assumed. Nothing
# outside this script may do it, and the service has no path that can: that is
# the whole point of the triggers. The seeded corpus is left alone, so the search
# index stays realistic; only what the benchmark itself wrote is removed.
#
# EVERY delete here is scoped to the SPACES scripts/bench-setup.ts made, which
# nothing but the benchmark writes in. Each such SPACE is put back to no posts,
# so its next post is the first of a fresh chain. Children go before their
# parents, for the foreign keys. None resets mailboxes.last_seq, so an unscoped
# delete would leave each recipient's counter standing above its surviving
# delivery rows with no record of what the missing positions were — the mailbox
# stream corrupted in exactly the way the restore machinery cannot repair.
reset_db() {
  PGPASSWORD=${MIGRATE_PASSWORD:-test_migrate_password_not_a_secret} psql -q \
    -h 127.0.0.1 -p "$PORT" -U schellingaf_migrate -d "$DB" \
    -c "set role schellingaf_owner;
        alter table schellingaf.mailbox_deliveries disable trigger deliveries_immutable;
        alter table schellingaf.join_requests    disable trigger requests_protect;
        alter table schellingaf.post_fingerprints disable trigger fingerprints_immutable;
        alter table schellingaf.post_objects     disable trigger post_objects_immutable;
        alter table schellingaf.posts            disable trigger posts_immutable;
        delete from schellingaf.mailbox_deliveries
         where space_id in (select space_id from bench.spaces);
        delete from schellingaf.join_requests
         where space_id in (select space_id from bench.spaces);
        delete from schellingaf.post_fingerprints
         where space_id in (select space_id from bench.spaces);
        delete from schellingaf.post_search
         where space_id in (select space_id from bench.spaces);
        delete from schellingaf.post_objects
         where space_id in (select space_id from bench.spaces);
        delete from schellingaf.posts
         where space_id in (select space_id from bench.spaces);
        update schellingaf.spaces set last_seq = 0
         where space_id in (select space_id from bench.spaces);
        alter table schellingaf.posts            enable trigger posts_immutable;
        alter table schellingaf.post_objects     enable trigger post_objects_immutable;
        alter table schellingaf.post_fingerprints enable trigger fingerprints_immutable;
        alter table schellingaf.join_requests    enable trigger requests_protect;
        alter table schellingaf.mailbox_deliveries enable trigger deliveries_immutable;
        select setval('bench.pair_seq', 1, false);" > /dev/null
}

run() {
  local label=$1 file=$2 extra=${3:-}
  printf '\n%s\n' "$label"
  printf '  %-8s %10s %9s %9s %9s %8s\n' clients tps "p50 ms" "p99 ms" "max ms" errors
  for c in $CLIENTS; do
    local jobs=$(( c < 4 ? c : 4 ))
    local prefix="$TMP/pgb-$c"
    rm -f "$prefix".*
    # A run on a table the reset did not restore measures something else.
    reset_db || { echo "the reset failed: nothing was measured" >&2; exit 1; }
    local out
    out=$(pgbench $PG -f "$file" -c "$c" -j "$jobs" -T "$DURATION" -n -l \
            --log-prefix="$prefix" $extra 2>&1)
    local tps errs
    tps=$(sed -n 's/^tps = \([0-9.]*\).*/\1/p' <<<"$out" | head -1)
    errs=$(grep -c 'ERROR' <<<"$out")
    # pgbench writes one line per transaction, with the latency in microseconds
    # in the third field. Percentiles come from those, because a mean hides
    # exactly the thing a contention benchmark is looking for: the tail.
    local pct
    pct=$(cat "$prefix".* 2>/dev/null | awk '{print $3}' | sort -n | awk '
      { v[NR] = $1 }
      END {
        if (NR == 0) { print "- - -"; exit }
        i50 = int(NR * 0.50); if (i50 < 1) i50 = 1
        i99 = int(NR * 0.99); if (i99 < 1) i99 = 1
        printf "%.2f %.2f %.2f", v[i50]/1000, v[i99]/1000, v[NR]/1000
      }')
    printf '  %-8s %10s %9s %9s %9s %8s\n' "$c" "${tps:-failed}" $pct "$errs"
    if [ "$errs" != "0" ]; then grep -m2 'ERROR' <<<"$out" | sed 's/^/      /'; fi
    rm -f "$prefix".*
  done
}

# Plain ifs rather than a fall-through case: the bash that ships with macOS is
# 3.2 and has no ";;&".
if [ "$ONLY" = hot ] || [ "$ONLY" = all ]; then
  run "one hot SPACE — every write takes the same row lock" \
      scripts/hot-space.pgbench "-M prepared"
fi
if [ "$ONLY" = to ] || [ "$ONLY" = all ]; then
  run "one recipient — SPACE locks spread, one mailbox row does not" \
      scripts/one-recipient.pgbench "-M prepared"
fi

if [ "$ONLY" = join ] || [ "$ONLY" = all ]; then
  run "one admin group — each request locks up to 33 mailboxes" \
      scripts/admin-group.pgbench
fi
printf '\nContention is the finding. The numbers are from a database in memory.\n'
