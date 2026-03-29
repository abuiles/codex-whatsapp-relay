import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appServerPermissionParams,
  cliPermissionOverrides,
  permissionLevelConfig,
  resolvePermissionLevel
} from "./controller-permissions.mjs";

const CLIENT_INFO = {
  name: "whatsapp-relay",
  title: "WhatsApp Relay",
  version: "0.2.0"
};

const OPT_OUT_NOTIFICATIONS = [
  "account/rateLimits/updated",
  "command/exec/outputDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "mcpServer/startupStatus/updated",
  "thread/status/changed",
  "thread/tokenUsage/updated"
];
const VOICE_COMMAND_INTENT_MODEL = "gpt-5.4-mini";
const VOICE_COMMAND_INTENT_REASONING_EFFORT = "low";
const PROJECT_INTENT_MODEL = "gpt-5.4-mini";
const PROJECT_INTENT_REASONING_EFFORT = "low";

const VOICE_COMMAND_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "payload", "prompt", "target", "decision", "confidence", "reason"],
  properties: {
    type: {
      type: "string",
      enum: [
        "help",
        "projects",
        "project",
        "status",
        "new",
        "newProjectSession",
        "projectPrompt",
        "btw",
        "sessions",
        "connect",
        "permissions",
        "approvalDecision",
        "stop",
        "prompt"
      ]
    },
    payload: { type: ["string", "null"] },
    prompt: { type: ["string", "null"] },
    target: { type: ["string", "null"] },
    decision: {
      anyOf: [
        {
          type: "string",
          enum: ["accept", "acceptForSession", "decline", "cancel"]
        },
        { type: "null" }
      ]
    },
    confidence: { type: ["number", "null"] },
    reason: { type: ["string", "null"] }
  }
};

const PROJECT_INTENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "projectAlias", "candidateAliases", "reason"],
  properties: {
    outcome: {
      type: "string",
      enum: ["match", "ambiguous", "noMatch"]
    },
    projectAlias: { type: ["string", "null"] },
    candidateAliases: {
      type: "array",
      items: { type: "string" }
    },
    reason: { type: ["string", "null"] }
  }
};

function configArgs({ model, profile, search, permissionLevel }) {
  const args = ["app-server"];
  const cliPermissions = cliPermissionOverrides(permissionLevel);

  if (profile) {
    args.push("-c", `profile=${JSON.stringify(profile)}`);
  }

  if (model) {
    args.push("-c", `model=${JSON.stringify(model)}`);
  }

  if (search) {
    args.push("-c", 'web_search="live"');
  }

  args.push("-c", `approval_policy=${JSON.stringify(cliPermissions.approvalPolicy)}`);
  args.push("-c", `sandbox_mode=${JSON.stringify(cliPermissions.sandboxMode)}`);

  return args;
}

function buildPromptInput(prompt) {
  return [
    {
      type: "text",
      text: prompt,
      text_elements: []
    }
  ];
}

function sanitizeIntentText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFallbackPrompt(transcript, captureAllDirectMessages = true) {
  const prompt = String(transcript ?? "").trim();
  if (!captureAllDirectMessages) {
    return { type: "ignored" };
  }

  return prompt ? { type: "prompt", prompt } : { type: "empty" };
}

export function buildVoiceCommandIntentPrompt({
  transcript,
  activeProjectAlias = null,
  projects = []
}) {
  const projectLines = Array.isArray(projects)
    ? projects.map((project) => `- ${project.alias}`)
    : [];

  return [
    "You classify one transcribed WhatsApp voice note for a local Codex bridge.",
    "Return only JSON that matches the provided schema.",
    "Decide whether the transcript is a bridge control command or a normal Codex prompt.",
    "Prefer `prompt` unless the user is clearly controlling the bridge itself.",
    "",
    "Supported bridge command types:",
    "- help",
    "- projects",
    "- project with `payload` set to the project hint or alias",
    "- status with optional `payload` set to a project hint",
    "- new for resetting the active project session",
    "- newProjectSession with `target` set to the repo or project hint",
    "- projectPrompt with `payload` formatted as `<project> <prompt>`",
    "- btw with `prompt`",
    "- sessions with optional `payload` set to a project hint",
    "- connect with `payload` formatted as `<selector>` or `<project> <selector>`",
    "- permissions with `payload` like `ro`, `ww`, `dfa`, or `<project> ro|ww|dfa`",
    "- approvalDecision with `decision` and optional `payload` target",
    "- stop with optional `payload` target",
    "- prompt with `prompt` for normal work",
    "",
    "Examples:",
    "- `project alpha app` -> project with payload `alpha app`",
    "- `list sessions for frontend site` -> sessions with payload `frontend site`",
    "- `session alpha app 2` -> connect with payload `alpha app 2`",
    "- `workspace write` -> permissions with payload `workspace write`",
    "- `read only` -> permissions with payload `read only`",
    "- `danger full access` -> permissions with payload `danger full access`",
    "- `please fix the checkout button` -> prompt with prompt `please fix the checkout button`",
    "",
    "Active project:",
    activeProjectAlias ?? "(none)",
    "",
    "Known projects:",
    ...(projectLines.length ? projectLines : ["- none"]),
    "",
    "Transcript:",
    String(transcript ?? "").trim()
  ].join("\n");
}

