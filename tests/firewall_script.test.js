// Tests of the dev container firewall (.devcontainer/intersight-init-firewall.sh) and of the
// container settings that keep it effective. The script runs with stub commands (iptables,
// ip6tables, ipset, dig, curl, ip...) that only log their calls: no root, no network.
// Covers the points raised by the Copilot review of PR #1.
// Usage: node tests/firewall_script.test.js   (Linux / macOS with bash; run in the dev container and CI)
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const scriptSource = fs.readFileSync(path.join(repoRoot, '.devcontainer/intersight-init-firewall.sh'), 'utf8');
let failures = 0;
function check(name, condition, details) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition || !details ? '' : '\n     ' + details));
  if (!condition) { failures++; }
}

// ---------------------------------------------------------------- stub environment
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-test-'));
const stubDir = path.join(workDir, 'bin');
fs.mkdirSync(stubDir);
// One stub for every command: logs "<name> <args>", fails when FW_FAIL_ON matches the call.
fs.writeFileSync(path.join(stubDir, 'stub'), `#!/usr/bin/env bash
name=$(basename "$0")
call="$name $*"
printf '%s\\n' "$call" >> "$FW_LOG"
if [ -n "\${FW_FAIL_ON:-}" ] && [ "$call" = "$FW_FAIL_ON" ]; then exit 1; fi
case "$name" in
  ip6tables) [ "\${FW_NO_IP6TABLES:-0}" = 1 ] && exit 3 ;;
  ip) if [ "$1" = "-6" ]; then [ "\${FW_IPV6_ROUTE:-0}" = 1 ] && echo "default via fe80::1 dev eth0"
      else echo "default via 172.17.0.1 dev eth0"; echo "172.17.0.0/16 dev eth0 proto kernel"; fi ;;
  dig) domain="\${@: -1}"
       [ -n "\${FW_DIG_FAIL:-}" ] && [ "$domain" = "$FW_DIG_FAIL" ] && exit 9
       echo "$domain. 60 IN A 198.51.100.7" ;;
  curl) case "$*" in
          *api.github.com/meta*) echo '{"web":["192.30.252.0/22"],"api":["192.30.252.0/22"],"git":["192.30.252.0/22","2a0a:a440::/29"]}' ;;
          *example.com*) exit 7 ;;
        esac ;;
  jq) input=$(cat); case "$*" in *-e*) exit 0 ;; *) printf '192.30.252.0/22\\n2a0a:a440::/29\\n' ;; esac ;;
  aggregate) cat ;;
esac
exit 0
`, { mode: 0o755 });
['iptables', 'ip6tables', 'iptables-save', 'ipset', 'dig', 'curl', 'ip', 'jq', 'aggregate'].forEach(function (name) {
  fs.symlinkSync('stub', path.join(stubDir, name));
});

// Runs a copy of the script whose /proc paths point to test files.
//   environ        variables of the container's PID 1 (where the appliance is read)
//   ipv6Disabled   content of /proc/sys/net/ipv6/conf/all/disable_ipv6
//   resolvConf     content of /etc/resolv.conf (default: one IPv4 resolver)
function runFirewall(options) {
  options = options || {};
  const runDir = fs.mkdtempSync(path.join(workDir, 'run-'));
  const environFile = path.join(runDir, 'environ');
  const ipv6File = path.join(runDir, 'disable_ipv6');
  const logFile = path.join(runDir, 'calls.log');
  const resolvFile = path.join(runDir, 'resolv.conf');
  fs.writeFileSync(resolvFile, options.resolvConf !== undefined ? options.resolvConf : 'nameserver 192.168.65.7\n');
  fs.writeFileSync(environFile, Object.keys(options.environ || {}).map(function (key) {
    return key + '=' + options.environ[key] + '\0';
  }).join(''));
  if (options.ipv6Disabled !== 'absent') { fs.writeFileSync(ipv6File, (options.ipv6Disabled || '0') + '\n'); }
  fs.writeFileSync(logFile, '');
  const scriptCopy = path.join(runDir, 'firewall.sh');
  fs.writeFileSync(scriptCopy, scriptSource
    .split('/proc/1/environ').join(environFile)
    .split('/proc/sys/net/ipv6/conf/all/disable_ipv6').join(ipv6File)
    .split('/etc/resolv.conf').join(resolvFile));
  const result = spawnSync('bash', [scriptCopy].concat(options.args || []), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, options.env || {}, {
      PATH: stubDir + ':' + process.env.PATH,
      FW_LOG: logFile
    })
  });
  const calls = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, output: (result.stdout || '') + (result.stderr || ''), calls: calls };
}
function indexOfCall(calls, call) { return calls.indexOf(call); }
function firstIndexMatching(calls, regex) {
  for (let i = 0; i < calls.length; i++) { if (regex.test(calls[i])) { return i; } }
  return -1;
}
const httpsRule = /-p tcp -d \S+ --dport 443 -j ACCEPT/;

