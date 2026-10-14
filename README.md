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
| `docs/intersight_metrics.json` | Catalogue des métriques Intersight (instruments, champs Druid, équipements supportés) |
| `tools/build_metrics_catalog.py` | Reconstruit ce catalogue depuis les pages « Supported Metrics » |
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

Le YAML est généré : **ne pas l'éditer à la main**. Il embarque une copie de `src/collector.js` sans commentaires, car Zabbix limite les scripts à 65 535 caractères. Il faut modifier `src/collector.js` ou `tools/generate_templates.py`, puis régénérer. La CI vérifie que le template commité correspond au script, que le code reste en ES5, et que tous les tests passent. Les UUID sont dérivés des noms, donc stables d'une génération à l'autre.


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
2. Il lit la télémétrie Druid via `/api/v1/telemetry/TimeSeries` (requêtes `groupBy`), groupée par `host.type` + `host.name` : 9 instruments (voir « Métriques collectées »).
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
| `{$INTERSIGHT.WINDOW}` | fenêtre de télémétrie en minutes : 10 (Advantage, défaut) ou 30 (Essentials) |
| `{$INTERSIGHT.PERCENT.SCALE}` | 100 (défaut) : Intersight stocke les pourcentages en ratios 0–1 |

6. **Allowed hosts** : si tu renseignes ce champ sur les items trapper, il doit contenir l'IP du frontend Zabbix, sinon `history.push` est refusé.
7. Lancer « Test » sur l'item `Intersight collector`, puis « Execute now ».

Au premier cycle, `Push: values rejected` est normal : les hosts n'existent pas encore. Ils sont créés par la LLD et alimentés dès le cycle suivant.

## Intersight Virtual Appliance

La télémétrie n'existe sur l'appliance que si la collecte de métriques est active. Il faut soit un déploiement multi-nœuds avec un nœud de métriques (2 ou 4 nœuds ; pas en 3 nœuds), soit l'option de collecte en déploiement mono-nœud. Sans cela, l'inventaire, les alarmes et le firmware fonctionnent, mais les items de puissance, température, ventilateurs et réseau restent vides, et « API: last errors » signale les requêtes de télémétrie.

## Métriques collectées

**Règle : aucun nom de champ déduit.** `docs/intersight_metrics.json` est le catalogue extrait des pages « Supported Metrics » d'Intersight (13 instruments, 146 métriques, 724 champs Druid, avec pour chaque métrique les types d'équipements qui la remontent). Un test fait échouer la CI si le collecteur interroge un champ ou un dataSource absent du catalogue. Pour mettre le catalogue à jour : `python3 tools/build_metrics_catalog.py <dossier des pages .md>`.

