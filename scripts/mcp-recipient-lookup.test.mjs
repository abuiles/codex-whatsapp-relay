import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP separates recipient contacts from history and exposes idle-cache failures", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-recipient-test-"));
  await fs.writeFile(path.join(directory, "store.json"), JSON.stringify({
    meta: { updatedAt: "2020-01-01T00:00:00.000Z" },
    chats: { "10000000002@s.whatsapp.net": { id: "10000000002@s.whatsapp.net", name: "Synthetic duplicate" } },
    contacts: {
      "10000000000@s.whatsapp.net": { id: "10000000000@s.whatsapp.net", name: "Synthetic Researcher" },
      "10000000001@s.whatsapp.net": { id: "10000000001@s.whatsapp.net", name: "Synthetic duplicate" }
    }, messages: {}
  }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../plugins/whatsapp-relay/scripts/mcp-server.mjs", import.meta.url))],
    env: { ...process.env, WHATSAPP_DATA_DIR: directory }, stderr: "pipe" });
  const client = new Client({ name: "synthetic-recipient-test", version: "1.0.0" });
  const call = (name, args) => client.callTool({ name, arguments: args });
  try {
    await client.connect(transport);
    const status = await call("whatsapp_auth_status", {});
    // Workers proxy to one shared runtime daemon, so the pid is the daemon's, not the worker's.
    assert.match(status.content[0].text, /runtime_mode: daemon/);
    assert.doesNotMatch(status.content[0].text, new RegExp(`runtime_pid: ${transport.pid}\\b`));
    const found = await call("whatsapp_list_chats", { query: "Synthetic Researcher" });
    assert.match(found.content[0].text, /kind=contact_only cached_messages=0/);
    assert.match(found.content[0].text, /sync_state: cache_only_disconnected/);
    assert.match(found.content[0].text, /cache_updated_at: 2020-01-01/);
    const empty = await call("whatsapp_read_messages", { chatName: "Synthetic Researcher" });
    assert.equal(empty.isError, false);
    assert.match(empty.content[0].text, /kind: contact_only/);
    assert.match(empty.content[0].text, /No cached messages/);
    assert.match(empty.content[0].text, /history_completeness: not_verified/);
    const missing = await call("whatsapp_list_chats", { query: "Unknown synthetic person" });
    assert.match(missing.content[0].text, /lookup_result: no_cached_match/);
    assert.match(missing.content[0].text, /does not prove it is absent on the phone/);
    const ambiguous = await call("whatsapp_read_messages", { chatName: "Synthetic duplicate" });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /Multiple chats matched/);
    const persisted = JSON.parse(await fs.readFile(path.join(directory, "store.json"), "utf8"));
    assert.equal(Object.keys(persisted.chats).length, 1);
    assert.equal(Object.keys(persisted.messages).length, 0);
  } finally {
    await client.close();
    const lock = await fs.readFile(path.join(directory, "runtime-daemon.json"), "utf8").then(JSON.parse).catch(() => null);
    if (lock?.pid) { try { process.kill(lock.pid, "SIGTERM"); } catch {} }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
