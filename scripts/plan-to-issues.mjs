#!/usr/bin/env node
// Turn a plan (docs/superpowers/plans/*.md) into one GitHub issue per `### Task N: …`.
//
//   node scripts/plan-to-issues.mjs <plan-file> [--dry-run] [--assign-me] [--milestone <title>]
//
// --dry-run only reads GitHub (existing issues, labels, milestones) and prints what it would
// create. Without it, it creates the milestone if missing, then the missing issues. An issue
// already exists when one (open or closed) has a title starting with "[Plan N] Task K:", so
// running it twice creates nothing the second time. Labels come from
// scripts/github-bootstrap.sh; a missing `plan:N` label is created here.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const USAGE =
  "usage: node scripts/plan-to-issues.mjs <plan-file> [--dry-run] [--assign-me] [--milestone <title>]";

// ------------------------------------------------------------------ pure helpers (tested)

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces become hyphens. */
export function githubAnchor(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Plan number, short name and tasks (title, anchor, Files lines, verification steps). */
export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/);
  const h1 = (lines.find((l) => l.startsWith("# ")) ?? "# Plan").slice(2).trim();
  const numberMatch = h1.match(/\bPlan (\d+)\b/);
  const name = h1
    .replace(/^TableMax\s+—\s+/, "")
    .replace(/\s+—\s+Implementation Plan$/, "")
    .replace(/^Plan \d+\s*:\s*/, "")
    .trim();

  const tasks = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^### (Task (\d+):\s*(.+))$/);
    if (heading) {
      current = { number: Number(heading[2]), title: heading[3].trim(), anchor: githubAnchor(heading[1]), lines: [] };
      tasks.push(current);
    } else if (/^#{1,3} /.test(line) || line.trim() === "---") {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  return {
    number: numberMatch ? Number(numberMatch[1]) : null,
    name,
    tasks: tasks.map(({ lines: body, ...task }) => ({ ...task, files: filesOf(body), checks: checksOf(body) })),
  };
}

function filesOf(body) {
  const start = body.findIndex((l) => l.trim() === "**Files:**");
  if (start < 0) return [];
  const files = [];
  for (const line of body.slice(start + 1)) {
    if (!line.trim().startsWith("- ")) break;
    files.push(line.trim());
  }
  return files;
}

/** Steps whose title says "verify/check", minus "verify it fails" (TDD red step). */
function checksOf(body) {
  const steps = [];
  let step = null;
  for (const line of body) {
    if (/^- \[ \] \*\*Step \d+/.test(line)) {
      step = [line.replace(/^- \[ \] /, "").trim()];
      steps.push(step);
    } else if (step && line.trim()) {
      step.push(line.trim());
    }
  }
  return steps
    .map((s) => s.join(" ").replace(/\s+—\s+/, " "))
    .filter((s) => {
      const title = s.match(/^\*\*(.+?)\*\*/)?.[1] ?? "";
      return /v[ée]rifi|verify|check/i.test(title) && !/[ée]chec|fail/i.test(title);
    });
}

