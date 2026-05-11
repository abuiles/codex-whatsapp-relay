import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMissionBranchName,
  buildMissionPrompt,
  slugifyMissionText
} from "./mission-control.mjs";

test("slugifyMissionText keeps mission names branch-safe", () => {
  assert.equal(
    slugifyMissionText("Cockpit metier / commandes & clients"),
    "cockpit-metier-commandes-clients"
  );
  assert.equal(slugifyMissionText("!!!", "fallback"), "fallback");
});

test("buildMissionBranchName includes project, timestamp, and objective", () => {
  const branchName = buildMissionBranchName({
    projectAlias: "erp-mvp",
    objective: "Approche cockpit operateur",
    now: new Date("2026-04-24T08:09:10.123Z")
  });

  assert.equal(
    branchName,
    "codex/mission-erp-mvp-20260424T080910z-approche-cockpit-operateur"
  );
});

test("buildMissionPrompt frames the ERP cockpit mission", () => {
  const prompt = buildMissionPrompt({
    projectAlias: "erp-mvp",
    workspace: "C:/repo/erp",
    objective: "Improve the next high-leverage section.",
    branchName: "codex/mission-erp",
    previousBranch: "main",
    dirtyCount: 2,
    skillPath: "C:/Users/example/.codex/skills/erp-mission-team/SKILL.md"
  });

  assert.match(prompt, /\$erp-mission-team/);
  assert.match(prompt, /Mission branch: codex\/mission-erp/);
  assert.match(prompt, /Branch strategy: new/);
  assert.match(prompt, /appended to the existing Codex project thread/);
  assert.match(prompt, /Reuse prior conversation context/);
  assert.match(prompt, /Depth expectation:/);
  assert.match(prompt, /maturity matrix/);
  assert.match(prompt, /preferably at least three meaningful sections/);
  assert.match(prompt, /commande section is a benchmark/);
  assert.match(prompt, /Do not push/);
  assert.match(prompt, /do not confuse reversibility with doing too little/);
  assert.match(prompt, /Dirty working-tree entries carried into the mission branch: 2/);
  assert.match(prompt, /Skills to extract/);
});

test("buildMissionPrompt can frame a fresh mission thread", () => {
  const prompt = buildMissionPrompt({
    projectAlias: "erp-mvp",
    workspace: "C:/repo/erp",
    objective: "Improve the next high-leverage section.",
    branchName: "codex/mission-erp",
    previousBranch: "main",
    continuesExistingThread: false
  });

  assert.match(prompt, /starts without an existing project thread/);
  assert.match(prompt, /Rebuild only the minimum useful context/);
});
