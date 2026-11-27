"""Generates templates/zbx_intersight_templates_7.0.yaml from src/collector.js.

Usage: python3 tools/generate_templates.py   (requires PyYAML)
UUIDs are derived from names, so regenerating gives stable UUIDs.

Zabbix rejects item scripts longer than 65535 characters (import error
'Invalid parameter "/N/params": value is too long'). The template therefore embeds a
copy of src/collector.js without its comments: see strip_comments(). The commented
file stays the source of truth.
"""
import hashlib, os, yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PARENT = 'Cisco Intersight by API'
TSRV = 'Cisco Intersight Server by push'
TCHA = 'Cisco Intersight Chassis by push'
TFI = 'Cisco Intersight FI by push'
TGROUP = 'Templates/Cisco Intersight'
ZABBIX_MAX_SCRIPT_LENGTH = 65535
EMBEDDED_SCRIPT_HEADER = (
    '// Generated from src/collector.js by tools/generate_templates.py: comments stripped\n'
    '// to fit the 65535-character limit of Zabbix scripts. Edit the source, not this copy.\n'
)


def strip_comments(script):
    """Removes the leading /* ... */ header block and every full-line // comment.

    Only whole comment lines are removed: code lines are never modified, so a "//"
    inside a string (e.g. 'https://') cannot be damaged. Consecutive blank lines are
    collapsed into one.
    """
    if script.startswith('/*'):
        script = script[script.index('*/') + 2:].lstrip('\n')
    kept_lines, previous_blank = [], False
    for line in script.split('\n'):
        if line.strip().startswith('//'):
            continue
        blank = line.strip() == ''
        if blank and previous_blank:
            continue
        kept_lines.append(line.rstrip())
        previous_blank = blank
    stripped = EMBEDDED_SCRIPT_HEADER + '\n'.join(kept_lines).strip('\n') + '\n'
    if len(stripped) > ZABBIX_MAX_SCRIPT_LENGTH:
        raise SystemExit('Embedded script is %d characters, above the Zabbix limit of %d'
                         % (len(stripped), ZABBIX_MAX_SCRIPT_LENGTH))
    return stripped


def uid(*parts):
    h = list(hashlib.md5('|'.join(parts).encode()).hexdigest())
    h[12] = '4'
    h[16] = '89ab'[int(h[16], 16) % 4]
    return ''.join(h)


class Lit(str):
    pass


yaml.add_representer(Lit, lambda d, v: d.represent_scalar('tag:yaml.org,2002:str', v, style='|'))


def jp(path, handler='DISCARD_VALUE', hb=None):
    steps = [{'type': 'JSONPATH', 'parameters': [path], 'error_handler': handler}]
    if hb:
        steps.append({'type': 'DISCARD_UNCHANGED_HEARTBEAT', 'parameters': [hb]})
    return steps


def trig(tpl, key, expr, name, prio, desc=None, manual=False, ctx='', opdata=None, tags=None):
    t = {'uuid': uid(tpl, key, name, ctx), 'expression': expr.replace('$T', tpl), 'name': name, 'priority': prio}
    if opdata:
        t['opdata'] = opdata
    if desc:
        t['description'] = desc
    if manual:
        t['manual_close'] = 'YES'
    if tags:
        t['tags'] = tags
    return t


def dep(tpl, master, name, key, path, vtype='FLOAT', units=None, tags=None, hb=None,
        inv=None, vmap=None, triggers=None, history=None):
    it = {'uuid': uid(tpl, key), 'name': name, 'type': 'DEPENDENT', 'key': key,
          'value_type': vtype, 'master_item': {'key': master}}
    if history:
        it['history'] = history
    if vtype in ('CHAR', 'TEXT'):
        it['trends'] = '0'
    if units:
        it['units'] = units
    if vmap:
        it['valuemap'] = {'name': vmap}
    if inv:
        it['inventory_link'] = inv
    it['preprocessing'] = jp(path, hb=hb)
    it['tags'] = tags or []
    if triggers:
        it['triggers'] = triggers
    return it


def calc(tpl, name, key, formula, units=None, delay='5m', tags=None, triggers=None):
    it = {'uuid': uid(tpl, key), 'name': name, 'type': 'CALCULATED', 'key': key, 'delay': delay,
          'value_type': 'FLOAT', 'params': formula}
    if units:
        it['units'] = units
    it['tags'] = tags or []
    if triggers:
        it['triggers'] = triggers
    return it


def macro(m, v, d, secret=False):
    x = {'macro': m, 'value': v, 'description': d}
    if secret:
        x['type'] = 'SECRET_TEXT'
        del x['value']
    return x


# ------------------------------------------------------------------ Intersight alarms
# Each Intersight alarm (cond.Alarm) becomes a Zabbix problem on the host of its device.
# One-way mirror: nothing is written to Intersight, actions on Zabbix problems have no effect there.
# Lifecycle (Cisco "Intersight Alarms Reference Guide", "Intersight Alarms Overview"): Active,
# Acknowledged, Suppressed, Cleared; acknowledging does not change the severity, so an
# acknowledged or suppressed alarm keeps its problem open: only Cleared (severity 0) closes it.
# User choices: Critical -> High (not Disaster); Info alarms raise problems too (the Info
# prototype can be disabled).
ALARM_TRIGGER_PRIORITY = [(3, 'HIGH'), (2, 'WARNING'), (1, 'INFO')]
ALARM_VALUE_HEARTBEAT = '1h'   # {$INTERSIGHT.ALARM.NODATA} must stay above this heartbeat
ALARM_VALUEMAPS = [
    ('Intersight alarm severity', [('0', 'Cleared'), ('1', 'Info'), ('2', 'Warning'), ('3', 'Critical')]),
    ('Intersight alarm acknowledged', [('0', 'No'), ('1', 'Yes')]),
    ('Intersight alarm suppressed', [('0', 'No'), ('1', 'Yes')]),
]


def alarm_valuemaps(T):
    return [{'uuid': uid(T, 'vm', name), 'name': name,
             'mappings': [{'value': v, 'newvalue': n} for v, n in mappings]} for name, mappings in ALARM_VALUEMAPS]


def alarm_macros():
    return [
        macro('{$INTERSIGHT.ALARM.NODATA}', '2h',
              'An alarm item without value for this long closes its problem (alarm gone from Intersight '
              'without Cleared, or collector down). Must stay above the 1h heartbeat of the alarm items.'),
        macro('{$INTERSIGHT.ALARM.LOST.DISABLE}', '1d',
              'Alarms no longer reported by Intersight: items disabled after this long. Must be shorter '
              'than {$INTERSIGHT.ALARM.LOST.DELETE} (Zabbix 7.0 "Low-level discovery").'),
        macro('{$INTERSIGHT.ALARM.LOST.DELETE}', '7d',
              'Alarms no longer reported by Intersight: items deleted after this long. Must be longer '
              'than {$INTERSIGHT.ALARM.LOST.DISABLE}.'),
    ]


