# Development sandbox for zabbix-cisco-intersight-by-api.
# Same tool versions as the GitHub CI (.github/workflows/tests.yml): Node 20 (devcontainer
# feature), Python 3.12 (Ubuntu 24.04 default) and PyYAML 6.0.3, so that a local run and the CI
# generate exactly the same template.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Tools needed by the outbound firewall (.devcontainer/intersight-init-firewall.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv iptables ipset iproute2 dnsutils jq aggregate curl \
 && rm -rf /var/lib/apt/lists/*

# PyYAML pinned like the CI, in a virtualenv first in PATH (nothing installed with pip at runtime).
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir pyyaml==6.0.3
ENV PATH=/opt/venv/bin:$PATH

# Firewall script. Its own name, so that the Claude Code devcontainer feature, which installs
# /usr/local/bin/init-firewall.sh, can never overwrite it.
COPY intersight-init-firewall.sh /usr/local/bin/intersight-init-firewall.sh
RUN chmod 0755 /usr/local/bin/intersight-init-firewall.sh

# The base image gives the "vscode" user unrestricted passwordless sudo. Keep only the firewall:
# otherwise anything running in the container (Claude Code included) could flush the rules.
RUN rm -f /etc/sudoers.d/vscode \
 && echo "vscode ALL=(root) NOPASSWD: /usr/local/bin/intersight-init-firewall.sh" > /etc/sudoers.d/intersight-firewall \
 && chmod 0440 /etc/sudoers.d/intersight-firewall
