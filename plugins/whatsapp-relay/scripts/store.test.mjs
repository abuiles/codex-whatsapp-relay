import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppStore, extractMessageText } from "./store.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-store-test-"));
  const store = new WhatsAppStore(path.join(directory, "store.json"));
  t.after(async () => { clearTimeout(store.pendingSave); await fs.rm(directory, { recursive: true, force: true }); });
  return store;
}
const pn = "10000000000@s.whatsapp.net", lid = "20000000000@lid";
const message = (id, remoteJid, time, text, extra = {}) => ({ key: { id, remoteJid, fromMe: false }, messageTimestamp: time, message: { conversation: text }, ...extra });

test("queried direct contacts resolve without fabricating a conversation or history", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: pn, name: "Synthetic\u00a0 Researcher", verifiedName: "Synthetic Lab" });
  assert.equal(store.listChats().length, 0);
  const match = store.resolveChat({ chatName: "synthetic researcher" }).match;
  assert.equal(match.id, pn);
  assert.equal(match.cacheEntryKind, "contact_only");
  assert.equal(store.getMessageCount(match.id), 0);
  assert.equal(store.resolveChat({ chatId: pn }).match.id, pn);
  assert.equal(store.listChats({ query: "Synthetic Lab" }).length, 1);
  assert.equal(store.listChats({ query: "Synthetic", unreadOnly: true }).length, 0);
  assert.equal(Object.keys(store.data.chats).length, 0);
  assert.equal(Object.keys(store.data.messages).length, 0);
});

test("same names in cached chats and contact-only records remain ambiguous", async t => {
  const store = await fixture(t);
  store.upsertChat({ id: pn, name: "Synthetic duplicate" });
  store.upsertContact({ id: "10000000001@s.whatsapp.net", name: "Synthetic duplicate" });
  const result = store.resolveChat({ chatName: "Synthetic duplicate" });
  assert.equal(result.match, null);
  assert.equal(result.candidates.length, 2);
  store.upsertContact({ id: lid, phoneNumber: pn, name: "Synthetic duplicate" });
  assert.equal(store.listChats({ query: "Synthetic duplicate" }).length, 2);
});

test("human contact labels replace masked phone names without renaming groups", async t => {
  const store = await fixture(t);
  store.upsertChat({ id: pn, name: "+1\u2219\u2219\u221900" });
  store.upsertContact({ id: pn, name: "+1\u2219\u2219\u221900", notify: "Synthetic recipient" });
  assert.equal(store.listChats({ query: "Synthetic recipient" })[0].displayName, "Synthetic recipient");
  store.upsertContact({ id: pn, name: "Saved researcher" });
  assert.equal(store.listChats()[0].displayName, "Saved researcher");
  store.upsertChat({ id: "10000000000@g.us", name: "Synthetic group" });
  store.upsertContact({ id: "10000000000@g.us", notify: "Participant" });
  assert.equal(store.listChats({ query: "Synthetic group" })[0].displayName, "Synthetic group");
});

test("outgoing sender labels never become the recipient name", async t => {
  const store = await fixture(t);
  const outgoing = message("outgoing", pn, 1, "synthetic", { pushName: "Own sender label" });
  outgoing.key.fromMe = true;
  store.ingestMessage(outgoing);
  assert.equal(store.listChats({ query: "Own sender label" }).length, 0);
  store.ingestMessage(message("incoming", pn, 2, "synthetic", { pushName: "Peer label" }));
  assert.equal(store.listChats({ query: "Peer label" }).length, 1);
});

test("phone and LID histories merge without losing recent messages or the saved name", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: pn, name: "Synthetic parent" });
  store.ingestMessage(message("older", pn, 1, "older"));
  store.ingestMessage(message("newer", lid, 2, "newer"));
  store.recordJidMapping({ lid, pn });
  assert.deepEqual(store.getMessages(pn).map(m => m.id), ["older", "newer"]);
  assert.equal(store.resolveChat({ chatId: lid }).match.id, pn);
  assert.equal(store.listChats({ query: "Synthetic parent" }).length, 1);
  assert.equal(store.listChats()[0].lastMessageText, "newer");
  assert.equal(store.listChats()[0].lastMessageId, "newer");
});

