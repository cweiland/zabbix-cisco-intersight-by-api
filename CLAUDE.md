# Project context for Claude Code

Zabbix templates that monitor Cisco Intersight: servers, chassis, Fabric Interconnects.
This project was designed in a claude.ai conversation. This file carries over its
decisions, verified facts and open points. Read it before changing anything.

## Working rules (maintainer requirements, apply to every answer and change)

- **Only justified, verified answers: no inference, no assumption.** Back every claim with a source (official doc, code, test, log, command output) and say plainly when something is not verified. Show the reasoning first, then the answer.
- **Check every change for security problems and personal data before handing it over** (code, docs, commit messages): secrets, keys, tokens, signed URLs, the maintainer's name, e-mail, machine name, host paths and logs. The repository is public.
- Answer the maintainer in French; code and code comments in English (see below).
- Git is read-only in the dev container: propose the change, the maintainer reviews, commits and pushes from the host (see "Change workflow").
- **Agent-facing files**: any file written for an agent or loaded by one. At least: `CLAUDE.md`, `.claude/` (settings, rules, skills, commands, agents), `CLAUDE.local.md`, `.mcp.json` (project MCP servers, Claude Code doc "Project scope"); `AGENTS.md`, `GEMINI.md`; `.github/copilot-instructions.md`, `.github/instructions/`, `.github/prompts/`; `.vscode/`, `.devcontainer/`. Also any file imported (`@path` in a CLAUDE.md), linked or named as required reading by one of them.
- **Keep the shared rules in sync**: when a rule in "Working rules" or "Change workflow" of this file changes, update `.github/copilot-instructions.md` in the same change, and the other way round.
- **Reviews**: when reviewing a PR or a diff that touches an agent-facing file, compare the shared rules of `CLAUDE.md` and `.github/copilot-instructions.md` and report any difference, and any new agent-facing file, import or link. Do not fix it yourself: propose the fix.
- **Human review**: Copilot code review reads the instructions from the PR's head branch, not from `main` (GitHub doc "Add repository instructions"). Any PR that touches an agent-facing file must be reviewed by the maintainer, not only by an assistant.

## Change workflow (no patch, no mbox)

The workspace is shared with the host: every edit you make is already in the maintainer's working tree on Windows. A patch or mbox on top of it conflicts with those same edits (the maintainer had to stash or revert), so:

1. Before editing, check that the working tree is clean (`git status`); if not, ask the maintainer.
2. Edit the files; run `tools/ci.sh` (it asks for approval).
3. Write the commit message to `.commit-msg.txt` at the repository root (git-ignored; English subject line under 72 characters, blank line, body, then the `Co-Authored-By` trailer). Check it for security problems and personal data like any change.
4. Give the maintainer a branch name and these commands to run on the host, from `main` up to date:
   `git switch -c <branch>` / `git status` and `git diff` (review) / `git add -A` / `git commit -F .commit-msg.txt` / `git push -u origin <branch>`, then the pull request on GitHub.
5. One change at a time: wait until the maintainer has committed before starting the next one.

If an edit reports an error (for example `ENOENT`), check `git diff` before retrying: on this mount the write may have succeeded anyway, and a retry could apply it twice. Run `tools/ci.sh` only once all edits are done, never in parallel with them.

Never ask for `.git` to become writable or to commit from the container: a writable `.git` (`commondir`, hooks, config) lets the container run commands through git on the host.

## Maintainer environment (hard constraints)

- **Zabbix 7.0.x LTS** is the target. 7.4 is supported only through the manual steps in `docs/UPGRADE_7.4_FR.md`.
- **Intersight Virtual Appliance** (on-prem), not SaaS.
- **Authentication: API key v3, `hs2019`, EC P-256 key only.** The maintainer has no other option: OAuth and RSA keys are unavailable to them. The `rsa` and `oauth` modes exist but are secondary.
- The maintainer writes in French and English. User-facing docs (README, CHANGELOG, docs/) are **in French**. Code and code comments are **in English**, with **explicit names and comments**, as requested by the maintainer after a first version that was hard to maintain.

## Workflow

```bash
node tests/run_all.js                # must pass; exit code 1 on any failure
python3 tools/generate_templates.py  # after ANY change to src/collector.js
python3 tools/check_metrics_against_doc.py <Supported_Metrices.md>
```

