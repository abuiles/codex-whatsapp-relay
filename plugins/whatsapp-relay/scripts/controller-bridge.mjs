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
import { extractAudioMessage, extractMessageText, extractMessageType } from "./store.mjs";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  transcribeVoiceNote
} from "./voice-transcriber.mjs";
import {
  DEFAULT_TTS_PROVIDER,
  DEFAULT_VOICE_REPLY_SPEED,
  normalizeVoiceReplySpeed,
  synthesizeVoiceReply
} from "./voice-replier.mjs";

const MAX_WHATSAPP_MESSAGE = 3500;
const HEARTBEAT_MS = 30_000;
const RECENT_MESSAGE_LIMIT = 500;
const OUTBOX_POLL_MS = 1_000;
const SESSION_LIST_LIMIT = 12;
const SESSION_CONNECT_SEARCH_LIMIT = 50;
const THREAD_SHORTCUT_TTL_MS = 30 * 60_000;
const DANGER_CONFIRMATION_WINDOW_MS = 60_000;
const VOICE_REPLY_SPEEDS = new Set(["1x", "2x"]);
const LOGGED_OUT_RECOVERY_MS = 60_000;
const VOICE_REPLY_LANGUAGE_TAG =
  /^\s*\[\[\s*reply_language\s*:\s*([a-z]{2,3}(?:[-_][a-z0-9]{2,8})?)\s*\]\]\s*/i;

function invalidControllerCommandError(message) {
  const error = new Error(message);
  error.code = "ERR_CONTROLLER_COMMAND_INVALID";
  error.retryable = false;
  return error;
}

const COMMAND_ALIASES = new Map([
  ["help", "help"],
  ["h", "help"],
  ["status", "status"],
  ["st", "status"],
  ["new", "new"],
  ["reset", "new"],
  ["n", "new"],
  ["stop", "stop"],
  ["x", "stop"],
  ["codex", "prompt"],
  ["ask", "prompt"],
  ["approve", "approve"],
  ["a", "approve"],
  ["deny", "deny"],
  ["decline", "deny"],
  ["d", "deny"],
  ["cancel", "cancel"],
  ["q", "cancel"],
  ["permissions", "permissions"],
  ["permission", "permissions"],
  ["perm", "permissions"],
  ["p", "permissions"],
  ["voice", "voice"],
  ["sessions", "sessions"],
  ["threads", "sessions"],
  ["ls", "sessions"],
  ["connect", "connect"],
  ["resume", "connect"],
  ["session", "connect"],
  ["c", "connect"]
]);

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
    "/status or /st -> show the current Codex session",
    "/new or /n [prompt] -> start a fresh session, optionally with a first prompt",
    "/sessions or /ls -> list recent Codex threads with /1, /2, ... shortcuts",
    "/session <n|thread-id-prefix>, /connect <...>, /c <...>, or /1 -> switch this chat to another Codex thread",
    "/permissions or /p [ro|ww|dfa] -> inspect or change read-only, workspace-write, or danger-full-access",
    "/voice [status|on|off] [1x|2x] -> inspect or change voice reply mode for this chat",
    "/approve or /a [session] -> approve the pending action once or for this session",
    "/deny or /d -> decline the pending action",
    "/cancel or /q -> cancel the pending action",
    "/stop or /x -> stop the in-flight Codex run for this chat",
    "/help or /h -> show this help",
    "",
    "Any other text in this direct chat continues your current Codex session.",
    `Voice notes are transcribed locally with ${DEFAULT_TRANSCRIPTION_MODEL}.`,
    "Short spoken commands are supported for help, status, stop, and new session.",
    "Prefix a prompt with 'reply in voice at 1x' or 'reply in voice at 2x' for a one-off spoken reply."
  ].join("\n");
}

function resolveSessionVoiceReply(session = {}) {
  const reply = session.voiceReply ?? {};
  return {
    enabled: reply.enabled === true,
    speed: normalizeVoiceReplySpeed(reply.speed, DEFAULT_VOICE_REPLY_SPEED)
  };
}

