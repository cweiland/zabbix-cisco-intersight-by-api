#!/bin/bash
# =====================================================================================
#  Outbound firewall of the development container (run at start by devcontainer.json).
# =====================================================================================
#  Adapted from the reference dev container of Anthropic (anthropics/claude-code,
#  .devcontainer/init-firewall.sh). Differences, all on the side of safety:
#    - Fail-closed: the DROP policies (IPv4 and IPv6) are set FIRST, before anything is
#      flushed. A failure at any later step leaves the container blocked, never open.
#    - No caller-chosen destination: "vscode" may run this script through sudo, so it takes
#      no argument (the sudoers rule forbids them too). The optional Intersight appliance is
#      read from the environment of the container's PID 1, set at creation from
#      devcontainer.json "containerEnv" and not writable by "vscode".
#    - IPv6 is filtered too (ip6tables, loopback only): iptables alone covers IPv4. Without
#      a usable ip6tables, IPv6 must be disabled in the container, otherwise the script stops.
#    - Host exception limited to the default gateway itself, not its /24 (which also holds
#      other containers).
#    - No "outbound SSH to any host" rule: GitHub stays reachable (SSH included) through
#      its published IP ranges.
#    - Only what this project needs: Claude Code (API and sign-in), GitHub, VS Code
#      extensions. No npm (the project has no npm dependency), no telemetry endpoints
#      (disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in devcontainer.json).
#      Claude Code hosts: "Network access requirements" in
#      https://code.claude.com/docs/en/network-config
#    - Appliance (INTERSIGHT_APPLIANCE_HOST): HTTPS only, and a resolution failure is a
#      warning, not a container start failure.
#
#  The unit tests never need the network: every Intersight / Zabbix call is mocked.
#  tests/firewall_script.test.js runs this script with stub commands.
#  Usage: sudo /usr/local/bin/intersight-init-firewall.sh   (no argument)
# =====================================================================================
set -euo pipefail
IFS=$'\n\t'

# Environment of the container's first process, and the kernel switch for IPv6.
CONTAINER_ENVIRON=/proc/1/environ
IPV6_DISABLED_FLAG=/proc/sys/net/ipv6/conf/all/disable_ipv6

ALLOWED_DOMAINS=(
    "api.anthropic.com"               # Claude Code: API requests
    "platform.claude.com"             # Claude Code: OAuth token exchange, refresh, revocation
    "claude.ai"                       # Claude Code: claude.ai account authentication
    "marketplace.visualstudio.com"    # VS Code extensions
    "vscode.blob.core.windows.net"
    "update.code.visualstudio.com"
)

if [ "$#" -ne 0 ]; then
    echo "ERROR: this script takes no argument (the appliance comes from the container environment)"
    exit 1
fi

# IPv4 addresses of a domain, one per line; empty when it does not resolve (a dig failure
# must not stop the script by itself: callers decide whether an empty answer is fatal).
resolve_ipv4() {
    dig +noall +answer A "$1" | awk '$4 == "A" {print $5}' || true
}

is_ipv4() {
    [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]
}

# Adds the IPv4 addresses of a domain to the allow-list. Returns 1 if it does not resolve.
allow_domain() {
    local domain="$1" ips ip
    ips=$(resolve_ipv4 "$domain")
    [ -n "$ips" ] || return 1
    while read -r ip; do
        if ! is_ipv4 "$ip"; then
            echo "ERROR: invalid IP from DNS for $domain: $ip"; exit 1
        fi
        ipset add -exist allowed-domains "$ip"
    done <<< "$ips"
    echo "Allowed $domain"
}

# --- 1. Close first (fail-closed): policies before any flush
DOCKER_DNS_RULES=$(iptables-save -t nat | grep "127\.0\.0\.11" || true)
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -P OUTPUT DROP

# IPv6: same closing, loopback only. If ip6tables cannot be used, IPv6 must be disabled,
# otherwise IPv6 traffic would bypass the IPv4 rules: stop.
if ip6tables -P OUTPUT DROP 2>/dev/null; then
    ip6tables -P INPUT DROP
    ip6tables -P FORWARD DROP
    ip6tables -F
    ip6tables -X
    ip6tables -A INPUT -i lo -j ACCEPT
    ip6tables -A OUTPUT -o lo -j ACCEPT
    echo "IPv6 blocked (loopback only)"
elif [ "$(cat "$IPV6_DISABLED_FLAG" 2>/dev/null || echo 1)" = "1" ]; then
    # Flag set to 1, or absent (kernel without IPv6): no IPv6 traffic at all.
    echo "IPv6 disabled in the container"
else
    # IPv6 enabled: even without a default route, link-local addresses (fe80::) and other
    # directly connected networks stay reachable, so unfiltered IPv6 is never acceptable.
    echo "ERROR: ip6tables is unusable while IPv6 is enabled: IPv6 would bypass the firewall"
    exit 1
fi

# Appliance from the container environment (empty when INTERSIGHT_APPLIANCE_HOST is not set).
APPLIANCE_HOST=$(sed -z -n 's/^INTERSIGHT_APPLIANCE_HOST=//p' "$CONTAINER_ENVIRON" | tr -d '\0')

# --- 2. Reset the IPv4 rules (policies stay DROP), keep Docker's internal DNS (127.0.0.11)
iptables -F; iptables -X
iptables -t nat -F; iptables -t nat -X
iptables -t mangle -F; iptables -t mangle -X
ipset destroy allowed-domains 2>/dev/null || true
if [ -n "$DOCKER_DNS_RULES" ]; then
    iptables -t nat -N DOCKER_OUTPUT 2>/dev/null || true
    iptables -t nat -N DOCKER_POSTROUTING 2>/dev/null || true
    echo "$DOCKER_DNS_RULES" | xargs -L 1 iptables -t nat
fi

iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT

# Default gateway only (Docker / VS Code plumbing), not the rest of its subnet.
HOST_IP=$(ip route | awk '/^default/ {print $3; exit}')
if ! is_ipv4 "$HOST_IP"; then echo "ERROR: cannot detect the default gateway"; exit 1; fi
iptables -A INPUT -s "$HOST_IP" -j ACCEPT
iptables -A OUTPUT -d "$HOST_IP" -j ACCEPT

# --- 3. Allow-list, filled while everything else is already blocked
ipset create allowed-domains hash:net
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# GitHub: published ranges (web, api, git). api.github.com is allowed first to fetch them.
allow_domain "api.github.com" || { echo "ERROR: cannot resolve api.github.com"; exit 1; }
github_meta=$(curl -s --connect-timeout 10 https://api.github.com/meta || true)
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
    elif is_ipv4 "$APPLIANCE_HOST"; then
        iptables -I OUTPUT -p tcp -d "$APPLIANCE_HOST" --dport 443 -j ACCEPT
        echo "Allowed Intersight appliance $APPLIANCE_HOST (HTTPS)"
    else
        appliance_ips=$(resolve_ipv4 "$APPLIANCE_HOST")
        if [ -z "$appliance_ips" ]; then
            echo "WARNING: $APPLIANCE_HOST does not resolve: the appliance stays unreachable"
        else
            while read -r ip; do
                if ! is_ipv4 "$ip"; then
                    echo "ERROR: invalid IP from DNS for $APPLIANCE_HOST: $ip"; exit 1
                fi
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
