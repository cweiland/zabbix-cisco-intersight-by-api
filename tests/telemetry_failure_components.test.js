// PSU and port discovery when one telemetry request fails (collector side and template side).
// Before: a failed hw.power_supply or hw.network request left every device with psus / ports = [],
// and the PSU / port rules replaced a missing list with [] (CUSTOM_VALUE): every PSU and port was
// marked as lost, disabled after {$INTERSIGHT.LLD.LOST.DISABLE} and deleted after
// {$INTERSIGHT.LLD.LOST.DELETE}. Now the collector leaves out the list of a failed request, and
// the rules discard a missing list (DISCARD_VALUE), like the host rules (PR #19).
// A request that succeeds with no row for a device still sends [] (e.g. a blade has no PSU).
// Fixture devices only (fictitious Moids and names). Rows follow the support lists of
// docs/intersight_metrics.json: hw.power for chassis, racks and FIs; hw.power_supply.utilization
// for FIs; hw.network.io_receive for blades, racks and FIs.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
let pushedValues = [];
let failedInstrument = null;      // the telemetry query of this instrument answers HTTP 500
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
  // One blade of chassis cha1, its chassis and one FI.
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [
    { Moid: 'bld1', Name: 'fixture-blade', Model: 'UCSX-210C-M7', EquipmentChassis: { Moid: 'cha1' } }] });
  if (url.includes('Chasses')) return toJson({ Results: [{ Moid: 'cha1', Name: 'fixture-chassis', Model: 'UCSX-9508' }] });
  if (url.includes('ElementSummaries')) return toJson({ Results: [{ Moid: 'fi1', Name: 'fixture-fi', Model: 'UCS-FI-6454' }] });
  return toJson({ Results: [] });
};
// Telemetry rows per instrument, in the Druid groupBy shape [{event: {...}}].
const row = (hostName, hostType, componentName, fields) =>
  ({ event: Object.assign({ host_name: hostName, host_type: hostType, name: componentName }, fields) });