export function buildProjectIntentPrompt({
  intent,
  activeProjectAlias = null,
  projects = []
}) {
  const projectLines = Array.isArray(projects)
    ? projects.map(
        (project) =>
          `- ${project.alias} (repo: ${path.basename(String(project.workspace ?? project.alias))})`
      )
    : [];

  return [
    "You resolve one WhatsApp project hint for a local Codex bridge.",
    "Return only JSON that matches the provided schema.",
    "Choose only from the known project aliases that are provided.",
    "Do not invent project aliases.",
    "Prefer `noMatch` over guessing when the hint is weak or underspecified.",
    "If exactly one project is the best fit, return outcome `match` with `projectAlias`.",
    "If multiple projects are plausible, return outcome `ambiguous` and list the best aliases in `candidateAliases`.",
    "If none fit, return outcome `noMatch`.",
    "",
    "Active project:",
    activeProjectAlias ?? "(none)",
    "",
    "Known projects:",
    ...(projectLines.length ? projectLines : ["- none"]),
    "",
    "Hint:",
    String(intent ?? "").trim()
  ].join("\n");
}

export function normalizeVoiceCommandIntent(result, transcript, captureAllDirectMessages = true) {
  const fallback = normalizeFallbackPrompt(transcript, captureAllDirectMessages);
  if (!result || typeof result !== "object") {
    return fallback;
  }

  const type = sanitizeIntentText(result.type);
  switch (type) {
    case "help":
      return { type: "help" };
    case "projects":
      return { type: "projects" };
    case "project": {
      const payload = sanitizeIntentText(result.payload);
      return payload ? { type: "project", payload } : fallback;
    }
    case "status":
      return { type: "status", payload: sanitizeIntentText(result.payload) };
    case "new":
      return { type: "new", prompt: sanitizeIntentText(result.prompt) };
    case "newProjectSession": {
      const target = sanitizeIntentText(result.target || result.payload);
      return target ? { type: "newProjectSession", target } : fallback;
    }
    case "projectPrompt": {
      const payload = sanitizeIntentText(result.payload);
      return payload ? { type: "projectPrompt", payload } : fallback;
    }
    case "btw": {
      const prompt = sanitizeIntentText(result.prompt);
      return prompt ? { type: "btw", prompt } : fallback;
    }
    case "sessions":
      return { type: "sessions", payload: sanitizeIntentText(result.payload) };
    case "connect": {
      const payload = sanitizeIntentText(result.payload);
      return payload ? { type: "connect", payload } : fallback;
    }
    case "permissions": {
      const payload = sanitizeIntentText(result.payload);
      return payload ? { type: "permissions", payload } : fallback;
    }
    case "approvalDecision": {
      const decision = sanitizeIntentText(result.decision);
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) {
        return fallback;
      }

      return {
        type: "approvalDecision",
        decision,
        payload: sanitizeIntentText(result.payload)
      };
    }
    case "stop":
      return { type: "stop", payload: sanitizeIntentText(result.payload) };
    case "prompt": {
      const prompt = sanitizeIntentText(result.prompt) || String(transcript ?? "").trim();
      return captureAllDirectMessages && prompt
        ? { type: "prompt", prompt }
        : fallback;
    }
    default:
      return fallback;
  }
}

