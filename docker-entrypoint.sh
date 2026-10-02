#!/bin/sh
# The image's entry point. The service never runs as root, but its log directory
# may be a volume a host mounts owned by root, which the node user could not write:
# the request log would refuse to start, and the checkpoint log would be lost.
#
# Started as root, this makes LOG_DIR if it is an absolute path, gives that one
# directory to node (not what is in it, so a large log costs nothing at start, and
# never what it points to, should it be a link the node user put there), and runs
# the command as node. Started as anyone else, it runs the command as it is.
set -eu

if [ "$(id -u)" = "0" ]; then
  case "${LOG_DIR:-}" in
    /*)
      mkdir -p "$LOG_DIR"
      chown -h node:node "$LOG_DIR"
      ;;
  esac
  # As USER node would have set it: setpriv changes the user and keeps the rest.
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
