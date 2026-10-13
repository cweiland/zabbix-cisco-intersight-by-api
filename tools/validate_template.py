"""Structural checks on the generated Zabbix template (no Zabbix needed).

Usage: python3 tools/validate_template.py   (requires PyYAML)
Exit code 1 on the first category of problems found.

Checks: macro names are valid {$...}, every macro used is defined in the same
template, UUIDs are unique UUIDv4, item keys are unique per template, triggers
only reference items of their own template, value maps used are defined.
"""
import os
import re
import sys

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, 'templates', 'zbx_intersight_templates_7.0.yaml')
MACRO_NAME = re.compile(r'\{\$[A-Z0-9_.]+\}')
UUID_V4 = re.compile(r'[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}')


def walk_uuids(node, found):
    if isinstance(node, dict):
        if 'uuid' in node:
            found.append(node['uuid'])
        for child in node.values():
            walk_uuids(child, found)
    elif isinstance(node, list):
        for child in node:
            walk_uuids(child, found)


def main():
    export = yaml.safe_load(open(TEMPLATE, encoding='utf-8'))['zabbix_export']
    problems = []

    uuids = []
    walk_uuids(export, uuids)
    problems += ['duplicate uuid ' + u for u in set(uuids) if uuids.count(u) > 1]
    problems += ['not a UUIDv4: ' + u for u in uuids if not UUID_V4.fullmatch(u)]

    for template in export['templates']:
        name = template['template']
        defined = set()
        for macro in template.get('macros', []):
            if not MACRO_NAME.fullmatch(macro['macro']):
                problems.append('%s: invalid macro name %r' % (name, macro['macro']))
            defined.add(macro['macro'])
        used = set(MACRO_NAME.findall(yaml.dump(template)))
        problems += ['%s: macro %s used but not defined' % (name, m) for m in sorted(used - defined)]

        keys = [item['key'] for item in template['items']]
        problems += ['%s: duplicate item key %s' % (name, k) for k in set(keys) if keys.count(k) > 1]

        own_items = '/' + re.escape(name) + '/'
        for item in template['items']:
            for trigger in item.get('triggers', []):
                for key in re.findall(own_items + r'([^,)]+)', trigger['expression']):
                    if key != item['key']:
                        problems.append('%s: trigger %r references %s' % (name, trigger['name'], key))
        for rule in template.get('discovery_rules', []):
            prototype_keys = {p['key'] for p in rule.get('item_prototypes', [])}
            for trigger in rule.get('trigger_prototypes', []):
                for key in re.findall(own_items + r'([^,)]+)', trigger['expression']):
                    if key not in prototype_keys:
                        problems.append('%s: trigger prototype %r references %s' % (name, trigger['name'], key))

        valuemaps = {v['name'] for v in template.get('valuemaps', [])}
        all_items = template['items'] + [p for r in template.get('discovery_rules', []) for p in r.get('item_prototypes', [])]
        problems += ['%s: value map %r not defined' % (name, i['valuemap']['name'])
                     for i in all_items if 'valuemap' in i and i['valuemap']['name'] not in valuemaps]

    if problems:
        print('Template problems:\n  ' + '\n  '.join(problems))
        sys.exit(1)
    print('OK: %d templates, %d UUIDs, macros / keys / triggers / value maps consistent.'
          % (len(export['templates']), len(uuids)))


if __name__ == '__main__':
    main()