def alarm_discovery(T, master, path):
    """LLD rule "Intersight alarms" on the list `path` of the master item (one entry per alarm)."""
    item = lambda field: 'intersight.alarm.%s[{#ALARM.ID}]' % field
    select = lambda field: "%s[?(@.id=='{#ALARM.ID}')].%s.first()" % (path, field)
    # A new list per object: a shared one would be written as a YAML anchor / alias.
    tags = lambda: [{'tag': 'component', 'value': 'alarm'}, {'tag': 'alarm-code', 'value': '{#ALARM.CODE}'}]
    prototypes = [
        dep(T, master, 'Alarm {#ALARM.NAME} on {#ALARM.TARGET}: ' + label, item(field), select(field), 'UNSIGNED',
            tags=tags(), vmap=vmap, hb=ALARM_VALUE_HEARTBEAT)
        for field, label, vmap in (('severity', 'severity', 'Intersight alarm severity'),
                                   ('ack', 'acknowledged', 'Intersight alarm acknowledged'),
                                   ('suppressed', 'suppressed', 'Intersight alarm suppressed'))]
    # {ITEM.LASTVALUE<N>} is the item of the Nth FUNCTION of the expression (Zabbix 7.0 source:
    # zbxeval/parse.c numbers each function, zbxdbwrap/trigger.c zbx_db_trigger_get_itemid reads
    # that number). Expression macros {?...} are not supported in operational data. Hence the
    # always-true "last(ack)>=0" (function 2) and "last(suppressed)>=0" (function 3): they only
    # make these items available as {ITEM.LASTVALUE2} and {ITEM.LASTVALUE3}; keep this order.
    # Limit: if the ack or suppressed item becomes unsupported, the trigger can become unknown.
    # nodata() (any value type, period >= 30s) closes the problem when the alarm leaves the data.
    expression = ('last(/$T/%s)=%%d and last(/$T/%s)>=0 and last(/$T/%s)>=0 '
                  'and nodata(/$T/%s,{$INTERSIGHT.ALARM.NODATA})=0'
                  % (item('severity'), item('ack'), item('suppressed'), item('severity')))
    triggers = [trig(T, 'alarm', expression % level, 'Intersight alarm: {#ALARM.NAME} on {#ALARM.TARGET}',
                     priority, ctx=str(level), tags=tags(),
                     opdata='Acknowledged in Intersight: {ITEM.LASTVALUE2}, suppressed: {ITEM.LASTVALUE3}',
                     desc='Mirror of Intersight alarm {#ALARM.ID} (code {#ALARM.CODE}). Acknowledging or '
                          'suppressing it in Intersight keeps the problem open; only Cleared closes it. '
                          'Nothing done here is sent to Intersight.')
                for level, priority in ALARM_TRIGGER_PRIORITY]
    return {
        'uuid': uid(T, 'alarm.discovery'), 'name': 'Intersight alarms', 'type': 'DEPENDENT',
        'key': 'intersight.alarm.discovery', 'master_item': {'key': master},
        # One macro per field, nothing else ("User macros supported by location", note 1).
        'lifetime_type': 'DELETE_AFTER', 'lifetime': '{$INTERSIGHT.ALARM.LOST.DELETE}',
        'enabled_lifetime_type': 'DISABLE_AFTER', 'enabled_lifetime': '{$INTERSIGHT.ALARM.LOST.DISABLE}',
        'lld_macro_paths': [{'lld_macro': '{#ALARM.ID}', 'path': '$.id'},
                            {'lld_macro': '{#ALARM.NAME}', 'path': '$.name'},
                            {'lld_macro': '{#ALARM.CODE}', 'path': '$.code'},
                            {'lld_macro': '{#ALARM.TARGET}', 'path': '$.target'}],
        # No list (alarm request failed): discard, so that no alarm is marked as lost.
        'preprocessing': [{'type': 'JSONPATH', 'parameters': [path], 'error_handler': 'DISCARD_VALUE'}],
        'item_prototypes': prototypes,
        'trigger_prototypes': triggers,
    }


# ------------------------------------------------------------------ PSU and port discovery
# Lost resources of the PSU and port rules. Without enabled_lifetime_type, the Zabbix 7.0 import
# defaults to DISABLE_IMMEDIATELY (C70XmlValidator.php): one run without telemetry (psus / ports
# set to []) disabled every PSU and port until the next run. One macro per field, nothing else
# ("User macros supported by location", note 1).
COMPONENT_LLD_LIFETIME = {
    'lifetime_type': 'DELETE_AFTER', 'lifetime': '{$INTERSIGHT.LLD.LOST.DELETE}',
    'enabled_lifetime_type': 'DISABLE_AFTER', 'enabled_lifetime': '{$INTERSIGHT.LLD.LOST.DISABLE}',
}


def component_lld_macros():
    return [
        macro('{$INTERSIGHT.LLD.LOST.DISABLE}', '1h',
              'PSUs and ports no longer reported: items disabled after this long. Must be shorter than '
              '{$INTERSIGHT.LLD.LOST.DELETE} (Zabbix 7.0 "Low-level discovery").'),
        macro('{$INTERSIGHT.LLD.LOST.DELETE}', '7d',
              'PSUs and ports no longer reported: items deleted after this long. Must be longer than '
              '{$INTERSIGHT.LLD.LOST.DISABLE}.'),
    ]


# Lost resources of the parent rules (servers, chassis, FI and models discovery). Same default
# DISABLE_IMMEDIATELY at import (C70XmlValidator.php), and disabling "affects lost hosts, items
# and triggers" (Zabbix 7.0 "Low-level discovery"). The collector already leaves out a list whose
# request failed (the rule discards the value); this delay is the second protection.
HOST_LLD_LIFETIME = {
    'lifetime_type': 'DELETE_AFTER', 'lifetime': '{$INTERSIGHT.HOST.LOST.DELETE}',
    'enabled_lifetime_type': 'DISABLE_AFTER', 'enabled_lifetime': '{$INTERSIGHT.HOST.LOST.DISABLE}',
}


HOST_LOST_DISABLE_DEFAULT = '1h'
HOST_LOST_DELETE_DEFAULT = '7d'


def host_lld_macros():
    return [
        macro('{$INTERSIGHT.HOST.LOST.DISABLE}', HOST_LOST_DISABLE_DEFAULT,
              'Servers, chassis, FIs and models no longer reported: discovered hosts and model items disabled '
              'after this long. Must be shorter than {$INTERSIGHT.HOST.LOST.DELETE} '
              '(Zabbix 7.0 "Low-level discovery").'),
        macro('{$INTERSIGHT.HOST.LOST.DELETE}', HOST_LOST_DELETE_DEFAULT,
              'Servers, chassis, FIs and models no longer reported: discovered hosts and model items deleted '
              'after this long (history lost). Must be longer than {$INTERSIGHT.HOST.LOST.DISABLE}.'),
    ]


