import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deriveProjectAlias,
  findConfiguredProject,
  normalizeConfiguredProjects,
  normalizeProjectAlias,
  resolveConfiguredProject,
  resolveExplicitConfiguredProject,
  resolveProjectReference,
  sanitizeProjectSpec
} from "./controller-projects.mjs";

test("normalizeConfiguredProjects migrates a legacy single-workspace config", () => {
  const normalized = normalizeConfiguredProjects({
    workspace: "/tmp/example",
    defaultProject: "main"
  });

  assert.equal(normalized.defaultProject, "main");
  assert.equal(normalized.workspace, "/tmp/example");
  assert.equal(normalized.projects.length, 1);
  assert.equal(normalized.projects[0].alias, "main");
  assert.equal(normalized.projects[0].workspace, "/tmp/example");
});

test("normalizeConfiguredProjects collapses duplicate workspaces down to one project", () => {
  const normalized = normalizeConfiguredProjects({
    defaultProject: "main",
    projects: [
      { alias: "retail-dashboard", workspace: "/tmp/retail-dashboard" },
      { alias: "retail-dashboard-2", workspace: "/tmp/retail-dashboard" }
    ]
  });

  assert.equal(normalized.projects.length, 1);
  assert.equal(normalized.projects[0].alias, "retail-dashboard");
  assert.equal(normalized.projects[0].workspace, "/tmp/retail-dashboard");
});

test("resolveConfiguredProject finds aliases and workspace basenames", () => {
  const config = {
    defaultProject: "relay",
    projects: [
      { alias: "relay", workspace: "/tmp/relay" },
      { alias: "alpha-app", workspace: "/tmp/alpha-app" }
    ]
  };

  assert.equal(resolveConfiguredProject(config, "alpha-app")?.workspace, "/tmp/alpha-app");
  assert.equal(resolveConfiguredProject(config, "alpha app")?.workspace, "/tmp/alpha-app");
});

test("findConfiguredProject resolves unique prefixes and existing workspaces", () => {
  const config = {
    defaultProject: "relay",
    projects: [
      { alias: "relay", workspace: "/tmp/relay" },
      { alias: "retail-dashboard", workspace: "/tmp/retail-dashboard" }
    ]
  };

  assert.equal(findConfiguredProject(config, "retail-dash")?.alias, "retail-dashboard");
  assert.equal(
    findConfiguredProject(config, "/tmp/retail-dashboard")?.alias,
    "retail-dashboard"
  );
});

test("resolveExplicitConfiguredProject keeps exact aliases deterministic", () => {
  const config = {
    defaultProject: "main",
    projects: [
      { alias: "sample-service", workspace: "/tmp/sample-service" },
      { alias: "sample-web", workspace: "/tmp/sample-web" }
    ]
  };

  assert.equal(resolveExplicitConfiguredProject(config, "sample-service")?.alias, "sample-service");
  assert.equal(resolveExplicitConfiguredProject(config, "blood")?.alias ?? null, null);
});

test("deriveProjectAlias avoids alias collisions", () => {
  const config = {
    projects: [{ alias: "alpha-app", workspace: "/tmp/alpha-app" }]
  };

  assert.equal(deriveProjectAlias("/tmp/alpha-app", config), "alpha-app-2");
});

test("resolveProjectReference auto-discovers a project from a named home directory", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(homeDir, "repo");
  const codeDir = path.join(homeDir, "code");
  const backendDir = path.join(codeDir, "alpha-app");

  try {
    await fs.mkdir(backendDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    const resolved = await resolveProjectReference(
      { projects: [] },
      "alpha app inside code directory",
      { homeDir, repoRootDir: repoDir }
    );

    assert.equal(resolved?.created, true);
    assert.equal(resolved?.project.workspace, backendDir);
    assert.equal(resolved?.project.alias, "alpha-app");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveProjectReference prefers a pasted absolute path even with WhatsApp formatting noise", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(homeDir, "repo");
  const kioskDir = path.join(homeDir, "code", "retail-kiosk");

  try {
    await fs.mkdir(kioskDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    const resolved = await resolveProjectReference(
      { projects: [] },
      `\u2060[retail-kiosk](${kioskDir})`,
      { homeDir, repoRootDir: repoDir }
    );

    assert.equal(resolved?.created, true);
    assert.equal(resolved?.project.workspace, kioskDir);
    assert.equal(resolved?.project.alias, "retail-kiosk");

    const aliasPlusPath = await resolveProjectReference(
      { projects: [] },
      `retail kiosk ${kioskDir}`,
      { homeDir, repoRootDir: repoDir }
    );

    assert.equal(aliasPlusPath?.created, true);
    assert.equal(aliasPlusPath?.project.workspace, kioskDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveProjectReference returns configured projects without recreating them", async () => {
  const config = {
    defaultProject: "main",
    projects: [
      { alias: "alpha-app", workspace: "/tmp/alpha-app" }
    ]
  };

  const resolved = await resolveProjectReference(config, "alpha-app");

  assert.equal(resolved?.created, false);
  assert.equal(resolved?.project.alias, "alpha-app");
});

test("resolveProjectReference reuses configured workspaces instead of creating alias duplicates", async () => {
  const config = {
    defaultProject: "main",
    projects: [
      { alias: "retail-dashboard", workspace: "/tmp/retail-dashboard" }
    ]
  };

  const resolved = await resolveProjectReference(config, "retail-dash");

  assert.equal(resolved?.created, false);
  assert.equal(resolved?.project.alias, "retail-dashboard");
});

test("resolveProjectReference can skip configured project matching and keep searching locally", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-projects-test-"));
  const homeDir = path.join(tempDir, "home");
  const repoDir = path.join(homeDir, "repo");
  const codeDir = path.join(homeDir, "code");
  const backendDir = path.join(codeDir, "alpha-app");

  try {
    await fs.mkdir(backendDir, { recursive: true });
    await fs.mkdir(repoDir, { recursive: true });

    const resolved = await resolveProjectReference(
      {
        defaultProject: "main",
        projects: [{ alias: "beta-app", workspace: "/tmp/beta-app" }]
      },
      "alpha app inside code directory",
      { homeDir, repoRootDir: repoDir, skipConfiguredSelection: true }
    );

    assert.equal(resolved?.created, true);
    assert.equal(resolved?.project.alias, "alpha-app");
    assert.equal(resolved?.project.workspace, backendDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("normalizeProjectAlias keeps project ids shell-friendly", () => {
  assert.equal(normalizeProjectAlias("Alpha App"), "alpha-app");
  assert.equal(normalizeProjectAlias("api/v2"), "api-v2");
});

test("sanitizeProjectSpec strips invisible characters and unwraps markdown links", () => {
  assert.equal(
    sanitizeProjectSpec("\u2060[retail-dashboard](/tmp/retail-dashboard)"),
    "/tmp/retail-dashboard"
  );
});
