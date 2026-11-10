#!/usr/bin/env bash
# Runs locally the same checks as the GitHub CI (.github/workflows/tests.yml), in the same order.
# Usage: tools/ci.sh   (from anywhere in the repository; needs node, python3 and PyYAML)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/4 Collector tests (ECDSA, auth modes, scenarios)"
node tests/run_all.js

echo "== 2/4 ES5 only (Zabbix embeds Duktape)"
if grep -nE '\blet |\bconst |=>|`' src/collector.js; then
    echo "ES2015+ syntax found in src/collector.js"; exit 1
fi

echo "== 3/4 Template is up to date with src/collector.js"
python3 tools/generate_templates.py
if ! git diff --exit-code --stat templates/; then
    echo "The generated template differs from the committed one: commit templates/ with your change."
    exit 1
fi

echo "== 4/4 Template structure"
python3 tools/validate_template.py

echo "All CI checks passed"
