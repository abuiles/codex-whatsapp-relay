import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  classifyProjectIntent as classifyProjectIntentWithCodex,
  classifyVoiceCommandIntent,
  listCodexThreads,
  normalizeVoiceCommandIntent,
  startCodexTurn
} from "./codex-runner.mjs";
import {
  ControllerConfigStore,
  resolvePhoneKeyFromJid
} from "./controller-config.mjs";
import {
  normalizeProjectAlias,
  resolveExplicitConfiguredProject,
  resolveConfiguredProject,
  resolveConfiguredProjectSelection,
  resolveProjectReference
} from "./controller-projects.mjs";
import {
  defaultPermissionLevel,
  normalizePermissionLevel,
  permissionLevelConfig,
  permissionLevelHelpList,
  resolvePermissionLevel
} from "./controller-permissions.mjs";
import { drainControllerCommands } from "./controller-outbox.mjs";
import { ControllerStateStore, defaultProjectSession } from "./controller-state.mjs";
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
const ACTIVE_RUN_PREVIEW_LIMIT = 160;
const VOICE_REPLY_SPEEDS = new Set(["1x", "2x"]);
const LOGGED_OUT_RECOVERY_MS = 60_000;
const VOICE_REPLY_LANGUAGE_TAG =
  /^\s*\[\[\s*reply_language\s*:\s*([a-z]{2,3}(?:[-_][a-z0-9]{2,8})?)\s*\]\]\s*/i;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g;
const FENCED_CODE_BLOCK_PATTERN = /```(?:[\w-]+)?\n?([\s\S]*?)```/g;
const ACTIONABLE_URL_PATTERN = /https?:\/\/\S+/i;

function invalidControllerCommandError(message) {
  const error = new Error(message);
  error.code = "ERR_CONTROLLER_COMMAND_INVALID";
  error.retryable = false;
  return error;
}

const COMMAND_ALIASES = new Map([
  ["help", "help"],
  ["h", "help"],
  ["projects", "projects"],
  ["project", "project"],
  ["status", "status"],
  ["st", "status"],
  ["in", "projectPrompt"],
  ["btw", "btw"],
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
  ["ro", "permissionShortcut"],
  ["ww", "permissionShortcut"],
  ["dfa", "permissionShortcut"],
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

function compactRunPreview(value, limit = ACTIVE_RUN_PREVIEW_LIMIT) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, limit) : null;
}

function buildActiveRunStatusLines(activeRun) {
  if (!activeRun) {
    return [];
  }

  return [
    `run_status: ${activeRun.status ?? "running"}`,
    activeRun.progressPreview ? `run_preview: ${activeRun.progressPreview}` : null,
    activeRun.lastProgressAt ? `run_progress_at: ${activeRun.lastProgressAt}` : null
  ].filter(Boolean);
}

export function applyRunLifecycleEvent(activeRun, event, timestamp = new Date().toISOString()) {
  if (!activeRun || !event || typeof event !== "object") {
    return activeRun;
  }

  activeRun.lastEventAt = timestamp;

  switch (event.type) {
    case "turnStarted":
      activeRun.status = "running";
      activeRun.threadId = activeRun.threadId ?? event.threadId ?? null;
      return activeRun;
    case "agentMessageStarted":
    case "agentMessageDelta":
    case "agentMessageCompleted": {
      activeRun.status = event.phase === "final_answer" ? "finalizing" : "running";
      activeRun.progressPhase = event.phase ?? activeRun.progressPhase ?? null;
      const preview = compactRunPreview(event.text);
      if (preview) {
        activeRun.progressPreview = preview;
        activeRun.lastProgressAt = timestamp;
      }
      return activeRun;
    }
    case "approvalRequested":
      activeRun.status = "waiting_for_approval";
      return activeRun;
    case "approvalResolved":
      activeRun.status = "running";
      return activeRun;
    case "turnCompleted":
      activeRun.status = event.status === "completed" ? "completed" : String(event.status);
      activeRun.threadId = activeRun.threadId ?? event.threadId ?? null;
      return activeRun;
    case "turnError":
      activeRun.status = event.willRetry ? "retrying" : "failed";
      if (!activeRun.progressPreview) {
        const preview = compactRunPreview(event.error);
        if (preview) {
          activeRun.progressPreview = preview;
          activeRun.lastProgressAt = timestamp;
        }
      }
      return activeRun;
    default:
      return activeRun;
  }
}

