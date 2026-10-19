# TableMax — Setup de travail en équipe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trois développeurs, chacun avec ses agents Claude Code, travaillent sur TableMax sans se marcher dessus : le travail vit dans des issues GitHub qu'on s'assigne, chaque issue a sa branche, son worktree et sa PR, la CI vérifie chaque PR, et un clone frais du dépôt donne à Claude toutes les règles et commandes du projet.

**Architecture:** Tout est versionné dans le dépôt. `CLAUDE.md` (racine + `src/` + `src-tauri/`) porte les règles ; `.claude/settings.json` porte permissions, hooks et plugin recommandé ; `.claude/skills/` porte le flux de travail (prendre une issue, travailler dessus, livrer, transformer un plan en issues) ; `.github/` porte modèles d'issue/PR et la CI. Côté GitHub : labels, jalons, issues, et un board Projects si le jeton le permet. La coordination repose sur l'assignation d'issue (un assigné = seul à pousser sa branche) parce que le dépôt privé gratuit n'autorise pas la protection de branche.

**Tech Stack:** Claude Code (CLAUDE.md, settings, hooks, skills), `gh` CLI (chaque développeur utilise son propre `gh auth login`), GitHub Actions (`ubuntu-24.04`, Docker Compose pour les bases de test), bash + `jq` pour les hooks.

