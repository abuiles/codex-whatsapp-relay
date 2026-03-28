import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { listCodexThreads, startCodexTurn } from "./codex-runner.mjs";
import {
  ControllerConfigStore,
  resolvePhoneKeyFromJid
} from "./controller-config.mjs";
import {
  defaultPermissionLevel,
  normalizePermissionLevel,
  permissionLevelConfig,
  permissionLevelHelpList,
  resolvePermissionLevel
} from "./controller-permissions.mjs";
import { drainControllerCommands } from "./controller-outbox.mjs";
import { ControllerStateStore } from "./controller-state.mjs";
import { extractMessageText } from "./store.mjs";

const MAX_WHATSAPP_MESSAGE = 3500;
const HEARTBEAT_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 500;
const OUTBOX_POLL_MS = 1_000;
const SESSION_LIST_LIMIT = 12;
const SESSION_CONNECT_SEARCH_LIMIT = 50;
const DANGER_CONFIRMATION_WINDOW_MS = 60_000;

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

function splitMessage(text, limit = MAX_WHATSAPP_MESSAGE) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.length <= limit) {
    return [trimmed];
  }

  const parts = [];
  let remaining = trimmed;

  while (remaining.length > limit) {
    let index = remaining.lastIndexOf("\n", limit);
    if (index < limit / 2) {
      index = remaining.lastIndexOf(" ", limit);
    }
    if (index < limit / 2) {
      index = limit;
    }

    parts.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function shortThreadId(threadId) {
  return threadId ? threadId.slice(0, 8) : "none";
}

function buildThreadName({ label, phoneKey }) {
  const base = String(label ?? "").trim() || phoneKey;
  const normalized = base.replace(/\s+/g, " ").trim();
  return `WhatsApp: ${normalized}`.slice(0, 120);
}

function formatThreadTimestamp(value) {
  if (!value) {
    return null;
  }

  const timestamp = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(timestamp).toISOString();
}

function sanitizeThreadPreview(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function helpText() {
  return [
    "WhatsApp Codex bridge commands:",
    "/status -> show the current Codex session",
    "/new [prompt] -> start a fresh session, optionally with a first prompt",
    "/sessions -> list recent Codex threads you can connect to",
    "/connect <thread-id-prefix> -> switch this chat to another Codex thread",
    "/permissions [level] -> inspect or change read-only, workspace-write, or danger-full-access",
    "/approve [session] -> approve the pending action once or for this session",
    "/deny -> decline the pending action",
    "/cancel -> cancel the pending action",
    "/stop -> stop the in-flight Codex run for this chat",
    "/help -> show this help",
    "",
    "Any other text in this direct chat continues your current Codex session."
  ].join("\n");
}

function parseIncomingCommand(text, captureAllDirectMessages) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { type: "empty" };
  }

  const commandMatch = trimmed.match(/^\/([a-z-]+)(?:\s+([\s\S]+))?$/i);
  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const payload = commandMatch[2]?.trim() ?? "";

    switch (command) {
      case "help":
        return { type: "help" };
      case "status":
        return { type: "status" };
      case "new":
      case "reset":
        return { type: "new", prompt: payload };
      case "stop":
        return { type: "stop" };
      case "codex":
      case "ask":
        return payload ? { type: "prompt", prompt: payload } : { type: "help" };
      case "approve":
        return {
          type: "approvalDecision",
          decision: payload.toLowerCase() === "session" ? "acceptForSession" : "accept"
        };
      case "deny":
      case "decline":
        return { type: "approvalDecision", decision: "decline" };
      case "cancel":
        return { type: "approvalDecision", decision: "cancel" };
      case "permissions":
      case "permission":
        return { type: "permissions", payload };
      case "sessions":
      case "threads":
        return { type: "sessions" };
      case "connect":
      case "resume":
        return { type: "connect", payload };
      default:
        return { type: "unknown" };
    }
  }

  if (captureAllDirectMessages) {
    return { type: "prompt", prompt: trimmed };
  }

  return { type: "ignored" };
}

