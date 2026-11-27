This guide is available in: English | [Français](UPGRADE_7.4_FR.md)

# Zabbix 7.4 variant: blades discovered under their chassis (nested LLD)

## Why this is not a separate YAML

No public documentation of the YAML format of the 7.4 *discovery prototypes* was found. A file written blind could fail on import. The reliable method has two steps:

1. Import the 7.0 YAML into Zabbix 7.4.
2. Add the nested rule in the UI, then **export**: you get a native 7.4 YAML, validated by Zabbix itself.

## What it changes

In 7.0, all the servers (rack and blade) are discovered flat by the parent host. In 7.4:

```
Host "Cisco Intersight"
 ├─ LLD Servers        → rack hosts only
 ├─ LLD Chassis        → chassis hosts
 │    └─ LLD Nested "Blades" (on each chassis) → blade hosts
 └─ LLD FI             → Fabric Interconnect hosts
```

According to the "current" Zabbix documentation (8.0, "Discovery prototypes"), a rule of type *Nested* on a discovered host receives the JSON object that was used to discover this host. This behaviour was not checked on the 7.4 page, and these steps have never been applied on a real Zabbix 7.4. Here, the rule "Blades discovery" of a chassis therefore receives the object of this chassis as sent by the rule "Chassis discovery" of the parent host. The collector includes in this object a `blades` array that contains `moid`, `display` and `model`.

**Failed read:**
- **Servers**: the collector does not send `blades` in the chassis. The JSONPath `$.blades` fails and the value is discarded (Discard value): no blade is declared lost.
- **Chassis**: the collector does not send the `chassis` list. The rule "Chassis discovery" of the parent discards the value, so no chassis is declared lost. No chassis object is then produced for the nested rule; what it receives in this case is not verified.
- In both cases, the disabling and deletion delays below are the second protection.

Collection does not change: the blades keep the technical name `intersight-<Moid>`, so `history.push` feeds them in the same way.

## Steps

1. **Template "Cisco Intersight Chassis by push"** > Discovery > Create discovery rule:
   - Name: `Blades discovery`
   - Type: **Nested**
   - Key: `intersight.blades.discovery`
   - Preprocessing: JSONPath `$.blades`, with "Custom on fail" → **Discard value**. If reading the servers failed, the collector does not send `blades`: the value is then discarded instead of declaring all the blades lost.
   - LLD macros: `{#BMOID}` → `$.moid`, `{#BNAME}` → `$.display`, `{#BMODEL}` → `$.model`
   - Delete lost resources: After, `{$INTERSIGHT.HOST.LOST.DELETE}`
   - Disable lost resources: After, `{$INTERSIGHT.HOST.LOST.DISABLE}`
   - Only one macro per field, nothing else (Zabbix 7.0 doc, "User macros supported by location", note 1). These two macros are defined on the template "Cisco Intersight Chassis by push" (`1h` and `7d`). A chassis host does not inherit the macros of the parent template: keep the same values as on "Cisco Intersight by API". **Deletion must stay longer than disabling.**
2. In this rule, **Host prototypes** > Create:
   - Host name: `intersight-{#BMOID}`
   - Visible name: `{#BNAME}`
   - Templates: `Cisco Intersight Server by push`
   - Groups: `Intersight/Servers`
   - Group prototypes: `Intersight/Servers/{#BMODEL}`
   - Tags: `intersight.class=server`, `intersight.model={#BMODEL}`, `intersight.chassis={#NAME}` (the LLD macros of the parent remain available)
   - Inventory: Automatic
3. **On the host "Cisco Intersight"**: set `{$INTERSIGHT.FLAT.SERVERS}` to `0`. The blades then leave the Servers LLD.
4. **Export** the 4 templates: this is your reference 7.4 version.

## Point of attention during the switch

The blades already created by the Servers LLD have the same technical name as those that the chassis LLD will create. As long as the old ones exist, the new discovery fails on a name conflict. The old ones are disabled after `{$INTERSIGHT.HOST.LOST.DISABLE}` (1 h), then deleted after `{$INTERSIGHT.HOST.LOST.DELETE}` (7 days), macros of the parent host. A disabled host still exists, so the name conflict lasts until the deletion; you can speed this up:

- **On a new environment**: make the switch before going into production.
- **Otherwise**: delete the discovered blade hosts right after step 3. Their history is lost.

## Going further in 7.4

The PSU and port LLD rules remain rules that depend on `intersight.raw`. They work in the same way in 7.4 and are updated at each push. Turning them into *Nested* rules brings nothing here.
