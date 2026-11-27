Ce guide est disponible en : [English](DEVCONTAINER_SECURITY.md) | Français

# Configurer sa machine pour le devcontainer

Le devcontainer de ce dépôt (`.devcontainer/`) isole Claude Code et les tests : pare-feu sortant, pas de `sudo`, `.git` en lecture seule, etc. (voir la section « Environnement de développement » du [README](../README-fr.md)).

**Une partie de la protection ne peut pas être réglée depuis le dépôt : elle dépend de votre machine.** VS Code (extension Dev Containers) ouvre en effet un canal entre le conteneur et votre machine. Ce guide explique comment le neutraliser, puis comment vérifier que c'est fait.

Pendant la conception, les étapes ont été vérifiées sur **Windows 11 avec Docker Desktop, VS Code et Git for Windows**, avec l'extension Dev Containers 0.475.0. Sur macOS ou Linux, le principe est le même, mais les commandes de la section 1 sont différentes et n'ont pas été vérifiées.

## Pourquoi c'est nécessaire

L'extension Dev Containers dépose dans le conteneur un script de relais, `/tmp/vscode-remote-containers-<id>.js`. Ce script interroge le gestionnaire d'identifiants git **de votre machine**, par le canal `REMOTE_CONTAINERS_IPC`.

Comme le pare-feu autorise GitHub, un programme du conteneur peut, par ce relais :

