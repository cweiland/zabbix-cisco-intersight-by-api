// Tests of .devcontainer/check-host-credentials.sh with fake Dev Containers relays: a relay
// that returns a credential, one that answers without credential, one that fails, one that
// hangs, and none at all. The secret must never be printed, and a probe that could not run
// must never be reported as "no credential" (Copilot review of 328b4c8).
// Usage: node tests/check_host_credentials.test.js   (Linux: bash, coreutils timeout, node)
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'linux') {
  console.log('SKIP check-host-credentials tests: Linux only (current platform: ' + process.platform + ')');
  process.exit(0);
}
const repoRoot = path.join(__dirname, '..');
const scriptSource = fs.readFileSync(path.join(repoRoot, '.devcontainer/check-host-credentials.sh'), 'utf8');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credcheck-test-'));
let failures = 0;
function check(name, condition, details) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition || !details ? '' : '\n     ' + details));
  if (!condition) { failures++; }
}

// relayBody: JavaScript of the fake relay, or null for no relay at all.
function runCheck(relayBody) {
  const relayDir = fs.mkdtempSync(path.join(workDir, 'relay-'));
  if (relayBody !== null) {
    fs.writeFileSync(path.join(relayDir, 'vscode-remote-containers-0000.js'), relayBody);
  }
  // The "-server-" script of Dev Containers must be ignored: make it return a credential.
  fs.writeFileSync(path.join(relayDir, 'vscode-remote-containers-server-0000.js'),
    "console.log('password=SERVER-SCRIPT-MUST-BE-IGNORED')\n");
  const scriptCopy = path.join(relayDir, 'check.sh');
  fs.writeFileSync(scriptCopy, scriptSource.replace(/^RELAY_DIR=\/tmp$/m, 'RELAY_DIR=' + relayDir)
    .replace(/^RELAY_TIMEOUT_SECONDS=10$/m, 'RELAY_TIMEOUT_SECONDS=1'));
  const result = spawnSync('bash', [scriptCopy], { encoding: 'utf8', timeout: 20000 });
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

check('the script reads RELAY_DIR and RELAY_TIMEOUT_SECONDS (test hooks still in place)',
  /^RELAY_DIR=\/tmp$/m.test(scriptSource) && /^RELAY_TIMEOUT_SECONDS=10$/m.test(scriptSource));

const leaking = runCheck("console.log('protocol=https\\nhost=github.com\\nusername=u\\npassword=SECRET-TEST')\n");
check('credential returned -> DANGER, exit status 1', leaking.status === 1 && /DANGER/.test(leaking.output), leaking.output);
check('... and the secret is never printed', !/SECRET-TEST/.test(leaking.output), leaking.output);

const empty = runCheck("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
check('relay answers without credential -> OK, exit status 0', empty.status === 0 && /^OK: no GitHub credential/m.test(empty.output), empty.output);
check('... the "-server-" script is not probed', !/SERVER-SCRIPT/.test(empty.output) && empty.status === 0, empty.output);

const failing = runCheck("process.exit(3)\n");
check('relay fails (exit 3) -> UNVERIFIED, exit status 2, never OK',
  failing.status === 2 && /UNVERIFIED: .*exit status 3/.test(failing.output) && !/^OK/m.test(failing.output), failing.output);

const broken = runCheck("this is not JavaScript\n");
check('Node error -> UNVERIFIED, exit status 2', broken.status === 2 && /UNVERIFIED/.test(broken.output), broken.output);

const hanging = runCheck("setTimeout(() => {}, 30000)\n");
check('relay does not answer in time -> UNVERIFIED (timeout), exit status 2',
  hanging.status === 2 && /did not answer within 1 s/.test(hanging.output), hanging.output);

const none = runCheck(null);
check('no relay script -> OK, exit status 0', none.status === 0 && /no Dev Containers relay script/.test(none.output), none.output);

fs.rmSync(workDir, { recursive: true, force: true });
if (failures) { console.log(failures + ' failure(s)'); }
process.exitCode = failures ? 1 : 0;
