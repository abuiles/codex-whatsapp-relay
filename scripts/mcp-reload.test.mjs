import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("SIGHUP reload preserves the initialized MCP transport and refreshes its tool list", { skip: typeof process.execve !== "function" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-mcp-reload-test-"));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../plugins/whatsapp-relay/scripts/mcp-server.mjs", import.meta.url))],
    env: { ...process.env, WHATSAPP_DATA_DIR: directory }, stderr: "pipe" });
  const client = new Client({ name: "synthetic-reload-test", version: "1.0.0" });
  let reloadReady;
  let notifications = 0;
  const refreshed = new Promise(resolve => { reloadReady = resolve; });
  client.setNotificationHandler((await import("@modelcontextprotocol/sdk/types.js")).ToolListChangedNotificationSchema, () => {
    notifications++; if (notifications >= 2) reloadReady();
  });
  try {
    await client.connect(transport);
    const before = await client.callTool({ name: "whatsapp_auth_status", arguments: {} });
    assert.match(before.content[0].text, /status: idle/);
    const pid = transport.pid;
    assert.ok(pid);
    process.kill(pid, "SIGHUP");
    await Promise.race([refreshed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("No refreshed tool-list notification")), 5000); timer.unref();
    })]);
    assert.equal(transport.pid, pid);
    const after = await client.callTool({ name: "whatsapp_auth_status", arguments: {} });
    assert.match(after.content[0].text, /status: idle/);
    assert.match(after.content[0].text, /credentials: missing/);
    const list = await client.listTools();
    assert.ok(list.tools.some(tool => tool.name === "whatsapp_send_media"));
  } finally {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
