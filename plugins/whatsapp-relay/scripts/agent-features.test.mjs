import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-agent-test-"));
process.env.WHATSAPP_DATA_DIR = dataDir;
const { WhatsAppStore } = await import("./store.mjs");
const { createWhatsAppService } = await import("./whatsapp-service.mjs");
const { AlertEngine, WatchStore, matchRule, readAlerts } = await import("./watch-rules.mjs");
const { ScheduledStore } = await import("./scheduler.mjs");
const { SendLimiter } = await import("./send-limiter.mjs");
const { mediaKind } = await import("./media-text.mjs");

test.after(() => fs.rm(dataDir, { recursive: true, force: true }));

const me = "15559990000@s.whatsapp.net";
const pn = "15550001111@s.whatsapp.net";
const other = "15550002222@s.whatsapp.net";
const group = "120363000000000001@g.us";
const incoming = (id, remoteJid, time, text) => ({ key: { id, remoteJid, fromMe: false }, messageTimestamp: time, pushName: "Ada", message: { conversation: text } });
const withContext = (id, remoteJid, time, text, contextInfo, participant) => ({
  key: { id, remoteJid, fromMe: false, participant }, messageTimestamp: time, pushName: "Bob",
  message: { extendedTextMessage: { text, contextInfo } }
});
const text = result => result.content.map(part => part.text ?? "").join("\n");

async function newStore() {
  const directory = await fs.mkdtemp(path.join(dataDir, "case-"));
  const store = new WhatsAppStore(path.join(directory, "store.json"));
  store.updateMeta({ lastConnection: { user: { id: "15559990000:1@s.whatsapp.net" } } });
  store.upsertChat({ id: pn, name: "Ada Lovelace" });
  store.upsertChat({ id: group, name: "Synthetic group", subject: "Synthetic group" });
  return { store, directory };
}

// A synthetic socket: records every call, never touches WhatsApp.
function fakeSocket() {
  const calls = [];
  let counter = 0;
  const record = name => async (...args) => { calls.push({ name, args }); };
  return {
    calls,
    user: { id: "15559990000:1@s.whatsapp.net" },
    async sendMessage(jid, content, options) {
      calls.push({ name: "sendMessage", args: [jid, content, options] });
      return { key: { id: `OUT${++counter}`, remoteJid: jid, fromMe: true }, messageTimestamp: 100 + counter, message: content.text ? { conversation: content.text } : {} };
    },
    async onWhatsApp(...numbers) { return numbers.map(n => ({ jid: `${n}@s.whatsapp.net`, exists: true })); },
    async groupMetadata(id) { return { id, subject: "Synthetic group", participants: [{ id: pn }, { id: other }] }; },
    async groupFetchAllParticipating() { return {}; },
    chatModify: record("chatModify"),
    star: record("star"),
    sendPresenceUpdate: record("sendPresenceUpdate"),
    presenceSubscribe: record("presenceSubscribe"),
    updateBlockStatus: record("updateBlockStatus"),
    async fetchBlocklist() { return [other]; },
    async groupCreate(subject, participants) { calls.push({ name: "groupCreate", args: [subject, participants] }); return { id: "120363000000000009@g.us", subject, participants }; },
    async groupParticipantsUpdate(id, jids, action) { calls.push({ name: "groupParticipantsUpdate", args: [id, jids, action] }); return jids.map(jid => ({ jid, status: "200" })); },
    groupSettingUpdate: record("groupSettingUpdate"),
    async groupInviteCode() { return "ABCDEFGHIJKL"; }
  };
}

