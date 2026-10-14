"""Builds docs/intersight_metrics.json from the Intersight "Supported Metrics" pages.

Usage:
    python3 tools/build_metrics_catalog.py <folder with hw-*.md / system-*.md pages>

Input: the per-instrument pages of https://intersight.com/apidocs/introduction/ saved as
Markdown (hw-host.md, hw-temperature.md, ...). They are Cisco content and are not stored
in this repository; only the factual catalog extracted from them is (instrument, data
source, metric names, type, supported device types, Druid field names).
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_page(text):
    instrument = re.search(r'^\*\*Label\*\*: (\S+)', text, re.M).group(1)
    data_source = re.search(r'^\*\*Data source\*\*: (\S+)', text, re.M).group(1)
    metrics = {}
    for section in re.split(r'\n## Metric ', text)[1:]:
        name = re.search(r'Name\*+: (\S+)', section).group(1)
        metric_type = re.search(r'Metric type\*+: (\S+)', section).group(1)
        support = re.findall(r'^- (\S+)', section.split('**Available metrics**')[0], re.M)
        fields = dict(re.findall(r'^\|(Sum|Count|Duration|Max rate|Min rate)\|([^|]+)\|', section, re.M))
        metrics[name] = {'type': metric_type, 'support': support, 'fields': fields}
    attributes = re.findall(r'^\|[^|]+\|([a-z_.]+)\|', text.split('## Attributes')[1].split('\n## ')[0], re.M)
    return instrument, {'dataSource': data_source, 'metrics': metrics, 'attributes': sorted(set(attributes))}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    catalog = {}
    for path in sorted(glob.glob(os.path.join(sys.argv[1], '*.md'))):
        text = open(path, encoding='utf-8').read()
        if '**Data source**' not in text:
            continue
        instrument, info = parse_page(text)
        info['page'] = os.path.basename(path)
        catalog[instrument] = info
    output = {
        '_source': 'Cisco Intersight "Supported Metrics" pages (intersight.com/apidocs/introduction/<instrument>)',
        '_rule': 'src/collector.js may only query fields listed here (tests/documented_fields.test.js).',
        'instruments': catalog,
    }
    target = os.path.join(ROOT, 'docs', 'intersight_metrics.json')
    # One line per instrument: compact, yet readable in a git diff.
    lines = ['{', '"_rule": %s,' % json.dumps(output['_rule']), '"_source": %s,' % json.dumps(output['_source']),
             '"instruments": {']
    names = sorted(catalog)
    for index, name in enumerate(names):
        lines.append('%s: %s%s' % (json.dumps(name), json.dumps(catalog[name], sort_keys=True, separators=(',', ':')),
                                   ',' if index < len(names) - 1 else ''))
    lines += ['}', '}']
    with open(target, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    print('%d instruments, %d metrics, %d fields -> %s' % (
        len(catalog), sum(len(i['metrics']) for i in catalog.values()),
        sum(len(m['fields']) for i in catalog.values() for m in i['metrics'].values()), target))


if __name__ == '__main__':
    main()