function resolveSessionPermissionLevel(config, session = {}) {
  return resolvePermissionLevel(
    session.permissionLevel ?? config.permissionLevel ?? defaultPermissionLevel()
  );
}

function formatPermissionSummary(level) {
  const config = permissionLevelConfig(level);
  return `${config.helpName}: ${config.description}`;
}

function isConfirmationFresh(session = {}) {
  const pending = session.pendingPermissionConfirmation;
  if (!pending?.expiresAt) {
    return false;
  }

  return Date.parse(pending.expiresAt) > Date.now();
}

function formatApprovalDetails(approval) {
  const lines = [
    `approval_type: ${approval.kind}`,
    `request_id: ${approval.requestId}`
  ];

  if (approval.networkApprovalContext) {
    lines.push("network_access: requested");
    lines.push(`host: ${approval.networkApprovalContext.host}`);
    if (approval.networkApprovalContext.protocol) {
      lines.push(`protocol: ${approval.networkApprovalContext.protocol}`);
    }
    if (approval.networkApprovalContext.port) {
      lines.push(`port: ${approval.networkApprovalContext.port}`);
    }
  } else if (approval.command) {
    const command = Array.isArray(approval.command)
      ? approval.command.join(" ")
      : String(approval.command);
    lines.push(`command: ${command}`);
  }

  if (approval.cwd) {
    lines.push(`cwd: ${approval.cwd}`);
  }

  if (approval.reason) {
    lines.push(`reason: ${approval.reason}`);
  }

  if (approval.grantRoot) {
    lines.push(`grant_root: ${approval.grantRoot}`);
  }

  if (approval.permissions) {
    const networkEnabled = approval.permissions.network?.enabled;
    if (networkEnabled !== null && networkEnabled !== undefined) {
      lines.push(`network_enabled: ${networkEnabled ? "yes" : "no"}`);
    }

    const readRoots = approval.permissions.fileSystem?.read ?? [];
    const writeRoots = approval.permissions.fileSystem?.write ?? [];
    if (readRoots.length) {
      lines.push(`read_roots: ${readRoots.join(", ")}`);
    }
    if (writeRoots.length) {
      lines.push(`write_roots: ${writeRoots.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Reply with /approve, /approve session, /deny, or /cancel.");

  return lines.join("\n");
}

function summarizeThread(thread, currentThreadId) {
  const preview = sanitizeThreadPreview(thread.preview);
  return [
    `- ${shortThreadId(thread.id)}${thread.id === currentThreadId ? " (current)" : ""}`,
    thread.name ? `  name=${thread.name}` : null,
    preview ? `  preview=${preview}` : null,
    thread.updatedAt ? `  updated_at=${formatThreadTimestamp(thread.updatedAt)}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveThreadSelection(threads, token) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    return {
      match: null,
      candidates: []
    };
  }

  const exact = threads.find((thread) => thread.id === normalized);
  if (exact) {
    return {
      match: exact,
      candidates: [exact]
    };
  }

  const prefixCandidates = threads.filter((thread) => thread.id.startsWith(normalized));
  if (prefixCandidates.length) {
    return {
      match: prefixCandidates.length === 1 ? prefixCandidates[0] : null,
      candidates: prefixCandidates
    };
  }

  const nameCandidates = threads.filter((thread) =>
    thread.name?.toLowerCase().includes(normalized.toLowerCase())
  );

  return {
    match: nameCandidates.length === 1 ? nameCandidates[0] : null,
    candidates: nameCandidates
  };
}

export class WhatsAppControllerBridge {
  constructor({
    runtime,
    configStore = new ControllerConfigStore(),
    stateStore = new ControllerStateStore()
  }) {
    this.runtime = runtime;
    this.configStore = configStore;
    this.stateStore = stateStore;
    this.started = false;
    this.startedAtMs = null;
    this.heartbeat = null;
    this.outboxPoller = null;
    this.processingOutbox = false;
    this.activeRuns = new Map();
    this.recentMessageIds = [];
    this.recentMessageSet = new Set();
    this.recentOutgoingIds = [];
    this.recentOutgoingSet = new Set();
    this.unsubscribers = [];
  }

  async initialize() {
    await this.configStore.load();
    await this.stateStore.load();
  }

  async start() {
    await this.initialize();
    const config = this.configStore.data;

    if (!config.enabled) {
      throw new Error("Controller bridge is disabled. Enable it before starting.");
    }

    if (!config.allowedControllers.length) {
      throw new Error("No allowed controller numbers are configured yet.");
    }

    if (!this.runtime.hasSavedCreds()) {
      throw new Error("WhatsApp is not authenticated yet. Run `whatsapp_start_auth` first.");
    }

    if (this.started) {
      return this.summary();
    }

    this.started = true;
    this.startedAtMs = Date.now();

    this.unsubscribers.push(
      this.runtime.on("messages.upsert", (payload) => {
        this.handleMessagesUpsert(payload).catch((error) => {
          console.error("failed to handle WhatsApp controller message", error);
        });
      })
    );

    this.unsubscribers.push(
      this.runtime.on("connection.update", () => {
        this.touchHeartbeat().catch((error) => {
          console.error("failed to update WhatsApp controller heartbeat", error);
        });
      })
    );

    await this.runtime.start({ printQrToTerminal: false });
    await this.stateStore.setProcess({
      pid: process.pid,
      status: "running",
      startedAt: new Date(this.startedAtMs).toISOString(),
      heartbeatAt: new Date().toISOString()
    });

    this.heartbeat = setInterval(() => {
      this.touchHeartbeat().catch((error) => {
        console.error("failed to write WhatsApp controller heartbeat", error);
      });
    }, HEARTBEAT_MS);

    await this.processOutbox();
    this.outboxPoller = setInterval(() => {
      this.processOutbox().catch((error) => {
        console.error("failed to process WhatsApp controller outbox", error);
      });
    }, OUTBOX_POLL_MS);

    return this.summary();
  }

  async stop({ clearProcess = true } = {}) {
    this.started = false;

    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }

    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }

    if (this.outboxPoller) {
      clearInterval(this.outboxPoller);
      this.outboxPoller = null;
    }

    for (const [phoneKey, run] of this.activeRuns.entries()) {
      await run.interrupt().catch(() => {
        if (!run.child.killed) {
          run.child.kill("SIGTERM");
        }
      });
      this.activeRuns.delete(phoneKey);
    }

    if (clearProcess) {
      await this.stateStore.clearProcess();
    }
  }

  async touchHeartbeat() {
    await this.stateStore.setProcess({
      pid: process.pid,
      status: "running",
      heartbeatAt: new Date().toISOString(),
      whatsappStatus: this.runtime.summary().status,
      whatsappUserId: this.runtime.summary().user?.id ?? null,
      whatsappLastDisconnect: this.runtime.summary().lastDisconnect ?? null
    });
  }

  summary() {
    const sessions = this.stateStore.listSessions().map((session) => ({
      phoneKey: session.phoneKey,
      label: session.label ?? null,
      threadId: session.threadId ?? null,
      busy: this.activeRuns.has(session.phoneKey),
      permissionLevel: resolveSessionPermissionLevel(this.configStore.data, session),
      lastPromptAt: session.lastPromptAt ?? null,
      lastReplyAt: session.lastReplyAt ?? null
    }));

    return {
      started: this.started,
      process: this.stateStore.data.process,
      config: this.configStore.data,
      sessions
    };
  }

  async processOutbox() {
    if (this.processingOutbox) {
      return;
    }

    this.processingOutbox = true;
    try {
      await drainControllerCommands(async (command) => {
        await this.handleOutboxCommand(command);
      });
    } finally {
      this.processingOutbox = false;
    }
  }

  async handleOutboxCommand(command = {}) {
    switch (command.type) {
      case "send_message":
        await this.sendTextMessage(command.payload.chatId, command.payload.text);
        return;
      default:
        throw new Error(`Unknown controller command type: ${command.type}`);
    }
  }

  rememberMessage(messageId) {
    if (!messageId || this.recentMessageSet.has(messageId)) {
      return false;
    }

    this.recentMessageSet.add(messageId);
    this.recentMessageIds.push(messageId);

    if (this.recentMessageIds.length > RECENT_MESSAGE_LIMIT) {
      const stale = this.recentMessageIds.shift();
      this.recentMessageSet.delete(stale);
    }

    return true;
  }

  rememberOutgoingMessage(messageId) {
    if (!messageId || this.recentOutgoingSet.has(messageId)) {
      return;
    }

    this.recentOutgoingSet.add(messageId);
    this.recentOutgoingIds.push(messageId);

    if (this.recentOutgoingIds.length > RECENT_MESSAGE_LIMIT) {
      const stale = this.recentOutgoingIds.shift();
      this.recentOutgoingSet.delete(stale);
    }
  }

  async handleMessagesUpsert(payload = {}) {
    if (payload.type && !["notify", "append"].includes(payload.type)) {
      return;
    }

    for (const message of payload.messages ?? []) {
      await this.handleIncomingMessage(message);
    }
  }

  async handleIncomingMessage(message) {
    const remoteJid = message?.key?.remoteJid;
    const messageId = message?.key?.id ?? null;
    const fromMe = Boolean(message?.key?.fromMe);

    if (!remoteJid || remoteJid.endsWith("@g.us")) {
      return;
    }

    if (fromMe && this.recentOutgoingSet.has(messageId)) {
      return;
    }

    if (!this.rememberMessage(messageId)) {
      return;
    }

    const timestamp = normalizeTimestamp(message.messageTimestamp);
    if (
      timestamp &&
      this.startedAtMs &&
      timestamp * 1000 < this.startedAtMs - 10_000
    ) {
      return;
    }

    const config = await this.configStore.load();
    const [controller, phoneKey] = await Promise.all([
      this.configStore.findControllerByJid(remoteJid),
      resolvePhoneKeyFromJid(remoteJid)
    ]);
    if (!config.enabled || !controller) {
      return;
    }

    if (!phoneKey) {
      return;
    }

    if (fromMe && phoneKey !== controller.phoneKey) {
      return;
    }

    const text = extractMessageText(message.message).trim();
    const session = this.stateStore.data.sessions[phoneKey] ?? {};

    await this.stateStore.upsertSession(phoneKey, {
      phoneKey,
      remoteJid,
      label: controller.label ?? message.pushName ?? null,
      permissionLevel: resolveSessionPermissionLevel(config, session),
      lastInboundAt: new Date().toISOString(),
      lastInboundText: text || `[${message.key?.id ?? "message"}]`
    });

    if (!text) {
      await this.sendReply(
        remoteJid,
        "Only text messages are supported for Codex control right now."
      );
      return;
    }

    const command = parseIncomingCommand(text, config.captureAllDirectMessages);
    const currentSession = this.stateStore.data.sessions[phoneKey] ?? session;
    const active = this.activeRuns.get(phoneKey);

    if (
      active?.pendingApproval &&
      !["approvalDecision", "status", "help", "stop"].includes(command.type)
    ) {
      await this.sendReply(
        remoteJid,
        [
          `Approval is pending for session ${shortThreadId(currentSession.threadId ?? null)}.`,
          "",
          formatApprovalDetails(active.pendingApproval)
        ].join("\n")
      );
      return;
    }

    switch (command.type) {
      case "empty":
      case "ignored":
        return;
      case "help":
        await this.sendReply(remoteJid, helpText());
        return;
      case "unknown":
        await this.sendReply(
          remoteJid,
          `Unknown command.\n\n${helpText()}`
        );
        return;
      case "status":
        await this.sendReply(remoteJid, this.renderSessionStatus(phoneKey));
        return;
      case "stop":
        await this.stopActiveRun(phoneKey, remoteJid);
        return;
      case "new":
        await this.stateStore.removeSession(phoneKey);
        if (command.prompt) {
          await this.runPrompt({
            phoneKey,
            remoteJid,
            prompt: command.prompt,
            forceNewThread: true,
            label: controller.label ?? message.pushName ?? null
          });
        } else {
          await this.sendReply(
            remoteJid,
            "Started a fresh Codex session for this chat. Send the next message when you want me to do something."
          );
        }
        return;
      case "sessions":
        await this.sendThreadList(phoneKey, remoteJid);
        return;
      case "connect":
        await this.connectToThread({
          phoneKey,
          remoteJid,
          payload: command.payload,
          label: controller.label ?? message.pushName ?? null
        });
        return;
      case "permissions":
        await this.handlePermissionsCommand({
          phoneKey,
          remoteJid,
          payload: command.payload,
          label: controller.label ?? message.pushName ?? null
        });
        return;
      case "approvalDecision":
        await this.handleApprovalDecision(phoneKey, remoteJid, command.decision);
        return;
      case "prompt":
        await this.runPrompt({
          phoneKey,
          remoteJid,
          prompt: command.prompt,
          forceNewThread: false,
          label: controller.label ?? message.pushName ?? null
        });
        return;
      default:
        return;
    }
  }

  renderSessionStatus(phoneKey) {
    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const active = this.activeRuns.get(phoneKey);
    const permissionLevel = resolveSessionPermissionLevel(this.configStore.data, session);
    const pendingConfirmation =
      isConfirmationFresh(session) && session.pendingPermissionConfirmation
        ? session.pendingPermissionConfirmation
        : null;

    return [
      "WhatsApp Codex bridge",
      `session: ${shortThreadId(session.threadId ?? null)}`,
      `busy: ${active ? "yes" : "no"}`,
      `workspace: ${this.configStore.data.workspace}`,
      `permissions: ${permissionLevel}`,
      active?.pendingApproval ? `approval_pending: yes (${active.pendingApproval.kind})` : null,
      pendingConfirmation
        ? `danger_full_access_confirmation: pending until ${pendingConfirmation.expiresAt}`
        : null,
      session.lastPromptAt ? `last_prompt_at: ${session.lastPromptAt}` : null,
      session.lastReplyAt ? `last_reply_at: ${session.lastReplyAt}` : null,
      "",
      "Commands: /new, /sessions, /connect, /permissions, /stop, /help"
    ]
      .filter(Boolean)
      .join("\n");
  }

  async sendThreadList(phoneKey, remoteJid) {
    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const config = this.configStore.data;
    const threads = await listCodexThreads({
      codexBin: config.codexBin,
      workspace: config.workspace,
      model: config.model,
      profile: config.profile,
      search: config.search,
      limit: SESSION_LIST_LIMIT
    });

    if (!threads.length) {
      await this.sendReply(remoteJid, "No Codex threads were found.");
      return;
    }

    const lines = [
      "Recent Codex sessions:",
      "",
      ...threads.map((thread) => summarizeThread(thread, session.threadId ?? null)),
      "",
      "Use /connect <thread-id-prefix> to switch this chat to one of these sessions."
    ];
    await this.sendReply(remoteJid, lines.join("\n"));
  }

  async connectToThread({ phoneKey, remoteJid, payload, label }) {
    const active = this.activeRuns.get(phoneKey);
    if (active) {
      await this.sendReply(
        remoteJid,
        "Wait for the active Codex run to finish or send /stop before switching sessions."
      );
      return;
    }

    const token = String(payload ?? "").trim();
    if (!token) {
      await this.sendReply(
        remoteJid,
        "Usage: /connect <thread-id-prefix>\n\nUse /sessions to list recent Codex threads first."
      );
      return;
    }

    const config = this.configStore.data;
    const threads = await listCodexThreads({
      codexBin: config.codexBin,
      workspace: config.workspace,
      model: config.model,
      profile: config.profile,
      search: config.search,
      limit: SESSION_CONNECT_SEARCH_LIMIT
    });
    const resolution = resolveThreadSelection(threads, token);

    if (!resolution.match) {
      if (!resolution.candidates.length) {
        await this.sendReply(
          remoteJid,
          `No recent Codex thread matched "${token}". Use /sessions to inspect available threads.`
        );
      } else {
        await this.sendReply(
          remoteJid,
          [
            `Multiple threads matched "${token}":`,
            "",
            ...resolution.candidates.slice(0, 10).map((thread) => summarizeThread(thread, null)),
            "",
            "Use a longer thread id prefix."
          ].join("\n")
        );
      }
      return;
    }

    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    await this.stateStore.upsertSession(phoneKey, {
      ...session,
      phoneKey,
      remoteJid,
      label,
      threadId: resolution.match.id,
      connectedThreadAt: new Date().toISOString(),
      connectedThreadName: resolution.match.name ?? null
    });

    await this.sendReply(
      remoteJid,
      [
        `This chat is now connected to session ${shortThreadId(resolution.match.id)}.`,
        resolution.match.name ? `name: ${resolution.match.name}` : null,
        sanitizeThreadPreview(resolution.match.preview)
          ? `preview: ${sanitizeThreadPreview(resolution.match.preview)}`
          : null
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  async handlePermissionsCommand({ phoneKey, remoteJid, payload, label }) {
    const active = this.activeRuns.get(phoneKey);
    if (active) {
      await this.sendReply(
        remoteJid,
        "Wait for the active Codex run to finish or send /stop before changing permissions."
      );
      return;
    }

    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const currentLevel = resolveSessionPermissionLevel(this.configStore.data, session);
    const trimmedPayload = String(payload ?? "").trim();

    if (!trimmedPayload) {
      await this.sendReply(
        remoteJid,
        [
          `Current permissions: ${formatPermissionSummary(currentLevel)}`,
          "",
          ...permissionLevelHelpList().map(
            ({ level, description, dangerous }) =>
              `- ${level}${dangerous ? " (explicit confirmation required)" : ""}: ${description}`
          ),
          "",
          "Use /permissions <level> to switch."
        ].join("\n")
      );
      return;
    }

    const [requestedToken, confirmationToken = ""] = trimmedPayload.split(/\s+/, 2);
    const requestedLevel = normalizePermissionLevel(requestedToken);

    if (!requestedLevel) {
      await this.sendReply(
        remoteJid,
        "Unknown permission level. Use /permissions with read-only, workspace-write, or danger-full-access."
      );
      return;
    }

    const requestedConfig = permissionLevelConfig(requestedLevel);
    if (!requestedConfig.dangerous) {
      await this.stateStore.upsertSession(phoneKey, {
        ...session,
        phoneKey,
        remoteJid,
        label,
        permissionLevel: requestedLevel,
        pendingPermissionConfirmation: null
      });

      await this.sendReply(
        remoteJid,
        `Permissions for this chat are now ${requestedLevel}.`
      );
      return;
    }

    const pendingConfirmation =
      isConfirmationFresh(session) && session.pendingPermissionConfirmation
        ? session.pendingPermissionConfirmation
        : null;

    if (
      pendingConfirmation &&
      pendingConfirmation.requestedLevel === requestedLevel &&
      confirmationToken === pendingConfirmation.code
    ) {
      await this.stateStore.upsertSession(phoneKey, {
        ...session,
        phoneKey,
        remoteJid,
        label,
        permissionLevel: requestedLevel,
        pendingPermissionConfirmation: null
      });

      await this.sendReply(
        remoteJid,
        [
          `Permissions for this chat are now ${requestedLevel}.`,
          "Sandboxing and approval prompts are disabled until you lower permissions or start a fresh session with /new."
        ].join("\n")
      );
      return;
    }

    const code = String(randomInt(100000, 1_000_000));
    const expiresAt = new Date(Date.now() + DANGER_CONFIRMATION_WINDOW_MS).toISOString();
    await this.stateStore.upsertSession(phoneKey, {
      ...session,
      phoneKey,
      remoteJid,
      label,
      pendingPermissionConfirmation: {
        code,
        expiresAt,
        requestedLevel
      }
    });

    await this.sendReply(
      remoteJid,
      [
        "Danger full access turns off the sandbox and approval prompts for this chat session.",
        `workspace: ${this.configStore.data.workspace}`,
        `confirm_by: ${expiresAt}`,
        "",
        `Reply with /permissions danger-full-access ${code} to confirm.`
      ].join("\n")
    );
  }

  async handleApprovalDecision(phoneKey, remoteJid, decision) {
    const active = this.activeRuns.get(phoneKey);
    if (!active?.pendingApproval) {
      await this.sendReply(remoteJid, "No approval is pending for this chat.");
      return;
    }

    const pendingApproval = active.pendingApproval;
    const availableDecisions = pendingApproval.availableDecisions ?? null;
    let nextDecision = decision;

    if (Array.isArray(availableDecisions) && !availableDecisions.includes(nextDecision)) {
      if (nextDecision === "acceptForSession" && availableDecisions.includes("accept")) {
        nextDecision = "accept";
      } else {
        await this.sendReply(
          remoteJid,
          `This approval does not support ${decision}. Available decisions: ${availableDecisions.join(", ")}.`
        );
        return;
      }
    }

    try {
      await active.answerApproval(pendingApproval.requestId, nextDecision);
      active.pendingApproval = null;
      await this.stateStore.upsertSession(phoneKey, {
        ...(this.stateStore.data.sessions[phoneKey] ?? {}),
        pendingApproval: null
      });
      await this.sendReply(
        remoteJid,
        `Sent ${nextDecision} for approval request ${pendingApproval.requestId}.`
      );
    } catch (error) {
      await this.sendReply(remoteJid, `Failed to answer approval request: ${error.message}`);
    }
  }

  async stopActiveRun(phoneKey, remoteJid) {
    const active = this.activeRuns.get(phoneKey);
    if (!active) {
      await this.sendReply(remoteJid, "No Codex run is active for this chat.");
      return;
    }

    active.cancelled = true;
    await active.interrupt().catch(() => {
      if (!active.child.killed) {
        active.child.kill("SIGTERM");
      }
    });
    await delay(300);
    if (!active.child.killed) {
      active.child.kill("SIGKILL");
    }

    this.activeRuns.delete(phoneKey);
    await this.stateStore.upsertSession(phoneKey, {
      ...(this.stateStore.data.sessions[phoneKey] ?? {}),
      pendingApproval: null
    });
    await this.sendReply(
      remoteJid,
      "Stopped the active Codex run for this chat."
    );
  }

  async runPrompt({ phoneKey, remoteJid, prompt, forceNewThread, label }) {
    const active = this.activeRuns.get(phoneKey);
    if (active) {
      await this.sendReply(
        remoteJid,
        `Codex is already working on your previous request in session ${shortThreadId(
          active.threadId ?? null
        )}. Send /stop to cancel it first.`
      );
      return;
    }

    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const config = this.configStore.data;
    const existingThreadId = forceNewThread ? null : session.threadId ?? null;
    const permissionLevel = resolveSessionPermissionLevel(config, session);
    const { child, interrupt, answerApproval, resultPromise } = startCodexTurn({
      codexBin: config.codexBin,
      workspace: config.workspace,
      prompt,
      threadId: existingThreadId,
      threadName: existingThreadId
        ? null
        : buildThreadName({
            label,
            phoneKey
          }),
      model: config.model,
      profile: config.profile,
      search: config.search,
      permissionLevel,
      onApprovalRequest: async (approval) => {
        const currentRun = this.activeRuns.get(phoneKey);
        if (!currentRun) {
          return;
        }

        currentRun.pendingApproval = approval;
        await this.stateStore.upsertSession(phoneKey, {
          ...(this.stateStore.data.sessions[phoneKey] ?? {}),
          pendingApproval: {
            kind: approval.kind,
            requestId: approval.requestId,
            requestedAt: new Date().toISOString()
          }
        });
        await this.sendReply(
          remoteJid,
          [
            `Approval needed for session ${shortThreadId(approval.threadId ?? existingThreadId)}.`,
            "",
            formatApprovalDetails(approval)
          ].join("\n")
        );
      },
      onApprovalResolved: async () => {
        const currentRun = this.activeRuns.get(phoneKey);
        if (!currentRun) {
          return;
        }

        currentRun.pendingApproval = null;
        await this.stateStore.upsertSession(phoneKey, {
          ...(this.stateStore.data.sessions[phoneKey] ?? {}),
          pendingApproval: null
        });
      }
    });

    const activeRun = {
      child,
      interrupt,
      answerApproval,
      threadId: existingThreadId,
      startedAt: new Date().toISOString(),
      cancelled: false,
      pendingApproval: null
    };
    this.activeRuns.set(phoneKey, activeRun);

    await this.stateStore.upsertSession(phoneKey, {
      ...session,
      phoneKey,
      remoteJid,
      label,
      permissionLevel,
      pendingPermissionConfirmation: null,
      lastPromptAt: new Date().toISOString(),
      lastPromptText: prompt,
      threadId: existingThreadId
    });

    await this.sendReply(
      remoteJid,
      existingThreadId
        ? `Continuing Codex session ${shortThreadId(existingThreadId)} with ${permissionLevel} permissions.`
        : `Starting a fresh Codex session for this chat with ${permissionLevel} permissions.`
    );

    try {
      const result = await resultPromise;
      this.activeRuns.delete(phoneKey);

      await this.stateStore.upsertSession(phoneKey, {
        ...(this.stateStore.data.sessions[phoneKey] ?? {}),
        phoneKey,
        remoteJid,
        label,
        threadId: result.threadId,
        pendingApproval: null,
        lastReplyAt: new Date().toISOString(),
        lastReplyPreview: result.replyText.slice(0, 200)
      });

      await this.sendReply(
        remoteJid,
        [
          `Session ${shortThreadId(result.threadId)}:`,
          "",
          result.replyText
        ].join("\n")
      );
    } catch (error) {
      this.activeRuns.delete(phoneKey);
      if (activeRun.cancelled) {
        return;
      }

      await this.stateStore.upsertSession(phoneKey, {
        ...(this.stateStore.data.sessions[phoneKey] ?? {}),
        phoneKey,
        remoteJid,
        label,
        pendingApproval: null,
        lastErrorAt: new Date().toISOString(),
        lastError: error.message
      });

      await this.sendReply(
        remoteJid,
        `Codex run failed: ${error.message}`
      );
    }
  }

  async sendReply(remoteJid, text) {
    await this.sendTextMessage(remoteJid, text);
  }

  async sendTextMessage(chatId, text) {
    const socket = await this.runtime.ensureConnected();

    for (const part of splitMessage(text)) {
      const sent = await socket.sendMessage(chatId, { text: part });
      this.rememberOutgoingMessage(sent?.key?.id ?? null);
    }
  }
}
