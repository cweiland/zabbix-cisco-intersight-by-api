// Intersight alarms mirrored as Zabbix problems (collector side and template side).
// Fixture alarms only (fictitious Moids, names and codes): no value from a real appliance.
// Facts checked on the user's appliance (CLAUDE.md, 2026-11-26): AncestorMoId of an alarm is the
// Moid of its server / chassis / FI; alarms without ancestor have AncestorMoId = ''; the combined
// filter "not Cleared or Cleared since <date>" is accepted.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
const alarmRequests = [];
let pushedValues = [];
let failAlarmRequest = false;   // second scenario: cond/Alarms answers HTTP 500
let failedInventoryPath = null;  // third scenario: this inventory list answers HTTP 500
const verified = [];             // one entry per Intersight request: signature valid or not

const FIXTURE_ALARMS = [
  // Acknowledged and not suppressed: still pushed with ack=1.
  { Moid: 'alarm-srv', Name: 'FixtureServerAlarm', Code: 'F0001', Severity: 'Critical', Acknowledge: 'Acknowledge',
    AcknowledgeBy: 'fixture-person', Suppressed: false, AncestorMoId: 'srv1', AncestorMoType: 'compute.RackUnit',
    AffectedMoDisplayName: 'fixture-target-1', Description: 'fixture description', LastTransitionTime: '2026-01-01T00:00:00Z' },
  { Moid: 'alarm-cha', Name: 'FixtureChassisAlarm', Code: 'F0002', Severity: 'Warning', Acknowledge: 'None',
    Suppressed: true, AncestorMoId: 'cha1', AncestorMoType: 'equipment.Chassis', AffectedMoDisplayName: 'fixture-target-2' },
  { Moid: 'alarm-fi', Name: 'FixtureFiAlarm', Code: 'F0003', Severity: 'Info', Acknowledge: 'None',
    Suppressed: false, AncestorMoId: 'fi1', AncestorMoType: 'network.Element', AffectedMoDisplayName: 'fixture-target-3' },
  // Recently Cleared: pushed with severity 0 (closes the problem).
  { Moid: 'alarm-cleared', Name: 'FixtureClearedAlarm', Code: 'F0004', Severity: 'Cleared', OrigSeverity: 'Warning',
    Acknowledge: 'None', Suppressed: false, AncestorMoId: 'srv1', AncestorMoType: 'compute.RackUnit' },
  // No ancestor (platform object) and unknown ancestor: both go to platform_alarms.
  { Moid: 'alarm-platform', Name: 'FixturePlatformAlarm', Code: 'F0005', Severity: 'Warning', Acknowledge: 'None',
    Suppressed: false, AncestorMoId: '', AncestorMoType: '' },
  { Moid: 'alarm-unknown', Name: 'FixtureUnknownAncestorAlarm', Code: 'F0006', Severity: 'Critical', Acknowledge: 'None',
    Suppressed: false, AncestorMoId: 'not-a-device', AncestorMoType: 'compute.Blade' },
  // Severity "None" (SDK enum): not pushed (user decision), still counted as info as before.
  { Moid: 'alarm-none', Name: 'FixtureNoSeverityAlarm', Code: 'F0007', Severity: 'None', Acknowledge: 'None',
    Suppressed: false, AncestorMoId: 'srv1' }
];