// ---------------------------------------------------------------- nominal run
const nominal = runFirewall({ environ: { INTERSIGHT_APPLIANCE_HOST: '' } });
check('nominal run succeeds', nominal.status === 0, nominal.output);
check('no appliance rule without INTERSIGHT_APPLIANCE_HOST', firstIndexMatching(nominal.calls, httpsRule) === -1);

// ---------------------------------------------------------------- fail-closed (review: DROP before flush)
const dropIndex = indexOfCall(nominal.calls, 'iptables -P OUTPUT DROP');
const firstFlushIndex = firstIndexMatching(nominal.calls, /^iptables (-t \w+ )?-F$/);
check('IPv4 OUTPUT DROP is set before the first flush', dropIndex !== -1 && dropIndex < firstFlushIndex,
  'DROP at ' + dropIndex + ', first flush at ' + firstFlushIndex);
const natFailure = runFirewall({ env: { FW_FAIL_ON: 'iptables -t nat -F' } });
check('a failure while flushing the NAT table stops the script', natFailure.status !== 0);
check('... and leaves IPv4 OUTPUT on DROP (fail-closed)', natFailure.calls.indexOf('iptables -P OUTPUT DROP') !== -1 &&
  natFailure.calls.indexOf('iptables -P OUTPUT DROP') < natFailure.calls.indexOf('iptables -t nat -F'));

// ---------------------------------------------------------------- no caller-chosen destination (review: sudo arguments)
const withArgument = runFirewall({ args: ['203.0.113.9'], environ: { INTERSIGHT_APPLIANCE_HOST: '' } });
check('an argument is refused', withArgument.status !== 0);
check('... before any rule is changed', withArgument.calls.filter(function (c) { return /^ip6?tables /.test(c); }).length === 0,
  withArgument.calls.join(' | '));
const withAppliance = runFirewall({ environ: { INTERSIGHT_APPLIANCE_HOST: '203.0.113.9' } });
check('appliance read from the container environment (PID 1): HTTPS rule', withAppliance.status === 0 &&
  withAppliance.calls.indexOf('iptables -I OUTPUT -p tcp -d 203.0.113.9 --dport 443 -j ACCEPT') !== -1, withAppliance.output);
const callerEnvironment = runFirewall({ environ: {}, env: { INTERSIGHT_APPLIANCE_HOST: '203.0.113.9' } });
check('the caller\'s own environment variable is ignored', firstIndexMatching(callerEnvironment.calls, httpsRule) === -1);

// ---------------------------------------------------------------- gateway only (review: /24 exception)
check('host exception limited to the default gateway', nominal.calls.indexOf('iptables -A OUTPUT -d 172.17.0.1 -j ACCEPT') !== -1 &&
  nominal.calls.indexOf('iptables -A INPUT -s 172.17.0.1 -j ACCEPT') !== -1);
check('no /24 host network exception', nominal.calls.filter(function (c) { return /\/24 -j ACCEPT/.test(c); }).length === 0);

