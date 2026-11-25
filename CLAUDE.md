# Project context for Claude Code

Zabbix templates that monitor Cisco Intersight: servers, chassis, Fabric Interconnects.
This project was designed in a claude.ai conversation. This file carries over its
decisions, verified facts and open points. Read it before changing anything.

## Working rules (user requirements, apply to every answer and change)

- **Only justified, verified answers: no inference, no assumption.** Back every claim with a source (official doc, code, test, log, command output) and say plainly when something is not verified. Show the reasoning first, then the answer.
- **Check every change for security problems and personal data before handing it over** (code, docs, commit messages): secrets, keys, tokens, signed URLs, the user's name, e-mail, machine name, host paths and logs. The repository is public.
- Answer the user in French; code and code comments in English (see below).
- Git is read-only in the dev container: propose the change, the user reviews, commits and pushes from the host (see "Change workflow").
- **Agent-facing files**: any file written for an agent or loaded by one. At least: `CLAUDE.md`, `.claude/` (settings, rules, skills, commands, agents), `CLAUDE.local.md`, `.mcp.json` (project MCP servers, Claude Code doc "Project scope"); `AGENTS.md`, `GEMINI.md`; `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`; `.vscode/`, `.devcontainer/`. Also any file imported (`@path` in a CLAUDE.md), linked or named as required reading by one of them.
- **Keep the shared rules in sync**: when a rule in "Working rules" or "Change workflow" of this file changes, update `.github/copilot-instructions.md` in the same change, and the other way round.
- **Reviews**: when reviewing a PR or a diff that touches an agent-facing file, compare the shared rules of `CLAUDE.md` and `.github/copilot-instructions.md` and report any difference, and any new agent-facing file, import or link. Do not fix it yourself: propose the fix.
- **Human review**: Copilot code review reads the instructions from the PR's head branch, not from `main` (GitHub doc "Add repository instructions"). Any PR that touches an agent-facing file must be reviewed by the user, not only by an assistant.

## Change workflow (no patch, no mbox)

The workspace is shared with the host: every edit you make is already in the user's working tree on Windows. A patch or mbox on top of it conflicts with those same edits (the user had to stash or revert), so:

1. Before editing, check that the working tree is clean (`git status`); if not, ask the user.
2. Edit the files; run `tools/ci.sh` (it asks for approval).
3. Write the commit message to `.commit-msg.txt` at the repository root (git-ignored; English subject line under 72 characters, blank line, body, then the `Co-Authored-By` trailer). Check it for security problems and personal data like any change.
4. Give the user a branch name and these commands to run on the host, from `main` up to date:
   `git switch -c <branch>` / `git status` and `git diff` (review) / `git add -A` / `git commit -F .commit-msg.txt` / `git push -u origin <branch>`, then the pull request on GitHub.
5. One change at a time: wait until the user has committed before starting the next one.

If an edit reports an error (for example `ENOENT`), check `git diff` before retrying: on this mount the write may have succeeded anyway, and a retry could apply it twice. Run `tools/ci.sh` only once all edits are done, never in parallel with them.

Never ask for `.git` to become writable or to commit from the container: a writable `.git` (`commondir`, hooks, config) lets the container run commands through git on the host.

## User environment (hard constraints)

- **Zabbix 7.0.x LTS** is the target. 7.4 is supported only through the manual steps in `docs/UPGRADE_7.4_FR.md`.
- **Intersight Virtual Appliance** (on-prem), not SaaS.
- **Authentication: API key v3, `hs2019`, EC P-256 key only.** The user has no other option: OAuth and RSA keys are unavailable to them. The `rsa` and `oauth` modes exist but are secondary.
- The user writes in French and English. User-facing docs (README, CHANGELOG, docs/) are **in French**. Code and code comments are **in English**, with **explicit names and comments**, as requested by the user after a first version that was hard to maintain.

## Workflow

```bash
node tests/run_all.js                # must pass; exit code 1 on any failure
python3 tools/generate_templates.py  # after ANY change to src/collector.js
python3 tools/check_metrics_against_doc.py <Supported_Metrices.md>
```