# Same macros on the chassis template, for the Zabbix 7.4 nested "Blades discovery" rule added by
# hand (docs/UPGRADE_7.4_FR.md). That rule runs on the discovered chassis hosts, which only link
# the chassis template: a macro of the parent template does not resolve there. Not used in 7.0.
def nested_blade_lld_macros():
    return [
        macro('{$INTERSIGHT.HOST.LOST.DISABLE}', HOST_LOST_DISABLE_DEFAULT,
              'Zabbix 7.4 nested blade discovery (docs/UPGRADE_7.4_FR.md): blade hosts no longer reported '
              'disabled after this long. Keep the same value as on the template "' + PARENT + '": a chassis '
              'host does not inherit the macros of the parent template. Must be shorter than '
              '{$INTERSIGHT.HOST.LOST.DELETE} (Zabbix 7.0 "Low-level discovery").'),
        macro('{$INTERSIGHT.HOST.LOST.DELETE}', HOST_LOST_DELETE_DEFAULT,
              'Zabbix 7.4 nested blade discovery (docs/UPGRADE_7.4_FR.md): blade hosts no longer reported '
              'deleted after this long (history lost). Keep the same value as on the template "' + PARENT +
              '": a chassis host does not inherit the macros of the parent template. Must be longer than '
              '{$INTERSIGHT.HOST.LOST.DISABLE}.'),
    ]


