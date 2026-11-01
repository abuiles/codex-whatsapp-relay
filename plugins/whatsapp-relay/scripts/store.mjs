import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { jidNormalizedUser, proto } from "@whiskeysockets/baileys";

const DEFAULT_MAX_MESSAGES_PER_CHAT = 200;

function mergeDeliveryStatus(previous, next) {
  if (next === undefined) return previous;
  if (previous === undefined || next === proto.WebMessageInfo.Status.ERROR) return next;
  if (previous === proto.WebMessageInfo.Status.ERROR && next === proto.WebMessageInfo.Status.PENDING) return previous;
  return Math.max(previous, next);
}

function receiptEvidence(entry) {
  const receipts = (entry.rawMessage?.userReceipt ?? []).filter(receipt => receipt.userJid);
  const count = field => receipts.filter(receipt => normalizeTimestamp(receipt[field]) > 0).length;
  return { delivered: count("receiptTimestamp"), read: count("readTimestamp"), played: count("playedTimestamp") };
}

function withReceiptEvidence(entry) {
  const receipts = receiptEvidence(entry);
  let status = entry.deliveryStatus;
  // Group receipts confirm individual participants, not the whole group.
  if (entry.fromMe && !entry.chatId.endsWith("@g.us")) {
    const receiptStatus = receipts.played ? proto.WebMessageInfo.Status.PLAYED
      : receipts.read ? proto.WebMessageInfo.Status.READ
      : receipts.delivered ? proto.WebMessageInfo.Status.DELIVERY_ACK : undefined;
    status = mergeDeliveryStatus(status, receiptStatus);
  }
  return { ...entry, deliveryStatus: status, receipts };
}

const UNREAD_MODEL_VERSION = 2;
// Status updates are not a conversation; WhatsApp does not badge them as unread chats.
export const STATUS_JID = "status@broadcast";
const UNREAD_REPAIR_WINDOW_SECONDS = 72 * 3600;
const CIPHERTEXT = proto.WebMessageInfo.StubType.CIPHERTEXT;

// What an incoming entry is, for unread counts and display: undecryptable
// messages count (the user has something to read), system stubs do not.
// muteEndTime is a millisecond timestamp; -1 means muted forever.
export function isMuted(chat, now = Date.now()) {
  return chat?.muteEndTime === -1 || (chat?.muteEndTime ?? 0) > now;
}

function isReadableIncoming(entry) {
  return !entry.fromMe && (entry.stubType === CIPHERTEXT || Boolean(entry.text || entry.media || entry.rawMessage));
}

function stubMessageType(stubType) {
  if (stubType === CIPHERTEXT) return "undecryptable";
  return `system_${proto.WebMessageInfo.StubType[stubType] ?? stubType}`.toLowerCase();
}

function emptyStore() {
  return {
    meta: {
      updatedAt: null,
      lastConnection: null,
      jidAliases: {},
      messageLimitByChat: {},
      // Monotonic arrival counter: whatsapp_inbox cursors use it because
      // offline backlog messages carry old timestamps.
      seq: 0,
      unreadModelVersion: UNREAD_MODEL_VERSION
    },
    chats: {},
    contacts: {},
    messages: {}
  };
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object") {
    if (typeof value.low === "number") {
      return value.low;
    }

    if (typeof value.toNumber === "function") {
      return value.toNumber();
    }
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function unwrapMessage(message) {
  if (!message) {
    return null;
  }

  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }

  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }

  return message;
}

export function extractMessageText(message) {
  const payload = unwrapMessage(message);
  if (!payload) {
    return "";
  }

  if (typeof payload.conversation === "string") {
    return payload.conversation;
  }

  if (typeof payload.extendedTextMessage?.text === "string") {
    return payload.extendedTextMessage.text;
  }

  if (typeof payload.imageMessage?.caption === "string") {
    return payload.imageMessage.caption;
  }

  if (typeof payload.videoMessage?.caption === "string") {
    return payload.videoMessage.caption;
  }

  if (typeof payload.documentMessage?.caption === "string") {
    return payload.documentMessage.caption;
  }

  if (payload.contactMessage) {
    return `[contact] ${payload.contactMessage.displayName ?? ""}`.trim();
  }
  if (payload.contactsArrayMessage) {
    return `[contacts] ${(payload.contactsArrayMessage.contacts ?? []).map(c => c.displayName ?? "").filter(Boolean).join(", ")}`;
  }

  if (typeof payload.buttonsResponseMessage?.selectedDisplayText === "string") {
    return payload.buttonsResponseMessage.selectedDisplayText;
  }

  if (typeof payload.listResponseMessage?.title === "string") {
    return payload.listResponseMessage.title;
  }

  if (typeof payload.templateButtonReplyMessage?.selectedDisplayText === "string") {
    return payload.templateButtonReplyMessage.selectedDisplayText;
  }

  if (typeof payload.pollCreationMessage?.name === "string") {
    return payload.pollCreationMessage.name;
  }

  if (payload.pollCreationMessageV2?.name || payload.pollCreationMessageV3?.name) {
    return (payload.pollCreationMessageV2 ?? payload.pollCreationMessageV3).name;
  }

  if (payload.locationMessage) {
    return `[location] ${payload.locationMessage.name ?? ""} ${payload.locationMessage.degreesLatitude ?? ""},${payload.locationMessage.degreesLongitude ?? ""}`.trim();
  }

  const firstKey = contentKey(payload);
  return firstKey ? `[${firstKey}]` : "";
}

export function extractMessageType(message) {
  const payload = unwrapMessage(message);
  if (!payload) {
    return "unknown";
  }

  return contentKey(payload) ?? "unknown";
}

