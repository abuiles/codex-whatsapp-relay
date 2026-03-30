import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyRunLifecycleEvent,
  buildVoiceReplyTextCompanion,
  buildDangerFullAccessConfirmationMessage,
  formatProjectRunReplyPrefix,
  buildVoiceReplyPrompt,
  extractVoiceReplyEnvelope,
  extractOneShotVoiceReplyRequest,
  WhatsAppControllerBridge,
  parseImplicitProjectCommand,
  parseApprovalTargetPayload,
  parseVoiceReplyCommandPayload,
  normalizeVoiceCommandText,
  parseIncomingCommand,
  parseVoiceTranscript,
  requiresTextConfirmationForVoicePrompt,
  resolveProjectSelection,
  resolveThreadSelection,
  sanitizeReplyTextForWhatsApp,
  shouldSplitCompoundVoiceControlRequest
} from "./controller-bridge.mjs";
import { normalizePermissionLevel } from "./controller-permissions.mjs";
import { ControllerStateStore } from "./controller-state.mjs";

test("parseIncomingCommand accepts shortcut aliases for admin commands", () => {
  assert.deepEqual(parseIncomingCommand("/h", true), { type: "help" });
  assert.deepEqual(parseIncomingCommand("/st", true), { type: "status", payload: "" });
  assert.deepEqual(parseIncomingCommand("/n review this diff", true), {
    type: "new",
    prompt: "review this diff"
  });
  assert.deepEqual(parseIncomingCommand("/projects", true), { type: "projects" });
  assert.deepEqual(parseIncomingCommand("/project alpha-app", true), {
    type: "project",
    payload: "alpha-app"
  });
  assert.deepEqual(parseIncomingCommand("/project 2", true), {
    type: "project",
    payload: "2"
  });
  assert.deepEqual(parseIncomingCommand("/in alpha-app review this diff", true), {
    type: "projectPrompt",
    payload: "alpha-app review this diff"
  });
  assert.deepEqual(parseIncomingCommand("/btw what time is it?", true), {
    type: "btw",
    prompt: "what time is it?"
  });
  assert.deepEqual(parseIncomingCommand("/ls", true), { type: "sessions", payload: "" });
  assert.deepEqual(parseIncomingCommand("/session 2", true), {
    type: "connect",
    payload: "2"
  });
  assert.deepEqual(parseIncomingCommand("/1", true), {
    type: "connect",
    payload: "1"
  });
  assert.deepEqual(parseIncomingCommand("/p ww", true), {
    type: "permissions",
    payload: "ww"
  });
  assert.deepEqual(parseIncomingCommand("/ro", true), {
    type: "permissions",
    payload: "ro"
  });
  assert.deepEqual(parseIncomingCommand("/ww alpha-app", true), {
    type: "permissions",
    payload: "alpha-app ww"
  });
  assert.deepEqual(parseIncomingCommand("/dfa alpha-app", true), {
    type: "permissions",
    payload: "alpha-app dfa"
  });
  assert.deepEqual(parseIncomingCommand("/dfa 263593", true), {
    type: "permissions",
    payload: "dfa 263593"
  });
  assert.deepEqual(parseIncomingCommand("/dfa alpha-app 263593", true), {
    type: "permissions",
    payload: "alpha-app dfa 263593"
  });
  assert.deepEqual(parseIncomingCommand("/voice on 2x", true), {
    type: "voiceReplySettings",
    payload: "on 2x"
  });
  assert.deepEqual(parseIncomingCommand("/a session", true), {
    type: "approvalDecision",
    decision: "accept",
    payload: "session"
  });
  assert.deepEqual(parseIncomingCommand("/d", true), {
    type: "approvalDecision",
    decision: "decline",
    payload: ""
  });
  assert.deepEqual(parseIncomingCommand("/q", true), {
    type: "approvalDecision",
    decision: "cancel",
    payload: ""
  });
  assert.deepEqual(parseIncomingCommand("/x", true), { type: "stop", payload: "" });
});

test("parseIncomingCommand recognizes the natural-language new project session shortcut", () => {
  assert.deepEqual(
    parseIncomingCommand("start new session in alpha app inside code directory", true),
    {
      type: "newProjectSession",
      target: "alpha app inside code directory"
    }
  );
});

test("parseApprovalTargetPayload keeps multi-word project targets intact", () => {
  assert.deepEqual(parseApprovalTargetPayload("alpha checkin session", "accept"), {
    decision: "acceptForSession",
    targetToken: "alpha checkin"
  });
  assert.deepEqual(parseApprovalTargetPayload("session beta checkin", "accept"), {
    decision: "acceptForSession",
    targetToken: "beta checkin"
  });
});

