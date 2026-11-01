// Reports the live session state without opening a second WhatsApp socket:
// the relay runtime daemon (or the controller bridge) is the only owner.
import { setTimeout as delay } from "node:timers/promises";

import { ControllerConfigStore } from "./controller-config.mjs";
import { getControllerProcessStatus } from "./controller-process.mjs";
import { daemonRequest } from "./daemon-client.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";

const runtime = new WhatsAppRuntime({ logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "error" });
const controllerConfigStore = new ControllerConfigStore();
const write = line => process.stdout.write(`${line}\n`);

if (!runtime.hasSavedCreds()) {
  write("status: not_authenticated");
  write("next: use `whatsapp_start_auth` in Codex or run `npm run whatsapp:auth`");
  process.exit(0);
}

const [controllerConfig, controllerProcessStatus] = await Promise.all([
  controllerConfigStore.load(),
  getControllerProcessStatus()
]);

if (controllerConfig.enabled && controllerProcessStatus.running) {
  write(`status: ${controllerProcessStatus.process.whatsappStatus ?? "connected_via_bridge"}`);
  write("live_session_owner: controller_bridge");
  if (controllerProcessStatus.process.whatsappUserId) write(`user: ${controllerProcessStatus.process.whatsappUserId}`);
  if (controllerProcessStatus.process.whatsappLastDisconnect?.label) {
    write(`last_disconnect: ${controllerProcessStatus.process.whatsappLastDisconnect.label}`);
  }
  process.exit(0);
}

let status;
try {
  const deadline = Date.now() + 20_000;
  do {
    status = await daemonRequest("status", {}, { timeoutMs: 5_000 });
    if (status.status === "connected" || status.released || status.status === "logged_out") break;
    await delay(500);
  } while (Date.now() < deadline);
} catch (error) {
  write("status: runtime_daemon_unavailable");
  write(`error: ${error.message}`);
  process.exit(1);
}

write(`status: ${status.status}`);
write(`runtime_daemon_pid: ${status.pid}`);
if (status.user?.id) write(`user: ${status.user.id}`);
if (status.released) write(`live_session_released: ${status.released.reason}${status.released.ownerPid ? ` (pid ${status.released.ownerPid})` : ""}`);
if (status.lastDisconnect?.label) write(`last_disconnect: ${status.lastDisconnect.label}`);
if (status.status !== "connected" && !status.released) {
  write("next: call `whatsapp_reconnect` in Codex, or rerun `npm run whatsapp:auth` if the session was logged out");
}
process.exit(status.status === "connected" ? 0 : 1);
