import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppRuntime } from "./runtime.mjs";
import { HistoryRequests } from "./history-requests.mjs";

const chatId = "10000000000@s.whatsapp.net";
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-history-test-"));
  const runtime = new WhatsAppRuntime({ logLevel: "silent" });
  runtime.historyRequests = new HistoryRequests(path.join(directory, "history-requests.json"));
  runtime.store = {
    getMessages: () => [{ chatId, id: "test-anchor", timestamp: 1700000010, fromMe: true }],
    getMessageCount: () => 1, ensureMessageCapacity() {}, getMessageLimit: () => 200,
    getOldestMessage: () => ({ chatId, id: "older", timestamp: 1700000000, fromMe: false })
  };
  t.after(async () => { await runtime.historyRequests.writes.catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  return runtime;
}
const response = (sessionId, extra = {}) => ({ peerDataRequestSessionId: sessionId,
  messages: [{ key: { remoteJid: chatId, id: "synthetic-response" } }], isLatest: true, ...extra });

test("history persists its exact stanza ID before dispatch and passes milliseconds", async t => {
  const runtime = await fixture(t);
  runtime.ensureConnected = async () => ({ user: { id: chatId }, relayMessage: async (to, body, options) => {
    const saved = JSON.parse(await fs.readFile(runtime.historyRequests.filePath));
    assert.equal(saved.requests[0].sessionId, options.messageId);
    assert.equal(to, chatId);
    const request = body.protocolMessage.peerDataOperationRequestMessage.historySyncOnDemandRequest;
    assert.equal(request.oldestMsgTimestampMs, 1700000010000);
    assert.equal(request.oldestMsgId, "test-anchor");
    assert.equal(request.onDemandMsgCount, 1);
    assert.deepEqual(options.additionalAttributes, { category: "peer", push_priority: "high_force" });
    // A response can arrive before relayMessage's promise settles.
    runtime.events.emit("messaging-history.set", response(options.messageId));
    return options.messageId;
  } });
  const result = await runtime.syncChatHistory({ chatId, count: 1, beforeMessageId: "test-anchor" });
  assert.equal(result.state, "response_received");
  assert.equal(result.oldestTimestampBefore, 1700000000);
  assert.equal(result.anchorTimestamp, 1700000010);
  assert.equal(result.sessionMatched, true);
  assert.deepEqual(result.receivedMessageIds, ["synthetic-response"]);
  assert.equal(runtime.events.listenerCount("messaging-history.set"), 0);
  assert.equal((await fs.stat(runtime.historyRequests.filePath)).mode & 0o777, 0o600);
  await assert.rejects(runtime.syncChatHistory({ chatId, beforeMessageId: "missing" }), /anchor message ID/);
});

test("unrelated history cannot complete a request; timeout survives reload without a resend", async t => {
  const runtime = await fixture(t);
  let requests = 0;
  let requestId;
  runtime.ensureConnected = async () => ({ user: { id: chatId }, relayMessage: async (_, __, options) => {
    requests++; requestId = options.messageId;
    runtime.events.emit("messaging-history.set", response(undefined));
    runtime.events.emit("messaging-history.set", response("different-session"));
  } });
  const result = await runtime.syncChatHistory({ chatId, count: 1, timeoutMs: 10 });
  assert.equal(result.state, "timed_out_waiting_response");
  assert.equal(result.sessionMatched, false);
  assert.equal(result.sessionId, requestId);
  assert.equal(runtime.events.listenerCount("messaging-history.set"), 0);
  runtime.historyRequests = new HistoryRequests(runtime.historyRequests.filePath);
  // Altering the requested count does not silently repeat an unresolved anchor.
  const reused = await runtime.syncChatHistory({ chatId, count: 2 });
  assert.equal(reused.reused, true);
  assert.equal(reused.sessionId, requestId);
  assert.equal(requests, 1);
  await runtime.historyRequests.recordResponse(response("unrelated"));
  assert.equal(runtime.historyRequests.list()[0].state, "timed_out_waiting_response");
  await runtime.historyRequests.recordResponse(response(requestId));
  const recovered = new HistoryRequests(runtime.historyRequests.filePath); await recovered.load();
  assert.equal(recovered.list()[0].state, "response_received");
  assert.deepEqual(recovered.list()[0].receivedMessageIds, ["synthetic-response"]);
});

test("dispatch failure cancels the waiter and preserves its ID as outcome unknown", async t => {
  const runtime = await fixture(t);
  let requests = 0;
  runtime.ensureConnected = async () => ({ user: { id: chatId }, relayMessage: async () => {
    requests++; throw new Error("synthetic socket close after dispatch");
  } });
  const result = await runtime.syncChatHistory({ chatId, count: 1, timeoutMs: 10000 });
  assert.equal(result.state, "dispatch_unknown");
  assert.match(result.sessionId, /^3EB0/);
  assert.equal(runtime.events.listenerCount("messaging-history.set"), 0);
  const reused = await runtime.syncChatHistory({ chatId, count: 1 });
  assert.equal(reused.reused, true);
  assert.equal(requests, 1);
});

test("concurrent history calls share an unresolved anchor without two dispatches", async t => {
  const runtime = await fixture(t);
  let requests = 0;
  runtime.ensureConnected = async () => ({ user: { id: chatId }, relayMessage: async (_, __, options) => {
    requests++;
    setTimeout(() => runtime.events.emit("messaging-history.set", response(options.messageId)), 5);
  } });
  const results = await Promise.all([runtime.syncChatHistory({ chatId }), runtime.syncChatHistory({ chatId })]);
  assert.equal(requests, 1);
  assert.equal(results[0].sessionId, results[1].sessionId);
  assert.equal(results.filter(result => result.reused).length, 1);
});
