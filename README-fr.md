Ce README est disponible en : [English](README.md) | Français

# Cisco Intersight → Zabbix

Supervision de Cisco Intersight (Virtual Appliance ou SaaS) dans Zabbix 7.0 LTS : serveurs rack et blade, châssis et Fabric Interconnects.

**Niveau de validation** : validé : mode `hs2019` sur une Intersight Virtual Appliance ; bêta : SaaS, modes `rsa` et `oauth`. Les constats notés « observé sur une appliance pendant la conception » viennent d'une seule installation : leur portée n'est pas garantie, et ils sont à vérifier sur chaque appliance.

- Un seul script fait tous les appels API, puis alimente un host Zabbix par équipement via `history.push`.
- Trois modes d'authentification : clé API v3 **hs2019** (ECDSA P-256 implémenté en JavaScript pur, car Zabbix ne sait signer qu'en RSA ; validé), clé v2 **rsa** (bêta), ou **OAuth2** (bêta).
- Métriques et agrégats par type d'équipement : puissance, énergie, coût et CO₂, température, ventilateurs, PSU, mémoire ECC, CPU, ports réseau, alarmes et firmware.

## Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `templates/zbx_intersight_templates_7.0.yaml` | Les 4 templates, **à importer dans Zabbix** |
| `src/collector.js` | Script de collecte (ES5 / Duktape), embarqué dans le template |
| `tools/generate_templates.py` | Régénère le YAML depuis `src/collector.js` |
| `tools/validate_template.py` | Contrôles structurels du YAML généré (macros, UUID, clés, triggers) |
| `tools/ci.sh` | Lance en local toutes les vérifications de la CI GitHub |
| `.devcontainer/` | Bac à sable de développement : conteneur, pare-feu sortant, mêmes versions que la CI |
| `docs/intersight_metrics.json` | Catalogue des métriques Intersight (instruments, champs Druid, équipements supportés) |
| `tools/build_metrics_catalog.py` | Reconstruit ce catalogue depuis les pages « Supported Metrics » |
| `tools/check_metrics_against_doc.py` | Vérifie les métriques utilisées contre la doc « Supported Metrics » d'une appliance |
| `tests/` | Tests Node.js sans dépendance : ECDSA (vecteur RFC 6979 + OpenSSL), modes d'auth, scénarios |
| `docs/UPGRADE_7.4_FR.md` | Variante Zabbix 7.4 (blades découverts sous leur châssis) |
| `SECURITY.md` | Signaler une vulnérabilité (signalement privé GitHub) et périmètre |
| `docs/DEVCONTAINER_SECURITE_FR.md` | Configurer sa machine pour le devcontainer (identifiants git, SSH, vérifications) |
| `CONTRIBUTING-fr.md` | Règles de contribution (vérifications, fichiers générés, unités, licence) |
| `CLAUDE.md` | Contexte du projet pour Claude Code (décisions, faits vérifiés, points ouverts) |
| `.github/copilot-instructions.md` | Instructions pour GitHub Copilot (règles essentielles reprises de `CLAUDE.md`) |

## Développement

```bash
node tests/run_all.js                  # tous les tests (Node.js 20, version utilisée par la CI)
python3 tools/generate_templates.py    # après toute modification de src/collector.js (PyYAML)
python3 tools/check_metrics_against_doc.py Supported_Metrices.md
tools/ci.sh                            # toutes les vérifications de la CI, avant chaque commit
```

Le YAML est généré : **ne pas l'éditer à la main**. Il embarque une copie de `src/collector.js` sans commentaires, car Zabbix limite les scripts à 65 535 caractères. Il faut modifier `src/collector.js` ou `tools/generate_templates.py`, puis régénérer. La CI vérifie que le template commité correspond au script, que le code reste en ES5, et que tous les tests passent. Les UUID sont dérivés des noms, donc stables d'une génération à l'autre.

### Environnement de développement (bac à sable)

Le dépôt fournit un devcontainer (`.devcontainer/`) : Ubuntu 24.04 avec Node 20, Python 3.12 et PyYAML 6.0.4, les mêmes versions que la CI, plus l'extension Claude Code.

**Avant la première ouverture, configurez votre machine en suivant [docs/DEVCONTAINER_SECURITE_FR.md](docs/DEVCONTAINER_SECURITE_FR.md)** : une partie de l'isolation (identifiants git, agent SSH) ne peut pas être réglée depuis le dépôt.

