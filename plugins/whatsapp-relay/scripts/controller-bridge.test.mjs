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
    normalizeVoiceCommandText("  Nueva sesión, por favor! "),
    "nueva sesion por favor"
  );
});

test("parseVoiceTranscript maps exact spoken control commands conservatively", () => {
  assert.deepEqual(parseVoiceTranscript("Ayuda"), { type: "help" });
  assert.deepEqual(parseVoiceTranscript("estado"), { type: "status" });
  assert.deepEqual(parseVoiceTranscript("detente"), { type: "stop" });
  assert.deepEqual(parseVoiceTranscript("cancelar"), {
    type: "approvalDecision",
    decision: "cancel"
  });
  assert.deepEqual(parseVoiceTranscript("nueva sesión"), { type: "new", prompt: "" });
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
      "Respondeme en voz a 2x explicame que cambio en este PR"
    ),
    {
      prompt: "explicame que cambio en este PR",
      voiceReply: {
        enabled: true,
        speed: "2x"
      }
    }
  );
});

test("extractOneShotVoiceReplyRequest accepts transcribed speed variants like unox", () => {
  assert.deepEqual(
    extractOneShotVoiceReplyRequest(
      "Respóndeme en voz a unox en qué proyecto estamos trabajando"
    ),
    {
      prompt: "en qué proyecto estamos trabajando",
      voiceReply: {
        enabled: true,
        speed: "1x"
      }
    }
  );
});