test("resolveThreadSelection honors numbered shortcuts from the last listed sessions", () => {
  const threads = [
    {
      id: "thread-current",
      name: "Current",
      preview: "current preview",
      updatedAt: "2026-03-28T08:00:00.000Z"
    },
    {
      id: "thread-other",
      name: "Other",
      preview: "other preview",
      updatedAt: "2026-03-28T09:00:00.000Z"
    }
  ];
  const session = {
    lastThreadChoicesAt: new Date().toISOString(),
    lastThreadChoices: [threads[1], threads[0]]
  };

  assert.equal(resolveThreadSelection(threads, "1", session).match?.id, "thread-other");
  assert.equal(resolveThreadSelection(threads, "2", {}).match?.id, "thread-other");
  assert.equal(resolveThreadSelection(threads, "3", {}).requestedShortcut, 3);
});

test("resolveProjectSelection honors numbered configured project shortcuts", () => {
  const projects = [
    { alias: "main", workspace: "/workspace/main" },
    { alias: "alpha-app", workspace: "/workspace/alpha-app" }
  ];

  assert.equal(resolveProjectSelection(projects, "2").match?.alias, "alpha-app");
  assert.equal(resolveProjectSelection(projects, "3").requestedShortcut, 3);
  assert.equal(resolveProjectSelection(projects, "alpha-app").match, null);
});

test("buildDangerFullAccessConfirmationMessage keeps the active-project confirmation short", () => {
  assert.equal(
    buildDangerFullAccessConfirmationMessage({
      projectAlias: "alpha-checkin",
      confirmationCode: "263593",
      activeProjectAlias: "alpha-checkin"
    }),
    [
      "Danger full access for alpha-checkin disables sandboxing and approval prompts.",
      "Reply /dfa 263593 within 1 minute."
    ].join("\n")
  );
});

test("buildDangerFullAccessConfirmationMessage includes the project when confirming another project", () => {
  assert.equal(
    buildDangerFullAccessConfirmationMessage({
      projectAlias: "alpha-checkin",
      confirmationCode: "263593",
      activeProjectAlias: "codex-whatsapp"
    }),
    [
      "Danger full access for alpha-checkin disables sandboxing and approval prompts.",
      "Reply /dfa alpha-checkin 263593 within 1 minute."
    ].join("\n")
  );
});

test("requiresTextConfirmationForVoicePrompt flags high-impact repo actions", () => {
  assert.equal(requiresTextConfirmationForVoicePrompt("merge PR 49 to main"), true);
  assert.equal(
    requiresTextConfirmationForVoicePrompt("release this version after tagging it"),
    true
  );
  assert.equal(
    requiresTextConfirmationForVoicePrompt("delete the current branch after the release"),
    true
  );
  assert.equal(requiresTextConfirmationForVoicePrompt("review PR 49 for regressions"), false);
  assert.equal(requiresTextConfirmationForVoicePrompt("explain the merge strategy"), false);
  assert.equal(requiresTextConfirmationForVoicePrompt("review the release notes"), false);
  assert.equal(requiresTextConfirmationForVoicePrompt("delete button is broken"), false);
});

test("shouldSplitCompoundVoiceControlRequest catches project-switch instructions chained with another action", () => {
  assert.equal(
    shouldSplitCompoundVoiceControlRequest(
      "switch to kiosk project and then review PR 48"
    ),
    true
  );
  assert.equal(
    shouldSplitCompoundVoiceControlRequest(
      "review PR 49 and check for regressions"
    ),
    false
  );
});

test("formatProjectRunReplyPrefix marks background completions clearly", () => {
  assert.equal(
    formatProjectRunReplyPrefix({
      projectAlias: "alpha-checkin",
      threadId: "019d39a1-9e5b-7bc2-b6e6-36f74d0c079d",
      activeProjectAlias: "beta-checkin"
    }),
    [
      "Background result from alpha-checkin session 019d39a1 completed.",
      "You are currently in beta-checkin."
    ].join("\n")
  );
});