export function normalizeProjectIntentSelection(result, projects = []) {
  const knownAliases = new Set(
    Array.isArray(projects)
      ? projects.map((project) => String(project.alias ?? "").trim()).filter(Boolean)
      : []
  );

  if (!result || typeof result !== "object") {
    return {
      outcome: "noMatch",
      projectAlias: null,
      candidateAliases: []
    };
  }

  const outcome = sanitizeIntentText(result.outcome);
  const projectAlias = sanitizeIntentText(result.projectAlias) || null;
  const candidateAliases = Array.isArray(result.candidateAliases)
    ? [...new Set(result.candidateAliases.map((alias) => sanitizeIntentText(alias)).filter(Boolean))]
        .filter((alias) => knownAliases.has(alias))
    : [];

  switch (outcome) {
    case "match":
      return projectAlias && knownAliases.has(projectAlias)
        ? {
            outcome: "match",
            projectAlias,
            candidateAliases: []
          }
        : {
            outcome: "noMatch",
            projectAlias: null,
            candidateAliases: []
          };
    case "ambiguous":
      return candidateAliases.length
        ? {
            outcome: "ambiguous",
            projectAlias: null,
            candidateAliases
          }
        : {
            outcome: "noMatch",
            projectAlias: null,
            candidateAliases: []
          };
    case "noMatch":
    default:
      return {
        outcome: "noMatch",
        projectAlias: null,
        candidateAliases: []
      };
  }
}

function formatRequestError(message = "Unknown app-server error.") {
  return new Error(message);
}

function formatTurnError(turnError) {
  if (!turnError) {
    return new Error("Codex turn failed.");
  }

  const parts = [turnError.message];
  if (turnError.additionalDetails) {
    parts.push(turnError.additionalDetails);
  }

  return new Error(parts.filter(Boolean).join("\n\n") || "Codex turn failed.");
}

function formatCloseError({ code, signal, stderr }) {
  return new Error(
    stderr.trim() ||
      (signal
        ? `Codex app-server exited with signal ${signal}.`
        : `Codex app-server exited with code ${code}.`)
  );
}

