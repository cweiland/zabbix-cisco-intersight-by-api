# Cisco Intersight → Zabbix

Supervision de Cisco Intersight (SaaS ou Virtual Appliance) dans Zabbix 7.0 LTS, compatible 7.4 : serveurs rack et blade, châssis et Fabric Interconnects.

- Un seul script fait tous les appels API, puis alimente un host Zabbix par équipement via `history.push`.
- Trois modes d'authentification : clé API v3 **hs2019** (ECDSA P-256 implémenté en JavaScript pur, car Zabbix ne sait signer qu'en RSA), clé v2 **rsa**, ou **OAuth2**.
- Métriques et agrégats par type d'équipement : puissance, énergie, coût et CO₂, température, ventilateurs, PSU, mémoire ECC, CPU, ports réseau, alarmes et firmware.

## Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `templates/zbx_intersight_templates_7.0.yaml` | Les 4 templates, **à importer dans Zabbix** |
| `src/collector.js` | Script de collecte (ES5 / Duktape), embarqué dans le template |
| `tools/generate_templates.py` | Régénère le YAML depuis `src/collector.js` |
| `tools/validate_template.py` | Contrôles structurels du YAML généré (macros, UUID, clés, triggers) |
| `tools/check_metrics_against_doc.py` | Vérifie les métriques utilisées contre la doc « Supported Metrics » de ton appliance |
| `tests/` | Tests Node.js sans dépendance : ECDSA (vecteur RFC 6979 + OpenSSL), modes d'auth, scénarios |
| `docs/UPGRADE_7.4_FR.md` | Variante Zabbix 7.4 (blades découverts sous leur châssis) |
| `CLAUDE.md` | Contexte du projet pour Claude Code (décisions, faits vérifiés, points ouverts) |

## Développement

```bash
node tests/run_all.js                  # tous les tests (Node.js 16+)
python3 tools/generate_templates.py    # après toute modification de src/collector.js (PyYAML)
python3 tools/check_metrics_against_doc.py Supported_Metrices.md
```

Le YAML est généré : **ne pas l'éditer à la main**. Il faut modifier `src/collector.js` ou `tools/generate_templates.py`, puis régénérer. La CI vérifie que le template commité correspond au script, que le code reste en ES5, et que tous les tests passent. Les UUID sont dérivés des noms, donc stables d'une génération à l'autre.


Le fichier `zbx_intersight_templates_7.0.yaml` contient 4 templates :

| Template | Lié à | Rôle |
|---|---|---|
| Cisco Intersight by API | 1 host « Intersight » créé à la main | Collecte (1 script / 5 min), découverte, agrégats, santé |
| Cisco Intersight Server by push | serveurs découverts (rack + blade) | Puissance, énergie, PSU, thermique, ventilos, réseau, firmware, alarmes |
| Cisco Intersight Chassis by push | châssis découverts | Idem, sans firmware |
| Cisco Intersight FI by push | Fabric Interconnects découverts | Idem, avec firmware et ports |

Le template parent fait **tous** les appels Intersight, puis pousse un JSON par équipement vers l'item trapper `intersight.raw` de chaque host découvert (méthode API `history.push`, Zabbix 7.0+). Les hosts découverts ne font aucun appel API.

## Flux de données

1. Le script `intersight.collect` lit l'inventaire : `compute/PhysicalSummaries`, `equipment/Chasses`, `network/ElementSummaries` et `cond/Alarms` (alarmes non acquittées).
2. Il lit la télémétrie Druid via `telemetry/GroupBys`, groupée par `host.type` + `host.name` : 9 instruments (voir « Métriques collectées »).
3. Il signe chaque requête avec ta **clé API v3** (`hs2019`, ECDSA P-256). Zabbix ne sait faire que du RSA, donc l'ECDSA est implémenté en JavaScript pur dans le script (nonce déterministe RFC 6979). Les modes `rsa` (clé v2) et `oauth` restent disponibles via `{$INTERSIGHT.AUTH}`.
4. Il pousse les valeurs vers les hosts `intersight-<Moid>` par `history.push`.
5. Il renvoie un JSON qui alimente les LLD (host prototypes), les items de santé et les agrégats.

Chaque appel est isolé dans un `try/catch`. Une métrique absente ne casse pas le reste ; l'erreur apparaît dans l'item « API: last errors ».

