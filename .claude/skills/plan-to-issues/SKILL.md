---
name: plan-to-issues
description: Turn a TableMax plan (docs/superpowers/plans/*.md) into GitHub issues, one per "### Task N", with the plan milestone and type/status/plan/area labels; skips tasks that already have an issue. Use when the user asks to create issues or tickets from a plan.
argument-hint: "<plan-file> [--dry-run] [--assign-me] [--milestone <title>]"
disable-model-invocation: true
---

# Plan → issues

Arguments: `$ARGUMENTS`. The work is done by `scripts/plan-to-issues.mjs` (tested by
`scripts/plan-to-issues.test.mjs`); do not create the issues by hand.

What it creates, per `### Task N: <title>`:

- title `[Plan P] Task N: <title>` (plans without a number use their name: `[<name>] Task N: …`);
- body: link to the task in the plan (GitHub anchor), the task's **Files** lines, its
  verification steps as acceptance criteria, plus `pnpm test && pnpm lint` green;
- labels `type:task`, `status:ready`, `plan:P`, and `area:frontend|backend|infra|docs`
  from the paths in **Files**;
- milestone: an existing `Plan P …` milestone, else `Plan P — <plan name>` (created), or
  `--milestone <title>`;
- `--assign-me`: assigned to you (for tasks you run yourself in series; `/work-issue`
  still sets `status:in-progress` when you start each one).

An issue already exists when any issue (open or closed) starts with `[Plan P] Task N:`; it
is skipped, so the command can be re-run safely.

## Steps

1. Check the file exists and has `### Task N:` headings. Without `gh auth status`, only a
   dry run is possible.
2. Always run the dry run first and show its output:
   ```bash
   node scripts/plan-to-issues.mjs <plan-file> --dry-run [--assign-me] [--milestone <title>]
   ```
3. If the user passed `--dry-run`, stop here. If labels are reported missing (other than
   `plan:P`, which the script creates), the repository is not bootstrapped yet: tell the user
   to run `bash scripts/github-bootstrap.sh` (owner) and stop.
4. Otherwise ask the user to confirm, then run the same command without `--dry-run` and show
   the created issue URLs.