global.HttpRequest = function () { this.headers = []; };
HttpRequest.prototype.clearHeader = function () { this.headers = []; };
HttpRequest.prototype.addHeader = function (header) { this.headers.push(header); };
HttpRequest.prototype.getStatus = function () { return this.status; };
// Checks the hs2019 signature of one request against the test key (as in
// tests/scenario_appliance_metrics.test.js).
HttpRequest.prototype.verifySignature = function (method, url) {
  const byName = {};
  this.headers.forEach(header => {
    const separator = header.indexOf(': ');
    byName[header.slice(0, separator).toLowerCase()] = header.slice(separator + 2);
  });
  const signingString = `(request-target): ${method} ${url.replace('https://intersight.com', '')}\n` +
    `host: ${byName.host}\ndate: ${byName.date}\ndigest: ${byName.digest}`;
  const signature = /signature="([^"]+)"/.exec(byName.authorization || '');
  verified.push(!!signature && crypto.verify('sha256', Buffer.from(signingString), ecKey.publicKey,
    Buffer.from(signature[1], 'base64')));
};
HttpRequest.prototype.get = function (url) {
  this.status = 200;
  this.verifySignature('get', url);
  if (url.includes('cond/Alarms') && failAlarmRequest) { this.status = 500; return 'fixture server error'; }
  if (failedInventoryPath && url.includes(failedInventoryPath)) { this.status = 500; return 'fixture server error'; }
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [{ Moid: 'srv1', Name: 'fixture-server', Model: 'UCSC-C220-M6S', ChassisId: '0' }] });
  if (url.includes('Chasses')) return toJson({ Results: [{ Moid: 'cha1', Name: 'fixture-chassis', Model: 'UCSX-9508' }] });
  if (url.includes('ElementSummaries')) return toJson({ Results: [{ Moid: 'fi1', Name: 'fixture-fi', Model: 'UCS-FI-6454' }] });
  if (url.includes('cond/Alarms')) { alarmRequests.push(url); return toJson({ Results: FIXTURE_ALARMS }); }
  return toJson({ Results: [] });
};
HttpRequest.prototype.post = function (url, body) {
  this.status = 200;
  if (url.includes('api_jsonrpc')) {
    pushedValues = JSON.parse(body).params;
    return toJson({ result: { data: pushedValues.map(() => ({ itemid: '1' })) } });
  }
  this.verifySignature('post', url);
  return '[]';
};

const collector = new Function('value', fs.readFileSync(process.env.COLLECTOR_CODE_FILE ||
  path.join(__dirname, '..', 'src', 'collector.js'), 'utf8'));
const runCollector = () => JSON.parse(collector(toJson({ key_id: 'K', api_host: 'intersight.com',
  private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }),
  zbx_url: 'https://zabbix.example.com/api_jsonrpc.php', zbx_token: 'fixture-token' })));
const runStart = Date.now();
const output = runCollector();

const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
const pushedDevice = moid => JSON.parse(pushedValues.find(v => v.host === 'intersight-' + moid).value);
const alarmIds = list => (list || []).map(a => a.id).sort().join(',');