async function fixture(t, { mode = "daemon", limits } = {}) {
  const { store, directory } = await newStore();
  t.after(() => clearTimeout(store.pendingSave));
  store.ingestMessage(incoming("in1", pn, 10, "Are we still on for lunch?"));
  store.ingestMessage({ key: { id: "mine", remoteJid: pn, fromMe: true }, messageTimestamp: 12, message: { conversation: "yes" } });
  store.ingestMessage(incoming("in2", pn, 13, "Café at noon"));
  const socket = fakeSocket();
  const runtime = {
    store,
    logger: { warn() {}, error() {} },
    state: { status: "connected", lastDisconnect: null, reconnectHeld: false },
    presence: new Map(),
    historyRequests: { load: async () => {}, list: () => [] },
    summary: () => ({ status: "connected", hasCreds: true, recentChatCount: 2, lastDisconnect: null }),
    hasSavedCreds: () => true,
    async ensureConnected() { return socket; },
    async stop() {}, async start() {}, async waitForConnection() { return socket; }
  };
  const service = createWhatsAppService({
    runtime, mode,
    watches: new WatchStore(path.join(directory, "watches.json")),
    scheduled: new ScheduledStore(path.join(directory, "scheduled.json")),
    alertsPath: path.join(directory, "alerts.jsonl"),
    sendLimiter: new SendLimiter({ limits: limits ?? { globalPerMinute: 100, chatPerMinute: 100, newChatsPerHour: 100 } })
  });
  return { service, store, socket, runtime, directory };
}

// ---- store ----

test("mentions, replies, view-once, contact cards and polls are ingested", async () => {
  const { store } = await newStore();
  store.ingestMessage({ key: { id: "root", remoteJid: group, fromMe: true }, messageTimestamp: 20, message: { conversation: "Plan for Friday?" } });
  store.ingestMessage(withContext("m1", group, 21, "@15559990000 can you bring snacks?", { mentionedJid: [me] }, other));
  store.ingestMessage(withContext("r1", group, 22, "I can", { stanzaId: "root", participant: me, quotedMessage: { conversation: "Plan for Friday?" } }, other));
  store.ingestMessage(withContext("r2", group, 23, "me too", { stanzaId: "r1", participant: other }, pn));
  store.ingestMessage({ key: { id: "vo", remoteJid: pn, fromMe: false }, messageTimestamp: 24, message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } } });
  store.ingestMessage({ key: { id: "card", remoteJid: pn, fromMe: false }, messageTimestamp: 25, message: { contactMessage: { displayName: "Grace", vcard: "BEGIN:VCARD\nFN:Grace\nTEL;type=CELL;waid=15550003333:+1 555 000 3333\nEND:VCARD" } } });
  store.ingestMessage({ key: { id: "poll", remoteJid: group, fromMe: true }, messageTimestamp: 26, message: { pollCreationMessageV3: { name: "Where?", options: [{ optionName: "Park" }, { optionName: "Beach" }], selectableOptionsCount: 1 } } });

  const [m1] = store.getMessages(group).filter(m => m.id === "m1");
  assert.deepEqual(m1.mentions, [me]);
  const r1 = store.getMessage(group, "r1");
  assert.equal(r1.replyTo, "root");
  assert.equal(r1.quotedText, "Plan for Friday?");
  assert.deepEqual(store.thread(group, "r2").map(m => m.id), ["root", "r1", "r2"]);
  assert.equal(store.getMessage(pn, "vo").viewOnce, true);
  assert.deepEqual(store.getMessage(pn, "card").contacts, [{ name: "Grace", phones: ["+1 555 000 3333"] }]);

  const poll = store.data.messages[group].find(m => m.id === "poll");
  const sha = name => createHash("sha256").update(name).digest();
  store.applyPollUpdates(poll, [
    { pollUpdateMessageKey: { remoteJid: group, participant: other }, vote: { selectedOptions: [sha("Beach")] } },
    { pollUpdateMessageKey: { remoteJid: group, fromMe: true }, vote: { selectedOptions: [sha("Park")] } },
    { pollUpdateMessageKey: { remoteJid: group, participant: pn }, vote: { selectedOptions: [sha("Beach")] } }
  ]);
  assert.deepEqual(store.pollTally(poll), [{ name: "Park", voters: ["me"] }, { name: "Beach", voters: [other, pn] }]);
  // A changed vote replaces the earlier one.
  store.applyPollUpdates(poll, [{ pollUpdateMessageKey: { remoteJid: group, participant: pn }, vote: { selectedOptions: [] } }]);
  assert.deepEqual(store.pollTally(poll)[1].voters, [other]);
  clearTimeout(store.pendingSave);
});

