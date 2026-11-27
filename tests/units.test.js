// Units: percentages, base units and Zabbix display units.
// Intersight stores utilizations as 0-1 ratios (checked in the raw data of the user's
// appliance), although its doc gives the unit "%". {$INTERSIGHT.PERCENT.SCALE} (default 100)
// converts them; a wrong scale must be reported, never silently stored.
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const check = (label, condition) => { console.log((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) process.exitCode = 1; };
const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
global.sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
global.sign = () => { throw 'unused'; };
const code = fs.readFileSync(process.env.COLLECTOR_CODE_FILE || path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');

// rawNetworkUtilization / rawIdle: values as Intersight would return them.
function runCollector(rawNetworkUtilization, rawIdle, extraParameters) {
  global.HttpRequest = function () { this.h = []; };
  HttpRequest.prototype.clearHeader = function () { this.h = []; };
  HttpRequest.prototype.addHeader = function (x) { this.h.push(x); };
  HttpRequest.prototype.getStatus = function () { return 200; };
  HttpRequest.prototype.get = function (u) {
    if (u.includes('ElementSummaries')) return JSON.stringify({ Results: [{ Moid: 'f1', Name: 'FI-A', Model: 'UCS-FI-6536' }] });
    return JSON.stringify({ Results: [] });
  };
  HttpRequest.prototype.post = function (u, b) {
    if (u.includes('api_jsonrpc')) return JSON.stringify({ result: { data: [] } });
    const q = JSON.parse(b), names = q.aggregations.map(a => a.name);
    // No host_id in these rows: they are matched through the (class, name) fallback.
    const dimensions = q.dimensions.filter(name => name !== 'host_id');
    const row = (values, component) => {
      const e = { [dimensions[0]]: 'FI-A', [dimensions[1]]: 'network.Element' };
      if (component) e[dimensions[2]] = component;
      names.forEach((n, i) => { if (values[i] !== undefined) e[n] = values[i]; });
      return { event: e };
    };
    if (q.filter.value === 'system.cpu') return JSON.stringify([row([rawIdle * 10, 10])]);
    if (q.filter.value === 'hw.network') return JSON.stringify([row([0, 60, 0, 60, 1.25e9, 0, 0, rawNetworkUtilization * 10, 10, 1], 'Eth1/1')]);
    return '[]';
  };
  const parameters = Object.assign({ key_id: 'K', private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }), api_host: 'intersight.com' }, extraParameters || {});
  const out = JSON.parse(new Function('value', code)(JSON.stringify(parameters)));
  return { fi: out.fis[0], errors: out.api.errors.filter(e => e.startsWith('units:')) };
}

let r = runCollector(0.455, 0.7);
check('default scale 100 on 0-1 ratios (real format): port 0.455 -> 45.5 %, idle 0.7 -> CPU 30 %, no warning',
  r.fi.ports[0].util === 45.5 && r.fi.cpu_util === 30 && r.errors.length === 0);

r = runCollector(45.5, 70);
check('values already in percent with scale 100 -> both reported (above 100 %), naming {$INTERSIGHT.PERCENT.SCALE}',
  r.errors.length === 2 && r.errors.every(e => e.includes('above 100') && e.includes('{$INTERSIGHT.PERCENT.SCALE}')));

r = runCollector(45.5, 70, { percent_scale: '1' });
check('percent_scale 1 for a future 0-100 format -> 45.5 %, CPU 30 %, no warning', r.fi.ports[0].util === 45.5 && r.fi.cpu_util === 30 && r.errors.length === 0);

r = runCollector(0.455, 0.7, { percent_scale: '1' });
check('percent_scale 1 on 0-1 ratios -> idle <= 1 on every FI reported as a probable ratio',
  r.errors.length === 1 && r.errors[0].includes('system.cpu.utilization_idle') && r.errors[0].includes('{$INTERSIGHT.PERCENT.SCALE}'));

