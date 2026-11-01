import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const pluginRoot = path.resolve(scriptDir, "..");
export const repoRoot = path.resolve(pluginRoot, "..", "..");
export const dataDir = process.env.WHATSAPP_DATA_DIR
  ? path.resolve(process.env.WHATSAPP_DATA_DIR)
  : path.join(pluginRoot, "data");
export const authDir = path.join(dataDir, "auth");
export const storeFile = path.join(dataDir, "store.json");
export const historyRequestsFile = path.join(dataDir, "history-requests.json");
export const runtimeFile = path.join(dataDir, "runtime.json");
export const credsFile = path.join(authDir, "creds.json");
export const controllerConfigFile = path.join(dataDir, "controller-config.json");
export const controllerStateFile = path.join(dataDir, "controller-state.json");
export const controllerLogFile = path.join(dataDir, "controller.log");
export const controllerOutboxDir = path.join(dataDir, "controller-outbox");
export const controllerOutboxFailedDir = path.join(dataDir, "controller-outbox.failed");
export const controllerDaemonScript = path.join(scriptDir, "controller-daemon.mjs");
export const scriptsDir = scriptDir;
export const runtimeDaemonScript = path.join(scriptDir, "runtime-daemon.mjs");
export const runtimeDaemonLockFile = path.join(dataDir, "runtime-daemon.json");
export const runtimeDaemonLogFile = path.join(dataDir, "runtime-daemon.log");
// macOS limits Unix socket paths to 104 bytes; long data directories fall back
// to a per-directory name in the private temporary directory.
const preferredSocket = path.join(dataDir, "runtime.sock");
export const runtimeDaemonSocket = Buffer.byteLength(preferredSocket) < 100
  ? preferredSocket
  : path.join(os.tmpdir(), `whatsapp-relay-${createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}.sock`);
export const globalControllerOwnerFile = path.join(
  process.env.HOME ?? repoRoot,
  ".codex",
  "plugins",
  "whatsapp-relay",
  "controller-owner.json"
);

export async function ensureRuntimeDirs() {
  await fs.mkdir(authDir, { recursive: true });
  await fs.mkdir(controllerOutboxDir, { recursive: true });
  await fs.mkdir(controllerOutboxFailedDir, { recursive: true });
}
export const watchesFile = path.join(dataDir, "watches.json");
export const alertsFile = path.join(dataDir, "alerts.jsonl");
export const scheduledFile = path.join(dataDir, "scheduled-messages.json");
export const mediaTextDir = path.join(dataDir, "downloads");
export const bugReportsFile = path.join(dataDir, "bug-reports.jsonl");
