import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  globalControllerOwnerFile,
  pluginRoot,
  repoRoot
} from "./paths.mjs";

function isPidRunning(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readControllerOwner(filePath = globalControllerOwnerFile) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function getGlobalControllerOwner(filePath = globalControllerOwnerFile) {
  const owner = await readControllerOwner(filePath);
  if (!owner?.pid) {
    return null;
  }

  if (!isPidRunning(owner.pid)) {
    await fs.rm(filePath, { force: true }).catch(() => {});
    return null;
  }

  return owner;
}

export async function claimGlobalControllerOwner(
  {
    pid = process.pid,
    repoRootPath = repoRoot,
    pluginRootPath = pluginRoot,
    startedAt = new Date().toISOString()
  } = {},
  filePath = globalControllerOwnerFile
) {
  const owner = {
    pid,
    repoRoot: repoRootPath,
    pluginRoot: pluginRootPath,
    startedAt
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(filePath, JSON.stringify(owner, null, 2), {
        flag: "wx"
      });
      return {
        acquired: true,
        owner
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const existingOwner = await getGlobalControllerOwner(filePath);
      if (!existingOwner) {
        continue;
      }

      if (existingOwner.pid === pid) {
        return {
          acquired: true,
          owner: existingOwner
        };
      }

      return {
        acquired: false,
        owner: existingOwner
      };
    }
  }

  return {
    acquired: false,
    owner: null
  };
}

export async function releaseGlobalControllerOwner(
  { pid = process.pid } = {},
  filePath = globalControllerOwnerFile
) {
  const owner = await readControllerOwner(filePath);
  if (!owner) {
    return false;
  }

  if (owner.pid !== pid && isPidRunning(owner.pid)) {
    return false;
  }

  await fs.rm(filePath, { force: true }).catch(() => {});
  return true;
}
