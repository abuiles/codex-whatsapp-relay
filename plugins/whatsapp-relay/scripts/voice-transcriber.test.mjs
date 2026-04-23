import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSttProvider,
  parseWhisperCppTranscript
} from "./voice-transcriber.mjs";

test("normalizeSttProvider accepts Parakeet and whisper.cpp aliases", () => {
  assert.equal(normalizeSttProvider("parakeet"), "parakeet-mlx");
  assert.equal(normalizeSttProvider("mlx"), "parakeet-mlx");
  assert.equal(normalizeSttProvider("whisper.cpp"), "whisper-cpp");
  assert.equal(normalizeSttProvider("whispercpp"), "whisper-cpp");
  assert.equal(normalizeSttProvider("weird", "whisper-cpp"), "whisper-cpp");
});

test("parseWhisperCppTranscript extracts text and segment timing", () => {
  const parsed = parseWhisperCppTranscript({
    result: {
      language: "fr"
    },
    transcription: [
      {
        timestamps: {
          from: "00:00:00,000",
          to: "00:00:01,500"
        },
        offsets: {
          from: 0,
          to: 1500
        },
        text: "Bonjour Codex."
      },
      {
        timestamps: {
          from: "00:00:01,500",
          to: "00:00:03,000"
        },
        text: "Peux-tu verifier le projet ?"
      }
    ]
  });

  assert.equal(parsed.transcript, "Bonjour Codex. Peux-tu verifier le projet ?");
  assert.equal(parsed.language, "fr");
  assert.equal(parsed.sentences[0].start, 0);
  assert.equal(parsed.sentences[0].end, 1.5);
  assert.equal(parsed.sentences[1].start, 1.5);
  assert.equal(parsed.sentences[1].end, 3);
});
