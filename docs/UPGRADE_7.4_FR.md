# Variante Zabbix 7.4 : blades découverts sous leur châssis (nested LLD)

## Pourquoi ce n'est pas un YAML séparé

Aucune documentation publique du format YAML des *discovery prototypes* 7.4 n'a été trouvée. Un fichier écrit à l'aveugle risquerait d'échouer à l'import. La méthode fiable est en deux temps :

1. Importez le YAML 7.0 dans Zabbix 7.4.
2. Ajoutez la règle imbriquée dans l'UI, puis **exportez** : vous obtenez un YAML 7.4 natif et validé par Zabbix lui-même.

## Ce que ça change

En 7.0, tous les serveurs (rack et blade) sont découverts à plat par le host parent. En 7.4 :

```
Host "Cisco Intersight"
 ├─ LLD Servers        → hosts rack uniquement
 ├─ LLD Chassis        → hosts châssis
 │    └─ LLD Nested "Blades" (sur chaque châssis) → hosts blades
 └─ LLD FI             → hosts Fabric Interconnects
```

D'après la documentation « current » de Zabbix (8.0, « Discovery prototypes »), une règle de type *Nested* sur un host découvert reçoit l'objet JSON qui a servi à découvrir ce host. Ce comportement n'a pas été relu sur la page 7.4, et ces étapes n'ont jamais été appliquées sur un vrai Zabbix 7.4. Ici, la règle « Blades discovery » d'un châssis reçoit donc l'objet de ce châssis tel que l'envoie la règle « Chassis discovery » du host parent. Le collecteur inclut dans cet objet un tableau `blades` contenant `moid`, `display` et `model`.

**Lecture en échec :**
- **Serveurs** : le collecteur n'envoie pas `blades` dans les châssis. Le JSONPath `$.blades` échoue et la valeur est ignorée (Discard value) : aucune lame n'est déclarée perdue.
- **Châssis** : le collecteur n'envoie pas la liste `chassis`. La règle « Chassis discovery » du parent ignore la valeur, donc aucun châssis n'est déclaré perdu. Aucun objet châssis n'est alors produit pour la règle imbriquée ; ce qu'elle reçoit dans ce cas n'est pas vérifié.
- Dans les deux cas, les délais de désactivation et de suppression ci-dessous sont la seconde protection.

La collecte ne change pas : les blades gardent le nom technique `intersight-<Moid>`, donc `history.push` les alimente de la même façon.

## Étapes

1. **Template « Cisco Intersight Chassis by push »** > Discovery > Create discovery rule :
   - Name : `Blades discovery`
   - Type : **Nested**
   - Key : `intersight.blades.discovery`
   - Preprocessing : JSONPath `$.blades`, avec « Custom on fail » → **Discard value**. Si la lecture des serveurs a échoué, le collecteur n'envoie pas `blades` : la valeur est alors ignorée au lieu de déclarer toutes les lames perdues.
   - LLD macros : `{#BMOID}` → `$.moid`, `{#BNAME}` → `$.display`, `{#BMODEL}` → `$.model`
   - Delete lost resources : After, `{$INTERSIGHT.HOST.LOST.DELETE}`
   - Disable lost resources : After, `{$INTERSIGHT.HOST.LOST.DISABLE}`
   - Une seule macro par champ, rien d'autre (doc Zabbix 7.0, « User macros supported by location », note 1). Ces deux macros sont définies sur le template « Cisco Intersight Chassis by push » (`1h` et `7d`). Un host châssis n'hérite pas des macros du template parent : gardez les mêmes valeurs que sur « Cisco Intersight by API ». **La suppression doit rester plus longue que la désactivation.**
2. Dans cette règle, **Host prototypes** > Create :
   - Host name : `intersight-{#BMOID}`
   - Visible name : `{#BNAME}`
   - Templates : `Cisco Intersight Server by push`
   - Groups : `Intersight/Servers`
   - Group prototypes : `Intersight/Servers/{#BMODEL}`
   - Tags : `intersight.class=server`, `intersight.model={#BMODEL}`, `intersight.chassis={#NAME}` (les macros LLD du parent restent disponibles)
   - Inventory : Automatic
3. **Sur le host « Cisco Intersight »** : passez `{$INTERSIGHT.FLAT.SERVERS}` à `0`. Les blades sortent alors de la LLD Servers.
4. **Exportez** les 4 templates : c'est votre version 7.4 de référence.

## Point d'attention lors de la bascule

Les blades déjà créés par la LLD Servers portent le même nom technique que ceux que créera la LLD châssis. Tant que les anciens existent, la nouvelle découverte échoue sur un conflit de nom. Les anciens sont désactivés après `{$INTERSIGHT.HOST.LOST.DISABLE}` (1 h) puis supprimés après `{$INTERSIGHT.HOST.LOST.DELETE}` (7 jours), macros du host parent. Un host désactivé existe toujours, donc le conflit de nom dure jusqu'à la suppression ; vous pouvez accélérer :

- **Sur un environnement neuf** : faites la bascule avant la mise en production.
- **Sinon** : supprimez les hosts blades découverts juste après l'étape 3. Leur historique est perdu.

## Pour aller plus loin en 7.4

Les LLD PSU et ports restent des règles dépendantes de `intersight.raw`. Elles fonctionnent à l'identique en 7.4 et se mettent à jour à chaque push. Les passer en *Nested* n'apporte rien ici.