function formatVoiceReplySummary(voiceReply) {
  return voiceReply.enabled ? `on (${voiceReply.speed})` : "off";
}

function parseRequestedVoiceReplySpeed(rawSpeed) {
  const normalized = normalizeVoiceCommandText(rawSpeed).replace(/\s+/g, "");
  switch (normalized) {
    case "":
      return DEFAULT_VOICE_REPLY_SPEED;
    case "1x":
    case "onex":
    case "unox":
    case "unoequis":
    case "oneex":
      return "1x";
    case "2x":
    case "twox":
    case "twoex":
    case "dosx":
    case "dosequis":
      return "2x";
    default:
      return normalizeVoiceReplySpeed(rawSpeed, DEFAULT_VOICE_REPLY_SPEED);
  }
}

export function parseVoiceReplyCommandPayload(payload) {
  const trimmed = String(payload ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "status") {
    return { action: "status" };
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const [first = "", second = ""] = tokens;
  const normalizedFirst = first.toLowerCase();
  const normalizedSecond = second.toLowerCase();

  if (normalizedFirst === "off") {
    return { action: "off" };
  }

  if (normalizedFirst === "on") {
    return {
      action: "on",
      speed: VOICE_REPLY_SPEEDS.has(normalizedSecond)
        ? normalizedSecond
        : DEFAULT_VOICE_REPLY_SPEED
    };
  }

  if (VOICE_REPLY_SPEEDS.has(normalizedFirst)) {
    return { action: "on", speed: normalizedFirst };
  }

  return { action: "unknown" };
}

export function extractOneShotVoiceReplyRequest(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return null;
  }

  const speedPattern =
    "(1x|2x|1\\s*x|2\\s*x|uno\\s*x|uno\\s*equis|unox|dos\\s*x|dos\\s*equis|dosx|one\\s*x|one\\s*ex|onex|two\\s*x|two\\s*ex|twox)";
  const patterns = [
    new RegExp(
      `^\\s*(?:por favor\\s+)?(?:resp[oó]ndeme|respondeme|responde|contestame|cont[eé]stame)\\s+en\\s+voz(?:\\s+a\\s*${speedPattern})?[\\s,:-]+([\\s\\S]+)$`,
      "i"
    ),
    new RegExp(
      `^\\s*(?:please\\s+)?(?:reply(?:\\s+to\\s+me)?|answer(?:\\s+me)?)\\s+in\\s+voice(?:\\s+at\\s*${speedPattern})?[\\s,:-]+([\\s\\S]+)$`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) {
      continue;
    }

    const prompt = String(match.at(-1) ?? "").trim();
    if (!prompt) {
      return null;
    }

    return {
      prompt,
      voiceReply: {
        enabled: true,
        speed: parseRequestedVoiceReplySpeed(match[1])
      }
    };
  }

  return null;
}

export function buildVoiceReplyPrompt(prompt) {
  return [
    String(prompt ?? "").trim(),
    "",
    "Delivery note for the assistant:",
    "- Your final answer will be converted into a WhatsApp voice note.",
    "- Reply in the same language as the user.",
    "- Start your final answer with a single metadata line exactly like [[reply_language:<language-code>]].",
    "- Replace <language-code> with the language you are actually replying in, for example en, es, it, or pt-BR.",
    "- Put the real answer after that metadata line and do not mention the metadata.",
    "- Write in plain, natural prose that sounds good when spoken aloud.",
    "- If the answer is short, give the full answer.",
    "- If it would be long, give a concise spoken summary with the key takeaway first.",
    "- Avoid markdown tables, code fences, raw URLs, and long literal lists unless the user explicitly asks for exact text."
  ].join("\n");
}

export function extractVoiceReplyEnvelope(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return {
      text: "",
      languageId: null,
      hasLanguageTag: false
    };
  }

  const match = source.match(VOICE_REPLY_LANGUAGE_TAG);
  if (!match) {
    return {
      text: source,
      languageId: null,
      hasLanguageTag: false
    };
  }

  const stripped = source.slice(match[0].length).trim();
  return {
    text: stripped,
    languageId: String(match[1] ?? "")
      .trim()
      .toLowerCase() || null,
    hasLanguageTag: true
  };
}

