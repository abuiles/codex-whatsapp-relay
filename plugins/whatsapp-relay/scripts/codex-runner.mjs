import { spawn } from "node:child_process";

import {
  appServerPermissionParams,
  cliPermissionOverrides,
  permissionLevelConfig,
  resolvePermissionLevel
} from "./controller-permissions.mjs";

const CLIENT_INFO = {
  name: "whatsapp-relay",
  title: "WhatsApp Relay",
  version: "0.1.0"
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