**Spec:** demande utilisateur du 2026-10-17 (« On est 3 devs sous Claude… il faudrait pas qu'on se marche dessus, il faut cibler nos tâches… système de ticket/carte GitHub et chacun assignerait ses agents Claude aux tâches… setup Claude Code… leur Claude fonctionnera directement comme il faut dans le projet ») + `docs/superpowers/specs/2026-10-16-tablemax-design.md` (règles du projet).

## Global Constraints

- Branche d'intégration : `main`. Jamais de commit ni de push direct sur `main` ; tout passe par une PR. Le merge est fait par un humain (le propriétaire décide), jamais par un agent.
- Une issue = une branche `issue-<n>-<slug>` = un worktree = une PR qui contient `Closes #<n>`. Seul l'assigné pousse sur cette branche.
- Prendre une issue = s'assigner (`gh issue edit <n> --add-assignee @me`) **et** poser le label `status:in-progress`, avant toute ligne de code. Une issue déjà assignée n'est jamais prise.
- Messages de commit : `<emoji> <type>(<scope>): <description>` (✨ feat, 🐛 fix, 🏗️ refactor, 🔥 chore, 📝 docs, ✅ test, 🎨 style, ⚡ perf, ⏪ revert, 🔒 security).
- Sécurité (spec §4) : secrets uniquement dans le trousseau ; rien de TablePlus ; aucune permission Tauri non nécessaire. Les fichiers versionnés ne contiennent aucun jeton ni mot de passe réel (les mots de passe des bases de test `tablemax`, `tunnel-pass`, `fixture-pass` sont factices et documentés).
- Les hooks versionnés tournent chez chaque coéquipier : courts, lisibles, sans réseau sauf `gh` en lecture, et testés.
- Aucun outil Azure DevOps ni Ticky dans ce projet (règles globales ham05 non applicables) : le `CLAUDE.md` du projet le dit explicitement.
- Le dépôt est privé sur un compte gratuit : la protection de branche et les checks obligatoires ne sont pas disponibles (`gh api …/branches/main/protection` → 403). La discipline est portée par les hooks, les skills et la CI informative.

## Review Focus

1. **Deux agents prennent la même issue au même moment** : le second voit l'assignation du premier et abandonne → `pick-issue` relit l'issue après s'être assigné et se retire si un autre assigné est présent (Task 3, test `pick-issue race` décrit dans le skill et vérifié à la main).
2. **Agent lancé sur `main`** (clone frais, oubli de worktree) : toute édition est refusée avec un message qui explique comment créer le worktree → test `block-main-edits` (Task 2).
3. **Clone frais sur une autre machine** : `CONTRIBUTING.md` suffit pour arriver à `pnpm test && pnpm lint && pnpm test:rust` verts → vérifié par la CI qui part d'un runner vierge (Task 4).
4. **Hook qui échoue** (`jq` absent, hors dépôt git, `gh` non connecté) : il ne bloque jamais le travail par erreur (sauf la règle `main`) et dit ce qui manque → tests de la Task 2.
5. **Secrets dans la config partagée** : aucun jeton dans `.claude/settings.json`, `.mcp.json` (absent), workflows (seulement `secrets.*` GitHub, aucun requis) → contrôle `scripts/check-no-secrets.sh` (Task 4) lancé en CI.

---

### Task 1: Règles du projet pour humains et agents

**Files:**
- Create: `CLAUDE.md`, `src/CLAUDE.md`, `src-tauri/CLAUDE.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/task.yml`, `.github/ISSUE_TEMPLATE/bug.yml`, `.github/ISSUE_TEMPLATE/config.yml`, `.github/pull_request_template.md`
- Modify: `.gitignore` (`.claude/worktrees/`, `.claude/settings.local.json`, `CLAUDE.local.md`), `README.md` (section « Contributing » qui renvoie à `CONTRIBUTING.md`)

**Interfaces:**
- `CLAUDE.md` (≤ 150 lignes) : ce qu'est TableMax (1 paragraphe) ; carte du dépôt (`src/`, `src-tauri/`, `docs/superpowers/specs|plans`, `docs/research`, `docs/notes`, `scripts/`, `tests/docker/`) ; commandes (`pnpm install`, `pnpm dev`, `pnpm test`, `pnpm lint`, `pnpm test:rust`, `pnpm demo:db`, `scripts/test-dbs.sh up|down|env`) ; « Definition of done » (tests + lint verts, `test:rust` si le backend change, notes de vérification manuelle pour l'UI) ; flux de travail (les règles d'issue/branche/PR des Global Constraints, les skills `/pick-issue`, `/work-issue`, `/ship`, `/plan-to-issues`) ; règles de sécurité et de copie (spec §4) ; « Ce projet n'utilise pas Azure DevOps ni Ticky ; les tickets sont des issues GitHub » ; pointeur vers la spec et le plan en cours ; mention que le plugin `superpowers` est recommandé (brainstorming → plan → subagent-driven-development).
- `src/CLAUDE.md` : React 19 + Zustand + Tailwind 4 ; chaînes visibles uniquement via `src/lib/strings.ts` ; couleurs uniquement via les tokens de `src/styles/tokens.css` ; IPC uniquement via `src/lib/ipc.ts` (miroir de `src-tauri/src/commands.rs`) et types dans `src/lib/types.ts` (miroir serde camelCase) ; tests Vitest + Testing Library à côté des fichiers, `ipc` mocké avec `vi.mock`.
- `src-tauri/CLAUDE.md` : modules (`driver/`, `ssh/`, `import/`, `manager.rs`, `store.rs`, `secrets.rs`, `commands.rs`) ; `AppError { kind, message }` et ses kinds ; aucune I/O bloquante hors `spawn_blocking` ; aucun secret dans `Debug`/erreurs/logs ; provider rustls `ring`, jamais `aws-lc` ; ajouter une version de base = une ligne dans `docker-compose.test.yml` + une URL dans `scripts/test-dbs.sh` ; les tests d'intégration lisent `TABLEMAX_TEST_*` (via `scripts/test-dbs.sh env`).
- `CONTRIBUTING.md` (français et anglais : sections courtes dans les deux langues) : prérequis Ubuntu (paquets système Tauri, Node 22, pnpm 10, Rust ≥ 1.96, Docker, `jq`, `gh`), installation, `claude plugin install superpowers@claude-plugins-official --scope project` (une fois), `gh auth login`, flux : choisir une issue `status:ready` → `/pick-issue` (ou `gh issue edit`) → `claude --worktree issue-<n>` → `/work-issue <n>` → `/ship` → relecture d'un coéquipier → merge par le propriétaire ; ce qu'on ne fait jamais (push sur `main`, prendre une issue assignée, `--force` sur la branche d'un autre) ; comment ajouter une issue (`/plan-to-issues` ou formulaire).
- Formulaires d'issue (YAML GitHub issue forms) : `task.yml` (champs : contexte, à faire, critères d'acceptation, fichiers probablement touchés, plan/spec liés ; labels par défaut `type:task`, `status:ready`) ; `bug.yml` (étapes, attendu, observé, version/OS ; labels `type:bug`, `status:triage`) ; `config.yml` (`blank_issues_enabled: false`).
- `pull_request_template.md` : `Closes #`, résumé, comment c'est testé (commandes + sortie), captures pour l'UI, check-list (tests, lint, `test:rust` si backend, pas de secret, chaînes dans `strings.ts`).

- [ ] **Step 1: Écrire les fichiers** selon les Interfaces (contenu factuel tiré du dépôt : vérifier chaque commande et chemin cités en les exécutant ou en les listant).
- [ ] **Step 2: Vérifier** — Run: `pnpm test && pnpm lint` (rien ne doit casser) et `for f in .github/ISSUE_TEMPLATE/*.yml; do python3 -I -c "import sys,yaml; yaml.safe_load(open(sys.argv[1]))" "$f"; done` → Expected: aucun échec (installer `python3-yaml` n'est pas permis : si `yaml` manque, utiliser `ruby -ryaml -e 'YAML.load_file(ARGV[0])'` ou `node` avec un parseur déjà présent dans `node_modules`, sinon le signaler).
- [ ] **Step 3: Commit** — `📝 docs(team): project rules for contributors and their Claude agents`

---

### Task 2: Configuration Claude Code partagée (`.claude/settings.json` + hooks)

**Files:**
- Create: `.claude/settings.json`, `.claude/hooks/block-main-edits.sh`, `.claude/hooks/session-context.sh`, `scripts/test-claude-hooks.sh`
- Modify: `package.json` (script `test:hooks` → `bash scripts/test-claude-hooks.sh`)

**Interfaces:**
- `.claude/settings.json` :
  - `permissions.allow` : `Bash(pnpm install*)`, `Bash(pnpm test*)`, `Bash(pnpm lint*)`, `Bash(pnpm build*)`, `Bash(pnpm web*)`, `Bash(pnpm demo:db*)`, `Bash(cargo test *)`, `Bash(cargo build *)`, `Bash(cargo check *)`, `Bash(cargo clippy *)`, `Bash(cargo fmt *)`, `Bash(cargo tree *)`, `Bash(bash scripts/test-dbs.sh *)`, `Bash(scripts/test-dbs.sh *)`, `Bash(docker compose -f docker-compose.test.yml *)`, `Bash(gh issue *)`, `Bash(gh pr *)`, `Bash(gh label list*)`, `Bash(gh run *)`, `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`, `Bash(git show*)`, `Bash(git branch*)`, `Bash(git switch *)`, `Bash(git fetch*)`, `Bash(git add *)`, `Bash(git commit *)`, `Bash(git worktree *)`.
  - `permissions.ask` : `Bash(git push*)`, `Bash(gh pr merge*)`.
  - `permissions.deny` : `Bash(git push --force*)`, `Bash(git push -f*)`, `Bash(git push * --force*)`, `Bash(git push * -f*)`, `Bash(git push origin main*)`, `Bash(git push * main)`, `Bash(gh pr merge*--admin*)`, `Read(./.env)`, `Read(./.env.*)`.
  - `hooks.PreToolUse` : matcher `Edit|Write|NotebookEdit` → `"${CLAUDE_PROJECT_DIR}"/.claude/hooks/block-main-edits.sh`, timeout 10.
  - `hooks.SessionStart` : matcher `startup|resume` → `"${CLAUDE_PROJECT_DIR}"/.claude/hooks/session-context.sh`, timeout 15.
  - `enabledPlugins` : `{ "superpowers@claude-plugins-official": true }`.
  - `worktree` : `{ "baseRef": "fresh" }`.
- `block-main-edits.sh` : lit le JSON d'entrée (stdin), prend `tool_input.file_path` (ou `notebook_path`) sinon `cwd` ; trouve la branche du dépôt qui contient ce chemin (`git -C <dir> branch --show-current`) ; si la branche est `main` ou `master` → stderr `TableMax: edits on '<branch>' are blocked. Start an issue worktree: claude --worktree issue-<n>  (see CONTRIBUTING.md)` et exit 2 ; sinon exit 0. Fichier hors dépôt git, branche détachée, ou `jq` absent → exit 0 (et, pour `jq` absent, un avertissement sur stderr). N'écrit jamais rien.
- `session-context.sh` : affiche (JSON `hookSpecificOutput.additionalContext` pour `SessionStart`) la branche courante ; si elle suit `issue-<n>-…` et que `gh` est connecté, ajoute le titre, l'état, les assignés et l'URL de l'issue `<n>` (`gh issue view <n> --json title,state,assignees,url`, timeout 10 s) ; sur `main` : « You are on main: pick an issue with /pick-issue and work in a worktree » ; `gh`/`jq` absents ou erreur → sortie vide, exit 0.
- `scripts/test-claude-hooks.sh` : crée un dépôt git temporaire (branches `main` et `issue-12-demo`), et vérifie avec des JSON d'entrée construits : édition d'un fichier sur `main` → exit 2 + message ; sur `issue-12-demo` → exit 0 ; fichier hors dépôt → exit 0 ; branche détachée → exit 0 ; `PATH` sans `jq` → exit 0 + avertissement ; `session-context.sh` sur `main` → JSON valide contenant `pick an issue` ; sur `issue-12-demo` avec `gh` remplacé par un faux script dans `PATH` → JSON contenant le titre factice ; sans `gh` → exit 0. Affiche `ok`/`FAIL` par cas et sort en erreur si un cas échoue.

- [ ] **Step 1: Écrire `scripts/test-claude-hooks.sh`** (cas ci-dessus) — Run: `bash scripts/test-claude-hooks.sh` → Expected: FAIL (hooks absents).
- [ ] **Step 2: Écrire les hooks et `.claude/settings.json`.**
- [ ] **Step 3: Vérifier** — Run: `bash scripts/test-claude-hooks.sh && jq . .claude/settings.json >/dev/null && pnpm lint` → Expected: tous les cas `ok`.
- [ ] **Step 4: Commit** — `🔥 chore(claude): shared Claude Code settings and guard hooks`

---

### Task 3: Skills de flux de travail

**Files:**
- Create: `.claude/skills/pick-issue/SKILL.md`, `.claude/skills/work-issue/SKILL.md`, `.claude/skills/ship/SKILL.md`, `.claude/skills/plan-to-issues/SKILL.md`

**Interfaces** (frontmatter : `name`, `description`, `argument-hint` si argument, `disable-model-invocation: true` pour `pick-issue`, `ship`, `plan-to-issues` qui ont des effets sur GitHub) :
- `/pick-issue [label-or-number]` : liste les issues ouvertes `status:ready` non assignées (filtre optionnel par label `area:*`/`plan:*` ou numéro), triées par jalon puis numéro, en affichant titre, labels, taille ; propose la première (ou celle demandée) ; s'assigne (`--add-assignee @me`), remplace `status:ready` par `status:in-progress`, **relit** l'issue : si un autre assigné est apparu, se désassigne, remet les labels et choisit la suivante ; puis indique la commande `claude --worktree issue-<n>` (ou, si déjà dans un worktree dont la branche est `issue-<n>-…`, passe à `/work-issue <n>`).
- `/work-issue <n>` : vérifie que la branche courante est `issue-<n>-<slug>` (sinon la crée depuis `origin/main` à jour si l'arbre est propre, sinon s'arrête) et que l'issue est assignée à `@me` ; lit l'issue, les fichiers « probablement touchés » et la spec/le plan liés ; pour un travail non trivial applique `superpowers:brainstorming` puis `superpowers:writing-plans` (plan dans `docs/superpowers/plans/`) puis `superpowers:subagent-driven-development` ; pour un petit ticket, TDD direct ; commits locaux au format du projet ; termine par `pnpm test && pnpm lint` (+ `pnpm test:rust` si `src-tauri/` a changé) et un résumé.
- `/ship` : refuse sur `main` ; exige un arbre propre et des tests verts (relance `pnpm test && pnpm lint`, et `pnpm test:rust` si `src-tauri/` a changé depuis `origin/main`) ; `git push -u origin <branche>` (soumis à la permission `ask`) ; ouvre ou met à jour la PR vers `main` avec le modèle (`Closes #<n>` tiré du nom de branche, sortie des tests) ; remplace `status:in-progress` par `status:review` ; ne merge jamais.
- `/plan-to-issues <plan-file>` : lit un plan `docs/superpowers/plans/*.md` ; crée (si absent) le jalon du plan ; crée une issue par `### Task N` (titre `[Plan N] Task N: <titre>`, corps = lien vers le plan à la bonne ancre + Files + critères = étapes de vérification, labels `type:task`, `plan:<N>`, `area:frontend|backend|infra|docs` déduit des fichiers, `status:ready`) ; ne recrée pas une issue déjà existante (recherche par titre) ; affiche la liste créée ; option `--assign-me` pour les tâches qu'on exécute soi-même en série.

- [ ] **Step 1: Écrire les quatre skills.** Chaque commande `gh` citée est vérifiée contre `gh <cmd> --help` (flags exacts).
- [ ] **Step 2: Vérifier** — Run: `for f in .claude/skills/*/SKILL.md; do head -1 "$f" | grep -qx -- '---' || echo "bad frontmatter $f"; done` et lancer `/plan-to-issues` en mode lecture seule (`--dry-run`, à prévoir dans le skill : affiche les issues qui seraient créées) sur `docs/superpowers/plans/2026-10-17-tablemax-02-connections.md` → Expected: 8 issues affichées, rien créé.
- [ ] **Step 3: Commit** — `🔥 chore(claude): issue workflow skills (pick, work, ship, plan-to-issues)`

---

### Task 4: Intégration continue

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/check-no-secrets.sh`

**Interfaces:**
- `ci.yml` : déclenché sur `pull_request` vers `main` et `push` sur `main` ; `concurrency` par ref avec annulation ; jobs :
  - `frontend` (`ubuntu-24.04`) : Node 22, pnpm 10 (`pnpm/action-setup`), cache pnpm, `pnpm install --frozen-lockfile`, `pnpm test`, `tsc` (la partie TypeScript de `pnpm lint`).
  - `backend` (`ubuntu-24.04`) : paquets système Tauri (liste du README), Rust 1.96 (`dtolnay/rust-toolchain` avec `clippy`), cache cargo (`Swatinem/rust-cache`), `cargo clippy -- -D warnings`, `bash scripts/test-dbs.sh up`, `eval "$(scripts/test-dbs.sh env)"`, `cargo test` (même commande que `pnpm test:rust`), `bash scripts/test-dbs.sh down` en `if: always()`.
  - `hygiene` : `bash scripts/test-claude-hooks.sh`, `bash scripts/check-no-secrets.sh`.
  - Toutes les actions tierces épinglées par version majeure connue ; `permissions: contents: read`.
- `check-no-secrets.sh` : échoue si un fichier suivi par git (hors `pnpm-lock.yaml`, `Cargo.lock`, `src-tauri/tests/fixtures/**`, `docs/research/**`) contient un motif de jeton (`ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `AKIA[0-9A-Z]{16}`, `-----BEGIN [A-Z ]*PRIVATE KEY-----`) ; liste les correspondances (fichier:ligne, sans la valeur).

- [ ] **Step 1: Écrire `check-no-secrets.sh`** — Run: `bash scripts/check-no-secrets.sh` → Expected: exit 0 sur le dépôt ; un fichier temporaire suivi contenant `ghp_` + 36 caractères fait échouer (tester puis annuler).
- [ ] **Step 2: Écrire `ci.yml`** et le valider localement (`actionlint` s'il est installé, sinon relecture + `python3 -I -c` YAML).
- [ ] **Step 3: Vérifier sur GitHub** : pousser la branche, ouvrir la PR (Task 5) et suivre le run (`gh run watch`) → Expected: les trois jobs verts. Corriger jusqu'au vert.
- [ ] **Step 4: Commit** — `🔥 chore(ci): lint, tests and test databases on every pull request`

---

### Task 5: GitHub — labels, jalons, issues, board, PRs

**Files:**
- Create: `scripts/github-bootstrap.sh` (idempotent ; relançable sans doublon), `docs/notes/team-setup.md` (ce qui a été créé, liens)

**Interfaces:**
- Labels (couleur + description) : `type:task`, `type:bug`, `type:epic`, `type:chore` ; `status:triage`, `status:ready`, `status:in-progress`, `status:review`, `status:blocked` ; `area:frontend`, `area:backend`, `area:infra`, `area:docs`, `area:security` ; `size:S`, `size:M`, `size:L` ; `plan:3`, `plan:4`, `plan:5`, `post-v1` ; `good first issue`.
- Jalons : `Plan 3 — Data`, `Plan 4 — Tabs & editor`, `Plan 5 — Safety & packaging`, `Post-v1`.
- Issues :
  - une issue `type:epic` par plan restant (3, 4, 5) reprenant la feuille de route de la spec (assignée au propriétaire pour le plan 3, que l'agent du propriétaire exécute en ce moment ; plans 4 et 5 `status:triage`) ;
  - une issue `type:epic` + `post-v1` par élément de la liste « prévus plus tard » de la spec §3 (autres drivers — une issue par driver : SQL Server, Redis, MongoDB, ClickHouse ; diagrammes ER ; metrics boards ; chat IA ; import/export CSV/JSON/SQL/Excel ; backup/restore ; gestion des utilisateurs ; process list ; édition de structure ; split view ; multi-fenêtres ; mise à jour automatique ; packaging macOS ; packaging Windows), `status:triage`, avec un paragraphe de contexte et les dépendances (ex. MongoDB → dépend d'une couche « capabilities » du trait `Session`) ;
  - des issues `good first issue` + `status:ready` regroupant les « minor (deferred) » des registres des plans 1 et 2 (`docs/notes/plan-01-followups.md`, `docs/notes/plan-02-followups.md`), une par thème cohérent, avec fichiers concernés — uniquement celles qui ne touchent pas les fichiers que le plan 3 va modifier (sinon `status:blocked` + « after Plan 3 »).
- Board : si `gh auth status` montre le scope `project`, créer le projet « TableMax » (colonnes via le champ Status : Triage, Ready, In progress, Review, Done), y ajouter toutes les issues, et le lier au dépôt ; sinon l'écrire dans `docs/notes/team-setup.md` avec la commande à lancer (`gh auth refresh -s project` puis `bash scripts/github-bootstrap.sh --project`).
- PRs : pousser `feat/plan-01-foundations`, `feat/plan-02-connections`, `feat/team-setup` et ouvrir les PRs empilées (plan 1 → `main`, plan 2 → plan 1, setup → plan 2) avec un corps qui explique l'ordre de merge. **Aucun merge.**
- Invitations : `jerembdn` est déjà invité ; le second ami n'a pas de pseudo connu → noté dans `docs/notes/team-setup.md`.

- [ ] **Step 1: Écrire `github-bootstrap.sh`** (fonctions `ensure_label`, `ensure_milestone`, `ensure_issue` par titre) ; Run: `bash scripts/github-bootstrap.sh --dry-run` → Expected: la liste de ce qui serait créé, sans appel en écriture.
- [ ] **Step 2: Exécuter** `bash scripts/github-bootstrap.sh` puis le relancer → Expected: la seconde exécution ne crée rien.
- [ ] **Step 3: PRs et CI** (Task 4 Step 3) ; écrire `docs/notes/team-setup.md`.
- [ ] **Step 4: Commit** — `🔥 chore(github): bootstrap labels, milestones, issues and board`
