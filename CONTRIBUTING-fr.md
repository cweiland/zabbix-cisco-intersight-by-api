Ce guide est disponible en : [English](CONTRIBUTING.md) | Français

# Contribuer

Ce guide reprend les règles qui s'appliquent déjà dans le dépôt. `CLAUDE.md` en est la référence complète (décisions, faits vérifiés, points ouverts) ; `.github/copilot-instructions.md` en reprend les règles essentielles.

## Environnement de développement

- Le dépôt fournit un devcontainer (`.devcontainer/`), avec les mêmes versions d'outils que la CI (Node 20, Python 3.12, PyYAML 6.0.4). Voir la section « Environnement de développement (bac à sable) » du [README](README-fr.md).
- **Avant la première ouverture, la machine hôte doit être configurée en suivant [docs/DEVCONTAINER_SECURITE_FR.md](docs/DEVCONTAINER_SECURITE_FR.md)** : une partie de l'isolation (identifiants git, agent SSH) ne peut pas être réglée depuis le dépôt.
- Dans le conteneur, git est en lecture seule : les commits et les push se font depuis la machine hôte, après relecture du diff.

## Vérifications et pull requests

- `tools/ci.sh` se lance avant chaque commit : il exécute en local les mêmes vérifications que la CI GitHub (tests, ES5, template à jour, structure du template).
- Toute modification de `main` passe par une pull request. Le contrôle `tests` (CI GitHub) est exigé sur `main`.

## Code

- **Template généré** : `templates/*.yaml` est généré par `tools/generate_templates.py` : il ne s'édite jamais à la main. Il faut modifier `src/collector.js` ou le générateur, puis lancer `python3 tools/generate_templates.py`. La CI échoue si le template commité ne correspond pas à `src/collector.js`.
- **ES5** : `src/collector.js` doit rester en ES5 (Zabbix l'exécute dans Duktape) : ni `let`, ni `const`, ni fonctions fléchées, ni template strings. La CI le vérifie.
- **65 535 caractères** : Zabbix limite les scripts d'item à 65 535 caractères. Le template embarque une copie de `src/collector.js` sans commentaires : le nouveau code doit rester compact, et les commentaires restent dans la source. Le générateur, `tools/validate_template.py` et `tests/embedded_script.test.js` échouent au-delà de la limite.
- **Aucun nom de métrique déduit** : chaque champ Druid et chaque dataSource interrogés doivent figurer dans `docs/intersight_metrics.json`, le catalogue extrait des pages « Supported Metrics » d'Intersight. `tests/documented_fields.test.js` échoue sur tout autre champ ou dataSource. Les calculs doivent aussi être documentés, ou découler de définitions documentées.
- **Unités de base** : les valeurs sont stockées en W, Wh, g, s, bps, B (tailles de données), jamais en kWh, kg, ms ou KB. Les valeurs sources sont converties vers l'unité de base (ms → s, octets de débit → bits, ratios 0–1 → %), jamais une valeur en unité de base vers une unité préfixée. Zabbix n'ajoute les préfixes K/M/G qu'à l'affichage (voir la section « Unités » du [README](README-fr.md)). `tests/units.test.js` refuse toute autre unité.
- **Nouvelle clé d'item quand l'unité change** : un changement d'unité ou d'échelle demande une nouvelle clé d'item (nouvel UUID, nouvelle série). Avec la même clé, l'ancien historique serait lu dans la nouvelle unité. Les anciennes et les nouvelles clés sont à noter dans le CHANGELOG, avec la consigne de cocher « Delete missing » pour les items à la réimportation (doc Zabbix 7.0, « Import rules ») : sinon, les anciens items ne sont pas supprimés.

## Tests

- Tout nouveau comportement reçoit une vérification PASS/FAIL qui met `process.exitCode = 1` en cas d'échec. `node tests/run_all.js` lance tous les fichiers `tests/*.test.js`.
- Aucune RegExp construite à partir d'une chaîne dans les tests (CodeQL « Incomplete string escaping ») : il faut une recherche en texte simple (`indexOf` / `includes`).

## Documentation

- Le README, le guide CONTRIBUTING et les guides de `docs/` existent en anglais et en français : toute modification se fait dans les deux langues, dans la même pull request. Chaque fichier renvoie vers l'autre langue.
- Le CHANGELOG est en anglais seul.
- Le code et ses commentaires sont en anglais.

## À ne jamais commiter

- `params.json` (paramètres et clé privée pour `zabbix_js`) ;
- les identifiants (`*.pem`, `*.key`, `.env`, `.env.*`) ;
- le dossier `cisco-docs/` et `Supported_Metrices.md` (documentation Cisco, non redistribuable) ;
- `docs/Zabbix_Documentation_*.pdf` (manuel Zabbix, dont la notice de copyright interdit la redistribution).

Tous sont dans le `.gitignore`.

## Signaler une vulnérabilité

Jamais par une issue publique : il faut passer par le signalement privé de GitHub, décrit dans [SECURITY.md](SECURITY.md).

## Licence

Le projet est distribué sous la GNU Affero General Public License, version 3 uniquement (`AGPL-3.0-only`) : texte complet dans [LICENSE](LICENSE). Toute contribution est distribuée sous la licence du projet, `AGPL-3.0-only`, comme le reste du dépôt.