// ---------------------------------------------------------------- IPv6 (review: iptables covers IPv4 only)
const ip6Drop = indexOfCall(nominal.calls, 'ip6tables -P OUTPUT DROP');
const ip6Flush = indexOfCall(nominal.calls, 'ip6tables -F');
check('IPv6 OUTPUT DROP, set before the IPv6 flush', ip6Drop !== -1 && ip6Drop < ip6Flush);
check('IPv6 loopback kept', nominal.calls.indexOf('ip6tables -A OUTPUT -o lo -j ACCEPT') !== -1);
const ipv6Open = runFirewall({ env: { FW_NO_IP6TABLES: '1', FW_IPV6_ROUTE: '1' } });
check('ip6tables unusable with an IPv6 route and IPv6 enabled: stop', ipv6Open.status !== 0 && /IPv6/.test(ipv6Open.output));
const ipv6Disabled = runFirewall({ env: { FW_NO_IP6TABLES: '1', FW_IPV6_ROUTE: '1' }, ipv6Disabled: '1' });
check('ip6tables unusable but IPv6 disabled: continue', ipv6Disabled.status === 0, ipv6Disabled.output);
// Review of 54c7418: no default route does not make IPv6 unreachable (link-local, fe80::).
const ipv6NoRoute = runFirewall({ env: { FW_NO_IP6TABLES: '1', FW_IPV6_ROUTE: '0' } });
check('ip6tables unusable, IPv6 enabled, no default route: still stop (link-local stays reachable)',
  ipv6NoRoute.status !== 0 && /IPv6/.test(ipv6NoRoute.output), ipv6NoRoute.output);
const ipv6Absent = runFirewall({ env: { FW_NO_IP6TABLES: '1' }, ipv6Disabled: 'absent' });
check('ip6tables unusable, kernel without IPv6 (no disable_ipv6 file): continue', ipv6Absent.status === 0, ipv6Absent.output);

// ---------------------------------------------------------------- Claude Code sign-in (review of 54c7418)
// code.claude.com/docs/en/network-config: OAuth token exchange, refresh and revocation go to
// platform.claude.com (claude.ai accounts included); claude.ai for claude.ai account authentication.
['api.anthropic.com', 'platform.claude.com', 'claude.ai'].forEach(function (domain) {
  check('Claude Code host allowed: ' + domain, nominal.calls.indexOf('dig +noall +answer A ' + domain) !== -1 &&
    nominal.output.indexOf('Allowed ' + domain + '\n') !== -1);
});

// Review of 711c051: allow_domain runs on the left of "||", where bash disables set -e.
const ipsetFailure = runFirewall({ env: { FW_FAIL_ON: 'ipset add -exist allowed-domains 198.51.100.7' } });
check('a failed ipset insertion stops the script (no "Allowed" line)', ipsetFailure.status !== 0 &&
  !/Allowed api\.github\.com/.test(ipsetFailure.output), ipsetFailure.output);

// ---------------------------------------------------------------- DNS failure (review: dig + pipefail)
const applianceDnsFailure = runFirewall({ environ: { INTERSIGHT_APPLIANCE_HOST: 'appliance.example.test' },
  env: { FW_DIG_FAIL: 'appliance.example.test' } });
check('appliance DNS failure is only a warning', applianceDnsFailure.status === 0 && /WARNING/.test(applianceDnsFailure.output),
  applianceDnsFailure.output);
check('... and the appliance stays unreachable', firstIndexMatching(applianceDnsFailure.calls, httpsRule) === -1);
const requiredDnsFailure = runFirewall({ env: { FW_DIG_FAIL: 'api.anthropic.com' } });
check('required domain DNS failure stops with a clear error', requiredDnsFailure.status !== 0 &&
  /cannot resolve api.anthropic.com/.test(requiredDnsFailure.output), requiredDnsFailure.output);
check('GitHub IPv6 ranges are not added to the IPv4 set', nominal.calls.filter(function (c) { return /2a0a:/.test(c) && /^ipset add/.test(c); }).length === 0);

// ---------------------------------------------------------------- security pass before the next review
// DNS: UDP 53 only towards the container's resolvers; an open port 53 would carry any data anywhere.
check('DNS allowed only towards the resolvers of /etc/resolv.conf',
  nominal.calls.indexOf('iptables -A OUTPUT -p udp -d 192.168.65.7 --dport 53 -j ACCEPT') !== -1 &&
  nominal.calls.filter(function (c) { return /--dport 53/.test(c) && !/ -d /.test(c); }).length === 0,
  nominal.calls.filter(function (c) { return /--dport 53/.test(c); }).join(' | '));
const ipv6OnlyResolver = runFirewall({ resolvConf: 'nameserver fd00::53\n' });
check('no IPv4 resolver: stop with a clear error', ipv6OnlyResolver.status !== 0 &&
  /no IPv4 nameserver/.test(ipv6OnlyResolver.output), ipv6OnlyResolver.output);