test("applyRunLifecycleEvent tracks live progress and approvals for an active run", () => {
  const activeRun = {
    status: "starting",
    threadId: null,
    progressPhase: null,
    progressPreview: null,
    lastEventAt: null,
    lastProgressAt: null
  };

  applyRunLifecycleEvent(
    activeRun,
    {
      type: "turnStarted",
      threadId: "thread-backend"
    },
    "2026-03-30T10:00:00.000Z"
  );
  assert.equal(activeRun.status, "running");
  assert.equal(activeRun.threadId, "thread-backend");

  applyRunLifecycleEvent(
    activeRun,
    {
      type: "agentMessageDelta",
      phase: "analysis",
      text: "  Reviewing the failing tests for the active project.  "
    },
    "2026-03-30T10:00:02.000Z"
  );
  assert.equal(activeRun.status, "running");
  assert.equal(activeRun.progressPhase, "analysis");
  assert.equal(activeRun.progressPreview, "Reviewing the failing tests for the active project.");
  assert.equal(activeRun.lastProgressAt, "2026-03-30T10:00:02.000Z");

  applyRunLifecycleEvent(
    activeRun,
    {
      type: "approvalRequested"
    },
    "2026-03-30T10:00:03.000Z"
  );
  assert.equal(activeRun.status, "waiting_for_approval");
  assert.equal(activeRun.lastEventAt, "2026-03-30T10:00:03.000Z");
});

test("WhatsAppControllerBridge summary reports the active project's thread id", () => {
  const bridge = new WhatsAppControllerBridge({
    runtime: {},
    configStore: {
      data: {
        defaultProject: "alpha-app",
        permissionLevel: "workspace-write"
      }
    },
    stateStore: {
      data: {
        process: {}
      },
      listSessions() {
        return [
          {
            phoneKey: "123",
            activeProject: "alpha-app",
            projects: {
              "alpha-app": {
                threadId: "thread-backend",
                permissionLevel: "workspace-write"
              }
            }
          }
        ];
      },
      getSession() {
        return {
          phoneKey: "123",
          activeProject: "alpha-app",
          projects: {
            "alpha-app": {
              threadId: "thread-backend",
              permissionLevel: "workspace-write"
            }
          }
        };
      }
    }
  });
  bridge.activeRuns.set("project:123:alpha-app", {
    status: "running",
    progressPreview: "Reviewing the failing tests",
    lastEventAt: "2026-03-30T10:00:00.000Z"
  });

  const summary = bridge.summary();
  assert.equal(summary.sessions[0].threadId, "thread-backend");
  assert.equal(summary.sessions[0].runStatus, "running");
  assert.equal(summary.sessions[0].runPreview, "Reviewing the failing tests");
});

test("renderSessionStatus includes live run status and preview for active projects", () => {
  const bridge = new WhatsAppControllerBridge({
    runtime: {},
    configStore: {
      data: {
        defaultProject: "alpha-app",
        permissionLevel: "workspace-write"
      }
    },
    stateStore: {
      data: {
        process: {}
      },
      getSession() {
        return {
          phoneKey: "123",
          activeProject: "alpha-app",
          projects: {
            "alpha-app": {
              threadId: "thread-backend",
              permissionLevel: "workspace-write"
            }
          }
        };
      }
    }
  });
  bridge.activeRuns.set("project:123:alpha-app", {
    status: "finalizing",
    progressPreview: "Preparing the final answer",
    lastProgressAt: "2026-03-30T10:00:04.000Z"
  });

  const status = bridge.renderSessionStatus("123");
  assert.match(status, /run_status: finalizing/);
  assert.match(status, /run_preview: Preparing the final answer/);
  assert.match(status, /run_progress_at: 2026-03-30T10:00:04.000Z/);
});

test("renderSessionStatus includes queued message counts for project and btw scopes", () => {
  const bridge = new WhatsAppControllerBridge({
    runtime: {},
    configStore: {
      data: {
        defaultProject: "alpha-app",
        permissionLevel: "workspace-write"
      }
    },
    stateStore: {
      data: {
        process: {}
      },
      getSession() {
        return {
          phoneKey: "123",
          activeProject: "alpha-app",
          projects: {
            "alpha-app": {
              threadId: "thread-backend",
              permissionLevel: "workspace-write",
              queuedPrompts: [
                { prompt: "follow up 1" },
                { prompt: "follow up 2" }
              ]
            }
          },
          btw: {
            queuedPrompts: [{ prompt: "side question" }]
          }
        };
      }
    }
  });

  assert.match(bridge.renderSessionStatus("123"), /queued_messages: 2/);
  assert.match(bridge.renderSessionStatus("123", "btw"), /queued_messages: 1/);
});

