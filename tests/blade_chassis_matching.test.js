// Blade <-> chassis matching (chassis.blades, server.is_blade).
// Case seen on the user's appliance: the RegisteredDevice Moid of a blade differs from
// the one of its chassis, so the "<RegisteredDevice.Moid>:<ChassisId>" key never matches.
// The compute.PhysicalSummary relationship "EquipmentChassis" (Intersight API schema,
// CiscoDevNet/intersight-python compute_physical_summary_all_of.py) must be used first.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const verified = [];
global.HttpRequest = function () { this.headers = []; };
HttpRequest.prototype.clearHeader = function () { this.headers = []; };
HttpRequest.prototype.addHeader = function (header) { this.headers.push(header); };
HttpRequest.prototype.getStatus = function () { return 200; };
HttpRequest.prototype.verifySignature = function (method, url) {
  const byName = {};
  this.headers.forEach(header => {
    const separator = header.indexOf(': ');
    byName[header.slice(0, separator).toLowerCase()] = header.slice(separator + 2);
  });
  const signingString = `(request-target): ${method} ${url.replace('https://intersight.com', '')}\n` +
    `host: ${byName.host}\ndate: ${byName.date}\ndigest: ${byName.digest}`;
  const signature = Buffer.from(/signature="([^"]+)"/.exec(byName.authorization)[1], 'base64');
  verified.push(crypto.verify('sha256', Buffer.from(signingString), ecKey.publicKey, signature));
};
const toJson = JSON.stringify;
HttpRequest.prototype.get = function (url) {
  this.verifySignature('get', url);
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [
    // Blades of chassis c1 and c2: RegisteredDevice differs from the chassis one.
    { Moid: 'b1', Name: 'blade-1', Model: 'UCSX-210C-M7', ChassisId: '1',
      RegisteredDevice: { Moid: 'reg-blade' }, EquipmentChassis: { Moid: 'c1' } },
    { Moid: 'b2', Name: 'blade-2', Model: 'UCSX-210C-M7', ChassisId: '1',
      RegisteredDevice: { Moid: 'reg-blade' }, EquipmentChassis: { Moid: 'c1' } },
    { Moid: 'b3', Name: 'blade-3', Model: 'UCSX-210C-M7', ChassisId: '2',
      RegisteredDevice: { Moid: 'reg-blade' }, EquipmentChassis: { Moid: 'c2' } },
    // No EquipmentChassis: fallback key "dom-old:3" matches chassis c3.
    { Moid: 'b4', Name: 'blade-4', Model: 'UCSB-B200-M6', ChassisId: '3', RegisteredDevice: { Moid: 'dom-old' } },
    // Rack server: no chassis at all.
    { Moid: 'r1', Name: 'rack-1', Model: 'UCSC-C240-M7', ChassisId: '0' }]});
  if (url.includes('Chasses')) return toJson({ Results: [
    { Moid: 'c1', Name: 'chassis-1', Model: 'UCSX-9508', ChassisId: 1, RegisteredDevice: { Moid: 'reg-chassis' } },
    { Moid: 'c2', Name: 'chassis-2', Model: 'UCSX-9508', ChassisId: 2, RegisteredDevice: { Moid: 'reg-chassis' } },
    { Moid: 'c3', Name: 'chassis-3', Model: 'UCSB-5108-AC2', ChassisId: 3, RegisteredDevice: { Moid: 'dom-old' } }]});
  return toJson({ Results: [] });
};
HttpRequest.prototype.post = function (url, body) {
  if (url.includes('api_jsonrpc')) return toJson({ result: { data: [] } });
  this.verifySignature('post', url);
  return '[]';
};
const collector = new Function('value', fs.readFileSync(process.env.COLLECTOR_CODE_FILE ||
  path.join(__dirname, '..', 'src', 'collector.js'), 'utf8'));
const output = JSON.parse(collector(toJson({ key_id: 'K', api_host: 'intersight.com',
  private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }) })));

const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
const chassisByMoid = moid => output.chassis.find(chassis => chassis.moid === moid);
const bladeMoids = moid => chassisByMoid(moid).blades.map(blade => blade.moid).sort().join(',');
const serverByMoid = moid => output.servers.find(server => server.moid === moid);

check('signatures verified ' + verified.filter(Boolean).length + '/' + verified.length, verified.every(Boolean));
check('chassis c1 holds b1,b2 through EquipmentChassis despite a different RegisteredDevice', bladeMoids('c1') === 'b1,b2');
check('chassis c2 holds b3 only', bladeMoids('c2') === 'b3');
check('chassis c3 holds b4 through the RegisteredDevice:ChassisId fallback', bladeMoids('c3') === 'b4');
check('chassis_moid exposed on servers (empty without EquipmentChassis)',
  serverByMoid('b1').chassis_moid === 'c1' && serverByMoid('b4').chassis_moid === '' && serverByMoid('r1').chassis_moid === '');
check('blades flagged is_blade=1, rack server is_blade=0',
  ['b1', 'b2', 'b3', 'b4'].every(moid => serverByMoid(moid).is_blade === 1) && serverByMoid('r1').is_blade === 0);
check('no errors', output.api.errors.length === 0);