function buildThreadName({ label, phoneKey, projectAlias = null, scopeType = "project" }) {
  const base = String(label ?? "").trim() || phoneKey;
  const normalized = base.replace(/\s+/g, " ").trim();
  const scopeSuffix =
    scopeType === "btw"
      ? " [btw]"
      : projectAlias
        ? ` [${projectAlias}]`
        : "";
  return `WhatsApp: ${normalized}${scopeSuffix}`.slice(0, 120);
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

function formatProjectStatus(project, projectSession, activeRun, permissionLevel, { activeProjectAlias } = {}) {
  const flags = [];
  if (project.alias === activeProjectAlias) {
    flags.push("active");
  }
  if (activeRun) {
    flags.push("busy");
  }

  const status = flags.length ? ` (${flags.join(", ")})` : "";
  const sessionId = shortThreadId(projectSession.threadId ?? null);
  return `- ${project.alias}${status} session=${sessionId} perms=${permissionLevel}`;
}

function formatProjectShortcut(index) {
  return `/project ${index}`;
}

function summarizeProjectChoice(
  project,
  projectSession,
  activeRun,
  permissionLevel,
  { activeProjectAlias, index = null } = {}
) {
  const preview = formatProjectStatus(project, projectSession, activeRun, permissionLevel, {
    activeProjectAlias
  }).replace(/^- /, "");
  const shortcut = Number.isInteger(index) ? ` ${formatProjectShortcut(index)}` : "";
  return [
    `${Number.isInteger(index) ? `${index}.` : "-"} ${preview}${shortcut}`,
    projectSession.connectedThreadName ? `  thread=${projectSession.connectedThreadName}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function renderAmbiguousProjectSelectionMessage(spec, candidates) {
  return [
    `Multiple configured projects matched "${String(spec ?? "").trim()}":`,
    "",
    ...candidates.map((project) => `- ${project.alias}`),
    "",
    "Use /projects to inspect available aliases and be more specific."
  ].join("\n");
}

function projectHelpFooter() {
  return [
    "",
    "Switch: /project <number|alias|project hint>",
    "One-off: /in <alias> <prompt>",
    "Fresh: /new or 'start new session in <repo> inside code directory'",
    "Permissions: /ro, /ww, /dfa, or /p <alias> <ro|ww|dfa>"
  ];
}

function helpText() {
  return [
    "WhatsApp Codex bridge commands:",
    "/projects -> list configured projects",
    "/project -> show the active project for this chat",
    "/project <number|alias|project hint|path hint> -> switch this chat to another project, letting Codex resolve natural project hints against existing projects before auto-adding a repo from a path",
    "/status or /st [project] -> show the current project session or another project's session",
    "/new or /n [prompt] -> start a fresh session in the active project, optionally with a first prompt",
    "/in <project> <prompt> -> send a one-off prompt to another project without switching",
    "/btw <prompt> -> ask a disposable side question and then return to your current project",
    "/sessions or /ls [project] -> list recent Codex threads for a project with /1, /2, ... shortcuts",
    "/session [project] <n|thread-id-prefix>, /connect <...>, /c <...>, or /1 -> switch this chat to another Codex thread inside a project",
    "/permissions or /p [project] [ro|ww|dfa] -> inspect or change read-only, workspace-write, or danger-full-access",
    "/ro, /ww, /dfa -> quick permission switch for the active project",
    "/voice [status|on|off] [1x|2x] -> inspect or change voice reply mode for this chat",
    "/approve or /a [project|btw] [session] -> approve the pending action once or for this session",
    "/deny or /d [project|btw] -> decline the pending action",
    "/cancel or /q [project|btw] -> cancel the pending action",
    "/stop or /x [project|btw] -> stop an in-flight Codex run",
    "/help or /h -> show this help",
    "",
    "Any other text in this direct chat continues the active project's current Codex session.",
    "If that same project or /btw scope is already busy, prompt-like follow-ups queue automatically and run in order.",
    `Voice notes are transcribed locally with ${DEFAULT_TRANSCRIPTION_MODEL}.`,
    "Short spoken commands are supported for help, status, stop, and new session.",
    "Say or type 'start new session in alpha app inside code directory' to jump into another repo without manually adding it first.",
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

function resolveConfiguredTtsProvider(config) {
  return config?.ttsProvider ?? DEFAULT_TTS_PROVIDER;
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

export function sanitizeReplyTextForWhatsApp(text) {
  return String(text ?? "")
    .replace(FENCED_CODE_BLOCK_PATTERN, (_, content) => String(content ?? "").trim())
    .replace(MARKDOWN_LINK_PATTERN, (_, label, target) => {
      const normalizedLabel = String(label ?? "").trim();
      const normalizedTarget = String(target ?? "").trim();
      if (!normalizedTarget) {
        return normalizedLabel;
      }

      if (!normalizedLabel || normalizedLabel === normalizedTarget) {
        return normalizedTarget;
      }

      return normalizedTarget.startsWith("/")
        ? normalizedTarget
        : `${normalizedLabel}: ${normalizedTarget}`;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildVoiceReplyTextCompanion(text) {
  const sanitized = sanitizeReplyTextForWhatsApp(text);
  if (!sanitized) {
    return "";
  }

  const actionableLines = [];
  for (const line of sanitized.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (
      ACTIONABLE_URL_PATTERN.test(trimmed) ||
      /(^|\s)\/[a-z0-9-]+(?:\s|$)/i.test(trimmed) ||
      /\b\d{6}\b/.test(trimmed)
    ) {
      actionableLines.push(trimmed);
    }
  }

  return [...new Set(actionableLines)].join("\n");
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
      case "projects":
        return { type: "projects" };
      case "project":
        return { type: "project", payload };
      case "status":
        return { type: "status", payload };
      case "new":
        return { type: "new", prompt: payload };
      case "projectPrompt":
        return payload ? { type: "projectPrompt", payload } : { type: "help" };
      case "btw":
        return payload ? { type: "btw", prompt: payload } : { type: "help" };
      case "stop":
        return { type: "stop", payload };
      case "prompt":
        return payload ? { type: "prompt", prompt: payload } : { type: "help" };
      case "approve":
        return {
          type: "approvalDecision",
          decision: "accept",
          payload
        };
      case "deny":
        return { type: "approvalDecision", decision: "decline", payload };
      case "cancel":
        return { type: "approvalDecision", decision: "cancel", payload };
      case "permissions":
        return { type: "permissions", payload };
      case "permissionShortcut": {
        const permissionShortcutTokens = splitPayloadTokens(payload);
        const trailingConfirmationToken =
          permissionShortcutTokens.length && /^\d{6}$/.test(permissionShortcutTokens.at(-1))
            ? permissionShortcutTokens.pop()
            : null;
        const shortcutPayload =
          permissionShortcutTokens.length > 0
            ? `${permissionShortcutTokens.join(" ")} ${command}${
                trailingConfirmationToken ? ` ${trailingConfirmationToken}` : ""
              }`
            : trailingConfirmationToken
              ? `${command} ${trailingConfirmationToken}`
              : command;
        return { type: "permissions", payload: shortcutPayload };
      }
      case "voice":
        return { type: "voiceReplySettings", payload };
      case "sessions":
        return { type: "sessions", payload };
      case "connect":
        return { type: "connect", payload };
      default:
        return { type: "unknown" };
    }
  }

  if (captureAllDirectMessages) {
    const implicitProjectCommand = parseImplicitProjectCommand(trimmed);
    if (implicitProjectCommand) {
      return implicitProjectCommand;
    }

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

export function parseImplicitProjectCommand(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    return null;
  }

  const patterns = [
    /^(?:please\s+)?start(?:\s+a)?\s+new\s+session\s+in\s+(.+)$/i,
    /^(?:please\s+)?start(?:\s+a)?\s+new\s+project\s+session\s+in\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) {
      continue;
    }

    const target = String(match[1] ?? "").trim();
    if (!target) {
      return null;
    }

    return {
      type: "newProjectSession",
      target
    };
  }

  return null;
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
    return { type: "status", payload: "" };
  }

  if (
    matchesVoiceCommand(normalized, [
      "cancel",
      "cancelar"
    ])
  ) {
    return { type: "approvalDecision", decision: "cancel", payload: "" };
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
    return { type: "stop", payload: "" };
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

function joinMessageSections(...sections) {
  return sections
    .filter((section) => typeof section === "string" && section.trim())
    .join("\n\n");
}

export function requiresTextConfirmationForVoicePrompt(prompt) {
  const normalized = normalizeVoiceCommandText(prompt);
  return [
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?merge\b/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?deploy\b/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?retarget\b/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?rebase\b/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?(?:delete|remove|drop|squash)\s+(?:it|this|that|last|current|my|the\s+(?:(?:current|last|my)\s+)?(?:branch|tag|release|pr|pull request|commit|remote|session|project|worktree)|(?:branch|tag|release|pr|pull request|commit|remote|session|project|worktree))\b/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?(?:prepare|cut|ship|publish|make|do)\s+(?:the\s+|a\s+)?release\b/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?release(?:\s+(?:it|this|that|the|a|current|new|v?\d))/,
    /^(?:please\s+|can you\s+|could you\s+|go ahead(?: and)?\s+|now\s+|okay\s+|ok\s+|lets\s+)?tag(?:\s+(?:it|this|that|the|a|v?\d))/,
    /\bauto ?merge\b/
  ].some((pattern) => pattern.test(normalized));
}

export function shouldSplitCompoundVoiceControlRequest(transcript) {
  const normalized = normalizeVoiceCommandText(transcript);
  return (
    /\b(and then|then|also|y luego|despues|después)\b/.test(normalized) &&
    /\b(switch|change|move|cambia|cambiar|mueve|mover)\b/.test(normalized) &&
    /\bproject|proyecto\b/.test(normalized)
  );
}

function formatHighImpactVoicePromptWarning(transcriptReply) {
  return joinMessageSections(
    transcriptReply,
    "This sounds like a high-impact repo action. Please send it as text so I do not merge, release, rebase, retarget, or delete the wrong thing from voice."
  );
}

export function formatProjectRunReplyPrefix({
  projectAlias,
  threadId,
  activeProjectAlias,
  outcome = "completed"
}) {
  const isBackground = activeProjectAlias && activeProjectAlias !== projectAlias;
  const action = outcome === "failed" ? "failed" : "completed";
  const sessionLabel = threadId ? ` session ${shortThreadId(threadId)}` : "";
  const heading = isBackground
    ? `Background result from ${projectAlias}${sessionLabel} ${action}.`
    : outcome === "failed"
      ? `Project ${projectAlias} failed.`
      : `Completed project ${projectAlias}${sessionLabel}.`;

  return [
    heading,
    isBackground ? `You are currently in ${activeProjectAlias}.` : null
  ]
    .filter(Boolean)
    .join("\n");
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

function resolveSessionPermissionLevel(config, projectOrSession = {}, maybeSession = undefined) {
  const project = maybeSession === undefined ? null : projectOrSession;
  const session = maybeSession === undefined ? projectOrSession : maybeSession;
  return resolvePermissionLevel(
    session.permissionLevel ??
      project?.permissionLevel ??
      config.permissionLevel ??
      defaultPermissionLevel()
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

export function resolveProjectSelection(projects, token) {
  const normalized = String(token ?? "").trim();
  if (!normalized) {
    return {
      match: null,
      candidates: []
    };
  }

  const shortcutIndex = parseThreadShortcutIndex(normalized);
  if (!shortcutIndex) {
    return {
      match: null,
      candidates: []
    };
  }

  const shortcutMatch = projects[shortcutIndex - 1] ?? null;
  if (shortcutMatch) {
    return {
      match: shortcutMatch,
      candidates: [shortcutMatch],
      shortcutIndex
    };
  }

  return {
    match: null,
    candidates: [],
    requestedShortcut: shortcutIndex
  };
}

function projectRunKey(phoneKey, projectAlias) {
  return `project:${phoneKey}:${projectAlias}`;
}

function btwRunKey(phoneKey) {
  return `btw:${phoneKey}`;
}

function splitPayloadTokens(value) {
  return String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function parseProjectPromptPayload(payload, config) {
  const tokens = splitPayloadTokens(payload);
  if (tokens.length < 2) {
    return null;
  }

  let ambiguousSelection = null;
  for (let prefixLength = tokens.length - 1; prefixLength >= 1; prefixLength -= 1) {
    const projectToken = tokens.slice(0, prefixLength).join(" ");
    const prompt = tokens.slice(prefixLength).join(" ");
    if (!prompt) {
      continue;
    }

    const selection = resolveConfiguredProjectSelection(config, projectToken);
    if (selection.match) {
      return {
        projectToken,
        project: selection.match,
        prompt
      };
    }

    if (!ambiguousSelection && selection.candidates.length) {
      ambiguousSelection = {
        projectToken,
        candidates: selection.candidates,
        prompt
      };
    }
  }

  if (ambiguousSelection) {
    return {
      projectToken: ambiguousSelection.projectToken,
      project: null,
      candidates: ambiguousSelection.candidates,
      prompt: ambiguousSelection.prompt
    };
  }

  const [projectToken, ...promptTokens] = tokens;
  return {
    projectToken,
    project: null,
    prompt: promptTokens.join(" ")
  };
}

export function parseApprovalTargetPayload(payload, baseDecision) {
  let decision = baseDecision;
  const targetTokens = [];

  for (const token of splitPayloadTokens(payload)) {
    if (token.toLowerCase() === "session") {
      decision = "acceptForSession";
      continue;
    }
    targetTokens.push(token);
  }

  return {
    decision,
    targetToken: targetTokens.join(" ").trim() || null
  };
}

function parseConnectPayload(payload, config) {
  const tokens = splitPayloadTokens(payload);
  if (tokens.length >= 2) {
    let ambiguousSelection = null;
    for (let prefixLength = tokens.length - 1; prefixLength >= 1; prefixLength -= 1) {
      const projectToken = tokens.slice(0, prefixLength).join(" ");
      const selector = tokens.slice(prefixLength).join(" ");
      const selection = resolveConfiguredProjectSelection(config, projectToken);
      if (selection.match) {
        return {
          projectAlias: selection.match.alias,
          selector,
          ambiguousProjects: []
        };
      }

      if (!ambiguousSelection && selection.candidates.length) {
        ambiguousSelection = {
          projectToken,
          candidates: selection.candidates,
          selector
        };
      }
    }

    if (ambiguousSelection) {
      return {
        projectAlias: null,
        selector: ambiguousSelection.selector,
        ambiguousProjectToken: ambiguousSelection.projectToken,
        ambiguousProjects: ambiguousSelection.candidates
      };
    }
  }

  return {
    projectAlias: null,
    selector: String(payload ?? "").trim(),
    ambiguousProjects: []
  };
}

function parseProjectTargetPayload(payload, config) {
  const token = String(payload ?? "").trim();
  if (!token) {
    return {
      projectAlias: null,
      targetType: "active"
    };
  }

  if (token.toLowerCase() === "btw") {
    return {
      projectAlias: null,
      targetType: "btw"
    };
  }

  const selection = resolveConfiguredProjectSelection(config, token);
  return selection.match
    ? {
        projectAlias: selection.match.alias,
        targetType: "project"
      }
    : selection.candidates.length
      ? {
          projectAlias: null,
          targetType: "ambiguous",
          candidates: selection.candidates
        }
      : {
          projectAlias: null,
          targetType: "unknown"
        };
}

function parsePermissionsPayload(payload, config) {
  const tokens = splitPayloadTokens(payload);
  if (!tokens.length) {
    return {
      projectAlias: null,
      permissionToken: "",
      confirmationToken: "",
      ambiguousProjects: []
    };
  }

  const extractPermissionToken = (permissionTokens) => {
    const limit = Math.min(permissionTokens.length, 3);
    for (let length = limit; length >= 1; length -= 1) {
      const candidate = permissionTokens.slice(0, length).join(" ");
      if (normalizePermissionLevel(candidate)) {
        return {
          permissionToken: candidate,
          confirmationToken: permissionTokens[length] ?? ""
        };
      }
    }

    return {
      permissionToken: permissionTokens[0] ?? "",
      confirmationToken: permissionTokens[1] ?? ""
    };
  };

  if (tokens.length >= 2) {
    const selection = resolveConfiguredProjectSelection(config, tokens[0]);
    if (selection.match) {
      const extracted = extractPermissionToken(tokens.slice(1));
      return {
        projectAlias: selection.match.alias,
        permissionToken: extracted.permissionToken,
        confirmationToken: extracted.confirmationToken,
        ambiguousProjects: []
      };
    }

    if (selection.candidates.length) {
      const extracted = extractPermissionToken(tokens.slice(1));
      return {
        projectAlias: null,
        permissionToken: extracted.permissionToken,
        confirmationToken: extracted.confirmationToken,
        ambiguousProjectToken: tokens[0],
        ambiguousProjects: selection.candidates
      };
    }
  }

  const extracted = extractPermissionToken(tokens);
  return {
    projectAlias: null,
    permissionToken: extracted.permissionToken,
    confirmationToken: extracted.confirmationToken,
    ambiguousProjects: []
  };
}

function formatDangerFullAccessConfirmationCommand({
  projectAlias,
  confirmationCode,
  activeProjectAlias
}) {
  const commandTokens = ["/dfa"];
  if (projectAlias !== activeProjectAlias) {
    commandTokens.push(projectAlias);
  }

  commandTokens.push(confirmationCode);
  return commandTokens.join(" ");
}

export function buildDangerFullAccessConfirmationMessage({
  projectAlias,
  confirmationCode,
  activeProjectAlias,
  windowMs = DANGER_CONFIRMATION_WINDOW_MS
}) {
  const confirmationCommand = formatDangerFullAccessConfirmationCommand({
    projectAlias,
    confirmationCode,
    activeProjectAlias
  });
  const minutes = Math.max(1, Math.round(windowMs / 60_000));
  const windowLabel = minutes === 1 ? "1 minute" : `${minutes} minutes`;

  return [
    `Danger full access for ${projectAlias} disables sandboxing and approval prompts.`,
    `Reply ${confirmationCommand} within ${windowLabel}.`
  ].join("\n");
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

  getChatSession(phoneKey) {
    return this.stateStore.getSession(phoneKey);
  }

  getActiveProject(phoneKey) {
    const chatSession = this.getChatSession(phoneKey);
    return resolveConfiguredProject(this.configStore.data, chatSession.activeProject);
  }

  getProjectSession(phoneKey, projectAlias = null) {
    const chatSession = this.getChatSession(phoneKey);
    const resolvedProject =
      projectAlias !== null
        ? resolveConfiguredProject(this.configStore.data, projectAlias)
        : this.getActiveProject(phoneKey);
    return {
      chatSession,
      project: resolvedProject,
      session:
        chatSession.projects?.[resolvedProject.alias] ?? defaultProjectSession()
    };
  }

  async upsertChatSession(phoneKey, partial = {}) {
    const current = this.getChatSession(phoneKey);
    await this.stateStore.upsertSession(phoneKey, {
      ...current,
      ...partial,
      phoneKey
    });
  }

  async upsertProjectSession(phoneKey, projectAlias, { chatPatch = {}, projectPatch = {} } = {}) {
    const current = this.getChatSession(phoneKey);
    const next = {
      ...current,
      ...chatPatch,
      phoneKey,
      projects: {
        ...current.projects,
        [projectAlias]: {
          ...(current.projects?.[projectAlias] ?? defaultProjectSession()),
          ...projectPatch
        }
      }
    };
    await this.stateStore.upsertSession(phoneKey, next);
  }

  async resetProjectSession(phoneKey, projectAlias, chatPatch = {}) {
    await this.upsertProjectSession(phoneKey, projectAlias, {
      chatPatch,
      projectPatch: defaultProjectSession()
    });
  }

  projectRun(phoneKey, projectAlias) {
    return this.activeRuns.get(projectRunKey(phoneKey, projectAlias));
  }

  btwRun(phoneKey) {
    return this.activeRuns.get(btwRunKey(phoneKey));
  }

  activeProjectRuns(phoneKey) {
    const chatSession = this.getChatSession(phoneKey);
    return Object.keys(chatSession.projects ?? {})
      .map((projectAlias) => {
        const run = this.projectRun(phoneKey, projectAlias);
        return run
          ? {
              projectAlias,
              run
            }
          : null;
      })
      .filter(Boolean);
  }

  getQueuedPrompts(phoneKey, { scopeType = "project", projectAlias = null } = {}) {
    const chatSession = this.getChatSession(phoneKey);
    if (scopeType === "btw") {
      return [...(chatSession.btw?.queuedPrompts ?? [])];
    }

    const project = resolveConfiguredProject(
      this.configStore.data,
      projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    return [...(chatSession.projects?.[project.alias]?.queuedPrompts ?? [])];
  }

  queuedPromptCount(phoneKey, options = {}) {
    return this.getQueuedPrompts(phoneKey, options).length;
  }

  async enqueueQueuedPrompt({
    phoneKey,
    remoteJid,
    label,
    scopeType = "project",
    projectAlias = null,
    prompt,
    forceNewThread = false,
    voiceReplyOverride = null
  }) {
    const trimmedPrompt = String(prompt ?? "").trim();
    if (!trimmedPrompt) {
      return 0;
    }

    const queuedPrompt = {
      prompt: trimmedPrompt,
      forceNewThread,
      queuedAt: new Date().toISOString(),
      voiceReplyOverride:
        voiceReplyOverride?.enabled
          ? {
              enabled: true,
              speed: voiceReplyOverride.speed ?? null
            }
          : null
    };
    const chatSession = this.getChatSession(phoneKey);

    if (scopeType === "btw") {
      const nextQueue = [...(chatSession.btw?.queuedPrompts ?? []), queuedPrompt];
      await this.upsertChatSession(phoneKey, {
        phoneKey,
        remoteJid,
        label,
        btw: {
          ...(chatSession.btw ?? {}),
          lastUsedAt: new Date().toISOString(),
          queuedPrompts: nextQueue
        }
      });
      return nextQueue.length;
    }

    const project = resolveConfiguredProject(
      this.configStore.data,
      projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const projectSession = chatSession.projects?.[project.alias] ?? defaultProjectSession();
    const nextQueue = [...(projectSession.queuedPrompts ?? []), queuedPrompt];
    await this.upsertProjectSession(phoneKey, project.alias, {
      chatPatch: {
        phoneKey,
        remoteJid,
        label
      },
      projectPatch: {
        queuedPrompts: nextQueue
      }
    });
    return nextQueue.length;
  }

  async dequeueQueuedPrompt(phoneKey, { scopeType = "project", projectAlias = null } = {}) {
    const chatSession = this.getChatSession(phoneKey);
    if (scopeType === "btw") {
      const queuedPrompts = [...(chatSession.btw?.queuedPrompts ?? [])];
      const nextPrompt = queuedPrompts.shift() ?? null;
      if (!nextPrompt) {
        return null;
      }

      await this.upsertChatSession(phoneKey, {
        phoneKey,
        btw: {
          ...(chatSession.btw ?? {}),
          queuedPrompts
        }
      });
      return nextPrompt;
    }

    const project = resolveConfiguredProject(
      this.configStore.data,
      projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const projectSession = chatSession.projects?.[project.alias] ?? defaultProjectSession();
    const queuedPrompts = [...(projectSession.queuedPrompts ?? [])];
    const nextPrompt = queuedPrompts.shift() ?? null;
    if (!nextPrompt) {
      return null;
    }

    await this.upsertProjectSession(phoneKey, project.alias, {
      projectPatch: {
        queuedPrompts
      }
    });
    return nextPrompt;
  }

  async clearQueuedPrompts(phoneKey, { scopeType = "project", projectAlias = null } = {}) {
    const chatSession = this.getChatSession(phoneKey);
    if (scopeType === "btw") {
      const queuedCount = (chatSession.btw?.queuedPrompts ?? []).length;
      if (!queuedCount) {
        return 0;
      }

      await this.upsertChatSession(phoneKey, {
        phoneKey,
        btw: {
          ...(chatSession.btw ?? {}),
          queuedPrompts: []
        }
      });
      return queuedCount;
    }

    const project = resolveConfiguredProject(
      this.configStore.data,
      projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const queuedCount = (chatSession.projects?.[project.alias]?.queuedPrompts ?? []).length;
    if (!queuedCount) {
      return 0;
    }

    await this.upsertProjectSession(phoneKey, project.alias, {
      projectPatch: {
        queuedPrompts: []
      }
    });
    return queuedCount;
  }

  async queuePromptIfBusy({
    phoneKey,
    remoteJid,
    label,
    scopeType = "project",
    projectAlias = null,
    prompt,
    forceNewThread = false,
    voiceReplyOverride = null,
    statusPrelude = null
  }) {
    const project = resolveConfiguredProject(
      this.configStore.data,
      projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const activeRun =
      scopeType === "btw"
        ? this.btwRun(phoneKey)
        : this.projectRun(phoneKey, project.alias);
    if (!activeRun) {
      return false;
    }

    const queuedCount = await this.enqueueQueuedPrompt({
      phoneKey,
      remoteJid,
      label,
      scopeType,
      projectAlias: project.alias,
      prompt,
      forceNewThread,
      voiceReplyOverride
    });
    await this.sendReply(
      remoteJid,
      joinMessageSections(
        statusPrelude,
        scopeType === "btw"
          ? "Queued your next btw message. I will read it as soon as the current task finishes."
          : `Queued your next message for project ${project.alias}. I will read it as soon as the current task finishes.`,
        activeRun.pendingApproval
          ? "The current run is still waiting on approval."
          : null,
        queuedCount > 1 ? `Queue depth for this scope: ${queuedCount}.` : null
      )
    );
    return true;
  }

  async runNextQueuedPrompt({
    phoneKey,
    remoteJid,
    label,
    scopeType = "project",
    projectAlias = null
  }) {
    const project = resolveConfiguredProject(
      this.configStore.data,
      projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const queuedPrompt = await this.dequeueQueuedPrompt(phoneKey, {
      scopeType,
      projectAlias: project.alias
    });
    if (!queuedPrompt) {
      return false;
    }

    await this.runPrompt({
      phoneKey,
      remoteJid,
      prompt: queuedPrompt.prompt,
      forceNewThread: Boolean(queuedPrompt.forceNewThread),
      label,
      scopeType,
      projectAlias: project.alias,
      voiceReplyOverride: queuedPrompt.voiceReplyOverride ?? null,
      statusPrelude:
        scopeType === "btw"
          ? "Running your queued btw follow-up now."
          : `Running your queued follow-up in ${project.alias} now.`
    });
    return true;
  }

  async ensureProject(spec, { phoneKey = null } = {}) {
    const config = await this.configStore.load();
    const explicitProject = resolveExplicitConfiguredProject(config, spec);
    if (explicitProject) {
      return {
        project: explicitProject,
        created: false
      };
    }

    let intentSelection = null;
    if (Array.isArray(config.projects) && config.projects.length) {
      try {
        const activeProject =
          phoneKey !== null ? this.getActiveProject(phoneKey) : resolveConfiguredProject(config);
        intentSelection = await classifyProjectIntentWithCodex({
          codexBin: config.codexBin,
          workspace: activeProject?.workspace ?? config.workspace,
          intent: spec,
          activeProjectAlias: activeProject?.alias ?? null,
          projects: config.projects
        });
      } catch {
        intentSelection = null;
      }
    }

    if (intentSelection?.outcome === "match") {
      return {
        project: resolveConfiguredProject(config, intentSelection.projectAlias),
        created: false
      };
    }

    if (intentSelection?.outcome === "ambiguous") {
      return {
        error: renderAmbiguousProjectSelectionMessage(
          spec,
          intentSelection.candidateAliases
            .map((alias) => resolveConfiguredProject(config, alias))
            .filter(Boolean)
        )
      };
    }

    const resolved = await resolveProjectReference(config, spec, {
      skipConfiguredSelection: Boolean(intentSelection)
    });
    if (!resolved) {
      return {
        error: `No configured project or local directory matched "${spec}".`
      };
    }

    if (resolved.matchType === "ambiguousConfigured") {
      return {
        error: renderAmbiguousProjectSelectionMessage(spec, resolved.candidates)
      };
    }

    if (resolved.matchType === "ambiguous") {
      return {
        error: [
          `Multiple directories matched "${spec}":`,
          "",
          ...resolved.candidates.map((candidate) => `- ${candidate}`),
          "",
          "Use /project with a clearer path or alias."
        ].join("\n")
      };
    }

    if (!resolved.created) {
      return {
        project: resolved.project,
        created: false
      };
    }

    const updatedConfig = await this.configStore.update({
      projects: [...config.projects, resolved.project]
    });

    return {
      project: resolveConfiguredProject(updatedConfig, resolved.project.alias),
      created: true
    };
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

    for (const [runKey, run] of this.activeRuns.entries()) {
      await run.interrupt().catch(() => {
        if (!run.child.killed) {
          run.child.kill("SIGTERM");
        }
      });
      this.activeRuns.delete(runKey);
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
    const sessions = this.stateStore.listSessions().map((session) => {
      const activeProjectAlias = session.activeProject ?? this.configStore.data.defaultProject;
      const activeProjectSession =
        session.projects?.[activeProjectAlias] ?? defaultProjectSession();
      const activeRun = this.projectRun(session.phoneKey, activeProjectAlias);
      return {
        phoneKey: session.phoneKey,
        label: session.label ?? null,
        activeProject: activeProjectAlias,
        threadId: activeProjectSession.threadId ?? null,
        busy:
          this.activeProjectRuns(session.phoneKey).length > 0 ||
          Boolean(this.btwRun(session.phoneKey)),
        runStatus: activeRun?.status ?? null,
        runPreview: activeRun?.progressPreview ?? null,
        runLastEventAt: activeRun?.lastEventAt ?? null,
        permissionLevel:
          activeProjectSession.permissionLevel ?? this.configStore.data.permissionLevel,
        projects: Object.entries(session.projects ?? {}).map(([alias, projectSession]) => {
          const run = this.projectRun(session.phoneKey, alias);
          return {
            alias,
            threadId: projectSession.threadId ?? null,
            busy: Boolean(run),
            runStatus: run?.status ?? null,
            runPreview: run?.progressPreview ?? null
          };
        }),
        lastPromptAt: activeProjectSession.lastPromptAt ?? null,
        lastReplyAt: activeProjectSession.lastReplyAt ?? null
      };
    });

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
    const chatSession = this.getChatSession(phoneKey);
    const activeProject = resolveConfiguredProject(
      config,
      chatSession.activeProject ?? config.defaultProject
    );
    const label = controller.label ?? message.pushName ?? null;

    await this.upsertChatSession(phoneKey, {
      phoneKey,
      remoteJid,
      label,
      activeProject: activeProject.alias,
      lastInboundAt: new Date().toISOString(),
      lastInboundText:
        text ||
        (audioMessage ? "[voice note]" : `[${message.key?.id ?? "message"}]`),
      lastInboundType: audioMessage ? "voice" : messageType
    });

    let command = null;
    let voiceTranscriptReply = null;

    if (text) {
      command = parseIncomingCommand(text, config.captureAllDirectMessages);
    } else if (audioMessage) {
      try {
        const audioBuffer = await this.runtime.downloadMediaBuffer(message);
        const transcription = await transcribeVoiceNote({
          audioBuffer,
          mimeType: audioMessage.mimetype ?? "audio/ogg"
        });
        text = transcription.transcript;

        await this.upsertChatSession(phoneKey, {
          ...(this.getChatSession(phoneKey) ?? chatSession),
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

        voiceTranscriptReply = formatVoiceTranscriptReply(transcription);
        if (shouldRetryVoiceTranscript(transcription)) {
          await this.sendReply(
            remoteJid,
            joinMessageSections(
              voiceTranscriptReply,
              "That voice note looks uncertain. Please try again with a longer note or type the command."
            )
          );
          return;
        }
        command = parseVoiceTranscript(text, config.captureAllDirectMessages);
        if (
          command.type === "ignored" ||
          (command.type === "prompt" && !command.voiceReply)
        ) {
          try {
            const classified = await classifyVoiceCommandIntent({
              codexBin: config.codexBin,
              workspace: activeProject.workspace,
              transcript: text,
              activeProjectAlias: activeProject.alias,
              projects: config.projects
            });
            command = normalizeVoiceCommandIntent(
              classified,
              text,
              config.captureAllDirectMessages
            );
          } catch {
            // Fall back to the local parser result when classification fails.
          }
        }
      } catch (error) {
        await this.upsertProjectSession(phoneKey, activeProject.alias, {
          chatPatch: {
            phoneKey,
            remoteJid,
            label
          },
          projectPatch: {
            lastErrorAt: new Date().toISOString(),
            lastError: `Voice transcription failed: ${error.message}`
          }
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

    if (voiceTranscriptReply) {
      if (shouldSplitCompoundVoiceControlRequest(text)) {
        await this.sendReply(
          remoteJid,
          joinMessageSections(
            voiceTranscriptReply,
            "That sounds like more than one action. Please split it into one step at a time, for example switch projects first, then send the next request."
          )
        );
        return;
      }

      const promptText =
        command.type === "prompt"
          ? command.prompt
          : command.type === "btw"
            ? command.prompt
            : command.type === "new"
              ? command.prompt
              : command.type === "projectPrompt"
                ? command.payload
                : "";

      if (requiresTextConfirmationForVoicePrompt(promptText)) {
        await this.sendReply(
          remoteJid,
          formatHighImpactVoicePromptWarning(voiceTranscriptReply)
        );
        return;
      }

      const defersTranscriptReply =
        command.type === "prompt" ||
        command.type === "btw" ||
        command.type === "projectPrompt" ||
        (command.type === "new" && Boolean(command.prompt));

      if (!defersTranscriptReply) {
        await this.sendReply(remoteJid, voiceTranscriptReply);
      }
    }

    switch (command.type) {
      case "empty":
      case "ignored":
        return;
      case "help":
        await this.sendReply(remoteJid, helpText());
        return;
      case "projects":
        await this.sendProjectList(phoneKey, remoteJid);
        return;
      case "project":
        await this.handleProjectCommand({
          phoneKey,
          remoteJid,
          payload: command.payload,
          label
        });
        return;
      case "unknown":
        await this.sendReply(
          remoteJid,
          `Unknown command.\n\n${helpText()}`
        );
        return;
      case "status":
        await this.sendReply(remoteJid, this.renderSessionStatus(phoneKey, command.payload));
        return;
      case "stop":
        await this.stopActiveRun(phoneKey, remoteJid, command.payload);
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
          const activeRun = this.projectRun(phoneKey, activeProject.alias);
          if (activeRun) {
            if (command.prompt) {
              await this.queuePromptIfBusy({
                phoneKey,
                remoteJid,
                label,
                scopeType: "project",
                projectAlias: activeProject.alias,
                prompt: command.prompt,
                forceNewThread: true,
                voiceReplyOverride: command.voiceReply ?? null,
                statusPrelude: voiceTranscriptReply
              });
              return;
            }
            await this.sendReply(
              remoteJid,
              `Wait for the active Codex run in ${activeProject.alias} to finish or send /stop ${activeProject.alias} before resetting that project.`
            );
            return;
          }
          await this.resetProjectSession(phoneKey, activeProject.alias, {
            phoneKey,
            remoteJid,
            label,
            activeProject: activeProject.alias
          });
        }
        if (command.prompt) {
          await this.runPrompt({
            phoneKey,
            remoteJid,
            prompt: command.prompt,
            forceNewThread: true,
            label,
            scopeType: "project",
            projectAlias: activeProject.alias,
            voiceReplyOverride: command.voiceReply ?? null,
            statusPrelude: voiceTranscriptReply
          });
        } else {
          await this.sendReply(
            remoteJid,
            `Started a fresh Codex session in project ${activeProject.alias}. Send the next message when you want me to do something.`
          );
        }
        return;
      case "newProjectSession":
        await this.handleNewProjectSessionCommand({
          phoneKey,
          remoteJid,
          target: command.target,
          label
        });
        return;
      case "projectPrompt":
        {
          const parsed = parseProjectPromptPayload(command.payload, config);
          if (!parsed) {
            await this.sendReply(
              remoteJid,
              "Usage: /in <project> <prompt>"
            );
            return;
          }

          if (parsed.candidates?.length) {
            await this.sendReply(
              remoteJid,
              renderAmbiguousProjectSelectionMessage(parsed.projectToken, parsed.candidates)
            );
            return;
          }

          const targetProject = parsed.project;
          if (!targetProject) {
            await this.sendReply(
              remoteJid,
              `Project "${parsed.projectToken}" is not configured yet. Use /project ${parsed.projectToken} first.`
            );
            return;
          }

          if (
            await this.queuePromptIfBusy({
              phoneKey,
              remoteJid,
              label,
              scopeType: "project",
              projectAlias: targetProject.alias,
              prompt: parsed.prompt,
              forceNewThread: false,
              voiceReplyOverride: command.voiceReply ?? null,
              statusPrelude: voiceTranscriptReply
            })
          ) {
            return;
          }

          await this.runPrompt({
            phoneKey,
            remoteJid,
            prompt: parsed.prompt,
            forceNewThread: false,
            label,
            scopeType: "project",
            projectAlias: targetProject.alias,
            voiceReplyOverride: command.voiceReply ?? null,
            statusPrelude: voiceTranscriptReply
          });
        }
        return;
      case "btw":
        if (
          await this.queuePromptIfBusy({
            phoneKey,
            remoteJid,
            label,
            scopeType: "btw",
            projectAlias: activeProject.alias,
            prompt: command.prompt,
            forceNewThread: true,
            voiceReplyOverride: command.voiceReply ?? null,
            statusPrelude: voiceTranscriptReply
          })
        ) {
          return;
        }
        await this.runPrompt({
          phoneKey,
          remoteJid,
          prompt: command.prompt,
          forceNewThread: true,
          label,
          scopeType: "btw",
          projectAlias: activeProject.alias,
          voiceReplyOverride: command.voiceReply ?? null,
          statusPrelude: voiceTranscriptReply
        });
        return;
      case "sessions":
        await this.sendThreadList(phoneKey, remoteJid, command.payload);
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
        await this.handleApprovalDecision(phoneKey, remoteJid, command.decision, command.payload);
        return;
      case "prompt":
        if (
          await this.queuePromptIfBusy({
            phoneKey,
            remoteJid,
            label,
            scopeType: "project",
            projectAlias: activeProject.alias,
            prompt: command.prompt,
            forceNewThread: false,
            voiceReplyOverride: command.voiceReply ?? null,
            statusPrelude: voiceTranscriptReply
          })
        ) {
          return;
        }
        await this.runPrompt({
          phoneKey,
          remoteJid,
          prompt: command.prompt,
          forceNewThread: false,
          label,
          scopeType: "project",
          projectAlias: activeProject.alias,
          voiceReplyOverride: command.voiceReply ?? null,
          statusPrelude: voiceTranscriptReply
        });
        return;
      default:
        return;
    }
  }

  async sendProjectList(phoneKey, remoteJid) {
    await this.sendReply(remoteJid, this.renderProjectList(phoneKey));
  }

  renderProjectList(phoneKey) {
    const config = this.configStore.data;
    const chatSession = this.getChatSession(phoneKey);
    const activeProject = this.getActiveProject(phoneKey);
    const lines = [
      "Projects:",
      "",
      ...config.projects.flatMap((project, index) => {
        const projectSession = chatSession.projects?.[project.alias] ?? defaultProjectSession();
        const run = this.projectRun(phoneKey, project.alias);
        const permissionLevel = resolveSessionPermissionLevel(
          config,
          project,
          projectSession
        );
        return summarizeProjectChoice(project, projectSession, run, permissionLevel, {
          activeProjectAlias: activeProject.alias,
          index: index + 1
        });
      }).filter(Boolean),
      "",
      "Quick switch: /project 1, /project 2, ...",
      ...projectHelpFooter()
    ];

    if (this.btwRun(phoneKey)) {
      lines.push("", "- btw (busy)");
    }

    return lines.join("\n");
  }

  async handleProjectCommand({ phoneKey, remoteJid, payload, label }) {
    const spec = String(payload ?? "").trim();
    if (!spec) {
      const activeProject = this.getActiveProject(phoneKey);
      const { session } = this.getProjectSession(phoneKey, activeProject.alias);
      const permissionLevel = resolveSessionPermissionLevel(
        this.configStore.data,
        activeProject,
        session
      );
      await this.sendReply(
        remoteJid,
        [
          `You are in project ${activeProject.alias}.`,
          `session: ${shortThreadId(session.threadId ?? null)}`,
          `permissions: ${permissionLevel}`,
          "",
          this.renderProjectList(phoneKey),
          "",
          "Next: send a normal message to continue, /new to reset, /ls to browse sessions."
        ].join("\n")
      );
      return;
    }

    const shortcutResolution = resolveProjectSelection(this.configStore.data.projects, spec);
    if (shortcutResolution.requestedShortcut) {
      await this.sendReply(
        remoteJid,
        [
          `No configured project matched shortcut ${formatProjectShortcut(shortcutResolution.requestedShortcut)}.`,
          [
            "Use /project or /projects to inspect available shortcuts,",
            "or /project <path hint> to add another repo."
          ].join(" ")
        ].join("\n")
      );
      return;
    }

    const ensured = shortcutResolution.match
      ? {
          project: shortcutResolution.match,
          created: false,
          shortcutIndex: shortcutResolution.shortcutIndex
        }
      : await this.ensureProject(spec, { phoneKey });
    if (ensured.error) {
      await this.sendReply(remoteJid, ensured.error);
      return;
    }

    const project = ensured.project;
    const { session } = this.getProjectSession(phoneKey, project.alias);
    const permissionLevel = resolveSessionPermissionLevel(this.configStore.data, project, session);
    await this.upsertChatSession(phoneKey, {
      phoneKey,
      remoteJid,
      label,
      activeProject: project.alias
    });

    await this.sendReply(
      remoteJid,
      [
        ensured.created
          ? `Added project ${project.alias} and switched this chat to it.`
          : ensured.shortcutIndex
            ? `Switched this chat to project ${project.alias} via ${formatProjectShortcut(
                ensured.shortcutIndex
              )}.`
            : `Switched this chat to project ${project.alias}.`,
        `session: ${shortThreadId(session.threadId ?? null)}`,
        `permissions: ${permissionLevel}`,
        "",
        session.threadId
          ? "Next: send a normal message to continue here, or /new to start fresh."
          : "Next: send a normal message to start here, or /new to force a fresh session.",
        `One-off elsewhere: /in ${project.alias} <prompt>`
      ].join("\n")
    );
  }

  async handleNewProjectSessionCommand({ phoneKey, remoteJid, target, label }) {
    const ensured = await this.ensureProject(target, { phoneKey });
    if (ensured.error) {
      await this.sendReply(remoteJid, ensured.error);
      return;
    }

    const project = ensured.project;
    const activeRun = this.projectRun(phoneKey, project.alias);
    if (activeRun) {
      await this.sendReply(
        remoteJid,
        `Wait for the active Codex run in ${project.alias} to finish or send /stop ${project.alias} before resetting that project.`
      );
      return;
    }
    await this.resetProjectSession(phoneKey, project.alias, {
      phoneKey,
      remoteJid,
      label,
      activeProject: project.alias
    });

    await this.sendReply(
      remoteJid,
      [
        ensured.created
          ? `Added project ${project.alias} and reset it for a fresh session.`
          : `Reset project ${project.alias} for a fresh session.`,
        "",
        "Next: your next normal message here will start a new Codex thread in that project."
      ].join("\n")
    );
  }

  renderSessionStatus(phoneKey, payload = "") {
    const config = this.configStore.data;
    const chatSession = this.getChatSession(phoneKey);
    const activeProject = this.getActiveProject(phoneKey);
    const voiceReply = resolveSessionVoiceReply(chatSession);
    const target = parseProjectTargetPayload(payload, config);

    if (target.targetType === "ambiguous") {
      return renderAmbiguousProjectSelectionMessage(payload, target.candidates);
    }

    if (target.targetType === "unknown") {
      return `Unknown project "${String(payload).trim()}". Use /projects to inspect available aliases.`;
    }

    if (target.targetType === "btw") {
      const btw = this.btwRun(phoneKey);
      return [
        "WhatsApp Codex bridge",
        `active_project: ${activeProject.alias}`,
        "target: btw",
        `busy: ${btw ? "yes" : "no"}`,
        `queued_messages: ${this.queuedPromptCount(phoneKey, { scopeType: "btw" })}`,
        `voice_reply: ${formatVoiceReplySummary(voiceReply)}`,
        ...buildActiveRunStatusLines(btw),
        btw?.pendingApproval ? `approval_pending: yes (${btw.pendingApproval.kind})` : null
      ]
        .filter(Boolean)
        .join("\n");
    }

    const project = resolveConfiguredProject(config, target.projectAlias ?? activeProject.alias);
    const projectSession = chatSession.projects?.[project.alias] ?? defaultProjectSession();
    const activeRun = this.projectRun(phoneKey, project.alias);
    const permissionLevel = resolveSessionPermissionLevel(config, project, projectSession);
    const pendingConfirmation =
      isConfirmationFresh(projectSession) && projectSession.pendingPermissionConfirmation
        ? projectSession.pendingPermissionConfirmation
        : null;
    const busyProjects = Object.keys(chatSession.projects ?? {}).filter((alias) =>
      Boolean(this.projectRun(phoneKey, alias))
    );

    return [
      "WhatsApp Codex bridge",
      `active_project: ${activeProject.alias}`,
      `project: ${project.alias}`,
      `session: ${shortThreadId(projectSession.threadId ?? null)}`,
      `busy: ${activeRun ? "yes" : "no"}`,
      `queued_messages: ${this.queuedPromptCount(phoneKey, {
        scopeType: "project",
        projectAlias: project.alias
      })}`,
      `permissions: ${permissionLevel}`,
      `voice_reply: ${formatVoiceReplySummary(voiceReply)}`,
      `voice_reply_provider: ${resolveConfiguredTtsProvider(config)}`,
      busyProjects.length ? `busy_projects: ${busyProjects.join(", ")}` : null,
      this.btwRun(phoneKey) ? "btw_busy: yes" : null,
      ...buildActiveRunStatusLines(activeRun),
      activeRun?.pendingApproval ? `approval_pending: yes (${activeRun.pendingApproval.kind})` : null,
      pendingConfirmation
        ? `danger_full_access_confirmation: pending until ${pendingConfirmation.expiresAt}`
        : null,
      projectSession.lastPromptAt ? `last_prompt_at: ${projectSession.lastPromptAt}` : null,
      projectSession.lastReplyAt ? `last_reply_at: ${projectSession.lastReplyAt}` : null,
      "",
      "Commands: /project, /in, /btw, /n, /ls, /session, /p, /ro, /ww, /dfa, /voice, /x, /h"
    ]
      .filter(Boolean)
      .join("\n");
  }

  async sendThreadList(phoneKey, remoteJid, payload = "") {
    const config = this.configStore.data;
    const target = parseProjectTargetPayload(payload, config);
    if (target.targetType === "ambiguous") {
      await this.sendReply(
        remoteJid,
        renderAmbiguousProjectSelectionMessage(payload, target.candidates)
      );
      return;
    }

    if (target.targetType === "unknown" || target.targetType === "btw") {
      await this.sendReply(
        remoteJid,
        `Unknown project "${String(payload).trim()}". Use /projects to inspect available aliases.`
      );
      return;
    }

    const project = resolveConfiguredProject(
      config,
      target.projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const { session } = this.getProjectSession(phoneKey, project.alias);
    const threads = await listCodexThreads({
      codexBin: config.codexBin,
      workspace: project.workspace,
      model: project.model ?? config.model,
      profile: project.profile ?? config.profile,
      search: project.search ?? config.search,
      limit: SESSION_LIST_LIMIT
    });

    if (!threads.length) {
      await this.sendReply(remoteJid, "No Codex threads were found.");
      return;
    }

    await this.upsertProjectSession(phoneKey, project.alias, {
      projectPatch: {
        lastThreadChoices: threads.map((thread) => ({
          id: thread.id,
          name: thread.name ?? null,
          preview: sanitizeThreadPreview(thread.preview),
          updatedAt: thread.updatedAt ?? null
        })),
        lastThreadChoicesAt: new Date().toISOString()
      }
    });

    const lines = [
      `Recent Codex sessions for ${project.alias}:`,
      "",
      ...threads.map((thread, index) =>
        summarizeThreadChoice(thread, session.threadId ?? null, index + 1)
      ),
      "",
      "Use /1, /2, ..., /session <number>, or /connect <thread-id-prefix> to switch this chat.",
      `You can also jump directly with /session ${project.alias} <number>.`
    ];
    await this.sendReply(remoteJid, lines.join("\n"));
  }

  async connectToThread({ phoneKey, remoteJid, payload, label }) {
    const config = this.configStore.data;
    const parsed = parseConnectPayload(payload, config);
    if (parsed.ambiguousProjects?.length) {
      await this.sendReply(
        remoteJid,
        renderAmbiguousProjectSelectionMessage(
          parsed.ambiguousProjectToken,
          parsed.ambiguousProjects
        )
      );
      return;
    }

    const project = resolveConfiguredProject(
      config,
      parsed.projectAlias ?? this.getActiveProject(phoneKey).alias
    );
    const active = this.projectRun(phoneKey, project.alias);
    if (active) {
      await this.sendReply(
        remoteJid,
        `Wait for the active Codex run in ${project.alias} to finish or send /stop ${project.alias} before switching sessions.`
      );
      return;
    }

    const token = String(parsed.selector ?? "").trim();
    if (!token) {
      await this.sendReply(
        remoteJid,
        "Usage: /session <number|thread-id-prefix>\n/session <project> <number|thread-id-prefix>\n\nUse /sessions to list recent Codex threads first."
      );
      return;
    }

    const threads = await listCodexThreads({
      codexBin: config.codexBin,
      workspace: project.workspace,
      model: project.model ?? config.model,
      profile: project.profile ?? config.profile,
      search: project.search ?? config.search,
      limit: SESSION_CONNECT_SEARCH_LIMIT
    });
    const { session } = this.getProjectSession(phoneKey, project.alias);
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

    await this.upsertProjectSession(phoneKey, project.alias, {
      chatPatch: {
        phoneKey,
        remoteJid,
        label
      },
      projectPatch: {
        threadId: resolution.match.id,
        connectedThreadAt: new Date().toISOString(),
        connectedThreadName: resolution.match.name ?? null
      }
    });

    await this.sendReply(
      remoteJid,
      [
        `Switched ${project.alias} to session ${shortThreadId(resolution.match.id)}.`,
        resolution.match.name ? `name: ${resolution.match.name}` : null,
        sanitizeThreadPreview(resolution.match.preview)
          ? `preview: ${sanitizeThreadPreview(resolution.match.preview)}`
          : null,
        "",
        "Next: send a normal message to continue in that session."
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  async handleVoiceReplyCommand({ phoneKey, remoteJid, payload, label }) {
    const activeCount =
      this.activeProjectRuns(phoneKey).length + (this.btwRun(phoneKey) ? 1 : 0);
    if (activeCount) {
      await this.sendReply(
        remoteJid,
        "Wait for the active Codex run to finish or send /stop before changing voice reply mode."
      );
      return;
    }

    const session = this.getChatSession(phoneKey);
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
      await this.upsertChatSession(phoneKey, {
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
      await this.upsertChatSession(phoneKey, {
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
    const config = this.configStore.data;
    const activeProject = this.getActiveProject(phoneKey);
    const parsed = parsePermissionsPayload(payload, config);
    if (parsed.ambiguousProjects?.length) {
      await this.sendReply(
        remoteJid,
        renderAmbiguousProjectSelectionMessage(
          parsed.ambiguousProjectToken,
          parsed.ambiguousProjects
        )
      );
      return;
    }

    const project = resolveConfiguredProject(
      config,
      parsed.projectAlias ?? activeProject.alias
    );
    const active = this.projectRun(phoneKey, project.alias);
    if (active) {
      await this.sendReply(
        remoteJid,
        `Wait for the active Codex run in ${project.alias} to finish or send /stop ${project.alias} before changing permissions.`
      );
      return;
    }

    const { session } = this.getProjectSession(phoneKey, project.alias);
    const currentLevel = resolveSessionPermissionLevel(config, project, session);
    const trimmedPayload = String(payload ?? "").trim();

    if (!trimmedPayload) {
      await this.sendReply(
        remoteJid,
        [
          `Project: ${project.alias}`,
          `Current permissions: ${formatPermissionSummary(currentLevel)}`,
          "",
          ...permissionLevelHelpList().map(
            ({ level, description, dangerous }) =>
              `- ${level}${dangerous ? " (explicit confirmation required)" : ""}: ${description}`
          ),
          "",
          "Quick shortcuts for the active project: /ro, /ww, /dfa",
          "Target another project with /p <project> <level>."
        ].join("\n")
      );
      return;
    }

    const requestedToken = parsed.permissionToken;
    const confirmationToken = parsed.confirmationToken;
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
      await this.upsertProjectSession(phoneKey, project.alias, {
        chatPatch: {
          phoneKey,
          remoteJid,
          label
        },
        projectPatch: {
          permissionLevel: requestedLevel,
          pendingPermissionConfirmation: null
        }
      });

      await this.sendReply(
        remoteJid,
        [
          `Permissions for project ${project.alias} are now ${requestedLevel}.`,
          project.alias === activeProject.alias
            ? "This is now the default for your normal messages in this chat."
            : `Your active project is still ${activeProject.alias}.`
        ].join("\n")
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
      await this.upsertProjectSession(phoneKey, project.alias, {
        chatPatch: {
          phoneKey,
          remoteJid,
          label
        },
        projectPatch: {
          permissionLevel: requestedLevel,
          pendingPermissionConfirmation: null
        }
      });

      await this.sendReply(
        remoteJid,
        [
          `Permissions for project ${project.alias} are now ${requestedLevel}.`,
          "Sandboxing and approval prompts are disabled until you lower permissions or start a fresh session with /new."
        ].join("\n")
      );
      return;
    }

    const code = String(randomInt(100000, 1_000_000));
    const expiresAt = new Date(Date.now() + DANGER_CONFIRMATION_WINDOW_MS).toISOString();
    await this.upsertProjectSession(phoneKey, project.alias, {
      chatPatch: {
        phoneKey,
        remoteJid,
        label
      },
      projectPatch: {
        pendingPermissionConfirmation: {
          code,
          expiresAt,
          requestedLevel
        }
      }
    });

    await this.sendReply(
      remoteJid,
      buildDangerFullAccessConfirmationMessage({
        projectAlias: project.alias,
        confirmationCode: code,
        activeProjectAlias: activeProject.alias
      })
    );
  }

  async handleApprovalDecision(phoneKey, remoteJid, baseDecision, payload = "") {
    const config = this.configStore.data;
    const parsed = parseApprovalTargetPayload(payload, baseDecision);
    const target = parseProjectTargetPayload(parsed.targetToken, config);

    if (target.targetType === "ambiguous") {
      await this.sendReply(
        remoteJid,
        renderAmbiguousProjectSelectionMessage(parsed.targetToken, target.candidates)
      );
      return;
    }

    if (target.targetType === "unknown") {
      await this.sendReply(
        remoteJid,
        `Unknown project "${parsed.targetToken}". Use /projects to inspect available aliases.`
      );
      return;
    }

    const project =
      target.targetType === "project"
        ? resolveConfiguredProject(config, target.projectAlias)
        : this.getActiveProject(phoneKey);
    const active =
      target.targetType === "btw"
        ? this.btwRun(phoneKey)
        : this.projectRun(phoneKey, project.alias);

    if (!active?.pendingApproval) {
      await this.sendReply(
        remoteJid,
        target.targetType === "btw"
          ? "No approval is pending for btw."
          : `No approval is pending for project ${project.alias}.`
      );
      return;
    }

    const pendingApproval = active.pendingApproval;
    const availableDecisions = pendingApproval.availableDecisions ?? null;
    let nextDecision = parsed.decision;

    if (Array.isArray(availableDecisions) && !availableDecisions.includes(nextDecision)) {
      if (nextDecision === "acceptForSession" && availableDecisions.includes("accept")) {
        nextDecision = "accept";
      } else {
        await this.sendReply(
          remoteJid,
          `This approval does not support ${nextDecision}. Available decisions: ${availableDecisions.join(", ")}.`
        );
        return;
      }
    }

    try {
      await active.answerApproval(pendingApproval.requestId, nextDecision);
      active.pendingApproval = null;
      if (target.targetType !== "btw") {
        await this.upsertProjectSession(phoneKey, project.alias, {
          projectPatch: {
            pendingApproval: null
          }
        });
      }
      await this.sendReply(
        remoteJid,
        target.targetType === "btw"
          ? `Sent ${nextDecision} for btw approval request ${pendingApproval.requestId}.`
          : `Sent ${nextDecision} for project ${project.alias} approval request ${pendingApproval.requestId}.`
      );
    } catch (error) {
      await this.sendReply(remoteJid, `Failed to answer approval request: ${error.message}`);
    }
  }

  async stopActiveRun(phoneKey, remoteJid, payload = "") {
    const config = this.configStore.data;
    const target = parseProjectTargetPayload(payload, config);
    if (target.targetType === "ambiguous") {
      await this.sendReply(
        remoteJid,
        renderAmbiguousProjectSelectionMessage(payload, target.candidates)
      );
      return;
    }

    if (target.targetType === "unknown") {
      await this.sendReply(
        remoteJid,
        `Unknown project "${String(payload).trim()}". Use /projects to inspect available aliases.`
      );
      return;
    }

    const project =
      target.targetType === "project"
        ? resolveConfiguredProject(config, target.projectAlias)
        : this.getActiveProject(phoneKey);
    const runKey =
      target.targetType === "btw"
        ? btwRunKey(phoneKey)
        : projectRunKey(phoneKey, project.alias);
    const active = this.activeRuns.get(runKey);
    if (!active) {
      await this.sendReply(
        remoteJid,
        target.targetType === "btw"
          ? "No Codex run is active for btw."
          : `No Codex run is active for project ${project.alias}.`
      );
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

    this.activeRuns.delete(runKey);
    const clearedQueued = await this.clearQueuedPrompts(phoneKey, {
      scopeType: target.targetType === "btw" ? "btw" : "project",
      projectAlias: project.alias
    });
    if (target.targetType !== "btw") {
      await this.upsertProjectSession(phoneKey, project.alias, {
        projectPatch: {
          pendingApproval: null
        }
      });
    }
    await this.sendReply(
      remoteJid,
      joinMessageSections(
        target.targetType === "btw"
          ? "Stopped the active Codex run for btw."
          : `Stopped the active Codex run for project ${project.alias}.`,
        clearedQueued
          ? `Cleared ${clearedQueued} queued follow-up message${
              clearedQueued === 1 ? "" : "s"
            } for this scope.`
          : null
      )
    );
  }

  async runPrompt({
    phoneKey,
    remoteJid,
    prompt,
    forceNewThread,
    label,
    scopeType = "project",
    projectAlias = null,
    voiceReplyOverride = null,
    statusPrelude = null
  }) {
    const config = this.configStore.data;
    const chatSession = this.getChatSession(phoneKey);
    const project =
      scopeType === "project"
        ? resolveConfiguredProject(
            config,
            projectAlias ?? chatSession.activeProject ?? config.defaultProject
          )
        : resolveConfiguredProject(
            config,
            projectAlias ?? chatSession.activeProject ?? config.defaultProject
          );
    const runKey =
      scopeType === "btw" ? btwRunKey(phoneKey) : projectRunKey(phoneKey, project.alias);
    const active = this.activeRuns.get(runKey);
    if (active) {
      const scopeLabel =
        scopeType === "btw"
          ? "btw"
          : `project ${project.alias}`;
      if (active.pendingApproval) {
        await this.sendReply(
          remoteJid,
          [
            `Approval is pending for ${scopeLabel}.`,
            "",
            formatApprovalDetails(active.pendingApproval)
          ].join("\n")
        );
        return;
      }

      await this.sendReply(
        remoteJid,
        scopeType === "btw"
          ? "Codex is already working on your previous btw request. Send /stop btw to cancel it first."
          : `Codex is already working on your previous request in project ${project.alias} for session ${shortThreadId(
              active.threadId ?? null
            )}. Send /stop ${project.alias} to cancel it first.`
      );
      return;
    }

    const projectSession =
      scopeType === "project"
        ? chatSession.projects?.[project.alias] ?? defaultProjectSession()
        : defaultProjectSession();
    const existingThreadId =
      scopeType === "project" && !forceNewThread ? projectSession.threadId ?? null : null;
    const permissionLevel = resolveSessionPermissionLevel(config, project, projectSession);
    const sessionVoiceReply = resolveSessionVoiceReply(chatSession);
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
      workspace: project.workspace,
      prompt: promptForCodex,
      threadId: existingThreadId,
      threadName: existingThreadId
        ? null
        : buildThreadName({
            label,
            phoneKey,
            projectAlias: scopeType === "project" ? project.alias : null,
            scopeType
          }),
      model: project.model ?? config.model,
      profile: project.profile ?? config.profile,
      search: project.search ?? config.search,
      permissionLevel,
      onApprovalRequest: async (approval) => {
        const currentRun = this.activeRuns.get(runKey);
        if (!currentRun) {
          return;
        }

        currentRun.pendingApproval = approval;
        if (scopeType === "project") {
          await this.upsertProjectSession(phoneKey, project.alias, {
            projectPatch: {
              pendingApproval: {
                kind: approval.kind,
                requestId: approval.requestId,
                requestedAt: new Date().toISOString()
              }
            }
          });
        }
        await this.sendReply(
          remoteJid,
          [
            scopeType === "btw"
              ? `Approval needed for btw session ${shortThreadId(approval.threadId ?? existingThreadId)}.`
              : `Approval needed for project ${project.alias} session ${shortThreadId(
                  approval.threadId ?? existingThreadId
                )}.`,
            "",
            formatApprovalDetails(approval)
          ].join("\n")
        );
      },
      onApprovalResolved: async () => {
        const currentRun = this.activeRuns.get(runKey);
        if (!currentRun) {
          return;
        }

        currentRun.pendingApproval = null;
        if (scopeType === "project") {
          await this.upsertProjectSession(phoneKey, project.alias, {
            projectPatch: {
              pendingApproval: null
            }
          });
        }
      },
      onLifecycleEvent: (event) => {
        const currentRun = this.activeRuns.get(runKey);
        if (!currentRun) {
          return;
        }

        applyRunLifecycleEvent(currentRun, event);
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
      status: "starting",
      lastEventAt: new Date().toISOString(),
      lastProgressAt: null,
      progressPhase: null,
      progressPreview: null,
      voiceReply: activeVoiceReply,
      scopeType,
      projectAlias: scopeType === "project" ? project.alias : null
    };
    this.activeRuns.set(runKey, activeRun);
    const activeProjectAtDispatch = this.getActiveProject(phoneKey);

    if (scopeType === "project") {
      await this.upsertProjectSession(phoneKey, project.alias, {
        chatPatch: {
          phoneKey,
          remoteJid,
          label
        },
        projectPatch: {
          permissionLevel,
          pendingPermissionConfirmation: null,
          lastPromptAt: new Date().toISOString(),
          lastPromptText: prompt,
          lastPromptVoiceReply: activeVoiceReply.enabled ? activeVoiceReply : null,
          threadId: existingThreadId
        }
      });
    } else {
      await this.upsertChatSession(phoneKey, {
        phoneKey,
        remoteJid,
        label,
        btw: {
          ...(chatSession.btw ?? {}),
          lastUsedAt: new Date().toISOString()
        }
      });
    }

    await this.sendReply(
      remoteJid,
      joinMessageSections(
        statusPrelude,
        scopeType === "btw"
          ? "Starting a disposable btw Codex session. I will answer here and then return to your current project."
          : project.alias !== activeProjectAtDispatch.alias
            ? `Started a one-off run in ${project.alias}. You are still in ${activeProjectAtDispatch.alias}. I will post the result here when it completes.`
            : existingThreadId
              ? `Working in ${project.alias} session ${shortThreadId(existingThreadId)} with ${permissionLevel} permissions. I will post the result here when it completes.`
              : `Starting a fresh Codex session in ${project.alias} with ${permissionLevel} permissions. I will post the result here when it completes.`
      )
    );

    try {
      const result = await resultPromise;
      this.activeRuns.delete(runKey);
      const replyEnvelope = extractVoiceReplyEnvelope(result.replyText);
      const replyText =
        replyEnvelope.text || (replyEnvelope.hasLanguageTag ? "" : result.replyText);

      if (!replyText) {
        throw new Error("Codex returned an empty reply.");
      }

      if (scopeType === "project") {
        await this.upsertProjectSession(phoneKey, project.alias, {
          chatPatch: {
            phoneKey,
            remoteJid,
            label
          },
          projectPatch: {
            threadId: result.threadId,
            pendingApproval: null,
            lastReplyAt: new Date().toISOString(),
            lastReplyPreview: replyText.slice(0, 200),
            lastReplyVoiceReply: activeVoiceReply.enabled ? activeVoiceReply : null
          }
        });
      } else {
        await this.upsertChatSession(phoneKey, {
          phoneKey,
          remoteJid,
          label,
          btw: {
            ...(this.getChatSession(phoneKey).btw ?? {}),
            lastUsedAt: new Date().toISOString(),
            lastThreadId: result.threadId ?? null
          }
        });
      }

      if (activeVoiceReply.enabled) {
        try {
          const activeProjectNow = this.getActiveProject(phoneKey);
          if (scopeType === "project" && activeProjectNow.alias !== project.alias) {
            await this.sendReply(
              remoteJid,
              formatProjectRunReplyPrefix({
                projectAlias: project.alias,
                threadId: result.threadId,
                activeProjectAlias: activeProjectNow.alias
              })
            );
          }
          await this.sendVoiceReply(
            remoteJid,
            replyText,
            activeVoiceReply,
            replyEnvelope.languageId
          );
          const textCompanion = buildVoiceReplyTextCompanion(replyText);
          if (textCompanion) {
            await this.sendReply(
              remoteJid,
              `Text companion:\n${textCompanion}`
            );
          }
        } catch (error) {
          await this.sendReply(
            remoteJid,
            `Failed to generate the voice reply locally with ${DEFAULT_TTS_PROVIDER}: ${error.message}`
          );
          await this.sendReply(
            remoteJid,
            scopeType === "btw"
              ? replyText
              : joinMessageSections(
                  formatProjectRunReplyPrefix({
                    projectAlias: project.alias,
                    threadId: result.threadId,
                    activeProjectAlias: this.getActiveProject(phoneKey).alias
                  }),
                  replyText
                )
          );
        }
        await this.runNextQueuedPrompt({
          phoneKey,
          remoteJid,
          label,
          scopeType,
          projectAlias: project.alias
        });
        return;
      }

      await this.sendReply(
        remoteJid,
        scopeType === "btw"
          ? replyText
          : joinMessageSections(
              formatProjectRunReplyPrefix({
                projectAlias: project.alias,
                threadId: result.threadId,
                activeProjectAlias: this.getActiveProject(phoneKey).alias
              }),
              replyText
            )
      );
      await this.runNextQueuedPrompt({
        phoneKey,
        remoteJid,
        label,
        scopeType,
        projectAlias: project.alias
      });
    } catch (error) {
      this.activeRuns.delete(runKey);
      if (activeRun.cancelled) {
        return;
      }

      if (scopeType === "project") {
        await this.upsertProjectSession(phoneKey, project.alias, {
          chatPatch: {
            phoneKey,
            remoteJid,
            label
          },
          projectPatch: {
            pendingApproval: null,
            lastErrorAt: new Date().toISOString(),
            lastError: error.message
          }
        });
      }

      await this.sendReply(
        remoteJid,
        scopeType === "btw"
          ? `Codex btw run failed: ${error.message}`
          : joinMessageSections(
              formatProjectRunReplyPrefix({
                projectAlias: project.alias,
                threadId: activeRun.threadId ?? existingThreadId,
                activeProjectAlias: this.getActiveProject(phoneKey).alias,
                outcome: "failed"
              }),
              error.message
            )
      );
      await this.runNextQueuedPrompt({
        phoneKey,
        remoteJid,
        label,
        scopeType,
        projectAlias: project.alias
      });
    }
  }

  async sendReply(remoteJid, text) {
    await this.sendTextMessage(remoteJid, sanitizeReplyTextForWhatsApp(text));
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
