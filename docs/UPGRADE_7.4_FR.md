# Variante Zabbix 7.4 : blades découverts sous leur châssis (nested LLD)

## Pourquoi ce n'est pas un YAML séparé

Je n'ai pas trouvé de documentation publique du format YAML des *discovery prototypes* 7.4. Un fichier écrit à l'aveugle risquerait d'échouer à l'import. La méthode fiable est en deux temps :

1. Importer le YAML 7.0 dans Zabbix 7.4 (les imports de versions antérieures sont convertis).
2. Ajouter la règle imbriquée dans l'UI, puis **exporter** : tu obtiens un YAML 7.4 natif et validé par Zabbix lui-même.

## Ce que ça change

En 7.0, tous les serveurs (rack et blade) sont découverts à plat par le host parent. En 7.4 :

```
Host "Cisco Intersight"
 ├─ LLD Servers        → hosts rack uniquement
 ├─ LLD Chassis        → hosts châssis
 │    └─ LLD Nested "Blades" (sur chaque châssis) → hosts blades
 └─ LLD FI             → hosts Fabric Interconnects
```

La doc 7.4 précise que lorsqu'une règle de type *Nested* existe sur un host découvert, elle reçoit l'objet JSON qui a servi à découvrir ce host. Le collecteur inclut déjà, pour chaque châssis, un tableau `blades` contenant `moid`, `display` et `model`.

La collecte ne change pas : les blades gardent le nom technique `intersight-<Moid>`, donc `history.push` les alimente de la même façon.

## Étapes

1. **Template « Cisco Intersight Chassis by push »** > Discovery > Create discovery rule :
   - Name : `Blades discovery`
   - Type : **Nested**
   - Key : `intersight.blades.discovery`
   - Preprocessing : JSONPath `$.blades`
   - LLD macros : `{#BMOID}` → `$.moid`, `{#BNAME}` → `$.display`, `{#BMODEL}` → `$.model`
2. Dans cette règle, **Host prototypes** > Create :
   - Host name : `intersight-{#BMOID}`
   - Visible name : `{#BNAME}`
   - Templates : `Cisco Intersight Server by push`
   - Groups : `Intersight/Servers`
   - Group prototypes : `Intersight/Servers/{#BMODEL}`
   - Tags : `intersight.class=server`, `intersight.chassis={#NAME}` (les macros LLD du parent restent disponibles)
   - Inventory : Automatic
3. **Sur le host « Cisco Intersight »** : passer `{$INTERSIGHT.FLAT.SERVERS}` à `0`. Les blades sortent alors de la LLD Servers.
4. **Exporter** les 4 templates : c'est ta version 7.4 de référence.

## Point d'attention lors de la bascule

Les blades déjà créés par la LLD Servers portent le même nom technique que ceux que créera la LLD châssis. Tant que les anciens existent, la nouvelle découverte échoue sur un conflit de nom. Les anciens disparaissent à l'expiration du lifetime de la LLD (7 jours), mais tu peux accélérer :

- **Sur un environnement neuf** : faire la bascule avant la mise en production.
- **Sinon** : supprimer les hosts blades découverts juste après l'étape 3. Leur historique est perdu.

## Pour aller plus loin en 7.4

Les LLD PSU et ports restent des règles dépendantes de `intersight.raw`. Elles fonctionnent à l'identique en 7.4 et se mettent à jour à chaque push. Les passer en *Nested* n'apporte rien ici.
