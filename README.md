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
| `tools/ci.sh` | Lance en local toutes les vérifications de la CI GitHub |
| `.devcontainer/` | Bac à sable de développement : conteneur, pare-feu sortant, mêmes versions que la CI |
| `docs/intersight_metrics.json` | Catalogue des métriques Intersight (instruments, champs Druid, équipements supportés) |
| `tools/build_metrics_catalog.py` | Reconstruit ce catalogue depuis les pages « Supported Metrics » |
| `tools/check_metrics_against_doc.py` | Vérifie les métriques utilisées contre la doc « Supported Metrics » de ton appliance |
| `tests/` | Tests Node.js sans dépendance : ECDSA (vecteur RFC 6979 + OpenSSL), modes d'auth, scénarios |
| `docs/UPGRADE_7.4_FR.md` | Variante Zabbix 7.4 (blades découverts sous leur châssis) |
| `SECURITY.md` | Signaler une vulnérabilité (signalement privé GitHub) et périmètre |
| `docs/DEVCONTAINER_SECURITE_FR.md` | Configurer sa machine pour le devcontainer (identifiants git, SSH, vérifications) |
| `CLAUDE.md` | Contexte du projet pour Claude Code (décisions, faits vérifiés, points ouverts) |

## Développement

```bash
node tests/run_all.js                  # tous les tests (Node.js 16+)
python3 tools/generate_templates.py    # après toute modification de src/collector.js (PyYAML)
python3 tools/check_metrics_against_doc.py Supported_Metrices.md
tools/ci.sh                            # toutes les vérifications de la CI, avant chaque commit
```

Le YAML est généré : **ne pas l'éditer à la main**. Il embarque une copie de `src/collector.js` sans commentaires, car Zabbix limite les scripts à 65 535 caractères. Il faut modifier `src/collector.js` ou `tools/generate_templates.py`, puis régénérer. La CI vérifie que le template commité correspond au script, que le code reste en ES5, et que tous les tests passent. Les UUID sont dérivés des noms, donc stables d'une génération à l'autre.

### Environnement de développement (bac à sable)

Le dépôt fournit un devcontainer (`.devcontainer/`) : Ubuntu 24.04 avec Node 20, Python 3.12 et PyYAML 6.0.4, les mêmes versions que la CI, plus l'extension Claude Code.

**Avant la première ouverture, configure ta machine en suivant [docs/DEVCONTAINER_SECURITE_FR.md](docs/DEVCONTAINER_SECURITE_FR.md)** : une partie de l'isolation (identifiants git, agent SSH) ne peut pas être réglée depuis le dépôt.

