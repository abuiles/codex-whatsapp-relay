import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ControllerStateStore } from "./controller-state.mjs";

test("ControllerStateStore migrates legacy single-session fields into the active project", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-state-test-"));
  const filePath = path.join(tempDir, "controller-state.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        sessions: {
          "123": {
            phoneKey: "123",
            threadId: "thread-123",
            permissionLevel: "workspace-write",
            voiceReply: {
              enabled: true,
              speed: "2x"
            }
          }
        }
      }),
      "utf8"
    );

    const store = new ControllerStateStore(filePath);
    await store.load();
    const session = store.getSession("123");

    assert.equal(session.activeProject, "main");
    assert.equal(session.voiceReply.enabled, true);
    assert.equal(session.projects.main.threadId, "thread-123");
    assert.equal(session.projects.main.permissionLevel, "workspace-write");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerStateStore keeps separate project buckets per chat", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-state-test-"));
  const filePath = path.join(tempDir, "controller-state.json");

  try {
    const store = new ControllerStateStore(filePath);
    await store.load();
    await store.upsertSession("123", {
      phoneKey: "123",
      activeProject: "alpha-app",
      projects: {
        "alpha-app": {
          threadId: "thread-backend"
        },
        "beta-app": {
          threadId: "thread-frontend"
        }
      }
    });

    const session = store.getSession("123");
    assert.equal(session.activeProject, "alpha-app");
    assert.equal(session.projects["alpha-app"].threadId, "thread-backend");
    assert.equal(session.projects["beta-app"].threadId, "thread-frontend");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerStateStore strips legacy project fields from the top chat session after migration", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-state-test-"));
  const filePath = path.join(tempDir, "controller-state.json");

  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        sessions: {
          "123": {
            phoneKey: "123",
            activeProject: "alpha-app",
            threadId: "thread-backend",
            lastErrorAt: "2026-03-29T12:33:19.105Z",
            lastError: "Voice transcription failed: Voice note transcription was empty.",
            projects: {
              "alpha-app": {
                threadId: "thread-backend"
              },
              "beta-app": {
                threadId: "thread-frontend"
              }
            }
          }
        }
      }),
      "utf8"
    );

    const store = new ControllerStateStore(filePath);
    await store.load();
    await store.save();

    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    const session = saved.sessions["123"];

    assert.equal(session.threadId, undefined);
    assert.equal(session.lastErrorAt, undefined);
    assert.equal(session.lastError, undefined);
    assert.equal(session.projects["alpha-app"].lastErrorAt, "2026-03-29T12:33:19.105Z");
    assert.equal(
      session.projects["alpha-app"].lastError,
      "Voice transcription failed: Voice note transcription was empty."
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("ControllerStateStore persists queued prompts per project and btw scope", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "controller-state-test-"));
  const filePath = path.join(tempDir, "controller-state.json");

  try {
    const store = new ControllerStateStore(filePath);
    await store.load();
    await store.upsertSession("123", {
      phoneKey: "123",
      activeProject: "alpha-app",
      projects: {
        "alpha-app": {
          queuedPrompts: [
            {
              prompt: "review the failing tests",
              queuedAt: "2026-03-30T10:00:00.000Z",
              forceNewThread: false
            },
            {
              prompt: "  ",
              queuedAt: "2026-03-30T10:00:05.000Z",
              forceNewThread: false
            }
          ]
        }
      },
      btw: {
        queuedPrompts: [
          {
            prompt: "what changed in the release?",
            queuedAt: "2026-03-30T10:01:00.000Z",
            forceNewThread: true,
            voiceReplyOverride: {
              enabled: true,
              speed: "2x"
            }
          }
        ]
      }
    });

    const session = store.getSession("123");
    assert.equal(session.projects["alpha-app"].queuedPrompts.length, 1);
    assert.equal(session.projects["alpha-app"].queuedPrompts[0].prompt, "review the failing tests");
    assert.equal(session.btw.queuedPrompts.length, 1);
    assert.equal(session.btw.queuedPrompts[0].voiceReplyOverride.enabled, true);
    assert.equal(session.btw.queuedPrompts[0].voiceReplyOverride.speed, "2x");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
