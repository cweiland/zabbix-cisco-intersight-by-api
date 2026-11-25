// Per-model aggregates: "device count" (formerly "devices reporting") must count an item
// every device has.
// Intersight has no power value for some devices (seen on some chassis and servers in the
// Intersight UI; cause unknown; other device types not checked), so counting
// intersight.power under-counted them. intersight.model is always set by the collector
// ('unknown' when Intersight has no model).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const check = (label, condition) => { console.log((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) process.exitCode = 1; };

// 1. Template: the count prototype reads intersight.model, not intersight.power.
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const countItem = yaml.match(/key: '?intersight\.model\.count\[\{#CLASS\},\{#MODEL\}\]'?\n(?:\s+(?!params:)\w+: .*\n)*\s+params: (.+)/);
check('device count prototype exists', countItem !== null);
check('device count prototype named "{#CLASS} {#MODEL}: device count", old name gone',
      /name: '\{#CLASS\} \{#MODEL\}: device count'\n\s+type: CALCULATED\n\s+key: '?intersight\.model\.count\[/.test(yaml)
      && !yaml.includes('devices reporting'));
check('device count counts intersight.model per model group',
      countItem !== null && countItem[1].replace(/'/g, '') === 'count(last_foreach(/*/intersight.model?[group="{#GROUP}"]))');

// 2. Collector: every pushed device has a model, even without Model in the inventory
//    and without any telemetry (no power).
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const code = fs.readFileSync(process.env.COLLECTOR_CODE_FILE || path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
global.HttpRequest = function () { this.h = []; };
HttpRequest.prototype.clearHeader = function () { this.h = []; };
HttpRequest.prototype.addHeader = function (x) { this.h.push(x); };
HttpRequest.prototype.getStatus = function () { return 200; };
HttpRequest.prototype.get = function (u) {
  // A server and a chassis with a model, a second server without one; no telemetry at all.
  if (u.includes('PhysicalSummaries')) return JSON.stringify({ Results: [
    { Moid: 's1', Name: 'srv-1', Model: 'UCSX-210C-M7', Serial: 'S1' },
    { Moid: 's2', Name: 'srv-2', Serial: 'S2' }] });
  if (u.includes('Chasses')) return JSON.stringify({ Results: [{ Moid: 'c1', Name: 'chassis-1', Model: 'UCSX-9508', Serial: 'C1' }] });
  return JSON.stringify({ Results: [] });
};
HttpRequest.prototype.post = function (u) {
  if (u.includes('api_jsonrpc')) return JSON.stringify({ result: { data: [] } });
  return '[]';
};
const parameters = { key_id: 'K', private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }), api_host: 'intersight.com' };
const out = JSON.parse(new Function('value', code)(JSON.stringify(parameters)));
const byMoid = {};
out.servers.concat(out.chassis).forEach(device => { byMoid[device.moid] = device; });
check('server and chassis without telemetry have no power value',
      ['s1', 's2', 'c1'].every(moid => byMoid[moid] !== undefined && byMoid[moid].power_w === undefined));
check('server and chassis without power still have their model',
      byMoid.s1 !== undefined && byMoid.s1.model === 'UCSX-210C-M7' && byMoid.c1 !== undefined && byMoid.c1.model === 'UCSX-9508');
check('model is "unknown" when Intersight has none', byMoid.s2 !== undefined && byMoid.s2.model === 'unknown');
