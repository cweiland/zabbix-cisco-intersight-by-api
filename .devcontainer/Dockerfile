# Development sandbox for zabbix-cisco-intersight-by-api.
# Same tool versions as the GitHub CI (.github/workflows/tests.yml): Node 20 (devcontainer
# feature), Python 3.12 (Ubuntu 24.04 default) and PyYAML 6.0.4, so that a local run and the CI
# generate exactly the same template.
# Base image pinned by digest (the tag is kept for readability; Docker uses the digest): a
# re-tagged or substituted image cannot enter the build. Digest of the image the maintainer built and
# validated (docker inspect, RepoDigests). To update: pull the tag, check, replace the digest.
FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae

# Tools needed by the outbound firewall (.devcontainer/intersight-init-firewall.sh).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv iptables ipset iproute2 dnsutils jq aggregate curl \
 && rm -rf /var/lib/apt/lists/*

# PyYAML pinned like the CI, with its PyPI hashes, in a virtualenv first in PATH (nothing
# installed with pip at runtime).
COPY requirements-dev.txt /tmp/requirements-dev.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements-dev.txt \
 && rm /tmp/requirements-dev.txt
ENV PATH=/opt/venv/bin:$PATH

# Firewall script and the ENTRYPOINT that runs it, as root, at every container start.
# Own names, so that the Claude Code devcontainer feature, which installs
# /usr/local/bin/init-firewall.sh, can never overwrite them.
COPY intersight-init-firewall.sh /usr/local/bin/intersight-init-firewall.sh
COPY intersight-entrypoint.sh /usr/local/bin/intersight-entrypoint.sh
COPY intersight-wait-for-firewall.sh /usr/local/bin/intersight-wait-for-firewall.sh
RUN chmod 0755 /usr/local/bin/intersight-init-firewall.sh /usr/local/bin/intersight-entrypoint.sh \
      /usr/local/bin/intersight-wait-for-firewall.sh

# The base image gives the "vscode" user unrestricted passwordless sudo. Remove it: the
# firewall runs from the ENTRYPOINT as root, so nothing running as "vscode" (Claude Code
# included) needs root, and nothing can change the firewall rules.
RUN rm -f /etc/sudoers.d/vscode

# Read-only git commands in the container (git status, git diff, git log): the workspace belongs
# to the host user, not to "vscode", so git refuses it ("detected dubious ownership"). The Dev
# Containers extension adds this entry itself at some starts, not all (maintainer's logs of 2026-11-20
# and 2026-11-24). Only this folder is trusted, not "*": its .git belongs to the host user and is
# mounted read-only. Mount point: /workspaces/<local folder name> (seen in the maintainer's logs).
ARG WORKSPACE_FOLDER_NAME
RUN test -n "$WORKSPACE_FOLDER_NAME" \
 && git config --system --add safe.directory "/workspaces/$WORKSPACE_FOLDER_NAME"

# Mount point of the Claude Code volume (devcontainer.json "mounts"), owned by "vscode" as in
# Anthropic's reference Dockerfile: a new, empty named volume takes the ownership of the image
# directory it is mounted on, so without it the volume would belong to root.
RUN mkdir -p /home/vscode/.claude && chown vscode:vscode /home/vscode/.claude

# Firewall first, then keep the container running. devcontainer.json sets
# "overrideCommand": false so that these run (a failing firewall ends the container).
ENTRYPOINT ["/usr/local/bin/intersight-entrypoint.sh"]
CMD ["sleep", "infinity"]