- **obtenir votre jeton GitHub**, puis pousser vers n'importe lequel de vos dépôts ou lire vos dépôts privés (observé pendant la conception : le relais a renvoyé l'identifiant et le mot de passe stockés) ;
- **faire apparaître une vraie fenêtre de connexion GitHub sur votre machine** (observé pendant la conception : une fois l'identifiant supprimé, une demande partie du conteneur a ouvert cette fenêtre). Si vous vous y connectez, le nouveau jeton repart vers le conteneur.

Le réglage VS Code `"dev.containers.gitCredentialHelperConfigLocation": "none"` **ne suffit pas**. Il retire seulement la ligne `credential.helper` de la config git du conteneur, et le journal affiche « Git credential helper not enabled ». Pourtant, le script de relais continue de répondre.

## 1. Sur votre machine (une fois)

### 1.1 Aucun identifiant HTTPS GitHub dans le gestionnaire d'identifiants

Sous Windows (PowerShell) :

```powershell
cmdkey /list | Select-String -Pattern github -Context 0,3
```

Supprimez l'entrée dont la cible contient `git:https://github.com`, en recopiant le nom **exact** affiché :

```powershell
cmdkey /delete:<nom exact de la cible>
```

Les autres entrées GitHub (par exemple `gh:github.com:…`, utilisée par GitHub CLI) n'ont pas été renvoyées par le relais lors des tests de conception. La section 2 permet de le vérifier sur votre machine.

### 1.2 Pas de fenêtre de connexion de Git Credential Manager

```powershell
git config --global credential.interactive false
git config --show-origin --get credential.interactive   # attendu : false
```

Avec la valeur `false`, Git Credential Manager n'affiche plus aucune fenêtre, et renvoie une erreur si une interaction serait nécessaire ([documentation de GCM](https://github.com/GitCredentialManager/git-credential-manager/blob/main/docs/configuration.md)). Les opérations git en HTTPS vers GitHub échoueront donc. C'est la raison de l'étape suivante.

### 1.3 Pousser en SSH, avec une phrase de passe et sans agent SSH

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519_github"
```

1. Choisissez une **phrase de passe** quand `ssh-keygen` la demande.
2. Ajoutez la clé publique (le fichier `.pub`) dans GitHub, sous Settings > SSH and GPG keys.
3. Déclarez la clé pour github.com dans `~/.ssh/config` :

```
Host github.com
    IdentityFile ~/.ssh/id_ed25519_github
```

4. Passez le dépôt en SSH :

```powershell
git remote set-url origin git@github.com:<propriétaire>/<dépôt>.git
```

5. Vérifiez que l'agent SSH de Windows est arrêté :

```powershell
Get-Service ssh-agent | Select-Object Name, Status, StartType   # attendu : Stopped, Disabled
```

**Pas d'agent SSH pendant que le conteneur tourne** : Dev Containers transmet automatiquement un agent SSH en marche au conteneur ([documentation VS Code](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials)). Sans agent, votre phrase de passe vous sera demandée à chaque push, et la clé reste sur votre machine.

### 1.4 GitHub CLI (`gh`), si vous l'utilisez

- **Ne lancez jamais `gh auth setup-git`.** Cette commande ferait de `gh` l'assistant d'identifiants de git, et son jeton (en général `repo`, `workflow`, `gist`) deviendrait accessible par le relais.
- **Vérifiez qu'aucun niveau de config ne le déclare.** `gh auth setup-git` l'inscrit sous une clé propre à l'URL (`credential.https://github.com.helper`) : il faut donc lister toutes les clés `credential.*.helper`, pas seulement `credential.helper` :

```powershell
git config --show-origin --get-regexp '^credential\..*helper$'   # attendu : aucune ligne "gh auth git-credential"
```

- **Alignez `gh` sur SSH :** `gh config set git_protocol ssh`.

### 1.5 Réglage VS Code (complément)

Dans vos réglages **utilisateur** (F1 > « Preferences: Open User Settings (JSON) ») :

```json
"dev.containers.gitCredentialHelperConfigLocation": "none"
```

Ce réglage n'est pas une protection à lui seul (voir plus haut), mais il évite que git utilise le relais sans que vous le sachiez. Il a la portée `machine` : il ne peut donc pas être fixé depuis le dépôt.

### 1.6 Révoquer l'ancien jeton

Votre jeton GitHub a peut-être déjà été accessible depuis un conteneur avant ces réglages. Par précaution, révoquez-le :

- jeton OAuth de Git Credential Manager : GitHub > Settings > Applications > Authorized OAuth Apps > Git Credential Manager > Revoke ;
- jeton personnel (PAT) : GitHub > Settings > Developer settings.

## 2. Vérifier, dans le conteneur

Après « Rebuild Container », dans le terminal du conteneur :

```bash
bash .devcontainer/check-host-credentials.sh
```

Le script demande un identifiant github.com au relais, et indique seulement si une réponse est revenue. Il n'affiche jamais l'identifiant. Code de sortie : 0 = aucun identifiant, 1 = un identifiant est revenu, 2 = vérification impossible.

| Résultat | Signification |
|---|---|
| `OK: no GitHub credential from the host` | le relais ne donne rien |
| `DANGER: … returns a GitHub credential from the host` | il reste un identifiant : reprenez la section 1.1 |
| `UNVERIFIED: …` | le relais n'a pas répondu (délai, erreur) : **rien n'est prouvé**. Relancez le script ; si le message persiste, vérifiez la section 1 à la main |
| Une fenêtre de connexion s'ouvre sur votre machine | fermez-la **sans vous connecter**, puis reprenez la section 1.2 |

Relancez ce script après chaque changement de votre config git ou de `gh`.

Autres vérifications utiles :

```bash
touch .devcontainer/x .git/x .vscode/x   # attendu : "Read-only file system" 3 fois
echo $CLAUDE_CONFIG_DIR                  # attendu : /home/vscode/.claude
```

Dans le journal du conteneur, vous devez voir, dans cet ordre : « Firewall ready », puis « Firewall ready for this container start », puis les tests.

## 3. Bonnes pratiques

- **Git est en lecture seule dans le conteneur.** Claude Code modifie les fichiers ; vous relisez le diff, puis vous commitez et poussez depuis votre machine.
- **N'exécutez pas sur votre machine un script du dépôt modifié dans le conteneur** sans avoir relu le diff : le reste du dépôt reste modifiable depuis le conteneur, par conception.
- **Ne publiez pas tels quels les journaux de VS Code** (Dev Containers, `shutdownMonitor`) dans une issue ou une PR. Ils contiennent votre nom d'utilisateur, le nom de votre machine, vos chemins et toutes les variables d'environnement de votre machine.
- **Limites connues, sans correctif dans le dépôt :**
  - un tunnel DNS reste possible à travers le résolveur ;
  - le pare-feu ouvre tout GitHub, pas seulement ce dépôt ;
  - les adresses IP autorisées sont calculées au démarrage : redémarrez le conteneur si un service change d'adresse.
