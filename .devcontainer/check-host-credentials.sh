#!/bin/bash
# =====================================================================================
#  Checks, from inside the dev container, that the host gives no GitHub credential
#  through the Dev Containers relay (see README, "Identifiants git de ta machine").
#  Prints only whether a credential came back, never the credential itself.
#  Usage: bash .devcontainer/check-host-credentials.sh   (as "vscode", in the container)
# =====================================================================================
set -uo pipefail

relay_scripts=$(ls /tmp/vscode-remote-containers-*.js 2>/dev/null | grep -v -- '-server-' || true)
if [ -z "$relay_scripts" ]; then
    echo "OK: no Dev Containers relay script in /tmp"
    exit 0
fi
found=0
while read -r relay_script; do
    answer=$(printf 'protocol=https\nhost=github.com\n\n' |
        timeout 10 node "$relay_script" git-credential-helper get 2>/dev/null || true)
    if printf '%s\n' "$answer" | grep -q '^password='; then
        echo "DANGER: $relay_script returns a GitHub credential from the host"
        found=1
    fi
done <<< "$relay_scripts"
# The answer is discarded with the variable: nothing is written or printed.
unset answer
if [ "$found" -eq 1 ]; then
    echo "Remove the https://github.com entry from the host credential manager (README)."
    exit 1
fi
echo "OK: no GitHub credential from the host (relay present but empty)"
