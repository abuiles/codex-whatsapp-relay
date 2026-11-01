import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scripts = fileURLToPath(new URL("../plugins/whatsapp-relay/scripts/", import.meta.url));

async function dataDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-daemon-"));
  t.after(async () => {
    const lock = await fs.readFile(path.join(directory, "runtime-daemon.json"), "utf8").then(JSON.parse).catch(() => null);
    if (lock?.pid) { try { process.kill(lock.pid, "SIGTERM"); } catch {} }
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function worker(t, directory, env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(scripts, "mcp-server.mjs")],
    env: { ...process.env, WHATSAPP_DATA_DIR: directory, ...env }, stderr: "pipe" });
  const client = new Client({ name: "synthetic-daemon-test", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

const status = async client => (await client.callTool({ name: "whatsapp_auth_status", arguments: {} })).content.map(c => c.text).join("\n");

test("concurrent MCP workers share one runtime daemon instead of opening their own sockets", async t => {
  const directory = await dataDirectory(t);
  const clients = await Promise.all([1, 2, 3].map(() => worker(t, directory)));
  const outputs = await Promise.all(clients.map(status));
  const pids = outputs.map(text => text.match(/runtime_pid: (\d+)/)?.[1]);
  assert.ok(pids[0]);
  assert.equal(new Set(pids).size, 1, outputs.join("\n---\n"));
  for (const text of outputs) assert.match(text, /runtime_mode: daemon/);
  const lock = JSON.parse(await fs.readFile(path.join(directory, "runtime-daemon.json"), "utf8"));
  assert.equal(String(lock.pid), pids[0]);
  const tools = await clients[0].listTools();
  for (const name of ["whatsapp_search_messages", "whatsapp_wait_for_messages", "whatsapp_react", "whatsapp_reconnect"]) {
    assert.ok(tools.tools.some(tool => tool.name === name), name);
  }
});

test("racing daemon starts leave exactly one owner", async t => {
  const directory = await dataDirectory(t);
  const children = Array.from({ length: 8 }, () => null).map(() => spawn(process.execPath, [path.join(scripts, "runtime-daemon.mjs")],
    { env: { ...process.env, WHATSAPP_DATA_DIR: directory }, stdio: "ignore" }));
  await new Promise(resolve => setTimeout(resolve, 1500));
  const alive = children.filter(child => child.exitCode === null);
  assert.equal(alive.length, 1);
  const lock = JSON.parse(await fs.readFile(path.join(directory, "runtime-daemon.json"), "utf8"));
  assert.equal(lock.pid, alive[0].pid);
});

test("WHATSAPP_DAEMON=off keeps the legacy in-process mode", async t => {
  const directory = await dataDirectory(t);
  const text = await status(await worker(t, directory, { WHATSAPP_DAEMON: "off" }));
  assert.match(text, /runtime_mode: local/);
  await assert.rejects(fs.access(path.join(directory, "runtime-daemon.json")));
});

test("the daemon exits once its lock file is removed", async t => {
  const directory = await dataDirectory(t);
  await status(await worker(t, directory));
  const lockFile = path.join(directory, "runtime-daemon.json");
  const { pid } = JSON.parse(await fs.readFile(lockFile, "utf8"));
  await fs.rm(lockFile);
  const deadline = Date.now() + 12_000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false);
});