## Installation

1. **Intersight** : utiliser la clé API v3 (`BEGIN EC PRIVATE KEY`, courbe P-256), idéalement avec un rôle en lecture seule.
2. **Zabbix, utilisateur technique** : créer un utilisateur dédié avec un rôle API autorisant `history.push`, une permission lecture sur les groupes `Intersight/*`, et un token API.
3. **Importer** le YAML (Data collection > Templates > Import).
4. **Créer un host** « Cisco Intersight », sans interface, et lier `Cisco Intersight by API`.
5. **Renseigner les macros** sur ce host :

| Macro | Valeur |
|---|---|
| `{$INTERSIGHT.AUTH}` | `hs2019` (défaut) |
| `{$INTERSIGHT.KEY_ID}` | ID de la clé API |
| `{$INTERSIGHT.SECRET}` (secret) | clé privée EC : PEM complet avec `\n` littéraux, ou corps base64 sur une ligne |
| `{$INTERSIGHT.API.HOST}` | `intersight.com`, ta région SaaS ou l'appliance |
| `{$ZABBIX.API.URL}` | `https://<frontend>/api_jsonrpc.php` |
| `{$ZABBIX.API.TOKEN}` (secret) | token de l'utilisateur technique |
| `{$INTERSIGHT.ENERGY.PRICE}` | prix du kWh (0 par défaut) |
| `{$INTERSIGHT.CO2.G.KWH}` | intensité carbone de ton fournisseur en gCO₂/kWh (0 par défaut) |

6. **Allowed hosts** : si tu renseignes ce champ sur les items trapper, il doit contenir l'IP du frontend Zabbix, sinon `history.push` est refusé.
7. Lancer « Test » sur l'item `Intersight collector`, puis « Execute now ».

Au premier cycle, `Push: values rejected` est normal : les hosts n'existent pas encore. Ils sont créés par la LLD et alimentés dès le cycle suivant.

## Intersight Virtual Appliance

La télémétrie n'existe sur l'appliance que si la collecte de métriques est active. Il faut soit un déploiement multi-nœuds avec un nœud de métriques (2 ou 4 nœuds ; pas en 3 nœuds), soit l'option de collecte en déploiement mono-nœud. Sans cela, l'inventaire, les alarmes et le firmware fonctionnent, mais les items de puissance, température, ventilateurs et réseau restent vides, et « API: last errors » signale les requêtes de télémétrie.

## Métriques collectées

Les noms de métriques suivent la doc de l'appliance (« Supported Metrics », métriques IMM). Les 9 instruments et 30 champs utilisés y figurent tous. Cette doc ne donne ni les dataSources ni la couverture par type d'équipement : ces deux points viennent des pages DevNet.

