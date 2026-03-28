import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  drainControllerCommands,
  enqueueControllerCommand
} from "./controller-outbox.mjs";

test("drainControllerCommands quarantines failed commands instead of leaving poison pills behind", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-outbox-test-"));
  const outboxDir = path.join(tempDir, "outbox");
  const failedDir = path.join(tempDir, "failed");

  await fs.mkdir(outboxDir, { recursive: true });
  await fs.mkdir(failedDir, { recursive: true });

  try {
    const command = await enqueueControllerCommand(
      {
        type: "send_message",
        payload: {
          chatId: "573017169679@s.whatsapp.net",
          text: "hello"
        }
      },
      { outboxDir }
    );

    await drainControllerCommands(
      async () => {
        throw new Error("simulated send failure");
      },
      { outboxDir, failedDir }
    );

    const pendingFiles = await fs.readdir(outboxDir);
    assert.equal(pendingFiles.length, 0);

    const failedFiles = await fs.readdir(failedDir);
    assert.equal(failedFiles.length, 1);

    const failedCommand = JSON.parse(
      await fs.readFile(path.join(failedDir, failedFiles[0]), "utf8")
    );
    assert.equal(failedCommand.id, command.id);
    assert.equal(failedCommand.error.message, "simulated send failure");
    assert.ok(failedCommand.failedAt);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
