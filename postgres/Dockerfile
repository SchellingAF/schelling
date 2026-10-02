# PostgreSQL 18 with pgBackRest, from the same PGDG repository the base image
# already trusts. Two programs in one image on purpose: pgBackRest has to reach
# the running cluster over its socket and read its data directory, and the backup
# container runs this same image as the postgres user.

FROM postgres:18-bookworm

# The base image already carries the PGDG apt source and its key, so this pulls a
# packaged, signed build rather than something fetched from the internet at run
# time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The loop that takes the backups, checks them, and pings the switch that tells
# somebody when it has stopped.
COPY backup-loop.sh /backup-loop.sh
RUN chmod 0755 /backup-loop.sh
