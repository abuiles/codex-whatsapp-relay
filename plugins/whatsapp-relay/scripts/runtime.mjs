import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  generateMessageIDV2,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import pino from "pino";

import { authDir, credsFile, ensureRuntimeDirs, historyRequestsFile, runtimeFile, storeFile } from "./paths.mjs";
import { WhatsAppStore } from "./store.mjs";
import { HistoryRequests } from "./history-requests.mjs";

const require = createRequire(import.meta.url);
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");

const VERTICAL_BLOCKS = {
  "00": " ",
  "10": "▀",
  "01": "▄",
  "11": "█"
};

function buildQrMatrix(value, quietZone = 2) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(value);
  qr.make();

  const moduleCount = qr.getModuleCount();
  const size = moduleCount + quietZone * 2;
  const evenSize = size % 2 === 0 ? size : size + 1;
  const matrix = [];

  for (let row = 0; row < evenSize; row += 1) {
    const currentRow = [];

    for (let col = 0; col < evenSize; col += 1) {
      const qrRow = row - quietZone;
      const qrCol = col - quietZone;
      const isInBounds =
        qrRow >= 0 &&
        qrRow < moduleCount &&
        qrCol >= 0 &&
        qrCol < moduleCount;

      // QR scanners expect a light quiet zone around the code. Keep the
      // library's dark modules as-is and leave out-of-bounds cells light.
      currentRow.push(isInBounds ? qr.modules[qrRow][qrCol] : false);
    }

    matrix.push(currentRow);
  }

  return matrix;
}

function renderCompactQr(value) {
  const matrix = buildQrMatrix(value);
  const rows = [];

  for (let row = 0; row < matrix.length; row += 2) {
    let line = "";
    const lowerRow = matrix[row + 1] ?? [];

    for (let col = 0; col < matrix[row].length; col += 1) {
      const upperDark = matrix[row][col] ? "1" : "0";
      const lowerDark = lowerRow[col] ? "1" : "0";
      line += VERTICAL_BLOCKS[`${upperDark}${lowerDark}`];
    }

    rows.push(line);
  }

  return rows.join("\n");
}

function createLogger(level = "warn") {
  return pino(
    {
      level
    },
    pino.destination(2)
  );
}

function disconnectCode(error) {
  if (!error) {
    return null;
  }

  if (typeof error?.output?.statusCode === "number") {
    return error.output.statusCode;
  }

  if (typeof error?.data?.statusCode === "number") {
    return error.data.statusCode;
  }

  try {
    return new Boom(error).output.statusCode;
  } catch {
    return null;
  }
}

function disconnectLabel(code) {
  switch (code) {
    case DisconnectReason.loggedOut:
      return "logged_out";
    case DisconnectReason.connectionClosed:
      return "connection_closed";
    case DisconnectReason.connectionLost:
      return "connection_lost";
    case DisconnectReason.connectionReplaced:
      return "connection_replaced";
    case DisconnectReason.restartRequired:
      return "restart_required";
    case DisconnectReason.timedOut:
      return "timed_out";
    default:
      return code === null ? "unknown" : `code_${code}`;
  }
}

const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 60_000;
const REPLACED_WINDOW_MS = 10 * 60_000;
const MAX_REPLACEMENTS = 5;

export class WhatsAppRuntime {
  constructor({ logLevel = "warn", reconnectOnReplaced = false } = {}) {
    this.logger = createLogger(logLevel);
    this.store = new WhatsAppStore(storeFile);
    this.historyRequests = new HistoryRequests(historyRequestsFile);
    this.events = new EventEmitter();
    this.presence = new Map(); // canonical jid -> { lastKnownPresence, lastSeen, at }
    this.socket = null;
    this.startPromise = null;
    this.shouldRenderQr = false;
    this.closing = false;
    // Bumped by every start/stop so a superseded #startInternal never opens a socket.
    this.generation = 0;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnectOnReplaced = reconnectOnReplaced;
    this.replacedAt = [];
    this.state = {
      status: "idle",
      hasCreds: existsSync(credsFile),
      user: null,
      lastQrAt: null,
      currentQrText: null,
      lastDisconnect: null,
      receivedPendingNotifications: false,
      nextReconnectAt: null,
      reconnectHeld: false,
      // Watchdog: when the live socket opened or was lost, and how many
      // automatic reconnects this process has scheduled.
      connectedSince: null,
      disconnectedSince: null,
      reconnectCount: 0,
      authDir,
      runtimeFile
    };
  }

