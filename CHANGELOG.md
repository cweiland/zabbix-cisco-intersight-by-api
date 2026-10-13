# Changelog

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
