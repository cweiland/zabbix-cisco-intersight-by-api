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
- UUIDs are derived from names (stable across regenerations). Renaming an item key changes its UUID.
- `src/collector.js` must stay **ES5** (Duktape). No `let`, `const`, arrow functions or template strings. CI checks this.
- The **JSON contract** between the collector and the templates is documented at the top of `src/collector.js`. Renaming a field requires changing the matching JSONPath in `tools/generate_templates.py`.

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
- Telemetry dataSources (Cisco DevNet): `hw.network` is in **NetworkInterfaces**; everything else is in **PhysicalEntities**.
- `host.name` is not unique (Cisco), so telemetry is matched on `host.type` + `host.name`.
- Support matrices (Cisco DevNet):
  - `hw.host.power` is NOT reported for IMM chassis. Their power is the sum of PSU `hw.power_out`.
  - `hw.power_supply.utilization` is reported by Fabric Interconnects only.
  - Only IMM/UCSM devices appear in the lists: standalone racks likely have no telemetry.
- Appliance telemetry requires a metrics node (2- or 4-node cluster; not 3-node) or the single-node opt-in.
- The appliance "Supported Metrics" doc (on-prem build 1.0.11-20261009…) lists every instrument and field used: 9 instruments, 30 fields. It does not give dataSources or per-device support. It is Cisco content: never commit it (it is in `.gitignore`).

## NOT verified yet (first things to check on the real system)

- **The template has never been imported into a real Zabbix.** Expect possible import errors and fix them in the generator, not in the YAML.
- **ECDSA speed in Duktape is unknown.** It is about 10 ms per signature on V8 and about 280 ms on V8 without JIT. There are 13 signatures per run. Watch item "API: signing time (hs2019)". If too slow: add a fixed-base precomputation table for G, or drop queries from `TELEMETRY_QUERIES`.
- **Rollup field suffixes** (`_max`, `_min`, `_count`, `_duration`) follow the DevNet pattern. The appliance doc only lists base metric names.
- **Inventory fields** not confirmed on the appliance: FI `Version` and `OutOfBandIpAddress`, chassis `OperState`, and the blade↔chassis matching via `RegisteredDevice.Moid` + `ChassisId`.
- **Response shapes**: list endpoints are assumed to return `{Results: [...]}` and Druid groupBy `[{event: {...}}]`.
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