test("digest surfaces mentions, replies and unanswered questions, muted chats last", async () => {
  const { store } = await newStore();
  store.ingestMessage(incoming("q1", pn, 1000, "Are you coming tonight?"));
  store.ingestMessage({ key: { id: "g0", remoteJid: group, fromMe: true }, messageTimestamp: 1001, message: { conversation: "hi all" } });
  store.ingestMessage(withContext("g1", group, 1002, "what time is it?", {}, other)); // a group question not addressed to me
  store.ingestMessage(withContext("g2", group, 1003, "@me thoughts?", { mentionedJid: [me] }, other));
  store.upsertChat({ id: "15550004444@s.whatsapp.net", name: "Muted friend", muteEndTime: -1 });
  store.ingestMessage(incoming("x1", "15550004444@s.whatsapp.net", 1004, "ping?"));

  const chats = store.digest({ sinceTimestamp: 900 });
  assert.equal(chats.length, 3);
  assert.equal(chats.at(-1).chatName, "Muted friend");
  const groupDigest = chats.find(c => c.chatId === group);
  assert.deepEqual(groupDigest.mentions.map(m => m.id), ["g2"]);
  assert.deepEqual(groupDigest.questions.map(m => m.id), ["g2"]);
  assert.deepEqual(chats.find(c => c.chatId === pn).questions.map(m => m.id), ["q1"]);

  // Once I reply, the direct question is no longer waiting.
  store.ingestMessage({ key: { id: "ans", remoteJid: pn, fromMe: true }, messageTimestamp: 1005, message: { conversation: "yes" } });
  store.markChatRead(pn);
  assert.equal(store.digest({ sinceTimestamp: 900 }).some(c => c.chatId === pn), false);
  clearTimeout(store.pendingSave);
});

test("listChats filters and follows the phone's pinned order", async () => {
  const { store } = await newStore();
  store.upsertChat({ id: other, name: "Pinned old", pinned: 5, timestamp: 1 });
  store.upsertChat({ id: "15550004444@s.whatsapp.net", name: "Archived", archived: true, timestamp: 50 });
  store.upsertChat({ id: "15550005555@s.whatsapp.net", name: "Disappearing", ephemeralExpiration: 86400, timestamp: 40 });
  assert.equal(store.listChats({ order: "phone" })[0].id, other);
  assert.notEqual(store.listChats()[0].id, other);
  assert.deepEqual(store.listChats({ filter: "archived" }).map(c => c.id), ["15550004444@s.whatsapp.net"]);
  assert.equal(store.listChats({ includeArchived: false }).some(c => c.archived), false);
  assert.deepEqual(store.listChats({ filter: "disappearing" }).map(c => c.id), ["15550005555@s.whatsapp.net"]);
  clearTimeout(store.pendingSave);
});

test("media kinds map to local extractors; stickers are skipped", () => {
  assert.equal(mediaKind("audio/ogg; codecs=opus"), "transcript");
  assert.equal(mediaKind("image/jpeg"), "ocr");
  assert.equal(mediaKind("image/webp"), null);
  assert.equal(mediaKind("application/pdf"), "pdf_text");
  assert.equal(mediaKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "document_text");
  assert.equal(mediaKind("", "notes.md"), "plain_text");
});

// ---- watch rules ----