const TELEMETRY_ROWS = {
  'hw.power_supply': [
    row('fixture-chassis', 'equipment.Chassis', 'PSU1', { inputPowerSum: 1200, inputPowerCount: 2 }),
    row('fixture-fi', 'network.Element', 'PSU1', { inputPowerSum: 400, inputPowerCount: 2, utilizationMax: 0.4 })],
  'hw.network': [
    row('fixture-blade', 'compute.Blade', 'eth0', { linkUpMin: 1 }),
    row('fixture-fi', 'network.Element', 'Ethernet1/1', { linkUpMin: 1 })]
};
HttpRequest.prototype.post = function (url, body) {
  this.status = 200;
  if (url.includes('api_jsonrpc')) {
    pushedValues = JSON.parse(body).params;
    return toJson({ result: { data: pushedValues.map(() => ({ itemid: '1' })) } });
  }
  this.verifySignature('post', url);
  const instrument = JSON.parse(body).filter.value;
  if (instrument === failedInstrument) { this.status = 500; return 'fixture server error'; }
  return toJson(TELEMETRY_ROWS[instrument] || []);
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
// Pushed JSON of every device, by Moid.
const pushedDevices = () => {
  const byMoid = {};
  pushedValues.forEach(v => { const device = JSON.parse(v.value); byMoid[device.moid] = device; });
  return byMoid;
};
const names = list => (list || []).map(component => component.name).sort().join(',');
const MOIDS = ['bld1', 'cha1', 'fi1'];

// --- Both requests succeed; the chassis has no port row and the blade no PSU row
const fullOutput = runCollector();
let devices = pushedDevices();
check('both requests read: one value pushed per device', Object.keys(devices).sort().join(',') === MOIDS.join(','));
check('both requests read: PSUs of the chassis and the FI pushed',
  names(devices.cha1.psus) === 'PSU1' && names(devices.fi1.psus) === 'PSU1');
check('both requests read: ports of the blade and the FI pushed',
  names(devices.bld1.ports) === 'eth0' && names(devices.fi1.ports) === 'Ethernet1/1');
check('both requests read: no PSU row for the blade -> psus = [] (unchanged)',
  Array.isArray(devices.bld1.psus) && devices.bld1.psus.length === 0);
check('both requests read: no port row for the chassis -> ports = [] (unchanged)',
  Array.isArray(devices.cha1.ports) && devices.cha1.ports.length === 0);
check('both requests read: no error', fullOutput.api.errors.length === 0);

// --- hw.power_supply fails
failedInstrument = 'hw.power_supply';
const failedPsuOutput = runCollector();
devices = pushedDevices();
check('failed hw.power_supply: one value pushed per device', Object.keys(devices).sort().join(',') === MOIDS.join(','));
check('failed hw.power_supply: no psus in any pushed value', MOIDS.every(moid => !('psus' in devices[moid])));
check('failed hw.power_supply: ports still pushed (FI and blade listed, chassis [])',
  names(devices.fi1.ports) === 'Ethernet1/1' && names(devices.bld1.ports) === 'eth0' &&
  Array.isArray(devices.cha1.ports) && devices.cha1.ports.length === 0);
check('failed hw.power_supply: error reported in api.errors',
  failedPsuOutput.api.errors.some(e => e.startsWith('telemetry hw.power_supply: ') && e.includes('HTTP 500')));

// --- hw.network fails
failedInstrument = 'hw.network';
const failedPortOutput = runCollector();
devices = pushedDevices();
check('failed hw.network: one value pushed per device', Object.keys(devices).sort().join(',') === MOIDS.join(','));
check('failed hw.network: no ports in any pushed value', MOIDS.every(moid => !('ports' in devices[moid])));
check('failed hw.network: psus still pushed (chassis and FI listed, blade [])',
  names(devices.cha1.psus) === 'PSU1' && names(devices.fi1.psus) === 'PSU1' &&
  Array.isArray(devices.bld1.psus) && devices.bld1.psus.length === 0);
check('failed hw.network: error reported in api.errors',
  failedPortOutput.api.errors.some(e => e.startsWith('telemetry hw.network: ') && e.includes('HTTP 500')));

check('signatures of every Intersight request verified (' + verified.filter(Boolean).length + '/' + verified.length + ')',
  verified.length > 0 && verified.every(Boolean));

// --- Template: PSU and port rules of the three device templates
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const templateBlocks = yaml.split(/\n  - uuid: \w+\n    template: /).slice(1);
const blockOf = name => templateBlocks.find(block => block.startsWith(name + '\n')) || '';
// Text of one discovery rule: from its "name:" line to its "item_prototypes:" line included (the
// rule's own preprocessing comes before its prototypes, which have their own steps).
const PROTOTYPES_LINE = '      item_prototypes:\n';
const ruleHeader = (block, ruleName) => {
  const start = block.indexOf('      name: ' + ruleName + '\n');
  if (start < 0) return '';
  const end = block.indexOf(PROTOTYPES_LINE, start);
  return end < 0 ? '' : block.slice(start, end + PROTOTYPES_LINE.length);
};
for (const template of ['Cisco Intersight Server by push', 'Cisco Intersight Chassis by push', 'Cisco Intersight FI by push']) {
  const block = blockOf(template);
  for (const [ruleName, listPath] of [['PSU discovery', '$.psus'], ['Network port discovery', '$.ports']]) {
    const rule = ruleHeader(block, ruleName);
    // The rule's single JSONPath step with DISCARD_VALUE, followed by the next rule field (6 spaces
    // then a letter: not a second step "- type", not error_handler_params).
    // Plain text search, no RegExp built from a string (CodeQL "Incomplete string escaping").
    const discardStep = '\n      preprocessing:\n      - type: JSONPATH\n        parameters:\n        - ' + listPath +
      '\n        error_handler: DISCARD_VALUE\n';
    const stepEnd = rule.indexOf(discardStep) + discardStep.length;
    const nextLine = rule.slice(stepEnd, stepEnd + 7);
    check(`${template} / ${ruleName}: missing ${listPath} discarded (DISCARD_VALUE), no CUSTOM_VALUE`,
      rule.includes(discardStep) && nextLine.startsWith('      ') && nextLine[6] !== ' ' && nextLine[6] !== '-' &&
      !rule.includes('CUSTOM_VALUE') && !rule.includes('error_handler_params'));
  }
}
