// Server power state (power_state, item intersight.power.state).
// OperPowerState is a free string: "The actual power state of the server."
// (CiscoDevNet/intersight-python, compute_physical_summary_all_of.py), with no list of values.
// Only "on" and "off" were seen on a design appliance. Mapping: "on" 1, "off" 0
// (case-insensitive), any other value 2 ("Other", its own WARNING trigger, so that it is not
// shown as "Off" nor raises "server is powered off"); absent or empty: power_state not sent.
// Fixture devices only (fictitious Moids and names).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};

const verified = [];   // one entry per Intersight request: signature valid or not
let pushedValues = [];
global.HttpRequest = function () { this.headers = []; };
HttpRequest.prototype.clearHeader = function () { this.headers = []; };
HttpRequest.prototype.addHeader = function (header) { this.headers.push(header); };
HttpRequest.prototype.getStatus = function () { return 200; };
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
  this.verifySignature('get', url);
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [
    { Moid: 'p-on', Name: 'fixture-on', Model: 'UCSC-C240-M7', OperPowerState: 'on' },
    { Moid: 'p-on-upper', Name: 'fixture-on-upper', Model: 'UCSC-C240-M7', OperPowerState: 'ON' },
    { Moid: 'p-off', Name: 'fixture-off', Model: 'UCSC-C240-M7', OperPowerState: 'off' },
    { Moid: 'p-off-mixed', Name: 'fixture-off-mixed', Model: 'UCSC-C240-M7', OperPowerState: 'Off' },
    { Moid: 'p-other', Name: 'fixture-other', Model: 'UCSC-C240-M7', OperPowerState: 'fixture-unknown' },
    { Moid: 'p-absent', Name: 'fixture-absent', Model: 'UCSC-C240-M7' },
    { Moid: 'p-empty', Name: 'fixture-empty', Model: 'UCSC-C240-M7', OperPowerState: '' }]});
  return toJson({ Results: [] });
};
HttpRequest.prototype.post = function (url, body) {
  if (url.includes('api_jsonrpc')) {
    pushedValues = JSON.parse(body).params;
    return toJson({ result: { data: pushedValues.map(() => ({ itemid: '1' })) } });
  }
  this.verifySignature('post', url);
  return '[]';
};

const code = fs.readFileSync(process.env.COLLECTOR_CODE_FILE || path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
const output = JSON.parse(new Function('value', code)(toJson({
  key_id: 'K', api_host: 'intersight.com', private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }),
  zbx_url: 'https://zabbix.example.com/api_jsonrpc.php', zbx_token: 'fixture-token' })));

// Pushed JSON of each device, by Moid (host "intersight-<Moid>").
const pushedByMoid = {};
pushedValues.forEach(entry => { pushedByMoid[entry.host.slice('intersight-'.length)] = JSON.parse(entry.value); });
const pushedPowerState = moid => (pushedByMoid[moid] || {}).power_state;

check(`every Intersight request signature verifies (${verified.length} requests)`, verified.length > 0 && verified.every(Boolean));
check('all 7 fixture servers pushed, no error', pushedValues.length === 7 && output.api.errors.length === 0);
check('OperPowerState "on" -> power_state 1', pushedPowerState('p-on') === 1);
check('OperPowerState "ON" -> power_state 1 (case-insensitive)', pushedPowerState('p-on-upper') === 1);
check('OperPowerState "off" -> power_state 0', pushedPowerState('p-off') === 0);
check('OperPowerState "Off" -> power_state 0 (case-insensitive)', pushedPowerState('p-off-mixed') === 0);
check('other OperPowerState ("fixture-unknown") -> power_state 2, not 0', pushedPowerState('p-other') === 2);
check('OperPowerState absent -> power_state not in the pushed JSON',
  !!pushedByMoid['p-absent'] && !('power_state' in pushedByMoid['p-absent']));
check('OperPowerState empty -> power_state not in the pushed JSON',
  !!pushedByMoid['p-empty'] && !('power_state' in pushedByMoid['p-empty']));
check('servers[] of the returned document carry the same power_state',
  output.servers.every(server => server.power_state === pushedPowerState(server.moid)));