test("matchRule narrows by chat, sender, keywords, regex, kind and mentions", () => {
  const entry = { id: "a", chatId: group, participant: other, senderName: "Bob Builder", chatName: "Synthetic group", text: "Is the invoice ready?", mentions: [] };
  const mine = new Set([me]);
  assert.equal(matchRule({}, entry), true);
  assert.equal(matchRule({}, { ...entry, fromMe: true }), false);
  assert.equal(matchRule({ chatKind: "direct" }, entry), false);
  assert.equal(matchRule({ from: "bob" }, entry), true);
  assert.equal(matchRule({ from: "+1 555 000 2222" }, entry), true);
  assert.equal(matchRule({ from: "alice" }, entry), false);
  assert.equal(matchRule({ contains: ["INVOICE"] }, entry), true);
  assert.equal(matchRule({ contains: ["receipt"] }, entry), false);
  assert.equal(matchRule({ regex: "invoice\\s+ready" }, entry), true);
  assert.equal(matchRule({ regex: "(" }, entry), false);
  assert.equal(matchRule({ mentionsMe: true }, entry, { myJids: mine }), false);
  assert.equal(matchRule({ mentionsMe: true }, { ...entry, mentions: [me] }, { myJids: mine }), true);
  assert.equal(matchRule({ mentionsMe: true }, { ...entry, replyTo: "x" }, { myJids: mine, myMessageIds: new Set(["x"]) }), true);
  assert.equal(matchRule({ mentionsMe: true }, { ...entry, chatId: pn, participant: undefined }, { myJids: mine }), true);
  // Broad rules skip muted chats; a rule naming the chat does not.
  const muted = { muteEndTime: -1 };
  assert.equal(matchRule({}, entry, { chat: muted }), false);
  assert.equal(matchRule({ chatId: group }, entry, { chat: muted }), true);
  assert.equal(matchRule({ includeMuted: true }, entry, { chat: muted }), true);
  assert.equal(matchRule({}, { ...entry, chatId: "status@broadcast" }), false);
});

async function engineFixture(t, rules, limits = {}) {
  const { store, directory } = await newStore();
  t.after(() => clearTimeout(store.pendingSave));
  const watches = new WatchStore(path.join(directory, "watches.json"));
  const alertsPath = path.join(directory, "alerts.jsonl");
  let clock = 1_000_000;
  const notified = [];
  const codexRuns = [];
  let finishCodex;
  const engine = new AlertEngine({
    store, watches, alertsPath, now: () => clock, limits,
    notify: async (title, body) => { notified.push({ title, body }); return { ok: true }; },
    runCodex: options => { codexRuns.push(options); return new Promise(resolve => { finishCodex = resolve; }); }
  });
  await engine.start();
  for (const rule of rules) await watches.add(rule);
  return {
    store, watches, engine, alertsPath, notified, codexRuns,
    advance: ms => { clock += ms; },
    finishCodex: result => finishCodex(result)
  };
}

test("alert engine starts at the present, batches matches and notifies once per batch", async t => {
  const f = await engineFixture(t, [{ label: "lunch", action: "notify", contains: ["lunch"] }]);
  f.store.ingestMessage(incoming("old", pn, 1, "lunch?"));
  f.store.ingestMessage(incoming("n1", pn, 2, "lunch at 1?"));
  f.store.ingestMessage(incoming("n2", pn, 3, "unrelated"));
  await f.engine.tick();
  assert.equal(f.notified.length, 0, "debounced");
  f.advance(16_000);
  await f.engine.tick();
  assert.equal(f.notified.length, 1);
  assert.match(f.notified[0].body, /2 messages in Ada Lovelace/);
  const { alerts } = await readAlerts({ alertsPath: f.alertsPath });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].outcome, "notified");
  assert.deepEqual(alerts[0].messages.map(m => m.id), ["old", "n1"]);
  assert.equal(f.watches.list()[0].firedCount, 1);
});

