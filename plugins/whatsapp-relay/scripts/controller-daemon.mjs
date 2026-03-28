import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { ControllerConfigStore } from "./controller-config.mjs";
import { WhatsAppControllerBridge } from "./controller-bridge.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const START_RETRY_MS = Number.parseInt(
  process.env.WHATSAPP_CONTROLLER_RETRY_MS ?? "5000",
  10
);
const LOGGED_OUT_RETRY_MS = Number.parseInt(
  process.env.WHATSAPP_CONTROLLER_LOGGED_OUT_RETRY_MS ?? "60000",
  10
);

let activeBridge = null;
let shuttingDown = false;

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

function retryDelayFor(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("logged out") ? LOGGED_OUT_RETRY_MS : START_RETRY_MS;
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

while (!shuttingDown) {
  const { bridge, stateStore } = buildBridge();
  activeBridge = bridge;

  try {
    await bridge.start();
    process.stdout.write("WhatsApp controller bridge started.\n");
    break;
  } catch (error) {
    await bridge.stop().catch(() => {});
    await stateStore.clearProcess().catch(() => {});

    const retryMs = retryDelayFor(error);
    console.error(`failed to start WhatsApp controller bridge: ${error.message}`);
    if (shuttingDown) {
      process.exit(1);
    }

    console.error(
      `Retrying WhatsApp controller bridge startup in ${Math.ceil(retryMs / 1000)}s.`
    );
    await delay(retryMs);
  }
}
