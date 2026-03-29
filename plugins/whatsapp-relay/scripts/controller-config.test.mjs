import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ControllerConfigStore } from "./controller-config.mjs";

test("ControllerConfigStore defaults to multilingual Chatterbox for new configs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.ttsProvider, "chatterbox-turbo");
    assert.equal(config.ttsChatterboxAllowNonEnglish, true);
    assert.equal(config.defaultProject, "main");
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].alias, "main");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore normalizes boolean-like non-English overrides from disk", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabled: true,
        ttsProvider: "chatterbox",
        ttsChatterboxAllowNonEnglish: "false",
        allowedControllers: []
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.ttsProvider, "chatterbox-turbo");
    assert.equal(config.ttsChatterboxAllowNonEnglish, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerConfigStore migrates a legacy single-workspace config into projects", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-config-test-"));
  const filePath = path.join(tempDir, "controller-config.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        enabled: true,
        workspace: "/tmp/alpha-app",
        model: "gpt-5.4",
        allowedControllers: []
      }),
      "utf8"
    );

    const store = new ControllerConfigStore(filePath);
    const config = await store.load();

    assert.equal(config.defaultProject, "main");
    assert.equal(config.workspace, "/tmp/alpha-app");
    assert.equal(config.projects.length, 1);
    assert.equal(config.projects[0].alias, "main");
    assert.equal(config.projects[0].workspace, "/tmp/alpha-app");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
