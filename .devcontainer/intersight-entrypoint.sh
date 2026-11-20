#!/bin/bash
# =====================================================================================
#  ENTRYPOINT of the development container (Dockerfile), run as root at every start.
# =====================================================================================
#  Applies the outbound firewall BEFORE anything else runs in the container. If the
#  firewall fails, this script exits with an error and the container ends: VS Code
#  cannot attach to a container without a firewall (fail-closed).
#
#  Why not postStartCommand: a failed lifecycle command leaves the container running.
#  devcontainer.json sets "overrideCommand": false, so the dev container CLI runs this
#  ENTRYPOINT + the image CMD through `exec "$@"` (devcontainers/cli,
#  src/spec-node/singleContainer.ts) instead of its own wait loop.
# =====================================================================================
set -euo pipefail

/usr/local/bin/intersight-init-firewall.sh

# Run the CMD (sleep infinity) as a child and stop on SIGTERM right away, as the dev
# container CLI's own wait loop does (trap + wait); with exec, PID 1 would ignore SIGTERM
# and "docker stop" would wait for its timeout.
trap 'exit 0' TERM
"$@" &
wait $!
