This README is available in: English | [Français](README-fr.md)

# Cisco Intersight → Zabbix

Monitoring of Cisco Intersight (Virtual Appliance or SaaS) in Zabbix 7.0 LTS: rack and blade servers, chassis and Fabric Interconnects.

**Validation level**: validated: `hs2019` mode on an Intersight Virtual Appliance; beta: SaaS, `rsa` and `oauth` modes. Findings marked "observed on an appliance during design" come from a single installation: their scope is not guaranteed, and they are to be checked on each appliance.

- A single script makes all the API calls, then feeds one Zabbix host per device through `history.push`.
- Three authentication modes: API key v3 **hs2019** (ECDSA P-256 implemented in pure JavaScript, because Zabbix can only sign with RSA; validated), v2 key **rsa** (beta), or **OAuth2** (beta).
- Metrics and aggregates per device type: power, energy, cost and CO₂, temperature, fans, PSUs, ECC memory, CPU, network ports, alarms and firmware.

## Repository contents

| Path | Role |
|---|---|
| `templates/zbx_intersight_templates_7.0.yaml` | The 4 templates, **to import into Zabbix** |
| `src/collector.js` | Collection script (ES5 / Duktape), embedded in the template |
| `tools/generate_templates.py` | Regenerates the YAML from `src/collector.js` |
| `tools/validate_template.py` | Structural checks of the generated YAML (macros, UUIDs, keys, triggers) |
| `tools/ci.sh` | Runs locally all the checks of the GitHub CI |
| `.devcontainer/` | Development sandbox: container, outbound firewall, same versions as the CI |
| `docs/intersight_metrics.json` | Catalog of the Intersight metrics (instruments, Druid fields, supported devices) |
| `tools/build_metrics_catalog.py` | Rebuilds this catalog from the "Supported Metrics" pages |
| `tools/check_metrics_against_doc.py` | Checks the metrics used against the "Supported Metrics" doc of an appliance |
| `tests/` | Node.js tests without dependencies: ECDSA (RFC 6979 vector + OpenSSL), auth modes, scenarios |
| `docs/UPGRADE_7.4.md` | Zabbix 7.4 variant (blades discovered under their chassis) |
| `SECURITY.md` | Reporting a vulnerability (GitHub private reporting) and scope |
| `docs/DEVCONTAINER_SECURITY.md` | Setting up your machine for the devcontainer (git credentials, SSH, checks) |
| `CONTRIBUTING.md` | Contribution rules (checks, generated files, units, license) |
| `CLAUDE.md` | Project context for Claude Code (decisions, verified facts, open points) |
| `.github/copilot-instructions.md` | Instructions for GitHub Copilot (essential rules taken from `CLAUDE.md`) |

## Development

```bash
node tests/run_all.js                  # all tests (Node.js 20, the version used by the CI)
python3 tools/generate_templates.py    # after any change to src/collector.js (PyYAML)
python3 tools/check_metrics_against_doc.py Supported_Metrices.md
tools/ci.sh                            # all the CI checks, before every commit
```

The YAML is generated: **do not edit it by hand**. It embeds a comment-stripped copy of `src/collector.js`, because Zabbix limits scripts to 65,535 characters. Change `src/collector.js` or `tools/generate_templates.py`, then regenerate. The CI checks that the committed template matches the script, that the code stays ES5, and that all tests pass. UUIDs are derived from names, so they are stable from one generation to the next.

### Development environment (sandbox)

The repository provides a devcontainer (`.devcontainer/`): Ubuntu 24.04 with Node 20, Python 3.12 and PyYAML 6.0.4, the same versions as the CI, plus the Claude Code extension.

**Before opening it for the first time, set up your machine by following [docs/DEVCONTAINER_SECURITY.md](docs/DEVCONTAINER_SECURITY.md)**: part of the isolation (git credentials, SSH agent) cannot be set from the repository.

