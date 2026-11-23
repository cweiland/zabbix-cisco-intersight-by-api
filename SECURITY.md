# Sécurité / Security

## Signaler une vulnérabilité

**N'ouvre pas d'issue publique** pour une faille de sécurité. Utilise le signalement privé de GitHub : onglet **Security** du dépôt, puis **Report a vulnerability**. Seul le mainteneur voit le rapport.

Indique si possible :

- le fichier et la version concernés (commit) ;
- comment reproduire le problème ;
- l'impact (fuite de la clé API Intersight, contournement du pare-feu du devcontainer, exécution de code sur la machine hôte, etc.).

*English: please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting (Security tab > Report a vulnerability).*

## Périmètre

- **Templates et collecteur** (`templates/`, `src/collector.js`) : signature des requêtes (hs2019, ECDSA P-256), gestion de la clé privée dans les macros Zabbix, données envoyées par `history.push`.
- **Devcontainer** (`.devcontainer/`) : pare-feu sortant, isolation entre le conteneur et la machine hôte. Les réglages qui dépendent de la machine hôte sont décrits dans [docs/DEVCONTAINER_SECURITE_FR.md](docs/DEVCONTAINER_SECURITE_FR.md). Les limites connues (tunnel DNS, accès à tout GitHub, adresses figées au démarrage) y sont listées : elles ne sont pas des vulnérabilités à signaler.

## Versions

Seule la dernière version de la branche `main` est maintenue.