- `templates/*.yaml` is **generated**: never edit it by hand. CI fails if it is out of sync with `src/collector.js`.
- **Zabbix limits item scripts to 65,535 characters.** The template embeds a comment-stripped copy of `src/collector.js` (`strip_comments()` in the generator; about 56k characters). Keep comments in the source. The generator, `tools/validate_template.py` and `tests/embedded_script.test.js` all fail if the limit is exceeded.
- UUIDs are derived from names (stable across regenerations). Renaming an item key changes its UUID.
- `src/collector.js` must stay **ES5** (Duktape). No `let`, `const`, arrow functions or template strings. CI checks this.
- The **JSON contract** between the collector and the templates is documented at the top of `src/collector.js`. Renaming a field requires changing the matching JSONPath in `tools/generate_templates.py`.

## Development environment

- `.devcontainer/` is the sandbox the user works in (VS Code + Claude Code). Same tool versions as the CI: Node 20, Python 3.12, PyYAML 6.0.4 (version and hashes in `.devcontainer/requirements-dev.txt`).
- Outbound firewall `.devcontainer/intersight-init-firewall.sh`, run as root by the image ENTRYPOINT (`.devcontainer/intersight-entrypoint.sh`, `overrideCommand: false`) at every start: if it fails, the container ends (a failed postStartCommand would not stop it). Fail-closed (DROP policies set before any flush), IPv4 and IPv6 (no ip6tables -> IPv6 must be disabled on "default" and every interface but lo, else the script stops; reading conf/all proves nothing per the kernel doc): only api.anthropic.com, platform.claude.com and claude.ai (Claude Code API and sign-in, per code.claude.com/docs/en/network-config), and GitHub ranges (all of GitHub, not only this repository). No VS Code host: the CLI copies the VS Code server from the host and extensions are downloaded on the host (`downloadExtensionsLocally`; the Marketplace query from the container failed in the user's log and installs still worked). No host or gateway exception (Docker publishes other containers' ports on the gateway address; VS Code uses docker exec). Addresses are resolved once at start (no root process stays to refresh them): restart after a CDN change. DNS (port 53, UDP and TCP per RFC 7766) only towards the IPv4 nameservers of `/etc/resolv.conf` (known limit: DNS tunnelling through the resolver stays possible). The Intersight appliance is reachable (HTTPS) only if `INTERSIGHT_APPLIANCE_HOST` is set when the container is created; the script reads it from PID 1's environment, never from its caller. Expect any other network access to fail; the tests never need the network.
- Zabbix documentation: zabbix.com is not reachable from the container. The user may keep the official 7.0 manual as `docs/Zabbix_Documentation_7.0.en.pdf` (git-ignored, about 50 MB). The Read tool cannot render it (no poppler); extract a page's text with a throwaway script run outside the repository with `python3 -I`. Fallback pointed to by the user: github.com/penmasters/zabbix-book (community book, not the official manual: say which source was used).
- The dev container CLI does not wait for the ENTRYPOINT before its `docker exec` commands (seen in the user's log: first exec about 1.2 s after start, while the firewall was running under DROP policies). So the entrypoint writes `/run/intersight-firewall.ready` (root, PID 1 start time) after a successful firewall, and `postStartCommand` starts with `intersight-wait-for-firewall.sh`, which only accepts that marker for the current start. VS Code connects after postStartCommand (`waitFor`). The firewall run is bounded below that wait: `timeout --kill-after=5 45` in the entrypoint, `dig +time=2 +tries=2`, `curl --max-time` on every call; a stalled run ends the container. Keep limit + kill below the wait when changing either.
- Read-only bind mounts (devcontainer.json): `.devcontainer/`, the whole `.git/`, `.vscode/`. The host executes them (initializeCommand, git hooks/config for git on the host, VS Code tasks/settings when reopened locally), so nothing in the container may change them. Only `.git/config` + `.git/hooks` is not enough: a writable `.git/commondir` redirects git to another config and hooks (tested with git 2.43). **So git is read-only in the container: do not commit or push from it; the user reviews, commits and pushes on the host.** Change these files from the host. `.vscode/extensions.json` is versioned so that the folder exists.
- Host credentials: Dev Containers opens an IPC channel to the host (`REMOTE_CONTAINERS_IPC`) and drops a relay script (`/tmp/vscode-remote-containers-<id>.js`, `git-credential-helper get`) that queries the host's credential manager. **Tested in the user's container: with `"dev.containers.gitCredentialHelperConfigLocation": "none"` the git config entry is gone ("Git credential helper not enabled" in the log) but the script still returns the stored github.com username and password.** It cannot be closed from the repository. Required on the host: no `https://github.com` entry in the credential manager, pushes over SSH with a passphrase key and no SSH agent (Dev Containers forwards a running agent, Windows' included), and `git config --global credential.interactive false` on the host (GCM doc: never prompts, fails instead): after the github.com entry was deleted, a request from the container opened a GitHub sign-in window on the user's host, which would have sent a fresh token back. Host setup guide for other users: `docs/DEVCONTAINER_SECURITE_FR.md` (keep it in sync). `.devcontainer/check-host-credentials.sh` checks it from inside the container without printing any secret (exit 0 none, 1 credential, 2 could not verify: a timeout or relay error is never reported as OK; `tests/check_host_credentials.test.js`); only the user runs it. To list host helpers, use `git config --get-regexp '^credential\..*helper$'` (gh writes URL-specific keys). Never call the relay or that script yourself.
- Supply chain: base image pinned by digest; PyYAML installed with `--require-hashes` from `.devcontainer/requirements-dev.txt` (also in the CI). `--security-opt=no-new-privileges` in runArgs.
- `CLAUDE_CONFIG_DIR=/home/vscode/.claude` (volume), as in Anthropic's reference devcontainer: keeps `.claude.json` across rebuilds.
- No `sudo` in the container (the base image's rule is removed): nothing can be installed at runtime and the firewall cannot be changed. The entrypoint and the firewall set `PATH=/usr/sbin:/usr/bin:/sbin:/bin`: the container PATH starts with `/usr/local/share/nvm/current/bin` (devcontainers Node feature, group `nvm`, which `vscode` belongs to), and root must never run a command from a directory `vscode` can write. Add tools to the `Dockerfile` instead; restart the container to re-apply the firewall.
- `tests/firewall_script.test.js` runs the firewall with stub commands (order of rules, arguments refused, IPv6 per interface, no gateway exception, read-only host-executed files, CLAUDE_CONFIG_DIR, DNS resolvers only, DNS, ipset and GitHub range failures, appliance names that look like options) and the entrypoint (a failing firewall stops it before the CMD; fake commands in a writable PATH directory never run; readiness marker written only after the firewall, stale or foreign markers rejected by the wait script). It came from the Copilot reviews of PR #1; keep it passing when changing the script. Linux only: skipped on other platforms.
- CI runner pinned to `ubuntu-24.04` like the dev container (ubuntu-latest was moving to 26.04; on it the stalled-firewall test failed because its `timeout` did not kill a grandchild). Tests must not depend on timeout signalling a process group: in the container, PID 1 exiting kills everything anyway.
- CI and supply chain (`tests/repository_config.test.js`): every GitHub Action pinned by full commit SHA with the release in a comment (`# v7.0.1`), `permissions: contents: read`, `persist-credentials: false`, Dependabot for github-actions, devcontainers, docker and pip. When adding an action, look up its SHA (`/repos/<owner>/<action>/commits/<tag>`), never use a tag alone.
- Run `tools/ci.sh` before every commit: same steps as the GitHub CI. Step 3 compares `templates/` before and after generation (not with the git index), so a regenerated but unstaged template passes.
- Never commit `params.json` (zabbix_js parameters, contains the private key) or `cisco-docs/` (Cisco pages used to rebuild the catalog).

## Rule: no inferred metric names (user requirement)

- The user explicitly asked: **do not infer**. Every Druid field must exist in `docs/intersight_metrics.json`, the catalog extracted from the Intersight "Supported Metrics" pages (`tools/build_metrics_catalog.py <folder of pages>`). `tests/documented_fields.test.js` fails on any other field or dataSource. The pages themselves (Cisco content) are not committed; the user provided them as Markdown.
- History: an earlier version used fields guessed from naming patterns; the user caught it. Fields were then restricted to the DevNet pages, and later restored once the newer pages (uploaded by the user) documented them.
- Computations must also be documented or follow from documented definitions (average = Sum / Count, shown in Cisco's Metrics Explorer example). Network throughput uses the formula of the intersight-grafana dashboards (github.com/3191110276/intersight-grafana, community repo, "best-effort", pointed to by the user): bits/s = sum(io_receive) / sum(io_receive_duration) * 8; link speed = longLast(bandwidth.limit) * 8 (documented in bytes/s). Label it as coming from those dashboards, not from Cisco docs.
- Support lists matter: a device outside a metric's "Support information" returns no row. `hw.cpu`, `hw.temperature.limit_high_degraded` and `hw.fan.speed.limit_low_critical` are only listed for `*-mqtt` device types (`imm-blade-mqtt`, `imm-ism-rack-mqtt`, `imm-chassis-mqtt-*`). The pages do not define "-mqtt": do not guess, check on the user's appliance which items fill.
- Default configuration targets the **Advantage** license (user requirement): 1-minute collection, 10-minute telemetry window. Essentials: 10-minute collection, window 30.

## Telemetry query shape (from the intersight-grafana dashboards)

- Dotted attributes are grouped through `nested-field` virtual columns (`host.name` -> `host_name`, path `$`); plain attributes (`name`) directly; filters use dotted names directly (`instrument.name`). `buildGroupBySpec()` in the collector does this for any dotted attribute.
- **Not yet validated on the user's appliance, and critical**: if every telemetry item stays empty while inventory works, check this grouping first (run one query from the Metrics Explorer Code tab and compare).
- Port role `hw.network.port.role` is grouped too; the template ignores roles `unconfigured|vethernet|vfc|vnic|vhba` by default, as the dashboards do.

## Units (checked at the user's request)

- **Verified by the user in the raw data of their appliance: utilizations are stored as 0-1 ratios** (0.1 = 10 %), although Cisco's doc gives the unit `%`. Consistent with the intersight-grafana dashboards (`* 100`, Grafana `percentunit`). One macro for all of them: `{$INTERSIGHT.PERCENT.SCALE}` = 100.
- Runtime checks (`checkPercentage()`, idle check) report wrong scales in "API: last errors"; `tests/units.test.js` covers them.
- **Base units only (user requirement): store W, Wh, g, s, bps, never kWh, kg or ms.** Grafana and external TSDBs read the stored value; Zabbix only adds K/M/G prefixes on display (Zabbix 7.0 manual, "Unit symbols", "Item value suffixes": base 10 except B and Bps, e.g. 1500 Wh shown as "1.5 KWh"). So no `/1000` or `*1000` to change scale in the collector or in calculated items; the only exceptions are per-kWh macros (cost, CO2: `Wh * macro / 1000`). Utilizations stay in % (0-100, user decision).
- Zabbix units: `!` prevents those display prefixes (the old %, ms, rpm stoplist is deprecated); use it only where a prefix makes no sense: `!rpm`, `!EUR`. Allowed units: `%`, `W`, `Wh`, `g`, `s`, `bps`, `°C`, `!rpm`, `!EUR`; `tests/units.test.js` rejects any other unit and any prefixed one.
- **A unit or scale change requires a new item key** (hence a new UUID and series). Same key = same history: old values would be read in the new unit, triggers over the last values would fire on them, and calculated items could read a last value still in the old unit (Copilot review of PR #13). Note the old -> new keys in the CHANGELOG and tell users to tick "Delete missing" for items on re-import, otherwise the old items are not removed (Zabbix 7.0 manual, "Import rules"). `tests/units.test.js` fails if the keys renamed for the base-units change come back.
- Network duration fields are taken as seconds (dashboard formula `bytes / duration * 8` labelled bps); not stated in Cisco's pages.

## Architecture (and why)

- **Parent host "Cisco Intersight by API"**: a single Script item (`intersight.collect`, every 5 min) makes ALL Intersight calls. It returns JSON for the LLD rules and pushes one JSON per device with `history.push`.
- **Discovered hosts** (`intersight-<Moid>`, via host prototypes) only receive data. Their trapper item `intersight.raw` feeds dependent items and dependent LLD (PSUs, ports).
- Why `history.push`: in Zabbix a dependent item cannot use a master item on another host. Calling the API from every discovered host would multiply API calls and signatures.
- Groups `Intersight/<Servers|Chassis|FI>/<model>` (group prototypes) drive the per-model aggregates (`last_foreach` with group filters; nested groups are included).

## Verified facts (with source)

- Zabbix `sign()` supports **RSA-SHA256 only**, hence ECDSA P-256 is implemented in pure JS (section 3 of `src/collector.js`, RFC 6979 deterministic nonce). Validated by the RFC 6979 A.2.5 vector and OpenSSL verification (`tests/ecdsa_p256.test.js`).
- hs2019 signing string order: `(request-target) host date digest`, signature DER then base64. Taken from a working third-party Intersight client, not from Cisco docs.
- Zabbix limits **HttpRequest objects** to 10 per script, so one object is reused for all Intersight calls.
- `history.push` exists since Zabbix 7.0. It accepts host + key. If "Allowed hosts" is set on a trapper item, it must include the frontend IP.
- **Nested LLD (discovery prototypes) only exists since Zabbix 7.4.**
- Telemetry dataSources (catalog): `hw.network` is in **NetworkInterfaces**; everything else is in **PhysicalEntities**. Queries go to `/api/v1/telemetry/TimeSeries` (DevNet "Telemetry APIs - Query Syntax").
- `host.name` is not unique (Cisco), so telemetry is matched on `host.type` + `host.name`.
- Support lists (catalog): `hw.host.power` is NOT reported for IMM chassis (their power = sum of PSU `hw.power`); ECC errors by blades and racks; `system.cpu` / `system.memory` by FIs; `hw.network.bandwidth.utilization_all` by blades, racks and FIs.
  - Intersight help "Data Collection": metrics exist for IMM, UMM (environmental only) and ISM (standalone) servers. Collection every minute (Advantage) or 10 min (Essentials, UMM). Blades need IOM UCS-IOM-2408 / UCSX-I-9108-25G / UCSX-I-9108-100G; IMM needs a valid license on every server; FIs need NTP.
  - Intersight help "Metrics Explorer": Average = Sum / count (documented example), and groupBy rows come under "event".
- Appliance telemetry requires a metrics node (2- or 4-node cluster; not 3-node) or the single-node opt-in.
- The appliance "Supported Metrics" summary doc (on-prem build 1.0.11-20261009…, checked by `tools/check_metrics_against_doc.py`) lists metric names and units but not dataSources, rollup fields or per-device support; the per-instrument pages (catalog) do. Cisco content: never commit either (`Supported_Metrices.md` is in `.gitignore`).

## Checked on the user's appliance (reported by the user, 2026-11-24)

- **Import into Zabbix 7.0: OK** (7.0-5 had failed with `Invalid parameter "/7/params": value is too long`, fixed in 7.0-6). Fix any future import error in the generator, not in the YAML.
- **ECDSA speed in Duktape:** item "API: signing time (hs2019)" stays below 20,000 ms per run (13 signatures), under the 90 s run-duration trigger and the 120 s item timeout. No optimisation needed for now; if it grows: fixed-base precomputation table for G, or fewer `TELEMETRY_QUERIES`.
- **hs2019 signing (EC P-256 mode) accepted by the appliance:** inventory is collected and "API: last errors" is empty. The signing string order is therefore right for this appliance (RSA and OAuth modes still untested).
- **Blade↔chassis matching by `RegisteredDevice.Moid:ChassisId` FAILS:** `blades` was empty in every chassis; the user compared `chassis_key` values: the `RegisteredDevice.Moid` part differs between a blade and its chassis. Fix (not yet checked on the appliance): match on `compute.PhysicalSummary.EquipmentChassis.Moid` == chassis `Moid` (field from the Intersight API schema, CiscoDevNet/intersight-python 1.0.11.x `compute_physical_summary_all_of.py`), old key only as fallback; `servers[].chassis_moid` shows the value read. Only affects the 7.4 nested mode (`flat_servers=0`); in 7.0 all servers are discovered anyway.

## NOT verified yet (first things to check on the real system)

- **Inventory fields** not confirmed on the appliance: FI `Version` and `OutOfBandIpAddress`, chassis `OperState`.
- **Response shapes**: list endpoints are assumed to return `{Results: [...]}` (the groupBy `[{event: {...}}]` shape is documented by the Metrics Explorer example).
- `hw.status` is deliberately not used: its "one series per state" semantics were unclear. Left pending (user decision, 2026-11-24).
- The OAuth mode has never run against a real Intersight.

## Repository

- `cweiland/zabbix-cisco-intersight-by-api` (public). The state of pull requests and CI is read on GitHub (merged PRs: `git log --oneline --merges origin/main`); it is not copied here.
- Ruleset on `main`: PR required, check `tests` required, no force push or deletion. CodeQL default setup, Dependabot, secret scanning and private vulnerability reporting are on.
- Dependabot PRs that touch `.devcontainer/` (features, base image, PyYAML): the CI does not build the image, so the user rebuilds the container from the PR branch before merging. Action updates are covered by the CI.
- LICENSE: AGPL-3.0-only (user decision, "like Zabbix": Zabbix headers say "version 3", no "or later"). `LICENSE` is the FSF text byte for byte (sha256 0d96a4ff...abcb0, same as gnu.org/licenses/agpl-3.0.txt and Zabbix's COPYING); never edit it.

## Open items

- Unreleased changes: `CHANGELOG.md` has a "Non publié" section (blade↔chassis fix) while the template version is still `7.0-6` (`tools/generate_templates.py`). Releasing it (version number) is the user's decision.
- Optional metrics not collected: GPU (`hw.gpu.*`), voltage, current, optical signal power, detailed packet counters.

## Testing conventions

- Tests mock `HttpRequest`, `sha256` and `sign`, then run `src/collector.js` through `new Function('value', ...)`, the same way Zabbix runs it.
- Mocked Intersight responses must follow the Cisco support matrices (e.g. no `hw.host` row for IMM chassis).
- Every request signature is verified cryptographically in the mocks.
- New behaviour gets a PASS/FAIL check that sets `process.exitCode = 1` on failure.

## Claude Code permissions (`.claude/settings.json`)

- Git is read-only for Claude (user decision): `git commit` and `git push` are denied. Claude edits files; the user reviews, commits and pushes from the host. In the dev container the whole `.git` is mounted read-only anyway (a writable `.git` lets the container run commands through git on the host). Read-only commands such as `git status`, `git diff` and `git log` need no rule.
- **Tests, `tools/ci.sh`, the generator and the validator are NOT pre-approved, on purpose** (user decision): they run scripts Claude can edit (`run_all.js` runs every `*.test.js`), so an allow rule would amount to running arbitrary code without asking. Expect a prompt each time; do not try to get around it.
- Do not work around the git rules (`git -C . commit`, `git -c ... push` and similar forms are not matched by the rules, but are just as off-limits).
- Reading `params.json`, `*.pem`, `*.key` and `.env*` is denied: they hold credentials. Do not read them by other means either (scripts, `node -e`, `python -c`).
- Personal approvals go to `.claude/settings.local.json`, which is git-ignored. Do not add "don't ask again" approvals for script-running commands there either.