| Instrument | Ce qui en est tiré | Équipements qui le remontent (catalogue) | Trigger |
|---|---|---|---|
| `hw.host` | puissance moyenne et pic | blades, racks, FI (pas les châssis IMM) | — |
| `hw.power_supply` (par PSU) | puissance absorbée et de sortie, utilisation ; puissance des châssis IMM = somme des puissances absorbées | châssis, racks, FI (utilisation : FI) | WARNING au-delà de 80 % |
| `hw.temperature` (par capteur) | température max ; marge au seuil critique et au seuil non critique **de chaque capteur** | seuil critique : FI, `imm-blade-mqtt`, `imm-ism-rack-mqtt` ; non critique : ces deux derniers | HIGH à moins de 10 °C du critique, WARNING au-dessus du non critique |
| `hw.fan` (par ventilateur) | vitesses min/max ; marge au seuil critique bas **de chaque ventilateur** | vitesse : châssis, racks, FI ; seuil : `imm-chassis-mqtt-*`, `imm-ism-rack-mqtt` | AVERAGE sous le seuil |
| `hw.memory` (par barrette) | erreurs ECC, barrettes en cause | blades, racks | HIGH dès 1 erreur non corrigible, WARNING si corrigibles sur 3 cycles |
| `hw.cpu` | utilisation C0 moyenne et pic (valeur agrégée sur tous les CPU du serveur) | `imm-blade-mqtt`, `imm-ism-rack-mqtt` | WARNING au-delà de 90 % pendant 30 min |
| `system.cpu`, `system.memory` | CPU (100 − idle) et mémoire | FI | WARNING au-delà de 90 % pendant 30 min |
| `hw.network` (par port) | débit reçu et émis (bits/s), vitesse de lien, utilisation de bande passante, état du lien, erreurs ; rôle du port (`hw.network.port.role`) pour filtrer | blades, racks, FI | lien tombé (s'il était up dans les 24 h), utilisation > 90 %, erreurs sur 3 cycles |

Un équipement absent de la liste de support d'une métrique ne renvoie aucune ligne : l'item correspondant reste vide, sans erreur. Les pages ne définissent pas le suffixe `-mqtt` des types de support ; vérifie sur ton appliance quels items se remplissent.

**Sources autres que la doc Cisco**, toutes deux reprises des tableaux de bord Grafana [intersight-grafana](https://github.com/3191110276/intersight-grafana) (dépôt communautaire, fourni « best-effort ») :
- **Formule du débit** : `somme(hw.network.io_receive) / somme(hw.network.io_receive_duration) × 8` en bits/s. Les champs sont documentés, mais pas la formule ; elle est cohérente avec la doc, qui exprime la vitesse de lien en octets par seconde.
- **Regroupement par attributs « à points »** (`host.name`, `host.type`, `hw.network.port.role`) via des colonnes virtuelles `nested-field`. C'est le seul point non validé qui conditionne toute la télémétrie : si les items de télémétrie restent tous vides alors que l'inventaire remonte, c'est la première piste à vérifier.

Ports : par défaut, la découverte ignore les rôles `unconfigured`, `vethernet`, `vfc`, `vnic` et `vhba` (`{$INTERSIGHT.PORT.ROLE.NOT_MATCHES}`), comme ces tableaux de bord. Les rôles possibles sont listés dans la page `hw-network`.

Non collectés, disponibles dans le catalogue si besoin : GPU (`hw.gpu`), tensions, courants, puissance optique, énergie, limites des PSU, disques physiques (`hw.physical_disk`, collecté toutes les 30 minutes ; sa page n'est pas dans le catalogue).

## Unités

| Métrique | Unité Cisco (doc appliance) | Stocké dans Zabbix | Source de la conversion |
|---|---|---|---|
| `hw.host.power`, `hw.power`, `hw.power_out` | `W` | `W` | aucune |
| `hw.temperature` et ses seuils | `Cel` | `°C` | aucune |
| `hw.fan.speed` et ses seuils | `rpm` | `!rpm` | aucune |
| ECC, erreurs réseau | `{errors}` | nombre sur la fenêtre | somme sur la fenêtre |
| `hw.cpu.utilization_c0`, `system.memory.utilization`, `hw.power_supply.utilization`, `hw.network.bandwidth.utilization_all` | `%` dans la doc, mais **ratio 0–1 dans les données** | `%` | × `{$INTERSIGHT.PERCENT.SCALE}` (défaut **100**) |
| `system.cpu.utilization_idle` | idem | CPU = 100 − idle × 100, en `%` | idem |
| `hw.network.io_receive` / `io_transmit` | `By` (octets) | `bps` | octets ÷ durée (s) × 8, formule des tableaux de bord |
| `hw.network.bandwidth.limit` | `By/s` | `bps` | × 8 |
| `hw.network.up` | `1` (0 ou 1) | 0/1 (valeur « Link state ») | aucune |
| Énergie, coût, CO₂ | — | `!kWh`, `!EUR`, `!kg` | calculés depuis la puissance |

**Pourcentages : la doc Cisco indique `%`, mais Intersight stocke des ratios 0–1** (0,1 = 10 %). C'est vérifié dans les données brutes d'une appliance, et cohérent avec les tableaux de bord intersight-grafana, qui multiplient par 100. D'où `{$INTERSIGHT.PERCENT.SCALE}` = 100. Si une version future renvoyait des valeurs 0–100, il suffirait de passer la macro à 1.

**Contrôles à l'exécution**, signalés dans « API: last errors » (puis trigger après 3 cycles) :
- un pourcentage supérieur à 100 % après mise à l'échelle → valeurs déjà en pourcent, passer l'échelle à 1 ;
- un idle CPU ≤ 1 sur tous les FI avec l'échelle 1 → valeurs en 0–1, remettre l'échelle à 100.

Affichage Zabbix : le préfixe `!` empêche Zabbix d'ajouter K/M/G aux unités (« 1.5 KkWh » sinon). `%`, `W`, `bps` et `°C` gardent la conversion automatique.

## Collecte des métriques

Selon la page d'aide Intersight « Data Collection » :
- Les métriques sont collectées pour les domaines IMM et UMM, et pour les serveurs **standalone (ISM)**. En UMM, seules les métriques environnementales sont collectées.
- **Intervalle de collecte** : 1 minute avec la licence Advantage, 10 minutes avec Essentials (et en UMM). La configuration par défaut vise Advantage : `{$INTERSIGHT.WINDOW}` = 10 minutes. **En Essentials, passe-la à 30** pour garder au moins 2 points par fenêtre.
- **Prérequis** sans lesquels la télémétrie reste vide : blades derrière un IOM UCS-IOM-2408, UCSX-I-9108-25G ou UCSX-I-9108-100G ; en IMM, une licence Intersight valide sur tous les serveurs ; sur les FI, une configuration NTP valide.

## À vérifier sur ton tenant (non garanti par la doc publique)

Ces points sont configurables sans toucher au code :

| Point | Où vérifier | Réglage |
|---|---|---|
| Appliance plus ancienne que le SaaS : métriques absentes de ta version | page d'aide de l'appliance, ou onglet Metrics d'un équipement | `TELEMETRY_QUERIES` |
| Champs FI (`Version`, `OutOfBandIpAddress`) et châssis (`OperState`) | API Reference Intersight | `src/collector.js`, section 7 |

Si un de ces points est faux, l'item « API: last errors » affiche l'appel en cause avec le code HTTP. Les items concernés restent simplement vides.

## Limites connues

- **Jointure** : la télémétrie est rattachée à l'inventaire par `host.type` + `host.name`. Un châssis et un serveur de même nom sont donc bien distingués. En revanche, deux serveurs de même nom partagent encore leurs métriques, car Cisco précise que `host.name` n'est pas garanti unique.
- **Double comptage possible** : si la puissance châssis inclut celle des blades, n'additionne pas les totaux « Chassis » et « Servers ». Les totaux sont volontairement séparés par classe.
- **Énergie** : `Energy: last 24h` est calculée comme puissance moyenne sur 24 h × 24 / 1000. C'est exact sur une fenêtre glissante, à condition d'avoir 24 h d'historique.
- **Historique du script maître** : il est à 0 (le JSON peut être gros). Pour déboguer, utiliser le bouton « Test ».
- **Température** : les triggers comparent chaque capteur à **ses propres** seuils (`limit_high_critical`, `limit_high_degraded`), sur les équipements qui les remontent. Les températures CPU ne remontent que si l'hôte est allumé.
- **Puissance châssis IMM** : c'est la somme de la puissance absorbée par les PSU (`hw.power`), Cisco ne remontant pas `hw.host.power` pour ces châssis.

## Ce que tu obtiens

- **Par équipement** : puissance moyenne et pic, état d'alimentation, énergie sur 24 h, température max, ventilateurs min/max, PSU (LLD : utilisation et sortie), ports (LLD filtrable), alarmes critiques et warning, modèle, numéro de série, firmware, IP de management. Les champs d'inventaire Zabbix sont remplis automatiquement.
- **Par type** (LLD sur les modèles, groupe `Intersight/<Classe>/<Modèle>`) : somme, moyenne, min, max, nombre d'équipements remontant, énergie, coût, CO₂, température max.
- **Par classe** : puissance totale, énergie, coût et CO₂ sur 24 h.
- **Santé** : appels, erreurs, durée, valeurs poussées et rejetées, absence de données, alarmes globales.

## Performance de la signature hs2019

L'ECDSA en JavaScript pur est coûteux dans l'interpréteur Duktape. Mesures de référence : ~10 ms par signature sous V8 avec JIT, ~280 ms sous V8 sans JIT. Duktape étant généralement plus lent, compte de 0,5 à 3 s par signature, soit 13 signatures par cycle (4 inventaires + 9 requêtes de télémétrie). Ces chiffres sont des estimations : la vraie mesure est l'item **« API: signing time (hs2019) »**. Un trigger se déclenche si le cycle approche le timeout de 120 s. Le cas échéant, augmente l'intervalle ou le timeout de l'item.