// --- Collector
check('no errors', output.api.errors.length === 0);
check('exactly one request to cond/Alarms', alarmRequests.length === 1);
const query = new URLSearchParams(alarmRequests[0].split('?')[1]);
const filterMatch = /^Severity ne 'Cleared' or \(Severity eq 'Cleared' and LastTransitionTime gt (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\)$/
  .exec(query.get('$filter'));
check('combined filter: not Cleared, or Cleared since <date without milliseconds>', !!filterMatch);
const sinceMs = filterMatch ? Date.parse(filterMatch[1]) : NaN;
check('default Cleared window is 1 day', Math.abs(runStart - 86400000 - sinceMs) < 120000);
check('$select lists the alarm fields and not AcknowledgeBy',
  query.get('$select') === 'Moid,Name,Code,Severity,Description,Acknowledge,Suppressed,AncestorMoId,' +
  'AncestorMoType,LastTransitionTime,CreationTime,AffectedMoDisplayName' && !query.get('$select').includes('AcknowledgeBy'));

check('server alarm attached through AncestorMoId (Cleared one included, Severity None left out)',
  alarmIds(pushedDevice('srv1').alarms) === 'alarm-cleared,alarm-srv');
check('chassis alarm attached through AncestorMoId', alarmIds(pushedDevice('cha1').alarms) === 'alarm-cha');
check('FI alarm attached through AncestorMoId', alarmIds(pushedDevice('fi1').alarms) === 'alarm-fi');
check('empty and unknown ancestors go to platform_alarms', alarmIds(output.platform_alarms) === 'alarm-platform,alarm-unknown');
check('platform_alarms keep their AncestorMoType',
  output.platform_alarms.find(a => a.id === 'alarm-unknown').ancestor_type === 'compute.Blade' &&
  output.platform_alarms.find(a => a.id === 'alarm-platform').ancestor_type === '');

const serverAlarm = pushedDevice('srv1').alarms.find(a => a.id === 'alarm-srv');
check('alarm object fields', toJson(serverAlarm) === toJson({ id: 'alarm-srv', name: 'FixtureServerAlarm', code: 'F0001',
  severity: 3, ack: 1, suppressed: 0, target: 'fixture-target-1', description: 'fixture description',
  last_transition: '2026-01-01T00:00:00Z' }));
check('recent Cleared alarm pushed with severity 0', pushedDevice('srv1').alarms.find(a => a.id === 'alarm-cleared').severity === 0);
check('severity numbers: Warning 2, Info 1; suppressed=1 read',
  pushedDevice('cha1').alarms[0].severity === 2 && pushedDevice('cha1').alarms[0].suppressed === 1 &&
  pushedDevice('fi1').alarms[0].severity === 1);
check('AcknowledgeBy and its value are in no pushed or returned JSON',
  !pushedValues.some(v => v.value.includes('AcknowledgeBy') || v.value.includes('fixture-person')) &&
  !toJson(output).includes('fixture-person'));
check('alarm counts unchanged: open and unacknowledged only (critical 1, warning 2, info 2)',
  toJson(output.alarms) === toJson({ critical: 1, warning: 2, info: 2 }));

check('parent result: no alarms list in servers, chassis or fis (only platform_alarms)',
  ['servers', 'chassis', 'fis'].every(list => output[list].length > 0 && output[list].every(d => !('alarms' in d))));
check('pushed JSON of every device holds its alarms list',
  pushedValues.length === 3 && pushedValues.every(v => Array.isArray(JSON.parse(v.value).alarms)));

// --- Second scenario: the cond/Alarms request fails
failAlarmRequest = true;
pushedValues = [];
const failedOutput = runCollector();
check('failed alarm request: devices still pushed, none with an alarms list',
  pushedValues.length === 3 && pushedValues.every(v => !('alarms' in JSON.parse(v.value))));
check('failed alarm request: no platform_alarms in the result', !('platform_alarms' in failedOutput));
check('failed alarm request: error reported in api.errors',
  failedOutput.api.errors.some(e => e.startsWith('alarms: ') && e.includes('cond/Alarms') && e.includes('HTTP 500')));

// --- Third scenario: one inventory list (chassis) fails, alarms are read
failAlarmRequest = false;
failedInventoryPath = 'equipment/Chasses';
pushedValues = [];
const partialOutput = runCollector();
check('failed chassis list: no platform_alarms in the result (the chassis alarm would land there)',
  !('platform_alarms' in partialOutput));
check('failed chassis list: alarms of the devices read are still pushed',
  pushedValues.length === 2 && alarmIds(pushedDevice('srv1').alarms) === 'alarm-cleared,alarm-srv' &&
  alarmIds(pushedDevice('fi1').alarms) === 'alarm-fi');
check('failed chassis list: error reported in api.errors',
  partialOutput.api.errors.some(e => e.startsWith('chassis: ') && e.includes('HTTP 500')));

check('signatures of every Intersight request verified (' + verified.filter(Boolean).length + '/' + verified.length + ')',
  verified.length > 0 && verified.every(Boolean));

// --- Template
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const templateNames = ['Cisco Intersight Server by push', 'Cisco Intersight Chassis by push',
  'Cisco Intersight FI by push', 'Cisco Intersight by API'];
// Text of each template block, from "- uuid:" + "template: <name>" to the next template.
const templateBlocks = yaml.split(/\n  - uuid: \w+\n    template: /).slice(1);
const blockOf = name => templateBlocks.find(block => block.startsWith(name + '\n'));
const ruleOf = name => {
  const block = blockOf(name) || '';
  const start = block.indexOf('      name: Intersight alarms\n');
  if (start < 0) return '';
  const next = block.slice(start + 1).search(/\n    - uuid: /);
  return next < 0 ? block.slice(start) : block.slice(start, start + 1 + next);
};
// Plain text search (no regular expression built from the name): the "value:" line that
// follows "macro: '{$<name>}'".
const macroValue = (block, name) => {
  const start = block.indexOf("macro: '{$" + name + "}'\n");
  if (start < 0) return null;
  const valueLine = block.slice(start).split('\n')[1].trim();
  return valueLine.startsWith('value: ') ? valueLine.slice('value: '.length).replace(/'/g, '') : null;
};
const durationSeconds = text => {
  const match = /^(\d+)([smhdw]?)$/.exec(text || '');
  return match ? +match[1] * { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]] : NaN;
};

for (const name of templateNames) {
  const rule = ruleOf(name), block = blockOf(name) || '';
  const tpl = name, item = f => `/${tpl}/intersight.alarm.${f}[{#ALARM.ID}]`;
  check(`${name}: "Intersight alarms" discovery present`, rule !== '');
  check(`${name}: master and path`, name === 'Cisco Intersight by API'
    ? /key: intersight\.collect\n/.test(rule) && rule.includes('- $.platform_alarms\n')
    : /key: intersight\.raw\n/.test(rule) && rule.includes('- $.alarms\n'));
  check(`${name}: lost resources fields hold exactly one macro`,
    rule.includes("\n      lifetime_type: DELETE_AFTER\n      lifetime: '{$INTERSIGHT.ALARM.LOST.DELETE}'\n") &&
    rule.includes("\n      enabled_lifetime_type: DISABLE_AFTER\n      enabled_lifetime: '{$INTERSIGHT.ALARM.LOST.DISABLE}'\n"));
  check(`${name}: default delete delay longer than disable delay`,
    durationSeconds(macroValue(block, 'INTERSIGHT.ALARM.LOST.DELETE')) > durationSeconds(macroValue(block, 'INTERSIGHT.ALARM.LOST.DISABLE')));
  check(`${name}: {$INTERSIGHT.ALARM.NODATA} above the 1h heartbeat`,
    durationSeconds(macroValue(block, 'INTERSIGHT.ALARM.NODATA')) > 3600 && (rule.match(/\n\s+- 1h\n/g) || []).length === 3);
  const listPath = name === 'Cisco Intersight by API' ? '$.platform_alarms' : '$.alarms';
  check(`${name}: discovery rule and its three item prototypes discard the value on JSONPath error`,
    rule.includes(`- ${listPath}\n        error_handler: DISCARD_VALUE\n`) &&
    ['severity', 'ack', 'suppressed'].every(f =>
      rule.includes(`- ${listPath}[?(@.id=='{#ALARM.ID}')].${f}.first()\n          error_handler: DISCARD_VALUE\n`)));
  check(`${name}: LLD macros`, ['ID', 'NAME', 'CODE', 'TARGET'].every(m => rule.includes(`lld_macro: '{#ALARM.${m}}'`)));
  check(`${name}: severity, ack, suppressed prototypes with value maps`,
    ['severity', 'ack', 'suppressed'].every(f => rule.includes(`key: intersight.alarm.${f}[{#ALARM.ID}]\n`)) &&
    ['severity', 'acknowledged', 'suppressed'].every(v => rule.includes('name: Intersight alarm ' + v + '\n') &&
      block.includes('  name: Intersight alarm ' + v + '\n      mappings:')));
  for (const [level, priority] of [[3, 'HIGH'], [2, 'WARNING'], [1, 'INFO']]) {
    const expression = `last(${item('severity')})=${level} and last(${item('ack')})>=0 and ` +
      `last(${item('suppressed')})>=0 and nodata(${item('severity')},{$INTERSIGHT.ALARM.NODATA})=0`;
    const trigger = new RegExp('expression: ' + expression.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') +
      "\\n\\s+name: 'Intersight alarm: \\{#ALARM\\.NAME\\} on \\{#ALARM\\.TARGET\\}'\\n\\s+priority: " + priority +
      "\\n\\s+opdata: 'Acknowledged in Intersight: \\{ITEM\\.LASTVALUE2\\}, suppressed: \\{ITEM\\.LASTVALUE3\\}'\\n");
    check(`${name}: severity ${level} -> ${priority}, expression severity/ack/suppressed/nodata, ` +
      'opdata LASTVALUE2 = ack (function 2), LASTVALUE3 = suppressed (function 3)', trigger.test(rule));
  }
  check(`${name}: tags component=alarm and alarm-code`,
    (rule.match(/- tag: component\n\s+value: alarm\n\s+- tag: alarm-code\n\s+value: '\{#ALARM\.CODE\}'\n/g) || []).length === 6);
}
check('parent passes {$INTERSIGHT.ALARM.CLEARED.WINDOW} (default 1d) to the script',
  /- name: alarm_cleared_window\n\s+value: '\{\$INTERSIGHT\.ALARM\.CLEARED\.WINDOW\}'/.test(yaml) &&
  macroValue(blockOf('Cisco Intersight by API'), 'INTERSIGHT.ALARM.CLEARED.WINDOW') === '1d');