async function runCodexExec({
  codexBin,
  args,
  cwd
}) {
  const child = spawn(codexBin, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", () => {});

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

function validatePermissionRequirements(requirements, permissionLevel) {
  if (!requirements) {
    return;
  }

  const config = permissionLevelConfig(permissionLevel);
  const allowedApprovalPolicies = requirements.allowedApprovalPolicies ?? null;
  const allowedSandboxModes = requirements.allowedSandboxModes ?? null;

  if (
    Array.isArray(allowedApprovalPolicies) &&
    !allowedApprovalPolicies.includes(config.approvalPolicyAppServer)
  ) {
    throw new Error(
      `Codex admin requirements do not allow approval policy ${config.approvalPolicyAppServer} for ${config.helpName}. Allowed policies: ${allowedApprovalPolicies.join(", ")}.`
    );
  }

  if (
    Array.isArray(allowedSandboxModes) &&
    !allowedSandboxModes.includes(config.sandboxModeCli)
  ) {
    throw new Error(
      `Codex admin requirements do not allow sandbox mode ${config.sandboxModeCli} for ${config.helpName}. Allowed sandbox modes: ${allowedSandboxModes.join(", ")}.`
    );
  }
}

function decisionToApprovalResponse(request, decision) {
  switch (request?.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision };
    case "item/permissions/requestApproval":
      if (decision === "accept" || decision === "acceptForSession") {
        return {
          permissions: request.params?.permissions ?? {},
          scope: decision === "acceptForSession" ? "session" : "turn"
        };
      }

      return {
        permissions: {},
        scope: "turn"
      };
    default:
      return decision;
  }
}

function startAppServerClient({
  codexBin,
  workspace,
  model = null,
  profile = null,
  search = false,
  permissionLevel = "read-only",
  onNotification = null,
  onServerRequest = null,
  onClose = null
}) {
  const resolvedPermissionLevel = resolvePermissionLevel(permissionLevel);
  const child = spawn(
    codexBin,
    configArgs({
      model,
      profile,
      search,
      permissionLevel: resolvedPermissionLevel
    }),
    {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  let buffer = "";
  let nextRequestId = 0;
  let stderr = "";
  let exiting = false;
  let shutdownPromise = null;

  const pendingRequests = new Map();
  const pendingServerRequests = new Map();

  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function cleanupRequest(requestId) {
    const pending = pendingRequests.get(requestId);
    pendingRequests.delete(requestId);
    return pending;
  }

  function rejectPending(error) {
    for (const [requestId, pending] of pendingRequests.entries()) {
      pending.reject(error);
      pendingRequests.delete(requestId);
    }
  }

  function writeMessage(payload) {
    return new Promise((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        reject(new Error("Codex app-server stdin is closed."));
        return;
      }

      child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  function handleMessage(rawLine) {
    if (!rawLine.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(rawLine);
    } catch {
      return;
    }

    if (message.method && "id" in message) {
      pendingServerRequests.set(message.id, message);
      Promise.resolve(onServerRequest?.(message)).catch(() => {});
      return;
    }

    if ("id" in message) {
      const pending = cleanupRequest(message.id);
      if (!pending) {
        return;
      }

      if (message.error) {
        pending.reject(formatRequestError(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      if (message.method === "serverRequest/resolved" && message.params?.requestId !== undefined) {
        pendingServerRequests.delete(message.params.requestId);
      }

      Promise.resolve(onNotification?.(message)).catch(() => {});
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newlineIndex = buffer.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      handleMessage(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.stdin.on("error", () => {});

  child.once("error", (error) => {
    rejectPending(error);
    Promise.resolve(onClose?.(error)).catch(() => {});
    resolveClosed({
      code: null,
      signal: null,
      stderr,
      error
    });
  });

  child.once("close", (code, signal) => {
    if (buffer.trim()) {
      handleMessage(buffer);
      buffer = "";
    }

    const closeError = formatCloseError({ code, signal, stderr });
    rejectPending(closeError);
    Promise.resolve(onClose?.(closeError)).catch(() => {});
    resolveClosed({
      code,
      signal,
      stderr,
      error: closeError
    });
  });

  return {
    child,
    closed,
    request(method, params) {
      const requestId = ++nextRequestId;
      return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, {
          resolve,
          reject
        });

        writeMessage({
          id: requestId,
          method,
          params
        }).catch((error) => {
          cleanupRequest(requestId);
          reject(error);
        });
      });
    },
    respond(requestId, result) {
      pendingServerRequests.delete(requestId);
      return writeMessage({
        id: requestId,
        result
      });
    },
    getPendingServerRequest(requestId) {
      return pendingServerRequests.get(requestId) ?? null;
    },
    getStderr() {
      return stderr;
    },
    shutdown(signal = "SIGTERM") {
      if (shutdownPromise) {
        return shutdownPromise;
      }

      shutdownPromise = (async () => {
        if (exiting) {
          return;
        }

        exiting = true;
        child.stdin.end();
        if (!child.killed) {
          child.kill(signal);
        }
      })();

      return shutdownPromise;
    },
    permissionLevel: resolvedPermissionLevel
  };
}

export async function listCodexThreads({
  codexBin,
  workspace,
  model = null,
  profile = null,
  search = false,
  limit = 20
}) {
  const client = startAppServerClient({
    codexBin,
    workspace,
    model,
    profile,
    search,
    permissionLevel: "read-only"
  });

  try {
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: OPT_OUT_NOTIFICATIONS
      }
    });

    const result = await client.request("thread/list", {
      cursor: null,
      limit,
      sortKey: "created_at"
    });

    return result.data ?? [];
  } finally {
    await client.shutdown().catch(() => {});
    await client.closed.catch(() => {});
  }
}

export async function classifyVoiceCommandIntent({
  codexBin,
  workspace,
  transcript,
  activeProjectAlias = null,
  projects = []
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-voice-intent-"));
  const schemaPath = path.join(tempDir, "voice-command-intent.schema.json");
  const outputPath = path.join(tempDir, "voice-command-intent.json");

  try {
    await fs.writeFile(
      schemaPath,
      JSON.stringify(VOICE_COMMAND_INTENT_SCHEMA, null, 2),
      "utf8"
    );

    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      workspace,
      "-m",
      VOICE_COMMAND_INTENT_MODEL,
      "-c",
      `model_reasoning_effort=${JSON.stringify(VOICE_COMMAND_INTENT_REASONING_EFFORT)}`,
      "-s",
      "read-only",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath
    ];

    args.push(
      buildVoiceCommandIntentPrompt({
        transcript,
        activeProjectAlias,
        projects
      })
    );

    const result = await runCodexExec({
      codexBin,
      args,
      cwd: workspace
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          (result.signal
            ? `Codex exec exited with signal ${result.signal}.`
            : `Codex exec exited with code ${result.code}.`)
      );
    }

    const raw = await fs.readFile(outputPath, "utf8");
    return JSON.parse(raw);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function classifyProjectIntent({
  codexBin,
  workspace,
  intent,
  activeProjectAlias = null,
  projects = []
}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-project-intent-"));
  const schemaPath = path.join(tempDir, "project-intent.schema.json");
  const outputPath = path.join(tempDir, "project-intent.json");

  try {
    await fs.writeFile(
      schemaPath,
      JSON.stringify(PROJECT_INTENT_SCHEMA, null, 2),
      "utf8"
    );

    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      workspace,
      "-m",
      PROJECT_INTENT_MODEL,
      "-c",
      `model_reasoning_effort=${JSON.stringify(PROJECT_INTENT_REASONING_EFFORT)}`,
      "-s",
      "read-only",
      "--output-schema",
      schemaPath,
      "-o",
      outputPath
    ];

    args.push(
      buildProjectIntentPrompt({
        intent,
        activeProjectAlias,
        projects
      })
    );

    const result = await runCodexExec({
      codexBin,
      args,
      cwd: workspace
    });
    if (result.code !== 0) {
      throw new Error(
        result.stderr.trim() ||
          (result.signal
            ? `Codex exec exited with signal ${result.signal}.`
            : `Codex exec exited with code ${result.code}.`)
      );
    }

    const raw = await fs.readFile(outputPath, "utf8");
    return normalizeProjectIntentSelection(JSON.parse(raw), projects);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function startCodexTurn({
  codexBin,
  workspace,
  prompt,
  threadId = null,
  threadName = null,
  model = null,
  profile = null,
  search = false,
  permissionLevel = "workspace-write",
  onApprovalRequest = null,
  onApprovalResolved = null
}) {
  if (!prompt?.trim()) {
    throw new Error("Codex prompt cannot be empty.");
  }

  const resolvedPermissionLevel = resolvePermissionLevel(permissionLevel);
  const permissionParams = appServerPermissionParams(resolvedPermissionLevel);
  const client = startAppServerClient({
    codexBin,
    workspace,
    model,
    profile,
    search,
    permissionLevel: resolvedPermissionLevel,
    onNotification: handleNotification,
    onServerRequest: handleServerRequest
  });
  const child = client.child;

  let resolvedThreadId = threadId;
  let activeTurnId = null;
  let settled = false;
  let fallbackReply = "";
  let finalReply = "";

  const agentMessages = new Map();

  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  function settle(type, value) {
    if (settled) {
      return;
    }

    settled = true;
    if (type === "resolve") {
      resolveResult(value);
    } else {
      rejectResult(value);
    }
  }

  function handleAgentMessage(item) {
    const existing = agentMessages.get(item.id) ?? {
      phase: item.phase ?? null,
      text: ""
    };
    const text = item.text || existing.text;
    agentMessages.set(item.id, {
      phase: item.phase ?? existing.phase ?? null,
      text
    });

    if (!fallbackReply && text.trim()) {
      fallbackReply = text;
    }

    if (item.phase === "final_answer" && text.trim()) {
      finalReply = text;
    }
  }

  function handleNotification(message) {
    const { method, params } = message;
    if (!params) {
      return;
    }

    switch (method) {
      case "item/started":
        if (params.turnId === activeTurnId && params.item?.type === "agentMessage") {
          agentMessages.set(params.item.id, {
            phase: params.item.phase ?? null,
            text: params.item.text ?? ""
          });
        }
        return;
      case "item/agentMessage/delta": {
        if (params.turnId !== activeTurnId) {
          return;
        }

        const current = agentMessages.get(params.itemId) ?? {
          phase: null,
          text: ""
        };
        current.text += params.delta;
        agentMessages.set(params.itemId, current);
        return;
      }
      case "item/completed":
        if (params.turnId === activeTurnId && params.item?.type === "agentMessage") {
          handleAgentMessage(params.item);
        }
        return;
      case "serverRequest/resolved":
        if (params.threadId === resolvedThreadId && params.requestId !== undefined) {
          onApprovalResolved?.({
            requestId: params.requestId,
            threadId: params.threadId,
            turnId: params.turnId ?? null
          });
        }
        return;
      case "turn/completed":
        if (params.turn.id !== activeTurnId) {
          return;
        }

        if (params.turn.status === "failed") {
          settle("reject", formatTurnError(params.turn.error));
        } else if (params.turn.status === "interrupted") {
          settle("reject", new Error("Codex run was interrupted."));
        } else {
          settle("resolve", {
            threadId: resolvedThreadId,
            replyText: finalReply || fallbackReply || "Codex completed without a final message."
          });
        }

        client.shutdown().catch(() => {});
        return;
      case "error":
        if (params.turnId !== activeTurnId && params.threadId !== resolvedThreadId) {
          return;
        }

        if (!params.willRetry) {
          settle("reject", formatTurnError(params.error));
          client.shutdown().catch(() => {});
        }
        return;
      default:
        return;
    }
  }

  function handleServerRequest(message) {
    const { method, id, params } = message;

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
        onApprovalRequest?.({
          requestId: id,
          threadId: params?.threadId ?? resolvedThreadId,
          turnId: params?.turnId ?? activeTurnId,
          itemId: params?.itemId ?? null,
          kind:
            method === "item/commandExecution/requestApproval"
              ? "commandExecution"
              : method === "item/fileChange/requestApproval"
                ? "fileChange"
                : "permissions",
          availableDecisions: params?.availableDecisions ?? null,
          ...params
        });
        return;
      default:
        return;
    }
  }

  client.closed.then(({ error }) => {
    if (!settled) {
      settle("reject", error);
    }
  });

  const bootstrap = (async () => {
    await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: false,
        optOutNotificationMethods: OPT_OUT_NOTIFICATIONS
      }
    });

    const requirementsResult = await client
      .request("configRequirements/read", {})
      .catch(() => ({ requirements: null }));
    validatePermissionRequirements(requirementsResult.requirements, resolvedPermissionLevel);

    const threadResult = threadId
      ? await client.request("thread/resume", {
          threadId,
          cwd: workspace,
          ...(model ? { model } : {}),
          approvalPolicy: permissionParams.approvalPolicy,
          persistExtendedHistory: false
        })
      : await client.request("thread/start", {
          cwd: workspace,
          ...(model ? { model } : {}),
          approvalPolicy: permissionParams.approvalPolicy,
          experimentalRawEvents: false,
          persistExtendedHistory: false
        });

    resolvedThreadId = threadResult.thread.id;

    if (threadName?.trim()) {
      await client
        .request("thread/name/set", {
          threadId: resolvedThreadId,
          name: threadName.trim()
        })
        .catch(() => {});
    }

    const turnResult = await client.request("turn/start", {
      threadId: resolvedThreadId,
      input: buildPromptInput(prompt),
      cwd: workspace,
      ...(model ? { model } : {}),
      approvalPolicy: permissionParams.approvalPolicy,
      sandboxPolicy: permissionParams.sandboxPolicy
    });

    activeTurnId = turnResult.turn.id;
  })();

  bootstrap.catch((error) => {
    settle("reject", error);
    client.shutdown().catch(() => {});
  });

  resultPromise
    .finally(() => {
      client.shutdown().catch(() => {});
    })
    .catch(() => {});

  return {
    child,
    interrupt: async () => {
      try {
        await bootstrap;
      } catch {
        await client.shutdown("SIGKILL");
        return;
      }

      if (!resolvedThreadId || !activeTurnId) {
        await client.shutdown("SIGKILL");
        return;
      }

      try {
        await client.request("turn/interrupt", {
          threadId: resolvedThreadId,
          turnId: activeTurnId
        });
      } catch {
        await client.shutdown("SIGKILL");
        return;
      }

      await client.shutdown();
    },
    answerApproval: async (requestId, decision) => {
      await bootstrap;

      const request = client.getPendingServerRequest(requestId);
      if (!request) {
        throw new Error(`Approval request ${requestId} is no longer pending.`);
      }

      await client.respond(requestId, decisionToApprovalResponse(request, decision));
    },
    resultPromise
  };
}
