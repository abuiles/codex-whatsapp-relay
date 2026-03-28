import test from "node:test";
import assert from "node:assert/strict";

import {
  extractOneShotVoiceReplyRequest,
  parseVoiceReplyCommandPayload,
  normalizeVoiceCommandText,
  parseVoiceTranscript
} from "./controller-bridge.mjs";

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
