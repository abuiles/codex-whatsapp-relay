import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpokenReplyText,
  detectSpeechLanguageId,
  detectSpeechLocale,
  normalizeSpeechLanguageId,
  normalizeTtsProvider,
  normalizeVoiceReplySpeed,
  resolveEffectiveTtsProvider
} from "./voice-replier.mjs";

test("normalizeVoiceReplySpeed accepts supported playback speeds", () => {
  assert.equal(normalizeVoiceReplySpeed("1x"), "1x");
  assert.equal(normalizeVoiceReplySpeed("2x"), "2x");
  assert.equal(normalizeVoiceReplySpeed("weird", "2x"), "2x");
});

test("buildSpokenReplyText strips markdown and raw links for speech", () => {
  const spoken = buildSpokenReplyText(`
# Summary

Look at this [link](https://example.com/demo) and this command:

\`\`\`bash
npm test
\`\`\`

Also visit https://example.com/raw-url
  `);

  assert.match(spoken, /Summary/);
  assert.match(spoken, /link/);
  assert.doesNotMatch(spoken, /https?:\/\//);
  assert.doesNotMatch(spoken, /```/);
});

test("normalizeTtsProvider accepts system and chatterbox aliases", () => {
  assert.equal(normalizeTtsProvider("system"), "system");
  assert.equal(normalizeTtsProvider("say"), "system");
  assert.equal(normalizeTtsProvider("chatterbox"), "chatterbox-turbo");
  assert.equal(normalizeTtsProvider("chatterbox-turbo"), "chatterbox-turbo");
  assert.equal(normalizeTtsProvider("weird", "system"), "system");
});

test("buildSpokenReplyText keeps spanish output suitable for voice synthesis", () => {
  const spoken = buildSpokenReplyText(
    "Claro, te respondo en espanol y te doy el resumen corto para escucharlo."
  );

  assert.match(spoken, /espanol/i);
});

test("detectSpeechLocale returns supported language ids when local detection can infer them", () => {
  assert.equal(detectSpeechLocale("Please give me the short answer in voice."), "en");
  assert.equal(detectSpeechLocale("Claro, te doy el resumen corto ahora."), "es");
  assert.equal(detectSpeechLocale("Bonjour, je peux te faire un resume rapide."), "fr");
});

test("detectSpeechLanguageId recognizes supported languages for Chatterbox routing", () => {
  assert.equal(detectSpeechLanguageId("Please give me the short answer in voice."), "en");
  assert.equal(detectSpeechLanguageId("Claro, te doy el resumen corto ahora."), "es");
  assert.equal(detectSpeechLanguageId("Claro, eu te dou o resumo curto agora."), "pt");
  assert.equal(detectSpeechLanguageId("Certo, ti do il riassunto breve adesso."), "it");
  assert.equal(
    detectSpeechLanguageId(
      "Bonjour, je peux te faire un resume rapide et clair si tu veux."
    ),
    "fr"
  );
});

test("normalizeSpeechLanguageId accepts Codex hints and BCP 47 variants", () => {
  assert.equal(normalizeSpeechLanguageId("es"), "es");
  assert.equal(normalizeSpeechLanguageId("pt-BR"), "pt");
  assert.equal(normalizeSpeechLanguageId("eng"), "en");
  assert.equal(normalizeSpeechLanguageId("iw"), "he");
  assert.equal(normalizeSpeechLanguageId(""), null);
});

test("resolveEffectiveTtsProvider keeps Chatterbox on for supported multilingual replies by default", () => {
  const previous = process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH;
  process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH = "1";

  try {
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", "en"), "chatterbox-turbo");
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", "es"), "chatterbox-turbo");
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", "pt"), "chatterbox-turbo");
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", "it"), "chatterbox-turbo");
    assert.equal(resolveEffectiveTtsProvider("system", "es"), "system");
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH;
    } else {
      process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH = previous;
    }
  }
});

test("resolveEffectiveTtsProvider can still force system fallback for non-English replies", () => {
  const previous = process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH;
  process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH = "0";

  try {
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", "es"), "system");
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", "pt"), "system");
    assert.equal(resolveEffectiveTtsProvider("chatterbox-turbo", null), "system");
  } finally {
    if (previous === undefined) {
      delete process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH;
    } else {
      process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH = previous;
    }
  }
});