// A value starting with "-" would be read by dig as an option.
const optionAppliance = runFirewall({ environ: { INTERSIGHT_APPLIANCE_HOST: '-b192.0.2.1' } });
check('appliance host starting with "-" ignored (never passed to dig)', optionAppliance.status === 0 &&
  /WARNING: ignored invalid appliance host/.test(optionAppliance.output) &&
  firstIndexMatching(optionAppliance.calls, /^dig .*-b192/) === -1 &&
  firstIndexMatching(optionAppliance.calls, httpsRule) === -1, optionAppliance.output);
// The exit status of a process substitution is ignored by bash: a failing aggregate used to
// end with an empty GitHub list and "Firewall ready".
const aggregateFailure = runFirewall({ env: { FW_FAIL_ON: 'aggregate -q' } });
check('a failure while computing the GitHub ranges stops the script', aggregateFailure.status !== 0 &&
  !/Firewall ready/.test(aggregateFailure.output), aggregateFailure.output);

// ---------------------------------------------------------------- container settings
const dockerfile = fs.readFileSync(path.join(repoRoot, '.devcontainer/Dockerfile'), 'utf8');
const devcontainer = JSON.parse(fs.readFileSync(path.join(repoRoot, '.devcontainer/devcontainer.json'), 'utf8'));
// Review of 711c051: a failed postStartCommand does not stop the container, so the firewall
// runs in the image ENTRYPOINT instead. With overrideCommand false, the dev container CLI runs
// ENTRYPOINT + CMD through `exec "$@"` (devcontainers/cli, src/spec-node/singleContainer.ts):
// a failing firewall ends the container.
check('no sudo at all for vscode (base image entry removed, none added)',
  /rm -f \/etc\/sudoers\.d\/vscode/.test(dockerfile) && !/NOPASSWD/.test(dockerfile));
check('overrideCommand is false (the image ENTRYPOINT runs)', devcontainer.overrideCommand === false);
check('image ENTRYPOINT is the firewall entrypoint, CMD keeps the container running',
  /ENTRYPOINT \["\/usr\/local\/bin\/intersight-entrypoint\.sh"\]/.test(dockerfile) && /CMD \["sleep", "infinity"\]/.test(dockerfile));
check('postStartCommand no longer runs the firewall (nor sudo)',
  !/firewall|sudo/.test(devcontainer.postStartCommand || ''), devcontainer.postStartCommand);
const entrypointPath = path.join(repoRoot, '.devcontainer/intersight-entrypoint.sh');
if (fs.existsSync(entrypointPath)) {
  const entrypointSource = fs.readFileSync(entrypointPath, 'utf8');
  function runEntrypoint(firewallExitCode) {
    const runDir = fs.mkdtempSync(path.join(workDir, 'entry-'));
    const fakeFirewall = path.join(runDir, 'firewall.sh');
    fs.writeFileSync(fakeFirewall, '#!/usr/bin/env bash\necho FIREWALL_RAN "$#"\nexit ' + firewallExitCode + '\n', { mode: 0o755 });
    const entryCopy = path.join(runDir, 'entrypoint.sh');
    fs.writeFileSync(entryCopy, entrypointSource.split('/usr/local/bin/intersight-init-firewall.sh').join(fakeFirewall));
    const result = spawnSync('bash', [entryCopy, 'sh', '-c', 'echo CMD_RAN'], { encoding: 'utf8' });
    return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
  }
  const entryOk = runEntrypoint(0);
  check('entrypoint: firewall run without argument, then the CMD', entryOk.status === 0 &&
    /FIREWALL_RAN 0/.test(entryOk.output) && /CMD_RAN/.test(entryOk.output), entryOk.output);
  const entryKo = runEntrypoint(1);
  check('entrypoint: a failing firewall stops it before the CMD (container ends)', entryKo.status !== 0 &&
    !/CMD_RAN/.test(entryKo.output), entryKo.output);
} else {
  check('entrypoint script .devcontainer/intersight-entrypoint.sh exists', false);
}
const claudeMount = (devcontainer.mounts || []).filter(function (m) { return /target=\/home\/vscode\/\.claude/.test(m); });
check('Claude Code volume mount point created and owned by vscode in the image', claudeMount.length === 1 &&
  /mkdir -p \/home\/vscode\/\.claude[^\n]*chown vscode:vscode \/home\/vscode\/\.claude/.test(dockerfile));

fs.rmSync(workDir, { recursive: true, force: true });
if (failures) { console.log(failures + ' failure(s)'); }
process.exitCode = failures ? 1 : 0;
