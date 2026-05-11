import fs from "node:fs/promises";

const DEFAULT_MAX_MESSAGES_PER_CHAT = 200;

function emptyStore() {
  return {
    meta: {
      updatedAt: null,
      lastConnection: null,
      messageLimitByChat: {}
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

  const firstKey = Object.keys(payload)[0];
  return firstKey ? `[${firstKey}]` : "";
}

export function extractMessageType(message) {
  const payload = unwrapMessage(message);
  if (!payload) {
    return "unknown";
  }

  return Object.keys(payload)[0] ?? "unknown";
}

export function extractAudioMessage(message) {
  const payload = unwrapMessage(message);
  if (!payload?.audioMessage) {
    return null;
  }

  return payload.audioMessage;
}

export function extractImageMessage(message) {
  const payload = unwrapMessage(message);
  if (!payload?.imageMessage) {
    return null;
  }

  return payload.imageMessage;
}

export function extractAlbumMessage(message) {
  const payload = unwrapMessage(message);
  if (!payload?.albumMessage) {
    return null;
  }

  return payload.albumMessage;
}

function preferredChatName(chat, contact) {
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
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  async save() {
    this.data.meta.updatedAt = new Date().toISOString();
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2));
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

    this.data.contacts[contact.id] = {
      ...(this.data.contacts[contact.id] ?? {}),
      id: contact.id,
      name: contact.name ?? this.data.contacts[contact.id]?.name ?? null,
      notify: contact.notify ?? this.data.contacts[contact.id]?.notify ?? null,
      verifiedName:
        contact.verifiedName ?? this.data.contacts[contact.id]?.verifiedName ?? null,
      updatedAt: new Date().toISOString()
    };

    this.scheduleSave();
  }

  upsertChat(chat) {
    if (!chat?.id) {
      return;
    }

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
      unreadCount: chat.unreadCount ?? existing.unreadCount ?? 0,
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

    normalized.displayName = preferredChatName(normalized, contact);
    this.data.chats[chat.id] = normalized;
    this.scheduleSave();
  }

  ingestHistory(history = {}) {
    for (const contact of history.contacts ?? []) {
      this.upsertContact(contact);
    }

    for (const chat of history.chats ?? []) {
      this.upsertChat(chat);
    }

    for (const message of history.messages ?? []) {
      this.ingestMessage(message, {
        incrementUnread: false
      });
    }
  }

  ingestMessage(message, { incrementUnread = true } = {}) {
    const remoteJid = message?.key?.remoteJid;
    if (!remoteJid) {
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

    const list = this.data.messages[remoteJid] ?? [];
    const existingIndex = list.findIndex((item) => item.id === messageEntry.id);

    if (existingIndex >= 0) {
      list[existingIndex] = {
        ...list[existingIndex],
        ...messageEntry
      };
    } else {
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
        message.pushName ??
        contact?.name ??
        contact?.notify ??
        null,
      ...(shouldUpdateLastMessage
        ? {
            lastMessageText: messageEntry.text,
            lastMessageType: messageEntry.messageType,
            lastMessageTimestamp: messageEntry.timestamp
          }
        : {}),
      unreadCount:
        incrementUnread && !messageEntry.fromMe
          ? (currentChat.unreadCount ?? 0) + 1
          : currentChat.unreadCount ?? 0,
      updatedAt: new Date().toISOString()
    };

    this.scheduleSave();
  }

  listChats({ limit = 20, query, unreadOnly = false } = {}) {
    const normalizedQuery = query?.trim().toLowerCase();
    const chats = Object.values(this.data.chats)
      .map((chat) => ({
        ...chat,
        displayName: preferredChatName(chat, this.data.contacts[chat.id])
      }))
      .filter((chat) => {
        if (unreadOnly && !(chat.unreadCount > 0)) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        const haystack = [
          chat.id,
          chat.displayName,
          chat.name,
          this.data.contacts[chat.id]?.name,
          this.data.contacts[chat.id]?.notify
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedQuery);
      })
      .sort(
        (a, b) =>
          (b.lastMessageTimestamp ?? b.timestamp ?? 0) -
          (a.lastMessageTimestamp ?? a.timestamp ?? 0)
      );

    return chats.slice(0, limit);
  }

  getMessages(chatId, limit = 20) {
    const messages = this.data.messages[chatId] ?? [];
    return messages.slice(-limit).sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  getMessageCount(chatId) {
    return (this.data.messages[chatId] ?? []).length;
  }

  getOldestMessage(chatId) {
    const messages = this.data.messages[chatId] ?? [];
    if (!messages.length) {
      return null;
    }

    return messages[0];
  }

  resolveChat({ chatId, chatName }) {
    if (chatId) {
      const exact = this.data.chats[chatId];
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

    const query = chatName?.trim().toLowerCase();
    if (!query) {
      return {
        match: null,
        candidates: []
      };
    }

    const candidates = this.listChats({ limit: 50, query });
    const exact = candidates.find((chat) => {
      const names = [
        chat.id,
        chat.displayName,
        chat.name,
        this.data.contacts[chat.id]?.name,
        this.data.contacts[chat.id]?.notify
      ]
        .filter(Boolean)
        .map((value) => value.toLowerCase());

      return names.includes(query);
    });

    if (exact) {
      return {
        match: exact,
        candidates
      };
    }

    return {
      match: candidates.length === 1 ? candidates[0] : null,
      candidates
    };
  }
}
