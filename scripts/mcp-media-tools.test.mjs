import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP advertises media tools and preflights a synthetic image without connecting or sending", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-mcp-tools-test-"));
  await fs.writeFile(path.join(directory, "history-requests.json"), JSON.stringify({ version: 1, requests: [
    { id: "synthetic-pending", sessionId: "synthetic-pending", chatId: "10000000000@s.whatsapp.net", state: "timed_out_waiting_response" }
  ] }));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../plugins/whatsapp-relay/scripts/mcp-server.mjs", import.meta.url))],
    env: { ...process.env, WHATSAPP_DATA_DIR: directory }, stderr: "pipe" });
  const client = new Client({ name: "synthetic-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    for (const name of ["whatsapp_prepare_media", "whatsapp_send_media", "whatsapp_download_media", "whatsapp_message_status"]) {
      assert.ok(tools.tools.some(tool => tool.name === name), name);
    }
    const filePath = path.join(directory, "test.png");
    await fs.writeFile(filePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVc8AAAAASUVORK5CYII=", "base64"));
    const result = await client.callTool({ name: "whatsapp_prepare_media", arguments: { filePath, mediaType: "image" } });
    assert.ok(!result.isError);
    assert.match(result.content[0].text, /sha256/);
    const legacySend = tools.tools.find(tool => tool.name === "whatsapp_send_message");
    assert.ok(legacySend.inputSchema.properties.media);
    const rejectedMedia = await client.callTool({ name: "whatsapp_send_message", arguments: {
      chatId: "10000000000@s.whatsapp.net", text: "", media: { filePath, mediaType: "image", expectedSha256: "0".repeat(64) }
    } });
    assert.equal(rejectedMedia.isError, true);
    assert.match(rejectedMedia.content[0].text, /File changed/);
    const empty = await client.callTool({ name: "whatsapp_send_message", arguments: { chatId: "10000000000@s.whatsapp.net", text: "" } });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /nonempty text/);
    const status = await client.callTool({ name: "whatsapp_auth_status", arguments: {} });
    assert.match(status.content[0].text, /status: idle/);
    assert.match(status.content[0].text, /credentials: missing/);
    assert.match(status.content[0].text, /send_message_media_v1/);
    const history = await client.callTool({ name: "whatsapp_sync_history", arguments: { statusOnly: true, requestId: "synthetic-pending" } });
    assert.ok(!history.isError);
    const journal = JSON.parse(history.content[0].text);
    assert.equal(journal.new_request_sent, false);
    assert.equal(journal.requests[0].state, "timed_out_waiting_response");
    assert.equal(journal.requests[0].id, "synthetic-pending");
  } finally {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
