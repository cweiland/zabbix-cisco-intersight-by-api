// Tests of the dev container firewall (.devcontainer/intersight-init-firewall.sh) and of the
// container settings that keep it effective. The script runs with stub commands (iptables,
// ip6tables, ipset, dig, curl, ip...) that only log their calls: no root, no network.
// Covers the points raised by the Copilot review of PR #1.
// Usage: node tests/firewall_script.test.js   (Linux / macOS with bash; run in the dev container and CI)
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

// Linux only (bash, GNU sed -z, symlinks): the script runs in the Linux dev container. Skipped
// elsewhere (macOS, native Windows) so that `node tests/run_all.js` still works there; it
// always runs in the dev container and in the CI (ubuntu-latest).
if (process.platform !== 'linux') {
  console.log('SKIP firewall tests: Linux only (current platform: ' + process.platform + ')');
  process.exit(0);
}
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
//   ipv6Conf       disable_ipv6 value per entry of /proc/sys/net/ipv6/conf ('absent': no
//                  IPv6 in the kernel; the value 'unreadable' makes the file unreadable)
//   resolvConf     content of /etc/resolv.conf (default: one IPv4 resolver)
function runFirewall(options) {
  options = options || {};
  const runDir = fs.mkdtempSync(path.join(workDir, 'run-'));
  const environFile = path.join(runDir, 'environ');
  const ipv6ConfDir = path.join(runDir, 'ipv6-conf');
  const logFile = path.join(runDir, 'calls.log');
  const resolvFile = path.join(runDir, 'resolv.conf');
  fs.writeFileSync(resolvFile, options.resolvConf !== undefined ? options.resolvConf : 'nameserver 192.168.65.7\n');
  fs.writeFileSync(environFile, Object.keys(options.environ || {}).map(function (key) {
    return key + '=' + options.environ[key] + '\0';
  }).join(''));
  if (options.ipv6Conf !== 'absent') {
    const ipv6Conf = options.ipv6Conf || { all: '0', default: '0', lo: '0', eth0: '0' };
    Object.keys(ipv6Conf).forEach(function (entry) {
      fs.mkdirSync(path.join(ipv6ConfDir, entry), { recursive: true });
      // A directory in place of the file: reading it fails, as an unreadable flag would.
      if (ipv6Conf[entry] === 'unreadable') { fs.mkdirSync(path.join(ipv6ConfDir, entry, 'disable_ipv6')); }
      else { fs.writeFileSync(path.join(ipv6ConfDir, entry, 'disable_ipv6'), ipv6Conf[entry] + '\n'); }
    });
  }
  fs.writeFileSync(logFile, '');
  const scriptCopy = path.join(runDir, 'firewall.sh');
  fs.writeFileSync(scriptCopy, scriptSource
    .split('/proc/1/environ').join(environFile)
    .split('/proc/sys/net/ipv6/conf').join(ipv6ConfDir)
    .split('/etc/resolv.conf').join(resolvFile)
    // The script resets PATH to system directories: put the stubs in front of them.
    .split('export PATH=/usr/sbin:/usr/bin:/sbin:/bin').join('export PATH=' + stubDir + ':/usr/sbin:/usr/bin:/sbin:/bin'));
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

// ---------------------------------------------------------------- no host exception (reviews: /24, then gateway)
// Review of 674d224: Docker publishes other containers' ports on the gateway address too.
check('no exception for the default gateway (172.17.0.1)', nominal.calls.filter(function (c) { return /172\.17\.0\.1/.test(c); }).length === 0,
  nominal.calls.filter(function (c) { return /172\.17/.test(c); }).join(' | '));
check('no /24 host network exception', nominal.calls.filter(function (c) { return /\/24 -j ACCEPT/.test(c); }).length === 0);
check('the routing table is no longer read (no gateway rule to build)', firstIndexMatching(nominal.calls, /^ip route/) === -1);

// ---------------------------------------------------------------- IPv6 (review: iptables covers IPv4 only)
const ip6Drop = indexOfCall(nominal.calls, 'ip6tables -P OUTPUT DROP');
const ip6Flush = indexOfCall(nominal.calls, 'ip6tables -F');
check('IPv6 OUTPUT DROP, set before the IPv6 flush', ip6Drop !== -1 && ip6Drop < ip6Flush);
check('IPv6 loopback kept', nominal.calls.indexOf('ip6tables -A OUTPUT -o lo -j ACCEPT') !== -1);
const ipv6Open = runFirewall({ env: { FW_NO_IP6TABLES: '1', FW_IPV6_ROUTE: '1' } });
check('ip6tables unusable with an IPv6 route and IPv6 enabled: stop', ipv6Open.status !== 0 && /IPv6/.test(ipv6Open.output));
const ipv6Disabled = runFirewall({ env: { FW_NO_IP6TABLES: '1', FW_IPV6_ROUTE: '1' },
  ipv6Conf: { all: '1', default: '1', lo: '0', eth0: '1' } });
check('ip6tables unusable but IPv6 disabled on every interface (loopback aside): continue', ipv6Disabled.status === 0, ipv6Disabled.output);
// Review of 674d224: reading conf/all/disable_ipv6 proves nothing (kernel ip-sysctl doc).
const ipv6AllButEth0 = runFirewall({ env: { FW_NO_IP6TABLES: '1' }, ipv6Conf: { all: '1', default: '1', lo: '1', eth0: '0' } });
check('ip6tables unusable, all=1 but eth0=0: stop', ipv6AllButEth0.status !== 0 && /eth0/.test(ipv6AllButEth0.output), ipv6AllButEth0.output);
const ipv6DefaultOn = runFirewall({ env: { FW_NO_IP6TABLES: '1' }, ipv6Conf: { all: '1', default: '0', lo: '1', eth0: '1' } });
check('ip6tables unusable, default=0 (future interfaces): stop', ipv6DefaultOn.status !== 0 && /default/.test(ipv6DefaultOn.output), ipv6DefaultOn.output);
const ipv6Unreadable = runFirewall({ env: { FW_NO_IP6TABLES: '1' }, ipv6Conf: { all: '1', default: '1', lo: '1', eth0: 'unreadable' } });
check('ip6tables unusable, unreadable flag: stop (fail-closed)', ipv6Unreadable.status !== 0 && /eth0/.test(ipv6Unreadable.output), ipv6Unreadable.output);
// Review of 54c7418: no default route does not make IPv6 unreachable (link-local, fe80::).
const ipv6NoRoute = runFirewall({ env: { FW_NO_IP6TABLES: '1', FW_IPV6_ROUTE: '0' } });
check('ip6tables unusable, IPv6 enabled, no default route: still stop (link-local stays reachable)',
  ipv6NoRoute.status !== 0 && /IPv6/.test(ipv6NoRoute.output), ipv6NoRoute.output);
const ipv6Absent = runFirewall({ env: { FW_NO_IP6TABLES: '1' }, ipv6Conf: 'absent' });
check('ip6tables unusable, kernel without IPv6 (no /proc/sys/net/ipv6/conf): continue', ipv6Absent.status === 0, ipv6Absent.output);

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
check('DNS allowed only towards the resolvers of /etc/resolv.conf (UDP and TCP)',
  nominal.calls.indexOf('iptables -A OUTPUT -p udp -d 192.168.65.7 --dport 53 -j ACCEPT') !== -1 &&
  nominal.calls.indexOf('iptables -A OUTPUT -p tcp -d 192.168.65.7 --dport 53 -j ACCEPT') !== -1 &&
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

// Review of d70fd0a: shared CDN front ends widen the egress; the container never used them
// (VS Code server copied from the host, extensions downloaded on the host).
['marketplace.visualstudio.com', 'vscode.blob.core.windows.net', 'update.code.visualstudio.com'].forEach(function (domain) {
  check('VS Code host not allowed: ' + domain, firstIndexMatching(nominal.calls, new RegExp(domain.replace(/\./g, '\\.'))) === -1);
});

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
  // A directory writable by "vscode" first in PATH (as /usr/local/share/nvm/current/bin with
  // the devcontainers Node feature), holding fake commands that must never run as root.
  const writableDir = path.join(workDir, 'writable-by-vscode');
  fs.mkdirSync(writableDir);
  ['sh', 'sleep', 'iptables', 'curl'].forEach(function (name) {
    fs.writeFileSync(path.join(writableDir, name), '#!/bin/sh\necho SUBSTITUTE_RAN ' + name + '\n', { mode: 0o755 });
  });
  function runEntrypoint(firewallExitCode) {
    const runDir = fs.mkdtempSync(path.join(workDir, 'entry-'));
    const fakeFirewall = path.join(runDir, 'firewall.sh');
    fs.writeFileSync(fakeFirewall, '#!/bin/bash\necho FIREWALL_RAN "$#" "PATH=$PATH"\nexit ' + firewallExitCode + '\n', { mode: 0o755 });
    const entryCopy = path.join(runDir, 'entrypoint.sh');
    fs.writeFileSync(entryCopy, entrypointSource.split('/usr/local/bin/intersight-init-firewall.sh').join(fakeFirewall));
    const result = spawnSync('bash', [entryCopy, 'sh', '-c', 'echo CMD_RAN'], { encoding: 'utf8',
      env: Object.assign({}, process.env, { PATH: writableDir + ':' + process.env.PATH }) });
    return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
  }
  const entryOk = runEntrypoint(0);
  check('entrypoint: firewall run without argument, then the CMD', entryOk.status === 0 &&
    /FIREWALL_RAN 0/.test(entryOk.output) && /CMD_RAN/.test(entryOk.output), entryOk.output);
  // Review of 32148f8: a PATH directory writable by "vscode" must not give root commands.
  check('entrypoint: PATH reset to system directories before the firewall and the CMD',
    /FIREWALL_RAN 0 PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\n/.test(entryOk.output) &&
    !/SUBSTITUTE_RAN/.test(entryOk.output), entryOk.output);
  check('firewall script resets PATH to system directories itself',
    /^export PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/m.test(scriptSource));
  const entryKo = runEntrypoint(1);
  check('entrypoint: a failing firewall stops it before the CMD (container ends)', entryKo.status !== 0 &&
    !/CMD_RAN/.test(entryKo.output), entryKo.output);
} else {
  check('entrypoint script .devcontainer/intersight-entrypoint.sh exists', false);
}
// Review of 674d224: files that the HOST executes must not be writable from the container
// (initializeCommand in devcontainer.json, git hooks and git config used by git on the host,
// VS Code workspace settings and tasks when the folder is reopened locally).
// .git as a whole: a writable .git/commondir alone redirects git to another config and other
// hooks (checked with git 2.43), so protecting only .git/config and .git/hooks is not enough.
['.devcontainer', '.git', '.vscode'].forEach(function (relative) {
  const target = '${containerWorkspaceFolder}/' + relative;
  check('read-only in the container: ' + relative, (devcontainer.mounts || []).some(function (m) {
    return m.indexOf('source=${localWorkspaceFolder}/' + relative + ',') === 0 &&
      m.indexOf('target=' + target + ',') !== -1 && /,type=bind,readonly$/.test(m);
  }), JSON.stringify(devcontainer.mounts));
});
check('.vscode exists in the repository (a bind mount needs an existing source)',
  fs.existsSync(path.join(repoRoot, '.vscode')));
// Review of 674d224: without CLAUDE_CONFIG_DIR, ~/.claude.json lives outside the volume
// (Anthropic's reference devcontainer.json sets it to the volume path).
check('CLAUDE_CONFIG_DIR points to the Claude Code volume',
  (devcontainer.containerEnv || {}).CLAUDE_CONFIG_DIR === '/home/vscode/.claude');
const claudeMount = (devcontainer.mounts || []).filter(function (m) { return /target=\/home\/vscode\/\.claude/.test(m); });
check('Claude Code volume mount point created and owned by vscode in the image', claudeMount.length === 1 &&
  /mkdir -p \/home\/vscode\/\.claude[^\n]*chown vscode:vscode \/home\/vscode\/\.claude/.test(dockerfile));

fs.rmSync(workDir, { recursive: true, force: true });
if (failures) { console.log(failures + ' failure(s)'); }
process.exitCode = failures ? 1 : 0;
