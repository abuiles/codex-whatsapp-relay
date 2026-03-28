import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSpokenReplyText,
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
