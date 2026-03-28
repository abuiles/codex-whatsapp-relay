import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TTS_PROVIDER,
  DEFAULT_VOICE_REPLY_SPEED,
  normalizeSpeechLanguageId,
  normalizeTtsProvider,
  normalizeVoiceReplySpeed,
  synthesizeVoiceReply
} from "./voice-replier.mjs";

function parseArgs(argv) {
  const args = {
    text: "Testing local voice replies.",
    output: "",
    provider: DEFAULT_TTS_PROVIDER,
    speed: DEFAULT_VOICE_REPLY_SPEED,
    languageId: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    switch (token) {
      case "--text":
        if (value) {
          args.text = value;
          index += 1;
        }
        break;
      case "--output":
        if (value) {
          args.output = value;
          index += 1;
        }
        break;
      case "--provider":
        if (value) {
          args.provider = value;
          index += 1;
        }
        break;
      case "--speed":
        if (value) {
          args.speed = value;
          index += 1;
        }
        break;
      case "--language-id":
      case "--lang":
        if (value) {
          args.languageId = value;
          index += 1;
        }
        break;
      default:
        break;
    }
  }

  return {
    text: args.text,
    output: args.output,
    provider: normalizeTtsProvider(args.provider, DEFAULT_TTS_PROVIDER),
    speed: normalizeVoiceReplySpeed(args.speed, DEFAULT_VOICE_REPLY_SPEED),
    languageId: normalizeSpeechLanguageId(args.languageId)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const synthesized = await synthesizeVoiceReply({
    text: options.text,
    provider: options.provider,
    speed: options.speed,
    languageIdHint: options.languageId
  });
  const outputFile =
    options.output ||
    path.join(os.tmpdir(), `whatsapp-relay-tts-smoke-${options.provider}-${Date.now()}.ogg`);

  await fs.writeFile(outputFile, synthesized.audioBuffer);
  console.log(
    JSON.stringify(
      {
        provider: synthesized.provider,
        speed: synthesized.speed,
        locale: synthesized.locale,
        languageId: synthesized.languageId ?? options.languageId ?? null,
        voice: synthesized.voice,
        seconds: synthesized.seconds,
        outputFile
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