test("alternate message IDs and contact mappings resolve into one chat", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: lid, phoneNumber: pn, name: "Synthetic" });
  const msg = message("one", lid, 3, "one"); msg.key.remoteJidAlt = pn;
  store.ingestMessage(msg);
  store.ingestMessage(msg);
  assert.equal(store.getMessageCount(pn), 1);
  assert.equal(store.data.chats[pn].unreadCount, 1);
  store.recordJidMapping({ lid: "not-a-lid", pn });
  assert.equal(Object.keys(store.data.meta.jidAliases).length, 1);
});

test("persisted media retains downloadable keys and roundtrips through protobuf", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("image", pn, 4, "", { message: { imageMessage: {
    caption: "Synthetic image", mimetype: "image/png", mediaKey: Buffer.alloc(32, 7), directPath: "/synthetic", fileLength: 12
  } } }));
  await store.save();
  const copy = new WhatsAppStore(store.filePath); await copy.load();
  const raw = copy.getRawMessage(pn, "image");
  assert.equal(raw.message.imageMessage.mediaKey.length, 32);
  assert.equal(raw.message.imageMessage.mediaKey[0], 7);
  assert.equal(copy.getMessages(pn)[0].media.mimetype, "image/png");
  assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
});

test("contact messages are readable and message revocation removes downloadable content", async t => {
  const store = await fixture(t);
  assert.equal(extractMessageText({ contactMessage: { displayName: "Synthetic contact", vcard: "synthetic" } }), "[contact] Synthetic contact");
  store.ingestMessage(message("one", pn, 1, "private"));
  store.updateMessage({ remoteJid: pn, id: "one" }, { message: null });
  assert.equal(store.getMessages(pn)[0].text, "[deleted]");
  assert.equal(store.getRawMessage(pn, "one"), null);
  assert.equal(store.listChats()[0].lastMessageText, "[deleted]");
});

test("edits and acknowledgements in the same event update the current cached entry", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("one", pn, 1, "", { message: { imageMessage: { caption: "before", mimetype: "image/png" } } }));
  store.updateMessage({ remoteJid: pn, id: "one" }, { message: { conversation: "after" }, status: 3 });
  const entry = store.getMessages(pn)[0];
  assert.equal(entry.text, "after");
  assert.equal(entry.deliveryStatus, 3);
  assert.equal(entry.media, undefined);
  assert.equal(store.getRawMessage(pn, "one").status, 3);
  assert.equal(store.listChats()[0].lastMessageText, "after");
});

test("late mapping merges duplicate IDs and refuses conflicting reassignment", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("same", pn, 1, "same"));
  store.ingestMessage(message("same", lid, 1, "same"));
  store.recordJidMapping({ lid, pn });
  assert.equal(store.getMessageCount(pn), 1);
  store.recordJidMapping({ lid, pn: "19999999999@s.whatsapp.net" });
  assert.equal(store.canonicalJid(lid), pn);
  assert.equal(store.data.meta.jidMappingConflictCount, 1);
});

test("revoking an older message leaves the newer chat preview intact", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("old", pn, 1, "old"));
  store.ingestMessage(message("new", pn, 2, "new"));
  store.updateMessage({ remoteJid: pn, id: "old" }, { message: null });
  assert.equal(store.listChats()[0].lastMessageText, "new");
});

test("duplicate exact names remain ambiguous even beyond the previous fifty-result cutoff", async t => {
  const store = await fixture(t);
  for (let i = 0; i < 60; i++) store.upsertChat({ id: `${10000000100 + i}@s.whatsapp.net`, name: "Synthetic name", timestamp: i });
  const resolved = store.resolveChat({ chatName: "Synthetic name" });
  assert.equal(resolved.match, null);
  assert.equal(resolved.candidates.length, 60);
});

test("a slow earlier save cannot overwrite a newer cache snapshot", async t => {
  const store = await fixture(t);
  const files = new Map();
  let firstWrite = true;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const writeFile = fs.writeFile.bind(fs);
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "writeFile", async (file, data, options) => {
    if (!String(file).startsWith(`${store.filePath}.`)) return writeFile(file, data, options);
    if (firstWrite) { firstWrite = false; entered(); await blocked; }
    files.set(file, data);
  });
  t.mock.method(fs, "rename", async (from, to) => {
    if (to !== store.filePath) return rename(from, to);
    files.set(to, files.get(from)); files.delete(from);
  });
  store.data.meta.syntheticRevision = 1;
  const first = store.save();
  await started;
  store.data.meta.syntheticRevision = 2;
  const second = store.save();
  await new Promise(setImmediate);
  release();
  await Promise.all([first, second]);
  assert.equal(JSON.parse(files.get(store.filePath)).meta.syntheticRevision, 2);
});

