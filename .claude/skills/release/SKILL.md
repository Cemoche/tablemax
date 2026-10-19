---
name: release
description: Cut a TableMax release end to end — pick the version, bump it through an issue and a PR, tag the merge commit after an explicit confirmation, watch the Release workflow, and check the published files. Use when the user asks to make, cut or publish a release or a version (e.g. "fais une release", "publish v0.2.0", "sors une beta").
argument-hint: "[version, e.g. 0.2.0 or 0.2.0-beta.1]"
---

# Release

Argument: `$ARGUMENTS` (optional version, without `v`). This follows README "Cutting a
release": the version lives in `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` (+ `src-tauri/Cargo.lock`); a pushed tag `v<version>` on a `main`
commit makes `.github/workflows/release.yml` build on Ubuntu 22.04, smoke-test on 24.04 and
publish the GitHub Release (`.deb`, AppImage, `SHA256SUMS`).

**Hard rules**
- **Pushing the tag publishes a public release: never push it without the user's explicit
  "yes" in this conversation, given after you showed the summary of step 5.** A general
  "go ahead" given earlier does not count.
- Tag only a commit of `origin/main`, never a branch, never a dirty or local-only commit.
- Never reuse a version that already has a GitHub Release, never delete or edit a published
  release, never force-push. Moving a tag is allowed only when **no** release exists for it
  (step 7).
- Talk to the user in their language; issue, PR and commit text in English.

## 1. State

```bash
gh auth status --active --json hosts --jq '.hosts[][] | select(.active) | .login'
gh api 'repos/{owner}/{repo}' --jq '.permissions | {admin, maintain}'
git fetch origin --tags --prune
gh release list --limit 5
git describe --tags --abbrev=0 origin/main 2>/dev/null    # last tag on main
jq -r .version package.json                               # in this checkout; compare with origin/main
git log --oneline <last-tag>..origin/main                 # what the release would contain
gh run list --workflow release.yml --limit 3
```

- No `admin` / `maintain` permission → stop: releases are cut by the maintainers.
- A Release run still in progress → say so and wait (`gh run watch <id>`), do not start another.
- Nothing since the last tag → say there is nothing to release and stop, unless the user
  insists (then it is a rebuild: still a new version).

## 2. Choose the version

If the user gave one, check it: `<major>.<minor>.<patch>[-suffix]`, greater than the last
release, not already released. Otherwise propose one from the commits since the last tag
(Conventional Commit types in the titles):

- a `!` after the type or `BREAKING` in a message → next **minor** while the major is 0
  (`0.x`), next major after 1.0;
- any `✨ feat` → next **minor**;
- only fixes, docs, chores, perf, security → next **patch**;
- the user asks for a beta / rc → `<next>-beta.N` / `-rc.N` (a prerelease on GitHub).

Show: last release, proposed version and why, and the list of user-visible changes (feat, fix,
perf, security; drop chores/docs/tests) — then ask the user to confirm the version.

## 3. Bump the version (issue → branch → PR)

Skip this step when `origin/main` already holds the chosen version in all four files
(`bash scripts/release-check-version.sh v<version>` passes on `origin/main`).

1. Issue (form sections, like `/new-issue`), labels `type:chore`, `status:in-progress`,
   `area:infra`, `size:S`, assigned to the user running the release:
   title `Release v<version>`, Context = last release and the changes list, To do = bump +
   tag + publish, Acceptance = Release published with both packages and `SHA256SUMS`.
   Put it on the board (Stage "In progress"), as `/new-issue` step 7 does.
2. Worktree from `origin/main`: `git worktree add -b issue-<n>-release-v<version> .worktrees/issue-<n> origin/main`.
3. In it:
   ```bash
   bash scripts/release-bump.sh <version>          # exactly 4 lines change
   bash scripts/release-check-version.sh v<version>
   git diff --stat                                  # package.json, tauri.conf.json, Cargo.toml, Cargo.lock
   git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "🔥 chore(release): v<version>"   # + the Co-Authored-By trailer
   ```
4. Ship it as `/ship` does (push, PR `Closes #<n>`, `status:review`). The PR changes
   `tauri.conf.json`, so it also runs the Release workflow's build and smoke tests (no
   publish): wait until **every** check is green (`gh pr checks <pr>`); a red check stops the
   release — report it and fix it through its own issue.
5. Merge: only when the user says so (the owner merges), with `gh pr merge <pr> --squash`.
   Then `git fetch origin` and take the merge commit: `gh pr view <pr> --json mergeCommit --jq .mergeCommit.oid`.

## 4. Pre-flight on the commit to tag

```bash
git fetch origin --tags
git merge-base --is-ancestor <sha> origin/main && echo on-main
git show <sha>:package.json | jq -r .version                       # = <version>
git ls-remote --tags origin "v<version>"                            # must print nothing
gh release view "v<version>" >/dev/null 2>&1 && echo "ALREADY RELEASED"   # must not print
```

Any surprise → stop and explain.

## 5. Confirm, then tag

Show: version, tag `v<version>`, commit (short sha + title), prerelease or not, the changes
list, and that pushing the tag publishes a public GitHub Release. Ask for an explicit yes.

After the yes:

```bash
git tag -a "v<version>" <sha> -m "TableMax <version>"
git push origin "v<version>"
```

## 6. Watch the Release workflow

```bash
gh run list --workflow release.yml --limit 1 --json databaseId,headBranch,status   # headBranch = v<version>
gh run watch <id> --exit-status --interval 60          # about 20 minutes, run it in the background
```

Tell the user it is running and roughly how long it takes.

## 7. If the run fails

`gh run view <id> --log-failed`, then:

- `gh release view "v<version>"` finds **no** release (the publish job never ran, or `gh`
  removed its draft): nothing is public. File the problem as an issue (`/new-issue`, type bug,
  with the log excerpt), fix it through the normal flow, and once the fix is on `main`, ask the
  user before moving the tag:
  ```bash
  git push origin --delete "v<version>" && git tag -d "v<version>"
  ```
  then steps 4–6 again on the new `main` commit (the version files are unchanged).
- A release **exists** (partial or complete): stop and ask the user. Never delete or replace it
  yourself; the usual way out is a new patch version.

## 8. Check what was published

```bash
d="$(mktemp -d)" && gh release download "v<version>" --dir "$d"
(cd "$d" && sha256sum -c SHA256SUMS)
dpkg-deb -f "$d"/TableMax_<version>_amd64.deb Package Version     # table-max, <version>
gh release view "v<version>" --json url,isPrerelease,assets --jq '.url, .isPrerelease, [.assets[].name]'
```

Expect exactly `TableMax_<version>_amd64.deb`, `TableMax_<version>_amd64.AppImage` and
`SHA256SUMS`, all checksums OK. Then close out the issue's board item (Stage "Done") and
remove the `status:*` label; the merged PR closed the issue.

## 9. Report

One short message: the release URL, its files and sizes, the checksum check, and the install
commands from the README "Download (Linux)" section, ready to send to users.
