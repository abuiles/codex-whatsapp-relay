import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-service-test-"));
process.env.WHATSAPP_DATA_DIR = dataDir;
const { DisconnectReason } = await import("@whiskeysockets/baileys");
const { WhatsAppStore } = await import("./store.mjs");
const { createWhatsAppService } = await import("./whatsapp-service.mjs");

test.after(() => fs.rm(dataDir, { recursive: true, force: true }));

const pn = "15550001111@s.whatsapp.net";
const other = "15550002222@s.whatsapp.net";
const group = "120363000000000001@g.us";
const incoming = (id, remoteJid, time, text, extra = {}) => ({ key: { id, remoteJid, fromMe: false }, messageTimestamp: time, pushName: "Ada", message: { conversation: text }, ...extra });

// A synthetic socket: records every outgoing call, never touches WhatsApp.
function fakeSocket() {
  const sent = [];
  let counter = 0;
  return {
    sent,
    user: { id: "15559990000:1@s.whatsapp.net" },
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options });
      return { key: { id: `OUT${++counter}`, remoteJid: jid, fromMe: true }, messageTimestamp: 100 + counter, message: content.text ? { conversation: content.text } : {} };
    },
    async onWhatsApp(...numbers) {
      return numbers.filter(n => n !== "15550009999").map(n => ({ jid: `${n}@s.whatsapp.net`, exists: true }));
    },
    async readMessages(keys) { sent.push({ read: keys }); },
    async groupMetadata(id) {
      return { id, subject: "Synthetic group", participants: [{ id: pn, admin: "admin" }, { id: other }] };
    },
    async groupFetchAllParticipating() { return { [group]: await this.groupMetadata(group) }; },
    async fetchStatus() { return [{ status: { status: "Synthetic about" } }]; },
    async profilePictureUrl() { return null; }
  };
}

async function fixture(t, { mode = "daemon", status = "connected", lastDisconnect = null, reconnectHeld = false, session } = {}) {
  const directory = await fs.mkdtemp(path.join(dataDir, "case-"));
  const store = new WhatsAppStore(path.join(directory, "store.json"));
  t.after(() => clearTimeout(store.pendingSave));
  store.upsertChat({ id: pn, name: "Ada Lovelace" });
  store.upsertChat({ id: group, name: "Synthetic group", subject: "Synthetic group" });
  store.ingestMessage(incoming("in1", pn, 10, "Are we still on for lunch?"));
  store.ingestMessage(incoming("in2", pn, 11, "Café at noon"));
  store.ingestMessage({ key: { id: "mine", remoteJid: pn, fromMe: true }, messageTimestamp: 12, message: { conversation: "yes" } });
  const socket = fakeSocket();
  let connects = 0;
  const runtime = {
    store,
    logger: { warn() {}, error() {} },
    state: { status, lastDisconnect, reconnectHeld },
    historyRequests: { load: async () => {}, list: () => [] },
    summary: () => ({ status: runtime.state.status, hasCreds: true, recentChatCount: 2, lastDisconnect: runtime.state.lastDisconnect }),
    hasSavedCreds: () => true,
    async ensureConnected() { connects += 1; return socket; },
    async stop() {}, async start() {}, async waitForConnection() { return socket; }
  };
  const service = createWhatsAppService({ runtime, mode, session });
  return { service, store, socket, runtime, connects: () => connects };
}

const text = result => result.content.map(part => part.text ?? "").join("\n");

test("search finds messages across chats regardless of accents and word order", async t => {
  const { service } = await fixture(t);
  const result = await service.call("whatsapp_search_messages", { query: "noon cafe" });
  assert.equal(result.isError, false);
  assert.match(text(result), /matches: 1/);
  assert.match(text(result), /id=in2 chat=Ada Lovelace/);
  assert.match(text(result), /Ada: Café at noon/);
});

test("replies quote the cached raw message and sends to a phone number are verified first", async t => {
  const { service, socket } = await fixture(t);
  const reply = await service.call("whatsapp_send_message", { chatName: "Ada", text: "On my way", replyToMessageId: "in1" });
  assert.equal(reply.isError, false, text(reply));
  assert.equal(socket.sent[0].jid, pn);
  assert.equal(socket.sent[0].options.quoted.key.id, "in1");
  assert.match(text(reply), /reply_to: in1/);

  const fresh = await service.call("whatsapp_send_message", { phoneNumber: "+1 (555) 000-2222", text: "hello" });
  assert.equal(fresh.isError, false, text(fresh));
  assert.equal(socket.sent[1].jid, other);

  const missing = await service.call("whatsapp_send_message", { phoneNumber: "+1 555 000 9999", text: "hello" });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /not registered on WhatsApp. Nothing was sent/);
  assert.equal(socket.sent.length, 2);
});

test("exactly one recipient form is required", async t => {
  const { service, socket } = await fixture(t);
  const result = await service.call("whatsapp_send_message", { chatId: pn, phoneNumber: "+15550001111", text: "x" });
  assert.equal(result.isError, true);
  assert.match(text(result), /exactly one of chatId, chatName or phoneNumber/);
  assert.equal(socket.sent.length, 0);
});