- **Prerequisites**: VS Code with the Dev Containers extension, and a Docker engine.
- **Opening**: command "Dev Containers: Reopen in Container". At every start, the firewall is applied first, by the image entry point (`.devcontainer/intersight-entrypoint.sh`): if it fails, the container stops and VS Code cannot connect to it. Then `postStartCommand` waits until the firewall of this start is complete (a marker written by root, specific to each start, `.devcontainer/intersight-wait-for-firewall.sh`), then runs the tests and the validator. The firewall is limited to 45 s (forced stop 5 s later), below the 60 s wait: a stalled start (DNS, GitHub) stops the container instead of letting VS Code connect too early. A broken environment is therefore reported at start. VS Code and its extensions, Claude Code included, wait for `postStartCommand` to finish (`waitFor`).
- **Outbound firewall**: everything is blocked except Claude Code (`api.anthropic.com`, and `platform.claude.com` + `claude.ai` for sign-in and token renewal, according to the [Claude Code network documentation](https://code.claude.com/docs/en/network-config)), and GitHub, over IPv4 as well as IPv6. If IPv6 cannot be filtered, it must be disabled on every interface (and for future interfaces), otherwise the container does not start. It fails closed, at two levels: the block is set before any other rule, and any error stops the container. Neither the host machine nor the container gateway can be reached: Docker also publishes the ports of other containers there. VS Code goes through `docker exec`, not through the network. There is no `sudo` in the container: nothing that runs in it, Claude Code included, can lift the rules or add a destination. The entry point and the firewall, run as root, only use commands from the system directories (`/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`), never those of a directory writable by `vscode` such as the Node one (`/usr/local/share/nvm`). To re-apply the firewall, restart the container. To install a tool, add it to the `Dockerfile` and rebuild. The tests `tests/firewall_script.test.js` check these points.
- **Access to an Intersight appliance** (HTTPS only): `INTERSIGHT_APPLIANCE_HOST` must be set in the environment where VS Code is started, before the container is created (a change requires "Rebuild Container"). The script reads this variable from the environment of the container, fixed at its creation. Without it, no appliance can be reached from the container. If its name does not resolve, the container starts anyway, with a warning. The tests do not need it: all calls are simulated.
- **If a legitimate connection is blocked** (for example for the Claude Code sign-in), add the domain to `ALLOWED_DOMAINS` in `.devcontainer/intersight-init-firewall.sh`.
- **Files executed by the host machine, read-only in the container**: `.devcontainer/` (including `initializeCommand`, run on the host), the whole `.git/` (hooks and config used by `git am`, `git push` or VS Code on the host; protecting only `.git/config` and `.git/hooks` is not enough, a single `.git/commondir` file redirects git to another config) and `.vscode/` (settings and tasks when the folder is reopened locally). Nothing that runs in the container, Claude Code included, can therefore run a command on the host machine this way. Consequences: in the container, git is used for reading (`git status`, `git diff`, `git log`); Claude Code edits the files, and commits and pushes are made from the host machine, after review. `.devcontainer/` and `.vscode/` are also changed from the host machine. The clone must be a regular repository (`.git` directory, not a worktree), and `.vscode/` must exist: only `.vscode/extensions.json` is versioned.
- **VS Code**: the container reaches no VS Code server. The VS Code server is copied from the host machine, and the extensions are downloaded on the host machine and then copied into the container (`downloadExtensionsLocally` in the log): no action needed.
- **IP addresses fixed at start**: the allowed list is computed once, at start. If a service changes address afterwards (CDN), its new connections fail until the next restart of the container. This is intended: no root process stays active to change the rules.
- **Git credentials of the host machine: no GitHub HTTPS credential on the host (required)**. Dev Containers opens a channel between the container and the host machine (`REMOTE_CONTAINERS_IPC`) and drops a relay script in it (`/tmp/vscode-remote-containers-<id>.js`) that queries the credential manager of the host machine. Since GitHub is allowed, a manipulated agent could obtain the GitHub token of the host and push to any repository of that account. **The setting `"dev.containers.gitCredentialHelperConfigLocation": "none"` is not enough**: it only removes the `credential.helper` from the git config, but the script still answers (observed during design: it returns the stored username and password). The only safe protection: keep **no** `https://github.com` credential in the credential manager of the host machine, and push from the host over SSH with a passphrase-protected key, **without an SSH agent** (Dev Containers automatically forwards a running agent, including the Windows one). The sign-in windows of the Windows credential manager (Git Credential Manager) must also be disabled: `git config --global credential.interactive false`. Without this setting, a request from the container opens a GitHub sign-in window on the host machine (observed during design): signing in there would send the token back to the container. **Never accept such a window while the container is running.** The `none` setting is to be kept as well: it prevents git from using the relay without this being visible. Check, in the container: the command of `.devcontainer/check-host-credentials.sh` must print "no GitHub credential".
- **Pinned images and packages**: the base image is fixed by its digest (`@sha256:` in the `Dockerfile`) and PyYAML is installed with its PyPI hashes (`.devcontainer/requirements-dev.txt`, `--require-hashes`, also in the CI). The container runs with `no-new-privileges`: no program can gain privileges (setuid). To update the image: `docker pull` of the tag, check, then replace the digest.
- **Claude Code**: its configuration (`CLAUDE_CONFIG_DIR`, including the `.claude.json` file) and its sign-in are in a Docker volume: they survive a "Rebuild Container".
- **DNS**: DNS requests (UDP and TCP) only go to the resolvers of the container (`/etc/resolv.conf`, written by Docker), not to any server. **Known limitation**: a recursive resolver relays requests to any domain, so a DNS tunnel (data hidden in domain names) remains possible; only a filtering DNS proxy would prevent it. Likewise, the allowed GitHub ranges give access to all of GitHub (other repositories, gists), not only to this repository.
- **Never commit**: `params.json` (parameters and private key for `zabbix_js`), the `cisco-docs/` folder (Cisco pages of the catalog), `Supported_Metrices.md` (Cisco "Supported Metrics" doc, not redistributable) and `docs/Zabbix_Documentation_*.pdf` (Zabbix manual, whose copyright notice forbids redistribution). All of them are in `.gitignore`.


The file `zbx_intersight_templates_7.0.yaml` contains 4 templates:

| Template | Linked to | Role |
|---|---|---|
| Cisco Intersight by API | 1 "Intersight" host created by hand | Collection (1 script / 5 min), discovery, aggregates, health |
| Cisco Intersight Server by push | discovered servers (rack + blade) | Power, energy, PSUs, thermal, fans, network, firmware, alarms |
| Cisco Intersight Chassis by push | discovered chassis | Same, without firmware |
| Cisco Intersight FI by push | discovered Fabric Interconnects | Same, with firmware and ports |

The parent template makes **all** the Intersight calls, then pushes one JSON per device to the trapper item `intersight.raw` of each discovered host (API method `history.push`, Zabbix 7.0+). The discovered hosts make no API call.

## Data flow

1. The script `intersight.collect` reads the inventory: `compute/PhysicalSummaries`, `equipment/Chasses`, `network/ElementSummaries` and `cond/Alarms` (a single request: non-Cleared alarms, plus the recent Cleared alarms; see "Intersight alarms").
2. It reads the Druid telemetry through `/api/v1/telemetry/TimeSeries` (`groupBy` queries), grouped by `host.id`, `host.type` and `host.name`: 9 instruments (see "Collected metrics"). Each row is attached to the device whose `Moid` is the last segment of `host.id` (see "Known limitations", "Join").
3. It signs every request with the **API key v3** (`hs2019`, ECDSA P-256). Zabbix can only do RSA, so ECDSA is implemented in pure JavaScript in the script (RFC 6979 deterministic nonce). The `rsa` (v2 key) and `oauth` modes remain available through `{$INTERSIGHT.AUTH}`.
4. It pushes the values to the `intersight-<Moid>` hosts through `history.push`.
5. It returns a JSON that feeds the LLD rules (host prototypes), the health items and the aggregates.

Each call is isolated in a `try/catch`. A missing metric does not break the rest; the error appears in the item "API: last errors".

## Installation

1. **Intersight**: use the API key v3 (`BEGIN EC PRIVATE KEY`, P-256 curve), ideally with a read-only role.
2. **Zabbix, technical user**: create a dedicated user with an API role that allows `history.push`, read permission on the `Intersight/*` groups, and an API token.
3. **Import** the YAML (Data collection > Templates > Import).
4. **Create a host** "Cisco Intersight", without interface, and link `Cisco Intersight by API` to it.
5. **Fill in the macros** on this host:

| Macro | Value |
|---|---|
| `{$INTERSIGHT.AUTH}` | `hs2019` (default) |
| `{$INTERSIGHT.KEY_ID}` | ID of the API key |
| `{$INTERSIGHT.SECRET}` (secret) | EC private key: full PEM with literal `\n`, or base64 body on one line |
| `{$INTERSIGHT.API.HOST}` | `intersight.com`, your SaaS region or your appliance |
| `{$ZABBIX.API.URL}` | `https://<frontend>/api_jsonrpc.php` |
| `{$ZABBIX.API.TOKEN}` (secret) | token of the technical user |
| `{$INTERSIGHT.ENERGY.PRICE}` | price per kWh (0 by default) |
| `{$INTERSIGHT.CO2.G.KWH}` | carbon intensity of your supplier in gCO₂/kWh (0 by default) |
| `{$INTERSIGHT.WINDOW}` | telemetry window in minutes: 10 (Advantage, default) or 30 (Essentials) |
| `{$INTERSIGHT.PERCENT.SCALE}` | 100 (default): Intersight stores percentages as 0–1 ratios |

6. **Allowed hosts**: if you fill in this field on the trapper items, it must contain the IP of the Zabbix frontend, otherwise `history.push` is refused.
7. Run "Test" on the item `Intersight collector`, then "Execute now".

In the first cycle, `Push: values rejected` is normal: the hosts do not exist yet. They are created by the LLD and fed from the next cycle on.

**Lost hosts (servers, chassis, FIs, models).** A device that is no longer reported by Intersight has its host disabled after `{$INTERSIGHT.HOST.LOST.DISABLE}` (`1h` by default), then deleted after `{$INTERSIGHT.HOST.LOST.DELETE}` (`7d` by default, history lost). It is enabled again if it is discovered again in the meantime (Zabbix 7.0 doc, "Low-level discovery"). The same delays apply to the aggregated items of a model that disappears. **Deletion must stay longer than disabling.** Each field of the rule contains only one macro (Zabbix 7.0 doc, "User macros supported by location", note 1): to change the delays, change the value of the macros.

If reading a list (servers, chassis or FIs) fails, the collector sends neither this list, nor its count, nor the list of models, nor (for servers) the `blades` lists of the chassis, and the discovery rules discard the value: no host is declared lost for this cycle. The devices that were read are still fed, and the error appears in "API: last errors". An empty list returned without error by Intersight, on the other hand, is passed on as is: the hosts of that type are then indeed declared lost. Not verified: the Zabbix doc does not say what happens to the open problems of a disabled host.

## Intersight Virtual Appliance

On an Intersight Virtual Appliance, telemetry only exists if metrics collection is active. According to the Cisco guide "Cisco Intersight Virtual Appliance and Intersight Assist Getting Started Guide", chapter "Overview", section "About Cisco Intersight Virtual Appliance", table 1 "Deployments Options" (<https://www.cisco.com/c/en/us/td/docs/unified_computing/Intersight/b_Cisco_Intersight_Appliance_Getting_Started_Guide/m_appliance_overview.html>):

- **Single node (standalone)**: collection is an option to enable, "In the standalone configuration, you can opt-in to enable the essential tier metrics data collection".
- **2 nodes**: "a two-node cluster that includes an appliance management node and a metrics node".
- **3 nodes**: "metrics data collection is not supported in the three-node cluster deployment".
- **4 nodes**: "a four-node cluster that includes HA management cluster and a metrics node".

The same page states that collection is disabled automatically above a server threshold, or when the disk disk8 of the metrics node is 90 % full, and that it must then be enabled again manually.

Without metrics collection, inventory, alarms and firmware work, but the power, temperature, fan and network items stay empty, and "API: last errors" reports the telemetry requests.

## Intersight alarms → Zabbix problems

Each Intersight alarm (`cond.Alarm`) becomes a Zabbix problem **on the host of its device**. It is a one-way mirror: nothing is written to Intersight, and acknowledging, closing or commenting on a problem in Zabbix has no effect on Intersight.

**Attachment.** An alarm goes to the device (server, chassis or FI) whose `Moid` is equal to its `AncestorMoId`. This was observed on an appliance during design; `AffectedMoId`, empty on open alarms, is not used. Alarms without an ancestor (empty `AncestorMoId`, platform objects such as `iam.ApiKey` or `softwarerepository.Authorization`) and those whose ancestor is not a device read by the collector go to the parent host "Cisco Intersight" (list `platform_alarms`).

**Collection.** A single `cond/Alarms` request per cycle: all the non-Cleared alarms, plus the alarms Cleared within `{$INTERSIGHT.ALARM.CLEARED.WINDOW}`. Reading the recent Cleared alarms allows their problem to be closed (the Cisco guide "Intersight Alarms Reference Guide" states that they remain visible for 30 days). The name of the person who acknowledged (`AcknowledgeBy`) is never read nor pushed. Alarms of severity `None` ("no severity" in the SDK) are not pushed. The existing alarm counters ("Alarms: critical", "Alarms (unacknowledged): …") do not change: they only count the open, unacknowledged alarms.

**In Zabbix**, a discovery rule "Intersight alarms" on the server, chassis and FI templates and on the parent template creates, for each alarm, three items (`intersight.alarm.severity[…]`, `intersight.alarm.ack[…]`, `intersight.alarm.suppressed[…]`, with value maps) and three mutually exclusive triggers, tagged `component: alarm` and `alarm-code: <code>`:

| Intersight severity | Value | Zabbix problem |
|---|---|---|
| Critical | 3 | High (and not Disaster: design choice) |
| Warning | 2 | Warning |
| Info | 1 | Information (the prototype can be disabled if these problems are not useful) |
| Cleared | 0 | none: the problem is closed |

A severity change closes the problem and opens another one, at the new severity.

**Acknowledgement and suppression** (states Acknowledged and Suppressed of the Intersight life cycle: Active, Acknowledged, Suppressed, Cleared): acknowledging or suppressing an alarm in Intersight **does not close** the problem, since acknowledgement does not change the severity (Cisco guide). Only Cleared closes it. The state is shown in the operational data of the problem ("Acknowledged in Intersight: …, suppressed: …"). For this, the expression contains two always-true conditions, `last(ack)>=0` and `last(suppressed)>=0`: their only purpose is to make these items reachable through `{ITEM.LASTVALUE2}` and `{ITEM.LASTVALUE3}`. These macros designate the item of the Nth function of the expression (checked in the Zabbix 7.0 source), and the expression macros `{?…}` are not accepted in operational data. To check after import: whether `{ITEM.LASTVALUE}` shows the raw value (0/1) there or the label of the value map.

| Macro | Default | Role |
|---|---|---|
| `{$INTERSIGHT.ALARM.CLEARED.WINDOW}` | `1d` | maximum age of the Cleared alarms read (parent template) |
| `{$INTERSIGHT.ALARM.NODATA}` | `2h` | without a value for this long, the problem of an alarm closes; must stay greater than the 1 h heartbeat of the alarm items ("Discard unchanged with heartbeat") |
| `{$INTERSIGHT.ALARM.LOST.DISABLE}` | `1d` | alarm no longer reported: items disabled after this delay ("Disable lost resources") |
| `{$INTERSIGHT.ALARM.LOST.DELETE}` | `7d` | items deleted after this delay ("Delete lost resources") |

**Constraint:** `{$INTERSIGHT.ALARM.LOST.DELETE}` must stay **longer** than `{$INTERSIGHT.ALARM.LOST.DISABLE}` (Zabbix 7.0 doc, "Low-level discovery"). Each of these two fields of the rule contains only one macro, nothing else: Zabbix requires a macro there to fill the whole field (Zabbix 7.0 doc, "User macros supported by location", note 1). To change the delays, change the value of the macros, not the fields.

## Collected metrics

**Rule: no inferred field name.** `docs/intersight_metrics.json` is the catalog extracted from the Intersight "Supported Metrics" pages (13 instruments, 146 metrics, 724 Druid fields, with, for each metric, the device types that report it). A test fails the CI if the collector queries a field or a dataSource that is not in the catalog. To update the catalog: `python3 tools/build_metrics_catalog.py <folder of the .md pages>`.

| Instrument | What is taken from it | Devices that report it (catalog) | Trigger |
|---|---|---|---|
| `hw.host` | average and peak power | blades, racks, FIs (not the IMM chassis) | — |
| `hw.power_supply` (per PSU) | input and output power, utilization; power of the IMM chassis = sum of the input powers | chassis, racks, FIs (utilization: FIs) | WARNING above 80 % |
| `hw.temperature` (per sensor) | max temperature; margin to the critical threshold and to the non-critical threshold **of each sensor** | critical threshold: FIs, `imm-blade-mqtt`, `imm-ism-rack-mqtt`; non-critical: the last two | HIGH less than 10 °C from the critical one, WARNING above the non-critical one |
| `hw.fan` (per fan) | min/max speeds; margin to the low critical threshold **of each fan** | speed: chassis, racks, FIs; threshold: `imm-chassis-mqtt-*`, `imm-ism-rack-mqtt` | AVERAGE below the threshold |
| `hw.memory` (per DIMM) | ECC errors, DIMMs involved | blades, racks | HIGH from 1 uncorrectable error, WARNING if correctable over 3 cycles |
| `hw.cpu` | average and peak C0 utilization (value aggregated over all the CPUs of the server) | `imm-blade-mqtt`, `imm-ism-rack-mqtt` | WARNING above 90 % for 30 min |
| `system.cpu`, `system.memory` | CPU (100 − idle) and memory | FIs | WARNING above 90 % for 30 min |
| `hw.network` (per port) | received and transmitted throughput (bits/s), link speed, bandwidth utilization, link state, errors; role of the port (`hw.network.port.role`) for filtering | blades, racks, FIs | link down (if it was up within 24 h), utilization > 90 %, errors over 3 cycles |

A device that is not in the support list of a metric returns no row: the corresponding item stays empty, without error. The pages do not define the `-mqtt` suffix of the support types: which items fill is to be checked on each appliance.

**Sources other than the Cisco doc**, both taken from the Grafana dashboards [intersight-grafana](https://github.com/3191110276/intersight-grafana) (community repository, provided "best-effort"):
- **Throughput formula**: `sum(hw.network.io_receive) / sum(hw.network.io_receive_duration) × 8` in bits/s. The fields are documented, but not the formula; it is consistent with the doc, which expresses the link speed in bytes per second.
- **Grouping by "dotted" attributes** (`host.name`, `host.type`, `host.id`, `hw.network.port.role`) through `nested-field` virtual columns. This is the only unvalidated point on which all the telemetry depends: if the telemetry items all stay empty while the inventory comes in, it is the first lead to check.

**Lost resources (PSUs and ports).** A PSU or a port that is no longer reported is disabled after `{$INTERSIGHT.LLD.LOST.DISABLE}` (`1h` by default), then deleted after `{$INTERSIGHT.LLD.LOST.DELETE}` (`7d` by default). It is enabled again if it is discovered again in the meantime (Zabbix 7.0 doc, "Low-level discovery"). Before this setting, disabling was immediate (default value on import), so that a single cycle without telemetry, in which the collector sends empty lists, disabled all the PSUs and all the ports of the device until the next cycle. If the telemetry request `hw.power_supply` or `hw.network` fails, the collector does not send the `psus` or `ports` list at all, and the rule discards the value (`DISCARD_VALUE`): no component is declared lost, and the error appears in "API: last errors". **Deletion must stay longer than disabling.** Each field of the rule contains only one macro (Zabbix 7.0 doc, "User macros supported by location", note 1): to change the delays, change the value of the macros.

Ports: by default, discovery ignores the roles `unconfigured`, `vethernet`, `vfc`, `vnic` and `vhba` (`{$INTERSIGHT.PORT.ROLE.NOT_MATCHES}`), as these dashboards do. The possible roles are listed in the `hw-network` page.

Not collected, available in the catalog if needed: GPU (`hw.gpu`), voltages, currents, optical power, energy, PSU limits, physical disks (`hw.physical_disk`, collected every 30 minutes; its page is not in the catalog).

## Units

| Metric | Cisco unit (appliance doc) | Stored in Zabbix | Source of the conversion |
|---|---|---|---|
| `hw.host.power`, `hw.power`, `hw.power_out` | `W` | `W` | none |
| `hw.temperature` and its thresholds | `Cel` | `°C` | none |
| `hw.fan.speed` and its thresholds | `rpm` | `!rpm` | none |
| ECC, network errors | `{errors}` | count over the window | sum over the window |
| `hw.cpu.utilization_c0`, `system.memory.utilization`, `hw.power_supply.utilization`, `hw.network.bandwidth.utilization_all` | `%` in the doc, but **0–1 ratio in the data** | `%` | × `{$INTERSIGHT.PERCENT.SCALE}` (default **100**) |
| `system.cpu.utilization_idle` | same | CPU = 100 − idle × 100, in `%` | same |
| `hw.network.io_receive` / `io_transmit` | `By` (bytes) | `bps` | bytes ÷ duration (s) × 8, formula of the dashboards |
| `hw.network.bandwidth.limit` | `By/s` | `bps` | × 8 |
| `hw.network.up` | `1` (0 or 1) | 0/1 (value map "Link state") | none |
| Energy, cost, CO₂ | — | `Wh`, `!EUR`, `g` | computed from the power |
| API durations (cycle, signing) | — | `s` | measured by the collector |
| Size of the largest pushed JSON | — | `B` | UTF-8 bytes, measured by the collector |

**Percentages: the Cisco doc states `%`, but Intersight stores 0–1 ratios** (0.1 = 10 %). This was observed in the raw data of an appliance during design, and is consistent with the intersight-grafana dashboards, which multiply by 100. Hence `{$INTERSIGHT.PERCENT.SCALE}` = 100. If a future version returned 0–100 values, setting the macro to 1 would be enough.

**Runtime checks**, reported in "API: last errors" (then a trigger after 3 cycles):
- a percentage above 100 % after scaling → values already in percent, set the scale to 1;
- a CPU idle ≤ 1 on all the FIs with scale 1 → values in 0–1, set the scale back to 100.

**Base units only**: all values are stored in base units (W, Wh, g, s, bit/s, bytes B), never in kWh, kg or ms. History, Grafana and external time-series databases therefore receive the raw value, with no conversion to redo. Zabbix only adds the K/M/G prefixes (base 10) on display, for example 1,500 Wh shown as "1.5 KWh" (Zabbix 7.0 doc, "Unit symbols", "Item value suffixes"). Exception: the unit `B` (bytes) uses base 2, 1,024 B shown as "1 KB" and 1,536 B as "1.5 KB" (same page, JEDEC standard). The `!` prefix prevents this addition; it is only used for `!rpm` and `!EUR`, where a prefix would make no sense.

## Metrics collection

According to the Intersight help page "Data Collection":
- Metrics are collected for IMM and UMM domains, and for **standalone (ISM)** servers. In UMM, only the environmental metrics are collected.
- **Collection interval**: 1 minute with the Advantage license, 10 minutes with Essentials (and in UMM). The default configuration targets Advantage: `{$INTERSIGHT.WINDOW}` = 10 minutes. **With Essentials, it must be set to 30** to keep at least 2 points per window.
- **Prerequisites** without which telemetry stays empty: blades behind an IOM UCS-IOM-2408, UCSX-I-9108-25G or UCSX-I-9108-100G; in IMM, a valid Intersight license on all the servers; on the FIs, a valid NTP configuration.

## To check on each tenant (not guaranteed by the public doc)

These points can be configured without touching the code:

| Point | Where to check | Setting |
|---|---|---|
| Appliance older than the SaaS: metrics missing from its version | help page of this appliance, or Metrics tab of a device | `TELEMETRY_QUERIES` |
| FI fields (`Version`, `OutOfBandIpAddress`) and chassis field (`OperState`) | Intersight API Reference | `src/collector.js`, section 7 |

If one of these points is wrong, the item "API: last errors" shows the call at fault with the HTTP code. The items concerned simply stay empty.

## Known limitations

- **Join**: telemetry is attached to the inventory through `host.id`, "a globally unique host ID", which is the API path of the resource (Cisco DevNet doc, "Host Power and Status"). Its last segment is the `Moid` of the device: two devices with the same name are therefore told apart. Observed on an appliance during design, for `hw.host` and `hw.power_supply` only.
  - **Fallback by name**: another installation may not return `host.id`. A row without `host.id` (absent or empty) is attached by class (`host.type`) and name (`host.name`), or by name alone if `host.type` is unknown. Cisco states that `host.name` is not guaranteed to be unique: if this name is carried by several devices (of the same class, or of any class when `host.type` is unknown), the row is ignored. These homonyms then do not receive this telemetry, rather than mixed values.
- **20,000 objects per list**: the collector reads at most 20,000 objects per list (servers, chassis, FIs, alarms), in pages of 1,000 sorted by `Moid`. If the last page read is full, "API: last errors" shows `<API path>: list truncated at 20000 objects`. The objects read remain monitored, but the following ones (in `Moid` order) are not discovered: the hosts that already existed are treated as lost resources, and the alarms beyond the limit are not reflected. A list of exactly 20,000 objects is reported too: without an extra request, it cannot be told apart from a longer list.
- **Possible double counting**: if the chassis power includes that of the blades, the "Chassis" and "Servers" totals must not be added up. The totals are deliberately kept separate per class.
- **Energy**: `Energy: last 24h` is computed as the average power over 24 h × 24, in Wh. This is exact over a sliding window, provided that there are 24 h of history. Cost and CO₂ divide these Wh by 1000, because the macros are expressed per kWh.
- **History of the master script**: it is set to 0 (the JSON can be large). To debug, use the "Test" button.
- **Size of `intersight.raw`**: this Text item is stored in the database (1 h of history). Zabbix truncates a Text value before storing it: 65,536 bytes on MySQL, 65,536 characters on PostgreSQL (Zabbix 7.0 doc, "Creating an item", "Text data limits"); a MySQL `TEXT` column holds at most 65,535 bytes (MySQL 8.0 doc, "String Data Type Syntax"). The item "API: largest pushed value" of the parent template gives the size, in UTF-8 bytes, of the largest pushed JSON, and "API: device of the largest pushed value" the Moid of its device (host `intersight-<Moid>`). A WARNING trigger fires above `{$INTERSIGHT.RAW.SIZE.WARN}` (50,000 bytes by default). A size in bytes is never less than the number of characters: the same threshold applies to both databases. Not verified: whether the dependent items receive the value before or after this truncation.
- **Temperature**: the triggers compare each sensor with **its own** thresholds (`limit_high_critical`, `limit_high_degraded`), on the devices that report them. CPU temperatures are only reported if the host is powered on.
- **Alarm gone without Cleared**: if an alarm disappears from Intersight without going through Cleared, its problem closes after `{$INTERSIGHT.ALARM.NODATA}` (2 h by default) thanks to `nodata()`. Its items are then disabled and deleted by the discovery (`{$INTERSIGHT.ALARM.LOST.DISABLE}`, `{$INTERSIGHT.ALARM.LOST.DELETE}`). A collector that is down for this long also closes the alarm problems; they open again when the data comes back.
- **Alarm trigger in an unknown state**: if the acknowledgement or suppression item of an alarm becomes unsupported, its trigger may go into an unknown state, because the expression reads these items (for the operational data).
- **Power of the IMM chassis**: it is the sum of the input power of the PSUs (`hw.power`), since Cisco does not report `hw.host.power` for these chassis.

## Data obtained

- **Per device**: average and peak power, power state, energy over 24 h, max temperature, min/max fans, PSUs (LLD: utilization and output), ports (filterable LLD), critical and warning alarms, model, serial number, firmware, management IP. The Zabbix inventory fields are filled in automatically.
- **Per type** (LLD on the models, group `Intersight/<Class>/<Model>`): sum, average, min, max, number of devices, energy, cost, CO₂, max temperature.
- **Per class**: total power, energy, cost and CO₂ over 24 h.
- **Alarms**: one Zabbix problem per Intersight alarm, on the host of its device (or on the parent host for the platform alarms), closed when the alarm goes to Cleared.
- **Health**: calls, errors, duration, pushed and rejected values, size of the largest pushed JSON, missing data, global alarms.

## hs2019 signing performance

Pure-JavaScript ECDSA is costly in the Duktape interpreter. A cycle requires at least 13 signatures (4 lists + 9 telemetry requests), plus one per extra page. The measurement is the item **"API: signing time (hs2019)"**. A trigger fires when the cycle duration ("API: run duration") is above 90 s over 3 consecutive cycles (item timeout: 120 s). If it does, increase the interval or the timeout of the item.

## License

This project is distributed under the **GNU Affero General Public License, version 3 only** (`AGPL-3.0-only`), like Zabbix: full text in [LICENSE](LICENSE). It can be used, modified and redistributed; anyone who distributes a modified version, or lets others use it over a network, must publish its source code under the same license.

The Cisco documentation used to build the metrics catalog is not included and is not covered by this license.
