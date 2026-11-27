// Host discovery when one inventory request fails (collector side and template side).
// Before: a failed list was sent as [] and the servers / chassis / FI / models rules replaced
// a missing list with [] (CUSTOM_VALUE) and only set lifetime: 7d, so the Zabbix 7.0 import
// defaulted to DISABLE_IMMEDIATELY (ui/include/classes/import/validators/C70XmlValidator.php),
// and disabling "affects lost hosts, items and triggers" (Zabbix 7.0 "Low-level discovery"):
// one failed request disabled every host of that class until the next run.
// Now: the collector leaves out a failed list (and models, built from all three), its count, and
// the chassis blades lists when the server list failed; the rules discard a missing list
// (DISCARD_VALUE), and the four lost-resource fields hold one macro each.
// Fixture devices only (fictitious Moids and names).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
let pushedValues = [];
let failedInventoryPath = null;   // this inventory list answers HTTP 500
let emptyInventoryPath = null;    // this inventory list answers 200 with no device
const verified = [];              // one entry per Intersight request: signature valid or not

global.HttpRequest = function () { this.headers = []; };
HttpRequest.prototype.clearHeader = function () { this.headers = []; };
HttpRequest.prototype.addHeader = function (header) { this.headers.push(header); };
HttpRequest.prototype.getStatus = function () { return this.status; };
// Checks the hs2019 signature of one request against the test key (as in tests/alarms.test.js).
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
  if (failedInventoryPath && url.includes(failedInventoryPath)) { this.status = 500; return 'fixture server error'; }
  if (emptyInventoryPath && url.includes(emptyInventoryPath)) return toJson({ Results: [] });
  // One rack server and one blade of chassis cha1 (EquipmentChassis relationship).
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [
    { Moid: 'srv1', Name: 'fixture-server', Model: 'UCSC-C220-M6S', ChassisId: '0' },
    { Moid: 'bld1', Name: 'fixture-blade', Model: 'UCSX-210C-M7', EquipmentChassis: { Moid: 'cha1' } }] });
  if (url.includes('Chasses')) return toJson({ Results: [{ Moid: 'cha1', Name: 'fixture-chassis', Model: 'UCSX-9508' }] });
  if (url.includes('ElementSummaries')) return toJson({ Results: [{ Moid: 'fi1', Name: 'fixture-fi', Model: 'UCS-FI-6454' }] });
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
const runCollector = () => {
  pushedValues = [];
  return JSON.parse(collector(toJson({ key_id: 'K', api_host: 'intersight.com',
    private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }),
    zbx_url: 'https://zabbix.example.com/api_jsonrpc.php', zbx_token: 'fixture-token' })));
};
const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
const moids = list => (list || []).map(device => device.moid).sort().join(',');
const pushedHosts = () => pushedValues.map(v => v.host).sort().join(',');

// --- Reference run: every list read
const fullOutput = runCollector();
check('all lists read: servers, chassis, fis and models present',
  moids(fullOutput.servers) === 'bld1,srv1' && moids(fullOutput.chassis) === 'cha1' && moids(fullOutput.fis) === 'fi1' &&
  Array.isArray(fullOutput.models) && fullOutput.models.length === 4);
check('all lists read: counts 2 servers, 1 chassis, 1 FI',
  fullOutput.counts.servers === 2 && fullOutput.counts.chassis === 1 && fullOutput.counts.fi === 1);
check('all lists read: blade listed in its chassis', moids(fullOutput.chassis[0].blades) === 'bld1');

// --- Only the chassis request fails
failedInventoryPath = 'equipment/Chasses';
const failedOutput = runCollector();
check('failed chassis list: no chassis list in the result', !('chassis' in failedOutput));
check('failed chassis list: no models list in the result (it would be incomplete)', !('models' in failedOutput));
check('failed chassis list: no counts.chassis, counts.servers and counts.fi present',
  !('chassis' in failedOutput.counts) && failedOutput.counts.servers === 2 && failedOutput.counts.fi === 1);