- **Prérequis** : VS Code avec l'extension Dev Containers, et un moteur Docker. Sous Windows, le plus simple sans licence est Docker Engine installé dans une distribution WSL ; Docker Desktop est payant dans les entreprises de plus de 250 salariés ou de plus de 10 M$ de chiffre d'affaires.
- **Ouverture** : commande « Dev Containers: Reopen in Container ». À chaque démarrage, le pare-feu est appliqué en premier, par le point d'entrée de l'image (`.devcontainer/intersight-entrypoint.sh`) : s'il échoue, le conteneur s'arrête et VS Code ne peut pas s'y connecter. Ensuite, `postStartCommand` attend que le pare-feu de ce démarrage soit complet (un marqueur écrit par root, propre à chaque démarrage, `.devcontainer/intersight-wait-for-firewall.sh`), puis lance les tests et le validateur. Le pare-feu est limité à 45 s (arrêt forcé 5 s plus tard), en dessous des 60 s d'attente : un démarrage bloqué (DNS, GitHub) arrête le conteneur au lieu de laisser VS Code se connecter trop tôt. Ensuite : si l'environnement est cassé, tu le sais tout de suite. VS Code et ses extensions, dont Claude Code, attendent la fin de `postStartCommand` (`waitFor`).
- **Pare-feu sortant** : tout est bloqué sauf Claude Code (`api.anthropic.com`, et `platform.claude.com` + `claude.ai` pour la connexion et le renouvellement des jetons, d'après la [documentation réseau de Claude Code](https://code.claude.com/docs/en/network-config)), et GitHub, en IPv4 comme en IPv6. Si IPv6 ne peut pas être filtré, il doit être désactivé sur chaque interface (et pour les futures interfaces), sinon le conteneur ne démarre pas. Il se ferme en cas d'échec, à deux niveaux : le blocage est posé avant toute autre règle, et toute erreur arrête le conteneur. Ni la machine hôte ni la passerelle du conteneur ne sont joignables : Docker y publie aussi les ports des autres conteneurs. VS Code passe par `docker exec`, pas par le réseau. Il n'y a aucun `sudo` dans le conteneur : rien de ce qui y tourne, Claude Code compris, ne peut lever les règles ni ajouter une destination. Le point d'entrée et le pare-feu, lancés en root, n'utilisent que les commandes des dossiers système (`/usr/sbin`, `/usr/bin`, `/sbin`, `/bin`), jamais celles d'un dossier modifiable par `vscode` comme celui de Node (`/usr/local/share/nvm`). Pour réappliquer le pare-feu, redémarre le conteneur. Pour installer un outil, il faut l'ajouter au `Dockerfile` et reconstruire. Les tests `tests/firewall_script.test.js` vérifient ces points.
- **Accès à l'appliance Intersight** (HTTPS uniquement) : définis `INTERSIGHT_APPLIANCE_HOST` dans l'environnement où VS Code est lancé, avant de créer le conteneur (un changement demande « Rebuild Container »). Le script la lit dans l'environnement du conteneur, fixé à sa création. Sans cette variable, l'appliance est injoignable depuis le conteneur. Si son nom ne se résout pas, le conteneur démarre quand même, avec un avertissement. Les tests n'en ont pas besoin : tous les appels sont simulés.
- **Si une connexion légitime est bloquée** (par exemple pour la connexion de Claude Code), ajoute le domaine à `ALLOWED_DOMAINS` dans `.devcontainer/intersight-init-firewall.sh`.
- **Fichiers exécutés par ta machine, en lecture seule dans le conteneur** : `.devcontainer/` (dont `initializeCommand`, lancé sur l'hôte), `.git/` en entier (hooks et config utilisés par `git am`, `git push` ou VS Code sur l'hôte ; protéger seulement `.git/config` et `.git/hooks` ne suffit pas, un simple fichier `.git/commondir` redirige git vers une autre config) et `.vscode/` (réglages et tâches quand le dossier est rouvert en local). Rien de ce qui tourne dans le conteneur, Claude Code compris, ne peut donc lancer de commande sur ta machine par ce biais. Conséquences : dans le conteneur, git sert à lire (`git status`, `git diff`, `git log`) ; Claude Code modifie les fichiers, et tu commites et pousses depuis ta machine, après relecture. Modifie `.devcontainer/` et `.vscode/` depuis ta machine aussi. Le clone doit être un dépôt classique (`.git` dossier, pas un worktree), et `.vscode/` doit exister : seul `.vscode/extensions.json` est versionné.
- **VS Code** : le conteneur ne joint aucun serveur de VS Code. Le serveur VS Code est copié depuis ta machine, et les extensions sont téléchargées sur ta machine puis copiées dans le conteneur (`downloadExtensionsLocally` dans le journal) : aucune action nécessaire.
- **Adresses IP figées au démarrage** : la liste autorisée est calculée une fois, au démarrage. Si un service change d'adresse ensuite (CDN), ses nouvelles connexions échouent jusqu'au prochain redémarrage du conteneur. C'est voulu : aucun processus root ne reste actif pour modifier les règles.
- **Identifiants git de ta machine : aucun identifiant HTTPS GitHub sur l'hôte (obligatoire)**. Dev Containers ouvre un canal entre le conteneur et ta machine (`REMOTE_CONTAINERS_IPC`) et y dépose un script de relais (`/tmp/vscode-remote-containers-<id>.js`) qui interroge le gestionnaire d'identifiants de ta machine. Comme GitHub est autorisé, un agent manipulé pourrait obtenir ton jeton et pousser vers n'importe lequel de tes dépôts. **Le réglage `"dev.containers.gitCredentialHelperConfigLocation": "none"` ne suffit pas** : il retire seulement le `credential.helper` de la config git, mais le script répond toujours (testé : il renvoie l'identifiant et le mot de passe stockés). La seule protection sûre : ne garder **aucun** identifiant `https://github.com` dans le gestionnaire d'identifiants de ta machine, et pousser depuis l'hôte en SSH avec une clé protégée par une phrase de passe, **sans agent SSH** (Dev Containers transmet automatiquement un agent qui tourne, y compris celui de Windows). Désactive aussi les fenêtres de connexion du gestionnaire d'identifiants de Windows (Git Credential Manager) : `git config --global credential.interactive false`. Sans ce réglage, une demande partie du conteneur ouvre une fenêtre de connexion GitHub sur ta machine (constaté) : s'y connecter renverrait le jeton au conteneur. **N'accepte jamais une telle fenêtre pendant que le conteneur tourne.** Garde aussi le réglage `none`, qui évite que git l'utilise sans que tu le saches. Vérification, dans le conteneur : la commande de `.devcontainer/check-host-credentials.sh` doit afficher « no GitHub credential ».
- **Images et paquets épinglés** : l'image de base est fixée par son empreinte (`@sha256:` dans le `Dockerfile`) et PyYAML est installé avec ses empreintes PyPI (`.devcontainer/requirements-dev.txt`, `--require-hashes`, aussi dans la CI). Le conteneur tourne avec `no-new-privileges` : aucun programme ne peut gagner de droits (setuid). Pour mettre l'image à jour : `docker pull` du tag, vérification, puis remplacement de l'empreinte.
- **Claude Code** : sa configuration (`CLAUDE_CONFIG_DIR`, y compris le fichier `.claude.json`) et sa connexion sont dans un volume Docker : elles survivent à un « Rebuild Container ».
- **DNS** : les requêtes DNS (UDP et TCP) ne partent que vers les résolveurs du conteneur (`/etc/resolv.conf`, écrit par Docker), pas vers n'importe quel serveur. **Limite connue** : un résolveur récursif relaie des requêtes vers n'importe quel domaine, donc un tunnel DNS (données cachées dans des noms de domaine) reste possible ; seul un proxy DNS filtrant l'empêcherait. De même, les plages GitHub autorisées donnent accès à tout GitHub (autres dépôts, gists), pas seulement à ce dépôt.
- **À ne jamais commiter** : `params.json` (paramètres et clé privée pour `zabbix_js`) et le dossier `cisco-docs/` (pages Cisco du catalogue). Les deux sont dans le `.gitignore`.


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
| Énergie, coût, CO₂ | — | `Wh`, `!EUR`, `g` | calculés depuis la puissance |
| Durées de l'API (cycle, signature) | — | `s` | mesurées par le collecteur |

