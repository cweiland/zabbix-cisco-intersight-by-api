// Rule: the collector only queries Druid fields documented by Cisco (no inferred names).
// Every instrument, dataSource and field in TELEMETRY_QUERIES must exist in
// docs/intersight_metrics.json, the catalog extracted from the Intersight
// "Supported Metrics" pages by tools/build_metrics_catalog.py.
const fs = require('fs'), path = require('path');
const check = (label, condition) => { console.log((condition ? 'PASS ' : 'FAIL ') + label); if (!condition) process.exitCode = 1; };
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'intersight_metrics.json'), 'utf8')).instruments;
const source = fs.readFileSync(process.env.COLLECTOR_CODE_FILE || path.join(__dirname, '..', 'src', 'collector.js'), 'utf8');
const block = source.slice(source.indexOf('var TELEMETRY_QUERIES'), source.indexOf('function buildTelemetryKey'));
const DATASOURCE_BY_KIND = { physical: 'PhysicalEntities', network: 'NetworkInterfaces' };

// field name -> "<instrument> / <metric> / <Sum|Count|Max rate|...>"
const fieldIndex = {};
for (const [instrument, info] of Object.entries(catalog)) {
  for (const [metric, m] of Object.entries(info.metrics)) {
    for (const [kind, field] of Object.entries(m.fields)) fieldIndex[instrument + '|' + field] = `${metric} (${kind})`;
  }
}

const queries = block.split(/\n    \{\n/).slice(1);
check(`found ${queries.length} telemetry queries`, queries.length > 0);
for (const query of queries) {
  const instrument = (/instrument: '([^']+)'/.exec(query) || [])[1];
  const kind = (/dataSource: '([^']+)'/.exec(query) || [])[1];
  const info = catalog[instrument];
  check(`instrument ${instrument} is in the catalog`, !!info);
  if (!info) continue;
  check(`instrument ${instrument} uses dataSource ${info.dataSource}`, DATASOURCE_BY_KIND[kind] === info.dataSource);
  for (const [, field] of query.matchAll(/fieldName: '([^']+)'/g)) {
    const documented = fieldIndex[instrument + '|' + field];
    check(`${instrument}: field ${field} is documented${documented ? ' as ' + documented : ''}`, !!documented);
  }
}
// Attributes used for grouping must be attributes of each instrument.
const baseAttributes = JSON.parse(((/var GROUP_BY_ATTRIBUTES = (\[[^\]]*\])/.exec(source) || [])[1] || '[]').replace(/'/g, '"'));
const componentAttribute = (/druidComponentDimension: itemParameters\.component_dim \|\| '([^']+)'/.exec(source) || [])[1];
check(`grouping attributes found (${baseAttributes.join(', ')}; component: ${componentAttribute})`, baseAttributes.length > 0 && !!componentAttribute);
for (const query of queries) {
  const instrument = (/instrument: '([^']+)'/.exec(query) || [])[1];
  if (!catalog[instrument]) continue;
  const extra = JSON.parse(((/extraAttributes: (\[[^\]]*\])/.exec(query) || [])[1] || '[]').replace(/'/g, '"'));
  const attributes = baseAttributes.concat(/perComponent: true/.test(query) ? [componentAttribute] : [], extra);
  for (const attribute of attributes) {
    check(`${instrument}: attribute ${attribute} is documented`, catalog[instrument].attributes.includes(attribute));
  }
}
check('telemetry endpoint is the documented /api/v1/telemetry/TimeSeries', source.includes("'/api/v1/telemetry/TimeSeries'"));