check('failed chassis list: servers and fis still present',
  moids(failedOutput.servers) === 'bld1,srv1' && moids(failedOutput.fis) === 'fi1');
check('failed chassis list: devices read are still pushed',
  pushedHosts() === 'intersight-bld1,intersight-fi1,intersight-srv1');
check('failed chassis list: error reported in api.errors',
  failedOutput.api.errors.some(e => e.startsWith('chassis: ') && e.includes('HTTP 500')));

// --- Only the server request fails
failedInventoryPath = 'compute/PhysicalSummaries';
const failedServersOutput = runCollector();
check('failed server list: no servers list in the result', !('servers' in failedServersOutput));
check('failed server list: no models list in the result', !('models' in failedServersOutput));
check('failed server list: no counts.servers, counts.chassis and counts.fi present',
  !('servers' in failedServersOutput.counts) && failedServersOutput.counts.chassis === 1 &&
  failedServersOutput.counts.fi === 1);
check('failed server list: chassis and fis still present',
  moids(failedServersOutput.chassis) === 'cha1' && moids(failedServersOutput.fis) === 'fi1');
check('failed server list: no blades list in the chassis (result and pushed value)',
  failedServersOutput.chassis.every(chassis => !('blades' in chassis)) &&
  !('blades' in JSON.parse(pushedValues.find(v => v.host === 'intersight-cha1').value)));
check('failed server list: devices read are still pushed', pushedHosts() === 'intersight-cha1,intersight-fi1');
check('failed server list: error reported in api.errors',
  failedServersOutput.api.errors.some(e => e.startsWith('servers: ') && e.includes('HTTP 500')));

// --- Intersight returns no chassis, without error
failedInventoryPath = null;
emptyInventoryPath = 'equipment/Chasses';
const emptyOutput = runCollector();
check('empty chassis list: chassis sent as []',
  Array.isArray(emptyOutput.chassis) && emptyOutput.chassis.length === 0);
check('empty chassis list: counts.chassis sent as 0', emptyOutput.counts.chassis === 0);
check('empty chassis list: models sent, without a chassis model',
  Array.isArray(emptyOutput.models) && emptyOutput.models.length === 3 &&
  emptyOutput.models.every(model => model['class'] !== 'Chassis'));
check('empty chassis list: no error', emptyOutput.api.errors.length === 0);

check('signatures of every Intersight request verified (' + verified.filter(Boolean).length + '/' + verified.length + ')',
  verified.length > 0 && verified.every(Boolean));

// --- Template: the four rules of the parent template
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const templateBlocks = yaml.split(/\n  - uuid: \w+\n    template: /).slice(1);
const blockOf = name => templateBlocks.find(block => block.startsWith(name + '\n')) || '';
const parentBlock = blockOf('Cisco Intersight by API');
// Text of one discovery rule: from its "name:" line to the next rule ("    - uuid:") or the end.
const ruleBlock = ruleName => {
  const start = parentBlock.indexOf('      name: ' + ruleName + '\n');
  if (start < 0) return '';
  const end = parentBlock.indexOf('\n    - uuid: ', start);
  return end < 0 ? parentBlock.slice(start) : parentBlock.slice(start, end);
};
const macroValue = (name, block = parentBlock) => {
  const start = block.indexOf("macro: '{$" + name + "}'\n");
  if (start < 0) return null;
  const valueLine = block.slice(start).split('\n')[1].trim();
  return valueLine.startsWith('value: ') ? valueLine.slice('value: '.length).replace(/'/g, '') : null;
};
const durationSeconds = text => {
  const match = /^(\d+)([smhdw]?)$/.exec(text || '');
  return match ? +match[1] * { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]] : NaN;
};
const EXPECTED_LIFETIME_LINES = [
  '      lifetime_type: DELETE_AFTER',
  "      lifetime: '{$INTERSIGHT.HOST.LOST.DELETE}'",
  '      enabled_lifetime_type: DISABLE_AFTER',
  "      enabled_lifetime: '{$INTERSIGHT.HOST.LOST.DISABLE}'"
];