// --- Template: value map and the two triggers of intersight.power.state
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const templateBlocks = yaml.split(/\n  - uuid: \w+\n    template: /).slice(1);
const blockOf = name => templateBlocks.find(block => block.startsWith(name + '\n')) || '';
const serverBlock = blockOf('Cisco Intersight Server by push');

// Value map "Power state": defined once in the generator, so present in the three device
// templates. Each must hold exactly 0 Off, 1 On, 2 Other.
const powerStateMaps = templateBlocks.map(block => {
  const start = block.indexOf('\n      name: Power state\n      mappings:\n', block.indexOf('\n    valuemaps:\n'));
  if (block.indexOf('\n    valuemaps:\n') < 0 || start < 0) return null;
  const end = block.indexOf('\n    - uuid: ', start + 1);
  const mapText = end < 0 ? block.slice(start) : block.slice(start, end);
  return [...mapText.matchAll(/- value: '?(\d+)'?\n\s+newvalue: '?([^'\n]+)'?/g)].map(m => m[1] + '=' + m[2]).join(',');
}).filter(map => map !== null);
check(`value map "Power state" is exactly 0 Off, 1 On, 2 Other in every template defining it (${powerStateMaps.length})`,
  powerStateMaps.length === 3 && powerStateMaps.every(map => map === '0=Off,1=On,2=Other'));

// Item intersight.power.state: from its name line to the next item (4 spaces) or the rules.
const itemStart = serverBlock.indexOf('\n      name: Power state\n      type: DEPENDENT\n');
const itemEnds = ['\n    - uuid: ', '\n    discovery_rules:'].map(text => serverBlock.indexOf(text, itemStart + 1)).filter(i => i > 0);
const itemBlock = itemStart < 0 ? '' : serverBlock.slice(itemStart, Math.min(...itemEnds));
check('item intersight.power.state unchanged: same UUID, key, UNSIGNED, value map "Power state"',
  serverBlock.includes('    - uuid: 2bab154794ca431f80897f6c9c318629\n      name: Power state\n') &&
  itemBlock.includes('\n      key: intersight.power.state\n') && itemBlock.includes('\n      value_type: UNSIGNED\n') &&
  itemBlock.includes('\n      valuemap:\n        name: Power state\n') && itemBlock.includes('\n        - $.power_state\n'));

// Triggers of the item (6-space "- uuid:" entries under "triggers:").
const triggerTexts = itemBlock.slice(itemBlock.indexOf('\n      triggers:\n')).split('\n      - uuid: ').slice(1);
const triggerByName = name => triggerTexts.find(text => text.includes('\n        name: ' + name + '\n')) || '';
check('exactly two triggers on intersight.power.state', itemBlock.includes('\n      triggers:\n') && triggerTexts.length === 2);

const poweredOff = triggerByName("'Intersight: server is powered off'");
check('trigger "server is powered off" unchanged: same UUID, last(...)=0, AVERAGE, same description, manual close',
  poweredOff.startsWith('f5666ec3a8d24b53b8ae8658ca8e4663\n') &&
  poweredOff.includes('\n        expression: last(/Cisco Intersight Server by push/intersight.power.state)=0\n') &&
  poweredOff.includes('\n        priority: AVERAGE\n') &&
  poweredOff.includes('\n        description: Use a maintenance period for planned shutdowns.\n') &&
  poweredOff.includes("\n        manual_close: 'YES'"));

const unexpected = triggerByName("'Intersight: unexpected power state reported'");
check('trigger "unexpected power state reported": last(...)=2, WARNING, no manual close',
  unexpected.includes('\n        expression: last(/Cisco Intersight Server by push/intersight.power.state)=2\n') &&
  unexpected.includes('\n        priority: WARNING\n') && !unexpected.includes('manual_close'));
// The description is folded by PyYAML: compare it with line breaks and indentation removed.
const unexpectedDescription = unexpected.split('\n').map(line => line.trim()).join(' ');
check('trigger "unexpected power state reported": description says to check Intersight and cites the SDK',
  unexpectedDescription.includes('neither "on" nor "off"') &&
  unexpectedDescription.includes('Check the power state of the server in Intersight') &&
  unexpectedDescription.includes('CiscoDevNet/intersight-python, compute_physical_summary_all_of.py'));