| Instrument | Ce qui en est tiré | Trigger |
|---|---|---|
| `hw.host` | puissance moyenne et pic | — |
| `hw.temperature` (par capteur) | température max, marges aux seuils non critique et critique **de chaque capteur** | WARNING au-dessus du seuil non critique, HIGH à moins de 10 °C du critique |
| `hw.fan` (par ventilateur) | vitesses min/max, marge au seuil critique bas **de chaque ventilateur** | AVERAGE si un ventilateur passe sous son seuil |
| `hw.power_supply` (par PSU) | utilisation (FI), puissance de sortie, puissance châssis IMM | WARNING au-delà de 80 % |
| `hw.memory` (par barrette) | erreurs ECC corrigibles et non corrigibles, liste des barrettes en cause | HIGH dès 1 erreur non corrigible, WARNING si erreurs corrigibles sur 3 cycles |
| `hw.cpu` (par processeur) | utilisation C0 moyenne et processeur le plus chargé (serveurs) | WARNING au-delà de 90 % pendant 30 min |
| `system.cpu`, `system.memory` | CPU (100 − idle) et mémoire des FI | WARNING au-delà de 90 % pendant 30 min |
| `hw.network` (par port) | débits, utilisation de bande passante, état du lien, erreurs | lien tombé (uniquement s'il était up dans les 24 h), utilisation > 90 %, erreurs sur 3 cycles |

Non collectés, mais disponibles si besoin : GPU (`hw.gpu.*`, uniquement avec les pilotes installés sur l'hôte), tensions et courants (`hw.voltage`, `hw.current`), puissance optique (`hw.signal_power`) et compteurs de paquets détaillés.

## Couverture des métriques par équipement (pages « Supported Metrics » de Cisco DevNet)

| Métrique | Équipements qui la remontent |
|---|---|
| `hw.host.power` | blades, racks, FI, châssis **UCSM** (pas les châssis IMM) |
| `hw.power_out` (par PSU) | châssis, FI, racks : sert de puissance du châssis en IMM (`power_source = psu_output`) |
| `hw.power_supply.utilization` | FI uniquement |
| `hw.network.*` | dataSource `NetworkInterfaces` (pas `PhysicalEntities`) |

Seuls les équipements d'un domaine UCS (IMM ou UCSM) figurent dans ces listes. Un rack C-Series standalone peut donc remonter l'inventaire sans télémétrie.

## À vérifier sur ton tenant (non garanti par la doc publique)

Ces points sont configurables sans toucher au code :

| Point | Où vérifier | Réglage |
|---|---|---|
| Appliance plus ancienne que le SaaS : métriques absentes de ta version | page d'aide de l'appliance, ou onglet Metrics d'un équipement | `TELEMETRY_QUERIES` |
| Noms de champs dérivés (`hw.temperature_max`, `..._min`) | onglet **Code** d'un graphique | `TELEMETRY_QUERIES` |
| Champs FI (`Version`, `OutOfBandIpAddress`) et châssis (`OperState`) | API Reference Intersight | `src/collector.js`, section 7 |

Si un de ces points est faux, l'item « API: last errors » affiche l'appel en cause avec le code HTTP. Les items concernés restent simplement vides.

## Limites connues

- **Jointure** : la télémétrie est rattachée à l'inventaire par `host.type` + `host.name`. Un châssis et un serveur de même nom sont donc bien distingués. En revanche, deux serveurs de même nom partagent encore leurs métriques, car Cisco précise que `host.name` n'est pas garanti unique.
- **Double comptage possible** : si la puissance châssis inclut celle des blades, n'additionne pas les totaux « Chassis » et « Servers ». Les totaux sont volontairement séparés par classe.
- **Énergie** : `Energy: last 24h` est calculée comme puissance moyenne sur 24 h × 24 / 1000. C'est exact sur une fenêtre glissante, à condition d'avoir 24 h d'historique.
- **Historique du script maître** : il est à 0 (le JSON peut être gros). Pour déboguer, utiliser le bouton « Test ».
- **Température** : le trigger compare chaque capteur à **son propre** seuil critique (`hw.temperature.limit_high_critical`) et alerte quand la marge passe sous `{$INTERSIGHT.TEMP.MARGIN.WARN}` (10 °C). Les températures CPU ne remontent que si l'hôte est allumé.
- **Puissance châssis IMM** : c'est la somme des sorties PSU, légèrement inférieure à la puissance au mur (rendement des alimentations).

## Ce que tu obtiens

- **Par équipement** : puissance moyenne et pic, état d'alimentation, énergie sur 24 h, température max, ventilateurs min/max, PSU (LLD : utilisation et sortie), ports (LLD filtrable), alarmes critiques et warning, modèle, numéro de série, firmware, IP de management. Les champs d'inventaire Zabbix sont remplis automatiquement.
- **Par type** (LLD sur les modèles, groupe `Intersight/<Classe>/<Modèle>`) : somme, moyenne, min, max, nombre d'équipements remontant, énergie, coût, CO₂, température max.
- **Par classe** : puissance totale, énergie, coût et CO₂ sur 24 h.
- **Santé** : appels, erreurs, durée, valeurs poussées et rejetées, absence de données, alarmes globales.

## Performance de la signature hs2019

L'ECDSA en JavaScript pur est coûteux dans l'interpréteur Duktape. Mesures de référence : ~10 ms par signature sous V8 avec JIT, ~280 ms sous V8 sans JIT. Duktape étant généralement plus lent, compte de 0,5 à 3 s par signature, soit 13 signatures par cycle (4 inventaires + 9 requêtes de télémétrie). Ces chiffres sont des estimations : la vraie mesure est l'item **« API: signing time (hs2019) »**. Un trigger se déclenche si le cycle approche le timeout de 120 s. Le cas échéant, augmente l'intervalle ou le timeout de l'item.
