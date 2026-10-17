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
- Node 22 (22.22 or newer), pnpm 10 (`npm install -g pnpm@10`), Rust ≥ 1.96 (via [rustup](https://rustup.rs),
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

Le plugin `superpowers` est activé par `.claude/settings.json` (versionné) mais chacun doit
l'installer une fois. Au premier lancement de `claude` dans le dépôt, acceptez de faire
confiance au dossier : les réglages, hooks et skills du projet s'appliquent alors. Réglages
personnels non versionnés : `CLAUDE.local.md`, `.claude/settings.local.json`.

### Flux de travail

Dans Claude Code, des skills font chaque étape ; les commandes `gh`/`git` équivalentes sont
dans `CLAUDE.md` (section Workflow) pour travailler sans Claude.

1. **`/pick-issue`** (ou `/pick-issue <n>`, `/pick-issue area:frontend`) : choisit une issue
   `status:ready` **sans assigné**, vous l'assigne, passe le label à `status:in-progress`,
   vérifie qu'un coéquipier ne l'a pas prise au même moment (sinon se retire) et poste un court
   commentaire « Taking this — plan: … ».
2. Ouvrir une session dans le worktree de l'issue : `claude --worktree issue-<n>` (ou
   `git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main`
   puis `claude` dans ce dossier). Le hook du projet refuse toute édition sur `main`.
3. **`/work-issue <n>`** : relit l'issue et ses commentaires, met la branche au nom
   `issue-<n>-<slug>`, lit le plan ou la spec liés, travaille (Superpowers ou TDD), commente
   l'issue aux étapes clés (plan écrit, tests verts, bloqué) et finit par
   `pnpm test && pnpm lint` (+ `pnpm test:rust` si le backend change).
4. **`/ship`** : relance les vérifications, pousse la branche (Claude demande confirmation),
   ouvre ou met à jour la PR vers `main` avec `Closes #<n>`, passe l'issue en `status:review`
   et y met le lien de la PR. Il ne merge jamais.
5. Un coéquipier relit la PR ; **le propriétaire du dépôt merge**.
6. Après le merge : `git worktree remove .worktrees/issue-<n>` (ou fermer la session
   `claude --worktree`).

Pour un message à l'équipe sur une issue : **`/issue-comment <n> <texte>`**.

Deux worktrees qui lancent `pnpm test:rust` en même temps : voir « Two worktrees side by
side » dans le [README](README.md#two-worktrees-side-by-side).

### Ce qu'on ne fait jamais

- Pousser ou committer sur `main` (tout passe par une PR).
- Prendre une issue déjà assignée, ou pousser sur la branche d'un autre.
- `git push --force`, sur quelque branche que ce soit (refusé par les réglages) : une branche
  déjà poussée se met à jour avec `git merge origin/main`, pas par rebase ; merger une PR
  (c'est le propriétaire qui merge).
- Committer un secret (jeton, mot de passe réel, clé privée).

Le dépôt est privé sur un compte gratuit : GitHub n'offre pas de protection de branche. Les
garde-fous sont côté Claude Code (hook qui refuse l'édition et les commits sur `main`,
permissions qui demandent avant `git push` et les écritures GitHub, et refusent `--force` et
les pushs sur `main`) et la CI, qui
signale mais ne bloque pas. Sans Claude, ces règles tiennent par convention.

### Ajouter une issue

**New issue** sur GitHub (ou `gh issue create --web`) et le formulaire **Task** (labels
`type:task`, `status:ready`) ou **Bug** (`type:bug`, `status:triage`). Pour un plan entier :
`/plan-to-issues docs/superpowers/plans/<plan>.md --dry-run`, puis sans `--dry-run` (une issue
par `### Task N`, les issues existantes sont ignorées).

### Pas encore actif

- Les labels (`type:*`, `status:*`, `area:*`, `size:*`, `plan:*`…), jalons, epics et le board
  GitHub sont créés par `scripts/github-bootstrap.sh`, lancé une fois par le propriétaire
  (voir `docs/notes/team-setup.md`). Avant cela, les skills le détectent, sautent les étapes de
  label et prennent l'issue par la seule assignation.
- La CI (`.github/workflows/ci.yml`) n'a pas encore tourné sur GitHub : ses premiers
  résultats peuvent demander des corrections de la CI elle-même.

---

## English

### Prerequisites (Ubuntu)

- Tauri system packages and test tools:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
    libssl-dev libayatana-appindicator3-dev librsvg2-dev jq openssl openssh-client sqlite3
  ```
- Node 22 (22.22 or newer), pnpm 10 (`npm install -g pnpm@10`), Rust ≥ 1.96 (via [rustup](https://rustup.rs),
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

The `superpowers` plugin is enabled by the tracked `.claude/settings.json`, but each developer
installs it once. The first time you run `claude` in the repo, trust the folder: the project
settings, hooks and skills then apply. Personal, untracked settings: `CLAUDE.local.md`,
`.claude/settings.local.json`.

### Workflow

In Claude Code, skills do each step; the matching `gh`/`git` commands are in `CLAUDE.md`
(Workflow section) for working without Claude.

1. **`/pick-issue`** (or `/pick-issue <n>`, `/pick-issue area:frontend`): picks a
   `status:ready` issue **with no assignee**, assigns it to you, sets `status:in-progress`,
   checks no teammate took it at the same moment (backs off if so) and posts a short
   "Taking this — plan: …" comment.
2. Open a session in the issue's worktree: `claude --worktree issue-<n>` (or
   `git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main`
   then `claude` in that folder). The project hook refuses edits on `main`.
3. **`/work-issue <n>`**: reads the issue and its comments, names the branch
   `issue-<n>-<slug>`, reads the linked plan or spec, does the work (Superpowers or TDD),
   comments on the issue at milestones (plan written, tests green, blocked) and ends with
   `pnpm test && pnpm lint` (+ `pnpm test:rust` when the backend changes).
4. **`/ship`**: re-runs the checks, pushes the branch (Claude asks first), opens or updates
   the PR to `main` with `Closes #<n>`, sets the issue to `status:review` and links the PR on
   it. It never merges.
5. A teammate reviews the PR; **the repository owner merges**.
6. After the merge: `git worktree remove .worktrees/issue-<n>` (or close the
   `claude --worktree` session).

To tell the team something on an issue: **`/issue-comment <n> <text>`**.

Two worktrees running `pnpm test:rust` at the same time: see "Two worktrees side by side"
in the [README](README.md#two-worktrees-side-by-side).

### Never

- Push or commit to `main` (everything goes through a PR).
- Take an issue that already has an assignee, or push to someone else's branch.
- `git push --force` any branch (denied by the settings): update a pushed branch with
  `git merge origin/main`, not a rebase; merge a PR (the owner merges).
- Commit a secret (token, real password, private key).

The repository is private on a free plan: GitHub offers no branch protection. The guards
live in Claude Code (a hook refusing edits and commits on `main`, permissions that ask before
`git push` and GitHub writes and deny `--force` and pushes to `main`) and in CI, which reports but does not block.
Without Claude, these rules hold by convention.

### Adding an issue

**New issue** on GitHub (or `gh issue create --web`) and the **Task** form (labels
`type:task`, `status:ready`) or the **Bug** form (`type:bug`, `status:triage`). For a whole
plan: `/plan-to-issues docs/superpowers/plans/<plan>.md --dry-run`, then without `--dry-run`
(one issue per `### Task N`; existing issues are skipped).

### Not live yet

- GitHub labels (`type:*`, `status:*`, `area:*`, `size:*`, `plan:*`…), milestones, epics and
  the board are created by `scripts/github-bootstrap.sh`, run once by the owner (see
  `docs/notes/team-setup.md`). Until then the skills detect it, skip the label steps and claim
  by assignment only.
- CI (`.github/workflows/ci.yml`) has not run on GitHub yet: its first results may need fixes
  to the CI itself.
