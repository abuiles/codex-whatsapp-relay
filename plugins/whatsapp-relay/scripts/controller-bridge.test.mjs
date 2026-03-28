import test from "node:test";
import assert from "node:assert/strict";

import {
  extractOneShotVoiceReplyRequest,
  parseVoiceReplyCommandPayload,
  normalizeVoiceCommandText,
  parseIncomingCommand,
  parseVoiceTranscript,
  resolveThreadSelection
} from "./controller-bridge.mjs";
import { normalizePermissionLevel } from "./controller-permissions.mjs";

test("parseIncomingCommand accepts shortcut aliases for admin commands", () => {
  assert.deepEqual(parseIncomingCommand("/h", true), { type: "help" });
  assert.deepEqual(parseIncomingCommand("/st", true), { type: "status" });
  assert.deepEqual(parseIncomingCommand("/n review this diff", true), {
    type: "new",
    prompt: "review this diff"
  });
  assert.deepEqual(parseIncomingCommand("/ls", true), { type: "sessions" });
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
  assert.deepEqual(parseIncomingCommand("/voice on 2x", true), {
    type: "voiceReplySettings",
    payload: "on 2x"
  });
  assert.deepEqual(parseIncomingCommand("/a session", true), {
    type: "approvalDecision",
    decision: "acceptForSession"
  });
  assert.deepEqual(parseIncomingCommand("/d", true), {
    type: "approvalDecision",
    decision: "decline"
  });
  assert.deepEqual(parseIncomingCommand("/q", true), {
    type: "approvalDecision",
    decision: "cancel"
  });
  assert.deepEqual(parseIncomingCommand("/x", true), { type: "stop" });
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

test("normalizeVoiceCommandText removes accents and punctuation", () => {
  assert.equal(
    normalizeVoiceCommandText("  Start over, please! "),
    "start over please"
  );
});

test("parseVoiceTranscript maps exact spoken control commands conservatively", () => {
  assert.deepEqual(parseVoiceTranscript("help"), { type: "help" });
  assert.deepEqual(parseVoiceTranscript("status"), { type: "status" });
  assert.deepEqual(parseVoiceTranscript("stop"), { type: "stop" });
  assert.deepEqual(parseVoiceTranscript("cancel"), {
    type: "approvalDecision",
    decision: "cancel"
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

test("normalizePermissionLevel accepts short aliases", () => {
  assert.equal(normalizePermissionLevel("ro"), "read-only");
  assert.equal(normalizePermissionLevel("ww"), "workspace-write");
  assert.equal(normalizePermissionLevel("dfa"), "danger-full-access");
});