test("a failed cache write leaves no partial file and does not poison later saves", async t => {
  const store = await fixture(t);
  const writeFile = fs.writeFile.bind(fs);
  let fail = true;
  t.mock.method(fs, "writeFile", async (file, data, options) => {
    await writeFile(file, data, options);
    if (fail && String(file).startsWith(`${store.filePath}.`)) { fail = false; throw new Error("synthetic write failure"); }
  });
  await assert.rejects(store.save(), /synthetic write failure/);
  assert.deepEqual(await fs.readdir(path.dirname(store.filePath)), []);
  store.data.meta.syntheticRevision = 2;
  await store.save();
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).meta.syntheticRevision, 2);
});

test("early acknowledgements survive insertion and duplicate pending snapshots", async t => {
  const store = await fixture(t);
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 2 });
  store.ingestMessage(message("sent", pn, 1, "test", { status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 2);
  store.ingestMessage(message("sent", pn, 1, "test", { status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 2);
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 4 });
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 2 });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 4);
});

test("explicit send failures are not erased by later pending snapshots", async t => {
  const store = await fixture(t);
  store.updateMessage({ remoteJid: pn, id: "sent" }, { status: 0 });
  store.ingestMessage(message("sent", pn, 1, "test", { status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 0);
});

test("unaddressed self-device receipts and service-JID ACKs resolve only unique outgoing IDs", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("out", pn, 1, "test", { key: { remoteJid: pn, id: "out", fromMe: true }, status: 1 }));
  store.updateMessage({ id: "out", fromMe: true }, { status: 3 });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 3);
  store.ingestMessage(message("server-ack", pn, 2, "test", { key: { remoteJid: pn, id: "server-ack", fromMe: true }, status: 1 }));
  store.updateMessage({ remoteJid: "s.whatsapp.net", id: "server-ack", fromMe: true }, { status: 2 });
  assert.equal(store.getMessages(pn)[1].deliveryStatus, 2);
  store.ingestMessage(message("incoming", pn, 3, "test", { status: 1 }));
  store.updateMessage({ id: "incoming", fromMe: true }, { status: 4 });
  assert.equal(store.getMessages(pn)[2].deliveryStatus, 1);
  store.ingestMessage(message("out", "30000000000@s.whatsapp.net", 4, "duplicate ID", { key: { remoteJid: "30000000000@s.whatsapp.net", id: "out", fromMe: true }, status: 1 }));
  store.updateMessage({ id: "out", fromMe: true }, { status: 5 });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 3);
});

test("an unaddressed ACK before send completion is retained for the outgoing message", async t => {
  const store = await fixture(t);
  store.updateMessage({ id: "early", fromMe: true }, { status: 2 });
  store.ingestMessage(message("early", pn, 1, "test", { key: { remoteJid: pn, id: "early", fromMe: true }, status: 1 }));
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 2);
  assert.equal(store.pendingMessageStatuses.size, 0);
});

test("real receipt timestamps survive history merges without promoting zero timestamps or whole groups", async t => {
  const store = await fixture(t);
  const raw = message("audio", pn, 1, "", { key: { remoteJid: pn, id: "audio", fromMe: true },
    message: { audioMessage: { mimetype: "audio/ogg", ptt: true } }, status: 1,
    userReceipt: [{ userJid: pn, receiptTimestamp: 10, readTimestamp: 0 }] });
  store.ingestMessage(raw);
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 3);
  assert.deepEqual(store.getMessages(pn)[0].receipts, { delivered: 1, read: 0, played: 0 });
  store.updateReceipt(raw.key, { userJid: pn, readTimestamp: 11, playedTimestamp: 12 });
  // A later history copy without receipts must not erase observed evidence.
  store.ingestMessage({ ...raw, userReceipt: [] });
  assert.equal(store.getMessages(pn)[0].deliveryStatus, 5);
  await store.save();
  const copy = new WhatsAppStore(store.filePath); await copy.load();
  assert.equal(copy.getMessages(pn)[0].deliveryStatus, 5);
  const group = "12345@g.us";
  store.ingestMessage({ ...raw, key: { ...raw.key, remoteJid: group } });
  assert.equal(store.getMessages(group)[0].deliveryStatus, 1);
  store.ingestMessage({ ...raw, key: { ...raw.key, id: "zero" }, userReceipt: [{ userJid: pn, receiptTimestamp: 0 }] });
  assert.equal(store.getMessages(pn).find(item => item.id === "zero").deliveryStatus, 1);
});

