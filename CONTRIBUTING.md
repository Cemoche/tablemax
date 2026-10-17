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
claude plugin install superpowers@claude-plugins-official --scope project
pnpm test && pnpm lint && pnpm test:rust   # tout doit être vert
```

Réglages personnels non versionnés : `CLAUDE.local.md`, `.claude/settings.local.json`.

### Flux de travail

1. Choisir une issue ouverte `status:ready` **sans assigné**.
2. La prendre : `/pick-issue` dans Claude (dans le clone principal), ou à la main
   `gh issue edit <n> --add-assignee @me --add-label status:in-progress --remove-label status:ready`.
3. Ouvrir son worktree : `claude --worktree issue-<n>` (crée `.claude/worktrees/issue-<n>/`
   depuis un `origin/main` à jour).
4. Dans cette session : `/work-issue <n>` (branche `issue-<n>-<slug>`, lecture de l'issue et
   du plan, travail, tests).
5. `/ship` : vérifie, pousse la branche, ouvre la PR vers `main` (`Closes #<n>`), passe
   l'issue en `status:review`.
6. Un coéquipier relit la PR ; **le propriétaire du dépôt merge**.
7. Après le merge : `git worktree remove .claude/worktrees/issue-<n>`.

Deux worktrees qui lancent `pnpm test:rust` en même temps : voir « Two worktrees side by
side » dans le [README](README.md#two-worktrees-side-by-side).

### Ce qu'on ne fait jamais

- Pousser ou committer sur `main` (tout passe par une PR).
- Prendre une issue déjà assignée, ou pousser sur la branche d'un autre.
- `git push --force` sur la branche de quelqu'un d'autre ; merger sa propre PR.
- Committer un secret (jeton, mot de passe réel, clé privée).

Le dépôt est privé sur un compte gratuit : GitHub n'offre pas de protection de branche.
Ces règles tiennent par convention, par les hooks de `.claude/settings.json` (édition
refusée sur `main`) et par la CI.

### Ajouter une issue

- Depuis un plan : `/plan-to-issues docs/superpowers/plans/<plan>.md --dry-run`, puis sans
  `--dry-run` (une issue par `### Task N`).
- Sinon : **New issue** sur GitHub (ou `gh issue create --web`) et le formulaire **Task**
  ou **Bug**. Les tâches arrivent en `status:ready`, les bugs en `status:triage`.

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
claude plugin install superpowers@claude-plugins-official --scope project
pnpm test && pnpm lint && pnpm test:rust   # all green
```

Personal, untracked settings: `CLAUDE.local.md`, `.claude/settings.local.json`.

### Workflow

1. Choose an open `status:ready` issue **with no assignee**.
2. Take it: `/pick-issue` in Claude (from the main checkout), or by hand
   `gh issue edit <n> --add-assignee @me --add-label status:in-progress --remove-label status:ready`.
3. Open its worktree: `claude --worktree issue-<n>` (creates `.claude/worktrees/issue-<n>/`
   from a fresh `origin/main`).
4. In that session: `/work-issue <n>` (branch `issue-<n>-<slug>`, reads the issue and the
   plan, does the work, runs the tests).
5. `/ship`: checks, pushes the branch, opens the PR to `main` (`Closes #<n>`), moves the
   issue to `status:review`.
6. A teammate reviews the PR; **the repository owner merges**.
7. After the merge: `git worktree remove .claude/worktrees/issue-<n>`.

Two worktrees running `pnpm test:rust` at the same time: see "Two worktrees side by side"
in the [README](README.md#two-worktrees-side-by-side).

### Never

- Push or commit to `main` (everything goes through a PR).
- Take an issue that already has an assignee, or push to someone else's branch.
- `git push --force` someone else's branch; merge your own PR.
- Commit a secret (token, real password, private key).

The repository is private on a free plan: GitHub offers no branch protection. These rules
hold by convention, by the hooks in `.claude/settings.json` (edits refused on `main`) and
by CI.

### Adding an issue

- From a plan: `/plan-to-issues docs/superpowers/plans/<plan>.md --dry-run`, then without
  `--dry-run` (one issue per `### Task N`).
- Otherwise: **New issue** on GitHub (or `gh issue create --web`) and the **Task** or
  **Bug** form. Tasks start as `status:ready`, bugs as `status:triage`.
