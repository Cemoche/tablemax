import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  areasFor,
  githubAnchor,
  issueFor,
  milestoneTitle,
  parseArgs,
  parsePlan,
  repoFromRemote,
} from "./plan-to-issues.mjs";

const SAMPLE = `# TableMax — Plan 7 : Demo things — Implementation Plan

> intro

### Task 1: Parse \`~/.ssh/config\` et verdicts

**Files:**
- Create: \`src-tauri/src/ssh/config.rs\`
- Modify: \`src/lib/ipc.ts\`

**Interfaces:**
- something

- [ ] **Step 1: Écrire le test qui échoue**
- [ ] **Step 2: Vérifier l'échec** — Run: \`cargo test\` → Expected: FAIL.
- [ ] **Step 3: Implémenter**
- [ ] **Step 4: Vérifier**

Run: \`pnpm test && pnpm lint\`
Expected: PASS.

- [ ] **Step 5: Commit**

### Task 2: Docs only

**Files:**
- Modify: \`docs/notes/x.md\`, \`.github/workflows/ci.yml\`

- [ ] **Step 1: Write**
`;

describe("githubAnchor", () => {
  it("follows GitHub's heading slugs", () => {
    expect(githubAnchor("Task 1: TLS pour PostgreSQL et MySQL/MariaDB")).toBe(
      "task-1-tls-pour-postgresql-et-mysqlmariadb",
    );
    expect(githubAnchor("Task 2: `~/.ssh/config` et verdicts `known_hosts`")).toBe(
      "task-2-sshconfig-et-verdicts-known_hosts",
    );
    expect(githubAnchor("Task 5: Formulaire SSL/SSH et confirmations (frontend)")).toBe(
      "task-5-formulaire-sslssh-et-confirmations-frontend",
    );
    expect(githubAnchor("Task 8: Dialogue d'import et vérification finale")).toBe(
      "task-8-dialogue-dimport-et-vérification-finale",
    );
  });
});

describe("parsePlan", () => {
  it("reads the plan number, name and tasks", () => {
    const plan = parsePlan(SAMPLE);
    expect(plan.number).toBe(7);
    expect(plan.name).toBe("Demo things");
    expect(plan.tasks.map((t) => [t.number, t.title])).toEqual([
      [1, "Parse `~/.ssh/config` et verdicts"],
      [2, "Docs only"],
    ]);
  });

  it("keeps the Files lines and the verification steps, not the failing-test step", () => {
    const [task] = parsePlan(SAMPLE).tasks;
    expect(task.files).toEqual([
      "- Create: `src-tauri/src/ssh/config.rs`",
      "- Modify: `src/lib/ipc.ts`",
    ]);
    expect(task.checks).toEqual(["**Step 4: Vérifier** Run: `pnpm test && pnpm lint` Expected: PASS."]);
  });

  it("parses the real Plan 2 into 8 tasks", () => {
    const md = readFileSync("docs/superpowers/plans/2026-10-17-tablemax-02-connections.md", "utf8");
    const plan = parsePlan(md);
    expect(plan.number).toBe(2);
    expect(plan.tasks).toHaveLength(8);
    expect(plan.tasks.every((t) => t.files.length > 0)).toBe(true);
  });

  it("has no number for a plan without one", () => {
    const plan = parsePlan("# TableMax — Setup de travail en équipe — Implementation Plan\n\n### Task 1: X\n");
    expect(plan.number).toBeNull();
    expect(plan.name).toBe("Setup de travail en équipe");
  });
});

describe("areasFor", () => {
  it("maps paths to area labels", () => {
    expect(areasFor(["- Create: `src-tauri/src/a.rs`", "- Modify: `src/lib/ipc.ts`"])).toEqual([
      "area:backend",
      "area:frontend",
    ]);
    expect(areasFor(["- Modify: `docs/notes/x.md`, `.github/workflows/ci.yml`"])).toEqual([
      "area:docs",
      "area:infra",
    ]);
    expect(areasFor(["- Modify: `docker-compose.test.yml`, `scripts/test-dbs.sh`"])).toEqual(["area:infra"]);
    expect(areasFor([])).toEqual([]);
  });
});

describe("issueFor", () => {
  const plan = parsePlan(SAMPLE);
  const ctx = { planPath: "docs/superpowers/plans/plan-07.md", repo: "acme/tablemax" };

  it("builds title, labels and a body linking to the plan task", () => {
    const issue = issueFor(plan, plan.tasks[0], ctx);
    expect(issue.title).toBe("[Plan 7] Task 1: Parse `~/.ssh/config` et verdicts");
    expect(issue.labels).toEqual(["type:task", "status:ready", "plan:7", "area:backend", "area:frontend"]);
    expect(issue.body).toContain(
      "https://github.com/acme/tablemax/blob/main/docs/superpowers/plans/plan-07.md#task-1-parse-sshconfig-et-verdicts",
    );
    expect(issue.body).toContain("- Create: `src-tauri/src/ssh/config.rs`");
    expect(issue.body).toContain("- [ ] **Step 4: Vérifier** Run: `pnpm test && pnpm lint` Expected: PASS.");
    expect(issue.body).toContain("- [ ] `pnpm test && pnpm lint` green");
  });

  it("uses the plan name when the plan has no number", () => {
    const unnumbered = parsePlan("# TableMax — Team setup — Implementation Plan\n\n### Task 3: Skills\n");
    const issue = issueFor(unnumbered, unnumbered.tasks[0], { planPath: "p.md", repo: null });
    expect(issue.title).toBe("[Team setup] Task 3: Skills");
    expect(issue.labels).toEqual(["type:task", "status:ready"]);
    expect(issue.body).toContain("`p.md`");
  });
});

describe("milestoneTitle", () => {
  it("reuses an existing milestone of the same plan number", () => {
    const plan = parsePlan(SAMPLE);
    expect(milestoneTitle(plan, ["Plan 7 — Demo", "Post-v1"])).toBe("Plan 7 — Demo");
    expect(milestoneTitle(plan, ["Plan 70 — Other"])).toBe("Plan 7 — Demo things");
  });
});

describe("parseArgs", () => {
  it("reads the plan file and flags", () => {
    expect(parseArgs(["p.md", "--dry-run", "--assign-me"])).toEqual({
      planPath: "p.md",
      dryRun: true,
      assignMe: true,
      milestone: null,
    });
    expect(parseArgs(["--milestone", "M", "p.md"]).milestone).toBe("M");
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["p.md", "--bogus"])).toThrow(/unknown option/);
    // an option value never swallows a flag (the allow rule relies on a trailing --dry-run)
    expect(() => parseArgs(["p.md", "--milestone", "--dry-run"])).toThrow(/needs a title/);
    expect(() => parseArgs(["p.md", "--milestone"])).toThrow(/needs a title/);
  });
});

describe("repoFromRemote", () => {
  it("reads owner/repo from ssh and https remotes", () => {
    expect(repoFromRemote("git@github.com:Cemoche/tablemax.git")).toBe("Cemoche/tablemax");
    expect(repoFromRemote("https://github.com/Cemoche/tablemax")).toBe("Cemoche/tablemax");
    expect(repoFromRemote("/some/local/path")).toBeNull();
  });
});
