#!/bin/bash
# =====================================================================================
#  Outbound firewall of the development container, run as root by the image ENTRYPOINT
#  (.devcontainer/intersight-entrypoint.sh) at every container start.
# =====================================================================================
#  Adapted from the reference dev container of Anthropic (anthropics/claude-code,
#  .devcontainer/init-firewall.sh). Differences, all on the side of safety:
#    - Fail-closed at two levels: the DROP policies (IPv4 and IPv6) are set FIRST, before
#      anything is flushed, and any error ends the ENTRYPOINT, hence the container.
#    - No sudo in the container: "vscode" (and Claude Code) cannot run or change this
#      script. It takes no argument; the optional Intersight appliance is read from the
#      environment of the container's PID 1, set at creation from devcontainer.json
#      "containerEnv".
#    - IPv6 is filtered too (ip6tables, loopback only): iptables alone covers IPv4. Without
#      a usable ip6tables, IPv6 must be disabled in the container, otherwise the script stops.
#    - No exception for the host or the default gateway: Docker publishes the ports of other
#      containers on the gateway address too. VS Code reaches the container through
#      "docker exec", not through the network.
#    - DNS (port 53, UDP and TCP) only towards the resolvers of /etc/resolv.conf, not to any host.
#    - No "outbound SSH to any host" rule: GitHub stays reachable (SSH included) through
#      its published IP ranges.
#    - Only what this project needs: Claude Code (API and sign-in) and GitHub. No VS Code
#      host (server and extensions come from the host), no npm (the project has no npm dependency), no telemetry endpoints
#      (disabled by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC in devcontainer.json).
#      Claude Code hosts: "Network access requirements" in
#      https://code.claude.com/docs/en/network-config
#    - Appliance (INTERSIGHT_APPLIANCE_HOST): HTTPS only, and a resolution failure is a
#      warning, not a container start failure.
#
#  The unit tests never need the network: every Intersight / Zabbix call is mocked.
#  tests/firewall_script.test.js runs this script with stub commands.
#  Usage: /usr/local/bin/intersight-init-firewall.sh   (as root, no argument)
# =====================================================================================
set -euo pipefail
IFS=$'\n\t'
# Commands only from system directories, which "vscode" cannot write (see the entrypoint).
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# Environment of the container's first process, and the kernel IPv6 settings per interface.
CONTAINER_ENVIRON=/proc/1/environ
IPV6_CONF_DIR=/proc/sys/net/ipv6/conf
# DNS resolvers of the container (written by Docker, read-only for "vscode").
RESOLV_CONF=/etc/resolv.conf

ALLOWED_DOMAINS=(
    "api.anthropic.com"               # Claude Code: API requests
    "platform.claude.com"             # Claude Code: OAuth token exchange, refresh, revocation
    "claude.ai"                       # Claude Code: claude.ai account authentication
)
# No VS Code host: the dev container CLI copies the VS Code server from the host, and VS Code
# downloads the extensions on the host when the container cannot reach the Marketplace
# ("downloadExtensionsLocally" in the Dev Containers log), so allowing these shared CDN
# front ends would only widen the egress.

if [ "$#" -ne 0 ]; then
    echo "ERROR: this script takes no argument (the appliance comes from the container environment)"
    exit 1
fi

