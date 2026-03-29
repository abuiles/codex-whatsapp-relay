import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { ControllerConfigStore } from "./controller-config.mjs";
import { getGlobalControllerOwner } from "./controller-owner.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import {
  controllerDaemonScript,
  controllerLogFile,
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

export function controllerDaemonEnv(config = {}, baseEnv = process.env) {
  return {
    ...baseEnv,
    WHATSAPP_RELAY_TTS_PROVIDER: config.ttsProvider ?? "system",
    WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH:
      config.ttsChatterboxAllowNonEnglish ? "1" : "0"
  };
}

export async function getControllerProcessStatus() {
  const stateStore = new ControllerStateStore();
  await stateStore.load();
  const processState = stateStore.data.process;
  const running = isPidRunning(processState.pid);

  if (!running && processState.pid) {
    await stateStore.clearProcess();
  }

  return {
    running,
    pid: running ? processState.pid : null,
    process: running ? processState : stateStore.data.process,
    sessions: stateStore.listSessions()
  };
}

export async function startControllerDaemon() {
  const current = await getControllerProcessStatus();
  if (current.running) {
    return current;
  }

  const globalOwner = await getGlobalControllerOwner();
  if (globalOwner && globalOwner.pid !== current.pid) {
    throw new Error(
      `WhatsApp controller is already running from ${globalOwner.repoRoot} (pid ${globalOwner.pid}). Stop that bridge before starting another checkout.`
    );
  }

  const configStore = new ControllerConfigStore();
  const config = await configStore.load();
  const logHandle = await fs.open(controllerLogFile, "a");
  const child = spawn(process.execPath, [controllerDaemonScript], {
    cwd: repoRoot,
    detached: true,
    env: controllerDaemonEnv(config),
    stdio: ["ignore", logHandle.fd, logHandle.fd]
  });

  child.unref();
  await logHandle.close();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250);
    const status = await getControllerProcessStatus();
    if (status.running && status.pid === child.pid) {
      return status;
    }
  }

  throw new Error(
    `Controller bridge did not report healthy startup. Check ${controllerLogFile}.`
  );
}

export async function stopControllerDaemon() {
  const stateStore = new ControllerStateStore();
  const current = await getControllerProcessStatus();
  if (!current.pid) {
    return current;
  }

  try {
    process.kill(current.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(250);
    const status = await getControllerProcessStatus();
    if (!status.running) {
      return status;
    }
  }

  try {
    process.kill(current.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }

  await stateStore.clearProcess();
  return getControllerProcessStatus();
}