// Base units only (user requirement): stored values must be in W, Wh, g, s, bps..., never
// kWh, kg or ms, so that Grafana and external TSDBs get the raw value. Zabbix adds K/M/G
// prefixes on display only (Zabbix 7.0 "Unit symbols", "Item value suffixes"). "!" stops those prefixes (Zabbix 7.0 "Unit symbols"): kept
// for units where a prefix makes no sense (rpm, EUR). B (bytes, size of the pushed JSON) is
// shown with base-2 prefixes, 1536 B -> "1.5 KB" (Zabbix 7.0 "Unit symbols", "Item value suffixes").
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');
const units = [...yaml.matchAll(/^\s+units: (.+)$/gm)].map(m => m[1].replace(/'/g, ''));
const allowed = ['%', 'W', 'Wh', 'g', 's', 'bps', 'B', '°C', '!rpm', '!EUR'];
check(`template units are all from the reviewed list (${[...new Set(units)].sort().join(' ')})`, units.length > 0 && units.every(u => allowed.includes(u)));
check('no prefixed unit (kWh, kg, ms, KB, with or without "!")', !units.some(u => /^!?(k|K|M|G|m)(W|Wh|g|s|bps|B)$/.test(u)));
check('no bare rpm / EUR (would display e.g. "1.5 Krpm")', !units.some(u => ['rpm', 'EUR'].includes(u)));
check('energy in Wh: power average * 24, no /1000', /^\s+params: avg\(\/\/intersight\.power,24h\)\*24$/m.test(yaml) && !yaml.includes('intersight.energy.kwh'));
const costFormulas = [...yaml.matchAll(/^\s+params: (last\(\/\/.*\{\$INTERSIGHT\.(?:ENERGY\.PRICE|CO2\.G\.KWH)\}.*)$/gm)].map(m => m[1]);
check(`cost and CO2 divide Wh by 1000 (macros per kWh): ${costFormulas.length} formulas`, costFormulas.length >= 4 && costFormulas.every(f => f.endsWith('/1000')));
check('API duration trigger threshold in seconds (> 90)', /intersight\.api\.run\.time,#3\)>90$/m.test(yaml));
// A unit change must come with a new key (new UUID): otherwise the old history (kWh, kg, ms)
// would be read in the new unit, and calculations could read a last value in the old unit.
const keys = [...yaml.matchAll(/^\s+key: (.+)$/gm)].map(m => m[1].replace(/'/g, ''));
const oldKeys = ['intersight.energy.kwh.24h', 'intersight.api.duration', 'intersight.api.sign',
  'intersight.total.energy[', 'intersight.total.co2[', 'intersight.model.energy[', 'intersight.model.co2['];
check('keys whose unit changed are renamed (no kWh / kg / ms history reused)',
  !keys.some(k => oldKeys.some(o => o.endsWith('[') ? k.startsWith(o) : k === o)) &&
  ['intersight.api.run.time', 'intersight.api.sign.time', 'intersight.total.energy.24h[Servers]', 'intersight.total.co2.24h[FI]',
   'intersight.model.energy.24h[{#CLASS},{#MODEL}]', 'intersight.model.co2.24h[{#CLASS},{#MODEL}]'].every(k => keys.includes(k)));
const runOutput = JSON.parse(new Function('value', code)(JSON.stringify({ key_id: 'K', private_key: ecKey.privateKey.export({ type: 'sec1', format: 'pem' }), api_host: 'intersight.com' })));
check('collector reports API durations in seconds (duration_s, sign_s), no *_ms field',
  typeof runOutput.api.duration_s === 'number' && typeof runOutput.api.sign_s === 'number' &&
  runOutput.api.duration_s < 60 && !('duration_ms' in runOutput.api) && !('sign_ms' in runOutput.api));
check('template macro {$INTERSIGHT.PERCENT.SCALE} defaults to 100', /macro: '\{\$INTERSIGHT\.PERCENT\.SCALE\}'\n\s+value: '100'/.test(yaml));
