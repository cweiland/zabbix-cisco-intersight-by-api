# Security / Sécurité

This policy is in English first, then in French (section "Version française").
Cette politique est d'abord en anglais, puis en français (section « Version française »).

## Reporting a vulnerability

**Do not open a public issue** for a security flaw. Use GitHub's private vulnerability reporting: **Security** tab of the repository, then **Report a vulnerability**. Only the maintainer sees the report.

If possible, state:

- the file and the version concerned (commit);
- how to reproduce the problem;
- the impact (leak of the Intersight API key, bypass of the devcontainer firewall, code execution on the host machine, etc.).

## Scope

- **Templates and collector** (`templates/`, `src/collector.js`): signing of the requests (hs2019, ECDSA P-256), handling of the private key in the Zabbix macros, data sent through `history.push`.
- **Devcontainer** (`.devcontainer/`): outbound firewall, isolation between the container and the host machine. The settings that depend on the host machine are described in [docs/DEVCONTAINER_SECURITY.md](docs/DEVCONTAINER_SECURITY.md). The known limitations (DNS tunnel, access to all of GitHub, addresses fixed at start) are listed there: they are not vulnerabilities to report.

## Versions

Only the latest version of the `main` branch is maintained.

## Version française

### Signaler une vulnérabilité

**N'ouvrez pas d'issue publique** pour une faille de sécurité. Utilisez le signalement privé de GitHub : onglet **Security** du dépôt, puis **Report a vulnerability**. Seul le mainteneur voit le rapport.

Indiquez si possible :

- le fichier et la version concernés (commit) ;
- comment reproduire le problème ;
- l'impact (fuite de la clé API Intersight, contournement du pare-feu du devcontainer, exécution de code sur la machine hôte, etc.).

### Périmètre

- **Templates et collecteur** (`templates/`, `src/collector.js`) : signature des requêtes (hs2019, ECDSA P-256), gestion de la clé privée dans les macros Zabbix, données envoyées par `history.push`.
- **Devcontainer** (`.devcontainer/`) : pare-feu sortant, isolation entre le conteneur et la machine hôte. Les réglages qui dépendent de la machine hôte sont décrits dans [docs/DEVCONTAINER_SECURITE_FR.md](docs/DEVCONTAINER_SECURITE_FR.md). Les limites connues (tunnel DNS, accès à tout GitHub, adresses figées au démarrage) y sont listées : elles ne sont pas des vulnérabilités à signaler.

### Versions

Seule la dernière version de la branche `main` est maintenue.