test("phone numbers resolve in any common format, with or without country code", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: "919876543210@s.whatsapp.net", name: "Synthetic phone contact" });
  store.upsertChat({ id: "15550001111@s.whatsapp.net", name: "Synthetic US chat" });
  for (const query of ["+91 98765 43210", "919876543210", "098765-43210", "(987) 654-3210"]) {
    assert.equal(store.resolveChat({ chatName: query }).match?.id, "919876543210@s.whatsapp.net", query);
  }
  assert.equal(store.listChats({ query: "+1 555 000 1111" })[0].id, "15550001111@s.whatsapp.net");
  assert.equal(store.listChats({ query: "12345" }).length, 0, "short digit runs are not phone lookups");
});

test("name search folds accents and matches words in any order", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: pn, name: "José Álvarez Núñez" });
  assert.equal(store.resolveChat({ chatName: "jose alvarez" }).match?.id, pn);
  assert.equal(store.resolveChat({ chatName: "nunez jose" }).match?.id, pn);
  assert.equal(store.listChats({ query: "JOSÉ" }).length, 1);
});

test("message search finds cached text across chats, newest first, with chat names", async t => {
  const store = await fixture(t);
  store.upsertChat({ id: pn, name: "Synthetic alpha" });
  store.upsertChat({ id: "10000000001@s.whatsapp.net", name: "Synthetic beta" });
  store.ingestMessage(message("a1", pn, 10, "Invoice number 42 is ready"));
  store.ingestMessage(message("a2", pn, 20, "unrelated"));
  store.ingestMessage(message("b1", "10000000001@s.whatsapp.net", 30, "Second invoice for café"));
  const hits = store.searchMessages({ query: "invoice" });
  assert.deepEqual(hits.map(hit => hit.id), ["b1", "a1"]);
  assert.equal(hits[0].chatName, "Synthetic beta");
  assert.deepEqual(store.searchMessages({ query: "cafe invoice" }).map(hit => hit.id), ["b1"]);
  assert.deepEqual(store.searchMessages({ query: "invoice", chatId: pn }).map(hit => hit.id), ["a1"]);
  assert.deepEqual(store.searchMessages({ query: "invoice", limit: 1 }).map(hit => hit.id), ["b1"]);
});

test("messages since a cursor are listed oldest first and exclude own messages by default", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("old", pn, 10, "before"));
  store.ingestMessage(message("new", pn, 20, "after"));
  const own = message("own", pn, 25, "mine");
  own.key.fromMe = true;
  store.ingestMessage(own);
  store.ingestMessage(message("g", "1-2@g.us", 30, "group", { key: { id: "g", remoteJid: "1-2@g.us", participant: pn, fromMe: false } }));
  assert.deepEqual(store.messagesSince({ sinceTimestamp: 10 }).map(m => m.id), ["new", "g"]);
  assert.deepEqual(store.messagesSince({ sinceTimestamp: 10, includeFromMe: true }).map(m => m.id), ["new", "own", "g"]);
  assert.deepEqual(store.messagesSince({ sinceTimestamp: 0, chatId: pn }).map(m => m.id), ["old", "new"]);
});

test("group participants are labelled with saved contact names", async t => {
  const store = await fixture(t);
  store.upsertContact({ id: pn, name: "Synthetic member" });
  assert.equal(store.senderName({ participant: pn, pushName: "push label" }), "Synthetic member");
  assert.equal(store.senderName({ participant: "10000000009@s.whatsapp.net", pushName: "push label" }), "push label");
  assert.equal(store.senderName({ fromMe: true }), "me");
});

