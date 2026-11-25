# Changelog

## Non publié
- **Unités de base uniquement** : les valeurs sont stockées en W, Wh, g et s au lieu de kWh, kg et ms, pour que Grafana et les bases de séries temporelles externes reçoivent la valeur brute. Zabbix n'ajoute les préfixes K/M/G qu'à l'affichage (« 1.5 KWh »).
  - Énergie 24 h en `Wh` (plus de `/1000`). **Clé renommée** `intersight.energy.kwh.24h` → `intersight.energy.24h` : nouvel UUID, l'historique de l'ancien item est perdu à la réimportation.
  - Coût : `énergie × {$INTERSIGHT.ENERGY.PRICE} / 1000` (le prix reste par kWh). CO₂ en `g` (l'intensité reste en gCO₂/kWh).
  - Durées de l'API en secondes (unité `s`) : champs JSON `api.duration_s` et `api.sign_s` (au lieu de `duration_ms`, `sign_ms`), seuil du trigger « collector close to its 120s timeout » à 90 s.
  - **Chaque item dont l'unité change a une nouvelle clé**, donc une nouvelle série : l'ancien historique (kWh, kg, ms) n'est jamais relu dans la nouvelle unité, et le coût ne peut pas lire un total encore en kWh. Clés renommées : `intersight.api.duration` → `intersight.api.run.time`, `intersight.api.sign` → `intersight.api.sign.time`, `intersight.total.energy[…]` → `intersight.total.energy.24h[…]`, `intersight.total.co2[…]` → `intersight.total.co2.24h[…]`, et de même pour `intersight.model.energy` / `intersight.model.co2`. Le coût garde sa clé (toujours en EUR).
  - **À la réimportation**, cocher « Delete missing » pour les items : sinon les anciens items ne sont pas supprimés et restent à côté des nouveaux (doc Zabbix 7.0, « Import rules »). Leur historique est alors supprimé ; l'exporter avant si besoin. Les nouveaux totaux restent vides jusqu'à leur premier calcul (intervalle de 1 h).
- Correctif : la liste `blades` de chaque châssis restait vide. Sur l'appliance, le `RegisteredDevice` d'une lame diffère de celui de son châssis, donc la clé `RegisteredDevice.Moid:ChassisId` ne correspondait jamais. Une lame est désormais rattachée par la relation `EquipmentChassis` de `compute.PhysicalSummary` (schéma de l'API Intersight, SDK CiscoDevNet/intersight-python) ; l'ancienne clé ne sert plus qu'en repli. Seul le mode imbriqué de Zabbix 7.4 (`flat_servers=0`) était concerné.
- Correctif : l'item agrégé « {#CLASS} {#MODEL}: devices reporting » comptait les équipements ayant une valeur de puissance (`intersight.power`). Certains équipements (par exemple des FI) ne remontent pas de puissance et n'étaient donc pas comptés. Il compte désormais les équipements ayant une valeur `intersight.model`, que le collecteur renseigne toujours (`unknown` si Intersight n'en donne pas). Même clé et même unité : l'historique est conservé, mais les valeurs antérieures suivent l'ancien comptage.
- Nouveau champ `chassis_moid` sur les serveurs (Moid du châssis, vide pour un rack) ; test `tests/blade_chassis_matching.test.js`.

## 7.0-6
- Correctif d'import : `Invalid parameter "/N/params": value is too long`. Zabbix limite les scripts à 65 535 caractères, et le collecteur commenté en fait 71 266. Le template embarque désormais une copie sans commentaires (environ 56 000 caractères) générée automatiquement ; `src/collector.js` reste la source commentée.
- `tools/validate_template.py` vérifie la longueur des scripts.
- `tests/embedded_script.test.js` exécute les tests du collecteur sur la copie embarquée, celle que Zabbix exécute réellement.
- **Règle : aucun nom de champ déduit.** `docs/intersight_metrics.json` est le catalogue extrait des pages « Supported Metrics » d'Intersight (13 instruments, 146 métriques, 724 champs, via `tools/build_metrics_catalog.py`). `tests/documented_fields.test.js` échoue sur tout champ ou dataSource absent du catalogue.
- Chaque item n'est créé que sur les équipements dont le type figure dans la « Support information » de la métrique (ECC : serveurs ; CPU `system.cpu` et mémoire : FI ; marges de température et de ventilateurs : serveurs, châssis ou FI selon le seuil).
- Débit réseau par port (bits/s) et vitesse de lien, avec la formule des tableaux de bord Grafana intersight-grafana : `somme(io_receive) / somme(io_receive_duration) × 8`. Tous les champs utilisés figurent dans le catalogue ; la formule, elle, vient de ces tableaux de bord et non de la doc Cisco.
- Regroupement par attributs « à points » (`host.name`, `host.type`, `hw.network.port.role`) via des colonnes virtuelles `nested-field`, comme dans ces mêmes tableaux de bord.
- **Unités vérifiées** : Cisco documente les utilisations en `%`, mais les données brutes de l'appliance sont des ratios 0–1 (0,1 = 10 %). Une seule macro, `{$INTERSIGHT.PERCENT.SCALE}` = 100, s'applique à toutes les utilisations (CPU, mémoire, PSU, réseau). S'y ajoutent des contrôles à l'exécution (pourcentage > 100 %, idle CPU ≤ 1 sur tous les FI) et un test dédié.
- Unités Zabbix `!kWh`, `!kg`, `!EUR`, `!ms`, `!rpm` : plus de préfixes automatiques absurdes (« 1.5 KkWh »).
- Filtre des ports par rôle (`{$INTERSIGHT.PORT.ROLE.NOT_MATCHES}`) : interfaces virtuelles et ports non configurés ignorés par défaut.
- Puissance des châssis IMM : somme de la puissance absorbée par les PSU (`hw.power`) au lieu de leur puissance de sortie.
- Endpoint de télémétrie : `/api/v1/telemetry/TimeSeries`, celui documenté par Cisco.
- Configuration par défaut pour la licence Advantage (collecte chaque minute) : fenêtre de télémétrie de 10 minutes. En Essentials (collecte toutes les 10 minutes), passer `{$INTERSIGHT.WINDOW}` à 30.

## 7.0-5
- Métriques issues de la doc « Supported Metrics » de l'appliance : erreurs ECC par barrette (`hw.memory`), utilisation CPU (`hw.cpu`, `system.cpu`), mémoire des FI (`system.memory`), état des liens et utilisation de bande passante par port.
- Seuils propres à chaque capteur : `hw.temperature.limit_high_degraded` (WARNING) et `limit_high_critical` (HIGH) ; `hw.fan.speed.limit_low_critical` pour chaque ventilateur.
- Trigger de lien tombé limité aux ports actifs dans les dernières 24 h.

## 7.0-4
- Correctif : `hw.network` interrogé dans le dataSource `NetworkInterfaces` (et non `PhysicalEntities`).
- Télémétrie rattachée par `host.type` + `host.name` (un châssis et un serveur de même nom ne sont plus confondus).
- Puissance des châssis IMM calculée depuis la sortie des PSU (`hw.host.power` n'est pas remonté pour eux).
- Marge de température au seuil critique de chaque capteur ; erreurs par port.

## 7.0-3
- Authentification par clé API v3 (hs2019) : ECDSA P-256 en JavaScript pur, nonce déterministe RFC 6979.

## 7.0-2
- Mode OAuth2 client credentials.

## 7.0-1
- Première version : 4 templates (parent + serveurs, châssis, FI), host prototypes, `history.push`, agrégats par modèle, énergie, coût et CO₂.
