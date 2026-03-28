import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpokenReplyText,
  normalizeTtsProvider,
  normalizeVoiceReplySpeed
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

test("buildSpokenReplyText keeps spanish output suitable for system fallback", () => {
  const spoken = buildSpokenReplyText(
    "Claro, te respondo en espanol y te doy el resumen corto para escucharlo."
  );

  assert.match(spoken, /espanol/i);
});