test("reactions attach to their target message instead of becoming chat messages", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("target", pn, 10, "hello"));
  const react = (id, text, fromMe = false) => ({ key: { id, remoteJid: pn, fromMe }, messageTimestamp: 11,
    message: { reactionMessage: { key: { id: "target", remoteJid: pn, fromMe: false }, text } } });
  store.ingestMessage(react("r1", "👍"));
  store.ingestMessage(react("r2", "❤️", true));
  assert.deepEqual(store.getMessages(pn).map(m => m.id), ["target"]);
  assert.deepEqual(store.getMessages(pn)[0].reactions, { [pn]: "👍", me: "❤️" });
  assert.equal(store.data.chats[pn].lastMessageText, "hello");
  store.ingestMessage(react("r3", "", true));
  assert.deepEqual(store.getMessages(pn)[0].reactions, { [pn]: "👍" });
  store.ingestMessage({ ...react("r4", "🔥"), message: { reactionMessage: { key: { id: "uncached" }, text: "🔥" } } });
  assert.equal(store.getMessageCount(pn), 1);
});

test("protocol edits and revokes update their target and replies record the quoted ID", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("orig", pn, 10, "first draft"));
  const protocol = (id, body) => ({ key: { id, remoteJid: pn, fromMe: false }, messageTimestamp: 12, message: { protocolMessage: body } });
  store.ingestMessage(protocol("p1", { type: 14, key: { id: "orig", remoteJid: pn }, editedMessage: { conversation: "final text" } }));
  let [entry] = store.getMessages(pn);
  assert.equal(entry.text, "final text");
  assert.ok(entry.editedAt);
  assert.equal(store.data.chats[pn].lastMessageText, "final text");
  store.ingestMessage({ key: { id: "reply", remoteJid: pn, fromMe: true }, messageTimestamp: 13,
    message: { extendedTextMessage: { text: "answer", contextInfo: { stanzaId: "orig" } } } });
  assert.equal(store.getMessages(pn).at(-1).replyTo, "orig");
  store.ingestMessage(protocol("p2", { type: 0, key: { id: "orig", remoteJid: pn } }));
  [entry] = store.getMessages(pn);
  assert.equal(entry.messageType, "revoked");
  assert.deepEqual(store.getMessages(pn).map(m => m.id), ["orig", "reply"]);
});

test("unread counts offline arrivals, ignores chats.update deltas, and resets on read or reply", async t => {
  const store = await fixture(t);
  store.upsertChat({ id: pn, name: "Synthetic" });
  for (let i = 1; i <= 3; i += 1) store.ingestMessage(message(`m${i}`, pn, 100 + i, `hi ${i}`));
  // Baileys' buffered delta (+1 for the last batch) must not overwrite the total.
  store.upsertChat({ id: pn, unreadCount: 1 });
  assert.equal(store.data.chats[pn].unreadCount, 3);
  // Read on the phone (app-state) clears it; a marked-unread flag is kept apart.
  store.upsertChat({ id: pn, unreadCount: 0 });
  assert.equal(store.data.chats[pn].unreadCount, 0);
  store.upsertChat({ id: pn, unreadCount: -1 });
  assert.equal(store.data.chats[pn].markedUnread, true);
  store.ingestMessage(message("m4", pn, 104, "again"));
  assert.equal(store.data.chats[pn].unreadCount, 1);
  store.ingestMessage({ key: { id: "me1", remoteJid: pn, fromMe: true }, messageTimestamp: 105, message: { conversation: "reply" } });
  assert.equal(store.data.chats[pn].unreadCount, 0);
  // A redelivered message and history sync never count twice.
  store.ingestMessage(message("m4", pn, 104, "again"));
  store.ingestHistory({ chats: [], contacts: [], messages: [message("h1", pn, 90, "old")] });
  assert.equal(store.data.chats[pn].unreadCount, 0);
  store.ingestHistory({ chats: [{ id: pn, unreadCount: 7 }], contacts: [], messages: [] });
  assert.equal(store.data.chats[pn].unreadCount, 7);
  store.markChatRead(pn);
  assert.equal(store.data.chats[pn].unreadCount, 0);
  assert.equal(store.data.chats[pn].markedUnread, false);
});

