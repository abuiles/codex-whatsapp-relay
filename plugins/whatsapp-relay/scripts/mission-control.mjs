import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const DEFAULT_MISSION_SKILL_NAME = "erp-mission-team";
const DEFAULT_GIT_TIMEOUT_MS = 20_000;
const DEFAULT_BRANCH_CHOICE_LIMIT = 8;

function codexHome() {
  return String(process.env.CODEX_HOME ?? "").trim() || path.join(os.homedir(), ".codex");
}

export function missionSkillPath(skillName = DEFAULT_MISSION_SKILL_NAME) {
  return path.join(codexHome(), "skills", skillName, "SKILL.md");
}

export function slugifyMissionText(value, fallback = "mission") {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/-+$/g, "");

  return slug || fallback;
}

export function buildMissionBranchName({
  projectAlias,
  objective,
  now = new Date()
}) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/u, "z");
  return `codex/mission-${slugifyMissionText(projectAlias, "project")}-${stamp}-${slugifyMissionText(objective)}`;
}

function parseLocalBranchList(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, updated] = line.split("\t");
      return {
        name: String(name ?? "").trim(),
        updated: String(updated ?? "").trim() || null
      };
    })
    .filter((branch) => branch.name);
}

async function runGit(args, { cwd, timeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr
      });
    });
  });
}

function gitFailure(result, args) {
  return new Error(
    result.stderr.trim() ||
      result.stdout.trim() ||
      (result.signal
        ? `git ${args.join(" ")} exited with signal ${result.signal}.`
        : `git ${args.join(" ")} exited with code ${result.code}.`)
  );
}

async function requireGitSuccess(args, options) {
  const result = await runGit(args, options);
  if (result.code !== 0) {
    throw gitFailure(result, args);
  }
  return result.stdout.trim();
}

export async function prepareMissionBranch({
  workspace,
  projectAlias,
  objective,
  now = new Date(),
  branchMode = "new",
  branchName = null
}) {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: workspace });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(`Workspace is not a Git repository: ${workspace}`);
  }

  const previousBranch =
    (await requireGitSuccess(["branch", "--show-current"], { cwd: workspace })) ||
    "detached-head";
  const status = await requireGitSuccess(["status", "--porcelain"], { cwd: workspace });
  const dirtyCount = status ? status.split(/\r?\n/u).filter(Boolean).length : 0;

  if (branchMode === "current") {
    return {
      branchName: previousBranch,
      previousBranch,
      dirtyCount,
      branchMode
    };
  }

  if (branchMode === "existing") {
    const targetBranch = String(branchName ?? "").trim();
    if (!targetBranch) {
      throw new Error("Missing existing branch name for mission.");
    }
    if (targetBranch !== previousBranch) {
      await requireGitSuccess(["switch", targetBranch], { cwd: workspace });
    }
    return {
      branchName: targetBranch,
      previousBranch,
      dirtyCount,
      branchMode
    };
  }

  const targetBranch =
    String(branchName ?? "").trim() ||
    buildMissionBranchName({
      projectAlias,
      objective,
      now
    });

  await requireGitSuccess(["switch", "-c", targetBranch], { cwd: workspace });

  return {
    branchName: targetBranch,
    previousBranch,
    dirtyCount,
    branchMode: "new"
  };
}

export async function listMissionBranchChoices({
  workspace,
  projectAlias,
  objective,
  now = new Date(),
  limit = DEFAULT_BRANCH_CHOICE_LIMIT
}) {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: workspace });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(`Workspace is not a Git repository: ${workspace}`);
  }

  const currentBranch =
    (await requireGitSuccess(["branch", "--show-current"], { cwd: workspace })) ||
    "detached-head";
  const status = await requireGitSuccess(["status", "--porcelain"], { cwd: workspace });
  const dirtyCount = status ? status.split(/\r?\n/u).filter(Boolean).length : 0;
  const newBranchName = buildMissionBranchName({
    projectAlias,
    objective,
    now
  });
  const branchOutput = await requireGitSuccess(
    [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)%09%(committerdate:relative)",
      "refs/heads"
    ],
    { cwd: workspace }
  );
  const recentBranches = parseLocalBranchList(branchOutput)
    .filter((branch) => branch.name !== currentBranch)
    .slice(0, Math.max(0, limit - 2));
  const choices = [
    {
      index: 1,
      mode: "current",
      branchName: currentBranch,
      fromBranch: currentBranch,
      label: "Continue on current branch"
    },
    {
      index: 2,
      mode: "new",
      branchName: newBranchName,
      fromBranch: currentBranch,
      label: "Create a new mission branch from current branch"
    },
    ...recentBranches.map((branch, index) => ({
      index: index + 3,
      mode: "existing",
      branchName: branch.name,
      fromBranch: currentBranch,
      updated: branch.updated,
      label: "Switch to existing local branch"
    }))
  ];

  return {
    currentBranch,
    dirtyCount,
    choices
  };
}

export function buildMissionPrompt({
  projectAlias,
  workspace,
  objective,
  branchName,
  previousBranch,
  dirtyCount = 0,
  branchMode = "new",
  continuesExistingThread = true,
  skillPath = missionSkillPath()
}) {
  return [
    `Use $erp-mission-team at ${skillPath} to run an autonomous ERP mission.`,
    "",
    `Project: ${projectAlias}`,
    `Workspace: ${workspace}`,
    `Mission branch: ${branchName}`,
    `Previous branch: ${previousBranch}`,
    `Branch strategy: ${branchMode}`,
    `Dirty working-tree entries carried into the mission branch: ${dirtyCount}`,
    "",
    "Session context:",
    continuesExistingThread
      ? "This mission is appended to the existing Codex project thread. Reuse prior conversation context, especially recent commande/order-section work and cockpit-oriented product decisions. Do not restart from zero unless the thread lacks the needed context."
      : "This mission starts without an existing project thread. Rebuild only the minimum useful context from the repository before changing code.",
    "",
    "Depth expectation:",
    "Treat broad ERP objectives as broad missions by default. Do not shrink a request about immature sections, multiple sections, or the ERP as a whole into a tiny 1-2 screen pass unless there is a real blocker or high regression risk.",
    "Before editing, build a maturity matrix that compares obvious ERP sections against the Commande benchmark. Then implement a coherent wave across the highest-leverage immature sections, preferably at least three meaningful sections when feasible.",
    "If fewer than three sections are changed, explicitly explain the blocker or tradeoff in the final report and propose the next continuation command.",
    "",
    "Mission objective:",
    objective,
    "",
    "Product direction:",
    "The order/commande section is a benchmark for the ERP's cockpit-oriented operator experience, not the only target. Inspect the broader ERP and identify where the same operator-first, business-cockpit approach can create the most value.",
    "",
    "Operating rules:",
    "- Stay on the provided mission branch.",
    "- Do not push, publish, deploy, or rewrite history.",
    "- Prefer reversible waves of changes over broad rewrites, but do not confuse reversibility with doing too little.",
    "- Do not wait for more user input unless the mission is genuinely blocked.",
    "- Run the relevant checks before finishing, or explain why they could not run.",
    "",
    "Final report:",
    "Return a concise WhatsApp-friendly report with branch name, Commande benchmark summary, maturity matrix or compact coverage summary, sections inspected, sections changed, checks run, remaining risks, and the recommended next step.",
    "Include a final section named 'Skills to extract' that summarizes the recurring skills, roles, or judgment patterns used during the mission. Highlight only the ones that were used repeatedly or would be worth turning into a dedicated future agent/skill."
  ].join("\n");
}