test("react, edit and delete target the cached key and update the cache", async t => {
  const { service, socket, store } = await fixture(t);
  assert.equal((await service.call("whatsapp_react", { chatId: pn, messageId: "in1", emoji: "👍" })).isError, false);
  assert.deepEqual(socket.sent[0].content.react.key.id, "in1");
  assert.ok(JSON.stringify(store.getMessages(pn).find(m => m.id === "in1").reactions).includes("👍"));

  const notMine = await service.call("whatsapp_edit_message", { chatId: pn, messageId: "in1", text: "x" });
  assert.equal(notMine.isError, true);
  assert.equal((await service.call("whatsapp_edit_message", { chatId: pn, messageId: "mine", text: "yes!" })).isError, false);
  assert.equal(socket.sent[1].content.edit.id, "mine");
  assert.equal(store.getMessages(pn).find(m => m.id === "mine").text, "yes!");

  const refused = await service.call("whatsapp_delete_message", { chatId: pn, messageId: "in1" });
  assert.match(text(refused), /Only your own messages/);
  assert.equal((await service.call("whatsapp_delete_message", { chatId: pn, messageId: "mine" })).isError, false);
  assert.equal(socket.sent[2].content.delete.id, "mine");
  assert.equal(store.getMessages(pn).find(m => m.id === "mine").messageType, "revoked");
});

test("forward, poll, location and mark-read build the expected payloads", async t => {
  const { service, socket, store } = await fixture(t);
  store.data.chats[pn].unreadCount = 2;
  assert.equal((await service.call("whatsapp_forward_message", { fromChatId: pn, messageId: "in2", chatId: group })).isError, false);
  assert.equal(socket.sent[0].content.forward.key.id, "in2");
  assert.equal((await service.call("whatsapp_send_poll", { chatId: group, question: "When?", options: ["Mon", "Tue"] })).isError, false);
  assert.deepEqual(socket.sent[1].content.poll, { name: "When?", values: ["Mon", "Tue"], selectableCount: 1 });
  assert.equal((await service.call("whatsapp_send_location", { chatId: group, latitude: 1.5, longitude: -2.5, name: "Here" })).isError, false);
  assert.equal(socket.sent[2].content.location.degreesLatitude, 1.5);
  const read = await service.call("whatsapp_mark_read", { chatId: pn });
  assert.match(text(read), /messages_marked_read: 2/);
  assert.deepEqual(socket.sent[3].read.map(key => key.id), ["in1", "in2"]);
  assert.equal(store.data.chats[pn].unreadCount, 0);
  const duplicate = await service.call("whatsapp_send_poll", { chatId: group, question: "?", options: ["a", "a"] });
  assert.equal(duplicate.isError, true);
});

test("check_number, group_info and contact_info answer without sending messages", async t => {
  const { service, socket } = await fixture(t);
  const check = text(await service.call("whatsapp_check_number", { phoneNumbers: ["+15550001111", "+15550009999"] }));
  assert.match(check, /\+15550001111 on_whatsapp=yes chat_id=15550001111@s\.whatsapp\.net cached_name=Ada Lovelace/);
  assert.match(check, /\+15550009999 on_whatsapp=no/);
  const info = text(await service.call("whatsapp_group_info", { chatName: "Synthetic" }));
  assert.match(info, /participant_count: 2/);
  assert.match(info, /Ada Lovelace \(15550001111@s\.whatsapp\.net\) admin=admin/);
  assert.match(text(await service.call("whatsapp_group_info", {})), /group_count: 1/);
  assert.match(text(await service.call("whatsapp_contact_info", { chatName: "Ada" })), /about: Synthetic about/);
  assert.equal(socket.sent.length, 0);
});

test("wait_for_messages returns new messages after the cursor and a next cursor", async t => {
  const { service, store } = await fixture(t);
  setTimeout(() => store.ingestMessage(incoming("late", pn, 50, "ping")), 200);
  const result = text(await service.call("whatsapp_wait_for_messages", { sinceTimestamp: 20, timeoutSeconds: 5 }));
  assert.match(result, /timed_out: no/);
  assert.match(result, /id=late/);
  assert.match(result, /next_since_timestamp: 50/);
  const idle = text(await service.call("whatsapp_wait_for_messages", { sinceTimestamp: 50, timeoutSeconds: 0 }));
  assert.match(idle, /timed_out: yes/);
});

test("cache-only workers never open a socket and still answer read tools", async t => {
  const { service, connects, socket } = await fixture(t, { mode: "cache_only", status: "idle" });
  const send = await service.call("whatsapp_send_message", { chatId: pn, text: "hi" });
  assert.equal(send.isError, true);
  assert.match(text(send), /runtime daemon is unreachable/);
  assert.match(text(await service.call("whatsapp_list_chats", { query: "ada" })), /Ada Lovelace/);
  assert.equal(connects(), 0);
  assert.equal(socket.sent.length, 0);
});

test("a single 440 reconnects, but a held or released session blocks live tools with a clear next step", async t => {
  const lastDisconnect = { code: DisconnectReason.connectionReplaced, at: "now" };
  const once = await fixture(t, { status: "disconnected", lastDisconnect });
  await once.service.call("whatsapp_mark_read", { chatId: pn });
  assert.equal(once.connects(), 1);

  const replaced = await fixture(t, { status: "disconnected", lastDisconnect, reconnectHeld: true });
  const result = await replaced.service.call("whatsapp_send_message", { chatId: pn, text: "hi" });
  assert.match(text(result), /keeps replacing this linked-device session.*whatsapp_reconnect/s);
  assert.equal(replaced.connects(), 0);

  const released = await fixture(t, { session: { blockedReason: () => "held by pid 42" } });
  assert.match(text(await released.service.call("whatsapp_react", { chatId: pn, messageId: "in1", emoji: "x" })), /held by pid 42/);
  assert.equal(released.socket.sent.length, 0);
});

test("argument validation errors are reported, not thrown", async t => {
  const { service } = await fixture(t);
  const result = await service.call("whatsapp_send_location", { chatId: pn, latitude: 200, longitude: 0 });
  assert.equal(result.isError, true);
  assert.match(text(result), /Invalid arguments: latitude/);
});
