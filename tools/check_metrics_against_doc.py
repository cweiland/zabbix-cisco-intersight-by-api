"""Checks that every instrument and field queried by src/collector.js exists in an
Intersight "Supported Metrics" document (appliance on-prem doc, HTML tables in .md).

Usage:
    python3 tools/check_metrics_against_doc.py path/to/Supported_Metrices.md

The document is not stored in this repository (Cisco content). Download it from your
appliance version, e.g.:
    https://cdn.intersight.com/components/an-hulk/<build>/docs/onprem/data/resources/monitoring/en/Supported_Metrices.md

Rollup suffixes (_count, _max, _min, _duration) are accepted on top of a documented
metric name: the document lists base metrics only.
Exit code 1 if anything is missing.
"""
import html
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROLLUP_SUFFIX = re.compile(r'_(count|max|min|duration)$')


def parse_document(path):
    text = open(path, encoding='utf-8').read()
    instruments, metrics = set(), set()
    for section in re.split(r'\n## ', text)[1:]:
        name = re.search(r'\*\*Name:\*\*\s*\[([^\]]+)\]', section)
        if name:
            instruments.add(name.group(1))
        for row in re.findall(r'<tr>(.*?)</tr>', section, re.S):
            cells = [html.unescape(re.sub(r'<[^>]+>', '', c)).strip() for c in re.findall(r'<td>(.*?)</td>', row, re.S)]
            if len(cells) > 1:
                metrics.add(cells[1])
    return instruments, metrics


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    instruments, metrics = parse_document(sys.argv[1])
    source = open(os.path.join(ROOT, 'src', 'collector.js'), encoding='utf-8').read()
    block = source[source.index('var TELEMETRY_QUERIES'):source.index('// Key of a device in the telemetry map')]
    used_instruments = re.findall(r"instrument: '([^']+)'", block)
    used_fields = re.findall(r"fieldName: '([^']+)'", block)

    problems = [i for i in used_instruments if i not in instruments]
    problems += [f for f in used_fields if f not in metrics and ROLLUP_SUFFIX.sub('', f) not in metrics]
    print('Document: %d instruments, %d metrics' % (len(instruments), len(metrics)))
    print('Collector: %d instruments, %d fields' % (len(used_instruments), len(used_fields)))
    if problems:
        print('NOT FOUND in the document:\n  ' + '\n  '.join(problems))
        sys.exit(1)
    print('OK: every instrument and field used by the collector is documented.')


if __name__ == '__main__':
    main()
