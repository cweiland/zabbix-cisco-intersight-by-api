// The script embedded in the template is what Zabbix runs: a comment-stripped copy of
// src/collector.js (Zabbix limit: 65535 characters). This test extracts it from the YAML,
// checks its size and syntax, then reruns the collector tests against it.
// Set COLLECTOR_CODE_FILE to run any collector test against another copy of the script.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const ZABBIX_MAX_SCRIPT_LENGTH = 65535;
const check = (label, condition) => { console.log((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) process.exitCode = 1; };

// Extract the literal block under "params: |" of the Script item (8-space indentation).
const yamlLines = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8').split('\n');
const start = yamlLines.indexOf('      params: |') + 1;
const scriptLines = [];
for (let i = start; i < yamlLines.length && (yamlLines[i] === '' || yamlLines[i].startsWith('        ')); i++) {
  scriptLines.push(yamlLines[i].slice(8));
}
while (scriptLines.length && scriptLines[scriptLines.length - 1] === '') scriptLines.pop();
const script = scriptLines.join('\n') + '\n';

check('embedded script found in the template', start > 0 && script.includes('initializeAuthentication();'));
check(`embedded script fits Zabbix limit (${script.length} <= ${ZABBIX_MAX_SCRIPT_LENGTH} characters)`, script.length <= ZABBIX_MAX_SCRIPT_LENGTH);
check('embedded script is ES5 (no let / const / arrow / template string)', !/\blet |\bconst |=>|`/.test(script));
let compiles = true; try { new Function('value', script); } catch (e) { compiles = false; }
check('embedded script compiles', compiles);

const scriptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zbx-')), 'embedded_collector.js');
fs.writeFileSync(scriptFile, script);
for (const testFile of ['auth_oauth.test.js', 'auth_rsa.test.js', 'scenario_appliance_metrics.test.js', 'scenario_support_matrix.test.js', 'units.test.js']) {
  let passed = true;
  try {
    execFileSync(process.execPath, [path.join(__dirname, testFile)], { encoding: 'utf8', timeout: 240000, env: Object.assign({}, process.env, { COLLECTOR_CODE_FILE: scriptFile }) });
  } catch (e) { passed = false; process.stdout.write(e.stdout || ''); }
  check(`${testFile} passes on the embedded script`, passed);
}
