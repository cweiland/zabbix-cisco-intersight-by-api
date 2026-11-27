// Blade <-> chassis matching (chassis.blades, server.is_blade).
// Case seen on the user's appliance: the RegisteredDevice Moid of a blade differs from
// the one of its chassis, so the "<RegisteredDevice.Moid>:<ChassisId>" key never matches.
// The compute.PhysicalSummary relationship "EquipmentChassis" (Intersight API schema,
// CiscoDevNet/intersight-python compute_physical_summary_all_of.py) must be used first.
// is_blade: SourceObjectType first (same SDK file: "either be RackUnit or Blade"; compute.Blade
// and compute.RackUnit seen on the user's appliance), the chassis / model rule as fallback.
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
// When set, compute/PhysicalSummaries answers these servers (SourceObjectType scenario below).
let sourceTypeServers = null;
HttpRequest.prototype.get = function (url) {
  this.verifySignature('get', url);
  if (sourceTypeServers && url.includes('PhysicalSummaries')) return toJson({ Results: sourceTypeServers });
  // No SourceObjectType in these servers: is_blade comes from the fallback rule.
  if (url.includes('PhysicalSummaries')) return toJson({ Results: [
    // Blades of chassis c1 and c2: RegisteredDevice differs from the chassis one.
    { Moid: 'b1', Name: 'blade-1', Model: 'UCSX-210C-M7', ChassisId: '1',
      RegisteredDevice: { Moid: 'reg-blade' }, EquipmentChassis: { Moid: 'c1' } },
    { Moid: 'b2', Name: 'blade-2', Model: 'UCSX-210C-M7', ChassisId: '1',
      RegisteredDevice: { Moid: 'reg-blade' }, EquipmentChassis: { Moid: 'c1' } },
    { Moid: 'b3', Name: 'blade-3', Model: 'UCSX-210C-M7', ChassisId: '2',
      RegisteredDevice: { Moid: 'reg-blade' }, EquipmentChassis: { Moid: 'c2' } },
    // Only EquipmentChassis identifies it as a blade: no ChassisId and a model outside
    // UCSB-* / UCSX-* (fixture value), so chassis_key is empty and the model rule fails.
    { Moid: 'b5', Name: 'blade-5', Model: 'TEST-MODEL-WITHOUT-BLADE-PREFIX',
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
// flatServers: value of the flat_servers item parameter ('1' = 7.0 default, '0' = 7.4 nested).
const runCollector = flatServers => JSON.parse(collector(toJson({ key_id: 'K', api_host: 'intersight.com',
  private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }), flat_servers: flatServers })));
const flatOutput = runCollector('1');
const nestedOutput = runCollector('0');

const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
const chassisByMoid = moid => flatOutput.chassis.find(chassis => chassis.moid === moid);
const bladeMoids = moid => chassisByMoid(moid).blades.map(blade => blade.moid).sort().join(',');
const serverByMoid = moid => flatOutput.servers.find(server => server.moid === moid);
const serverMoids = output => output.servers.map(server => server.moid).sort().join(',');

check('signatures verified ' + verified.filter(Boolean).length + '/' + verified.length, verified.every(Boolean));
check('chassis c1 holds b1,b2 through EquipmentChassis despite a different RegisteredDevice', bladeMoids('c1') === 'b1,b2');
check('chassis c2 holds b3,b5 (b5 known only through EquipmentChassis)', bladeMoids('c2') === 'b3,b5');
check('chassis c3 holds b4 through the RegisteredDevice:ChassisId fallback', bladeMoids('c3') === 'b4');
check('chassis_moid exposed on servers (empty without EquipmentChassis)',
  serverByMoid('b1').chassis_moid === 'c1' && serverByMoid('b4').chassis_moid === '' && serverByMoid('r1').chassis_moid === '');
check('b5 (EquipmentChassis only: empty chassis_key, non-blade model) flagged is_blade=1',
  serverByMoid('b5').chassis_key === '' && serverByMoid('b5').is_blade === 1);
check('blades flagged is_blade=1, rack server is_blade=0',
  ['b1', 'b2', 'b3', 'b4', 'b5'].every(moid => serverByMoid(moid).is_blade === 1) && serverByMoid('r1').is_blade === 0);
check('flat_servers=1: every server in the Servers discovery', serverMoids(flatOutput) === 'b1,b2,b3,b4,b5,r1');
check('flat_servers=0: blades (b5 included) left out of the Servers discovery, rack kept',
  serverMoids(nestedOutput) === 'r1');
check('flat_servers=0: blades still listed under their chassis',
  nestedOutput.chassis.find(chassis => chassis.moid === 'c2').blades.map(blade => blade.moid).sort().join(',') === 'b3,b5');
check('no errors', flatOutput.api.errors.length === 0 && nestedOutput.api.errors.length === 0);

// --- is_blade from SourceObjectType (compute.PhysicalSummary). The fixtures above have no
// SourceObjectType: their checks cover the fallback rule, unchanged.
sourceTypeServers = [
  // Blade type, with no chassis relationship, no ChassisId and a model outside UCSB-* / UCSX-*.
  { Moid: 's1', Name: 'typed-blade', Model: 'TEST-MODEL-WITHOUT-BLADE-PREFIX', SourceObjectType: 'compute.Blade' },
  // Rack type with a UCSB-* model: the type comes before the model.
  { Moid: 's2', Name: 'typed-rack', Model: 'UCSB-B200-M6', SourceObjectType: 'compute.RackUnit' },
  // Any other value: fallback rule (UCSX-* model -> blade; rack model without chassis -> rack).
  { Moid: 's3', Name: 'other-type-blade-model', Model: 'UCSX-210C-M7', SourceObjectType: 'fixture.OtherType' },
  { Moid: 's4', Name: 'other-type-rack-model', Model: 'UCSC-C240-M7', ChassisId: '0', SourceObjectType: 'fixture.OtherType' }];
const signaturesBeforeTypedRuns = verified.length;
const typedFlatOutput = runCollector('1');
const typedNestedOutput = runCollector('0');
const typedServerByMoid = moid => typedFlatOutput.servers.find(server => server.moid === moid);

check('typed runs: signatures verified',
  verified.length > signaturesBeforeTypedRuns && verified.slice(signaturesBeforeTypedRuns).every(Boolean));
check('SourceObjectType compute.Blade: is_blade=1 with a non-blade model and no chassis',
  typedServerByMoid('s1').chassis_moid === '' && typedServerByMoid('s1').chassis_key === '' &&
  typedServerByMoid('s1').is_blade === 1);
check('SourceObjectType compute.RackUnit: is_blade=0 despite a UCSB-* model (type before model)',
  typedServerByMoid('s2').is_blade === 0);
check('other SourceObjectType value: fallback rule (UCSX-* model 1, rack model without chassis 0)',
  typedServerByMoid('s3').is_blade === 1 && typedServerByMoid('s4').is_blade === 0);
check('typed, flat_servers=1: every server in the Servers discovery', serverMoids(typedFlatOutput) === 's1,s2,s3,s4');
check('typed, flat_servers=0: blades (s1, s3) left out of the Servers discovery, racks (s2, s4) kept',
  serverMoids(typedNestedOutput) === 's2,s4');
check('typed runs: no errors', typedFlatOutput.api.errors.length === 0 && typedNestedOutput.api.errors.length === 0);
