---
name: release
description: Cut a TableMax release end to end — pick the version, bump it through an issue and a PR, tag the merged commit after an explicit confirmation, watch the Release workflow, and check the published files. Use when the user asks to make, cut or publish a release or a version (e.g. "fais une release", "publish v0.2.0", "sors une beta").
argument-hint: "[version, e.g. 0.2.0 or 0.2.0-beta.1]"
---

# Release

Argument: `$ARGUMENTS` (optional version, without `v`). This follows README "Cutting a
release": the version lives in `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`; a pushed tag `v<version>` on a `main`
commit makes `.github/workflows/release.yml` build on Ubuntu 22.04, smoke-test on 24.04 and
publish the GitHub Release (`.deb`, AppImage, `SHA256SUMS`).

**Hard rules**
- **Pushing the tag publishes a public release: never push it without the user's explicit
  "yes" in this conversation, given after you showed the summary of step 5.** A general
  "go ahead" given earlier does not count.
- **The owner merges** (`CLAUDE.md`): you never merge the version PR on your own initiative.
  Ask the user to merge it, or to tell you to; a "merge it" from the user is the owner merging
  through you.
- Tag only a commit that is on `origin/main` and whose four files hold the version (step 4).
- Never reuse a version that already has a GitHub Release, never delete or edit a published
  release, never force-push. Moving a tag is allowed only when **no** release exists for it
  (step 7).
- Talk to the user in their language; issue, PR and commit text in English.

Helper used below — the four version files of a commit, extracted to check them without a
checkout:

```bash
tree_at() { # $1 = commit; prints a temp dir holding its four version files
  local d; d="$(mktemp -d)"
  git archive "$1" package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock | tar -x -C "$d"
  echo "$d"
}
```

## 1. State

```bash
gh auth status --active --json hosts --jq '.hosts[][] | select(.active) | .login'
gh api 'repos/{owner}/{repo}' --jq '.permissions | {admin, maintain}'
git fetch origin --tags
gh release list --exclude-pre-releases --limit 1 --json tagName,publishedAt   # last stable release
gh release list --limit 5                                                       # incl. prereleases
git show origin/main:package.json | jq -r .version                             # version on main
gh run list --workflow release.yml --limit 3
```

- No `admin` / `maintain` permission → stop: releases are cut by the maintainers.
- A Release run in progress or queued → say so and wait (`gh run watch <id>`).
- `LAST` = the last stable release's tag; **none** → this is the first release: the range is
  all of `origin/main`.
- What the release would contain (titles **and** bodies, for breaking changes):
  ```bash
  git log --format='%h %s%n%b' "$LAST"..origin/main      # or origin/main when there is no LAST
  ```
- Nothing in the range → say there is nothing to release and stop, unless the user insists
  (a rebuild: next **patch**).

## 2. Choose the version

If the user gave one, check it: `<major>.<minor>.<patch>[-suffix]`, greater than `LAST`, no
release and no tag with that name. Otherwise propose one from the **user-visible** changes in
the range: commits whose type is `feat`, `fix`, `perf` or `security` **and** whose scope is
not internal tooling (`claude`, `ci`, `release`, `scripts`, `test`, `docs`, `deps`, `git`):

- a `!` after the type, or `BREAKING` in a body → next **minor** while the major is 0
  (`0.x`), next major from 1.0;
- any user-visible `feat` → next **minor**;
- otherwise (user-visible fixes, perf, security, or nothing user-visible) → next **patch**;
- a beta / rc on request → `<next>-beta.N` / `-rc.N` (N = 1 + the highest existing one; a
  GitHub prerelease).

Show: last release, proposed version and why, the user-visible changes (one line each), and
how many internal commits are left out — then ask the user to confirm the version.

## 3. Bump the version (issue → branch → PR)

Skip this step when `origin/main` already holds the version:
`RELEASE_ROOT="$(tree_at origin/main)" bash scripts/release-check-version.sh v<version>`
prints the version.

1. Issue (form sections, like `/new-issue`), labels `type:chore`, `status:in-progress`,
   `area:infra`, `size:S`, assigned to the user cutting the release: title
   `Release v<version>`; Context = last release and the changes list; To do = bump, tag,
   publish; Acceptance = release published with both packages and `SHA256SUMS`, checksums OK.
   Put it on the board (Stage "In progress"), as `/new-issue` step 7 does.