for (const [ruleName, listPath] of [['Servers discovery', '$.servers'], ['Chassis discovery', '$.chassis'],
  ['Fabric Interconnects discovery', '$.fis'], ['Models discovery (aggregates per type)', '$.models']]) {
  const rule = ruleBlock(ruleName);
  // Lost-resource fields of the rule itself (6 spaces), not of its prototypes.
  const lifetimeLines = rule.split('\n').filter(line => /^ {6}(enabled_)?lifetime(_type)?: /.test(line));
  check(`${ruleName}: exactly the four lost-resource fields, one macro each`,
    JSON.stringify(lifetimeLines) === JSON.stringify(EXPECTED_LIFETIME_LINES));
  // The rule's single JSONPath step, with DISCARD_VALUE and no custom value, followed by the next
  // rule field (6 spaces then a letter: not a second step "- type", not error_handler_params).
  // Plain text search, no RegExp built from a string (CodeQL "Incomplete string escaping").
  const discardStep = '\n      preprocessing:\n      - type: JSONPATH\n        parameters:\n        - ' + listPath +
    '\n        error_handler: DISCARD_VALUE\n';
  const stepEnd = rule.indexOf(discardStep) + discardStep.length;
  const nextLine = rule.slice(stepEnd, stepEnd + 7);
  check(`${ruleName}: missing ${listPath} discarded (DISCARD_VALUE), no CUSTOM_VALUE`,
    rule.includes(discardStep) && nextLine.startsWith('      ') && nextLine[6] !== ' ' && nextLine[6] !== '-' &&
    !rule.includes('CUSTOM_VALUE') && !rule.includes('error_handler_params'));
}
// Count items: a missing count (failed list) is discarded, not stored as 0. Each item block runs
// from its "key:" line to the next item ("    - uuid:"); its single step must be DISCARD_VALUE.
for (const [kind, countPath] of [['servers', '$.counts.servers'], ['chassis', '$.counts.chassis'], ['fi', '$.counts.fi']]) {
  const start = parentBlock.indexOf('      key: intersight.count.' + kind + '\n');
  const end = start < 0 ? -1 : parentBlock.indexOf('\n    - uuid: ', start);
  const itemBlock = start < 0 ? '' : parentBlock.slice(start, end < 0 ? undefined : end);
  check(`count item intersight.count.${kind}: missing ${countPath} discarded (DISCARD_VALUE)`,
    itemBlock.includes(`        - ${countPath}\n        error_handler: DISCARD_VALUE\n`) &&
    !itemBlock.includes('error_handler_params'));
}
const disable = macroValue('INTERSIGHT.HOST.LOST.DISABLE'), remove = macroValue('INTERSIGHT.HOST.LOST.DELETE');
check('parent template: defaults DISABLE = 1h, DELETE = 7d', disable === '1h' && remove === '7d');
check('parent template: default delete delay longer than disable delay', durationSeconds(remove) > durationSeconds(disable));

// Chassis template: same two macros, for the Zabbix 7.4 nested "Blades discovery" rule added by
// hand (docs/UPGRADE_7.4_FR.md). A chassis host does not inherit the parent template's macros.
const chassisBlock = blockOf('Cisco Intersight Chassis by push');
const chassisDisable = macroValue('INTERSIGHT.HOST.LOST.DISABLE', chassisBlock);
const chassisDelete = macroValue('INTERSIGHT.HOST.LOST.DELETE', chassisBlock);
check('chassis template: HOST.LOST defaults DISABLE = 1h, DELETE = 7d (same as the parent)',
  chassisDisable === '1h' && chassisDelete === '7d' && chassisDisable === disable && chassisDelete === remove);
check('chassis template: default delete delay longer than disable delay',
  durationSeconds(chassisDelete) > durationSeconds(chassisDisable));
