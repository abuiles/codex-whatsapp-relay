// Client side of the runtime daemon protocol: one newline-delimited JSON
// request per Unix socket connection, answered by one JSON line.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { ensureRuntimeDirs, runtimeDaemonLogFile, runtimeDaemonScript, runtimeDaemonSocket, scriptsDir } from "./paths.mjs";

const SPAWN_WAIT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class DaemonUnavailableError extends Error {}

// written=false means the daemon never saw the request, so retrying is safe
// even for tools that send messages.
function request(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let written = false;
    let buffer = "";
    const socket = net.createConnection(runtimeDaemonSocket);
    const fail = error => {
      socket.destroy();
      error.written = written;
      reject(error);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error(`runtime daemon did not answer within ${Math.round(timeoutMs / 1000)}s`), { code: "ETIMEDOUT" })));
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: process.pid, method, params })}\n`, () => { written = true; });
    });
    socket.on("data", chunk => { buffer += chunk; });
    socket.on("error", fail);
    socket.on("close", () => {
      const line = buffer.split("\n")[0];
      if (!line) return fail(Object.assign(new Error("runtime daemon closed the connection without answering"), { code: "ECONNRESET" }));
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        return fail(Object.assign(new Error("runtime daemon sent a malformed answer"), { code: "EPROTO" }));
      }
      if (response.error) return reject(Object.assign(new Error(response.error.message), { written: true, answered: true }));
      resolve(response.result);
    });
  });
}

function spawnDaemon() {
  const log = fs.openSync(runtimeDaemonLogFile, "a", 0o600);
  const child = spawn(process.execPath, [runtimeDaemonScript], {
    cwd: scriptsDir,
    detached: true,
    env: process.env,
    stdio: ["ignore", log, log]
  });
  child.unref();
  fs.closeSync(log);
}

const NOT_RUNNING = new Set(["ENOENT", "ECONNREFUSED"]);

/** Send one request, starting the daemon if nobody is listening. */
export async function daemonRequest(method, params, { spawn: allowSpawn = true, timeoutMs, retryAfterWrite = false } = {}) {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  let spawned = false;
  let retriedAfterWrite = false;
  for (;;) {
    try {
      return await request(method, params, { timeoutMs });
    } catch (error) {
      if (error.answered) throw error;
      if (error.written) {
        if (retryAfterWrite && !retriedAfterWrite && error.code !== "ETIMEDOUT") {
          retriedAfterWrite = true;
          continue;
        }
        throw error;
      }
      if (!NOT_RUNNING.has(error.code) && error.code !== "ECONNRESET") throw error;
      if (!allowSpawn) throw new DaemonUnavailableError(`runtime daemon is not running (${error.code})`);
      if (!spawned) {
        await ensureRuntimeDirs();
        spawnDaemon();
        spawned = true;
      }
      if (Date.now() > deadline) {
        throw new DaemonUnavailableError(`runtime daemon did not start within ${SPAWN_WAIT_MS / 1000}s; see ${runtimeDaemonLogFile}`);
      }
      await delay(200);
    }
  }
}

/**
 * Proxy a tool call. Read-only tools retry once if the connection drops after
 * the request was sent; tools that send or change things never do, because
 * WhatsApp may already have accepted the message.
 */
export async function callTool(name, args, { mutates, timeoutMs }) {
  try {
    return await daemonRequest("call", { name, args }, { timeoutMs, retryAfterWrite: !mutates });
  } catch (error) {
    if (error.answered) throw error;
    if (error instanceof DaemonUnavailableError || !error.written) throw new DaemonUnavailableError(error.message);
    if (mutates) {
      return { isError: true, content: [{ type: "text", text: `The relay runtime connection dropped after ${name} was submitted (${error.message}). outcome: unknown. Do not automatically retry; check with whatsapp_read_messages first.` }] };
    }
    throw error;
  }
}

/** Ask the daemon to drop the socket so this process can own the linked device. */
export async function releaseDaemonSession(reason) {
  try {
    return await daemonRequest("release", { ownerPid: process.pid, reason }, { spawn: false, timeoutMs: 15_000 });
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return null;
    throw error;
  }
}

export async function daemonStatus() {
  try {
    return await daemonRequest("status", {}, { spawn: false, timeoutMs: 5_000 });
  } catch {
    return null;
  }
}
