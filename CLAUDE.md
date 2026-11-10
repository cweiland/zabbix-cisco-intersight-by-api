# Project context for Claude Code

Zabbix templates that monitor Cisco Intersight: servers, chassis, Fabric Interconnects.
This project was designed in a claude.ai conversation. This file carries over its
decisions, verified facts and open points. Read it before changing anything.

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

- `.devcontainer/` is the sandbox the user works in (VS Code + Claude Code). Same tool versions as the CI: Node 20, Python 3.12, PyYAML 6.0.3.
- Outbound firewall `.devcontainer/intersight-init-firewall.sh`, fail-closed: only api.anthropic.com, GitHub ranges and the VS Code marketplace. The Intersight appliance is reachable (HTTPS) only if `INTERSIGHT_APPLIANCE_HOST` is set. Expect any other network access to fail; the tests never need the network.
- `sudo` is limited to the firewall script: nothing can be installed at runtime. Add tools to the `Dockerfile` instead.
- Run `tools/ci.sh` before every commit: same steps as the GitHub CI, including "committed template == generated template".
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
- Zabbix units: `!` prevents automatic K/M/G prefixes (Zabbix 7.0 doc "Unit symbols"; the old %, ms, rpm stoplist is deprecated). Use `!kWh`, `!kg`, `!EUR`, `!ms`, `!rpm`; `tests/units.test.js` rejects any other unit.
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

## NOT verified yet (first things to check on the real system)

- **Import into the user's Zabbix 7.0:** the first attempt (7.0-5) failed with `Invalid parameter "/7/params": value is too long` (script over 65,535 characters), fixed in 7.0-6. **7.0-6 has not been imported yet** (pushed at the user's request before the import test). Other import errors are still possible: fix them in the generator, not in the YAML.
- **ECDSA speed in Duktape is unknown.** It is about 10 ms per signature on V8 and about 280 ms on V8 without JIT. There are 13 signatures per run. Watch item "API: signing time (hs2019)". If too slow: add a fixed-base precomputation table for G, or drop queries from `TELEMETRY_QUERIES`.
- **Inventory fields** not confirmed on the appliance: FI `Version` and `OutOfBandIpAddress`, chassis `OperState`, and the blade↔chassis matching via `RegisteredDevice.Moid` + `ChassisId`.
- **Response shapes**: list endpoints are assumed to return `{Results: [...]}` (the groupBy `[{event: {...}}]` shape is documented by the Metrics Explorer example).
- `hw.status` is deliberately not used: its "one series per state" semantics were unclear.
- The OAuth mode has never run against a real Intersight.

## Open items

- Repository: `cweiland/zabbix-cisco-intersight-by-api` (private). First pushed from claude.ai through the GitHub connector; check that the CI workflow passes.
- LICENSE: not chosen. Ask the user.
- Optional metrics not collected: GPU (`hw.gpu.*`), voltage, current, optical signal power, detailed packet counters.

## Testing conventions

- Tests mock `HttpRequest`, `sha256` and `sign`, then run `src/collector.js` through `new Function('value', ...)`, the same way Zabbix runs it.
- Mocked Intersight responses must follow the Cisco support matrices (e.g. no `hw.host` row for IMM chassis).
- Every request signature is verified cryptographically in the mocks.
- New behaviour gets a PASS/FAIL check that sets `process.exitCode = 1` on failure.