2. Worktree, anchored to the main checkout (not to the current worktree):
   ```bash
   main_dir="$(git worktree list --porcelain | awk 'NR==1 { print $2 }')"
   git -C "$main_dir" worktree add -b "issue-<n>-release-v<version>" "$main_dir/.worktrees/issue-<n>" origin/main
   ```
3. In that worktree:
   ```bash
   bash scripts/release-bump.sh <version>              # exactly 4 lines change
   bash scripts/release-check-version.sh v<version>
   git diff --stat                                      # the four files only
   git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "🔥 chore(release): v<version>"       # + the Co-Authored-By trailer
   ```
4. Ship it as `/ship` does (push, PR with `Closes #<n>`, `status:review`). The PR changes
   `tauri.conf.json`, so it also runs the Release workflow's build and smoke tests (no
   publish): wait until **every** check is green (`gh pr checks <pr>`). A red check stops the
   release: report it; it gets fixed through its own issue.
5. Ask the user to merge (hard rules). Once merged: `git fetch origin`, and
   `SHA` = `gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid`.

When step 3 was skipped, `SHA` = `git rev-parse origin/main`.

## 4. Pre-flight on `SHA`

```bash
git merge-base --is-ancestor "$SHA" origin/main && echo on-main                # must print on-main
RELEASE_ROOT="$(tree_at "$SHA")" bash scripts/release-check-version.sh "v<version>"   # all four files
git ls-remote --tags origin "v<version>"                                       # must print nothing
gh release view "v<version>" 2>&1 | grep -q 'release not found' && echo no-release   # must print no-release
```

The last check must print `no-release`; any other output (a release, or an auth / network
error) means you cannot tell: stop. `SHA` is normally `origin/main` itself; if other PRs were
merged after the version PR, say so: tagging `SHA` releases without them.

## 5. Confirm, then tag

Show: version, tag `v<version>`, commit (short sha + title), prerelease or not, the
user-visible changes, and that pushing the tag publishes a public GitHub Release. Ask for an
explicit yes. After the yes:

```bash
git tag -a "v<version>" "$SHA" -m "TableMax <version>"
git push origin "v<version>"
```

## 6. Watch the Release workflow

The run for the tag can take a few seconds to appear; select it by tag, never "the latest":

```bash
gh run list --workflow release.yml --branch "v<version>" --event push --limit 1 --json databaseId,status
gh run watch <id> --exit-status --interval 60     # about 10 minutes; run it in the background
```

Tell the user it is running and roughly how long it takes.

## 7. If the run fails

`gh run view <id> --log-failed`, then check whether something was published
(`gh release view "v<version>"`):

- **"release not found"** (the publish job never ran, or `gh` removed its draft): nothing is
  public. File the problem as an issue (`/new-issue`, type bug, with the log excerpt), fix it
  through the normal flow, and once the fix is on `main`, ask the user before moving the tag:
  ```bash
  git push origin --delete "v<version>" && git tag -d "v<version>"
  ```
  then steps 4–6 again with `SHA` = the new `origin/main` (the version files are unchanged).
- **A release exists** (partial or complete): stop and ask the user. Never delete or replace
  it yourself; the usual way out is a new patch version.

## 8. Check what was published

```bash
d="$(mktemp -d)" && gh release download "v<version>" --dir "$d"
(cd "$d" && sha256sum -c SHA256SUMS)                                   # every line OK
dpkg-deb -f "$d/TableMax_<version>_amd64.deb" Package Version          # table-max, <version> (Debian/Ubuntu hosts)
gh release view "v<version>" --json url,isPrerelease,assets --jq '.url, .isPrerelease, [.assets[].name]'
```

Expect exactly `TableMax_<version>_amd64.deb`, `TableMax_<version>_amd64.AppImage` and
`SHA256SUMS`. Then move the issue's board item to "Done" and remove its `status:*` label (the
merged PR closed the issue).

## 9. Report

One short message: the release URL, its files and sizes, the checksum result, and the install
commands from README "Download (Linux)", ready to send to users.