test("runNextQueuedPrompt dequeues and dispatches the next queued prompt", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-bridge-test-"));
  const filePath = path.join(tempDir, "controller-state.json");

  try {
    const stateStore = new ControllerStateStore(filePath);
    await stateStore.load();
    await stateStore.upsertSession("123", {
      phoneKey: "123",
      activeProject: "alpha-app",
      remoteJid: "123@s.whatsapp.net",
      label: "Test User",
      projects: {
        "alpha-app": {
          threadId: "thread-backend",
          queuedPrompts: [
            {
              prompt: "review the failing tests",
              queuedAt: "2026-03-30T10:00:00.000Z",
              forceNewThread: false
            }
          ]
        }
      }
    });

    const bridge = new WhatsAppControllerBridge({
      runtime: {},
      configStore: {
        data: {
          defaultProject: "alpha-app",
          permissionLevel: "workspace-write"
        }
      },
      stateStore
    });

    const dispatched = [];
    bridge.runPrompt = async (args) => {
      dispatched.push(args);
    };

    const handled = await bridge.runNextQueuedPrompt({
      phoneKey: "123",
      remoteJid: "123@s.whatsapp.net",
      label: "Test User",
      scopeType: "project",
      projectAlias: "alpha-app"
    });

    assert.equal(handled, true);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].prompt, "review the failing tests");
    assert.equal(dispatched[0].statusPrelude, "Running your queued follow-up in alpha-app now.");
    assert.equal(
      stateStore.getSession("123").projects["alpha-app"].queuedPrompts.length,
      0
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("stopActiveRun clears queued follow-ups for the stopped project scope", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-bridge-stop-test-"));
  const filePath = path.join(tempDir, "controller-state.json");

  try {
    const stateStore = new ControllerStateStore(filePath);
    await stateStore.load();
    await stateStore.upsertSession("123", {
      phoneKey: "123",
      activeProject: "alpha-app",
      remoteJid: "123@s.whatsapp.net",
      label: "Test User",
      projects: {
        "alpha-app": {
          threadId: "thread-backend",
          queuedPrompts: [
            { prompt: "follow up 1", queuedAt: "2026-03-30T10:00:00.000Z" },
            { prompt: "follow up 2", queuedAt: "2026-03-30T10:00:05.000Z" }
          ]
        }
      }
    });

    const bridge = new WhatsAppControllerBridge({
      runtime: {},
      configStore: {
        data: {
          defaultProject: "alpha-app",
          permissionLevel: "workspace-write"
        }
      },
      stateStore
    });

    const replies = [];
    bridge.sendReply = async (_remoteJid, text) => {
      replies.push(text);
    };
    bridge.activeRuns.set("project:123:alpha-app", {
      cancelled: false,
      pendingApproval: null,
      interrupt: async () => {},
      child: {
        killed: true,
        kill() {}
      }
    });

    await bridge.stopActiveRun("123", "123@s.whatsapp.net", "");

    assert.equal(
      stateStore.getSession("123").projects["alpha-app"].queuedPrompts.length,
      0
    );
    assert.match(replies[0], /Cleared 2 queued follow-up messages for this scope\./);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("buildVoiceReplyTextCompanion extracts actionable artifacts for spoken replies", () => {
  assert.equal(
    buildVoiceReplyTextCompanion(
      [
        "Preview is ready.",
        "Open https://example.com/preview/123",
        "Then run /project beta-checkin",
        "Confirmation code: 263593"
      ].join("\n")
    ),
    [
      "Open https://example.com/preview/123",
      "Then run /project beta-checkin",
      "Confirmation code: 263593"
    ].join("\n")
  );
});

test("normalizeVoiceCommandText removes accents and punctuation", () => {
  assert.equal(
    normalizeVoiceCommandText("  Start over, please! "),
    "start over please"
  );
});

test("parseVoiceTranscript maps exact spoken control commands conservatively", () => {
  assert.deepEqual(parseVoiceTranscript("help"), { type: "help" });
  assert.deepEqual(parseVoiceTranscript("status"), { type: "status", payload: "" });
  assert.deepEqual(parseVoiceTranscript("stop"), { type: "stop", payload: "" });
  assert.deepEqual(parseVoiceTranscript("cancel"), {
    type: "approvalDecision",
    decision: "cancel",
    payload: ""
  });
  assert.deepEqual(parseVoiceTranscript("new session"), { type: "new", prompt: "" });
  assert.deepEqual(parseVoiceTranscript("please fix the checkout button"), {
    type: "prompt",
    prompt: "please fix the checkout button"
  });
});

test("parseVoiceTranscript respects captureAllDirectMessages when no voice command matches", () => {
  assert.deepEqual(parseVoiceTranscript("please fix the checkout button", false), {
    type: "ignored"
  });
});

test("parseVoiceTranscript extracts one-shot voice replies from spoken prompts", () => {
  assert.deepEqual(
    parseVoiceTranscript("reply in voice at 2x explain what changed in this PR"),
    {
      type: "prompt",
      prompt: "explain what changed in this PR",
      voiceReply: {
        enabled: true,
        speed: "2x"
      }
    }
  );
});

test("parseVoiceReplyCommandPayload parses status and speed controls", () => {
  assert.deepEqual(parseVoiceReplyCommandPayload(""), { action: "status" });
  assert.deepEqual(parseVoiceReplyCommandPayload("on"), {
    action: "on",
    speed: "1x"
  });
  assert.deepEqual(parseVoiceReplyCommandPayload("on 2x"), {
    action: "on",
    speed: "2x"
  });
  assert.deepEqual(parseVoiceReplyCommandPayload("2x"), {
    action: "on",
    speed: "2x"
  });
  assert.deepEqual(parseVoiceReplyCommandPayload("off"), { action: "off" });
});

test("extractOneShotVoiceReplyRequest pulls a one-off spoken reply directive out of text", () => {
  assert.deepEqual(
    extractOneShotVoiceReplyRequest(
      "Reply in voice at 2x explain what changed in this PR"
    ),
    {
      prompt: "explain what changed in this PR",
      voiceReply: {
        enabled: true,
        speed: "2x"
      }
    }
  );
});

test("extractOneShotVoiceReplyRequest accepts transcribed speed variants like onex", () => {
  assert.deepEqual(
    extractOneShotVoiceReplyRequest(
      "Reply in voice at onex what project are we working on"
    ),
    {
      prompt: "what project are we working on",
      voiceReply: {
        enabled: true,
        speed: "1x"
      }
    }
  );
});

test("buildVoiceReplyPrompt instructs Codex to emit a hidden reply language tag", () => {
  const prompt = buildVoiceReplyPrompt("Explain the change.");
  assert.match(prompt, /\[\[reply_language:<language-code>\]\]/);
  assert.match(prompt, /for example en, es, it, or pt-BR/i);
  assert.match(prompt, /do not mention the metadata/i);
});

test("extractVoiceReplyEnvelope strips the language tag before delivery", () => {
  assert.deepEqual(
    extractVoiceReplyEnvelope("[[reply_language:pt-BR]]\nClaro, eu te dou o resumo curto agora."),
    {
      text: "Claro, eu te dou o resumo curto agora.",
      languageId: "pt-br",
      hasLanguageTag: true
    }
  );
  assert.deepEqual(extractVoiceReplyEnvelope("Plain reply"), {
    text: "Plain reply",
    languageId: null,
    hasLanguageTag: false
  });
});

test("extractVoiceReplyEnvelope tolerates whitespace and never falls back to the raw tag", () => {
  assert.deepEqual(
    extractVoiceReplyEnvelope(" \n [[ reply_language : es ]] \n Hola."),
    {
      text: "Hola.",
      languageId: "es",
      hasLanguageTag: true
    }
  );
  assert.deepEqual(extractVoiceReplyEnvelope("[[reply_language:it]]"), {
    text: "",
    languageId: "it",
    hasLanguageTag: true
  });
});

test("normalizePermissionLevel accepts short aliases", () => {
  assert.equal(normalizePermissionLevel("ro"), "read-only");
  assert.equal(normalizePermissionLevel("ww"), "workspace-write");
  assert.equal(normalizePermissionLevel("dfa"), "danger-full-access");
  assert.equal(normalizePermissionLevel("read only"), "read-only");
  assert.equal(normalizePermissionLevel("workspace write"), "workspace-write");
  assert.equal(normalizePermissionLevel("danger full access"), "danger-full-access");
});

test("parseImplicitProjectCommand stays conservative and requires the new-session phrasing", () => {
  assert.equal(parseImplicitProjectCommand("switch to alpha app"), null);
  assert.deepEqual(
    parseImplicitProjectCommand("please start a new project session in alpha app"),
    {
      type: "newProjectSession",
      target: "alpha app"
    }
  );
});

test("sanitizeReplyTextForWhatsApp unwraps markdown links and code fences into copy-safe text", () => {
  assert.equal(
    sanitizeReplyTextForWhatsApp(
      "Use:\n\n```text\n/project /workspace/current-project\n```\n\nSee [README](/workspace/current-project/README.md)."
    ),
    [
      "Use:",
      "",
      "/project /workspace/current-project",
      "",
      "See /workspace/current-project/README.md."
    ].join("\n")
  );
});
