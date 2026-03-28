import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  controllerOutboxDir,
  controllerOutboxFailedDir,
  ensureRuntimeDirs
} from "./paths.mjs";

function commandFileName(id) {
  return `${id}.json`;
}

function failedCommandFileName(id) {
  return `${id}.failed.json`;
}

function errorSummary(error) {
  return {
    message: error?.message ?? String(error),
    name: error?.name ?? "Error"
  };
}

function isRetryableControllerCommandError(error) {
  if (error?.retryable === true) {
    return true;
  }

  if (error?.retryable === false || error?.permanent === true) {
    return false;
  }

  return error?.code !== "ERR_CONTROLLER_COMMAND_INVALID";
}

async function quarantineFailedCommand(command, error, failedDir) {
  const failedCommand = {
    ...command,
    failedAt: new Date().toISOString(),
    error: errorSummary(error)
  };
  const finalPath = path.join(
    failedDir,
    failedCommandFileName(command.id ?? crypto.randomUUID())
  );
  const tempPath = path.join(
    failedDir,
    `.${path.basename(finalPath)}.${crypto.randomUUID()}.tmp`
  );

  await fs.writeFile(tempPath, JSON.stringify(failedCommand, null, 2));
  await fs.rename(tempPath, finalPath);
}

export async function enqueueControllerCommand(
  { type, payload },
  { outboxDir = controllerOutboxDir } = {}
) {
  if (!type) {
    throw new Error("Controller command type is required.");
  }

  await ensureRuntimeDirs();

  const id = `${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
  const command = {
    id,
    type,
    payload: payload ?? {},
    createdAt: new Date().toISOString()
  };

  const finalPath = path.join(outboxDir, commandFileName(id));
  const tempPath = path.join(
    outboxDir,
    `.${commandFileName(id)}.${crypto.randomUUID()}.tmp`
  );

  await fs.writeFile(tempPath, JSON.stringify(command, null, 2));
  await fs.rename(tempPath, finalPath);

  return command;
}

export async function drainControllerCommands(
  handler,
  {
    outboxDir = controllerOutboxDir,
    failedDir = controllerOutboxFailedDir
  } = {}
) {
  await ensureRuntimeDirs();

  const entries = await fs.readdir(outboxDir, {
    withFileTypes: true
  });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  for (const file of files) {
    const filePath = path.join(outboxDir, file);
    let command = null;

    try {
      command = JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch {
      await fs.unlink(filePath).catch(() => {});
      continue;
    }

    try {
      await handler(command);
      await fs.unlink(filePath).catch(() => {});
    } catch (error) {
      if (isRetryableControllerCommandError(error)) {
        break;
      }

      await quarantineFailedCommand(command, error, failedDir);
      await fs.unlink(filePath).catch(() => {});
    }
  }
}