// Group messages carry a senderKeyDistributionMessage next to the real content;
// it is key material, not the message.
const NON_CONTENT_KEYS = new Set(["messageContextInfo", "senderKeyDistributionMessage"]);
function contentKey(payload) {
  return Object.keys(payload).find(key => !NON_CONTENT_KEYS.has(key) && payload[key] != null);
}

export function isViewOnce(message) {
  const inner = message?.ephemeralMessage?.message ?? message;
  return Boolean(inner?.viewOnceMessage || inner?.viewOnceMessageV2 || inner?.viewOnceMessageV2Extension ||
    Object.values(inner ?? {}).some(value => value?.viewOnce === true));
}

function vcardSummary(vcard = "") {
  const name = /^FN[^:]*:(.*)$/m.exec(vcard)?.[1]?.trim() ?? null;
  const phones = [...vcard.matchAll(/^(?:item\d+\.)?TEL[^:]*:(.*)$/gm)].map(match => match[1].trim());
  return { name, phones };
}

export function extractAudioMessage(message) {
  const payload = unwrapMessage(message);
  if (!payload?.audioMessage) {
    return null;
  }

  return payload.audioMessage;
}

// Fold accents and invisible formatting so "jose" finds "José" and pasted
// names with zero-width or non-breaking spaces still match.
function normalizedName(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").normalize("NFKC")
    .replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function matchesTokens(haystack, query) {
  return query.split(" ").every(token => haystack.includes(token));
}

// A query made only of phone punctuation with at least seven digits is a phone
// lookup. Leading trunk zeros are dropped so local formats match by suffix.
export function queryPhoneDigits(value) {
  const text = String(value ?? "").trim();
  if (!/^[+\d\s().-]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 7 ? digits : null;
}

function jidDigits(jid) {
  return /@s\.whatsapp\.net$/.test(jid ?? "") ? jid.split("@")[0].split(":")[0] : null;
}

function preferredChatName(chat, contact) {
  if (chat.id === STATUS_JID) return "Status updates";
  if (!chat.isGroup && !chat.id.endsWith("@g.us")) {
    const names = [contact?.name, chat.name, contact?.notify, contact?.verifiedName, chat.pushName];
    const named = names.find(value => value && value !== chat.id &&
      !/^[+\d\s().:·∙•*‐‑–-]+$/u.test(value));
    if (named) return named;
  }
  return (
    chat.name ||
    chat.subject ||
    chat.pushName ||
    contact?.name ||
    contact?.notify ||
    contact?.verifiedName ||
    chat.id
  );
}

export class WhatsAppStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyStore();
    this.pendingSave = null;
    this.savePromise = Promise.resolve();
    this.pendingMessageStatuses = new Map();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        ...emptyStore(),
        ...parsed,
        meta: {
          ...emptyStore().meta,
          ...(parsed.meta ?? {}),
          messageLimitByChat: parsed.meta?.messageLimitByChat ?? {}
        },
        chats: parsed.chats ?? {},
        contacts: parsed.contacts ?? {},
        messages: parsed.messages ?? {}
      };
      if ((parsed.meta?.unreadModelVersion ?? 0) < UNREAD_MODEL_VERSION) this.#repairUnreadCounts();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Caches written before the current unread model lost counts: chats.update
  // carries per-batch deltas that overwrote the total, and offline ("append")
  // messages were never counted. Best effort: incoming messages since your
  // last reply, within the last 72 hours, never lower than the stored count;
  // zero when your reply is the newest message, and for status updates.
  #repairUnreadCounts() {
    const cutoff = Math.floor(Date.now() / 1000) - UNREAD_REPAIR_WINDOW_SECONDS;
    let changed = false;
    for (const [chatId, chat] of Object.entries(this.data.chats)) {
      const messages = this.data.messages[chatId] ?? [];
      const lastMine = Math.max(0, ...messages.filter(entry => entry.fromMe).map(entry => entry.timestamp ?? 0));
      const since = Math.max(lastMine, cutoff);
      const recent = messages.filter(entry => isReadableIncoming(entry) && (entry.timestamp ?? 0) > since).length;
      const newest = messages.reduce((a, b) => ((b.timestamp ?? 0) >= (a?.timestamp ?? 0) ? b : a), null);
      const repaired = chatId === STATUS_JID || newest?.fromMe ? 0 : Math.max(chat.unreadCount ?? 0, recent);
      if (repaired !== (chat.unreadCount ?? 0)) {
        chat.unreadCount = repaired;
        changed = true;
      }
    }
    this.data.meta.unreadModelVersion = UNREAD_MODEL_VERSION;
    if (changed) this.scheduleSave();
  }

  // A message this relay sent reads its chat, as replying does on the phone.
  // The echo from messages.upsert is then a duplicate and changes nothing.
  ingestSent(message) {
    this.ingestMessage(message, { incrementUnread: false });
    if (message?.key?.remoteJid) this.markChatRead(message.key.remoteJid);
  }

  markChatRead(chatId) {
    const chat = this.data.chats[this.canonicalJid(chatId)];
    if (!chat) return;
    chat.unreadCount = 0;
    chat.markedUnread = false;
    chat.readAt = Math.max(chat.readAt ?? 0, chat.lastMessageTimestamp ?? 0, Math.floor(Date.now() / 1000));
    this.scheduleSave();
  }

  async save() {
    this.data.meta.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.savePromise.catch(() => {}).then(async () => {
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, snapshot, { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
    this.savePromise = write;
    return write;
  }

  async flush() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
      await this.save();
    }
    await this.savePromise.catch(() => {});
  }

  scheduleSave() {
    if (this.pendingSave) {
      clearTimeout(this.pendingSave);
    }

    this.pendingSave = setTimeout(() => {
      this.pendingSave = null;
      this.save().catch((error) => {
        console.error("failed to save WhatsApp store", error);
      });
    }, 300);
  }

  updateMeta(partial) {
    this.data.meta = {
      ...this.data.meta,
      ...partial
    };
    this.scheduleSave();
  }

  canonicalJid(jid) {
    const normalized = jidNormalizedUser(jid ?? "");
    return this.data.meta.jidAliases?.[normalized] ?? normalized;
  }

  recordJidMapping({ lid, pn } = {}) {
    lid = jidNormalizedUser(lid ?? "");
    pn = jidNormalizedUser(pn ?? "");
    if (!lid.endsWith("@lid") || !pn.endsWith("@s.whatsapp.net")) return;
    if (this.data.meta.jidAliases?.[lid] === pn) return;
    if (this.data.meta.jidAliases?.[lid]) {
      this.data.meta.jidMappingConflictCount = (this.data.meta.jidMappingConflictCount ?? 0) + 1;
      this.scheduleSave();
      return;
    }
    this.data.meta.jidAliases = { ...(this.data.meta.jidAliases ?? {}), [lid]: pn };
    const contact = this.data.contacts[lid];
    if (contact) {
      this.data.contacts[pn] = { ...contact, ...this.data.contacts[pn], id: pn, lid, phoneNumber: pn };
      delete this.data.contacts[lid];
    }
    const lidChat = this.data.chats[lid];
    const pnChat = this.data.chats[pn];
    if (lidChat || pnChat) {
      const newest = (lidChat?.lastMessageTimestamp ?? lidChat?.timestamp ?? 0) >
        (pnChat?.lastMessageTimestamp ?? pnChat?.timestamp ?? 0) ? lidChat : pnChat;
      this.data.chats[pn] = {
        ...lidChat, ...pnChat, id: pn,
        name: pnChat?.name ?? lidChat?.name ?? null,
        ...(newest ? { lastMessageText: newest.lastMessageText, lastMessageId: newest.lastMessageId, lastMessageType: newest.lastMessageType,
          lastMessageTimestamp: newest.lastMessageTimestamp, timestamp: newest.timestamp } : {})
      };
      delete this.data.chats[lid];
    }
    const merged = new Map();
    for (const message of [...(this.data.messages[lid] ?? []), ...(this.data.messages[pn] ?? [])]) {
      const previous = merged.get(message.id);
      merged.set(message.id, { ...previous, ...message, chatId: pn,
        rawMessage: message.rawMessage ?? previous?.rawMessage,
        deliveryStatus: mergeDeliveryStatus(previous?.deliveryStatus, message.deliveryStatus) });
    }
    this.ensureMessageCapacity(pn, Math.max(this.getMessageLimit(lid), this.getMessageLimit(pn)));
    this.data.messages[pn] = [...merged.values()].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).slice(-this.getMessageLimit(pn));
    delete this.data.messages[lid];
    this.scheduleSave();
  }

  getMessageLimit(chatId) {
    return this.data.meta.messageLimitByChat?.[chatId] ?? DEFAULT_MAX_MESSAGES_PER_CHAT;
  }

  ensureMessageCapacity(chatId, minimumLimit) {
    if (!chatId) {
      return;
    }

    const nextLimit = Math.max(this.getMessageLimit(chatId), minimumLimit);
    if (nextLimit === this.getMessageLimit(chatId)) {
      return;
    }

    this.data.meta.messageLimitByChat = {
      ...(this.data.meta.messageLimitByChat ?? {}),
      [chatId]: nextLimit
    };
    this.scheduleSave();
  }

  upsertContact(contact) {
    if (!contact?.id) {
      return;
    }

    this.recordJidMapping({ lid: contact.lid ?? contact.id, pn: contact.phoneNumber ?? contact.id });
    const id = this.canonicalJid(contact.id);
    this.data.contacts[id] = {
      ...(this.data.contacts[id] ?? {}),
      id,
      lid: contact.lid ?? (contact.id.endsWith("@lid") ? contact.id : this.data.contacts[id]?.lid),
      phoneNumber: contact.phoneNumber ?? this.data.contacts[id]?.phoneNumber,
      name: contact.name ?? this.data.contacts[id]?.name ?? null,
      notify: contact.notify ?? this.data.contacts[id]?.notify ?? null,
      verifiedName:
        contact.verifiedName ?? this.data.contacts[id]?.verifiedName ?? null,
      updatedAt: new Date().toISOString()
    };

    this.scheduleSave();
  }

  // chats.update carries unreadCount as a per-batch delta (>0), 0 when the
  // chat was read on another device, and -1 when it was marked unread; only
  // history sync carries an absolute count. Deltas are ignored because
  // ingestMessage counts every arriving message itself.
  upsertChat(chat, { absoluteUnread = false } = {}) {
    if (!chat?.id) {
      return;
    }

    chat = { ...chat, id: this.canonicalJid(chat.id) };

    const existing = this.data.chats[chat.id] ?? {};
    const contact = this.data.contacts[chat.id];
    const normalized = {
      ...existing,
      id: chat.id,
      name:
        chat.name ??
        chat.subject ??
        existing.name ??
        contact?.name ??
        contact?.notify ??
        null,
      archived: chat.archived ?? existing.archived ?? false,
      pinned: chat.pinned !== undefined ? normalizeTimestamp(chat.pinned) : existing.pinned ?? null,
      muteEndTime: chat.muteEndTime !== undefined ? normalizeTimestamp(chat.muteEndTime) : existing.muteEndTime ?? null,
      ephemeralExpiration: chat.ephemeralExpiration !== undefined ? (chat.ephemeralExpiration || null) : existing.ephemeralExpiration ?? null,
      unreadCount: existing.unreadCount ?? 0,
      timestamp:
        normalizeTimestamp(
          chat.conversationTimestamp ??
            chat.lastMessageRecvTimestamp ??
            chat.lastMsgTimestamp ??
            chat.timestamp
        ) ?? existing.timestamp ?? null,
      isGroup: chat.id.endsWith("@g.us"),
      updatedAt: new Date().toISOString()
    };

    if (typeof chat.unreadCount === "number") {
      if (chat.unreadCount === 0 || (absoluteUnread && chat.unreadCount > 0)) {
        normalized.unreadCount = Math.max(chat.unreadCount, 0);
        normalized.markedUnread = false;
        if (chat.unreadCount === 0) {
          normalized.readAt = Math.max(existing.readAt ?? 0, existing.lastMessageTimestamp ?? 0, normalized.timestamp ?? 0);
        }
      } else if (chat.unreadCount < 0) {
        normalized.markedUnread = true;
      }
    }

    normalized.displayName = preferredChatName(normalized, contact);
    this.data.chats[chat.id] = normalized;
    this.scheduleSave();
  }

  ingestHistory(history = {}) {
    this.data.meta.lastHistorySyncAt = new Date().toISOString();
    for (const contact of history.contacts ?? []) {
      this.upsertContact(contact);
    }

    for (const chat of history.chats ?? []) {
      this.upsertChat(chat, { absoluteUnread: true });
    }

    for (const message of history.messages ?? []) {
      this.ingestMessage(message, {
        incrementUnread: false
      });
    }
  }

  // incrementUnread marks a live arrival (notify or offline append): it gets an
  // inbox sequence number and can change the unread count. History sync,
  // receipts and updates pass false.
  ingestMessage(message, { incrementUnread = true } = {}) {
    const key = message?.key;
    if (key?.remoteJidAlt) {
      this.recordJidMapping({
        lid: key.remoteJid?.endsWith("@lid") ? key.remoteJid : key.remoteJidAlt,
        pn: key.remoteJid?.endsWith("@s.whatsapp.net") ? key.remoteJid : key.remoteJidAlt
      });
    }
    const remoteJid = this.canonicalJid(key?.remoteJid);
    if (!remoteJid) {
      return;
    }

    const reaction = unwrapMessage(message.message)?.reactionMessage;
    if (reaction) {
      this.applyReaction(remoteJid, reaction, message.key);
      return;
    }

    // Edits and revokes are envelopes about another message, never chat content.
    const protocol = unwrapMessage(message.message)?.protocolMessage;
    if (protocol) {
      const target = { remoteJid: key.remoteJid, id: protocol.key?.id, fromMe: protocol.key?.fromMe };
      if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) {
        this.updateMessage(target, { messageStubType: proto.WebMessageInfo.StubType.REVOKE });
      } else if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocol.editedMessage) {
        this.applyEdit(remoteJid, protocol.key?.id, extractMessageText(protocol.editedMessage));
      }
      return;
    }

    const timestamp = normalizeTimestamp(message.messageTimestamp);
    const messageEntry = {
      id: message.key?.id ?? `${remoteJid}:${timestamp ?? Date.now()}`,
      chatId: remoteJid,
      participant: message.key?.participant ?? null,
      fromMe: Boolean(message.key?.fromMe),
      pushName: message.pushName ?? null,
      timestamp,
      text: extractMessageText(message.message),
      messageType: extractMessageType(message.message)
    };
    if (!message.message && message.messageStubType) {
      messageEntry.stubType = message.messageStubType;
      messageEntry.stubParameters = message.messageStubParameters ?? [];
      messageEntry.messageType = stubMessageType(message.messageStubType);
    }
    if (message.status !== undefined) messageEntry.deliveryStatus = message.status;
    const contextInfo = Object.values(unwrapMessage(message.message) ?? {}).find(value => value?.contextInfo)?.contextInfo;
    if (contextInfo?.stanzaId) {
      messageEntry.replyTo = contextInfo.stanzaId;
      if (contextInfo.participant) messageEntry.quotedParticipant = this.canonicalJid(contextInfo.participant);
      if (contextInfo.quotedMessage) messageEntry.quotedText = extractMessageText(contextInfo.quotedMessage).slice(0, 200);
    }
    if (contextInfo?.mentionedJid?.length) messageEntry.mentions = contextInfo.mentionedJid.map(jid => this.canonicalJid(jid));
    if (isViewOnce(message.message)) messageEntry.viewOnce = true;
    const content = unwrapMessage(message.message);
    const cards = content?.contactMessage ? [content.contactMessage] : content?.contactsArrayMessage?.contacts ?? [];
    if (cards.length) messageEntry.contacts = cards.map(card => {
      const parsed = vcardSummary(card.vcard);
      return { name: card.displayName ?? parsed.name, phones: parsed.phones };
    });
    const poll = content?.pollCreationMessage ?? content?.pollCreationMessageV2 ?? content?.pollCreationMessageV3;
    if (poll) messageEntry.poll = {
      options: (poll.options ?? []).map(option => option.optionName ?? ""),
      selectableCount: poll.selectableOptionsCount ?? 0
    };
    if (message.message) {
      messageEntry.rawMessage = proto.WebMessageInfo.toObject(proto.WebMessageInfo.fromObject(message), {
        bytes: String, longs: String
      });
      const payload = unwrapMessage(message.message);
      const media = payload?.imageMessage ?? payload?.videoMessage ?? payload?.audioMessage ?? payload?.documentMessage ?? payload?.stickerMessage;
      if (media) messageEntry.media = {
        mimetype: media.mimetype ?? null, fileName: media.fileName ?? null,
        fileLength: normalizeTimestamp(media.fileLength), seconds: media.seconds ?? null,
        voiceNote: Boolean(media.ptt)
      };
    }

    const list = this.data.messages[remoteJid] ?? [];
    const existingIndex = list.findIndex((item) => item.id === messageEntry.id);
    const pendingKey = `${remoteJid}|${messageEntry.id}`;
    messageEntry.deliveryStatus = mergeDeliveryStatus(
      mergeDeliveryStatus(mergeDeliveryStatus(list[existingIndex]?.deliveryStatus, this.pendingMessageStatuses.get(pendingKey)),
        messageEntry.fromMe ? this.pendingMessageStatuses.get(`*|${messageEntry.id}`) : undefined),
      messageEntry.deliveryStatus
    );
    this.pendingMessageStatuses.delete(pendingKey);
    if (messageEntry.fromMe) this.pendingMessageStatuses.delete(`*|${messageEntry.id}`);

    if (existingIndex >= 0) {
      if (messageEntry.rawMessage && list[existingIndex].rawMessage?.userReceipt?.length) {
        const receipts = new Map(list[existingIndex].rawMessage.userReceipt.map(receipt => [receipt.userJid, receipt]));
        for (const receipt of messageEntry.rawMessage.userReceipt ?? []) {
          const previous = receipts.get(receipt.userJid) ?? {};
          const merged = { ...previous, ...receipt };
          for (const field of ["receiptTimestamp", "readTimestamp", "playedTimestamp"]) {
            const stamp = Math.max(normalizeTimestamp(previous[field]) ?? 0, normalizeTimestamp(receipt[field]) ?? 0);
            if (stamp > 0) merged[field] = stamp;
          }
          receipts.set(receipt.userJid, merged);
        }
        messageEntry.rawMessage.userReceipt = [...receipts.values()];
      }
      // A blank stub (e.g. undecryptable) must not overwrite real content.
      if (!message.message && list[existingIndex].rawMessage) return;
      list[existingIndex] = {
        ...list[existingIndex],
        ...messageEntry
      };
      if (message.message) {
        delete list[existingIndex].stubType;
        delete list[existingIndex].stubParameters;
        if (!messageEntry.media) delete list[existingIndex].media;
      }
    } else {
      if (incrementUnread) {
        this.data.meta.seq = (this.data.meta.seq ?? 0) + 1;
        messageEntry.seq = this.data.meta.seq;
      }
      list.push(messageEntry);
    }

    list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    this.data.messages[remoteJid] = list.slice(-this.getMessageLimit(remoteJid));

    const currentChat = this.data.chats[remoteJid] ?? {
      id: remoteJid,
      isGroup: remoteJid.endsWith("@g.us")
    };
    const currentLastTimestamp =
      currentChat.lastMessageTimestamp ?? currentChat.timestamp ?? null;
    const shouldUpdateLastMessage =
      currentLastTimestamp === null ||
      (messageEntry.timestamp ?? 0) >= currentLastTimestamp;

    const contact = this.data.contacts[remoteJid];
    this.data.chats[remoteJid] = {
      ...currentChat,
      displayName: preferredChatName(currentChat, contact),
      name:
        currentChat.name ??
        contact?.name ??
        contact?.notify ??
        (!messageEntry.fromMe && !currentChat.isGroup ? message.pushName : null) ??
        null,
      ...(shouldUpdateLastMessage
        ? {
            lastMessageText: messageEntry.text,
            lastMessageId: messageEntry.id,
            lastMessageType: messageEntry.messageType,
            lastMessageTimestamp: messageEntry.timestamp
          }
        : {}),
      unreadCount: currentChat.unreadCount ?? 0,
      updatedAt: new Date().toISOString()
    };
    if (incrementUnread && existingIndex < 0) {
      const chat = this.data.chats[remoteJid];
      if (remoteJid === STATUS_JID) {
        // Status updates still get an inbox sequence number, but no unread badge.
      } else if (isReadableIncoming(messageEntry) && (messageEntry.timestamp ?? 0) > (chat.readAt ?? 0)) {
        chat.unreadCount += 1;
      } else if (messageEntry.fromMe && messageEntry.timestamp >= (chat.readAt ?? 0)) {
        // Replying from any device reads the chat, as it does on the phone.
        chat.unreadCount = 0;
        chat.markedUnread = false;
        chat.readAt = messageEntry.timestamp;
      }
    }

    this.scheduleSave();
  }

  applyEdit(chatId, messageId, text) {
    const target = (this.data.messages[chatId] ?? []).find(entry => entry.id === messageId);
    if (!target) return;
    target.text = text;
    target.editedAt = new Date().toISOString();
    const chat = this.data.chats[chatId];
    if (chat?.lastMessageId === messageId) chat.lastMessageText = text;
    this.scheduleSave();
  }

  // Reactions are state on the target message; an uncached target is ignored.
  applyReaction(chatId, reaction, senderKey = {}) {
    const target = (this.data.messages[chatId] ?? []).find(entry => entry.id === reaction.key?.id);
    if (!target) return;
    const sender = senderKey.fromMe ? "me" : this.canonicalJid(senderKey.participant ?? chatId);
    const reactions = { ...target.reactions };
    if (reaction.text) reactions[sender] = reaction.text; else delete reactions[sender];
    if (Object.keys(reactions).length) target.reactions = reactions; else delete target.reactions;
    this.scheduleSave();
  }

  contactCandidate(id) {
    id = this.canonicalJid(id);
    const contact = this.data.contacts[id];
    if (!contact || !/@(?:s\.whatsapp\.net|lid)$/.test(id)) return null;
    const candidate = { id, isGroup: false, cacheEntryKind: "contact_only", cachedMessageCount: 0 };
    return { ...candidate, displayName: preferredChatName(candidate, contact) };
  }

  // Votes are aggregated by Baileys from the decrypted updates; keep the latest
  // selection per voter, as WhatsApp does when someone changes their vote.
  applyPollUpdates(entry, pollUpdates) {
    const votes = { ...entry.pollVotes };
    for (const update of pollUpdates) {
      const key = update.pollUpdateMessageKey ?? {};
      const voter = key.fromMe ? "me" : this.canonicalJid(key.participant ?? key.remoteJid);
      const hashes = (update.vote?.selectedOptions ?? []).map(option => Buffer.from(option).toString("hex"));
      votes[voter] = entry.poll.options.filter(name =>
        hashes.includes(createHash("sha256").update(name).digest("hex")));
    }
    entry.pollVotes = votes;
    this.scheduleSave();
  }

  pollTally(entry) {
    if (!entry?.poll) return null;
    return entry.poll.options.map(name => ({
      name,
      voters: Object.entries(entry.pollVotes ?? {}).filter(([, picks]) => picks.includes(name)).map(([voter]) => voter)
    }));
  }

  setExtractedText(chatId, messageId, text, kind) {
    const entry = (this.data.messages[this.canonicalJid(chatId)] ?? []).find(message => message.id === messageId);
    if (!entry) return false;
    entry.extractedText = String(text ?? "").slice(0, 20000);
    entry.extractedKind = kind;
    this.scheduleSave();
    return true;
  }

  getMessage(chatId, messageId) {
    const entry = (this.data.messages[this.canonicalJid(chatId)] ?? []).find(message => message.id === messageId);
    return entry ? this.#annotate(entry) : null;
  }

  // My own JIDs (phone and LID) so mentions of me can be recognized.
  myJids() {
    const user = this.data.meta.lastConnection?.user ?? {};
    return new Set([user.id, user.lid].filter(Boolean).flatMap(jid => {
      const bare = jid.replace(/:\d+@/, "@");
      return [bare, this.canonicalJid(bare)];
    }));
  }

  // A reply thread: the root message and every cached message replying to it,
  // directly or through other replies.
  thread(chatId, messageId) {
    const list = this.data.messages[this.canonicalJid(chatId)] ?? [];
    const byId = new Map(list.map(entry => [entry.id, entry]));
    let root = byId.get(messageId);
    while (root?.replyTo && byId.has(root.replyTo)) root = byId.get(root.replyTo);
    const rootId = root?.id ?? messageId;
    const members = new Set([rootId]);
    for (const entry of list) if (entry.replyTo && members.has(entry.replyTo)) members.add(entry.id);
    return list.filter(entry => members.has(entry.id)).map(entry => this.#annotate(entry));
  }

  statusUpdates({ sinceTimestamp } = {}) {
    const since = sinceTimestamp ?? Math.floor(Date.now() / 1000) - 24 * 3600;
    return (this.data.messages[STATUS_JID] ?? []).filter(entry =>
      (entry.timestamp ?? 0) > since && !entry.stubType && entry.messageType !== "protocolMessage")
      .map(entry => this.#annotate(entry));
  }

  // What needs attention since a point in time, grouped by chat: unread count,
  // messages that mention me, and questions nobody (me) has answered yet.
  digest({ sinceTimestamp, limitPerChat = 5 } = {}) {
    const me = this.myJids();
    const chats = [];
    for (const [chatId, list] of Object.entries(this.data.messages)) {
      if (chatId === STATUS_JID) continue;
      const chat = this.data.chats[chatId] ?? {};
      if (chat.archived && !(chat.unreadCount > 0)) continue;
      const recent = list.filter(entry => (entry.timestamp ?? 0) > sinceTimestamp);
      if (!recent.length && !(chat.unreadCount > 0)) continue;
      const myLast = list.findLast(entry => entry.fromMe)?.timestamp ?? 0;
      const myIds = new Set(list.filter(entry => entry.fromMe).map(entry => entry.id));
      const incoming = recent.filter(isReadableIncoming);
      const mentions = incoming.filter(entry => entry.mentions?.some(jid => me.has(jid)) ||
        (entry.replyTo && myIds.has(entry.replyTo)));
      const isGroup = chatId.endsWith("@g.us");
      const questions = incoming.filter(entry => (entry.timestamp ?? 0) > myLast && /\?\s*$|\?\s/.test(entry.text ?? "") &&
        (!isGroup || mentions.includes(entry)));
      const unread = chat.unreadCount ?? 0;
      if (!unread && !mentions.length && !questions.length && !chat.markedUnread) continue;
      chats.push({
        chatId, chatName: this.chatName(chatId), isGroup, unread, markedUnread: Boolean(chat.markedUnread),
        muted: (chat.muteEndTime ?? 0) > Date.now() || chat.muteEndTime === -1,
        lastTimestamp: list.at(-1)?.timestamp ?? 0,
        mentions: mentions.slice(-limitPerChat).map(entry => this.#annotate(entry)),
        questions: questions.slice(-limitPerChat).map(entry => this.#annotate(entry)),
        latest: incoming.slice(-Math.min(unread || 1, limitPerChat)).map(entry => this.#annotate(entry))
      });
    }
    // Direct questions and mentions first, then busiest unread chats.
    return chats.sort((a, b) =>
      (b.mentions.length + b.questions.length > 0) - (a.mentions.length + a.questions.length > 0) ||
      a.muted - b.muted || b.unread - a.unread || b.lastTimestamp - a.lastTimestamp);
  }

  listChats({ limit = 20, query, unreadOnly = false, order = "recent", includeArchived = true, filter } = {}) {
    const normalizedQuery = normalizedName(query);
    const phoneQuery = queryPhoneDigits(query);
    const entries = new Map(Object.values(this.data.chats).map(chat => [chat.id, {
      ...chat, cacheEntryKind: "cached_chat", cachedMessageCount: this.getMessageCount(chat.id)
    }]));
    // A saved contact can be searchable before conversation history arrives.
    // Do not fabricate a cached chat or persist an empty message history.
    if (normalizedQuery) for (const id of Object.keys(this.data.contacts)) {
      const candidate = this.contactCandidate(id);
      if (candidate && !entries.has(candidate.id)) entries.set(candidate.id, candidate);
    }
    const chats = [...entries.values()]
      .map((chat) => ({
        ...chat,
        displayName: preferredChatName(chat, this.data.contacts[chat.id])
      }))
      .filter((chat) => {
        if (unreadOnly && !(chat.unreadCount > 0)) {
          return false;
        }
        if (!includeArchived && chat.archived) return false;
        if (filter === "archived" && !chat.archived) return false;
        if (filter === "pinned" && !chat.pinned) return false;
        if (filter === "muted" && !isMuted(chat)) return false;
        if (filter === "disappearing" && !chat.ephemeralExpiration) return false;

        if (!normalizedQuery) {
          return true;
        }

        if (phoneQuery) {
          const contact = this.data.contacts[chat.id];
          return [chat.id, contact?.phoneNumber, contact?.id].some(jid => jidDigits(jid)?.endsWith(phoneQuery));
        }

        const haystack = [
          chat.id,
          chat.displayName,
          chat.name,
          chat.subject,
          chat.pushName,
          this.data.contacts[chat.id]?.name,
          this.data.contacts[chat.id]?.notify,
          this.data.contacts[chat.id]?.verifiedName
        ]
          .filter(Boolean)
          .map(normalizedName)
          .join(" ");

        return matchesTokens(haystack, normalizedQuery);
      })
      .sort(
        (a, b) =>
          // The phone's order: pinned chats first (most recently pinned on top).
          (order === "phone" ? (b.pinned ?? 0) - (a.pinned ?? 0) : 0) ||
          (b.lastMessageTimestamp ?? b.timestamp ?? 0) -
          (a.lastMessageTimestamp ?? a.timestamp ?? 0)
      );

    return chats.slice(0, limit);
  }

  chatName(chatId) {
    chatId = this.canonicalJid(chatId);
    const chat = this.data.chats[chatId];
    return chat ? preferredChatName(chat, this.data.contacts[chatId]) : this.contactCandidate(chatId)?.displayName ?? chatId;
  }

  senderName(entry) {
    if (entry.fromMe) return "me";
    const jid = entry.participant ?? (entry.chatId?.endsWith("@g.us") ? null : entry.chatId);
    const contact = jid ? this.data.contacts[this.canonicalJid(jid)] : null;
    return contact?.name || entry.pushName || contact?.notify || contact?.verifiedName || jid || "contact";
  }

  #annotate(entry) {
    return { ...withReceiptEvidence(entry), chatName: this.chatName(entry.chatId), senderName: this.senderName(entry) };
  }

  // Cached full-text search. Newest first; it only covers what this device has cached.
  searchMessages({ query, chatId, limit = 20, sinceTimestamp } = {}) {
    const folded = normalizedName(query);
    if (!folded) return [];
    const chatIds = chatId ? [this.canonicalJid(chatId)] : Object.keys(this.data.messages);
    const hits = chatIds.flatMap(id => (this.data.messages[id] ?? []).filter(entry =>
      (!sinceTimestamp || (entry.timestamp ?? 0) > sinceTimestamp) &&
      matchesTokens(normalizedName(entry.extractedText ? `${entry.text} ${entry.extractedText}` : entry.text), folded)));
    return hits.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit).map(entry => this.#annotate(entry));
  }

  // Oldest first so a caller can advance its cursor to the last returned timestamp.
  // Live arrivals after an inbox cursor, in arrival order. Without a cursor:
  // the unread messages of every unread chat, plus the current cursor.
  inbox({ cursor, chatId, includeFromMe = false, limit = 100 } = {}) {
    const chatIds = chatId ? [this.canonicalJid(chatId)] : Object.keys(this.data.messages).filter(id => id !== STATUS_JID);
    let entries;
    if (cursor === undefined) {
      entries = chatIds.flatMap(id => {
        const unread = this.data.chats[id]?.unreadCount ?? 0;
        if (!unread) return [];
        return (this.data.messages[id] ?? []).filter(isReadableIncoming).slice(-unread);
      }).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    } else {
      entries = chatIds.flatMap(id => (this.data.messages[id] ?? []).filter(entry =>
        (entry.seq ?? 0) > cursor && (includeFromMe || !entry.fromMe)))
        .sort((a, b) => a.seq - b.seq);
    }
    const truncated = entries.length > limit;
    // Keep the oldest when paging a cursor, the newest when listing unread.
    entries = cursor === undefined ? entries.slice(-limit) : entries.slice(0, limit);
    const nextCursor = cursor !== undefined && truncated ? entries.at(-1).seq : this.data.meta.seq ?? 0;
    return { messages: entries.map(entry => this.#annotate(entry)), nextCursor, truncated };
  }

  messagesSince({ sinceTimestamp = 0, chatId, includeFromMe = false, limit = 100 } = {}) {
    const chatIds = chatId ? [this.canonicalJid(chatId)] : Object.keys(this.data.messages);
    return chatIds.flatMap(id => (this.data.messages[id] ?? []).filter(entry =>
      (entry.timestamp ?? 0) > sinceTimestamp && (includeFromMe || !entry.fromMe)))
      .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).slice(0, limit).map(entry => this.#annotate(entry));
  }

  getMessages(chatId, limit = 20) {
    chatId = this.canonicalJid(chatId);
    const messages = this.data.messages[chatId] ?? [];
    return messages.slice(-limit).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)).map(withReceiptEvidence);
  }

  getMessageCount(chatId) {
    chatId = this.canonicalJid(chatId);
    return (this.data.messages[chatId] ?? []).length;
  }

  getRawMessage(chatId, messageId) {
    const entry = (this.data.messages[this.canonicalJid(chatId)] ?? []).find(message => message.id === messageId);
    return entry?.rawMessage ? proto.WebMessageInfo.fromObject(entry.rawMessage) : null;
  }

  updateMessage(key, update = {}) {
    // A self-device receipt can omit recipient; server ACKs can use the service
    // JID. Resolve only a unique outgoing ID, never an incoming message ID.
    const unaddressedOwn = key?.fromMe === true && (!key.remoteJid || key.remoteJid === "s.whatsapp.net");
    if (unaddressedOwn) {
      const matches = Object.values(this.data.messages).flatMap(messages => messages.filter(message => message.fromMe && message.id === key.id));
      if (matches.length > 1) return;
      if (matches.length === 1) key = { ...key, remoteJid: matches[0].chatId };
    }
    const list = this.data.messages[this.canonicalJid(key?.remoteJid)] ?? [];
    const entry = list.find(message => message.id === key?.id);
    if (!entry) {
      // A provider acknowledgement can beat sendMessage's asynchronous return.
      if (key?.id && (key.remoteJid || unaddressedOwn) && update.status !== undefined) {
        const pendingKey = `${unaddressedOwn ? "*" : this.canonicalJid(key.remoteJid)}|${key.id}`;
        this.pendingMessageStatuses.set(pendingKey, mergeDeliveryStatus(this.pendingMessageStatuses.get(pendingKey), update.status));
        if (this.pendingMessageStatuses.size > 1000) this.pendingMessageStatuses.delete(this.pendingMessageStatuses.keys().next().value);
      }
      return;
    }
    if (update.message === null || update.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
      entry.text = "[deleted]";
      entry.messageType = "revoked";
      delete entry.rawMessage;
      delete entry.media;
    } else if (update.message) {
      // A placeholder resend can fill in a message that only had a stub.
      const raw = this.getRawMessage(key.remoteJid, key.id) ??
        { key: { remoteJid: key.remoteJid, id: key.id, fromMe: entry.fromMe, participant: entry.participant ?? undefined },
          messageTimestamp: entry.timestamp, pushName: entry.pushName ?? undefined };
      this.ingestMessage({ ...raw, ...update, key: raw.key }, { incrementUnread: false });
    } else if (update.messageStubParameters && entry.stubType) {
      entry.stubParameters = update.messageStubParameters;
    }
    if (update.pollUpdates?.length && entry.poll) this.applyPollUpdates(entry, update.pollUpdates);
    const updated = (this.data.messages[this.canonicalJid(key.remoteJid)] ?? []).find(message => message.id === key.id);
    if (update.status !== undefined) {
      updated.deliveryStatus = mergeDeliveryStatus(updated.deliveryStatus, update.status);
      if (updated.rawMessage) updated.rawMessage.status = updated.deliveryStatus;
    }
    const chat = this.data.chats[this.canonicalJid(key.remoteJid)];
    if (chat && (chat.lastMessageId === key.id ||
        (!chat.lastMessageId && list.at(-1)?.id === key.id && (chat.lastMessageTimestamp ?? 0) <= (updated.timestamp ?? 0)))) {
      chat.lastMessageId = updated.id;
      chat.lastMessageText = updated.text;
      chat.lastMessageType = updated.messageType;
    }
    this.scheduleSave();
  }

  updateReceipt(key, receipt) {
    const raw = this.getRawMessage(key?.remoteJid, key?.id);
    if (!raw || !receipt?.userJid) return;
    const previous = raw.userReceipt ?? [];
    const index = previous.findIndex(item => this.canonicalJid(item.userJid) === this.canonicalJid(receipt.userJid));
    const merged = { ...(previous[index] ?? {}), userJid: receipt.userJid };
    for (const field of ["receiptTimestamp", "readTimestamp", "playedTimestamp"]) {
      const stamp = normalizeTimestamp(receipt[field]);
      if (stamp > 0) merged[field] = Math.max(normalizeTimestamp(merged[field]) ?? 0, stamp);
    }
    if (index < 0) previous.push(merged); else previous[index] = merged;
    raw.userReceipt = previous;
    this.ingestMessage(raw, { incrementUnread: false });
  }

  getOldestMessage(chatId) {
    chatId = this.canonicalJid(chatId);
    const messages = this.data.messages[chatId] ?? [];
    if (!messages.length) {
      return null;
    }

    return messages[0];
  }

  resolveChat({ chatId, chatName }) {
    if (chatId) {
      chatId = this.canonicalJid(chatId);
      const cached = this.data.chats[chatId];
      const exact = cached ? { ...cached,
        displayName: preferredChatName(cached, this.data.contacts[chatId]),
        cacheEntryKind: "cached_chat", cachedMessageCount: this.getMessageCount(chatId)
      } : this.contactCandidate(chatId);
      if (exact) {
        return {
          match: exact,
          candidates: [exact]
        };
      }

      return {
        match: null,
        candidates: []
      };
    }

    const query = normalizedName(chatName);
    if (!query) {
      return {
        match: null,
        candidates: []
      };
    }

    const candidates = this.listChats({ limit: Number.MAX_SAFE_INTEGER, query });
    const exact = candidates.filter((chat) => {
      const names = [
        chat.id,
        chat.displayName,
        chat.name,
        chat.subject,
        chat.pushName,
        this.data.contacts[chat.id]?.name,
        this.data.contacts[chat.id]?.notify,
        this.data.contacts[chat.id]?.verifiedName
      ]
        .filter(Boolean)
        .map(normalizedName);

      return names.includes(query);
    });

    if (exact.length === 1) {
      return {
        match: exact[0],
        candidates
      };
    }

    if (exact.length > 1) return { match: null, candidates: exact };

    return {
      match: candidates.length === 1 ? candidates[0] : null,
      candidates
    };
  }
}