# ------------------------------------------------------------------ child templates
def child(tpl, cls, label, extra_items):
    T = tpl
    tag = lambda c: [{'tag': 'component', 'value': c}]
    items = [{
        'uuid': uid(T, 'intersight.raw'), 'name': 'Raw data (pushed by Intersight collector)',
        'type': 'TRAP', 'key': 'intersight.raw', 'history': '1h', 'value_type': 'TEXT', 'trends': '0',
        'description': 'Filled by the parent host "' + PARENT + '" through the history.push API method. '
                       'If Allowed hosts is set, it must include the Zabbix frontend IP.',
        'tags': tag('raw'),
        'triggers': [trig(T, 'raw', 'nodata(/$T/intersight.raw,{$INTERSIGHT.NODATA})=1',
                          'Intersight: no data pushed for {$INTERSIGHT.NODATA}', 'WARNING',
                          'Check the parent collector item (API errors, push errors, API token).')]
    }]
    items += [
        dep(T, 'intersight.raw', 'Alarms: critical', 'intersight.alarms.critical', '$.alarm_critical', 'UNSIGNED',
            tags=tag('alarms'), triggers=[trig(T, 'ac', 'last(/$T/intersight.alarms.critical)>0',
                                                'Intersight: {ITEM.LASTVALUE1} critical alarm(s)', 'HIGH')]),
        dep(T, 'intersight.raw', 'Alarms: warning', 'intersight.alarms.warning', '$.alarm_warning', 'UNSIGNED',
            tags=tag('alarms'), triggers=[trig(T, 'aw', 'last(/$T/intersight.alarms.warning)>0',
                                                'Intersight: {ITEM.LASTVALUE1} warning alarm(s)', 'WARNING')]),
        dep(T, 'intersight.raw', 'Model', 'intersight.model', '$.model', 'CHAR', tags=tag('inventory'),
            hb='1d', inv='MODEL', history='7d'),
        dep(T, 'intersight.raw', 'Serial number', 'intersight.serial', '$.serial', 'CHAR', tags=tag('inventory'),
            hb='1d', inv='SERIALNO_A', history='7d'),
        dep(T, 'intersight.raw', 'Power: average', 'intersight.power', '$.power_w', units='W', tags=tag('power')),
        dep(T, 'intersight.raw', 'Power: peak', 'intersight.power.max', '$.power_max_w', units='W', tags=tag('power')),
        dep(T, 'intersight.raw', 'Temperature: hottest sensor', 'intersight.temp.max', '$.temp_max', units='°C',
            tags=tag('thermal')),
        dep(T, 'intersight.raw', 'Fans: lowest speed', 'intersight.fan.min', '$.fan_min', units='!rpm',
            tags=tag('fans')),
        dep(T, 'intersight.raw', 'Fans: highest speed', 'intersight.fan.max', '$.fan_max', units='!rpm',
            tags=tag('fans')),
        dep(T, 'intersight.raw', 'PSU: highest utilization', 'intersight.psu.util.max', '$.psu_util_max', units='%',
            tags=tag('psu')),
        dep(T, 'intersight.raw', 'Network: errors in window', 'intersight.net.errors', '$.net_errors',
            tags=tag('network')),
        # Base units only (Wh, not kWh): history and external tools get the raw value;
        # Zabbix adds K/M/G prefixes on display only (Zabbix 7.0 "Unit symbols").
        calc(T, 'Energy: last 24h', 'intersight.energy.24h',
             'avg(//intersight.power,24h)*24', 'Wh', '1h', tags=tag('energy')),
    ]
    items += extra_items(T, tag)
    for it in items:
        it['tags'] = it['tags'] + [{'tag': 'class', 'value': cls}]

    lld_psu = {
        'uuid': uid(T, 'psu.discovery'), 'name': 'PSU discovery', 'type': 'DEPENDENT',
        'key': 'intersight.psu.discovery', 'master_item': {'key': 'intersight.raw'}, **COMPONENT_LLD_LIFETIME,
        'lld_macro_paths': [{'lld_macro': '{#PSU}', 'path': '$.name'}],
        'preprocessing': [{'type': 'JSONPATH', 'parameters': ['$.psus'],
                           'error_handler': 'CUSTOM_VALUE', 'error_handler_params': '[]'}],
        'item_prototypes': [
            dep(T, 'intersight.raw', 'PSU {#PSU}: utilization', 'intersight.psu.util[{#PSU}]',
                "$.psus[?(@.name=='{#PSU}')].util.first()", units='%',
                tags=[{'tag': 'component', 'value': 'psu'}, {'tag': 'psu', 'value': '{#PSU}'}]),
            dep(T, 'intersight.raw', 'PSU {#PSU}: output power', 'intersight.psu.out[{#PSU}]',
                "$.psus[?(@.name=='{#PSU}')].out_w.first()", units='W',
                tags=[{'tag': 'component', 'value': 'psu'}, {'tag': 'psu', 'value': '{#PSU}'}]),
            dep(T, 'intersight.raw', 'PSU {#PSU}: input power', 'intersight.psu.in[{#PSU}]',
                "$.psus[?(@.name=='{#PSU}')].in_w.first()", units='W',
                tags=[{'tag': 'component', 'value': 'psu'}, {'tag': 'psu', 'value': '{#PSU}'}]),
        ],
    }
    lld_psu['item_prototypes'][0]['uuid'] = uid(T, 'psu.util.proto')
    lld_psu['item_prototypes'][1]['uuid'] = uid(T, 'psu.out.proto')
    lld_psu['item_prototypes'][2]['uuid'] = uid(T, 'psu.in.proto')
    lld_psu['trigger_prototypes'] = [trig(
        T, 'psu', 'min(/$T/intersight.psu.util[{#PSU}],15m)>{$INTERSIGHT.PSU.UTIL.WARN}',
        'Intersight: PSU {#PSU} above {$INTERSIGHT.PSU.UTIL.WARN}% for 15m', 'WARNING',
        'Little headroom left: losing the other PSU could overload this one.')]

    lld_port = {
        'uuid': uid(T, 'port.discovery'), 'name': 'Network port discovery', 'type': 'DEPENDENT',
        'key': 'intersight.port.discovery', 'master_item': {'key': 'intersight.raw'}, **COMPONENT_LLD_LIFETIME,
        'filter': {'evaltype': 'AND', 'conditions': [
            {'macro': '{#PORT}', 'value': '{$INTERSIGHT.PORT.MATCHES}', 'formulaid': 'A'},
            {'macro': '{#PORT}', 'value': '{$INTERSIGHT.PORT.NOT_MATCHES}', 'operator': 'NOT_MATCHES_REGEX',
             'formulaid': 'B'},
            {'macro': '{#PORT_ROLE}', 'value': '{$INTERSIGHT.PORT.ROLE.NOT_MATCHES}', 'operator': 'NOT_MATCHES_REGEX',
             'formulaid': 'C'}]},
        'lld_macro_paths': [{'lld_macro': '{#PORT}', 'path': '$.name'},
                            {'lld_macro': '{#PORT_ROLE}', 'path': '$.role'}],
        'preprocessing': [{'type': 'JSONPATH', 'parameters': ['$.ports'],
                           'error_handler': 'CUSTOM_VALUE', 'error_handler_params': '[]'}],
        'item_prototypes': [
            dep(T, 'intersight.raw', 'Port {#PORT}: received', 'intersight.port.rx[{#PORT}]',
                "$.ports[?(@.name=='{#PORT}')].rx_bps.first()", units='bps',
                tags=[{'tag': 'component', 'value': 'network'}, {'tag': 'port', 'value': '{#PORT}'},
                      {'tag': 'port_role', 'value': '{#PORT_ROLE}'}]),
            dep(T, 'intersight.raw', 'Port {#PORT}: transmitted', 'intersight.port.tx[{#PORT}]',
                "$.ports[?(@.name=='{#PORT}')].tx_bps.first()", units='bps',
                tags=[{'tag': 'component', 'value': 'network'}, {'tag': 'port', 'value': '{#PORT}'},
                      {'tag': 'port_role', 'value': '{#PORT_ROLE}'}]),
            dep(T, 'intersight.raw', 'Port {#PORT}: link speed', 'intersight.port.speed[{#PORT}]',
                "$.ports[?(@.name=='{#PORT}')].speed_bps.first()", units='bps',
                tags=[{'tag': 'component', 'value': 'network'}, {'tag': 'port', 'value': '{#PORT}'},
                      {'tag': 'port_role', 'value': '{#PORT_ROLE}'}]),
            dep(T, 'intersight.raw', 'Port {#PORT}: errors in window', 'intersight.port.errors[{#PORT}]',
                "$.ports[?(@.name=='{#PORT}')].errors.first()",
                tags=[{'tag': 'component', 'value': 'network'}, {'tag': 'port', 'value': '{#PORT}'}]),
            dep(T, 'intersight.raw', 'Port {#PORT}: bandwidth utilization', 'intersight.port.util[{#PORT}]',
                "$.ports[?(@.name=='{#PORT}')].util.first()", units='%',
                tags=[{'tag': 'component', 'value': 'network'}, {'tag': 'port', 'value': '{#PORT}'}]),
            dep(T, 'intersight.raw', 'Port {#PORT}: link state', 'intersight.port.up[{#PORT}]',
                "$.ports[?(@.name=='{#PORT}')].up.first()", 'UNSIGNED', vmap='Link state',
                tags=[{'tag': 'component', 'value': 'network'}, {'tag': 'port', 'value': '{#PORT}'}]),
        ],
        'trigger_prototypes': [trig(
            T, 'porterr', 'min(/$T/intersight.port.errors[{#PORT}],#3)>{$INTERSIGHT.PORT.ERRORS.WARN}',
            'Intersight: port {#PORT} has errors for 3 runs', 'WARNING',
            'Sum of hw.errors_network_receive_all and hw.errors_network_transmit_all over the telemetry window.'),
        trig(T, 'portutil', 'min(/$T/intersight.port.util[{#PORT}],15m)>{$INTERSIGHT.PORT.UTIL.WARN}',
             'Intersight: port {#PORT} bandwidth above {$INTERSIGHT.PORT.UTIL.WARN}% for 15m', 'WARNING'),
        trig(T, 'portdown', 'last(/$T/intersight.port.up[{#PORT}])=0 and max(/$T/intersight.port.up[{#PORT}],24h)=1',
             'Intersight: port {#PORT} link down', 'AVERAGE',
             'Fires only for links that were up during the last 24h, so unused ports stay silent. '
             'hw.network.up minimum over the window: a link down at least once reads as down.', manual=True)],
    }
    lld_port['item_prototypes'][0]['uuid'] = uid(T, 'port.rx.proto')
    lld_port['item_prototypes'][1]['uuid'] = uid(T, 'port.tx.proto')
    lld_port['item_prototypes'][2]['uuid'] = uid(T, 'port.speed.proto')
    lld_port['item_prototypes'][3]['uuid'] = uid(T, 'port.err.proto')
    lld_port['item_prototypes'][4]['uuid'] = uid(T, 'port.util.proto')
    lld_port['item_prototypes'][5]['uuid'] = uid(T, 'port.up.proto')

    return {
        'uuid': uid(T), 'template': T, 'name': T,
        'description': 'Linked by host prototypes of "' + PARENT + '". Receives data via history.push; '
                       'makes no API call itself. Class: ' + label + '.',
        'vendor': {'name': 'Custom', 'version': '7.0-6'},
        'groups': [{'name': TGROUP}],
        'items': items,
        'discovery_rules': [lld_psu, lld_port, alarm_discovery(T, 'intersight.raw', '$.alarms')],
        'tags': [{'tag': 'class', 'value': 'hardware'}, {'tag': 'target', 'value': 'cisco-intersight'}],
        'macros': [
            macro('{$INTERSIGHT.NODATA}', '20m', 'No pushed data for this long raises a warning.'),
            macro('{$INTERSIGHT.TEMP.MARGIN.WARN}', '10', 'Warn when a sensor is this close (°C) to its critical threshold.'),
            macro('{$INTERSIGHT.PORT.ERRORS.WARN}', '0', 'Port errors per telemetry window above this value raise a warning.'),
            macro('{$INTERSIGHT.PORT.UTIL.WARN}', '90', 'Port bandwidth utilization threshold (%).'),
            macro('{$INTERSIGHT.CPU.UTIL.WARN}', '90', 'CPU utilization threshold (%).'),
            macro('{$INTERSIGHT.MEM.UTIL.WARN}', '90', 'Memory utilization threshold (%), Fabric Interconnects.'),
            macro('{$INTERSIGHT.ECC.CORRECTABLE.WARN}', '0', 'Correctable ECC errors per window, sustained 3 runs.'),
            macro('{$INTERSIGHT.PSU.UTIL.WARN}', '80', 'PSU utilization threshold (%). Reported by Fabric Interconnects only.'),
            macro('{$INTERSIGHT.PORT.MATCHES}', '.*', 'Regex of ports to discover.'),
            macro('{$INTERSIGHT.PORT.NOT_MATCHES}', 'CHANGE_IF_NEEDED', 'Regex of ports to ignore.'),
            macro('{$INTERSIGHT.PORT.ROLE.NOT_MATCHES}', '^(unconfigured|vethernet|vfc|vnic|vhba)$',
                  'Regex of port roles (hw.network.port.role) to ignore. Default: unconfigured and virtual '
                  'interfaces, as excluded by the intersight-grafana dashboards.'),
        ] + component_lld_macros() + alarm_macros() + (nested_blade_lld_macros() if cls == 'chassis' else []),
        'valuemaps': [{'uuid': uid(T, 'vm'), 'name': 'Power state',
                       'mappings': [{'value': '0', 'newvalue': 'Off'}, {'value': '1', 'newvalue': 'On'}]},
                      {'uuid': uid(T, 'vm-link'), 'name': 'Link state',
                       'mappings': [{'value': '0', 'newvalue': 'Down'}, {'value': '1', 'newvalue': 'Up'}]}]
                     + alarm_valuemaps(T),
    }