/** area:* labels from the paths in the Files lines. */
export function areasFor(files) {
  const paths = files.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  const areas = new Set();
  for (const p of paths) {
    if (p.startsWith("src-tauri/")) areas.add("area:backend");
    else if (p.startsWith("src/")) areas.add("area:frontend");
    else if (p.startsWith("docs/") || /^[^/]+\.md$/.test(p)) areas.add("area:docs");
    else if (/^(\.github|\.claude|scripts|tests\/docker)\//.test(p) || /^docker-compose|^package\.json$/.test(p))
      areas.add("area:infra");
  }
  return ["area:backend", "area:frontend", "area:docs", "area:infra"].filter((a) => areas.has(a));
}

function titlePrefix(plan) {
  return plan.number === null ? `[${plan.name}]` : `[Plan ${plan.number}]`;
}

export function issueFor(plan, task, { planPath, repo }) {
  const link = repo
    ? `[\`${planPath}\` — Task ${task.number}](https://github.com/${repo}/blob/main/${planPath}#${task.anchor})`
    : `\`${planPath}\`, Task ${task.number}`;
  const checks = [...task.checks.map((c) => `- [ ] ${c}`), "- [ ] `pnpm test && pnpm lint` green"];
  const body = [
    "## Context",
    "",
    `Task ${task.number} of ${titlePrefix(plan).slice(1, -1)} (${plan.name}): ${link}.`,
    "Read the whole task in the plan (Interfaces, Steps) and the plan's Global Constraints before starting.",
    "",
    "## Files likely touched",
    "",
    ...(task.files.length ? task.files : ["- see the plan"]),
    "",
    "## Acceptance criteria",
    "",
    ...checks,
    "",
    "Definition of done: `CLAUDE.md`. Findings outside this task become new issues.",
  ].join("\n");
  const labels = ["type:task", "status:ready"];
  if (plan.number !== null) labels.push(`plan:${plan.number}`);
  labels.push(...areasFor(task.files));
  return { title: `${titlePrefix(plan)} Task ${task.number}: ${task.title}`, body, labels };
}

/** The plan's milestone: an existing "Plan N …" one, else "Plan N — <name>". */
export function milestoneTitle(plan, existingTitles) {
  if (plan.number === null) return plan.name;
  const re = new RegExp(`^Plan ${plan.number}(?!\\d)`);
  return existingTitles.find((t) => re.test(t)) ?? `Plan ${plan.number} — ${plan.name}`;
}

export function parseArgs(argv) {
  const opts = { planPath: null, dryRun: false, assignMe: false, milestone: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--assign-me") opts.assignMe = true;
    else if (a === "--milestone") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error(`--milestone needs a title\n${USAGE}`);
      opts.milestone = value;
    }
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}\n${USAGE}`);
    else if (!opts.planPath) opts.planPath = a;
    else throw new Error(`unexpected argument ${a}\n${USAGE}`);
  }
  if (!opts.planPath) throw new Error(USAGE);
  return opts;
}

export function repoFromRemote(url) {
  const m = url.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

// ------------------------------------------------------------------ GitHub side

function gh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function ghJson(args) {
  return JSON.parse(gh(args));
}

function readGitHub() {
  try {
    return {
      issues: ghJson(["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,title"]),
      labels: ghJson(["label", "list", "--limit", "500", "--json", "name"]).map((l) => l.name),
      milestones: ghJson(["api", "--paginate", "--slurp", "repos/{owner}/{repo}/milestones?state=all&per_page=100"])
        .flat()
        .map((m) => m.title),
      ok: true,
    };
  } catch (e) {
    return { issues: [], labels: [], milestones: [], ok: false, error: String(e.stderr || e.message).trim() };
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const plan = parsePlan(readFileSync(opts.planPath, "utf8"));
  if (plan.tasks.length === 0) {
    console.error(`no "### Task N:" heading in ${opts.planPath}`);
    process.exit(1);
  }
  let repo = null;
  try {
    repo = repoFromRemote(execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }));
  } catch {
    // no origin: the issue body names the plan file without a link
  }

  const github = readGitHub();
  if (!github.ok) {
    if (!opts.dryRun) {
      console.error(`cannot read GitHub (gh auth login?): ${github.error}`);
      process.exit(1);
    }
    console.log(`(GitHub not readable, showing the plan only: ${github.error.split("\n")[0]})`);
  }
  const milestone = opts.milestone ?? milestoneTitle(plan, github.milestones);
  const issues = plan.tasks.map((t) => issueFor(plan, t, { planPath: opts.planPath, repo }));
  const existing = (title) => {
    const prefix = title.slice(0, title.indexOf(":") + 1);
    return github.issues.find((i) => i.title.startsWith(prefix));
  };

  const mode = opts.dryRun ? "DRY RUN — nothing is created" : "creating";
  console.log(`${titlePrefix(plan)} ${plan.name}: ${plan.tasks.length} task(s), milestone "${milestone}" (${mode})`);
  if (!github.milestones.includes(milestone)) console.log(`  ${opts.dryRun ? "would create" : "create"} milestone "${milestone}"`);
  const neededLabels = [...new Set(issues.flatMap((i) => i.labels))];
  const missingLabels = github.ok ? neededLabels.filter((l) => !github.labels.includes(l)) : [];

  if (!opts.dryRun) {
    const blocking = missingLabels.filter((l) => !l.startsWith("plan:"));
    if (blocking.length) {
      console.error(`missing labels ${blocking.join(", ")}: run scripts/github-bootstrap.sh first`);
      process.exit(1);
    }
    for (const l of missingLabels) gh(["label", "create", l, "--color", "5319e7", "--description", `Plan ${l.slice(5)} task`]);
    if (!github.milestones.includes(milestone))
      gh(["api", "-X", "POST", "repos/{owner}/{repo}/milestones", "-f", `title=${milestone}`]);
  } else if (missingLabels.length) {
    console.log(`  missing labels (bootstrap creates them; plan:N is created here): ${missingLabels.join(", ")}`);
  }

  for (const issue of issues) {
    const found = existing(issue.title);
    if (found) {
      console.log(`  exists        #${found.number} ${found.title}`);
      continue;
    }
    const labels = issue.labels.join(",");
    if (opts.dryRun) {
      console.log(`  would create  ${issue.title}\n                labels: ${labels}${opts.assignMe ? " · assignee: @me" : ""}`);
      continue;
    }
    const args = ["issue", "create", "--title", issue.title, "--body-file", "-", "--milestone", milestone];
    for (const l of issue.labels) args.push("--label", l);
    if (opts.assignMe) args.push("--assignee", "@me");
    console.log(`  created       ${gh(args, issue.body).trim()}  ${issue.title}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
