#!/bin/bash
# =====================================================================================
#  First step of postStartCommand (devcontainer.json): waits until the ENTRYPOINT has
#  completed the firewall for THIS container start, before any workspace code runs.
# =====================================================================================
#  The dev container CLI does not wait for the ENTRYPOINT: it starts its "docker exec"
#  commands as soon as the container runs. The firewall closes everything first (DROP
#  policies), so nothing gets out meanwhile, but workspace code (tests, then the VS Code
#  extensions, which wait for postStartCommand) should only start once it is complete.
#  The marker is written by root (intersight-entrypoint.sh) and holds the start time of the
#  container's PID 1: a stale marker or a file created by "vscode" is rejected.
# =====================================================================================
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

FIREWALL_READY_FLAG=/run/intersight-firewall.ready
FLAG_OWNER_UID=0
ATTEMPTS=120          # every 0.5 s: 60 s in total

pid1_start_time=$(awk '{print $22}' /proc/1/stat)
for _ in $(seq 1 "$ATTEMPTS"); do
    if [ -f "$FIREWALL_READY_FLAG" ] && [ "$(stat -c %u "$FIREWALL_READY_FLAG")" = "$FLAG_OWNER_UID" ] &&
       [ "$(cat "$FIREWALL_READY_FLAG")" = "$pid1_start_time" ]; then
        echo "Firewall ready for this container start"
        exit 0
    fi
    sleep 0.5
done
echo "ERROR: the firewall is not ready for this container start (no valid $FIREWALL_READY_FLAG)"
exit 1