def ecc_items(T, tag):
    return [
        dep(T, 'intersight.raw', 'Memory: correctable ECC errors in window', 'intersight.mem.ecc.correctable',
            '$.mem_ecc_correctable', tags=tag('memory'),
            triggers=[trig(T, 'eccc', 'min(/$T/intersight.mem.ecc.correctable,#3)>{$INTERSIGHT.ECC.CORRECTABLE.WARN}',
                           'Intersight: correctable ECC errors for 3 runs', 'WARNING',
                           'See item "Memory: DIMMs with ECC errors". Persistent correctable errors often precede a DIMM failure.')]),
        dep(T, 'intersight.raw', 'Memory: uncorrectable ECC errors in window', 'intersight.mem.ecc.uncorrectable',
            '$.mem_ecc_uncorrectable', tags=tag('memory'),
            triggers=[trig(T, 'eccu', 'last(/$T/intersight.mem.ecc.uncorrectable)>0',
                           'Intersight: {ITEM.LASTVALUE1} uncorrectable ECC error(s)', 'HIGH',
                           'See item "Memory: DIMMs with ECC errors".', manual=True)]),
        dep(T, 'intersight.raw', 'Memory: DIMMs with ECC errors', 'intersight.mem.ecc.dimms', '$.mem_ecc_dimms',
            'CHAR', tags=tag('memory'), hb='1h', history='30d'),
    ]


def cpu_items(T, tag, with_peak):
    items = [dep(T, 'intersight.raw', 'CPU: utilization', 'intersight.cpu.util', '$.cpu_util', units='%',
                 tags=tag('cpu'),
                 triggers=[trig(T, 'cpu', 'min(/$T/intersight.cpu.util,30m)>{$INTERSIGHT.CPU.UTIL.WARN}',
                                'Intersight: CPU utilization above {$INTERSIGHT.CPU.UTIL.WARN}% for 30m', 'WARNING')])]
    if with_peak:
        items.append(dep(T, 'intersight.raw', 'CPU: peak utilization in window', 'intersight.cpu.util.max',
                         '$.cpu_util_max', units='%', tags=tag('cpu')))
    return items


def temperature_margin_items(T, tag, with_degraded):
    # Cisco "Supported Metrics", hw-temperature: limit_high_critical is reported by FI,
    # imm-blade-mqtt and imm-ism-rack-mqtt; limit_high_degraded by the two latter only.
    items = [dep(T, 'intersight.raw', 'Temperature: smallest margin to critical', 'intersight.temp.margin',
                 '$.temp_margin_min', units='°C', tags=tag('thermal'),
                 triggers=[trig(T, 'tm', 'max(/$T/intersight.temp.margin,15m)<{$INTERSIGHT.TEMP.MARGIN.WARN}',
                                'Intersight: a sensor is within {$INTERSIGHT.TEMP.MARGIN.WARN}°C of its critical threshold',
                                'HIGH', 'Margin = hw.temperature.limit_high_critical - hw.temperature, per sensor.')])]
    if with_degraded:
        items.append(dep(T, 'intersight.raw', 'Temperature: smallest margin to non-critical threshold',
                         'intersight.temp.margin.degraded', '$.temp_margin_degraded_min', units='°C',
                         tags=tag('thermal'),
                         triggers=[trig(T, 'tdeg', 'max(/$T/intersight.temp.margin.degraded,15m)<0',
                                        'Intersight: a sensor is above its non-critical temperature threshold',
                                        'WARNING', 'hw.temperature above hw.temperature.limit_high_degraded '
                                        '(upper non critical limit) for 15m, on at least one sensor.')]))
    return items


def fan_margin_items(T, tag):
    # Cisco "Supported Metrics", hw-fan: limit_low_critical is reported by
    # imm-chassis-mqtt-primary/secondary and imm-ism-rack-mqtt.
    return [dep(T, 'intersight.raw', 'Fans: smallest margin to lower critical speed', 'intersight.fan.margin',
                '$.fan_margin_min', units='!rpm', tags=tag('fans'),
                triggers=[trig(T, 'fan', 'max(/$T/intersight.fan.margin,15m)<0',
                               'Intersight: a fan is below its lower critical speed', 'AVERAGE',
                               'hw.fan.speed below hw.fan.speed.limit_low_critical for 15m, on at least one fan.')])]


def server_extra(T, tag):
    # ECC: blades and racks. CPU: hw.cpu (imm-blade-mqtt, imm-ism-rack-mqtt).
    return (ecc_items(T, tag) + cpu_items(T, tag, True) + temperature_margin_items(T, tag, True)
            + fan_margin_items(T, tag)) + [
        dep(T, 'intersight.raw', 'Firmware (CIMC)', 'intersight.firmware', '$.firmware', 'CHAR',
            tags=tag('inventory'), hb='1d', inv='SOFTWARE', history='30d',
            triggers=[trig(T, 'fw', 'change(/$T/intersight.firmware)=1',
                           'Intersight: firmware changed to {ITEM.LASTVALUE1}', 'INFO', manual=True)]),
        dep(T, 'intersight.raw', 'Management IP', 'intersight.mgmt.ip', '$.mgmt_ip', 'CHAR',
            tags=tag('inventory'), hb='1d', inv='OOB_IP', history='7d'),
        dep(T, 'intersight.raw', 'Power state', 'intersight.power.state', '$.power_state', 'UNSIGNED',
            tags=tag('power'), vmap='Power state',
            triggers=[trig(T, 'off', 'last(/$T/intersight.power.state)=0', 'Intersight: server is powered off',
                           'AVERAGE', 'Use a maintenance period for planned shutdowns.', manual=True)]),
    ]


def chassis_extra(T, tag):
    return fan_margin_items(T, tag) + [dep(T, 'intersight.raw', 'Operational state', 'intersight.oper.state', '$.oper_state', 'CHAR',
                tags=tag('health'), hb='1d', history='7d')]


