This guide is available in: English | [Français](DEVCONTAINER_SECURITE_FR.md)

# Setting up your machine for the devcontainer

The devcontainer of this repository (`.devcontainer/`) isolates Claude Code and the tests: outbound firewall, no `sudo`, read-only `.git`, etc. (see the section "Development environment" of the [README](../README.md)).

**Part of the protection cannot be set from the repository: it depends on your machine.** VS Code (Dev Containers extension) indeed opens a channel between the container and your machine. This guide explains how to neutralize it, then how to check that it is done.

During design, the steps were checked on **Windows 11 with Docker Desktop, VS Code and Git for Windows**, with the Dev Containers extension 0.475.0. On macOS or Linux, the principle is the same, but the commands of section 1 are different and were not checked.

## Why this is necessary

The Dev Containers extension drops a relay script in the container, `/tmp/vscode-remote-containers-<id>.js`. This script queries the git credential manager **of your machine**, through the `REMOTE_CONTAINERS_IPC` channel.

Since the firewall allows GitHub, a program in the container can, through this relay:

- **obtain your GitHub token**, then push to any of your repositories or read your private repositories (observed during design: the relay returned the stored username and password);
- **make a real GitHub sign-in window appear on your machine** (observed during design: once the credential was deleted, a request from the container opened this window). If you sign in there, the new token goes back to the container.

The VS Code setting `"dev.containers.gitCredentialHelperConfigLocation": "none"` **is not enough**. It only removes the `credential.helper` line from the git config of the container, and the log shows "Git credential helper not enabled". Yet the relay script keeps answering.

## 1. On your machine (once)

### 1.1 No GitHub HTTPS credential in the credential manager

On Windows (PowerShell):

```powershell
cmdkey /list | Select-String -Pattern github -Context 0,3
```

Delete the entry whose target contains `git:https://github.com`, copying the **exact** name shown:

```powershell
cmdkey /delete:<exact name of the target>
```

The other GitHub entries (for example `gh:github.com:…`, used by GitHub CLI) were not returned by the relay during the design tests. Section 2 lets you check this on your machine.

### 1.2 No Git Credential Manager sign-in window

```powershell
git config --global credential.interactive false
git config --show-origin --get credential.interactive   # expected: false
```

With the value `false`, Git Credential Manager no longer shows any window, and returns an error if an interaction would be needed ([GCM documentation](https://github.com/GitCredentialManager/git-credential-manager/blob/main/docs/configuration.md)). Git operations over HTTPS to GitHub will therefore fail. This is the reason for the next step.

### 1.3 Push over SSH, with a passphrase and without an SSH agent

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519_github"
```

1. Choose a **passphrase** when `ssh-keygen` asks for it.
2. Add the public key (the `.pub` file) in GitHub, under Settings > SSH and GPG keys.
3. Declare the key for github.com in `~/.ssh/config`:

```
Host github.com
    IdentityFile ~/.ssh/id_ed25519_github
```

4. Switch the repository to SSH:

```powershell
git remote set-url origin git@github.com:<owner>/<repository>.git
```

5. Disable and stop the Windows SSH agent, then check it. This needs a PowerShell window started with "Run as administrator" ([Microsoft doc, "Set-Service"](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-service?view=powershell-5.1)):

```powershell
Set-Service -Name ssh-agent -StartupType Disabled
Set-Service -Name ssh-agent -Status Stopped
Get-Service ssh-agent | Select-Object Name, Status, StartType   # expected: Stopped, Disabled
```

**No SSH agent while the container is running**: Dev Containers automatically forwards a running SSH agent to the container ([VS Code documentation](https://code.visualstudio.com/remote/advancedcontainers/sharing-git-credentials)). Without an agent, your passphrase will be asked for at each push, and the key stays on your machine.

### 1.4 GitHub CLI (`gh`), if you use it

- **Never run `gh auth setup-git`.** This command would make `gh` the credential helper of git, and its token (usually `repo`, `workflow`, `gist`) would become reachable through the relay.
- **Check that no config level declares it.** `gh auth setup-git` writes it under a URL-specific key (`credential.https://github.com.helper`): all the `credential.*.helper` keys must therefore be listed, not only `credential.helper`:

```powershell
git config --show-origin --get-regexp '^credential\..*helper$'   # expected: no "gh auth git-credential" line
```

- **Align `gh` on SSH:** `gh config set git_protocol ssh`.

### 1.5 VS Code setting (complement)

In your **user** settings (F1 > "Preferences: Open User Settings (JSON)"):

```json
"dev.containers.gitCredentialHelperConfigLocation": "none"
```

This setting is not a protection on its own (see above), but it prevents git from using the relay without your knowledge. It has the `machine` scope: it therefore cannot be set from the repository.

### 1.6 Revoke the old token

Your GitHub token may already have been reachable from a container before these settings. As a precaution, revoke it:

- OAuth token of Git Credential Manager: GitHub > Settings > Applications > Authorized OAuth Apps > Git Credential Manager > Revoke;
- personal access token (PAT): GitHub > Settings > Developer settings.

## 2. Check, in the container

After "Rebuild Container", in the terminal of the container:

```bash
bash .devcontainer/check-host-credentials.sh
```

The script asks the relay for a github.com credential, and only tells whether an answer came back. It never prints the credential. Exit code: 0 = no credential, 1 = a credential came back, 2 = check impossible.

| Result | Meaning |
|---|---|
| `OK: no GitHub credential from the host` | the relay gives nothing |
| `DANGER: … returns a GitHub credential from the host` | a credential remains: go back to section 1.1 |
| `UNVERIFIED: …` | the relay did not answer (timeout, error): **nothing is proven**. Run the script again; if the message persists, check section 1 by hand |
| A sign-in window opens on your machine | close it **without signing in**, then go back to section 1.2 |

Run this script again after each change to your git config or to `gh`.

Other useful checks:

```bash
touch .devcontainer/x .git/x .vscode/x   # expected: "Read-only file system" 3 times
echo $CLAUDE_CONFIG_DIR                  # expected: /home/vscode/.claude
```

In the log of the container, you must see, in this order: "Firewall ready", then "Firewall ready for this container start", then the tests.

## 3. Good practices

- **Git is read-only in the container.** Claude Code edits the files; you review the diff, then you commit and push from your machine.
- **Do not run on your machine a script of the repository that was modified in the container** without having reviewed the diff: the rest of the repository remains writable from the container, by design.
- **Do not publish the VS Code logs as they are** (Dev Containers, `shutdownMonitor`) in an issue or a PR. They contain your username, the name of your machine, your paths and all the environment variables of your machine.
- **Known limitations, with no fix in the repository:**
  - a DNS tunnel remains possible through the resolver;
  - the firewall opens all of GitHub, not only this repository;
  - the allowed IP addresses are computed at start: restart the container if a service changes address.