**Pourcentages : la doc Cisco indique `%`, mais Intersight stocke des ratios 0–1** (0,1 = 10 %). C'est vérifié dans les données brutes d'une appliance, et cohérent avec les tableaux de bord intersight-grafana, qui multiplient par 100. D'où `{$INTERSIGHT.PERCENT.SCALE}` = 100. Si une version future renvoyait des valeurs 0–100, il suffirait de passer la macro à 1.

**Contrôles à l'exécution**, signalés dans « API: last errors » (puis trigger après 3 cycles) :
- un pourcentage supérieur à 100 % après mise à l'échelle → valeurs déjà en pourcent, passer l'échelle à 1 ;
- un idle CPU ≤ 1 sur tous les FI avec l'échelle 1 → valeurs en 0–1, remettre l'échelle à 100.

**Unités de base uniquement** : toutes les valeurs sont stockées en unité de base (W, Wh, g, s, bit/s), jamais en kWh, kg ou ms. L'historique, Grafana et les bases de séries temporelles externes reçoivent donc la valeur brute, sans conversion à refaire. Zabbix n'ajoute les préfixes K/M/G (base 10) qu'à l'affichage, par exemple 1 500 Wh affichés « 1.5 KWh » (doc Zabbix 7.0, « Unit symbols », « Item value suffixes »). Le préfixe `!` empêche cet ajout ; il ne sert que pour `!rpm` et `!EUR`, où un préfixe n'aurait pas de sens.

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
- **Énergie** : `Energy: last 24h` est calculée comme puissance moyenne sur 24 h × 24, en Wh. C'est exact sur une fenêtre glissante, à condition d'avoir 24 h d'historique. Le coût et le CO₂ divisent ces Wh par 1000, car les macros sont exprimées par kWh.
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

## Licence

Ce projet est distribué sous la **GNU Affero General Public License, version 3 uniquement** (`AGPL-3.0-only`), comme Zabbix : texte complet dans [LICENSE](LICENSE). Tu peux l'utiliser, le modifier et le redistribuer ; si tu distribues une version modifiée, ou si tu la fais utiliser par d'autres à travers un réseau, tu dois en publier le code source sous la même licence.

La documentation Cisco utilisée pour construire le catalogue des métriques n'est pas incluse et n'est pas couverte par cette licence.
