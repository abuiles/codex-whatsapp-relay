// MCP stdio worker. Codex starts one per thread, so workers never open the
// WhatsApp socket themselves: tool calls go to the single runtime daemon
// (runtime-daemon.mjs), which owns the linked device. If the daemon cannot be
// reached the worker still answers read-only tools from the local cache.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { callTool, DaemonUnavailableError } from "./daemon-client.mjs";
import { WhatsAppRuntime } from "./runtime.mjs";
import { createWhatsAppService, SERVER_INSTRUCTIONS, textResult, TOOL_DEFINITIONS } from "./whatsapp-service.mjs";

const daemonEnabled = process.env.WHATSAPP_DAEMON !== "off";
let runtime = null;
let localService = null;

// Built lazily: in daemon mode most workers never need a local runtime.
async function getLocalService() {
  if (!localService) {
    runtime = new WhatsAppRuntime({ logLevel: process.env.WHATSAPP_LOG_LEVEL ?? "warn" });
    await runtime.initialize();
    localService = createWhatsAppService({ runtime, mode: daemonEnabled ? "cache_only" : "local" });
  }
  return localService;
}

function timeoutFor(name, args) {
  if (name === "whatsapp_wait_for_messages") return ((args?.timeoutSeconds ?? 30) + 20) * 1000;
  if (name === "whatsapp_reconnect" || name === "whatsapp_sync_history") return 180_000;
  return 120_000;
}

async function dispatch(tool, args) {
  if (!daemonEnabled) return (await getLocalService()).call(tool.name, args);
  try {
    return await callTool(tool.name, args, { mutates: tool.mutates, timeoutMs: timeoutFor(tool.name, args) });
  } catch (error) {
    if (!(error instanceof DaemonUnavailableError)) return textResult(error.message, { isError: true });
    const fallback = await (await getLocalService()).call(tool.name, args);
    fallback.content?.unshift({ type: "text", text: `runtime_mode: cache_only (relay runtime daemon unavailable: ${error.message})` });
    return fallback;
  }
}

const server = new McpServer({ name: "whatsapp-relay", version: "0.2.0" }, { instructions: SERVER_INSTRUCTIONS });
for (const tool of TOOL_DEFINITIONS) {
  server.tool(tool.name, tool.description, tool.input, args => dispatch(tool, args));
}

const transport = new StdioServerTransport();
let reloading = false;
process.on("SIGHUP", async () => {
  if (reloading) return;
  if (typeof process.execve !== "function") {
    console.error("In-place MCP reload requires a Node.js version with process.execve.");
    return;
  }
  reloading = true;
  try {
    if (runtime) {
      await runtime.store.flush();
      await runtime.historyRequests.writes;
    }
    // Preserve the host's stdio transport while replacing only this MCP worker.
    process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], process.env);
  } catch (error) {
    reloading = false;
    console.error("WhatsApp MCP reload failed", error.message);
  }
});
await server.connect(transport);
server.sendToolListChanged();