def fi_extra(T, tag):
    # system.cpu and system.memory: Fabric Interconnects (and imm-edge-cmc).
    return cpu_items(T, tag, False) + temperature_margin_items(T, tag, False) + [
        dep(T, 'intersight.raw', 'Memory: utilization', 'intersight.mem.util', '$.mem_util', units='%',
            tags=tag('memory'),
            triggers=[trig(T, 'mem', 'min(/$T/intersight.mem.util,30m)>{$INTERSIGHT.MEM.UTIL.WARN}',
                           'Intersight: memory utilization above {$INTERSIGHT.MEM.UTIL.WARN}% for 30m', 'WARNING')]),
        dep(T, 'intersight.raw', 'Firmware', 'intersight.firmware', '$.firmware', 'CHAR', tags=tag('inventory'),
            hb='1d', inv='SOFTWARE', history='30d',
            triggers=[trig(T, 'fw', 'change(/$T/intersight.firmware)=1',
                           'Intersight: firmware changed to {ITEM.LASTVALUE1}', 'INFO', manual=True)]),
        dep(T, 'intersight.raw', 'Management IP', 'intersight.mgmt.ip', '$.mgmt_ip', 'CHAR',
            tags=tag('inventory'), hb='1d', inv='OOB_IP', history='7d'),
    ]


# Description of the trigger on intersight.api.push.max.bytes (sources: see the item, below).
RAW_SIZE_DESCRIPTION = (
    'The largest JSON pushed to the Text item intersight.raw (stored in the database) is above '
    '{$INTERSIGHT.RAW.SIZE.WARN} bytes, in UTF-8. Zabbix truncates a Text value before storing it: '
    '65536 bytes on MySQL, 65536 characters on PostgreSQL (Zabbix 7.0 manual, "Creating an item", '
    '"Text data limits"); a MySQL TEXT column holds 65,535 bytes (MySQL 8.0 manual, "String Data Type '
    'Syntax"). A truncated value is no longer valid JSON in the history; the effect on the dependent '
    'items has not been tested. The device is in item "API: device of the largest pushed value" '
    '(host intersight-<Moid>). When the measurements stop (push disabled, no device), the missing value is '
    'discarded and the problem closes after 20 minutes without a measurement (nodata, Zabbix 7.0 manual, '
    '"History functions").')


