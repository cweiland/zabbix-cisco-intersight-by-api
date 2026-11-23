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
# Snapshot of templates/ before generation, compared with the result: does not depend on what
# is staged in git (a regenerated but unstaged template is consistent, so it passes).
templates_before=$(mktemp -d)
trap 'rm -rf "$templates_before"' EXIT
cp -a templates/. "$templates_before"/
python3 tools/generate_templates.py
if ! diff -r "$templates_before" templates >/dev/null; then
    diff -r --brief "$templates_before" templates || true
    echo "templates/ was out of date with src/collector.js and has just been regenerated: review and commit it."
    exit 1
fi

echo "== 4/4 Template structure"
python3 tools/validate_template.py

echo "All CI checks passed"
