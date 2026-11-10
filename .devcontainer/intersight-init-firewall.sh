#!/bin/bash
# =====================================================================================
#  Outbound firewall of the development container (run at start by devcontainer.json).
# =====================================================================================
#  Adapted from the reference dev container of Anthropic (anthropics/claude-code,
#  .devcontainer/init-firewall.sh). Differences, all on the side of safety:
#    - Fail-closed: the DROP policies are set FIRST and the allow-list is filled after.
#      In the reference they come last, so a failure midway (DNS, GitHub API down) left
#      the container with flushed rules, i.e. fully open.
#    - No "outbound SSH to any host" rule: GitHub stays reachable (SSH included) through
#      its published IP ranges.
#    - Only what this project needs: Anthropic API (Claude Code), GitHub, VS Code
#      extensions. No npm (the project has no npm dependency), no telemetry endpoints
#      (disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in devcontainer.json).
#    - Optional Intersight appliance (argument 1, from INTERSIGHT_APPLIANCE_HOST): HTTPS
#      only, and a resolution failure is a warning, not a container start failure.
#
#  The unit tests never need the network: every Intersight / Zabbix call is mocked.
#  Usage: intersight-init-firewall.sh [appliance-fqdn-or-ipv4]
# =====================================================================================
set -euo pipefail
IFS=$'\n\t'

APPLIANCE_HOST="${1:-}"
ALLOWED_DOMAINS=(
    "api.anthropic.com"               # Claude Code
    "marketplace.visualstudio.com"    # VS Code extensions
    "vscode.blob.core.windows.net"
    "update.code.visualstudio.com"
)

# Adds the IPv4 addresses of a domain to the allow-list. Returns 1 if it does not resolve.
allow_domain() {
    local domain="$1" ips ip
    ips=$(dig +noall +answer A "$domain" | awk '$4 == "A" {print $5}')
    [ -n "$ips" ] || return 1
    while read -r ip; do
        if [[ ! "$ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            echo "ERROR: invalid IP from DNS for $domain: $ip"; exit 1
        fi
        ipset add -exist allowed-domains "$ip"
    done <<< "$ips"
    echo "Allowed $domain"
}

# --- 1. Keep Docker's internal DNS (127.0.0.11) working, then reset everything
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)
iptables -F; iptables -X
iptables -t nat -F; iptables -t nat -X
iptables -t mangle -F; iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true
if [ -n "$DOCKER_DNS_RULES" ]; then
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

# --- 2. Close first (fail-closed): from here on, only explicit rules let traffic out
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT

# Host network (default gateway /24): needed by Docker / VS Code plumbing.
HOST_IP=$(ip route | awk '/^default/ {print $3; exit}')
if [ -z "$HOST_IP" ]; then echo "ERROR: cannot detect the host IP"; exit 1; fi
HOST_NETWORK=$(echo "$HOST_IP" | sed "s/\.[0-9]*$/.0\/24/")
iptables -A INPUT -s "$HOST_NETWORK" -j ACCEPT
iptables -A OUTPUT -d "$HOST_NETWORK" -j ACCEPT

# --- 3. Allow-list, filled while everything else is already blocked
ipset create allowed-domains hash:net
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# GitHub: published ranges (web, api, git). api.github.com is allowed first to fetch them.
allow_domain "api.github.com" || { echo "ERROR: cannot resolve api.github.com"; exit 1; }
github_meta=$(curl -s --connect-timeout 10 https://api.github.com/meta)
if ! echo "$github_meta" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: unexpected answer from https://api.github.com/meta"; exit 1
fi
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: invalid CIDR from GitHub meta: $cidr"; exit 1
    fi
    ipset add -exist allowed-domains "$cidr"
done < <(echo "$github_meta" | jq -r '(.web + .api + .git)[]' | grep -v ':' | aggregate -q)
echo "Allowed GitHub ranges"

for domain in "${ALLOWED_DOMAINS[@]}"; do
    allow_domain "$domain" || { echo "ERROR: cannot resolve $domain"; exit 1; }
done

# Intersight appliance (optional): HTTPS only.
if [ -n "$APPLIANCE_HOST" ]; then
    if [[ ! "$APPLIANCE_HOST" =~ ^[A-Za-z0-9.-]+$ ]]; then
        echo "WARNING: ignored invalid appliance host: $APPLIANCE_HOST"
    elif [[ "$APPLIANCE_HOST" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        iptables -I OUTPUT -p tcp -d "$APPLIANCE_HOST" --dport 443 -j ACCEPT
        echo "Allowed Intersight appliance $APPLIANCE_HOST (HTTPS)"
    else
        appliance_ips=$(dig +noall +answer A "$APPLIANCE_HOST" | awk '$4 == "A" {print $5}')
        if [ -z "$appliance_ips" ]; then
            echo "WARNING: $APPLIANCE_HOST does not resolve: the appliance stays unreachable"
        else
            while read -r ip; do
                iptables -I OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
            done <<< "$appliance_ips"
            echo "Allowed Intersight appliance $APPLIANCE_HOST (HTTPS)"
        fi
    fi
fi

# Everything else: immediate rejection (clearer than a silent timeout).
iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited

# --- 4. Verification
if curl -s --connect-timeout 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: firewall check failed: https://example.com is reachable"; exit 1
fi
if ! curl -s --connect-timeout 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: firewall check failed: https://api.github.com is not reachable"; exit 1
fi
echo "Firewall ready: example.com blocked, GitHub reachable"