# ------------------------------------------------------------------ parent template
def parent(script):
    T = PARENT
    tag = lambda c: [{'tag': 'component', 'value': c}]
    M = 'intersight.collect'
    params = [('auth', '{$INTERSIGHT.AUTH}'), ('client_id', '{$INTERSIGHT.CLIENT_ID}'),
              ('client_secret', '{$INTERSIGHT.CLIENT_SECRET}'), ('key_id', '{$INTERSIGHT.KEY_ID}'), ('private_key', '{$INTERSIGHT.SECRET}'),
              ('api_host', '{$INTERSIGHT.API.HOST}'), ('window', '{$INTERSIGHT.WINDOW}'),
              ('datasource', '{$INTERSIGHT.DATASOURCE}'),
              ('network_datasource', '{$INTERSIGHT.DATASOURCE.NETWORK}'), ('component_dim', '{$INTERSIGHT.COMPONENT.DIM}'),
              ('flat_servers', '{$INTERSIGHT.FLAT.SERVERS}'),
              ('percent_scale', '{$INTERSIGHT.PERCENT.SCALE}'),
              ('alarm_cleared_window', '{$INTERSIGHT.ALARM.CLEARED.WINDOW}'), ('zbx_url', '{$ZABBIX.API.URL}'),
              ('zbx_token', '{$ZABBIX.API.TOKEN}')]
    items = [{
        'uuid': uid(T, M), 'name': 'Intersight collector', 'type': 'SCRIPT', 'key': M, 'delay': '5m',
        'history': '0', 'value_type': 'TEXT', 'trends': '0', 'timeout': '120s',
        'params': Lit(script), 'parameters': [{'name': n, 'value': v} for n, v in params],
        'description': 'Inventory + telemetry from Intersight, pushes per-device JSON to discovered hosts. '
                       'History disabled on purpose (large JSON); use the item Test button to debug.',
        'tags': tag('raw'),
    }]
    items += [
        dep(T, M, 'API: calls per run', 'intersight.api.calls', '$.api.calls', 'UNSIGNED', tags=tag('health'),
            triggers=[trig(T, 'nd', 'nodata(/$T/intersight.api.calls,20m)=1',
                           'Intersight: collector has not returned data for 20m', 'HIGH',
                           'The script failed entirely: check key, secret, API host, network egress.')]),
        dep(T, M, 'API: errors per run', 'intersight.api.errors', '$.api.errors.length()', 'UNSIGNED',
            tags=tag('health'),
            triggers=[trig(T, 'er', 'min(/$T/intersight.api.errors,#3)>0',
                           'Intersight: collector errors for 3 runs', 'WARNING',
                           'See item "API: last errors" for details.')]),
        {'uuid': uid(T, 'errtxt'), 'name': 'API: last errors', 'type': 'DEPENDENT',
         'key': 'intersight.api.errors.text', 'value_type': 'TEXT', 'trends': '0', 'history': '7d',
         'master_item': {'key': M},
         'preprocessing': [{'type': 'JAVASCRIPT', 'parameters': [
             "var e = JSON.parse(value).api.errors; return e.length ? e.join('\\n') : 'none';"]},
             {'type': 'DISCARD_UNCHANGED_HEARTBEAT', 'parameters': ['1h']}],
         'tags': tag('health')},
        # Keys renamed when the unit went from ms to s (was intersight.api.duration / .sign):
        # a new series, so the old ms history is never read as seconds.
        dep(T, M, 'API: run duration', 'intersight.api.run.time', '$.api.duration_s', units='s',
            tags=tag('health'),
            triggers=[trig(T, 'slow', 'min(/$T/intersight.api.run.time,#3)>90',
                           'Intersight: collector close to its 120s timeout', 'WARNING',
                           'Check "API: signing time" (ECDSA in pure JS) and the Intersight API latency.')]),
        dep(T, M, 'API: signing time (hs2019)', 'intersight.api.sign.time', '$.api.sign_s', units='s',
            tags=tag('health')),
        # Size of the largest JSON pushed to the Text item intersight.raw, which is stored (1h).
        # Zabbix 7.0 manual, "Creating an item", "Text data limits": a Text value is truncated
        # before being stored, to 65536 bytes on MySQL, 65536 characters on PostgreSQL.
        # history_text.value is t_text, i.e. text on MySQL (Zabbix 7.0 create/src/schema.tmpl,
        # create/bin/gen_schema.pl): 65,535 bytes (MySQL 8.0 "String Data Type Syntax").
        # Measured in UTF-8 bytes: never below the character count, so one threshold covers both.
        # Both items discard a missing value (push disabled, no device).
        dep(T, M, 'API: largest pushed value', 'intersight.api.push.max.bytes', '$.api.max_push_bytes', 'UNSIGNED',
            units='B', tags=tag('health'),
            # nodata(): without it the problem would never close once the measurements stop (push
            # disabled, no device: the value is discarded, so last() keeps the old one). 20m as
            # the "intersight.api.calls" trigger; {$INTERSIGHT.NODATA} is not on this template.
            triggers=[trig(T, 'rawsize', 'last(/$T/intersight.api.push.max.bytes)>{$INTERSIGHT.RAW.SIZE.WARN}'
                                         ' and nodata(/$T/intersight.api.push.max.bytes,20m)=0',
                           'Intersight: pushed value larger than {$INTERSIGHT.RAW.SIZE.WARN} bytes', 'WARNING',
                           RAW_SIZE_DESCRIPTION, opdata='Largest: {ITEM.LASTVALUE1}')]),
        dep(T, M, 'API: device of the largest pushed value', 'intersight.api.push.max.moid', '$.api.max_push_moid',
            'CHAR', tags=tag('health')),
        dep(T, M, 'Push: values accepted', 'intersight.push.sent', '$.push.sent', 'UNSIGNED', tags=tag('health')),
        dep(T, M, 'Push: values rejected', 'intersight.push.failed', '$.push.failed', 'UNSIGNED',
            tags=tag('health'),
            triggers=[trig(T, 'pf', 'min(/$T/intersight.push.failed,#3)>0',
                           'Intersight: history.push rejected values for 3 runs', 'WARNING',
                           'Normal for one run after new devices are discovered. Persistent: check the API token '
                           'permissions and the Allowed hosts of trapper items.')]),
        dep(T, M, 'Count: servers', 'intersight.count.servers', '$.counts.servers', 'UNSIGNED', tags=tag('inventory')),
        dep(T, M, 'Count: chassis', 'intersight.count.chassis', '$.counts.chassis', 'UNSIGNED', tags=tag('inventory')),
        dep(T, M, 'Count: fabric interconnects', 'intersight.count.fi', '$.counts.fi', 'UNSIGNED',
            tags=tag('inventory')),
        dep(T, M, 'Alarms (unacknowledged): critical', 'intersight.alarms.total.critical', '$.alarms.critical',
            'UNSIGNED', tags=tag('alarms')),
        dep(T, M, 'Alarms (unacknowledged): warning', 'intersight.alarms.total.warning', '$.alarms.warning',
            'UNSIGNED', tags=tag('alarms')),
        dep(T, M, 'Alarms (unacknowledged): info', 'intersight.alarms.total.info', '$.alarms.info',
            'UNSIGNED', tags=tag('alarms')),
    ]
    # Totals per class
    for cls in ('Servers', 'Chassis', 'FI'):
        g = 'Intersight/' + cls
        k = 'intersight.total.%s[' + cls + ']'
        items += [
            calc(T, cls + ': total power', k % 'power',
                 'sum(last_foreach(/*/intersight.power?[group="%s"]))' % g, 'W', tags=tag('aggregate')),
            # energy.24h / co2.24h: renamed when the unit went from kWh / kg to Wh / g (new
            # series, no mixed history). Cost keeps its key: still EUR.
            calc(T, cls + ': energy last 24h', k % 'energy.24h',
                 'sum(last_foreach(/*/intersight.energy.24h?[group="%s"]))' % g, 'Wh', '1h',
                 tags=tag('aggregate')),
            # Energy is in Wh and both macros are per kWh, hence the /1000.
            calc(T, cls + ': cost last 24h', k % 'cost',
                 'last(//%s)*{$INTERSIGHT.ENERGY.PRICE}/1000' % (k % 'energy.24h'), '!EUR', '1h',
                 tags=tag('aggregate')),
            calc(T, cls + ': CO2 last 24h', k % 'co2.24h',
                 'last(//%s)*{$INTERSIGHT.CO2.G.KWH}/1000' % (k % 'energy.24h'), 'g', '1h',
                 tags=tag('aggregate')),
        ]

    def lldrule(key, name, path, cls_group, tpl, cls):
        return {
            'uuid': uid(T, key), 'name': name, 'type': 'DEPENDENT', 'key': key, 'master_item': {'key': M},
            **HOST_LLD_LIFETIME,
            'lld_macro_paths': [{'lld_macro': '{#MOID}', 'path': '$.moid'},
                                {'lld_macro': '{#NAME}', 'path': '$.display'},
                                {'lld_macro': '{#MODEL}', 'path': '$.model'}],
            # No list (its inventory request failed): discard, so that no host is marked as lost.
            'preprocessing': [{'type': 'JSONPATH', 'parameters': [path], 'error_handler': 'DISCARD_VALUE'}],
            'host_prototypes': [{
                'uuid': uid(T, key, 'hp'), 'host': 'intersight-{#MOID}', 'name': '{#NAME}',
                'inventory_mode': 'AUTOMATIC',
                'group_links': [{'group': {'name': 'Intersight/' + cls_group}}],
                'group_prototypes': [{'name': 'Intersight/' + cls_group + '/{#MODEL}'}],
                'templates': [{'name': tpl}],
                'tags': [{'tag': 'intersight.class', 'value': cls}, {'tag': 'intersight.model', 'value': '{#MODEL}'}],
            }],
        }

    disc = [
        lldrule('intersight.servers.discovery', 'Servers discovery', '$.servers', 'Servers', TSRV, 'server'),
        lldrule('intersight.chassis.discovery', 'Chassis discovery', '$.chassis', 'Chassis', TCHA, 'chassis'),
        lldrule('intersight.fi.discovery', 'Fabric Interconnects discovery', '$.fis', 'FI', TFI, 'fi'),
    ]
    G = '{#GROUP}'
    mk = lambda f: 'intersight.model.%s[{#CLASS},{#MODEL}]' % f
    pw = '/*/intersight.power?[group="%s"]' % G
    model_items = [
        calc(T, '{#CLASS} {#MODEL}: power sum', mk('power.sum'), 'sum(last_foreach(%s))' % pw, 'W'),
        calc(T, '{#CLASS} {#MODEL}: power average', mk('power.avg'), 'avg(last_foreach(%s))' % pw, 'W'),
        calc(T, '{#CLASS} {#MODEL}: power min', mk('power.min'), 'min(last_foreach(%s))' % pw, 'W'),
        calc(T, '{#CLASS} {#MODEL}: power max', mk('power.max'), 'max(last_foreach(%s))' % pw, 'W'),
        # Counted on intersight.model, not on power: Intersight has no power value for some
        # devices (seen on some chassis and servers in the Intersight UI; cause unknown; other
        # device types not checked), while the collector always sets model ('unknown' when
        # Intersight has none). count() without operator counts the values whatever their
        # type, so a CHAR item works (Zabbix 7.0 source, eval_execute_function_count).
        calc(T, '{#CLASS} {#MODEL}: device count', mk('count'),
             'count(last_foreach(/*/intersight.model?[group="%s"]))' % G),
        # Renamed with the unit change (see the totals above); cost keeps its key.
        calc(T, '{#CLASS} {#MODEL}: energy last 24h', mk('energy.24h'),
             'sum(last_foreach(/*/intersight.energy.24h?[group="%s"]))' % G, 'Wh', '1h'),
        # Energy in Wh, macros per kWh: /1000 (cost in EUR, CO2 in g).
        calc(T, '{#CLASS} {#MODEL}: cost last 24h', mk('cost'),
             'last(//%s)*{$INTERSIGHT.ENERGY.PRICE}/1000' % mk('energy.24h'), '!EUR', '1h'),
        calc(T, '{#CLASS} {#MODEL}: CO2 last 24h', mk('co2.24h'),
             'last(//%s)*{$INTERSIGHT.CO2.G.KWH}/1000' % mk('energy.24h'), 'g', '1h'),
        calc(T, '{#CLASS} {#MODEL}: hottest sensor', mk('temp.max'),
             'max(last_foreach(/*/intersight.temp.max?[group="%s"]))' % G, '°C'),
    ]
    for it in model_items:
        it['uuid'] = uid(T, 'proto', it['key'])
        it['tags'] = [{'tag': 'component', 'value': 'aggregate'}, {'tag': 'class', 'value': '{#CLASS}'},
                      {'tag': 'model', 'value': '{#MODEL}'}]
    disc.append({
        'uuid': uid(T, 'models'), 'name': 'Models discovery (aggregates per type)', 'type': 'DEPENDENT',
        'key': 'intersight.models.discovery', 'master_item': {'key': M}, **HOST_LLD_LIFETIME,
        'lld_macro_paths': [{'lld_macro': '{#CLASS}', 'path': '$.class'},
                            {'lld_macro': '{#MODEL}', 'path': '$.model'},
                            {'lld_macro': '{#GROUP}', 'path': '$.group'}],
        # No list (an inventory request failed, list incomplete): discard the value.
        'preprocessing': [{'type': 'JSONPATH', 'parameters': ['$.models'], 'error_handler': 'DISCARD_VALUE'}],
        'item_prototypes': model_items,
    })
    disc.append(alarm_discovery(T, M, '$.platform_alarms'))
    return {
        'uuid': uid(T), 'template': T, 'name': T,
        'description': 'Cisco Intersight (SaaS or appliance). Auth: API key v3 hs2019 (default), API key v2 rsa, or OAuth2. '
                       'Creates one host per server / chassis / Fabric Interconnect and feeds them with history.push. '
                       'Requires Zabbix 7.0+.',
        'vendor': {'name': 'Custom', 'version': '7.0-6'},
        'groups': [{'name': TGROUP}],
        'items': items,
        'discovery_rules': disc,
        'tags': [{'tag': 'class', 'value': 'hardware'}, {'tag': 'target', 'value': 'cisco-intersight'}],
        'macros': [
            macro('{$INTERSIGHT.API.HOST}', 'intersight.com', 'Intersight FQDN (SaaS region or appliance).'),
            macro('{$INTERSIGHT.AUTH}', 'hs2019', 'hs2019 = API key v3 (EC P-256, ECDSA in pure JS). '
                  'rsa = API key v2. oauth = OAuth2 client credentials.'),
            macro('{$INTERSIGHT.CLIENT_ID}', '', 'OAuth2 client ID (app registration with client_credentials grant).'),
            macro('{$INTERSIGHT.CLIENT_SECRET}', '', 'OAuth2 client secret.', True),
            macro('{$INTERSIGHT.KEY_ID}', '', 'API key ID (hs2019 or rsa).'),
            macro('{$INTERSIGHT.SECRET}', '', 'Private key (EC for hs2019, RSA for rsa): full PEM with literal \\n, or base64 body on one line.', True),
            macro('{$INTERSIGHT.WINDOW}', '10', 'Telemetry window in minutes. Default for the Advantage tier (collection every '
                  'minute). Essentials and UMM collect every 10 minutes: set 30.'),
            macro('{$INTERSIGHT.DATASOURCE}', 'PhysicalEntities',
                  'Druid dataSource of hw.host, hw.temperature, hw.fan, hw.power_supply (Cisco doc).'),
            macro('{$INTERSIGHT.DATASOURCE.NETWORK}', 'NetworkInterfaces',
                  'Druid dataSource of hw.network (Cisco doc).'),
            macro('{$INTERSIGHT.COMPONENT.DIM}', 'name',
                  'Druid attribute naming a PSU / sensor / port (Cisco doc: name).'),
            macro('{$INTERSIGHT.PERCENT.SCALE}', '100',
                  'Multiplier turning raw utilizations into %. Intersight stores them as 0-1 ratios (checked in the '
                  'raw data), although its doc says "%". Set 1 only if a future version returns 0-100.'),
            macro('{$INTERSIGHT.FLAT.SERVERS}', '1',
                  '1 = all servers discovered here. 0 = blades discovered under their chassis (Zabbix 7.4 nested).'),
            macro('{$ZABBIX.API.URL}', 'https://zabbix.example.com/api_jsonrpc.php',
                  'Zabbix API URL used by history.push.'),
            macro('{$ZABBIX.API.TOKEN}', '', 'API token of a dedicated user with read access to Intersight/* groups.',
                  True),
            macro('{$INTERSIGHT.ENERGY.PRICE}', '0', 'Electricity price per kWh. To fill in.'),
            macro('{$INTERSIGHT.CO2.G.KWH}', '0', 'Grid carbon intensity in gCO2/kWh. To fill in.'),
            macro('{$INTERSIGHT.ALARM.CLEARED.WINDOW}', '1d',
                  'Cleared alarms younger than this are still read, so that their problem closes.'),
            macro('{$INTERSIGHT.RAW.SIZE.WARN}', '50000',
                  'Warning threshold, in UTF-8 bytes, for the largest JSON pushed to intersight.raw. Zabbix truncates '
                  'a stored Text value to 65536 bytes on MySQL and 65536 characters on PostgreSQL (Zabbix 7.0 manual, '
                  '"Creating an item", "Text data limits"); a MySQL TEXT column holds 65,535 bytes (MySQL 8.0 manual, '
                  '"String Data Type Syntax"). A byte count is never below the character count: one threshold '
                  'covers both databases. Keep it below 65535.'),
        ] + host_lld_macros() + alarm_macros(),
        'valuemaps': alarm_valuemaps(T),
    }


script = strip_comments(open(os.path.join(ROOT, 'src', 'collector.js')).read())
export = {'zabbix_export': {
    'version': '7.0',
    'template_groups': [{'uuid': uid('tg', TGROUP), 'name': TGROUP}],
    'host_groups': [{'uuid': uid('hg', 'Intersight/' + g), 'name': 'Intersight/' + g} for g in ('Servers', 'Chassis', 'FI')],
    'templates': [
        child(TSRV, 'server', 'rack and blade servers', server_extra),
        child(TCHA, 'chassis', 'chassis', chassis_extra),
        child(TFI, 'fi', 'Fabric Interconnects', fi_extra),
        parent(script),
    ],
}}
with open(os.path.join(ROOT, 'templates', 'zbx_intersight_templates_7.0.yaml'), 'w') as f:
    yaml.dump(export, f, sort_keys=False, allow_unicode=True, width=1000, default_flow_style=False)
print('ok')