- **Prérequis** : VS Code avec l'extension Dev Containers, et un moteur Docker.
- **Ouverture** : commande « Dev Containers: Reopen in Container ». À chaque démarrage, le pare-feu est appliqué en premier, par le point d'entrée de l'image (`.devcontainer/intersight-entrypoint.sh`) : s'il échoue, le conteneur s'arrête et VS Code ne peut pas s'y connecter. Ensuite, `postStartCommand` attend que le pare-feu de ce démarrage soit complet (un marqueur écrit par root, propre à chaque démarrage, `.devcontainer/intersight-wait-for-firewall.sh`), puis lance les tests et le validateur. Le pare-feu est limité à 45 s (arrêt forcé 5 s plus tard), en dessous des 60 s d'attente : un démarrage bloqué (DNS, GitHub) arrête le conteneur au lieu de laisser VS Code se connecter trop tôt. Un environnement cassé est donc signalé dès le démarrage. VS Code et ses extensions, dont Claude Code, attendent la fin de `postStartCommand` (`waitFor`).
- **Pare-feu sortant** : tout est bloqué sauf Claude Code (`api.anthropic.com`, et `platform.claude.com` + `claude.ai` pour la connexion et le renouvellement des jetons, d'après la [documentation réseau de Claude Code](https://code.claude.com/docs/en/network-config)), et GitHub, en IPv4 comme en IPv6. Si IPv6 ne peut pas être filtré, il doit être désactivé sur chaque interface (et pour les futures interfaces), sinon le conteneur ne démarre pas. Il se ferme en cas d'échec, à deux niveaux : le blocage est posé avant toute autre règle, et toute erreur arrête le conteneur. Ni la machine hôte ni la passerelle du conteneur ne sont joignables : Docker y publie aussi les ports des autres conteneurs. VS Code passe par `docker exec`, pas par le réseau. Il n'y a aucun `sudo` dans le conteneur : rien de ce qui y tourne, Claude Code compris, ne peut lever les règles ni ajouter une destination. Le point d'entrée et le pare-feu, lancés en root, n'utilisent que les commandes des dossiers système (`/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`), jamais celles d'un dossier modifiable par `vscode` comme celui de Node (`/usr/local/share/nvm`). Pour réappliquer le pare-feu, il faut redémarrer le conteneur. Pour installer un outil, il faut l'ajouter au `Dockerfile` et reconstruire. Les tests `tests/firewall_script.test.js` vérifient ces points.
- **Accès à une appliance Intersight** (HTTPS uniquement) : `INTERSIGHT_APPLIANCE_HOST` doit être défini dans l'environnement où VS Code est lancé, avant la création du conteneur (un changement demande « Rebuild Container »). Le script lit cette variable dans l'environnement du conteneur, fixé à sa création. Sans elle, aucune appliance n'est joignable depuis le conteneur. Si son nom ne se résout pas, le conteneur démarre quand même, avec un avertissement. Les tests n'en ont pas besoin : tous les appels sont simulés.
- **Si une connexion légitime est bloquée** (par exemple pour la connexion de Claude Code), il faut ajouter le domaine à `ALLOWED_DOMAINS` dans `.devcontainer/intersight-init-firewall.sh`.
- **Fichiers exécutés par la machine hôte, en lecture seule dans le conteneur** : `.devcontainer/` (dont `initializeCommand`, lancé sur l'hôte), `.git/` en entier (hooks et config utilisés par `git am`, `git push` ou VS Code sur l'hôte ; protéger seulement `.git/config` et `.git/hooks` ne suffit pas, un simple fichier `.git/commondir` redirige git vers une autre config) et `.vscode/` (réglages et tâches quand le dossier est rouvert en local). Rien de ce qui tourne dans le conteneur, Claude Code compris, ne peut donc lancer de commande sur la machine hôte par ce biais. Conséquences : dans le conteneur, git sert à lire (`git status`, `git diff`, `git log`) ; Claude Code modifie les fichiers, et les commits et les push se font depuis la machine hôte, après relecture. `.devcontainer/` et `.vscode/` se modifient aussi depuis la machine hôte. Le clone doit être un dépôt classique (`.git` dossier, pas un worktree), et `.vscode/` doit exister : seul `.vscode/extensions.json` est versionné.
- **VS Code** : le conteneur ne joint aucun serveur de VS Code. Le serveur VS Code est copié depuis la machine hôte, et les extensions sont téléchargées sur la machine hôte puis copiées dans le conteneur (`downloadExtensionsLocally` dans le journal) : aucune action nécessaire.
- **Adresses IP figées au démarrage** : la liste autorisée est calculée une fois, au démarrage. Si un service change d'adresse ensuite (CDN), ses nouvelles connexions échouent jusqu'au prochain redémarrage du conteneur. C'est voulu : aucun processus root ne reste actif pour modifier les règles.
- **Identifiants git de la machine hôte : aucun identifiant HTTPS GitHub sur l'hôte (obligatoire)**. Dev Containers ouvre un canal entre le conteneur et la machine hôte (`REMOTE_CONTAINERS_IPC`) et y dépose un script de relais (`/tmp/vscode-remote-containers-<id>.js`) qui interroge le gestionnaire d'identifiants de la machine hôte. Comme GitHub est autorisé, un agent manipulé pourrait obtenir le jeton GitHub de l'hôte et pousser vers n'importe quel dépôt de ce compte. **Le réglage `"dev.containers.gitCredentialHelperConfigLocation": "none"` ne suffit pas** : il retire seulement le `credential.helper` de la config git, mais le script répond toujours (observé pendant la conception : il renvoie l'identifiant et le mot de passe stockés). La seule protection sûre : ne garder **aucun** identifiant `https://github.com` dans le gestionnaire d'identifiants de la machine hôte, et pousser depuis l'hôte en SSH avec une clé protégée par une phrase de passe, **sans agent SSH** (Dev Containers transmet automatiquement un agent qui tourne, y compris celui de Windows). Les fenêtres de connexion du gestionnaire d'identifiants de Windows (Git Credential Manager) doivent aussi être désactivées : `git config --global credential.interactive false`. Sans ce réglage, une demande partie du conteneur ouvre une fenêtre de connexion GitHub sur la machine hôte (observé pendant la conception) : s'y connecter renverrait le jeton au conteneur. **N'acceptez jamais une telle fenêtre pendant que le conteneur tourne.** Le réglage `none` est à garder aussi : il évite que git utilise le relais sans que cela se voie. Vérification, dans le conteneur : la commande de `.devcontainer/check-host-credentials.sh` doit afficher « no GitHub credential ».
- **Images et paquets épinglés** : l'image de base est fixée par son empreinte (`@sha256:` dans le `Dockerfile`) et PyYAML est installé avec ses empreintes PyPI (`.devcontainer/requirements-dev.txt`, `--require-hashes`, aussi dans la CI). Le conteneur tourne avec `no-new-privileges` : aucun programme ne peut gagner de droits (setuid). Pour mettre l'image à jour : `docker pull` du tag, vérification, puis remplacement de l'empreinte.
- **Claude Code** : sa configuration (`CLAUDE_CONFIG_DIR`, y compris le fichier `.claude.json`) et sa connexion sont dans un volume Docker : elles survivent à un « Rebuild Container ».
- **DNS** : les requêtes DNS (UDP et TCP) ne partent que vers les résolveurs du conteneur (`/etc/resolv.conf`, écrit par Docker), pas vers n'importe quel serveur. **Limite connue** : un résolveur récursif relaie des requêtes vers n'importe quel domaine, donc un tunnel DNS (données cachées dans des noms de domaine) reste possible ; seul un proxy DNS filtrant l'empêcherait. De même, les plages GitHub autorisées donnent accès à tout GitHub (autres dépôts, gists), pas seulement à ce dépôt.
- **À ne jamais commiter** : `params.json` (paramètres et clé privée pour `zabbix_js`), le dossier `cisco-docs/` (pages Cisco du catalogue), `Supported_Metrices.md` (doc Cisco « Supported Metrics », non redistribuable) et `docs/Zabbix_Documentation_*.pdf` (manuel Zabbix, dont la notice de copyright interdit la redistribution). Tous sont dans le `.gitignore`.


Le fichier `zbx_intersight_templates_7.0.yaml` contient 4 templates :

| Template | Lié à | Rôle |
|---|---|---|
| Cisco Intersight by API | 1 host « Intersight » créé à la main | Collecte (1 script / 5 min), découverte, agrégats, santé |
| Cisco Intersight Server by push | serveurs découverts (rack + blade) | Puissance, énergie, PSU, thermique, ventilos, réseau, firmware, alarmes |
| Cisco Intersight Chassis by push | châssis découverts | Idem, sans firmware |
| Cisco Intersight FI by push | Fabric Interconnects découverts | Idem, avec firmware et ports |

Le template parent fait **tous** les appels Intersight, puis pousse un JSON par équipement vers l'item trapper `intersight.raw` de chaque host découvert (méthode API `history.push`, Zabbix 7.0+). Les hosts découverts ne font aucun appel API.

## Flux de données

1. Le script `intersight.collect` lit l'inventaire : `compute/PhysicalSummaries`, `equipment/Chasses`, `network/ElementSummaries` et `cond/Alarms` (une seule requête : alarmes non Cleared, plus les alarmes Cleared récentes ; voir « Alarmes Intersight »).
2. Il lit la télémétrie Druid via `/api/v1/telemetry/TimeSeries` (requêtes `groupBy`), groupée par `host.id`, `host.type` et `host.name` : 9 instruments (voir « Métriques collectées »). Chaque ligne est rattachée à l'équipement dont le `Moid` est le dernier segment de `host.id` (voir « Limites connues », « Jointure »).
3. Il signe chaque requête avec la **clé API v3** (`hs2019`, ECDSA P-256). Zabbix ne sait faire que du RSA, donc l'ECDSA est implémenté en JavaScript pur dans le script (nonce déterministe RFC 6979). Les modes `rsa` (clé v2) et `oauth` restent disponibles via `{$INTERSIGHT.AUTH}`.
4. Il pousse les valeurs vers les hosts `intersight-<Moid>` par `history.push`.
5. Il renvoie un JSON qui alimente les LLD (host prototypes), les items de santé et les agrégats.

Chaque appel est isolé dans un `try/catch`. Une métrique absente ne casse pas le reste ; l'erreur apparaît dans l'item « API: last errors ».

## Installation

1. **Intersight** : utilisez la clé API v3 (`BEGIN EC PRIVATE KEY`, courbe P-256), idéalement avec un rôle en lecture seule.
2. **Zabbix, utilisateur technique** : créez un utilisateur dédié avec un rôle API autorisant `history.push`, une permission lecture sur les groupes `Intersight/*`, et un token API.
3. **Importez** le YAML (Data collection > Templates > Import).
4. **Créez un host** « Cisco Intersight », sans interface, et liez-lui `Cisco Intersight by API`.
5. **Renseignez les macros** sur ce host :

| Macro | Valeur |
|---|---|
| `{$INTERSIGHT.AUTH}` | `hs2019` (défaut) |
| `{$INTERSIGHT.KEY_ID}` | ID de la clé API |
| `{$INTERSIGHT.SECRET}` (secret) | clé privée EC : PEM complet avec `\n` littéraux, ou corps base64 sur une ligne |
| `{$INTERSIGHT.API.HOST}` | `intersight.com`, votre région SaaS ou votre appliance |
| `{$ZABBIX.API.URL}` | `https://<frontend>/api_jsonrpc.php` |
| `{$ZABBIX.API.TOKEN}` (secret) | token de l'utilisateur technique |
| `{$INTERSIGHT.ENERGY.PRICE}` | prix du kWh (0 par défaut) |
| `{$INTERSIGHT.CO2.G.KWH}` | intensité carbone de votre fournisseur en gCO₂/kWh (0 par défaut) |
| `{$INTERSIGHT.WINDOW}` | fenêtre de télémétrie en minutes : 10 (Advantage, défaut) ou 30 (Essentials) |
| `{$INTERSIGHT.PERCENT.SCALE}` | 100 (défaut) : Intersight stocke les pourcentages en ratios 0–1 |

6. **Allowed hosts** : si vous renseignez ce champ sur les items trapper, il doit contenir l'IP du frontend Zabbix, sinon `history.push` est refusé.
7. Lancez « Test » sur l'item `Intersight collector`, puis « Execute now ».

Au premier cycle, `Push: values rejected` est normal : les hosts n'existent pas encore. Ils sont créés par la LLD et alimentés dès le cycle suivant.

**Hôtes perdus (serveurs, châssis, FI, modèles).** Un équipement qui n'est plus remonté par Intersight voit son hôte désactivé après `{$INTERSIGHT.HOST.LOST.DISABLE}` (`1h` par défaut), puis supprimé après `{$INTERSIGHT.HOST.LOST.DELETE}` (`7d` par défaut, historique perdu). Il est réactivé s'il est de nouveau découvert entre-temps (doc Zabbix 7.0, « Low-level discovery »). Les mêmes délais s'appliquent aux items agrégés d'un modèle qui disparaît. **La suppression doit rester plus longue que la désactivation.** Chaque champ de la règle ne contient qu'une macro (doc Zabbix 7.0, « User macros supported by location », note 1) : pour changer les délais, il faut modifier la valeur des macros.

Si la lecture d'une liste (serveurs, châssis ou FI) échoue, le collecteur n'envoie ni cette liste, ni son compte, ni la liste des modèles, ni (pour les serveurs) les listes `blades` des châssis, et les règles de découverte ignorent la valeur : aucun hôte n'est déclaré perdu pour ce cycle. Les équipements lus sont toujours alimentés, et l'erreur apparaît dans « API: last errors ». Une liste vide renvoyée sans erreur par Intersight est en revanche transmise telle quelle : les hôtes de ce type sont alors bien déclarés perdus. Non vérifié : la doc Zabbix ne dit pas ce que deviennent les problèmes ouverts d'un hôte désactivé.

## Intersight Virtual Appliance

Sur une Intersight Virtual Appliance, la télémétrie n'existe que si la collecte de métriques est active. Selon le guide Cisco « Cisco Intersight Virtual Appliance and Intersight Assist Getting Started Guide », chapitre « Overview », section « About Cisco Intersight Virtual Appliance », tableau 1 « Deployments Options » (<https://www.cisco.com/c/en/us/td/docs/unified_computing/Intersight/b_Cisco_Intersight_Appliance_Getting_Started_Guide/m_appliance_overview.html>) :

- **Mono-nœud (standalone)** : la collecte est une option à activer, « In the standalone configuration, you can opt-in to enable the essential tier metrics data collection ».
- **2 nœuds** : « a two-node cluster that includes an appliance management node and a metrics node ».
- **3 nœuds** : « metrics data collection is not supported in the three-node cluster deployment ».
- **4 nœuds** : « a four-node cluster that includes HA management cluster and a metrics node ».

La même page indique que la collecte se désactive automatiquement au-delà d'un seuil de serveurs, ou quand le disque disk8 du nœud de métriques est rempli à 90 %, et qu'elle doit alors être réactivée manuellement.

Sans collecte de métriques, l'inventaire, les alarmes et le firmware fonctionnent, mais les items de puissance, température, ventilateurs et réseau restent vides, et « API: last errors » signale les requêtes de télémétrie.

## Alarmes Intersight → problèmes Zabbix

Chaque alarme Intersight (`cond.Alarm`) devient un problème Zabbix **sur l'hôte de son équipement**. C'est un miroir à sens unique : rien n'est écrit vers Intersight, et acquitter, fermer ou commenter un problème dans Zabbix n'a aucun effet sur Intersight.

**Rattachement.** Une alarme va sur l'équipement (serveur, châssis ou FI) dont le `Moid` est égal à son `AncestorMoId`. C'est observé sur une appliance pendant la conception ; `AffectedMoId`, vide sur les alarmes ouvertes, n'est pas utilisé. Les alarmes sans ancêtre (`AncestorMoId` vide, objets de la plateforme comme `iam.ApiKey` ou `softwarerepository.Authorization`) et celles dont l'ancêtre n'est pas un équipement lu par le collecteur vont sur l'hôte parent « Cisco Intersight » (liste `platform_alarms`).

**Collecte.** Une seule requête `cond/Alarms` par cycle : toutes les alarmes non Cleared, plus les alarmes Cleared depuis `{$INTERSIGHT.ALARM.CLEARED.WINDOW}`. Lire les Cleared récentes permet de fermer leur problème (le guide Cisco « Intersight Alarms Reference Guide » indique qu'elles restent visibles 30 jours). Le nom de la personne qui a acquitté (`AcknowledgeBy`) n'est jamais lu ni poussé. Les alarmes de sévérité `None` (« pas de sévérité » dans le SDK) ne sont pas poussées. Les compteurs d'alarmes existants (« Alarms: critical », « Alarms (unacknowledged): … ») ne changent pas : ils ne comptent que les alarmes ouvertes et non acquittées.

**Dans Zabbix**, une règle de découverte « Intersight alarms » sur les templates serveur, châssis, FI et sur le template parent crée, pour chaque alarme, trois items (`intersight.alarm.severity[…]`, `intersight.alarm.ack[…]`, `intersight.alarm.suppressed[…]`, avec tables de valeurs) et trois triggers exclusifs, tagués `component: alarm` et `alarm-code: <code>` :

| Sévérité Intersight | Valeur | Problème Zabbix |
|---|---|---|
| Critical | 3 | High (et non Disaster : choix de conception) |
| Warning | 2 | Warning |
| Info | 1 | Information (le prototype peut être désactivé si ces problèmes sont inutiles) |
| Cleared | 0 | aucun : le problème est fermé |

Un changement de sévérité ferme le problème et en ouvre un autre, à la nouvelle sévérité.

**Acquittement et suppression** (états Acknowledged et Suppressed du cycle de vie Intersight : Active, Acknowledged, Suppressed, Cleared) : acquitter ou supprimer une alarme dans Intersight **ne ferme pas** le problème, puisque l'acquittement ne change pas la sévérité (guide Cisco). Seul Cleared le ferme. L'état est affiché dans les données opérationnelles du problème (« Acknowledged in Intersight: …, suppressed: … »). Pour cela, l'expression contient deux conditions toujours vraies, `last(ack)>=0` et `last(suppressed)>=0` : elles ne servent qu'à rendre ces items accessibles par `{ITEM.LASTVALUE2}` et `{ITEM.LASTVALUE3}`. Ces macros désignent l'item de la N-ième fonction de l'expression (vérifié dans le source de Zabbix 7.0), et les macros d'expression `{?…}` ne sont pas acceptées dans les données opérationnelles. À vérifier après import : si `{ITEM.LASTVALUE}` y affiche la valeur brute (0/1) ou le libellé de la table de valeurs.

| Macro | Défaut | Rôle |
|---|---|---|
| `{$INTERSIGHT.ALARM.CLEARED.WINDOW}` | `1d` | ancienneté maximale des alarmes Cleared lues (template parent) |
| `{$INTERSIGHT.ALARM.NODATA}` | `2h` | sans valeur pendant cette durée, le problème d'une alarme se ferme ; doit rester supérieure au heartbeat de 1 h des items d'alarme (« Discard unchanged with heartbeat ») |
| `{$INTERSIGHT.ALARM.LOST.DISABLE}` | `1d` | alarme qui n'est plus remontée : items désactivés après ce délai (« Disable lost resources ») |
| `{$INTERSIGHT.ALARM.LOST.DELETE}` | `7d` | items supprimés après ce délai (« Delete lost resources ») |

**Contrainte :** `{$INTERSIGHT.ALARM.LOST.DELETE}` doit rester **plus long** que `{$INTERSIGHT.ALARM.LOST.DISABLE}` (doc Zabbix 7.0, « Low-level discovery »). Chacun de ces deux champs de la règle ne contient qu'une macro, rien d'autre : Zabbix exige qu'une macro y remplisse tout le champ (doc Zabbix 7.0, « User macros supported by location », note 1). Pour changer les délais, il faut modifier la valeur des macros, pas les champs.

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

Un équipement absent de la liste de support d'une métrique ne renvoie aucune ligne : l'item correspondant reste vide, sans erreur. Les pages ne définissent pas le suffixe `-mqtt` des types de support : les items qui se remplissent sont à vérifier sur chaque appliance.

**Sources autres que la doc Cisco**, toutes deux reprises des tableaux de bord Grafana [intersight-grafana](https://github.com/3191110276/intersight-grafana) (dépôt communautaire, fourni « best-effort ») :
- **Formule du débit** : `somme(hw.network.io_receive) / somme(hw.network.io_receive_duration) × 8` en bits/s. Les champs sont documentés, mais pas la formule ; elle est cohérente avec la doc, qui exprime la vitesse de lien en octets par seconde.
- **Regroupement par attributs « à points »** (`host.name`, `host.type`, `host.id`, `hw.network.port.role`) via des colonnes virtuelles `nested-field`. C'est le seul point non validé qui conditionne toute la télémétrie : si les items de télémétrie restent tous vides alors que l'inventaire remonte, c'est la première piste à vérifier.

**Ressources perdues (PSU et ports).** Une PSU ou un port qui n'est plus remonté est désactivé après `{$INTERSIGHT.LLD.LOST.DISABLE}` (`1h` par défaut), puis supprimé après `{$INTERSIGHT.LLD.LOST.DELETE}` (`7d` par défaut). Il est réactivé s'il est de nouveau découvert entre-temps (doc Zabbix 7.0, « Low-level discovery »). Avant ce réglage, la désactivation était immédiate (valeur par défaut à l'import), si bien qu'un seul cycle sans télémétrie, où le collecteur envoie des listes vides, désactivait toutes les PSU et tous les ports de l'équipement jusqu'au cycle suivant. Si la requête de télémétrie `hw.power_supply` ou `hw.network` échoue, le collecteur n'envoie pas du tout la liste `psus` ou `ports`, et la règle ignore la valeur (`DISCARD_VALUE`) : aucun composant n'est déclaré perdu, et l'erreur apparaît dans « API: last errors ». **La suppression doit rester plus longue que la désactivation.** Chaque champ de la règle ne contient qu'une macro (doc Zabbix 7.0, « User macros supported by location », note 1) : pour changer les délais, il faut modifier la valeur des macros.

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
| Énergie, coût, CO₂ | — | `Wh`, `!EUR`, `g` | calculés depuis la puissance |
| Durées de l'API (cycle, signature) | — | `s` | mesurées par le collecteur |
| Taille du plus gros JSON poussé | — | `B` | octets UTF-8, mesurés par le collecteur |

**Pourcentages : la doc Cisco indique `%`, mais Intersight stocke des ratios 0–1** (0,1 = 10 %). C'est observé dans les données brutes d'une appliance pendant la conception, et cohérent avec les tableaux de bord intersight-grafana, qui multiplient par 100. D'où `{$INTERSIGHT.PERCENT.SCALE}` = 100. Si une version future renvoyait des valeurs 0–100, il suffirait de passer la macro à 1.

**Contrôles à l'exécution**, signalés dans « API: last errors » (puis trigger après 3 cycles) :
- un pourcentage supérieur à 100 % après mise à l'échelle → valeurs déjà en pourcent, passer l'échelle à 1 ;
- un idle CPU ≤ 1 sur tous les FI avec l'échelle 1 → valeurs en 0–1, remettre l'échelle à 100.

**Unités de base uniquement** : toutes les valeurs sont stockées en unité de base (W, Wh, g, s, bit/s, octets B), jamais en kWh, kg ou ms. L'historique, Grafana et les bases de séries temporelles externes reçoivent donc la valeur brute, sans conversion à refaire. Zabbix n'ajoute les préfixes K/M/G (base 10) qu'à l'affichage, par exemple 1 500 Wh affichés « 1.5 KWh » (doc Zabbix 7.0, « Unit symbols », « Item value suffixes »). Exception : l'unité `B` (octets) utilise la base 2, 1 024 B affichés « 1 KB » et 1 536 B « 1.5 KB » (même page, norme JEDEC). Le préfixe `!` empêche cet ajout ; il ne sert que pour `!rpm` et `!EUR`, où un préfixe n'aurait pas de sens.

## Collecte des métriques

Selon la page d'aide Intersight « Data Collection » :
- Les métriques sont collectées pour les domaines IMM et UMM, et pour les serveurs **standalone (ISM)**. En UMM, seules les métriques environnementales sont collectées.
- **Intervalle de collecte** : 1 minute avec la licence Advantage, 10 minutes avec Essentials (et en UMM). La configuration par défaut vise Advantage : `{$INTERSIGHT.WINDOW}` = 10 minutes. **En Essentials, elle doit passer à 30** pour garder au moins 2 points par fenêtre.
- **Prérequis** sans lesquels la télémétrie reste vide : blades derrière un IOM UCS-IOM-2408, UCSX-I-9108-25G ou UCSX-I-9108-100G ; en IMM, une licence Intersight valide sur tous les serveurs ; sur les FI, une configuration NTP valide.

## À vérifier sur chaque tenant (non garanti par la doc publique)

Ces points sont configurables sans toucher au code :

| Point | Où vérifier | Réglage |
|---|---|---|
| Appliance plus ancienne que le SaaS : métriques absentes de sa version | page d'aide de cette appliance, ou onglet Metrics d'un équipement | `TELEMETRY_QUERIES` |
| Champs FI (`Version`, `OutOfBandIpAddress`) et châssis (`OperState`) | API Reference Intersight | `src/collector.js`, section 7 |

Si un de ces points est faux, l'item « API: last errors » affiche l'appel en cause avec le code HTTP. Les items concernés restent simplement vides.

## Limites connues

- **Jointure** : la télémétrie est rattachée à l'inventaire par `host.id`, « a globally unique host ID », qui est le chemin API de la ressource (doc Cisco DevNet, « Host Power and Status »). Son dernier segment est le `Moid` de l'équipement : deux équipements de même nom sont donc bien distingués. Observé sur une appliance pendant la conception, pour `hw.host` et `hw.power_supply` seulement.
  - **Repli par nom** : une autre installation peut ne pas renvoyer `host.id`. Une ligne sans `host.id` (absent ou vide) est rattachée par classe (`host.type`) et nom (`host.name`), ou par nom seul si `host.type` est inconnu. Cisco précise que `host.name` n'est pas garanti unique : si ce nom est porté par plusieurs équipements (de la même classe, ou de n'importe quelle classe quand `host.type` est inconnu), la ligne est ignorée. Ces homonymes ne reçoivent alors pas cette télémétrie, plutôt que des valeurs mélangées.
- **20 000 objets par liste** : le collecteur lit au plus 20 000 objets par liste (serveurs, châssis, FI, alarmes), par pages de 1 000 triées par `Moid`. Si la dernière page lue est pleine, « API: last errors » affiche `<chemin de l'API>: list truncated at 20000 objects`. Les objets lus restent supervisés, mais les suivants (dans l'ordre des `Moid`) ne sont pas découverts : les hôtes qui existaient déjà sont traités comme ressources perdues, et les alarmes au-delà de la limite ne sont pas reflétées. Une liste d'exactement 20 000 objets est aussi signalée : sans requête supplémentaire, elle ne peut pas être distinguée d'une liste plus longue.
- **Double comptage possible** : si la puissance châssis inclut celle des blades, les totaux « Chassis » et « Servers » ne doivent pas être additionnés. Les totaux sont volontairement séparés par classe.
- **Énergie** : `Energy: last 24h` est calculée comme puissance moyenne sur 24 h × 24, en Wh. C'est exact sur une fenêtre glissante, à condition d'avoir 24 h d'historique. Le coût et le CO₂ divisent ces Wh par 1000, car les macros sont exprimées par kWh.
- **Historique du script maître** : il est à 0 (le JSON peut être gros). Pour déboguer, utiliser le bouton « Test ».
- **Taille de `intersight.raw`** : cet item Text est stocké en base (1 h d'historique). Zabbix tronque une valeur Text avant de la stocker : 65 536 octets en MySQL, 65 536 caractères en PostgreSQL (doc Zabbix 7.0, « Creating an item », « Text data limits ») ; une colonne `TEXT` MySQL contient au plus 65 535 octets (doc MySQL 8.0, « String Data Type Syntax »). L'item « API: largest pushed value » du template parent donne la taille, en octets UTF-8, du plus gros JSON poussé, et « API: device of the largest pushed value » le Moid de son équipement (hôte `intersight-<Moid>`). Un trigger WARNING se déclenche au-delà de `{$INTERSIGHT.RAW.SIZE.WARN}` (50 000 octets par défaut). Une taille en octets n'est jamais inférieure au nombre de caractères : le même seuil vaut pour les deux bases. Non vérifié : si les items dépendants reçoivent la valeur avant ou après cette troncature.
- **Température** : les triggers comparent chaque capteur à **ses propres** seuils (`limit_high_critical`, `limit_high_degraded`), sur les équipements qui les remontent. Les températures CPU ne remontent que si l'hôte est allumé.
- **Alarme disparue sans Cleared** : si une alarme disparaît d'Intersight sans passer par Cleared, son problème se ferme après `{$INTERSIGHT.ALARM.NODATA}` (2 h par défaut) grâce à `nodata()`. Ses items sont ensuite désactivés puis supprimés par la découverte (`{$INTERSIGHT.ALARM.LOST.DISABLE}`, `{$INTERSIGHT.ALARM.LOST.DELETE}`). Un collecteur en panne pendant cette durée ferme aussi les problèmes d'alarme ; ils se rouvrent au retour des données.
- **Trigger d'alarme indéterminé** : si l'item d'acquittement ou de suppression d'une alarme devient non supporté, son trigger peut devenir indéterminé, car l'expression lit ces items (pour les données opérationnelles).
- **Puissance châssis IMM** : c'est la somme de la puissance absorbée par les PSU (`hw.power`), Cisco ne remontant pas `hw.host.power` pour ces châssis.

## Données obtenues

- **Par équipement** : puissance moyenne et pic, état d'alimentation, énergie sur 24 h, température max, ventilateurs min/max, PSU (LLD : utilisation et sortie), ports (LLD filtrable), alarmes critiques et warning, modèle, numéro de série, firmware, IP de management. Les champs d'inventaire Zabbix sont remplis automatiquement.
- **Par type** (LLD sur les modèles, groupe `Intersight/<Classe>/<Modèle>`) : somme, moyenne, min, max, nombre d'équipements, énergie, coût, CO₂, température max.
- **Par classe** : puissance totale, énergie, coût et CO₂ sur 24 h.
- **Alarmes** : un problème Zabbix par alarme Intersight, sur l'hôte de son équipement (ou sur l'hôte parent pour les alarmes de la plateforme), fermé quand l'alarme passe à Cleared.
- **Santé** : appels, erreurs, durée, valeurs poussées et rejetées, taille du plus gros JSON poussé, absence de données, alarmes globales.

## Performance de la signature hs2019

L'ECDSA en JavaScript pur est coûteux dans l'interpréteur Duktape. Un cycle demande au moins 13 signatures (4 listes + 9 requêtes de télémétrie), plus une par page supplémentaire. La mesure est l'item **« API: signing time (hs2019) »**. Un trigger se déclenche quand la durée du cycle (« API: run duration ») est au-delà de 90 s sur 3 cycles consécutifs (timeout de l'item : 120 s). Le cas échéant, l'intervalle ou le timeout de l'item est à augmenter.

## Licence

Ce projet est distribué sous la **GNU Affero General Public License, version 3 uniquement** (`AGPL-3.0-only`), comme Zabbix : texte complet dans [LICENSE](LICENSE). Il peut être utilisé, modifié et redistribué ; quiconque distribue une version modifiée, ou la fait utiliser par d'autres à travers un réseau, doit en publier le code source sous la même licence.

La documentation Cisco utilisée pour construire le catalogue des métriques n'est pas incluse et n'est pas couverte par cette licence.
