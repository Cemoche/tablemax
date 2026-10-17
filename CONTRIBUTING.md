# Contributing to TableMax

[Français](#français) · [English](#english)

Rules for Claude agents: [`CLAUDE.md`](CLAUDE.md) (plus `src/CLAUDE.md` and `src-tauri/CLAUDE.md`).
Design: [`docs/superpowers/specs/2026-10-16-tablemax-design.md`](docs/superpowers/specs/2026-10-16-tablemax-design.md).

---

## Français

### Prérequis (Ubuntu)

- Paquets système Tauri et outils des tests :
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
    libssl-dev libayatana-appindicator3-dev librsvg2-dev jq openssl openssh-client sqlite3
  ```
- Node 22, pnpm 10 (`npm install -g pnpm@10`), Rust ≥ 1.96 (via [rustup](https://rustup.rs),
  puis `rustup update stable`), Docker avec `docker compose` v2,
  [`gh`](https://github.com/cli/cli#installation), Claude Code (`claude`).
- Contrôle : `node --version; pnpm --version; rustc --version; docker compose version; jq --version; gh --version`.

### Installation (une fois)

```bash
gh auth login                       # votre propre compte GitHub
gh repo clone Cemoche/tablemax && cd tablemax
pnpm install
claude plugin install superpowers@claude-plugins-official   # recommandé, portée utilisateur
pnpm test && pnpm lint && pnpm test:rust   # tout doit être vert
```

N'utilisez pas `--scope project` pour le plugin : il écrit `.claude/settings.json`, fichier
versionné qui n'existe pas encore. Réglages personnels non versionnés : `CLAUDE.local.md`,
`.claude/settings.local.json`.

### Flux de travail (manuel pour l'instant)

1. Choisir une issue ouverte **sans assigné**.
2. La prendre avant d'écrire du code : `gh issue edit <n> --add-assignee @me`, puis
   `gh issue view <n>` pour vérifier que personne d'autre ne l'a prise. L'assignation est
   la seule prise de ticket (pas encore de labels de statut).
3. Une branche par issue, `issue-<n>-<slug>`, depuis `origin/main` à jour, de préférence
   dans un worktree :
   `git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main`
   (`.worktrees/` est ignoré par git), ou `claude --worktree issue-<n>` puis
   `git branch -m issue-<n>-<slug>`.
4. Travailler, committer au format `<emoji> <type>(<scope>): <description>` (voir
   `CLAUDE.md`), et passer `pnpm test && pnpm lint` (+ `pnpm test:rust` si le backend change).
5. Pousser sa branche (`git push -u origin issue-<n>-<slug>`) et ouvrir la PR vers `main`
   (`gh pr create --base main`) avec le modèle de PR et `Closes #<n>`.
6. Un coéquipier relit la PR ; **le propriétaire du dépôt merge**.
7. Après le merge : `git worktree remove .worktrees/issue-<n>`.

Deux worktrees qui lancent `pnpm test:rust` en même temps : voir « Two worktrees side by
side » dans le [README](README.md#two-worktrees-side-by-side).

### Ce qu'on ne fait jamais

- Pousser ou committer sur `main` (tout passe par une PR).
- Prendre une issue déjà assignée, ou pousser sur la branche d'un autre.
- `git push --force` sur la branche de quelqu'un d'autre ; merger une PR (c'est le
  propriétaire qui merge).
- Committer un secret (jeton, mot de passe réel, clé privée).

Le dépôt est privé sur un compte gratuit : GitHub n'offre pas de protection de branche, et
aucun hook ni CI ne vérifie encore ces règles. Elles tiennent **uniquement par convention**.

### Ajouter une issue

**New issue** sur GitHub (ou `gh issue create --web`) et le formulaire **Task** ou **Bug**.

### Prévu, pas encore en place

Reporté avec la suite du plan `docs/superpowers/plans/2026-10-17-tablemax-team-setup.md` ;
**rien de ceci n'existe encore** : `.claude/settings.json` partagé (permissions, hooks qui
refusent l'édition sur `main`, plugin activé pour le projet), les skills `/pick-issue`,
`/work-issue`, `/ship` et `/plan-to-issues`, les labels (`type:*`, `status:*`, `area:*`…)
avec labels par défaut dans les formulaires, jalons et board, et la CI
`.github/workflows/ci.yml`.

---

## English

### Prerequisites (Ubuntu)

- Tauri system packages and test tools:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
    libssl-dev libayatana-appindicator3-dev librsvg2-dev jq openssl openssh-client sqlite3
  ```
- Node 22, pnpm 10 (`npm install -g pnpm@10`), Rust ≥ 1.96 (via [rustup](https://rustup.rs),
  then `rustup update stable`), Docker with `docker compose` v2,
  [`gh`](https://github.com/cli/cli#installation), Claude Code (`claude`).
- Check: `node --version; pnpm --version; rustc --version; docker compose version; jq --version; gh --version`.

### Setup (once)

```bash
gh auth login                       # your own GitHub account
gh repo clone Cemoche/tablemax && cd tablemax
pnpm install
claude plugin install superpowers@claude-plugins-official   # recommended, user scope
pnpm test && pnpm lint && pnpm test:rust   # all green
```

Do not install the plugin with `--scope project`: it writes `.claude/settings.json`, a
tracked file that does not exist yet. Personal, untracked settings: `CLAUDE.local.md`,
`.claude/settings.local.json`.

### Workflow (manual for now)

1. Choose an open issue **with no assignee**.
2. Claim it before writing code: `gh issue edit <n> --add-assignee @me`, then
   `gh issue view <n>` to check nobody else took it. The assignment is the only claim (no
   status labels yet).
3. One branch per issue, `issue-<n>-<slug>`, from an up-to-date `origin/main`, preferably
   in a worktree:
   `git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main`
   (`.worktrees/` is gitignored), or `claude --worktree issue-<n>` then
   `git branch -m issue-<n>-<slug>`.
4. Work, commit as `<emoji> <type>(<scope>): <description>` (see `CLAUDE.md`), and run
   `pnpm test && pnpm lint` (+ `pnpm test:rust` when the backend changes).
5. Push your branch (`git push -u origin issue-<n>-<slug>`) and open the PR to `main`
   (`gh pr create --base main`) with the PR template and `Closes #<n>`.
6. A teammate reviews the PR; **the repository owner merges**.
7. After the merge: `git worktree remove .worktrees/issue-<n>`.

Two worktrees running `pnpm test:rust` at the same time: see "Two worktrees side by side"
in the [README](README.md#two-worktrees-side-by-side).

### Never

- Push or commit to `main` (everything goes through a PR).
- Take an issue that already has an assignee, or push to someone else's branch.
- `git push --force` someone else's branch; merge a PR (the owner merges).
- Commit a secret (token, real password, private key).

The repository is private on a free plan: GitHub offers no branch protection, and no hook
or CI checks these rules yet. They hold **by convention only**.

### Adding an issue

**New issue** on GitHub (or `gh issue create --web`) and the **Task** or **Bug** form.

### Planned, not set up yet

Postponed with the rest of `docs/superpowers/plans/2026-10-17-tablemax-team-setup.md`;
**none of this exists yet**: a shared `.claude/settings.json` (permissions, hooks refusing
edits on `main`, plugin enabled for the project), the `/pick-issue`, `/work-issue`, `/ship`
and `/plan-to-issues` skills, labels (`type:*`, `status:*`, `area:*`…) with default labels
in the issue forms, milestones and a board, and the CI `.github/workflows/ci.yml`.
