import fs from "node:fs/promises";
import path from "node:path";

import { normalizeProjectAlias } from "./controller-projects.mjs";
import { controllerStateFile } from "./paths.mjs";

const DEFAULT_PROJECT_ALIAS = "main";
const LEGACY_PROJECT_FIELDS = [
  "threadId",
  "permissionLevel",
  "pendingPermissionConfirmation",
  "pendingApproval",
  "lastPromptAt",
  "lastPromptText",
  "lastPromptVoiceReply",
  "lastReplyAt",
  "lastReplyPreview",
  "lastReplyVoiceReply",
  "connectedThreadAt",
  "connectedThreadName",
  "lastThreadChoices",
  "lastThreadChoicesAt",
  "lastErrorAt",
  "lastError"
];

function normalizeQueuedPrompt(value = {}) {
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt) {
    return null;
  }

  return {
    prompt,
    forceNewThread: Boolean(value.forceNewThread),
    queuedAt: typeof value.queuedAt === "string" ? value.queuedAt : null,
    voiceReplyOverride:
      value.voiceReplyOverride?.enabled
        ? {
            enabled: true,
            speed: value.voiceReplyOverride.speed ?? null
          }
        : null
  };
}

function normalizeQueuedPromptList(value) {
  return Array.isArray(value)
    ? value.map((item) => normalizeQueuedPrompt(item)).filter(Boolean)
    : [];
}

export function defaultProjectSession() {
  return {
    threadId: null,
    permissionLevel: null,
    pendingPermissionConfirmation: null,
    pendingApproval: null,
    lastPromptAt: null,
    lastPromptText: null,
    lastPromptVoiceReply: null,
    lastReplyAt: null,
    lastReplyPreview: null,
    lastReplyVoiceReply: null,
    connectedThreadAt: null,
    connectedThreadName: null,
    lastThreadChoices: [],
    lastThreadChoicesAt: null,
    lastErrorAt: null,
    lastError: null,
    queuedPrompts: []
  };
}

export function defaultChatSession(phoneKey = null) {
  return {
    phoneKey,
    label: null,
    remoteJid: null,
    activeProject: DEFAULT_PROJECT_ALIAS,
    voiceReply: null,
    projects: {
      [DEFAULT_PROJECT_ALIAS]: defaultProjectSession()
    },
    btw: {
      lastUsedAt: null,
      queuedPrompts: []
    },
    lastInboundAt: null,
    lastInboundText: null,
    lastInboundType: null,
    lastVoiceTranscriptAt: null,
    lastVoiceTranscriptModel: null,
    lastVoiceTranscriptConfidence: null,
    lastVoiceTranscriptMinConfidence: null
  };
}

function defaultState() {
  return {
    process: {
      pid: null,
      status: "stopped",
      startedAt: null,
      heartbeatAt: null
    },
    sessions: {}
  };
}

function extractLegacyProjectSession(value = {}) {
  return LEGACY_PROJECT_FIELDS.reduce((project, field) => {
    if (value[field] !== undefined) {
      project[field] = value[field];
    }
    return project;
  }, {});
}

function normalizeProjectSession(value = {}) {
  return {
    ...defaultProjectSession(),
    ...value,
    lastThreadChoices: Array.isArray(value.lastThreadChoices) ? value.lastThreadChoices : [],
    queuedPrompts: normalizeQueuedPromptList(value.queuedPrompts)
  };
}

function normalizeChatSession(value = {}, phoneKey = null) {
  const merged = {
    ...defaultChatSession(phoneKey),
    ...value
  };
  for (const field of LEGACY_PROJECT_FIELDS) {
    delete merged[field];
  }

  const activeProject = normalizeProjectAlias(
    value.activeProject ?? DEFAULT_PROJECT_ALIAS,
    DEFAULT_PROJECT_ALIAS
  );
  const rawProjects =
    value.projects && typeof value.projects === "object" ? value.projects : {};
  const legacyProject = extractLegacyProjectSession(value);
  const projectEntries = Object.entries(rawProjects).map(([alias, project]) => [
    normalizeProjectAlias(alias, DEFAULT_PROJECT_ALIAS),
    normalizeProjectSession(project)
  ]);

  if (!projectEntries.length || Object.keys(legacyProject).length) {
    projectEntries.push([
      activeProject,
      normalizeProjectSession({
        ...(rawProjects[activeProject] ?? {}),
        ...legacyProject
      })
    ]);
  }

  const projects = Object.fromEntries(projectEntries);
  if (!projects[activeProject]) {
    projects[activeProject] = defaultProjectSession();
  }

  return {
    ...merged,
    phoneKey: phoneKey ?? value.phoneKey ?? null,
    activeProject,
    voiceReply: value.voiceReply ?? null,
    projects,
    btw: {
      ...defaultChatSession().btw,
      ...(value.btw ?? {}),
      queuedPrompts: normalizeQueuedPromptList(value.btw?.queuedPrompts)
    }
  };
}

function normalizeState(value = {}) {
  const sessions = Object.fromEntries(
    Object.entries(value.sessions ?? {}).map(([phoneKey, session]) => [
      phoneKey,
      normalizeChatSession(session, phoneKey)
    ])
  );

  return {
    ...defaultState(),
    ...value,
    process: {
      ...defaultState().process,
      ...(value.process ?? {})
    },
    sessions
  };
}

export class ControllerStateStore {
  constructor(filePath = controllerStateFile) {
    this.filePath = filePath;
    this.data = defaultState();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.data = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      this.data = defaultState();
    }

    return this.data;
  }

  async save() {
    this.data = normalizeState(this.data);
    const tempFile = path.join(
      path.dirname(this.filePath),
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tempFile, JSON.stringify(this.data, null, 2));
    await fs.rename(tempFile, this.filePath);
    return this.data;
  }

  async mutate(mutator) {
    const run = this.queue.then(async () => {
      await this.load();
      await mutator(this.data);
      return this.save();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async setProcess(partial = {}) {
    return this.mutate((data) => {
      data.process = {
        ...data.process,
        ...partial
      };
      this.data = normalizeState(data);
    });
  }

  async clearProcess() {
    return this.mutate((data) => {
      data.process = defaultState().process;
      this.data = normalizeState(data);
    });
  }

  async upsertSession(phoneKey, partial = {}) {
    return this.mutate((data) => {
      data.sessions[phoneKey] = {
        ...(data.sessions[phoneKey] ?? {}),
        ...partial
      };
      this.data = normalizeState(data);
    });
  }

  async removeSession(phoneKey) {
    return this.mutate((data) => {
      delete data.sessions[phoneKey];
      this.data = normalizeState(data);
    });
  }

  getSession(phoneKey) {
    return normalizeChatSession(this.data.sessions[phoneKey] ?? {}, phoneKey);
  }

  listSessions() {
    return Object.entries(this.data.sessions).map(([phoneKey, session]) => {
      const normalized = normalizeChatSession(session, phoneKey);
      const activeProject = normalized.activeProject;
      const activeProjectSession = normalized.projects[activeProject] ?? defaultProjectSession();
      return {
        phoneKey,
        ...normalized,
        threadId: activeProjectSession.threadId ?? null,
        permissionLevel: activeProjectSession.permissionLevel ?? null
      };
    });
  }
}