function parseThreadShortcutIndex(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }

  const index = Number.parseInt(normalized, 10);
  return Number.isInteger(index) && index > 0 ? index : null;
}

function isFreshThreadShortcutList(session = {}) {
  const storedAt = Date.parse(session.lastThreadChoicesAt ?? "");
  return Number.isFinite(storedAt) && storedAt + THREAD_SHORTCUT_TTL_MS > Date.now();
}

function resolveStoredThreadShortcut(session = {}, token) {
  const index = parseThreadShortcutIndex(token);
  if (!index || !isFreshThreadShortcutList(session)) {
    return null;
  }

  const choice = session.lastThreadChoices?.[index - 1];
  return choice
    ? {
        id: choice.id,
        name: choice.name ?? null,
        preview: choice.preview ?? null,
        updatedAt: choice.updatedAt ?? null
      }
    : null;
}

function formatThreadShortcut(index) {
  return `/${index}`;
}

export function parseIncomingCommand(text, captureAllDirectMessages) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { type: "empty" };
  }

  const commandMatch = trimmed.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]+))?$/i);
  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const payload = commandMatch[2]?.trim() ?? "";
    const shortcutIndex = parseThreadShortcutIndex(command);
    if (shortcutIndex && !payload) {
      return { type: "connect", payload: String(shortcutIndex) };
    }

    const normalizedCommand = COMMAND_ALIASES.get(command) ?? null;

    switch (normalizedCommand) {
      case "help":
        return { type: "help" };
      case "status":
        return { type: "status" };
      case "new":
        return { type: "new", prompt: payload };
      case "stop":
        return { type: "stop" };
      case "prompt":
        return payload ? { type: "prompt", prompt: payload } : { type: "help" };
      case "approve":
        return {
          type: "approvalDecision",
          decision: payload.toLowerCase() === "session" ? "acceptForSession" : "accept"
        };
      case "deny":
        return { type: "approvalDecision", decision: "decline" };
      case "cancel":
        return { type: "approvalDecision", decision: "cancel" };
      case "permissions":
        return { type: "permissions", payload };
      case "voice":
        return { type: "voiceReplySettings", payload };
      case "sessions":
        return { type: "sessions" };
      case "connect":
        return { type: "connect", payload };
      default:
        return { type: "unknown" };
    }
  }

  if (captureAllDirectMessages) {
    const oneShotVoiceReply = extractOneShotVoiceReplyRequest(trimmed);
    if (oneShotVoiceReply) {
      return {
        type: "prompt",
        prompt: oneShotVoiceReply.prompt,
        voiceReply: oneShotVoiceReply.voiceReply
      };
    }

    return { type: "prompt", prompt: trimmed, voiceReply: null };
  }

  return { type: "ignored" };
}