  async initialize() {
    await ensureRuntimeDirs();
    // Never discard this process's own pending writes when reloading from disk.
    await this.store.flush();
    await this.store.load();
    await this.historyRequests.load();
  }

  hasSavedCreds() {
    return existsSync(credsFile);
  }

  summary() {
    return {
      ...this.state,
      hasCreds: this.hasSavedCreds(),
      recentChatCount: Object.keys(this.store.data.chats ?? {}).length
    };
  }

  async start({ printQrToTerminal = false, force = false } = {}) {
    this.shouldRenderQr = printQrToTerminal;

    if (!force) {
      if (this.startPromise) return this.startPromise;
      // A socket that is still connecting has no open ws yet; starting another
      // here would orphan it, and orphans later replace each other (440).
      if (this.socket && ["connecting", "awaiting_qr_scan", "connected"].includes(this.state.status)) {
        return this.socket;
      }
    }

    this.#clearReconnect();
    this.closing = false;
    const generation = ++this.generation;
    const prior = this.startPromise;
    const run = (async () => {
      if (prior) await prior.catch(() => {});
      return this.#startInternal({ printQrToTerminal, generation });
    })();
    const tracked = run.finally(() => {
      if (this.startPromise === tracked) this.startPromise = null;
    });
    this.startPromise = tracked;
    return tracked;
  }

