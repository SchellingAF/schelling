#!/bin/sh
# Size the database for the machine it is actually on.
#
# Every figure below is a formula of the machine's memory and cores, so moving to
# a bigger machine is a re-run of this script rather than somebody remembering
# which settings were tuned for eight gigabytes.
#
#   sh scripts/size-postgres.sh                 # print what it would write
#   sh scripts/size-postgres.sh --write         # write postgres/postgresql.conf
#
# Run it ON the machine that will run the database. Reading the memory of a
# laptop and shipping the answer to a server is exactly the mistake this exists
# to prevent, so it prints what it measured and the file records it.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TEMPLATE="$ROOT/postgres/postgresql.conf.template"
TARGET="$ROOT/postgres/postgresql.conf"

# Total memory in megabytes, and cores. Linux first, then macOS, because the
# stack is developed on one and deployed on the other.
if [ -r /proc/meminfo ]; then
  MEM_MB=$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)
  CORES=$(getconf _NPROCESSORS_ONLN)
  WHERE="Linux"
elif command -v sysctl >/dev/null 2>&1; then
  MEM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
  CORES=$(sysctl -n hw.ncpu)
  WHERE="macOS"
else
  echo "cannot read this machine's memory or core count" >&2
  exit 1
fi

# A container is often given less than the machine has. If a cgroup limit is
# set, that is the real number, and sizing to the host would have the kernel
# kill the database under load rather than the query being slow.
for LIMIT in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
  [ -r "$LIMIT" ] || continue
  VALUE=$(cat "$LIMIT")
  case "$VALUE" in
    max|*[!0-9]*) continue ;;
  esac
  # An unset limit shows as an implausibly large number rather than as "max".
  LIMIT_MB=$(( VALUE / 1024 / 1024 ))
  if [ "$LIMIT_MB" -gt 0 ] && [ "$LIMIT_MB" -lt "$MEM_MB" ]; then
    MEM_MB=$LIMIT_MB
    WHERE="$WHERE (cgroup limit)"
  fi
done

# 25% of memory, capped at 64 GB: past that PostgreSQL's own buffer management
# stops beating the operating system's page cache.
SHARED_BUFFERS_MB=$(( MEM_MB / 4 ))
[ "$SHARED_BUFFERS_MB" -gt 65536 ] && SHARED_BUFFERS_MB=65536
[ "$SHARED_BUFFERS_MB" -lt 128 ] && SHARED_BUFFERS_MB=128

# 70%: what the planner should assume is cached between PostgreSQL and the
# kernel. It reserves nothing; it only changes which plan looks cheap.
EFFECTIVE_CACHE_MB=$(( MEM_MB * 7 / 10 ))
[ "$EFFECTIVE_CACHE_MB" -lt 256 ] && EFFECTIVE_CACHE_MB=256

# Per sort, per connection. max_connections is 100, so the worst case is
# bounded well under memory even at the ceiling.
WORK_MEM_MB=$(( MEM_MB / 200 ))
[ "$WORK_MEM_MB" -gt 64 ] && WORK_MEM_MB=64
[ "$WORK_MEM_MB" -lt 4 ] && WORK_MEM_MB=4

# Index builds and vacuum. Generous, because they are few and serial.
MAINTENANCE_MB=$(( MEM_MB / 16 ))
[ "$MAINTENANCE_MB" -gt 2048 ] && MAINTENANCE_MB=2048
[ "$MAINTENANCE_MB" -lt 64 ] && MAINTENANCE_MB=64

# Big enough that checkpoints are paced by the timeout rather than by running out
# of log, and small enough not to swallow a small machine's disk.
MAX_WAL_MB=$(( MEM_MB / 2 ))
[ "$MAX_WAL_MB" -gt 16384 ] && MAX_WAL_MB=16384
[ "$MAX_WAL_MB" -lt 1024 ] && MAX_WAL_MB=1024

IO_WORKERS=$(( CORES / 4 ))
[ "$IO_WORKERS" -gt 16 ] && IO_WORKERS=16
[ "$IO_WORKERS" -lt 3 ] && IO_WORKERS=3

STAMP="# Sized on $WHERE: ${MEM_MB}MB usable memory, ${CORES} cores."

render() {
  printf '%s\n' "$STAMP"
  printf '# Re-run scripts/size-postgres.sh on the machine that runs the database.\n\n'
  sed \
    -e "s/__SHARED_BUFFERS__/${SHARED_BUFFERS_MB}MB/" \
    -e "s/__EFFECTIVE_CACHE__/${EFFECTIVE_CACHE_MB}MB/" \
    -e "s/__WORK_MEM__/${WORK_MEM_MB}MB/" \
    -e "s/__MAINTENANCE_WORK_MEM__/${MAINTENANCE_MB}MB/" \
    -e "s/__MAX_WAL_SIZE__/${MAX_WAL_MB}MB/" \
    -e "s/__IO_WORKERS__/${IO_WORKERS}/" \
    "$TEMPLATE"
}

if [ "${1:-}" = "--write" ]; then
  render > "$TARGET"
  echo "$STAMP"
  echo "wrote postgres/postgresql.conf"
  grep -E '^(shared_buffers|effective_cache_size|work_mem|maintenance_work_mem|max_wal_size|io_workers)' "$TARGET"
else
  render
fi
