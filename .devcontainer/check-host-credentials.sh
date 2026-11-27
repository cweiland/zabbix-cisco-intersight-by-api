#!/bin/bash
# =====================================================================================
#  Checks, from inside the dev container, that the host gives no GitHub credential
#  through the Dev Containers relay (see docs/DEVCONTAINER_SECURITY.md).
#  Prints only whether a credential came back, never the credential itself.
#  Usage: bash .devcontainer/check-host-credentials.sh   (as "vscode", in the container)
#  Exit status: 0 = no credential, 1 = a credential came back, 2 = could not be verified.
#  If a sign-in window opens on the host while it runs, close it without signing in: the host
#  still prompts (set "git config --global credential.interactive false" there).
# =====================================================================================
set -uo pipefail

RELAY_DIR=/tmp
RELAY_TIMEOUT_SECONDS=10

relay_scripts=$(ls "$RELAY_DIR"/vscode-remote-containers-*.js 2>/dev/null | grep -v -- '-server-' || true)
if [ -z "$relay_scripts" ]; then
    echo "OK: no Dev Containers relay script in $RELAY_DIR"
    exit 0
fi

found=0
unverified=0
while read -r relay_script; do
    # The probe's own exit status is kept: a timeout, a Node error or a broken IPC channel
    # must not look like "no credential".
    answer=$(printf 'protocol=https\nhost=github.com\n\n' |
        timeout "$RELAY_TIMEOUT_SECONDS" node "$relay_script" git-credential-helper get 2>/dev/null)
    probe_status=$?
    if printf '%s\n' "$answer" | grep -q '^password='; then
        echo "DANGER: $relay_script returns a GitHub credential from the host"
        found=1
    elif [ "$probe_status" -eq 124 ]; then
        echo "UNVERIFIED: $relay_script did not answer within ${RELAY_TIMEOUT_SECONDS} s"
        unverified=1
    elif [ "$probe_status" -ne 0 ]; then
        echo "UNVERIFIED: $relay_script failed (exit status $probe_status), nothing could be checked"
        unverified=1
    fi
done <<< "$relay_scripts"
# The answer is discarded with the variable: nothing is written or printed.
unset answer

if [ "$found" -eq 1 ]; then
    echo "Remove the https://github.com entry from the host credential manager (docs/DEVCONTAINER_SECURITY.md)."
    exit 1
fi
if [ "$unverified" -eq 1 ]; then
    echo "Could not verify: run it again; if it persists, check the host setup by hand (docs/DEVCONTAINER_SECURITY.md)."
    exit 2
fi
echo "OK: no GitHub credential from the host (relay answered, without credential)"