  #clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.state.nextReconnectAt = null;
  }

  reconnectPending() {
    return Boolean(this.reconnectTimer);
  }

  // One pending reconnect at a time, with exponential backoff. A replaced
  // session (440) only means another process used these creds; retry it a few
  // times, then hold so two owners cannot ping-pong forever.
  #scheduleReconnect(code) {
    if (code === DisconnectReason.loggedOut) return;
    if (code === DisconnectReason.connectionReplaced) {
      const now = Date.now();
      this.replacedAt = [...this.replacedAt.filter(at => now - at < REPLACED_WINDOW_MS), now];
      if (!this.reconnectOnReplaced || this.replacedAt.length > MAX_REPLACEMENTS) {
        this.state.reconnectHeld = true;
        return;
      }
    }
    this.#clearReconnect();
    const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.state.reconnectCount += 1;
    this.state.nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.state.nextReconnectAt = null;
      this.start({ printQrToTerminal: false, force: true }).catch((error) => {
        console.error("failed to reconnect WhatsApp runtime", error);
        if (!this.closing && !this.reconnectTimer) this.#scheduleReconnect(DisconnectReason.connectionLost);
      });
    }, delayMs);
  }

  async #startInternal({ printQrToTerminal, generation }) {
    await this.initialize();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    this.store.recordJidMapping({ pn: state.creds.me?.id, lid: state.creds.me?.lid });
    // Recover cached mappings without network lookups or a second WhatsApp socket.
    const phoneJids = Object.keys(this.store.data.chats).filter(id => id.endsWith("@s.whatsapp.net"));
    const mappings = await state.keys.get("lid-mapping", phoneJids.map(id => id.split("@")[0]));
    for (const pn of phoneJids) {
      const lidUser = mappings[pn.split("@")[0]];
      if (typeof lidUser === "string") this.store.recordJidMapping({ pn, lid: `${lidUser}@lid` });
    }
    const { version } = await fetchLatestWaWebVersion();
    if (generation !== this.generation) return this.socket;

    // Never leave the previous socket alive: it would keep reconnecting under
    // the same linked device and replace this one.
    const previous = this.socket;
    this.socket = null;
    try {
      previous?.end?.(undefined);
    } catch {}

    this.state.status = "connecting";
    this.state.currentQrText = null;
    this.state.hasCreds = this.hasSavedCreds();

    const socket = makeWASocket({
      auth: state,
      version,
      browser: Browsers.macOS("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async key => this.store.getRawMessage(key.remoteJid, key.id)?.message,
      logger: this.logger
    });

    this.socket = socket;
    this.events.emit("socket.ready", socket);

    socket.ev.on("creds.update", async () => {
      await saveCreds();
      this.state.hasCreds = this.hasSavedCreds();
      this.events.emit("creds.update", this.summary());
    });

    socket.ev.on("messaging-history.set", (payload) => {
      if (socket !== this.socket) return;
      this.store.ingestHistory(payload);
      this.historyRequests.recordResponse(payload, value => this.store.canonicalJid(value))
        .catch(error => this.logger.error({ err: error }, "Failed to persist history response metadata"));
      this.events.emit("messaging-history.set", payload);
    });

    socket.ev.on("contacts.upsert", (contacts) => {
      if (socket !== this.socket) return;
      for (const contact of contacts) {
        this.store.upsertContact(contact);
      }
      this.events.emit("contacts.upsert", contacts);
    });

    socket.ev.on("contacts.update", (contacts) => {
      if (socket !== this.socket) return;
      for (const contact of contacts) {
        this.store.upsertContact(contact);
      }
      this.events.emit("contacts.update", contacts);
    });

    socket.ev.on("chats.upsert", (chats) => {
      if (socket !== this.socket) return;
      for (const chat of chats) {
        this.store.upsertChat(chat);
      }
      this.events.emit("chats.upsert", chats);
    });

    socket.ev.on("chats.update", (chats) => {
      if (socket !== this.socket) return;
      for (const chat of chats) {
        this.store.upsertChat(chat);
      }
      this.events.emit("chats.update", chats);
    });

    socket.ev.on("presence.update", ({ id, presences }) => {
      if (socket !== this.socket) return;
      for (const [jid, presence] of Object.entries(presences ?? {})) {
        this.presence.set(this.store.canonicalJid(jid), { ...presence, chatId: id, at: Date.now() });
      }
      this.events.emit("presence.update", { id, presences });
    });

    socket.ev.on("lid-mapping.update", mapping => {
      if (socket === this.socket) this.store.recordJidMapping(mapping);
    });

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      if (socket !== this.socket) return;
      this.store.updateMeta({ lastMessageEventAt: new Date().toISOString() });
      for (const message of messages ?? []) {
        // "append" is the offline backlog delivered on reconnect: still new to the user.
        this.store.ingestMessage(message, { incrementUnread: type === "notify" || type === "append" });
      }
    });

    socket.ev.on("messages.update", updates => {
      if (socket !== this.socket) return;
      for (const { key, update } of updates) this.store.updateMessage(key, update);
    });

    socket.ev.on("message-receipt.update", updates => {
      if (socket !== this.socket) return;
      for (const { key, receipt } of updates) this.store.updateReceipt(key, receipt);
    });

    socket.ws.on("CB:ack,class:message", ({ attrs = {} }) => {
      if (socket !== this.socket || !attrs.id) return;
      this.historyRequests.recordAck(attrs.id, attrs.error)
        .catch(error => this.logger.error({ err: error }, "Failed to persist history ACK metadata"));
      if (attrs.error) return;
      this.store.updateMessage({ remoteJid: attrs.from, id: attrs.id, fromMe: true }, { status: proto.WebMessageInfo.Status.SERVER_ACK });
    });

    socket.ev.on("connection.update", (update) => {
      if (socket !== this.socket) return;
      if (typeof update.receivedPendingNotifications === "boolean") this.state.receivedPendingNotifications = update.receivedPendingNotifications;
      if (update.qr) {
        this.state.lastQrAt = new Date().toISOString();
        this.state.status = "awaiting_qr_scan";
        this.state.currentQrText = this.#renderQr(update.qr);
        if (printQrToTerminal) {
          process.stdout.write(
            "\nScan this QR code from WhatsApp on your phone.\n\n"
          );
          process.stdout.write(`${this.state.currentQrText}\n`);
          process.stdout.write(
            "\nWhatsApp -> Settings -> Linked Devices -> Link a Device\n\n"
          );
        }
      }

      if (update.connection === "open") {
        this.state.status = "connected";
        this.state.connectedSince = new Date().toISOString();
        this.state.disconnectedSince = null;
        this.reconnectAttempts = 0;
        this.state.reconnectHeld = false;
        this.state.user = socket.user ?? null;
        this.state.lastDisconnect = null;
        this.state.currentQrText = null;
        this.state.hasCreds = this.hasSavedCreds();
        this.store.updateMeta({
          lastConnection: {
            openedAt: new Date().toISOString(),
            user: socket.user ?? null
          }
        });
      }

      if (update.connection === "close") {
        this.state.receivedPendingNotifications = false;
        this.state.currentQrText = null;
        const code = disconnectCode(update.lastDisconnect?.error);
        const label = disconnectLabel(code);
        this.state.status =
          code === DisconnectReason.loggedOut ? "logged_out" : "disconnected";
        if (code === DisconnectReason.loggedOut) {
          this.state.currentQrText = null;
        }
        this.state.connectedSince = null;
        this.state.disconnectedSince ??= new Date().toISOString();
        this.state.lastDisconnect = {
          code,
          label,
          at: new Date().toISOString()
        };
        this.state.user = code === DisconnectReason.loggedOut ? null : this.state.user;

        if (!this.closing) this.#scheduleReconnect(code);
      }

      this.events.emit("connection.update", update);
    });

    socket.ev.on("messages.upsert", (payload) => {
      this.events.emit("messages.upsert", payload);
    });

    return socket;
  }

  // Release the live WhatsApp socket without logging out, so another owner
  // (the controller bridge or a QR flow) can take over the linked device.
  async stop() {
    this.closing = true;
    this.generation += 1;
    this.#clearReconnect();
    // An explicit stop/reconnect clears the 440 hold and the backoff.
    this.reconnectAttempts = 0;
    this.replacedAt = [];
    this.state.reconnectHeld = false;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.end?.(undefined);
    } catch {}
    this.state.status = "idle";
    this.state.currentQrText = null;
    await this.store.flush();
    this.closing = false;
  }

  on(eventName, listener) {
    this.events.on(eventName, listener);
    return () => {
      this.events.off(eventName, listener);
    };
  }

  async waitForConnection(timeoutMs = 20_000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (this.state.status === "connected" && this.socket) {
        return this.socket;
      }

      if (this.state.status === "logged_out") {
        throw new Error("WhatsApp session was logged out. Re-run the QR auth flow.");
      }

      await delay(250);
    }

    throw new Error(
      `Timed out waiting for WhatsApp to connect. Current status: ${this.state.status}.`
    );
  }

  async ensureConnected(timeoutMs = 20_000) {
    if (this.state.status === "connected" && this.socket) {
      return this.socket;
    }

    if (!this.hasSavedCreds()) {
      throw new Error(
        "WhatsApp is not authenticated yet. Call `whatsapp_start_auth` and scan the QR code first."
      );
    }

    await this.start({ printQrToTerminal: false });
    return this.waitForConnection(timeoutMs);
  }

  async downloadMediaBuffer(message) {
    const socket = await this.ensureConnected();
    return downloadMediaMessage(message, "buffer", {}, {
      logger: this.logger,
      reuploadRequest: socket.updateMediaMessage
    });
  }

  async startAuthFlow(timeoutMs = 20_000) {
    if (this.state.status === "connected" && this.socket) {
      return {
        status: "connected",
        user: this.socket.user ?? this.state.user,
        qrText: null
      };
    }

    if (this.state.status === "awaiting_qr_scan" && this.socket?.ws?.isOpen &&
        this.state.currentQrText) {
      return {
        status: "awaiting_qr_scan",
        user: null,
        qrText: this.state.currentQrText
      };
    }

    await this.start({ printQrToTerminal: false });

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (this.state.status === "connected") {
        return {
          status: "connected",
          user: this.socket?.user ?? this.state.user,
          qrText: null
        };
      }

      if (this.state.currentQrText) {
        return {
          status: "awaiting_qr_scan",
          user: null,
          qrText: this.state.currentQrText
        };
      }

      await delay(250);
    }

    throw new Error(
      `Timed out waiting for WhatsApp auth to start. Current status: ${this.state.status}.`
    );
  }

  async syncChatHistory({ chatId, count = 50, timeoutMs = 20_000, beforeMessageId }) {
    await this.historyRequests.load();
    chatId = this.store.canonicalJid?.(chatId) ?? chatId;
    const cacheOldestBefore = this.store.getOldestMessage(chatId);
    const anchor = beforeMessageId
      ? this.store.getMessages(chatId, this.store.getMessageLimit(chatId)).find(message => message.id === beforeMessageId)
      : cacheOldestBefore;
    if (beforeMessageId && !anchor) throw new Error("History anchor message ID was not found in this chat's cache.");
    if (!anchor?.timestamp) throw new Error("History sync requires a cached anchor message with a timestamp.");

    const unresolved = this.historyRequests.findUnresolved(chatId, anchor.id);
    if (unresolved) return { ...unresolved, reused: true, sessionId: unresolved.sessionId, timedOut: true };

    const socket = await this.ensureConnected();
    // Another concurrent caller may have prepared the same anchor while this
    // call was waiting for the connection.
    const pending = this.historyRequests.findUnresolved(chatId, anchor.id);
    if (pending) return { ...pending, reused: true, sessionId: pending.sessionId, timedOut: true };
    const beforeCount = this.store.getMessageCount(chatId);
    this.store.ensureMessageCapacity(chatId, beforeCount + count + 25);
    const sessionId = generateMessageIDV2(socket.user?.id);
    const record = {
      sessionId, chatId, count, state: "prepared", createdAt: new Date().toISOString(),
      anchorMessageId: anchor.id, anchorTimestamp: anchor.timestamp,
      beforeCount, oldestTimestampBefore: cacheOldestBefore?.timestamp ?? null,
      events: 0, receivedMessageIds: [], sessionMatched: false
    };
    // Persist the exact stanza ID before dispatch. The SDK's convenience method
    // generates its ID internally, which loses it if dispatch or the wait fails.
    await this.historyRequests.update(sessionId, record);
    const abort = new AbortController();
    const waiting = this.#waitForHistorySync({ chatId, sessionId, timeoutMs, signal: abort.signal });
    try {
      await socket.relayMessage(jidNormalizedUser(socket.user.id), {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE,
          peerDataOperationRequestMessage: {
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
            historySyncOnDemandRequest: {
              chatJid: anchor.chatId, oldestMsgFromMe: anchor.fromMe, oldestMsgId: anchor.id,
              oldestMsgTimestampMs: anchor.timestamp * 1000, onDemandMsgCount: count
            }
          }
        }
      }, {
        messageId: sessionId,
        additionalAttributes: { category: "peer", push_priority: "high_force" },
        additionalNodes: [{ tag: "meta", attrs: { appdata: "default" } }]
      });
    } catch (error) {
      abort.abort();
      await waiting;
      const failed = await this.historyRequests.update(sessionId, previous => ({
        state: previous.state === "response_received" ? previous.state : "dispatch_unknown",
        error: error.message
      }));
      return { ...failed, sessionId, timedOut: true };
    }
    const result = await waiting;
    const completed = await this.historyRequests.update(sessionId, previous => ({
      ...result,
      state: previous.state === "provider_rejected" ? previous.state
        : previous.state === "response_received" || result.sessionMatched ? "response_received" : "timed_out_waiting_response",
      afterCount: this.store.getMessageCount(chatId),
      oldestTimestampAfter: this.store.getOldestMessage(chatId)?.timestamp ?? anchor.timestamp,
      retentionLimit: this.store.getMessageLimit(chatId)
    }));
    return { ...completed, sessionId };
  }

  #waitForHistorySync({ chatId, sessionId, timeoutMs, signal }) {
    return new Promise(resolve => {
      let done = false;
      let idleTimer;
      const summary = { events: 0, chats: 0, contacts: 0, messages: 0,
        lastProgress: null, isLatest: false, timedOut: false, sessionMatched: false, receivedMessageIds: [] };
      const finish = extra => {
        if (done) return;
        done = true;
        clearTimeout(idleTimer);
        clearTimeout(timeoutTimer);
        this.events.off("messaging-history.set", onHistory);
        signal.removeEventListener("abort", onAbort);
        resolve({ ...summary, ...extra });
      };
      const onAbort = () => finish({ aborted: true });
      const onHistory = payload => {
        // A chat-only event may belong to initial sync or a different request.
        if (payload.peerDataRequestSessionId !== sessionId) return;
        const canonical = value => this.store.canonicalJid?.(value) ?? value;
        const matching = (payload.messages ?? []).filter(message => canonical(message.key?.remoteJid) === canonical(chatId));
        summary.sessionMatched = true;
        summary.events++;
        summary.chats += (payload.chats ?? []).filter(chat => canonical(chat.id) === canonical(chatId)).length;
        summary.contacts += (payload.contacts ?? []).length;
        summary.messages += matching.length;
        summary.receivedMessageIds = [...new Set([...summary.receivedMessageIds, ...matching.map(message => message.key.id).filter(Boolean)])].slice(0, 100);
        summary.lastProgress = payload.progress ?? summary.lastProgress;
        summary.isLatest ||= payload.isLatest === true;
        if (summary.isLatest) return finish();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => finish(), 750);
      };
      const timeoutTimer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.events.on("messaging-history.set", onHistory);
    });
  }

  #renderQr(value) {
    return renderCompactQr(value);
  }
}
