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

# Root must never run a command found in a directory that "vscode" can write. The container
# PATH starts with /usr/local/share/nvm/current/bin (devcontainers Node feature), a directory
# of the "nvm" group, which "vscode" belongs to: a fake iptables, curl or sleep placed there
# would run as root at the next start. System directories only (not /usr/local).
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# Readiness marker read by intersight-wait-for-firewall.sh (postStartCommand), so that no
# workspace code runs before the firewall is complete. It holds the start time of this PID 1
# (field 22 of /proc/1/stat): a marker left by a previous start of the same container never
# matches. Removed first, written only after a successful firewall run.
FIREWALL_READY_FLAG=/run/intersight-firewall.ready
rm -f "$FIREWALL_READY_FLAG"

/usr/local/bin/intersight-init-firewall.sh

awk '{print $22}' /proc/1/stat > "$FIREWALL_READY_FLAG.tmp"
mv "$FIREWALL_READY_FLAG.tmp" "$FIREWALL_READY_FLAG"

# Run the CMD (sleep infinity) as a child and stop on SIGTERM right away, as the dev
# container CLI's own wait loop does (trap + wait); with exec, PID 1 would ignore SIGTERM
# and "docker stop" would wait for its timeout.
trap 'exit 0' TERM
"$@" &
wait $!
