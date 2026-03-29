import process from "node:process";

import { ControllerConfigStore } from "./controller-config.mjs";
import { WhatsAppControllerBridge } from "./controller-bridge.mjs";
import {
  claimGlobalControllerOwner,
  releaseGlobalControllerOwner
} from "./controller-owner.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

let activeBridge = null;
let shuttingDown = false;
let ownsGlobalController = false;

function buildBridge() {
  const runtime = new WhatsAppRuntime({
    logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn"
  });
  const configStore = new ControllerConfigStore();
  const stateStore = new ControllerStateStore();
  const bridge = new WhatsAppControllerBridge({
    runtime,
    configStore,
    stateStore
  });

  return {
    bridge,
    stateStore
  };
}

async function shutdown(code = 0) {
  shuttingDown = true;

  if (activeBridge) {
    try {
      await activeBridge.stop();
    } catch (error) {
      console.error("failed to stop WhatsApp controller bridge cleanly", error);
    }
  }

  if (ownsGlobalController) {
    await releaseGlobalControllerOwner().catch((error) => {
      console.error("failed to release WhatsApp controller ownership", error);
    });
    ownsGlobalController = false;
  }

  process.exit(code);
}

process.on("SIGTERM", () => {
  shutdown(0).catch((error) => {
    console.error("failed to shut down WhatsApp controller bridge", error);
    process.exit(1);
  });
});

process.on("SIGINT", () => {
  shutdown(0).catch((error) => {
    console.error("failed to shut down WhatsApp controller bridge", error);
    process.exit(1);
  });
});

const { bridge, stateStore } = buildBridge();
activeBridge = bridge;

try {
  const ownership = await claimGlobalControllerOwner();
  if (!ownership.acquired) {
    const ownerRepo = ownership.owner?.repoRoot ?? "another checkout";
    throw new Error(
      `WhatsApp controller is already running from ${ownerRepo} (pid ${ownership.owner?.pid ?? "unknown"}). Stop that bridge before starting another one.`
    );
  }

  ownsGlobalController = true;
  await bridge.start();
  process.stdout.write("WhatsApp controller bridge started.\n");
} catch (error) {
  await bridge.stop().catch(() => {});
  if (ownsGlobalController) {
    await releaseGlobalControllerOwner().catch(() => {});
    ownsGlobalController = false;
  }
  await stateStore.clearProcess().catch(() => {});

  if (!shuttingDown) {
    console.error(`failed to start WhatsApp controller bridge: ${error.message}`);
  }

  process.exit(shuttingDown ? 0 : 1);
}