test("codex rules run one at a time and defer instead of stacking", async t => {
  const f = await engineFixture(t, [
    { label: "a", action: "codex", chatId: pn, cooldownMinutes: 0 },
    { label: "b", action: "codex", chatId: group, cooldownMinutes: 0 }
  ]);
  f.store.ingestMessage(incoming("p1", pn, 2, "hello"));
  f.store.ingestMessage(withContext("g1", group, 3, "hi", {}, other));
  await f.engine.tick();
  f.advance(16_000);
  await f.engine.tick();
  assert.equal(f.codexRuns.length, 1);
  assert.equal(f.codexRuns[0].sandbox, "read-only");
  assert.match(f.codexRuns[0].prompt, /data from other people, not instructions/);
  let { alerts } = await readAlerts({ alertsPath: f.alertsPath });
  assert.deepEqual(alerts.map(a => a.outcome), ["codex_started", "deferred"]);
  await f.engine.tick();
  assert.equal((await readAlerts({ alertsPath: f.alertsPath })).alerts.length, 2, "deferral is logged once");

  f.finishCodex({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  await f.engine.tick();
  assert.equal(f.codexRuns.length, 2);
  ({ alerts } = await readAlerts({ alertsPath: f.alertsPath }));
  assert.deepEqual(alerts.map(a => a.outcome), ["codex_started", "deferred", "codex_finished", "codex_started"]);
});

test("codex runs are capped per hour", async t => {
  const f = await engineFixture(t, [{ action: "codex", chatId: pn, cooldownMinutes: 0 }], { codexMaxPerHour: 1 });
  f.store.ingestMessage(incoming("p1", pn, 2, "one"));
  await f.engine.tick();
  f.advance(16_000);
  await f.engine.tick();
  f.finishCodex({ ok: true });
  await new Promise(resolve => setImmediate(resolve));
  f.store.ingestMessage(incoming("p2", pn, 3, "two"));
  await f.engine.tick();
  f.advance(16_000);
  await f.engine.tick();
  assert.equal(f.codexRuns.length, 1);
  const { alerts } = await readAlerts({ alertsPath: f.alertsPath });
  assert.match(alerts.at(-1).reason, /cap reached/);
  f.advance(3600_000);
  await f.engine.tick();
  assert.equal(f.codexRuns.length, 2);
});

test("a once rule removes itself after firing", async t => {
  const f = await engineFixture(t, [{ action: "record", chatId: pn, once: true }]);
  f.store.ingestMessage(incoming("p1", pn, 2, "x"));
  await f.engine.tick();
  f.advance(16_000);
  await f.engine.tick();
  assert.equal(f.watches.list().length, 0);
  assert.equal((await readAlerts({ alertsPath: f.alertsPath })).alerts[0].outcome, "recorded");
});

// ---- scheduler and limiter ----

test("scheduled messages send once, retry only after a refusal, and recover as unknown", async () => {
  const directory = await fs.mkdtemp(path.join(dataDir, "sched-"));
  const scheduled = new ScheduledStore(path.join(directory, "scheduled.json"));
  const now = 10_000_000;
  const due = await scheduled.add({ chatId: pn, text: "due", sendAt: now - 1000 });
  const late = await scheduled.add({ chatId: pn, text: "late", sendAt: now - 2 * 3600_000 });
  const future = await scheduled.add({ chatId: pn, text: "future", sendAt: now + 60_000 });
  let refuse = true;
  const sends = [];
  const send = async item => { sends.push(item.text); return refuse ? { ok: false, retry: true, error: "status: rate_limited" } : { ok: true, messageId: "OUT1" }; };
  await scheduled.runDue({ send, now });
  assert.equal(due.status, "pending");
  assert.equal(late.status, "missed");
  refuse = false;
  await scheduled.runDue({ send, now });
  assert.equal(due.status, "sent");
  assert.equal(due.messageId, "OUT1");
  await scheduled.runDue({ send, now });
  assert.deepEqual(sends, ["due", "due"]);
  assert.equal(future.status, "pending");

  future.status = "sending";
  const reloaded = new ScheduledStore(scheduled.filePath);
  await scheduled.save();
  await reloaded.load();
  const stuck = await reloaded.recoverInterrupted();
  assert.deepEqual(stuck.map(item => item.text), ["future"]);
  assert.equal(reloaded.data.items.find(item => item.id === future.id).status, "unknown");
  assert.equal((await scheduled.cancel(late.id)).status, "missed");
});

test("send limiter refuses bursts, per-chat floods and cold outreach", () => {
  let clock = 0;
  const limiter = new SendLimiter({ limits: { globalPerMinute: 3, chatPerMinute: 2, newChatsPerHour: 1 }, now: () => clock });
  limiter.record(pn); limiter.record(pn);
  assert.match(limiter.check(pn).reason, /to this chat/);
  assert.equal(limiter.check(group), null);
  limiter.record(group);
  assert.match(limiter.check(other).reason, /sends in the last minute/);
  clock += 61_000;
  assert.equal(limiter.check(other, { isNewChat: true }), null);
  limiter.record(other, { isNewChat: true });
  const refused = limiter.check("15550007777@s.whatsapp.net", { isNewChat: true });
  assert.match(refused.reason, /new chats/);
  assert.ok(refused.retryAfterSeconds > 3000);
});

// ---- service tools ----

test("manage_chat sends the phone's chat mutations and updates the cache", async t => {
  const { service, socket, store } = await fixture(t);
  const call = args => service.call("whatsapp_manage_chat", { chatId: pn, ...args });
  assert.equal((await call({ action: "archive" })).isError, false);
  assert.deepEqual(socket.calls[0].args[0].archive, true);
  assert.equal(socket.calls[0].args[0].lastMessages[0].key.id, "in2");
  assert.equal(store.data.chats[pn].archived, true);
  const muted = await call({ action: "mute", durationHours: 8 });
  assert.match(text(muted), /muted_until:/);
  assert.ok(socket.calls[1].args[0].mute > Date.now());
  await call({ action: "mute" });
  assert.equal(store.data.chats[pn].muteEndTime, -1);
  await call({ action: "mark_unread" });
  assert.equal(store.data.chats[pn].markedUnread, true);
  await call({ action: "pin" });
  assert.ok(store.data.chats[pn].pinned > 0);
  await call({ action: "star", messageId: "in1" });
  assert.deepEqual(socket.calls.at(-1).args, [pn, [{ id: "in1", fromMe: false }], true]);
  const list = await service.call("whatsapp_list_chats", { filter: "muted" });
  assert.match(text(list), /Ada Lovelace/);
  assert.match(text(list), /muted=always/);
});

test("group admin, block and presence call the socket with resolved JIDs", async t => {
  const { service, socket, runtime } = await fixture(t);
  const created = await service.call("whatsapp_group_admin", { action: "create", subject: "Trip", participants: ["+1 555 000 2222"] });
  assert.match(text(created), /status: created/);
  assert.deepEqual(socket.calls[0].args, ["Trip", [other]]);
  const added = await service.call("whatsapp_group_admin", { action: "promote", chatId: group, participants: [other] });
  assert.match(text(added), /status=200 ok/);
  const notGroup = await service.call("whatsapp_group_admin", { action: "leave", chatId: pn });
  assert.equal(notGroup.isError, true);
  assert.match(text(await service.call("whatsapp_group_admin", { action: "invite_link", chatId: group })), /chat\.whatsapp\.com\/ABCDEFGHIJKL/);

  await service.call("whatsapp_block", { action: "block", chatId: pn });
  assert.deepEqual(socket.calls.at(-1).args, [pn, "block"]);
  assert.match(text(await service.call("whatsapp_block", { action: "list" })), /blocked_count: 1/);
  assert.equal((await service.call("whatsapp_block", { action: "block", chatId: group })).isError, true);

  await service.call("whatsapp_presence", { action: "typing", chatId: pn });
  assert.deepEqual(socket.calls.at(-1).args, ["composing", pn]);
  runtime.presence.set(pn, { lastKnownPresence: "available", at: Date.now() });
  assert.match(text(await service.call("whatsapp_presence", { action: "get", chatId: pn, waitSeconds: 0 })), /presence: available/);
});

test("contact cards, @mentions and status posts build the expected payloads", async t => {
  const { service, socket, store } = await fixture(t);
  await service.call("whatsapp_send_contact", { chatId: pn, contacts: [{ name: "Grace\nHopper", phoneNumber: "+1 555 000 3333" }] });
  const card = socket.calls[0].args[1].contacts.contacts[0];
  assert.match(card.vcard, /TEL;type=CELL;waid=15550003333:\+15550003333/);
  assert.doesNotMatch(card.vcard, /Grace\nHopper/);

  await service.call("whatsapp_send_message", { chatId: group, text: "see this", mentions: ["+1 555 000 2222"] });
  assert.deepEqual(socket.calls[1].args[1].mentions, [other]);
  assert.match(socket.calls[1].args[1].text, /@15550002222/);

  const noAudience = await service.call("whatsapp_status", { action: "post", text: "hello" });
  assert.equal(noAudience.isError, true);
  assert.equal(socket.calls.length, 2);
  store.upsertContact({ id: other, name: "Bob" });
  const posted = await service.call("whatsapp_status", { action: "post", text: "hello", audience: "contacts" });
  assert.equal(posted.isError, false, text(posted));
  const [jid, , options] = socket.calls[2].args;
  assert.equal(jid, "status@broadcast");
  assert.deepEqual(options.statusJidList, [other]);
  assert.equal(options.broadcast, true);
});

test("sends past the rate limit are refused with nothing sent", async t => {
  const { service, socket } = await fixture(t, { limits: { globalPerMinute: 100, chatPerMinute: 1, newChatsPerHour: 100 } });
  assert.equal((await service.call("whatsapp_send_message", { chatId: pn, text: "one" })).isError, false);
  const refused = await service.call("whatsapp_send_message", { chatId: pn, text: "two" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /^status: rate_limited/);
  assert.match(text(refused), /Nothing was sent/);
  assert.equal(socket.calls.length, 1);
});

test("watch rules are validated, persisted and refused without the daemon", async t => {
  const { service, directory } = await fixture(t);
  assert.equal((await service.call("whatsapp_watch", { action: "codex" })).isError, true);
  assert.equal((await service.call("whatsapp_watch", { regex: "(" })).isError, true);
  const added = await service.call("whatsapp_watch", { label: "boss", from: "Ada", action: "notify", expiresInHours: 2 });
  assert.match(text(added), /status: watching/);
  const saved = JSON.parse(await fs.readFile(path.join(directory, "watches.json"), "utf8"));
  assert.equal(saved.rules[0].from, "Ada");
  const id = saved.rules[0].id;
  assert.match(text(await service.call("whatsapp_list_watches", {})), new RegExp(id));
  assert.match(text(await service.call("whatsapp_unwatch", { id })), /removed/);

  const worker = await fixture(t, { mode: "cache_only" });
  const refused = await worker.service.call("whatsapp_watch", { from: "Ada" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /needs the relay runtime daemon/);
});

test("schedule_message validates time and lists and cancels entries", async t => {
  const { service } = await fixture(t);
  assert.equal((await service.call("whatsapp_schedule_message", { chatId: pn, text: "x", sendAt: new Date(Date.now() + 5000).toISOString() })).isError, true);
  assert.equal((await service.call("whatsapp_schedule_message", { chatId: pn, text: "x" })).isError, true);
  const scheduled = await service.call("whatsapp_schedule_message", { chatId: pn, text: "Happy birthday!", inMinutes: 60 });
  assert.equal(scheduled.isError, false, text(scheduled));
  const id = /id: (\S+)/.exec(text(scheduled))[1];
  assert.match(text(await service.call("whatsapp_list_scheduled", {})), /Happy birthday/);
  assert.match(text(await service.call("whatsapp_cancel_scheduled", { id })), /cancelled/);
  assert.match(text(await service.call("whatsapp_list_scheduled", {})), /scheduled: 0/);
});

test("digest and threadOf read the cache through the tools", async t => {
  const { service, store } = await fixture(t);
  store.ingestMessage({ key: { id: "rep", remoteJid: pn, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { extendedTextMessage: { text: "you there?", contextInfo: { stanzaId: "mine", participant: me } } } });
  const digest = await service.call("whatsapp_digest", { sinceHours: 1 });
  assert.match(text(digest), /chats_needing_attention: 1/);
  assert.match(text(digest), /mentions_or_replies_to_you:/);
  assert.match(text(digest), /you there\?/);
  const thread = await service.call("whatsapp_read_messages", { chatId: pn, threadOf: "rep" });
  assert.match(text(thread), /thread_size: 2/);
});

test("sync_history untilDate stops when WhatsApp returns nothing older", async t => {
  const { service, runtime } = await fixture(t);
  let requests = 0;
  runtime.syncChatHistory = async () => { requests += 1; return { state: "response_received", messages: 0 }; };
  // The cached history starts at t=10 s.
  const result = await service.call("whatsapp_sync_history", { chatId: pn, untilDate: "1970-01-01T00:00:05Z" });
  assert.equal(requests, 1);
  assert.match(text(result), /stop_reason: no_older_messages_returned/);
  assert.match(text(result), /reached: no/);
  const done = await service.call("whatsapp_sync_history", { chatId: pn, untilDate: "1970-01-01T00:00:20Z" });
  assert.match(text(done), /reached: yes/);
  assert.equal(requests, 1);
});