export function normalizeVoiceCommandText(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[?!.,;:()[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesVoiceCommand(text, phrases) {
  return phrases.includes(text);
}

export function parseVoiceTranscript(transcript, captureAllDirectMessages = true) {
  const normalized = normalizeVoiceCommandText(transcript);
  if (!normalized) {
    return { type: "empty" };
  }

  if (
    matchesVoiceCommand(normalized, [
      "help",
      "ayuda",
      "comandos"
    ])
  ) {
    return { type: "help" };
  }

  if (
    matchesVoiceCommand(normalized, [
      "status",
      "estado",
      "session status",
      "estado de la sesion"
    ])
  ) {
    return { type: "status" };
  }

  if (
    matchesVoiceCommand(normalized, [
      "cancel",
      "cancelar"
    ])
  ) {
    return { type: "approvalDecision", decision: "cancel" };
  }

  if (
    matchesVoiceCommand(normalized, [
      "stop",
      "para",
      "parar",
      "deten",
      "detente",
      "detener"
    ])
  ) {
    return { type: "stop" };
  }

  if (
    matchesVoiceCommand(normalized, [
      "new",
      "new session",
      "new chat",
      "start over",
      "fresh session",
      "nueva sesion",
      "sesion nueva",
      "nuevo chat",
      "reinicia",
      "reiniciar"
    ])
  ) {
    return { type: "new", prompt: "" };
  }

  if (!captureAllDirectMessages) {
    return { type: "ignored" };
  }

  const prompt = String(transcript ?? "").trim();
  const oneShotVoiceReply = extractOneShotVoiceReplyRequest(prompt);
  if (oneShotVoiceReply) {
    return {
      type: "prompt",
      prompt: oneShotVoiceReply.prompt,
      voiceReply: oneShotVoiceReply.voiceReply
    };
  }

  return {
    type: "prompt",
    prompt
  };
}

function formatVoiceTranscriptReply(transcription) {
  const confidence = Number.isFinite(transcription.avgConfidence)
    ? ` (${Math.round(transcription.avgConfidence * 100)}% avg confidence)`
    : "";
  return `Transcript${confidence}: ${transcription.transcript}`;
}

function shouldRetryVoiceTranscript(transcription) {
  if (!Number.isFinite(transcription?.avgConfidence)) {
    return false;
  }

  const wordCount = String(transcription.transcript ?? "")
    .split(/\s+/)
    .filter(Boolean).length;

  return transcription.avgConfidence < 0.85 && wordCount <= 4;
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
  return summarizeThreadChoice(thread, currentThreadId);
}

function summarizeThreadChoice(thread, currentThreadId, index = null) {
  const preview = sanitizeThreadPreview(thread.preview);
  const shortcut = Number.isInteger(index)
    ? ` ${formatThreadShortcut(index)}`
    : "";
  return [
    `${Number.isInteger(index) ? `${index}.` : "-"} ${shortThreadId(thread.id)}${
      thread.id === currentThreadId ? " (current)" : ""
    }${shortcut}`,
    thread.name ? `  name=${thread.name}` : null,
    preview ? `  preview=${preview}` : null,
    thread.updatedAt ? `  updated_at=${formatThreadTimestamp(thread.updatedAt)}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

export function resolveThreadSelection(threads, token, session = {}) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    return {
      match: null,
      candidates: []
    };
  }

  const shortcutMatch =
    resolveStoredThreadShortcut(session, normalized) ??
    (() => {
      const index = parseThreadShortcutIndex(normalized);
      return index ? threads[index - 1] ?? null : null;
    })();
  if (shortcutMatch) {
    return {
      match: shortcutMatch,
      candidates: [shortcutMatch]
    };
  }

  const shortcutIndex = parseThreadShortcutIndex(normalized);
  if (shortcutIndex) {
    return {
      match: null,
      candidates: [],
      requestedShortcut: shortcutIndex
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
    this.loggedOutRecoveryAtMs = 0;
    this.loggedOutRecoveryPromise = null;
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
    await this.recoverLoggedOutRuntime();
    const summary = this.runtime.summary();

    await this.stateStore.setProcess({
      pid: process.pid,
      status: "running",
      heartbeatAt: new Date().toISOString(),
      whatsappStatus: summary.status,
      whatsappUserId: summary.user?.id ?? null,
      whatsappLastDisconnect: summary.lastDisconnect ?? null
    });
  }

  async recoverLoggedOutRuntime() {
    const summary = this.runtime.summary();
    if (summary.status !== "logged_out" || !this.runtime.hasSavedCreds()) {
      return;
    }

    if (this.loggedOutRecoveryPromise) {
      await this.loggedOutRecoveryPromise.catch(() => {});
      return;
    }

    if (Date.now() - this.loggedOutRecoveryAtMs < LOGGED_OUT_RECOVERY_MS) {
      return;
    }

    this.loggedOutRecoveryAtMs = Date.now();
    this.loggedOutRecoveryPromise = this.runtime
      .start({ printQrToTerminal: false, force: true })
      .catch((error) => {
        console.error("failed to recover logged out WhatsApp runtime", error);
      })
      .finally(() => {
        this.loggedOutRecoveryPromise = null;
      });

    await this.loggedOutRecoveryPromise;
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
        if (!command?.payload?.chatId) {
          throw invalidControllerCommandError(
            "Controller send_message command is missing payload.chatId."
          );
        }
        if (typeof command?.payload?.text !== "string" || !command.payload.text.trim()) {
          throw invalidControllerCommandError(
            "Controller send_message command is missing payload.text."
          );
        }
        await this.sendTextMessage(command.payload.chatId, command.payload.text);
        return;
      default:
        throw invalidControllerCommandError(
          `Unknown controller command type: ${command.type}`
        );
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

    const messageType = extractMessageType(message.message);
    const audioMessage = extractAudioMessage(message.message);
    const extractedText = extractMessageText(message.message).trim();
    let text = audioMessage ? "" : extractedText;
    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const label = controller.label ?? message.pushName ?? null;

    await this.stateStore.upsertSession(phoneKey, {
      phoneKey,
      remoteJid,
      label,
      permissionLevel: resolveSessionPermissionLevel(config, session),
      lastInboundAt: new Date().toISOString(),
      lastInboundText:
        text ||
        (audioMessage ? "[voice note]" : `[${message.key?.id ?? "message"}]`),
      lastInboundType: audioMessage ? "voice" : messageType
    });

    let command = null;

    if (text) {
      command = parseIncomingCommand(text, config.captureAllDirectMessages);
    } else if (audioMessage) {
      await this.sendReply(
        remoteJid,
        [
          "Voice note received.",
          `Transcribing locally with ${DEFAULT_TRANSCRIPTION_MODEL}.`,
          "The first run can take longer while the model is prepared."
        ].join(" ")
      );

      try {
        const audioBuffer = await this.runtime.downloadMediaBuffer(message);
        const transcription = await transcribeVoiceNote({
          audioBuffer,
          mimeType: audioMessage.mimetype ?? "audio/ogg"
        });
        text = transcription.transcript;

        await this.stateStore.upsertSession(phoneKey, {
          ...(this.stateStore.data.sessions[phoneKey] ?? session),
          phoneKey,
          remoteJid,
          label,
          lastInboundText: text,
          lastInboundType: "voice",
          lastVoiceTranscriptAt: new Date().toISOString(),
          lastVoiceTranscriptModel: transcription.model,
          lastVoiceTranscriptConfidence: transcription.avgConfidence,
          lastVoiceTranscriptMinConfidence: transcription.minConfidence
        });

        await this.sendReply(remoteJid, formatVoiceTranscriptReply(transcription));
        if (shouldRetryVoiceTranscript(transcription)) {
          await this.sendReply(
            remoteJid,
            "That voice note looks uncertain. Please try again with a longer note or type the command."
          );
          return;
        }
        command = parseVoiceTranscript(text, config.captureAllDirectMessages);
      } catch (error) {
        await this.stateStore.upsertSession(phoneKey, {
          ...(this.stateStore.data.sessions[phoneKey] ?? session),
          phoneKey,
          remoteJid,
          label,
          lastErrorAt: new Date().toISOString(),
          lastError: `Voice transcription failed: ${error.message}`
        });
        await this.sendReply(
          remoteJid,
          `Failed to transcribe that voice note locally: ${error.message}`
        );
        return;
      }
    } else {
      await this.sendReply(
        remoteJid,
        "Only text messages and voice notes are supported for Codex control right now."
      );
      return;
    }
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
      case "voiceReplySettings":
        await this.handleVoiceReplyCommand({
          phoneKey,
          remoteJid,
          payload: command.payload,
          label
        });
        return;
      case "new":
        {
          const preservedVoiceReply = resolveSessionVoiceReply(session);
          await this.stateStore.removeSession(phoneKey);
          if (preservedVoiceReply.enabled) {
            await this.stateStore.upsertSession(phoneKey, {
              phoneKey,
              remoteJid,
              label,
              voiceReply: preservedVoiceReply
            });
          }
        }
        if (command.prompt) {
          await this.runPrompt({
            phoneKey,
            remoteJid,
            prompt: command.prompt,
            forceNewThread: true,
            label,
            voiceReplyOverride: command.voiceReply ?? null
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
          label
        });
        return;
      case "permissions":
        await this.handlePermissionsCommand({
          phoneKey,
          remoteJid,
          payload: command.payload,
          label
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
          label,
          voiceReplyOverride: command.voiceReply ?? null
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
    const voiceReply = resolveSessionVoiceReply(session);
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
      `voice_reply: ${formatVoiceReplySummary(voiceReply)}`,
      `voice_reply_provider: ${DEFAULT_TTS_PROVIDER}`,
      active?.pendingApproval ? `approval_pending: yes (${active.pendingApproval.kind})` : null,
      pendingConfirmation
        ? `danger_full_access_confirmation: pending until ${pendingConfirmation.expiresAt}`
        : null,
      session.lastPromptAt ? `last_prompt_at: ${session.lastPromptAt}` : null,
      session.lastReplyAt ? `last_reply_at: ${session.lastReplyAt}` : null,
      "",
      "Commands: /n, /ls, /1, /session, /p, /voice, /x, /h"
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

    await this.stateStore.upsertSession(phoneKey, {
      phoneKey,
      lastThreadChoices: threads.map((thread) => ({
        id: thread.id,
        name: thread.name ?? null,
        preview: sanitizeThreadPreview(thread.preview),
        updatedAt: thread.updatedAt ?? null
      })),
      lastThreadChoicesAt: new Date().toISOString()
    });

    const lines = [
      "Recent Codex sessions:",
      "",
      ...threads.map((thread, index) =>
        summarizeThreadChoice(thread, session.threadId ?? null, index + 1)
      ),
      "",
      "Use /1, /2, ..., /session <number>, or /connect <thread-id-prefix> to switch this chat."
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
        "Usage: /session <number|thread-id-prefix>\n\nUse /sessions to list recent Codex threads first."
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
    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const resolution = resolveThreadSelection(threads, token, session);

    if (!resolution.match) {
      if (resolution.requestedShortcut) {
        await this.sendReply(
          remoteJid,
          [
            `No recent session matched shortcut ${formatThreadShortcut(resolution.requestedShortcut)}.`,
            "Use /sessions to refresh the numbered list, or use /session <thread-id-prefix>."
          ].join("\n")
        );
        return;
      }

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

  async handleVoiceReplyCommand({ phoneKey, remoteJid, payload, label }) {
    const active = this.activeRuns.get(phoneKey);
    if (active) {
      await this.sendReply(
        remoteJid,
        "Wait for the active Codex run to finish or send /stop before changing voice reply mode."
      );
      return;
    }

    const session = this.stateStore.data.sessions[phoneKey] ?? {};
    const currentVoiceReply = resolveSessionVoiceReply(session);
    const parsed = parseVoiceReplyCommandPayload(payload);

    if (parsed.action === "status") {
      await this.sendReply(
        remoteJid,
        `Voice replies for this chat are ${formatVoiceReplySummary(currentVoiceReply)}.`
      );
      return;
    }

    if (parsed.action === "off") {
      const nextVoiceReply = {
        ...currentVoiceReply,
        enabled: false
      };
      await this.stateStore.upsertSession(phoneKey, {
        ...session,
        phoneKey,
        remoteJid,
        label,
        voiceReply: nextVoiceReply
      });
      await this.sendReply(remoteJid, "Voice replies are now off for this chat.");
      return;
    }

    if (parsed.action === "on") {
      const nextVoiceReply = {
        enabled: true,
        speed: normalizeVoiceReplySpeed(parsed.speed, currentVoiceReply.speed)
      };
      await this.stateStore.upsertSession(phoneKey, {
        ...session,
        phoneKey,
        remoteJid,
        label,
        voiceReply: nextVoiceReply
      });
      await this.sendReply(
        remoteJid,
        `Voice replies are now on for this chat at ${nextVoiceReply.speed}.`
      );
      return;
    }

    await this.sendReply(
      remoteJid,
      [
        "Usage:",
        "/voice status",
        "/voice on",
        "/voice on 2x",
        "/voice off"
      ].join("\n")
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
        "Unknown permission level. Use /permissions with ro|ww|dfa or read-only|workspace-write|danger-full-access."
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

  async runPrompt({
    phoneKey,
    remoteJid,
    prompt,
    forceNewThread,
    label,
    voiceReplyOverride = null
  }) {
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
    const sessionVoiceReply = resolveSessionVoiceReply(session);
    const activeVoiceReply =
      voiceReplyOverride && voiceReplyOverride.enabled
        ? {
            enabled: true,
            speed: normalizeVoiceReplySpeed(
              voiceReplyOverride.speed,
              sessionVoiceReply.speed
            )
          }
        : sessionVoiceReply;
    const promptForCodex = activeVoiceReply.enabled
      ? buildVoiceReplyPrompt(prompt)
      : prompt;
    const { child, interrupt, answerApproval, resultPromise } = startCodexTurn({
      codexBin: config.codexBin,
      workspace: config.workspace,
      prompt: promptForCodex,
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
      pendingApproval: null,
      voiceReply: activeVoiceReply
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
      lastPromptVoiceReply: activeVoiceReply.enabled ? activeVoiceReply : null,
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
      const replyEnvelope = extractVoiceReplyEnvelope(result.replyText);
      const replyText =
        replyEnvelope.text || (replyEnvelope.hasLanguageTag ? "" : result.replyText);

      if (!replyText) {
        throw new Error("Codex returned an empty reply.");
      }

      await this.stateStore.upsertSession(phoneKey, {
        ...(this.stateStore.data.sessions[phoneKey] ?? {}),
        phoneKey,
        remoteJid,
        label,
        threadId: result.threadId,
        pendingApproval: null,
        lastReplyAt: new Date().toISOString(),
        lastReplyPreview: replyText.slice(0, 200),
        lastReplyVoiceReply: activeVoiceReply.enabled ? activeVoiceReply : null
      });

      if (activeVoiceReply.enabled) {
        try {
          await this.sendVoiceReply(
            remoteJid,
            replyText,
            activeVoiceReply,
            replyEnvelope.languageId
          );
        } catch (error) {
          await this.sendReply(
            remoteJid,
            `Failed to generate the voice reply locally with ${DEFAULT_TTS_PROVIDER}: ${error.message}`
          );
          await this.sendReply(
            remoteJid,
            [
              `Session ${shortThreadId(result.threadId)}:`,
              "",
              replyText
            ].join("\n")
          );
        }
        return;
      }

      await this.sendReply(
        remoteJid,
        [
          `Session ${shortThreadId(result.threadId)}:`,
          "",
          replyText
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

  async sendVoiceReply(remoteJid, text, voiceReply, languageIdHint = null) {
    const synthesized = await synthesizeVoiceReply({
      text,
      speed: voiceReply?.speed,
      languageIdHint
    });
    await this.sendVoiceNoteMessage(remoteJid, synthesized.audioBuffer, {
      mimetype: synthesized.mimetype,
      seconds: synthesized.seconds
    });
  }

  async sendTextMessage(chatId, text) {
    const socket = await this.runtime.ensureConnected();

    for (const part of splitMessage(text)) {
      const sent = await socket.sendMessage(chatId, { text: part });
      this.rememberOutgoingMessage(sent?.key?.id ?? null);
    }
  }

  async sendVoiceNoteMessage(chatId, audioBuffer, { mimetype, seconds } = {}) {
    const socket = await this.runtime.ensureConnected();
    const content = {
      audio: Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer ?? ""),
      ptt: true,
      mimetype: mimetype ?? "audio/ogg; codecs=opus"
    };

    if (Number.isFinite(seconds) && seconds > 0) {
      content.seconds = seconds;
    }

    const sent = await socket.sendMessage(chatId, content);
    this.rememberOutgoingMessage(sent?.key?.id ?? null);
  }
}
