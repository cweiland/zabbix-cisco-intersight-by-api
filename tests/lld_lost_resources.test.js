// Lost resources of the "PSU discovery" and "Network port discovery" rules (device templates).
// Without enabled_lifetime_type, the Zabbix 7.0 import defaults to DISABLE_IMMEDIATELY
// (ui/include/classes/import/validators/C70XmlValidator.php): one run without telemetry
// (psus / ports = []) disabled every PSU and port. Both rules now set the four fields, each
// holding one macro and nothing else ("User macros supported by location", note 1), and the
// delete delay must be longer than the disable delay (Zabbix 7.0 "Low-level discovery").
const fs = require('fs'), path = require('path');
const check = (label, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + label);
  if (!condition) process.exitCode = 1;
};
const yaml = fs.readFileSync(path.join(__dirname, '..', 'templates', 'zbx_intersight_templates_7.0.yaml'), 'utf8');

// Text of each template block, split on "- uuid: ..." + "template: <name>".
const templateBlocks = yaml.split(/\n  - uuid: \w+\n    template: /).slice(1);
const blockOf = name => templateBlocks.find(block => block.startsWith(name + '\n')) || '';
// Header of a discovery rule: from its "name:" line to its "lld_macro_paths:" line.
const ruleHeader = (block, ruleName) => {
  const start = block.indexOf('      name: ' + ruleName + '\n');
  if (start < 0) return '';
  const end = block.indexOf('      lld_macro_paths:\n', start);
  return end < 0 ? '' : block.slice(start, end);
};
// Plain text search: the "value:" line that follows "macro: '{$<name>}'".
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

const EXPECTED_LIFETIME_LINES = [
  '      lifetime_type: DELETE_AFTER',
  "      lifetime: '{$INTERSIGHT.LLD.LOST.DELETE}'",
  '      enabled_lifetime_type: DISABLE_AFTER',
  "      enabled_lifetime: '{$INTERSIGHT.LLD.LOST.DISABLE}'"
];

for (const template of ['Cisco Intersight Server by push', 'Cisco Intersight Chassis by push', 'Cisco Intersight FI by push']) {
  const block = blockOf(template);
  for (const rule of ['PSU discovery', 'Network port discovery']) {
    const lifetimeLines = ruleHeader(block, rule).split('\n').filter(line => /^ {6}(enabled_)?lifetime(_type)?: /.test(line));
    check(`${template} / ${rule}: exactly the four lost-resource fields, one macro each`,
      JSON.stringify(lifetimeLines) === JSON.stringify(EXPECTED_LIFETIME_LINES));
  }
  const disable = macroValue(block, 'INTERSIGHT.LLD.LOST.DISABLE'), remove = macroValue(block, 'INTERSIGHT.LLD.LOST.DELETE');
  check(`${template}: defaults DISABLE = 1h, DELETE = 7d`, disable === '1h' && remove === '7d');
  check(`${template}: default delete delay longer than disable delay`, durationSeconds(remove) > durationSeconds(disable));
}
