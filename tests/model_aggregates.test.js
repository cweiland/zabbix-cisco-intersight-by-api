// Per-model aggregates: "devices reporting" must count an item every device has.
// Power is missing on devices outside the telemetry support lists (seen on some FIs), so
// counting intersight.power under-counted them. intersight.model is always set by the
// collector ('unknown' when Intersight has no model).
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const check = (label, condition) => { console.log((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) process.exitCode = 1; };

// 1. Template: the count prototype reads intersight.model, not intersight.power.
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const countItem = yaml.match(/key: '?intersight\.model\.count\[\{#CLASS\},\{#MODEL\}\]'?\n(?:\s+(?!params:)\w+: .*\n)*\s+params: (.+)/);
check('devices reporting prototype exists', countItem !== null);
check('devices reporting counts intersight.model per model group',
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
  if (u.includes('ElementSummaries')) return JSON.stringify({ Results: [{ Moid: 'f1', Name: 'FI-A', Model: 'UCS-FI-6536' }, { Moid: 'f2', Name: 'FI-B' }] });
  return JSON.stringify({ Results: [] });
};
HttpRequest.prototype.post = function (u) {
  if (u.includes('api_jsonrpc')) return JSON.stringify({ result: { data: [] } });
  return '[]';
};
const parameters = { key_id: 'K', private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }), api_host: 'intersight.com' };
const out = JSON.parse(new Function('value', code)(JSON.stringify(parameters)));
check('FIs without telemetry have no power value', out.fis.length === 2 && out.fis.every(fi => fi.power_w === undefined));
check('every FI has a model (unknown when missing)',
      out.fis.length === 2 && out.fis[0].model === 'UCS-FI-6536' && out.fis[1].model === 'unknown');