# IPv4 addresses of a domain, one per line; empty when it does not resolve (a dig failure
# must not stop the script by itself: callers decide whether an empty answer is fatal).
resolve_ipv4() {
    # Bounded: 2 tries of 2 s (dig defaults: 3 tries of 5 s), see the entrypoint time limit.
    dig +noall +answer +time=2 +tries=2 A "$1" | awk '$4 == "A" {print $5}' || true
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
        # Explicit exit: callers use "allow_domain ... || ...", where set -e is off.
        ipset add -exist allowed-domains "$ip" || { echo "ERROR: cannot add $ip ($domain) to the allow-list"; exit 1; }
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
elif [ ! -d "$IPV6_CONF_DIR" ]; then
    echo "IPv6 absent from the kernel"
else
    # Without ip6tables, every interface must have IPv6 disabled: even without a default
    # route, link-local addresses (fe80::) stay reachable. conf/all/disable_ipv6 proves
    # nothing when read ("Reading this value does not have any particular meaning", kernel
    # ip-sysctl doc), so check "default" (future interfaces) and each interface. The
    # loopback is skipped: its traffic never leaves the container. Unreadable = enabled.
    ipv6_enabled_on=""
    for ipv6_flag in "$IPV6_CONF_DIR"/*/disable_ipv6; do
        interface=$(basename "$(dirname "$ipv6_flag")")
        case "$interface" in all|lo) continue ;; esac
        flag_value=$(cat "$ipv6_flag" 2>/dev/null || echo unreadable)
        [ "$flag_value" = "1" ] || ipv6_enabled_on="$ipv6_enabled_on $interface"
    done
    if [ -n "$ipv6_enabled_on" ]; then
        echo "ERROR: ip6tables is unusable while IPv6 is enabled on:$ipv6_enabled_on (IPv6 would bypass the firewall)"
        exit 1
    fi
    echo "IPv6 disabled on every interface"
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

# DNS only towards the container's resolvers (written by Docker), not to any host: an open
# port 53 would carry any data to any server. Docker's internal DNS (127.0.0.11) is on
# the loopback, already allowed. IPv6 resolvers are ignored (IPv6 is blocked above).
dns_servers=$(awk '$1 == "nameserver" {print $2}' "$RESOLV_CONF" || true)
dns_rule_count=0
while read -r dns_server; do
    if is_ipv4 "$dns_server"; then
        iptables -A OUTPUT -p udp -d "$dns_server" --dport 53 -j ACCEPT
        # TCP too, towards the same resolver: answers too large for UDP are retried over TCP
        # (RFC 7766: DNS over TCP is required of every implementation).
        iptables -A OUTPUT -p tcp -d "$dns_server" --dport 53 -j ACCEPT
        dns_rule_count=$((dns_rule_count + 1))
    fi
done <<< "$dns_servers"
if [ "$dns_rule_count" -eq 0 ]; then
    echo "ERROR: no IPv4 nameserver in $RESOLV_CONF"; exit 1
fi

# --- 3. Allow-list, filled while everything else is already blocked
ipset create allowed-domains hash:net
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

# GitHub: published ranges (web, api, git). api.github.com is allowed first to fetch them.
allow_domain "api.github.com" || { echo "ERROR: cannot resolve api.github.com"; exit 1; }
github_meta=$(curl -s --connect-timeout 5 --max-time 10 https://api.github.com/meta || true)
if ! echo "$github_meta" | jq -e '.web and .api and .git' >/dev/null; then
    echo "ERROR: unexpected answer from https://api.github.com/meta"; exit 1
fi
# Computed in a variable, not in "< <(...)": the exit status of a process substitution is
# ignored, so a failing jq or aggregate would leave an empty list without stopping the script.
github_cidrs=$(echo "$github_meta" | jq -r '(.web + .api + .git)[]' | grep -v ':' | aggregate -q)
if [ -z "$github_cidrs" ]; then
    echo "ERROR: no IPv4 range in https://api.github.com/meta"; exit 1
fi
while read -r cidr; do
    if [[ ! "$cidr" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/[0-9]{1,2}$ ]]; then
        echo "ERROR: invalid CIDR from GitHub meta: $cidr"; exit 1
    fi
    ipset add -exist allowed-domains "$cidr"
done <<< "$github_cidrs"
echo "Allowed GitHub ranges"

for domain in "${ALLOWED_DOMAINS[@]}"; do
    allow_domain "$domain" || { echo "ERROR: cannot resolve $domain"; exit 1; }
done

# Intersight appliance (optional): HTTPS only.
if [ -n "$APPLIANCE_HOST" ]; then
    # First character alphanumeric: a value starting with "-" would be read by dig as an option.
    if [[ ! "$APPLIANCE_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
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
if curl -s --connect-timeout 5 --max-time 5 https://example.com >/dev/null 2>&1; then
    echo "ERROR: firewall check failed: https://example.com is reachable"; exit 1
fi
if ! curl -s --connect-timeout 5 --max-time 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "ERROR: firewall check failed: https://api.github.com is not reachable"; exit 1
fi
echo "Firewall ready: example.com blocked, GitHub reachable"