- `templates/*.yaml` is **generated**: never edit it by hand. CI fails if it is out of sync with `src/collector.js`.
- **Zabbix limits item scripts to 65,535 characters.** The template embeds a comment-stripped copy of `src/collector.js` (`strip_comments()` in the generator; 62,265 characters with the paging sorted by Moid (truncation reported), `is_blade` from `SourceObjectType` and `power_state` 2 for an unexpected `OperPowerState`, i.e. about 3,270 left: any new function must stay compact). Keep comments in the source. The generator, `tools/validate_template.py` and `tests/embedded_script.test.js` all fail if the limit is exceeded.
- UUIDs are derived from names (stable across regenerations). Renaming an item key changes its UUID.
- `src/collector.js` must stay **ES5** (Duktape). No `let`, `const`, arrow functions or template strings. CI checks this.
- The **JSON contract** between the collector and the templates is documented at the top of `src/collector.js`. Renaming a field requires changing the matching JSONPath in `tools/generate_templates.py`.

## Development environment

- `.devcontainer/` is the sandbox the maintainer works in (VS Code + Claude Code). Same tool versions as the CI: Node 20, Python 3.12, PyYAML 6.0.4 (version and hashes in `.devcontainer/requirements-dev.txt`).
- Outbound firewall `.devcontainer/intersight-init-firewall.sh`, run as root by the image ENTRYPOINT (`.devcontainer/intersight-entrypoint.sh`, `overrideCommand: false`) at every start: if it fails, the container ends (a failed postStartCommand would not stop it). Fail-closed (DROP policies set before any flush), IPv4 and IPv6 (no ip6tables -> IPv6 must be disabled on "default" and every interface but lo, else the script stops; reading conf/all proves nothing per the kernel doc): only api.anthropic.com, platform.claude.com and claude.ai (Claude Code API and sign-in, per code.claude.com/docs/en/network-config), and GitHub ranges (all of GitHub, not only this repository). No VS Code host: the CLI copies the VS Code server from the host and extensions are downloaded on the host (`downloadExtensionsLocally`; the Marketplace query from the container failed in the maintainer's log and installs still worked). No host or gateway exception (Docker publishes other containers' ports on the gateway address; VS Code uses docker exec). Addresses are resolved once at start (no root process stays to refresh them): restart after a CDN change. DNS (port 53, UDP and TCP per RFC 7766) only towards the IPv4 nameservers of `/etc/resolv.conf` (known limit: DNS tunnelling through the resolver stays possible). The Intersight appliance is reachable (HTTPS) only if `INTERSIGHT_APPLIANCE_HOST` is set when the container is created; the script reads it from PID 1's environment, never from its caller. Expect any other network access to fail; the tests never need the network.
- Zabbix documentation: zabbix.com is not reachable from the container. The maintainer may keep the official 7.0 manual as `docs/Zabbix_Documentation_7.0.en.pdf` (git-ignored, about 50 MB; never commit it, see "Never commit" below). The Read tool cannot render it (no poppler); extract a page's text with a throwaway script run outside the repository with `python3 -I`. Fallback pointed to by the maintainer: github.com/penmasters/zabbix-book (community book, not the official manual: say which source was used).
- The dev container CLI does not wait for the ENTRYPOINT before its `docker exec` commands (seen in the maintainer's log: first exec about 1.2 s after start, while the firewall was running under DROP policies). So the entrypoint writes `/run/intersight-firewall.ready` (root, PID 1 start time) after a successful firewall, and `postStartCommand` starts with `intersight-wait-for-firewall.sh`, which only accepts that marker for the current start. VS Code connects after postStartCommand (`waitFor`). The firewall run is bounded below that wait: `timeout --kill-after=5 45` in the entrypoint, `dig +time=2 +tries=2`, `curl --max-time` on every call; a stalled run ends the container. Keep limit + kill below the wait when changing either.
- Read-only bind mounts (devcontainer.json): `.devcontainer/`, the whole `.git/`, `.vscode/`. The host executes them (initializeCommand, git hooks/config for git on the host, VS Code tasks/settings when reopened locally), so nothing in the container may change them. Only `.git/config` + `.git/hooks` is not enough: a writable `.git/commondir` redirects git to another config and hooks (tested with git 2.43). **So git is read-only in the container: do not commit or push from it; the maintainer reviews, commits and pushes on the host.** Change these files from the host. `.vscode/extensions.json` is versioned so that the folder exists.
- Host credentials: Dev Containers opens an IPC channel to the host (`REMOTE_CONTAINERS_IPC`) and drops a relay script (`/tmp/vscode-remote-containers-<id>.js`, `git-credential-helper get`) that queries the host's credential manager. **Tested in the maintainer's container: with `"dev.containers.gitCredentialHelperConfigLocation": "none"` the git config entry is gone ("Git credential helper not enabled" in the log) but the script still returns the stored github.com username and password.** It cannot be closed from the repository. Required on the host: no `https://github.com` entry in the credential manager, pushes over SSH with a passphrase key and no SSH agent (Dev Containers forwards a running agent, Windows' included), and `git config --global credential.interactive false` on the host (GCM doc: never prompts, fails instead): after the github.com entry was deleted, a request from the container opened a GitHub sign-in window on the maintainer's host, which would have sent a fresh token back. Host setup guide for other users: `docs/DEVCONTAINER_SECURITE_FR.md` (keep it in sync). `.devcontainer/check-host-credentials.sh` checks it from inside the container without printing any secret (exit 0 none, 1 credential, 2 could not verify: a timeout or relay error is never reported as OK; `tests/check_host_credentials.test.js`); only the maintainer runs it. To list host helpers, use `git config --get-regexp '^credential\..*helper$'` (gh writes URL-specific keys). Never call the relay or that script yourself.
- Supply chain: base image pinned by digest; PyYAML installed with `--require-hashes` from `.devcontainer/requirements-dev.txt` (also in the CI). `--security-opt=no-new-privileges` in runArgs.
- `CLAUDE_CONFIG_DIR=/home/vscode/.claude` (volume), as in Anthropic's reference devcontainer: keeps `.claude.json` across rebuilds.
- No `sudo` in the container (the base image's rule is removed): nothing can be installed at runtime and the firewall cannot be changed. The entrypoint and the firewall set `PATH=/usr/sbin:/usr/bin:/sbin:/bin`: the container PATH starts with `/usr/local/share/nvm/current/bin` (devcontainers Node feature, group `nvm`, which `vscode` belongs to), and root must never run a command from a directory `vscode` can write. Add tools to the `Dockerfile` instead; restart the container to re-apply the firewall.
- `tests/firewall_script.test.js` runs the firewall with stub commands (order of rules, arguments refused, IPv6 per interface, no gateway exception, read-only host-executed files, CLAUDE_CONFIG_DIR, DNS resolvers only, DNS, ipset and GitHub range failures, appliance names that look like options) and the entrypoint (a failing firewall stops it before the CMD; fake commands in a writable PATH directory never run; readiness marker written only after the firewall, stale or foreign markers rejected by the wait script). It came from the Copilot reviews of PR #1; keep it passing when changing the script. Linux only: skipped on other platforms.
- CI runner pinned to `ubuntu-24.04` like the dev container (ubuntu-latest was moving to 26.04; on it the stalled-firewall test failed because its `timeout` did not kill a grandchild). Tests must not depend on timeout signalling a process group: in the container, PID 1 exiting kills everything anyway.
- CI and supply chain (`tests/repository_config.test.js`): every GitHub Action pinned by full commit SHA with the release in a comment (`# v7.0.1`), `permissions: contents: read`, `persist-credentials: false`, Dependabot for github-actions, devcontainers, docker and pip. When adding an action, look up its SHA (`/repos/<owner>/<action>/commits/<tag>`), never use a tag alone.
- Run `tools/ci.sh` before every commit: same steps as the GitHub CI. Step 3 compares `templates/` before and after generation (not with the git index), so a regenerated but unstaged template passes.
- Never commit `params.json` (zabbix_js parameters, contains the private key), `cisco-docs/` (Cisco pages used to rebuild the catalog) or `docs/Zabbix_Documentation_*.pdf` (Zabbix manual: its "Copyright notice", last page, forbids publishing or distributing it except as Zabbix does, on a Zabbix web site or with the software).

## Rule: no inferred metric names (maintainer requirement)

- The maintainer explicitly asked: **do not infer**. Every Druid field must exist in `docs/intersight_metrics.json`, the catalog extracted from the Intersight "Supported Metrics" pages (`tools/build_metrics_catalog.py <folder of pages>`). `tests/documented_fields.test.js` fails on any other field or dataSource. The pages themselves (Cisco content) are not committed; the maintainer provided them as Markdown.
- History: an earlier version used fields guessed from naming patterns; the maintainer caught it. Fields were then restricted to the DevNet pages, and later restored once the newer pages (uploaded by the maintainer) documented them.
- Computations must also be documented or follow from documented definitions (average = Sum / Count, shown in Cisco's Metrics Explorer example). Network throughput uses the formula of the intersight-grafana dashboards (github.com/3191110276/intersight-grafana, community repo, "best-effort", pointed to by the maintainer): bits/s = sum(io_receive) / sum(io_receive_duration) * 8; link speed = longLast(bandwidth.limit) * 8 (documented in bytes/s). Label it as coming from those dashboards, not from Cisco docs.
- Support lists matter: a device outside a metric's "Support information" returns no row. `hw.cpu`, `hw.temperature.limit_high_degraded` and `hw.fan.speed.limit_low_critical` are only listed for `*-mqtt` device types (`imm-blade-mqtt`, `imm-ism-rack-mqtt`, `imm-chassis-mqtt-*`). The pages do not define "-mqtt": do not guess, check on the design appliance which items fill.
- Default configuration targets the **Advantage** license (maintainer requirement): 1-minute collection, 10-minute telemetry window. Essentials: 10-minute collection, window 30.

## Telemetry query shape (from the intersight-grafana dashboards)

- Dotted attributes are grouped through `nested-field` virtual columns (`host.name` -> `host_name`, path `$`); plain attributes (`name`) directly; filters use dotted names directly (`instrument.name`). `buildGroupBySpec()` in the collector does this for any dotted attribute.
- **Not yet validated on the design appliance, and critical**: if every telemetry item stays empty while inventory works, check this grouping first (run one query from the Metrics Explorer Code tab and compare).
- Port role `hw.network.port.role` is grouped too; the template ignores roles `unconfigured|vethernet|vfc|vnic|vhba` by default, as the dashboards do.

## Units (checked at the maintainer's request)

- **Verified by the maintainer in the raw data of a design appliance: utilizations are stored as 0-1 ratios** (0.1 = 10 %), although Cisco's doc gives the unit `%`. Consistent with the intersight-grafana dashboards (`* 100`, Grafana `percentunit`). One macro for all of them: `{$INTERSIGHT.PERCENT.SCALE}` = 100.
- Runtime checks (`checkPercentage()`, idle check) report wrong scales in "API: last errors"; `tests/units.test.js` covers them.
- **Base units only (maintainer requirement): store W, Wh, g, s, bps, never kWh, kg or ms.** Grafana and external TSDBs read the stored value; Zabbix only adds K/M/G prefixes on display (Zabbix 7.0 manual, "Unit symbols", "Item value suffixes": base 10 except B and Bps, e.g. 1500 Wh shown as "1.5 KWh"). So: convert source values **to** the base unit (ms timings -> s: `/ 1000` for `duration_s`/`sign_s`; bytes -> bits: `* 8`; 0-1 ratios -> %: `{$INTERSIGHT.PERCENT.SCALE}`), never a base-unit value **to** a prefixed unit (W -> kW, Wh -> kWh, g -> kg), neither in the collector nor in calculated items. Per-kWh macros are applied to Wh with `/ 1000` (cost, CO2). Utilizations stay in % (0-100, maintainer decision).
- Zabbix units: `!` prevents those display prefixes (the old %, ms, rpm stoplist is deprecated); use it only where a prefix makes no sense: `!rpm`, `!EUR`. Allowed units: `%`, `W`, `Wh`, `g`, `s`, `bps`, `B`, `°C`, `!rpm`, `!EUR`; `tests/units.test.js` rejects any other unit and any prefixed one. `B` (data sizes, item "API: largest pushed value") uses base-2 prefixes: 1024 B shown as "1 KB", 1536 B as "1.5 KB" (Zabbix 7.0 manual, "Unit symbols", "Item value suffixes", JEDEC).
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
- **Size of `intersight.raw` (Text, history 1h, stored in the database).** `history_text.value` is `t_text` (Zabbix 7.0 `create/src/schema.tmpl`), i.e. `text` on MySQL and on PostgreSQL (`create/bin/gen_schema.pl`, branch `release/7.0`). MySQL `TEXT` holds 65,535 bytes (MySQL 8.0 "String Data Type Syntax"). The Zabbix 7.0 manual ("Creating an item", "Text data limits", page 293 of the PDF) says a Text value is truncated before being stored: 65536 bytes on MySQL, 65536 **characters** on PostgreSQL (and Oracle, SQLite proxy): the limit is not MySQL-only. The maintainer's database is MySQL. On it, the largest pushed JSON (one FI) was only partly shown by the Zabbix frontend. Hence `api.max_push_bytes` / `api.max_push_moid` (UTF-8 bytes, never below the character count) and the WARNING trigger above `{$INTERSIGHT.RAW.SIZE.WARN}` = 50000 (`tests/push_size.test.js`). Not verified: whether dependent items see the value before or after that truncation.
- Duktape in Zabbix 7.0 is the bundled 2.7.0 (`src/libs/zbxembed/duktape.h`). An HTTP body is pushed into it as UTF-8 (`httprequest.c`, `duk_push_lstring`), so a 4-byte character is one Duktape character whose `charCodeAt()` is the full code point (Duktape `duk_bi_string.c`, `duk_hstring_misc.c`; guide "Stack types": extended UTF-8 internally); strings sent back to C are converted to UTF-8, surrogate pairs included (`es_duktape_string_decode`, `embed.c`). `utf8ByteLength()` counts both forms as 4 bytes.
- **Nested LLD (discovery prototypes) only exists since Zabbix 7.4.**
- `{ITEM.LASTVALUE<N>}` is the item of the Nth **function** of the trigger expression, not the Nth distinct item (Zabbix 7.0 source: `src/libs/zbxeval/parse.c` numbers each function token, `src/libs/zbxdbwrap/trigger.c` `zbx_db_trigger_get_itemid` reads that number). So `last(a)=1 and nodata(a,…)=0 and last(b)>=0` makes `b` `{ITEM.LASTVALUE3}`. The alarm triggers put `nodata()` last for this reason.
- LLD lost resources in the 7.0 YAML: `lifetime_type` (`DELETE_AFTER`), `lifetime`, `enabled_lifetime_type` (`DISABLE_AFTER`), `enabled_lifetime` (Zabbix 7.0 source, `ui/include/classes/import/validators/C70XmlValidator.php`; default `enabled_lifetime_type` is `DISABLE_IMMEDIATELY`). Consequence: the PSU and port rules, which only set `lifetime`, disabled their resources on the first run without telemetry (the collector sent `psus` / `ports` = `[]`); they now have their own delay macros, `{$INTERSIGHT.LLD.LOST.DISABLE}` (1h) and `{$INTERSIGHT.LLD.LOST.DELETE}` (7d). The collector now leaves out `psus` / `ports` when the `hw.power_supply` / `hw.network` request failed (`[]` only when the request succeeded with no row for the device), and both rules use `DISCARD_VALUE` (`tests/telemetry_failure_components.test.js`). Same default on the servers, chassis, FI and models rules, and disabling "affects lost hosts, items and triggers" (Zabbix 7.0 "Low-level discovery"): one failed inventory request (list sent as `[]`) disabled every host of that class. Now the collector leaves out a failed list (and `models`), those rules use `DISCARD_VALUE`, and they have `{$INTERSIGHT.HOST.LOST.DISABLE}` (1h) / `{$INTERSIGHT.HOST.LOST.DELETE}` (7d) (`tests/host_lld_failed_inventory.test.js`). Not verified: what happens to the open problems of a disabled host (not stated in the Zabbix doc).
- Telemetry dataSources (catalog): `hw.network` is in **NetworkInterfaces**; everything else is in **PhysicalEntities**. Queries go to `/api/v1/telemetry/TimeSeries` (DevNet "Telemetry APIs - Query Syntax").
- `host.name` is not unique and may change, `host.id` is "a globally unique host ID", the API path of the resource (Cisco DevNet "Host Power and Status"; `host.id` is an attribute of all 13 instruments of the catalog). So every telemetry row is resolved to a device Moid when it is read: last segment of `host.id`; without `host.id` (absent or empty), the (class, name) fallback built from the inventory (`buildMoidByNameKey()`), by name in any class when `host.type` is unknown, and only if that name is unique; otherwise the row is ignored. Fallback kept on purpose (maintainer decision): the repository is public and another Intersight may not return `host.id`. Known limit: homonyms without `host.id` get no telemetry, rather than mixed data (`tests/telemetry_match_by_host_id.test.js`).
- Support lists (catalog): `hw.host.power` is NOT reported for IMM chassis (their power = sum of PSU `hw.power`); ECC errors by blades and racks; `system.cpu` / `system.memory` by FIs; `hw.network.bandwidth.utilization_all` by blades, racks and FIs.
  - Intersight help "Data Collection": metrics exist for IMM, UMM (environmental only) and ISM (standalone) servers. Collection every minute (Advantage) or 10 min (Essentials, UMM). Blades need IOM UCS-IOM-2408 / UCSX-I-9108-25G / UCSX-I-9108-100G; IMM needs a valid license on every server; FIs need NTP.
  - Intersight help "Metrics Explorer": Average = Sum / count (documented example), and groupBy rows come under "event".
- Appliance telemetry requires metrics data collection (Cisco "Cisco Intersight Virtual Appliance and Intersight Assist Getting Started Guide", chapter "Overview", section "About Cisco Intersight Virtual Appliance", table 1 "Deployments Options", https://www.cisco.com/c/en/us/td/docs/unified_computing/Intersight/b_Cisco_Intersight_Appliance_Getting_Started_Guide/m_appliance_overview.html): standalone, "you can opt-in to enable the essential tier metrics data collection"; "a two-node cluster that includes an appliance management node and a metrics node"; "metrics data collection is not supported in the three-node cluster deployment"; "a four-node cluster that includes HA management cluster and a metrics node". The same page says that collection is disabled automatically above a server threshold, or when disk8 of the metrics node reaches 90 %, and must then be re-enabled manually. It does not say that collection is disabled by default: do not write it.
- The appliance "Supported Metrics" summary doc (on-prem, checked by `tools/check_metrics_against_doc.py`) lists metric names and units but not dataSources, rollup fields or per-device support; the per-instrument pages (catalog) do. Cisco content: never commit either (`Supported_Metrices.md` is in `.gitignore`).

## Checked on the design appliance (2026-11-24)

- **Import into Zabbix 7.0: OK** (7.0-5 had failed with `Invalid parameter "/7/params": value is too long`, fixed in 7.0-6). Fix any future import error in the generator, not in the YAML.
- **ECDSA speed in Duktape:** item "API: signing time (hs2019)" stays below the 90 s threshold of the run-duration trigger (item timeout 120 s). No optimisation needed for now; if it grows: fixed-base precomputation table for G, or fewer `TELEMETRY_QUERIES`.
- **hs2019 signing (EC P-256 mode) accepted by the appliance:** inventory is collected and "API: last errors" is empty. The signing string order is therefore right for this appliance (RSA and OAuth modes still untested).
- **Blade↔chassis matching by `RegisteredDevice.Moid:ChassisId` FAILS:** `blades` was empty in every chassis; the maintainer compared `chassis_key` values: the `RegisteredDevice.Moid` part differs between a blade and its chassis. Fix (not yet checked on the design appliance): match on `compute.PhysicalSummary.EquipmentChassis.Moid` == chassis `Moid` (field from the Intersight API schema, CiscoDevNet/intersight-python 1.0.11.x `compute_physical_summary_all_of.py`), old key only as fallback; `servers[].chassis_moid` shows the value read. Only affects the 7.4 nested mode (`flat_servers=0`); in 7.0 all servers are discovered anyway.

### Telemetry `host.id` (design appliance, 2026-11-27)

- `host.id` has the form `/api/v1/<space>/<class>/<id>`, e.g. `/api/v1/compute/Blades/<id>`. Seen on the `hw.host` and `hw.power_supply` queries.
- Its last segment `<id>` equals the device `Moid` in the inventory, for blades, racks, chassis and FIs. For a blade it is the blade itself, not the FI.
- No row has an empty `host_id`.
- **Uniqueness:** a groupBy on `host_id` alone and a groupBy on `host_id, host_name, host_type` return the same number of rows, for `hw.host` and for `hw.power_supply`. So each `host.id` maps to one name and one type.
- No duplicate name in `compute/PhysicalSummaries`, `equipment/Chasses` and `network/ElementSummaries`.

### Paging and server type (design appliance, 2026-11-27)

- `$orderby=Moid` is accepted together with `$top`, `$skip`, `$filter` and `$select`, on `compute/PhysicalSummaries` and `cond/Alarms`. The results come back sorted by Moid. So `listAllObjects` sorts every page by Moid (Cisco Intersight API Docs, "Query Language", "$top and $skip Query Options: Pagination": `$orderby` gives "a predictable order"; no default order stated). Moid is unique (SDK `mo_base_mo.py`: "The unique identifier of this Managed Object instance"); the SDK does not state that it never changes. A list whose last page read is full at `MAX_ITEMS_PER_LIST` is reported in `api.errors` and kept (`tests/inventory_paging.test.js`).
- `SourceObjectType` is present on `compute/PhysicalSummaries`. Only two values were seen, `compute.RackUnit` and `compute.Blade`, with `$apply=groupby((SourceObjectType),...)` (SDK `compute_physical_summary_all_of.py`: "This feild will either be RackUnit or Blade"). `is_blade` reads it first; the chassis / model rule is only the fallback for other installations (`tests/blade_chassis_matching.test.js`).

### Server power state (design appliance, 2026-11-27)

- `OperPowerState` of `compute/PhysicalSummaries`: only `on` and `off` were seen, with `$apply=groupby((OperPowerState),...)`. The SDK sets no list of values: `oper_power_state (str): The actual power state of the server.` (CiscoDevNet/intersight-python, `compute_physical_summary_all_of.py`).
- Hence `power_state`: `on` 1, `off` 0 (case-insensitive), any other non-empty value 2 ("Other" in the value map "Power state"); absent or empty `OperPowerState`: not sent. Value 2 raises its own WARNING trigger "Intersight: unexpected power state reported" (no manual close), not "server is powered off" (`tests/power_state.test.js`).

### Alarms (design appliance, 2026-11-26)

- `AncestorMoId` of an alarm equals the `Moid` of the device in `compute/PhysicalSummaries` (servers), `equipment/Chasses` (chassis) and `network/ElementSummaries` (FI, `AncestorMoType` = `network.Element`).
- `AffectedMoId` is empty on open alarms: never use it to attach an alarm.
- An alarm keeps its `Moid` until Cleared; a Cleared alarm keeps its `OrigSeverity` (Critical or Warning), with a `LastTransitionTime` later than its `CreationTime`.
- Alarms without ancestor have `AncestorMoId = ''`: the filter `eq ''` finds alarms, `eq null` none. Their `AffectedMoType` and `AncestorMoType` are empty too. Their affected object (`AffectedMo.ObjectType`) is a platform object: `iam.ApiKey` or `softwarerepository.Authorization`, the only types seen (list not exhaustive).
- The combined filter `Severity ne 'Cleared' or (Severity eq 'Cleared' and LastTransitionTime gt <date>)` is accepted and returns exactly the union of both sets.
- Fields `AncestorMoId`, `AncestorMoType`, `Acknowledge`, `Suppressed`, `LastTransitionTime` and `OrigSeverity` exist on the appliance.
- Volume: everything fits in one page of 1,000 (`PAGE_SIZE`) on the design appliance.
- Design decisions (maintainer, 2026-11-26): Critical -> High (not Disaster); Info alarms raise problems (prototype can be disabled); Cleared window 1d; lost resources disabled after 1d, deleted after 7d; Severity `None` (SDK enum) not pushed; alarm items use a 1h heartbeat with `{$INTERSIGHT.ALARM.NODATA}` = 2h; `AcknowledgeBy` (a person's name) is never selected nor pushed.

## NOT verified yet (first things to check on the real system)

- Whether `{ITEM.LASTVALUE2}` / `{ITEM.LASTVALUE3}` in the alarm triggers' operational data show the raw 0/1 or the value map label: check after import.
- **Inventory fields** not confirmed on the appliance: FI `Version` and `OutOfBandIpAddress`, chassis `OperState`.
- **Response shapes**: list endpoints are assumed to return `{Results: [...]}` (the groupBy `[{event: {...}}]` shape is documented by the Metrics Explorer example).
- **`host.id` on the other instruments:** only `hw.host` and `hw.power_supply` were tested on the design appliance. Not verified for the other instruments (`hw.network` on `NetworkInterfaces`, `hw.temperature`, etc.); the doc describes the same attribute. Rows without `host.id` use the name fallback.
- `hw.status` is deliberately not used: its "one series per state" semantics were unclear. Left pending (maintainer decision, 2026-11-24).
- The OAuth mode has never run against a real Intersight.
- **Zabbix 7.4 nested blade discovery not import-tested:** the manual steps in `docs/UPGRADE_7.4_FR.md` (rule type Nested, JSONPath `$.blades` with Discard value on failure, lost resources `{$INTERSIGHT.HOST.LOST.DELETE}` / `{$INTERSIGHT.HOST.LOST.DISABLE}`) have never been applied on a real Zabbix 7.4. The behaviour of nested rules was read in the "current" documentation (Zabbix 8.0, "Discovery prototypes"), not in the 7.4 page. The 7.4 import validator (`C74XmlValidator.php`, branch `release/7.4`) has the `NESTED` type and the `lifetime_type` / `enabled_lifetime_type` fields for discovery rules. Also to check on 7.4: what the nested rule receives when the parent "Chassis discovery" discards its value (chassis request failed).
- **Options left for later on the size of `intersight.raw`** (maintainer decision, 2026-11-27: monitor only, no storage change for now):
  - Stop storing `intersight.raw` (history 0): its dependent items would still be fed, but "No trigger functions will be evaluated because trigger evaluation is based on history data only" (Zabbix 7.0 manual, "History and trends"), so the `nodata(/…/intersight.raw,…)` trigger would have to move to another item (for example a numeric dependent item). Not tested.
  - Remove the alarm `description` from the pushed JSON, or use it (today it is pushed but not read by any item). Not measured: how much of the largest value it accounts for.
- **Possible follow-up:** generate a 7.4 template file with the nested blade rule built in, instead of manual steps. Only once a Zabbix 7.4 instance is available to test the import: never publish a template file that was never imported.

## Repository

- `cweiland/zabbix-cisco-intersight-by-api` (public). The state of pull requests and CI is read on GitHub (merged PRs: `git log --oneline --merges origin/main`); it is not copied here.
- Ruleset on `main`: PR required, check `tests` required, no force push or deletion. CodeQL default setup, Dependabot, secret scanning and private vulnerability reporting are on.
- Dependabot PRs that touch `.devcontainer/` (features, base image, PyYAML): the CI does not build the image, so the maintainer rebuilds the container from the PR branch before merging. Action updates are covered by the CI.
- LICENSE: AGPL-3.0-only (maintainer decision, "like Zabbix": Zabbix headers say "version 3", no "or later"). `LICENSE` is the FSF text byte for byte (sha256 0d96a4ff...abcb0, same as gnu.org/licenses/agpl-3.0.txt and Zabbix's COPYING); never edit it.
- Template vendor: `cweiland`, the maintainer's GitHub username, already public as the owner of the repository (maintainer decision, 2026-11-27). It is not personal data to report in a security or personal-data check.

## Open items

- Unreleased changes: `CHANGELOG.md` has a "Non publié" section (blade↔chassis fix; base units with renamed keys, PR #13) while the template version is still `7.0-6` (`tools/generate_templates.py`). Releasing it (version number) is the maintainer's decision.
- Optional metrics not collected: GPU (`hw.gpu.*`), voltage, current, optical signal power, detailed packet counters.

## Testing conventions

- Tests mock `HttpRequest`, `sha256` and `sign`, then run `src/collector.js` through `new Function('value', ...)`, the same way Zabbix runs it.
- Mocked Intersight responses must follow the Cisco support matrices (e.g. no `hw.host` row for IMM chassis).
- Every request signature is verified cryptographically in the mocks.
- New behaviour gets a PASS/FAIL check that sets `process.exitCode = 1` on failure.
- Never build a RegExp from a string in tests (CodeQL "Incomplete string escaping", PR #17 and #19): use plain text search (`indexOf` / `includes`).

## Claude Code permissions (`.claude/settings.json`)

- Git is read-only for Claude (maintainer decision): `git commit` and `git push` are denied. Claude edits files; the maintainer reviews, commits and pushes from the host. In the dev container the whole `.git` is mounted read-only anyway (a writable `.git` lets the container run commands through git on the host). Read-only commands such as `git status`, `git diff` and `git log` need no rule.
- **Tests, `tools/ci.sh`, the generator and the validator are NOT pre-approved, on purpose** (maintainer decision): they run scripts Claude can edit (`run_all.js` runs every `*.test.js`), so an allow rule would amount to running arbitrary code without asking. Expect a prompt each time; do not try to get around it.
- Do not work around the git rules (`git -C . commit`, `git -c ... push` and similar forms are not matched by the rules, but are just as off-limits).
- Reading `params.json`, `*.pem`, `*.key` and `.env*` is denied: they hold credentials. Do not read them by other means either (scripts, `node -e`, `python -c`).
- Personal approvals go to `.claude/settings.local.json`, which is git-ignored. Do not add "don't ask again" approvals for script-running commands there either.
