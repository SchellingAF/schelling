#!/bin/sh
# The reviewer image's entry point, as the service image's is for its log directory.
# The reviewer never runs as root, but its state directory, where its KEY and its
# mailbox cursor live, may be a volume a host mounts owned by root, which the node
# user could not write: the KEY would be made again at every start and the cursor
# kept in memory only.
#
# Started as root, this makes the directory of REVIEWER_STATE_FILE if it is an absolute
# path, gives that one directory to node (not what is in it, and never what it points
# to, should it be a link the node user put there), and runs the command as node.
# Started as anyone else, it runs the command as it is.
set -eu

if [ "$(id -u)" = "0" ]; then
  state_dir=$(dirname "${REVIEWER_STATE_FILE:-/state/reviewer-state.json}")
  case "$state_dir" in
    /*)
      mkdir -p "$state_dir"
      chown -h node:node "$state_dir"
      ;;
  esac
  # As USER node would have set it: setpriv changes the user and keeps the rest.
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
