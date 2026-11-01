// The single owner of the live WhatsApp linked-device socket on this machine.
// WhatsApp allows one live socket per linked device; every MCP worker (Codex
// starts one per thread) proxies tool calls here instead of opening its own,
// which would replace the others' connections (DisconnectReason.connectionReplaced).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { ControllerConfigStore } from "./controller-config.mjs";
import { getControllerProcessStatus } from "./controller-process.mjs";
import { ensureRuntimeDirs, runtimeDaemonLockFile, runtimeDaemonSocket, scriptsVersion } from "./paths.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";
import { ScheduledStore } from "./scheduler.mjs";
import { AlertEngine, WatchStore } from "./watch-rules.mjs";
import { createWhatsAppService } from "./whatsapp-service.mjs";

const WATCH_INTERVAL_MS = 5_000;
const IDLE_EXIT_MS = Number(process.env.WHATSAPP_DAEMON_IDLE_MS ?? 10 * 60_000);
const BRIDGE_HANDOVER_MS = 60_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// undefined: no lock file; null: unreadable (corrupt) lock file.
function readLock() {
  let text;
  try {
    text = fs.readFileSync(runtimeDaemonLockFile, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The lock is written to a private file and hard-linked into place, so it
// appears with its full contents; a racing daemon never reads it half-written
// and mistakes it for a stale lock.
function acquireLock() {
  const draft = `${runtimeDaemonLockFile}.${process.pid}`;
  fs.writeFileSync(draft, JSON.stringify({ pid: process.pid, socket: runtimeDaemonSocket, startedAt: new Date().toISOString() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.linkSync(draft, runtimeDaemonLockFile);
        return true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readLock();
        if (owner === undefined) continue;
        if (owner && pidAlive(owner.pid)) return false;
        fs.rmSync(runtimeDaemonLockFile, { force: true });
      }
    }
    return false;
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

await ensureRuntimeDirs();
if (!acquireLock()) {
  console.error(`runtime daemon already running (pid ${readLock()?.pid}); exiting`);
  process.exit(0);
}

const runtime = new WhatsAppRuntime({ logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn", reconnectOnReplaced: true });
const controllerConfigStore = new ControllerConfigStore();
await runtime.initialize();

// While another process (bridge, QR CLI) holds the linked device, this daemon
// must not reconnect: two sockets would keep replacing each other.
let released = null; // { reason, ownerPid?, expiresAt? }
let inFlight = 0;
let lastActivity = Date.now();
let shuttingDown = false;
const bootVersion = scriptsVersion();

function releasedReason() {
  if (!released) return null;
  const owner = released.ownerPid ? ` (pid ${released.ownerPid})` : "";
  return `the live session was handed to another process${owner}: ${released.reason}`;
}

async function bridgeOwnsSession() {
  const [config, status] = await Promise.all([controllerConfigStore.load(), getControllerProcessStatus()]);
  return config.enabled && status.running;
}

async function release({ ownerPid, reason = "released", ttlMs } = {}) {
  released = { reason, ownerPid, expiresAt: ttlMs ? Date.now() + ttlMs : undefined };
  await runtime.stop();
}

// One instance each, shared by the tools and the background loops, so a rule
// added through a tool is the same object the engine reads.
const watches = new WatchStore();
const scheduled = new ScheduledStore();

const service = createWhatsAppService({
  runtime,
  controllerConfigStore,
  watches,
  scheduled,
  mode: "daemon",
  session: {
    blockedReason: releasedReason,
    async beforeBridgeStart() {
      await release({ reason: "controller_bridge_starting", ttlMs: BRIDGE_HANDOVER_MS });
    },
    afterBridgeStart(processStatus) {
      if (processStatus?.pid) released = { reason: "controller_bridge", ownerPid: processStatus.pid };
    },
    async afterBridgeStop() {
      released = null;
      await autoConnect();
    },
    async reconnect() {
      released = null;
    }
  }
});

// A single 440 is retried by the runtime itself; only a repeated one (another
// owner keeps taking the device) holds until an explicit whatsapp_reconnect.
function canAutoConnect() {
  return runtime.hasSavedCreds() && !released && !runtime.state.reconnectHeld &&
    !["connected", "connecting", "awaiting_qr_scan", "logged_out"].includes(runtime.state.status);
}

// The watcher respects the runtime's backoff; a tool call skips the wait,
// because someone is asking for fresh data right now.
async function autoConnect({ skipBackoff = false } = {}) {
  if (!canAutoConnect() || (!skipBackoff && runtime.reconnectPending()) || await bridgeOwnsSession()) return;
  runtime.start().catch(error => console.error(`[${new Date().toISOString()}] auto-connect failed: ${error.message}`));
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[${new Date().toISOString()}] runtime daemon exiting: ${reason}`);
  server.close();
  try { await runtime.stop(); } catch {}
  try { await runtime.historyRequests.writes; } catch {}
  // A daemon that lost the lock must not delete the winner's socket.
  if (readLock()?.pid === process.pid) {
    fs.rmSync(runtimeDaemonLockFile, { force: true });
    if (ownsSocket()) fs.rmSync(runtimeDaemonSocket, { force: true });
  }
  process.exit(0);
}

async function handle(request) {
  switch (request.method) {
    case "call": {
      lastActivity = Date.now();
      inFlight += 1;
      await autoConnect({ skipBackoff: true }).catch(() => {});
      try {
        return await service.call(request.params?.name, request.params?.args ?? {});
      } finally {
        inFlight -= 1;
        lastActivity = Date.now();
      }
    }
    case "status":
      return { pid: process.pid, ...runtime.summary(), released, inFlight };
    case "release":
      await release(request.params ?? {});
      return { released };
    case "shutdown":
      setImmediate(() => shutdown("shutdown requested"));
      return { ok: true };
    default:
      throw new Error(`Unknown method ${request.method}`);
  }
}

const server = net.createServer(connection => {
  let buffer = "";
  connection.setEncoding("utf8");
  connection.on("error", () => {});
  connection.on("data", async chunk => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = "";
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      connection.end(`${JSON.stringify({ id: null, error: { message: "Malformed request" } })}\n`);
      return;
    }
    try {
      const result = await handle(request);
      connection.end(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch (error) {
      connection.end(`${JSON.stringify({ id: request.id, error: { message: error.message } })}\n`);
    }
  });
});

let socketInode = null;
function ownsSocket() {
  try {
    return fs.statSync(runtimeDaemonSocket).ino === socketInode;
  } catch {
    return false;
  }
}

fs.rmSync(runtimeDaemonSocket, { force: true });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(runtimeDaemonSocket, () => {
    fs.chmodSync(runtimeDaemonSocket, 0o600);
    socketInode = fs.statSync(runtimeDaemonSocket).ino;
    resolve();
  });
});
console.error(`[${new Date().toISOString()}] runtime daemon ${process.pid} listening on ${runtimeDaemonSocket}`);

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

await autoConnect();

// Watch rules: notify, record, or start a capped background `codex exec` run.
const alerts = new AlertEngine({
  store: runtime.store,
  watches,
  async codexConfig() {
    const config = await controllerConfigStore.load();
    return { codexBin: config.codexBin, workspace: config.workspace, model: config.model, profile: config.profile };
  }
});
await alerts.start().catch(error => console.error(`[${new Date().toISOString()}] alert engine start failed: ${error.message}`));
runtime.on("messages.upsert", () => { alerts.tick(); });
// WhatsApp drops a linked device after ~14 days with the phone offline, or
// when it is removed on the phone. Say so once, instead of every tool failing.
runtime.on("connection.update", update => {
  if (update.connection !== "close" || runtime.state.status !== "logged_out") return;
  alerts.systemAlert("logged_out", "WhatsApp relay logged out",
    "WhatsApp unlinked this device. Ask Codex to relink (whatsapp_start_auth, with phoneNumber for a pairing code).")
    .catch(error => console.error(`[${new Date().toISOString()}] logout alert failed: ${error.message}`));
});

// Scheduled messages go through the same send tool (and its rate limits).
await scheduled.ensureLoaded();
await scheduled.recoverInterrupted();
let schedulerRun = null;
function runScheduled() {
  if (schedulerRun || !scheduled.data.items.some(item => item.status === "pending")) return schedulerRun;
  schedulerRun = scheduled.runDue({
    send: async item => {
      inFlight += 1;
      try {
        return await service.sendStored(item);
      } finally {
        inFlight -= 1;
      }
    }
  }).catch(error => console.error(`[${new Date().toISOString()}] scheduler error: ${error.message}`))
    .finally(() => { schedulerRun = null; });
  return schedulerRun;
}

const watcher = setInterval(async () => {
  try {
    if (readLock()?.pid !== process.pid) return shutdown("lock file removed or taken over");
    // Workers connect by path; if another process replaced the socket file,
    // exit so the next call starts a daemon that owns both lock and socket.
    if (!ownsSocket()) return shutdown("socket file removed or replaced");
    if (released?.ownerPid && !pidAlive(released.ownerPid)) released = null;
    if (released?.expiresAt && Date.now() > released.expiresAt) released = null;
    if (await bridgeOwnsSession()) {
      if (runtime.socket) await runtime.stop();
      await runtime.store.load();
    } else {
      await autoConnect();
    }
    alerts.tick();
    runScheduled();
    if (inFlight === 0 && !schedulerRun && scriptsVersion() !== bootVersion) return shutdown("relay scripts changed; the next call starts the new version");
    if (!runtime.hasSavedCreds() && inFlight === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) return shutdown("idle without credentials");
  } catch (error) {
    console.error(`[${new Date().toISOString()}] watcher error: ${error.message}`);
  }
}, WATCH_INTERVAL_MS);
// The listening server keeps the process alive, not the watcher.
watcher.unref?.();
