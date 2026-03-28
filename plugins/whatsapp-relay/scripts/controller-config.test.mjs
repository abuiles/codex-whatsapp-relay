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
