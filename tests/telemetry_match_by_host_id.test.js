// Telemetry matched to devices by host.id (the device Moid), with a (class, name) fallback.
// Cisco DevNet "Host Power and Status": host.id is "a globally unique host ID" (the API path
// of the resource), host.name "is not guaranteed to be unique". Before: rows were matched by
// (class, name) only, so two devices of one class with the same name got the same mixed data.
// Now each row is resolved to a Moid when it is read: last segment of host.id, else the name
// fallback (class from host.type, any class when host.type is unknown), and only when that
// name is unique. Homonyms without host.id get no telemetry rather than mixed data.
// Fixture devices only (fictitious Moids, names and host.id paths: only the last segment is
// read). Rows follow the support lists of docs/intersight_metrics.json: hw.host for racks and
// FIs (no IMM chassis), hw.power_supply for chassis, racks and FIs, hw.network for racks and FIs.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const toJson = JSON.stringify;
let pushedValues = [];
const telemetryQueries = [];
const verified = [];              // one entry per Intersight request: signature valid or not

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
const rack = (moid, name) => ({ Moid: moid, Name: name, Model: 'UCSC-C220-M7' });
HttpRequest.prototype.get = function (url) {
  this.verifySignature('get', url);
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [
    rack('twin1', 'fixture-twin'), rack('twin2', 'fixture-twin'),     // same name, with host.id
    rack('shsrv', 'fixture-shared'),                                  // same name as chassis shcha
    rack('leg1', 'fixture-legacy'),                                   // rows without host_id
    rack('dup1', 'fixture-dup'), rack('dup2', 'fixture-dup'),         // same name, no host.id
    rack('mix1', 'fixture-mixed')] });                                // host.id on hw.host only
  if (url.includes('Chasses')) return toJson({ Results: [
    { Moid: 'shcha', Name: 'fixture-shared', Model: 'UCSX-9508' },
    { Moid: 'leg2', Name: 'fixture-legacy-chassis', Model: 'UCSX-9508' }] });   // host_id ''
  if (url.includes('ElementSummaries')) return toJson({ Results: [
    { Moid: 'fi1', Name: 'fixture-fi', Model: 'UCS-FI-6454' }] });             // no host.type
  return toJson({ Results: [] });
};
// One Druid groupBy row [{event: {...}}]. hostId undefined = no host_id field at all.
const row = (hostId, hostName, hostType, componentName, fields) => {
  const event = Object.assign({ host_name: hostName }, fields);
  if (hostId !== undefined) event.host_id = hostId;
  if (hostType !== undefined) event.host_type = hostType;
  if (componentName !== undefined) event.name = componentName;
  return { event: event };
};
const RK = 'compute.RackUnit', CH = 'equipment.Chassis';
const power = watts => ({ powerSum: watts * 10, powerCount: 10 });
const psuInput = watts => ({ inputPowerSum: watts * 10, inputPowerCount: 10 });
const TELEMETRY_ROWS = {
  'hw.host': [
    row('/api/v1/compute/RackUnits/twin1', 'fixture-twin', RK, undefined, power(300)),
    row('/api/v1/compute/RackUnits/twin2', 'fixture-twin', RK, undefined, power(500)),
    row('/api/v1/compute/RackUnits/shsrv', 'fixture-shared', RK, undefined, power(200)),
    // No host.type nor host.id, name held by a rack and a chassis: ambiguous, ignored.
    row(undefined, 'fixture-shared', undefined, undefined, power(888)),
    row(undefined, 'fixture-legacy', RK, undefined, power(100)),
    // host.id of no inventoried device, with the name of an existing one: never matched by name.
    row('/api/v1/compute/RackUnits/ghost0', 'fixture-legacy', RK, undefined, power(999)),
    // Druid merges the two homonyms without host.id into one row.
    row(undefined, 'fixture-dup', RK, undefined, power(700)),
    row('/api/v1/compute/RackUnits/mix1', 'fixture-mixed', RK, undefined, power(400)),
    row('', 'fixture-fi', undefined, undefined, power(600))],
  'hw.power_supply': [
    row('/api/v1/compute/RackUnits/twin1', 'fixture-twin', RK, 'PSU1', psuInput(150)),
    row('/api/v1/compute/RackUnits/twin2', 'fixture-twin', RK, 'PSU1', psuInput(250)),
    row('/api/v1/compute/RackUnits/twin2', 'fixture-twin', RK, 'PSU2', psuInput(260)),
    row('/api/v1/equipment/Chasses/shcha', 'fixture-shared', CH, 'PSU1', psuInput(1000)),
    row('/api/v1/equipment/Chasses/shcha', 'fixture-shared', CH, 'PSU2', psuInput(1100)),
    row('', 'fixture-legacy-chassis', CH, 'PSU1', psuInput(900)),
    row(undefined, 'fixture-dup', RK, 'PSU1', psuInput(350))],
  'hw.network': [
    row('/api/v1/compute/RackUnits/twin1', 'fixture-twin', RK, 'eth0', { linkUpMin: 1 }),
    row('/api/v1/compute/RackUnits/twin2', 'fixture-twin', RK, 'eth1', { linkUpMin: 1 }),
    row(undefined, 'fixture-mixed', RK, 'eth0', { linkUpMin: 1 }),
    row(undefined, 'fixture-dup', RK, 'eth0', { linkUpMin: 1 }),
    row(undefined, 'fixture-fi', undefined, 'Ethernet1/1', { linkUpMin: 1 })]
};
HttpRequest.prototype.post = function (url, body) {
  if (url.includes('api_jsonrpc')) {
    pushedValues = JSON.parse(body).params;
    return toJson({ result: { data: pushedValues.map(() => ({ itemid: '1' })) } });
  }
  this.verifySignature('post', url);
  const query = JSON.parse(body);
  telemetryQueries.push(query);
  return toJson(TELEMETRY_ROWS[query.filter.value] || []);
};