test("the inbox cursor follows arrival order, so old-timestamp backlog is not skipped", async t => {
  const store = await fixture(t);
  store.ingestMessage(message("a", pn, 1000, "live"));
  const first = store.inbox();
  assert.deepEqual(first.messages.map(m => m.id), ["a"]);
  assert.equal(store.inbox({ cursor: first.nextCursor }).messages.length, 0);
  // Offline backlog arrives later but carries an older timestamp.
  store.ingestMessage(message("b", lid, 500, "backlog"));
  store.ingestMessage({ key: { id: "c", remoteJid: pn, fromMe: true }, messageTimestamp: 1001, message: { conversation: "mine" } });
  const next = store.inbox({ cursor: first.nextCursor });
  assert.deepEqual(next.messages.map(m => m.id), ["b"]);
  assert.deepEqual(store.inbox({ cursor: first.nextCursor, includeFromMe: true }).messages.map(m => m.id), ["b", "c"]);
  const paged = store.inbox({ cursor: first.nextCursor, includeFromMe: true, limit: 1 });
  assert.equal(paged.truncated, true);
  assert.deepEqual(store.inbox({ cursor: paged.nextCursor, includeFromMe: true }).messages.map(m => m.id), ["c"]);
  // History sync has no arrival sequence and never shows up as new.
  store.ingestHistory({ chats: [], contacts: [], messages: [message("h", pn, 2000, "synced")] });
  assert.equal(store.inbox({ cursor: next.nextCursor }).messages.length, 0);
});

test("undecryptable stubs are labelled, counted as unread, and filled in by a later resend", async t => {
  const store = await fixture(t);
  const CIPHERTEXT = 2;
  store.ingestMessage({ key: { id: "x", remoteJid: pn, fromMe: false }, messageTimestamp: 100, messageStubType: CIPHERTEXT, messageStubParameters: ["No session"] });
  store.ingestMessage({ key: { id: "g", remoteJid: pn, fromMe: false }, messageTimestamp: 101, messageStubType: 20 });
  let [stub, system] = store.getMessages(pn, 10);
  assert.equal(stub.messageType, "undecryptable");
  assert.match(system.messageType, /^system_/);
  assert.equal(store.data.chats[pn].unreadCount, 1);
  store.updateMessage({ remoteJid: pn, id: "x", fromMe: false }, { message: { conversation: "recovered" } });
  [stub] = store.getMessages(pn, 10);
  assert.equal(stub.text, "recovered");
  assert.equal(stub.stubType, undefined);
  // A late stub never overwrites real content.
  store.ingestMessage({ key: { id: "x", remoteJid: pn, fromMe: false }, messageTimestamp: 100, messageStubType: CIPHERTEXT });
  assert.equal(store.getMessages(pn, 10)[0].text, "recovered");
  assert.equal(store.data.chats[pn].unreadCount, 1);
});

test("loading a pre-v1 cache repairs unread counts from messages since the last reply", async t => {
  const store = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  await fs.writeFile(store.filePath, JSON.stringify({
    meta: {},
    chats: { [pn]: { id: pn, unreadCount: 1 } },
    contacts: {},
    messages: { [pn]: [
      { id: "1", chatId: pn, fromMe: false, timestamp: now - 300, text: "before" },
      { id: "2", chatId: pn, fromMe: true, timestamp: now - 200, text: "reply" },
      ...[3, 4, 5].map(i => ({ id: String(i), chatId: pn, fromMe: false, timestamp: now - 100 + i, text: "new" }))
    ] }
  }));
  await store.load();
  assert.equal(store.data.chats[pn].unreadCount, 3);
  assert.equal(store.data.meta.unreadModelVersion, 2);
});

test("status updates never count as unread, and a stale count is cleared when your reply is newest", async t => {
  const store = await fixture(t);
  const now = Math.floor(Date.now() / 1000);
  await fs.writeFile(store.filePath, JSON.stringify({
    meta: { unreadModelVersion: 1 },
    chats: { "status@broadcast": { id: "status@broadcast", unreadCount: 65 }, [pn]: { id: pn, unreadCount: 1 } },
    contacts: {},
    messages: { [pn]: [
      { id: "1", chatId: pn, fromMe: false, timestamp: now - 20, text: "q" },
      { id: "2", chatId: pn, fromMe: true, timestamp: now - 10, text: "a" }
    ] }
  }));
  await store.load();
  assert.equal(store.data.chats["status@broadcast"].unreadCount, 0);
  assert.equal(store.data.chats[pn].unreadCount, 0);
  store.ingestMessage(message("s1", "status@broadcast", now, "my story", { key: { id: "s1", remoteJid: "status@broadcast", fromMe: false, participant: lid } }));
  assert.equal(store.data.chats["status@broadcast"].unreadCount, 0);
  assert.equal(store.inbox({ cursor: 0 }).messages.length, 0);
  assert.equal(store.inbox({ cursor: 0, chatId: "status@broadcast" }).messages.length, 1);
});
