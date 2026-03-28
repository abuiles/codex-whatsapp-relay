import fs from "node:fs/promises";
import path from "node:path";

import { resolvePermissionLevel } from "./controller-permissions.mjs";
import { authDir, controllerConfigFile, repoRoot } from "./paths.mjs";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D+/g, "");
}

export function normalizeControllerNumber(value) {
  const phoneKey = digitsOnly(value);
  if (!phoneKey) {
    throw new Error("Controller number must include at least one digit.");
  }

  return {
    phoneKey,
    number: String(value).trim().startsWith("+") ? `+${phoneKey}` : phoneKey
  };
}

export function phoneKeyFromJid(remoteJid) {
  const match = String(remoteJid ?? "").match(/^(\d+)/);
  return match?.[1] ?? null;
}

async function readLidReverseMapping(lid) {
  const mappingPath = path.join(authDir, `lid-mapping-${lid}_reverse.json`);
  try {
    const raw = await fs.readFile(mappingPath, "utf8");
    const resolved = digitsOnly(JSON.parse(raw));
    return resolved || null;
  } catch {
    return null;
  }
}

export async function resolvePhoneKeyFromJid(remoteJid) {
  const jid = String(remoteJid ?? "").trim();
  if (!jid) {
    return null;
  }

  const directMatch = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/i);
  if (directMatch) {
    return directMatch[1];
  }

  const lidMatch = jid.match(/^(\d+)(?::\d+)?@(lid|hosted\.lid)$/i);
  if (lidMatch) {
    return readLidReverseMapping(lidMatch[1]);
  }

  return phoneKeyFromJid(jid);
}

function defaultConfig() {
  return {
    enabled: false,
    workspace: repoRoot,
    codexBin: "codex",
    model: null,
    profile: null,
    permissionLevel: "workspace-write",
    search: false,
    captureAllDirectMessages: true,
    allowedControllers: []
  };
}

function normalizeConfig(config = {}) {
  const merged = {
    ...defaultConfig(),
    ...config
  };

  delete merged.fullAuto;
  merged.permissionLevel = resolvePermissionLevel(merged.permissionLevel);

  const seen = new Set();
  merged.allowedControllers = (merged.allowedControllers ?? [])
    .map((controller) => {
      const { phoneKey, number } = normalizeControllerNumber(
        controller.number ?? controller.phoneKey
      );
      return {
        phoneKey,
        number,
        label: controller.label ?? null,
        addedAt: controller.addedAt ?? new Date().toISOString()
      };
    })
    .filter((controller) => {
      if (seen.has(controller.phoneKey)) {
        return false;
      }
      seen.add(controller.phoneKey);
      return true;
    });

  return merged;
}

export class ControllerConfigStore {
  constructor(filePath = controllerConfigFile) {
    this.filePath = filePath;
    this.data = defaultConfig();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = normalizeConfig(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      this.data = defaultConfig();
    }

    return this.data;
  }

  async save() {
    this.data = normalizeConfig(this.data);
    const tempFile = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tempFile, JSON.stringify(this.data, null, 2));
    await fs.rename(tempFile, this.filePath);
    return this.data;
  }

  async mutate(mutator) {
    const run = this.queue.then(async () => {
      await this.load();
      await mutator(this.data);
      return this.save();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async update(partial = {}) {
    return this.mutate((data) => {
      this.data = normalizeConfig({
        ...data,
        ...partial
      });
    });
  }

  async allowController({ number, label = null }) {
    const { phoneKey, number: normalizedNumber } = normalizeControllerNumber(number);
    return this.mutate((data) => {
      const existingIndex = data.allowedControllers.findIndex(
        (controller) => controller.phoneKey === phoneKey
      );
      const nextController = {
        phoneKey,
        number: normalizedNumber,
        label,
        addedAt:
          existingIndex >= 0
            ? data.allowedControllers[existingIndex].addedAt
            : new Date().toISOString()
      };

      if (existingIndex >= 0) {
        data.allowedControllers[existingIndex] = nextController;
      } else {
        data.allowedControllers.push(nextController);
      }

      this.data = normalizeConfig(data);
      return nextController;
    }).then(() =>
      this.data.allowedControllers.find((controller) => controller.phoneKey === phoneKey)
    );
  }

  async revokeController(number) {
    const { phoneKey } = normalizeControllerNumber(number);
    let removed = false;
    await this.mutate((data) => {
      const before = data.allowedControllers.length;
      data.allowedControllers = data.allowedControllers.filter(
        (controller) => controller.phoneKey !== phoneKey
      );
      removed = before !== data.allowedControllers.length;
      this.data = normalizeConfig(data);
    });
    return removed;
  }

  async findControllerByJid(remoteJid) {
    const phoneKey = await resolvePhoneKeyFromJid(remoteJid);
    if (!phoneKey) {
      return null;
    }

    await this.load();
    return (
      this.data.allowedControllers.find((controller) => controller.phoneKey === phoneKey) ??
      null
    );
  }
}