const collector = new Function('value', fs.readFileSync(process.env.COLLECTOR_CODE_FILE ||
  path.join(__dirname, '..', 'src', 'collector.js'), 'utf8'));
const output = JSON.parse(collector(toJson({ key_id: 'K', api_host: 'intersight.com',
  private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }),
  zbx_url: 'https://zabbix.example.com/api_jsonrpc.php', zbx_token: 'fixture-token' })));
const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
// Pushed JSON of every device, by Moid.
const devices = {};
pushedValues.forEach(v => { const device = JSON.parse(v.value); devices[device.moid] = device; });
const names = list => (list || []).map(component => component.name).sort().join(',');
const inputs = list => (list || []).map(component => component.in_w).sort((a, b) => a - b).join(',');
const hasNoTelemetry = device => device.power_w === undefined &&
  Array.isArray(device.psus) && device.psus.length === 0 && Array.isArray(device.ports) && device.ports.length === 0;

check('one value pushed per device', Object.keys(devices).sort().join(',') ===
  'dup1,dup2,fi1,leg1,leg2,mix1,shcha,shsrv,twin1,twin2');

// --- Two servers with the same name, different host.id
check('same-name servers: each gets its own power (300 W / 500 W)',
  devices.twin1.power_w === 300 && devices.twin1.power_source === 'host' && devices.twin2.power_w === 500);
check('same-name servers: each gets its own PSUs (PSU1 150 W / PSU1 250 W + PSU2 260 W)',
  names(devices.twin1.psus) === 'PSU1' && inputs(devices.twin1.psus) === '150' &&
  names(devices.twin2.psus) === 'PSU1,PSU2' && inputs(devices.twin2.psus) === '250,260');
check('same-name servers: each gets its own ports (eth0 / eth1)',
  names(devices.twin1.ports) === 'eth0' && names(devices.twin2.ports) === 'eth1');

// --- A server and a chassis with the same name, with host.id
check('server and chassis with one name: server keeps its own power (200 W, host), no PSU',
  devices.shsrv.power_w === 200 && devices.shsrv.power_source === 'host' && devices.shsrv.psus.length === 0);
check('server and chassis with one name: chassis gets its PSUs and their power (2100 W, psu_input)',
  names(devices.shcha.psus) === 'PSU1,PSU2' && devices.shcha.power_w === 2100 && devices.shcha.power_source === 'psu_input');
check('row without host.type nor host.id on a name held in two classes: ignored (no 888 W anywhere)',
  Object.keys(devices).every(moid => devices[moid].power_w !== 888));

// --- Rows without host_id (absent or empty): (class, name) fallback, "any" included
check('host_id absent: matched by (class, name) (rack 100 W)', devices.leg1.power_w === 100);
check('host_id empty: matched by (class, name) (chassis PSU1, 900 W)',
  names(devices.leg2.psus) === 'PSU1' && devices.leg2.power_w === 900);
check('no host.type nor host_id (absent or empty): matched by unique name in any class (FI 600 W, Ethernet1/1)',
  devices.fi1.power_w === 600 && names(devices.fi1.ports) === 'Ethernet1/1');
check('same-name servers without host.id: no telemetry for either (no power, psus [], ports [])',
  hasNoTelemetry(devices.dup1) && hasNoTelemetry(devices.dup2));

// --- One device with host.id on one instrument and without it on another
check('host.id on hw.host, none on hw.network: power and ports on the same device (400 W, eth0)',
  devices.mix1.power_w === 400 && names(devices.mix1.ports) === 'eth0');

// --- host.id whose Moid is no inventoried device
check('host.id of no inventoried device: attributed to no device (no 999 W; same-name rack keeps 100 W)',
  Object.keys(devices).every(moid => devices[moid].power_w !== 999) && devices.leg1.power_w === 100);

// --- Queries
check('telemetry queries sent (' + telemetryQueries.length + ')', telemetryQueries.length > 0);
check('every query groups by host_id through the nested-field virtual column host.id',
  telemetryQueries.every(query => query.dimensions.includes('host_id') && (query.virtualColumns || []).some(column =>
    column.type === 'nested-field' && column.columnName === 'host.id' && column.outputName === 'host_id' && column.path === '$')));
check('host.name and host.type still grouped (name fallback)',
  telemetryQueries.every(query => query.dimensions.includes('host_name') && query.dimensions.includes('host_type')));
check('no error', output.api.errors.length === 0);
check('signatures of every Intersight request verified (' + verified.filter(Boolean).length + '/' + verified.length + ')',
  verified.length > 0 && verified.every(Boolean));
