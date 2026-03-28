import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginRoot } from "./paths.mjs";

export const DEFAULT_VOICE_REPLY_SPEED = "1x";
export const DEFAULT_TTS_PROVIDER = normalizeTtsProvider(
  process.env.WHATSAPP_RELAY_TTS_PROVIDER,
  "system"
);

const MAX_SPOKEN_REPLY_CHARS = resolvePositiveInt(
  process.env.WHATSAPP_RELAY_TTS_MAX_CHARS,
  1_200
);
const DEFAULT_TIMEOUT_MS = resolvePositiveInt(
  process.env.WHATSAPP_RELAY_TTS_TIMEOUT_MS,
  2 * 60 * 1000
);
const DEFAULT_CHATTERBOX_PYTHON = path.join(pluginRoot, ".venv-chatterbox", "bin", "python");
const DEFAULT_CHATTERBOX_DEVICE = normalizeChatterboxDevice(
  process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_DEVICE,
  "auto"
);
const CHATTERBOX_AUDIO_PROMPT = String(
  process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_AUDIO_PROMPT ?? ""
).trim();
const CHATTERBOX_TTS_SCRIPT = path.join(pluginRoot, "scripts", "chatterbox_tts.py");

let voiceCachePromise = null;

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeVoiceReplySpeed(value, fallback = DEFAULT_VOICE_REPLY_SPEED) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "1x" || normalized === "2x") {
    return normalized;
  }

  return fallback;
}

export function normalizeTtsProvider(value, fallback = DEFAULT_TTS_PROVIDER) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  switch (normalized) {
    case "system":
    case "say":
    case "macos":
      return "system";
    case "chatterbox":
    case "chatterbox-turbo":
    case "turbo":
      return "chatterbox-turbo";
    default:
      return fallback;
  }
}

function isTruthyEnv(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function normalizeChatterboxDevice(value, fallback = "auto") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "cpu" || normalized === "mps" || normalized === "auto") {
    return normalized;
  }

  return fallback;
}

export function resolveEffectiveTtsProvider(provider, locale) {
  const normalizedProvider = normalizeTtsProvider(provider, DEFAULT_TTS_PROVIDER);
  if (
    normalizedProvider === "chatterbox-turbo" &&
    locale !== "en" &&
    !isTruthyEnv(process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH)
  ) {
    return "system";
  }

  return normalizedProvider;
}

function normalizeLocaleSample(text) {
  return ` ${String(text ?? "")
    .toLowerCase()
    .replace(/[?!.,;:()[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function summarizeCommand(command, args) {
  return [command, ...args].join(" ");
}

function summarizeFailure(command, args, stderr, stdout, signal, code) {
  const output = [String(stderr ?? "").trim(), String(stdout ?? "").trim()]
    .filter(Boolean)
    .join("\n");
  const exitText = signal ? `signal ${signal}` : `exit code ${code}`;
  const preview = output ? `\n${output.slice(0, 800)}` : "";
  return `Command failed (${exitText}): ${summarizeCommand(command, args)}${preview}`;
}

async function runCommand(command, args, { timeoutMs, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let closed = false;
    let timeout = null;

    if (timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!closed && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 250).unref();
      }, timeoutMs);
      timeout.unref();
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      closed = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (timedOut) {
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms: ${summarizeCommand(command, args)}`
          )
        );
        return;
      }

      if (code !== 0) {
        reject(new Error(summarizeFailure(command, args, stderr, stdout, signal, code)));
        return;
      }

      resolve({
        stdout,
        stderr
      });
    });
  });
}

function looksSpanish(text) {
  const lower = normalizeLocaleSample(text);
  const accents = /[áéíóúñ¿¡]/.test(lower);
  const spanishMarkers = [
    " el ",
    " la ",
    " los ",
    " las ",
    " que ",
    " para ",
    " con ",
    " por ",
    " una ",
    " este ",
    " esta ",
    " puedes ",
    " ahora "
  ];
  const markerHits = spanishMarkers.filter((marker) => lower.includes(marker)).length;
  return accents || markerHits >= 2;
}

function looksEnglish(text) {
  const lower = normalizeLocaleSample(text);
  const englishMarkers = [
    " the ",
    " and ",
    " you ",
    " your ",
    " this ",
    " that ",
    " with ",
    " for ",
    " from ",
    " what ",
    " how ",
    " can ",
    " could ",
    " would ",
    " should ",
    " reply ",
    " voice ",
    " summary ",
    " short ",
    " answer ",
    " thanks ",
    " please ",
    " hello ",
    " hi ",
    " i ",
    " we ",
    " it ",
    " is ",
    " are "
  ];

  return englishMarkers.filter((marker) => lower.includes(marker)).length >= 2;
}

export function detectSpeechLocale(text) {
  if (looksSpanish(text)) {
    return "es";
  }

  if (looksEnglish(text)) {
    return "en";
  }

  return "other";
}

async function listSystemVoices() {
  if (!voiceCachePromise) {
    voiceCachePromise = runCommand("say", ["-v", "?"], {
      timeoutMs: DEFAULT_TIMEOUT_MS
    })
      .then(({ stdout }) =>
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const match = line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/);
            if (!match) {
              return null;
            }
            return {
              name: match[1].trim(),
              locale: match[2]
            };
          })
          .filter(Boolean)
      )
      .catch(() => []);
  }

  return voiceCachePromise;
}

function preferredVoiceNamesForLocale(locale) {
  switch (locale) {
    case "es":
      return [
        process.env.WHATSAPP_RELAY_TTS_VOICE_ES,
        "Eddy (Spanish (Mexico))",
        "Eddy (Spanish (Spain))",
        "Flo (Spanish (Mexico))",
        "Flo (Spanish (Spain))",
        "Grandma (Spanish (Mexico))",
        "Grandpa (Spanish (Mexico))",
        "Monica"
      ].filter(Boolean);
    case "en":
      return [
        process.env.WHATSAPP_RELAY_TTS_VOICE_EN,
        "Eddy (English (US))",
        "Eddy (English (UK))",
        "Flo (English (US))",
        "Flo (English (UK))",
        "Samantha",
        "Alex",
        "Albert",
        "Daniel"
      ].filter(Boolean);
    default:
      return [];
  }
}

async function resolveVoiceName(locale) {
  const explicitDefault = String(process.env.WHATSAPP_RELAY_TTS_VOICE_DEFAULT ?? "").trim();
  if (explicitDefault) {
    return explicitDefault;
  }

  const voices = await listSystemVoices();
  if (!voices.length) {
    return null;
  }

  const preferredNames = preferredVoiceNamesForLocale(locale);
  for (const name of preferredNames) {
    if (voices.some((voice) => voice.name === name)) {
      return name;
    }
  }

  if (locale !== "es" && locale !== "en") {
    return null;
  }

  const exactLocale = locale === "es" ? "es_MX" : "en_US";
  const exactVoice = voices.find((voice) => voice.locale === exactLocale);
  if (exactVoice) {
    return exactVoice.name;
  }

  const languagePrefix = `${locale}_`;
  const prefixVoice = voices.find((voice) => voice.locale.startsWith(languagePrefix));
  if (prefixVoice) {
    return prefixVoice.name;
  }

  return null;
}

async function ensureFileExists(filePath, installHint) {
  if (!filePath.includes(path.sep)) {
    return;
  }

  try {
    await fs.access(filePath);
  } catch {
    const hint = installHint ? ` ${installHint}` : "";
    throw new Error(`Required file was not found: ${filePath}.${hint}`.trim());
  }
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, " Code omitted. ");
}

function stripInlineCode(text) {
  return text.replace(/`([^`]+)`/g, "$1");
}

function stripMarkdownLinks(text) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

function stripRawUrls(text) {
  return text.replace(/https?:\/\/\S+/g, "link");
}

function stripHeadings(text) {
  return text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
}

function normalizeBullets(text) {
  return text.replace(/^\s*[-*]\s+/gm, "• ");
}

function stripUnsupportedMarkup(text) {
  return String(text ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function collapseWhitespace(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function clipAtSentenceBoundary(text, limit) {
  if (text.length <= limit) {
    return text;
  }

  const preview = text.slice(0, limit + 1);
  const sentenceBreak = Math.max(
    preview.lastIndexOf(". "),
    preview.lastIndexOf("! "),
    preview.lastIndexOf("? "),
    preview.lastIndexOf(".\n"),
    preview.lastIndexOf("!\n"),
    preview.lastIndexOf("?\n")
  );
  if (sentenceBreak >= limit * 0.55) {
    return preview.slice(0, sentenceBreak + 1).trim();
  }

  const paragraphBreak = preview.lastIndexOf("\n\n");
  if (paragraphBreak >= limit * 0.55) {
    return preview.slice(0, paragraphBreak).trim();
  }

  const wordBreak = preview.lastIndexOf(" ");
  if (wordBreak >= limit * 0.55) {
    return preview.slice(0, wordBreak).trim();
  }

  return preview.slice(0, limit).trim();
}

export function buildSpokenReplyText(text) {
  const cleaned = collapseWhitespace(
    stripUnsupportedMarkup(
      normalizeBullets(
        stripHeadings(
          stripRawUrls(
            stripMarkdownLinks(
            stripInlineCode(
              stripCodeBlocks(text)
            )
            )
          )
        )
      )
    )
  );

  if (!cleaned) {
    return "";
  }

  if (cleaned.length <= MAX_SPOKEN_REPLY_CHARS) {
    return cleaned;
  }

  const clipped = clipAtSentenceBoundary(cleaned, MAX_SPOKEN_REPLY_CHARS);
  const locale = detectSpeechLocale(cleaned);
  if (locale === "es") {
    return `${clipped} Si quieres, te doy mas detalle en otro mensaje.`;
  }

  if (locale === "en") {
    return `${clipped} If you want, I can give more detail in another message.`;
  }

  return clipped;
}

function ffmpegArgs({ inputFile, outputFile, speed }) {
  const tempo = normalizeVoiceReplySpeed(speed);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputFile,
    "-c:a",
    "libopus",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "48k",
    "-avoid_negative_ts",
    "make_zero",
    "-filter:a",
    tempo === "2x" ? "atempo=2.0" : "atempo=1.0",
    outputFile
  ];
}

async function probeDurationSeconds(filePath) {
  try {
    const { stdout } = await runCommand(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        filePath
      ],
      {
        timeoutMs: DEFAULT_TIMEOUT_MS
      }
    );
    const duration = Number.parseFloat(stdout.trim());
    return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
  } catch {
    return null;
  }
}

function resolveChatterboxPython() {
  const explicit = String(process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_PYTHON ?? "").trim();
  return explicit || DEFAULT_CHATTERBOX_PYTHON;
}

function buildChatterboxArgs({ textFile, outputFile, device, audioPromptPath }) {
  const args = [
    CHATTERBOX_TTS_SCRIPT,
    "--text-file",
    textFile,
    "--output-file",
    outputFile,
    "--device",
    normalizeChatterboxDevice(device, DEFAULT_CHATTERBOX_DEVICE)
  ];

  if (audioPromptPath) {
    args.push("--audio-prompt-path", audioPromptPath);
  }

  return args;
}

function parseStructuredStdout(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    return {};
  }

  try {
    return JSON.parse(lastLine);
  } catch {
    return {};
  }
}

async function synthesizeWithSystemVoice({ spokenText, speed, timeoutMs, locale }) {
  const voice = await resolveVoiceName(locale);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-tts-"));

  try {
    const textFile = path.join(tempDir, "reply.txt");
    const rawAudioFile = path.join(tempDir, "reply.aiff");
    const outputFile = path.join(tempDir, "reply.ogg");

    await fs.writeFile(textFile, spokenText, "utf8");

    const sayArgs = [];
    if (voice) {
      sayArgs.push("-v", voice);
    }
    sayArgs.push("-f", textFile, "-o", rawAudioFile);
    await runCommand("say", sayArgs, { timeoutMs });
    await runCommand("ffmpeg", ffmpegArgs({ inputFile: rawAudioFile, outputFile, speed }), {
      timeoutMs
    });

    const [audioBuffer, seconds] = await Promise.all([
      fs.readFile(outputFile),
      probeDurationSeconds(outputFile)
    ]);

    return {
      audioBuffer,
      voice,
      seconds,
      mimetype: "audio/ogg; codecs=opus",
      provider: "system"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeWithChatterbox({ spokenText, speed, timeoutMs, locale }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-chatterbox-"));
  const pythonBin = resolveChatterboxPython();

  try {
    await ensureFileExists(
      pythonBin,
      "Run `npm run whatsapp:install-chatterbox` or set WHATSAPP_RELAY_TTS_CHATTERBOX_PYTHON."
    );
    await ensureFileExists(
      CHATTERBOX_TTS_SCRIPT,
      "The Chatterbox Turbo bridge script is missing from the plugin."
    );

    const textFile = path.join(tempDir, "reply.txt");
    const rawAudioFile = path.join(tempDir, "reply.wav");
    const outputFile = path.join(tempDir, "reply.ogg");
    await fs.writeFile(textFile, spokenText, "utf8");

    const { stdout } = await runCommand(
      pythonBin,
      buildChatterboxArgs({
        textFile,
        outputFile: rawAudioFile,
        device: DEFAULT_CHATTERBOX_DEVICE,
        audioPromptPath: CHATTERBOX_AUDIO_PROMPT
      }),
      { timeoutMs }
    );

    await runCommand("ffmpeg", ffmpegArgs({ inputFile: rawAudioFile, outputFile, speed }), {
      timeoutMs
    });

    const metadata = parseStructuredStdout(stdout);
    const [audioBuffer, seconds] = await Promise.all([
      fs.readFile(outputFile),
      probeDurationSeconds(outputFile)
    ]);

    return {
      audioBuffer,
      seconds,
      locale,
      device: metadata.device ?? DEFAULT_CHATTERBOX_DEVICE,
      voice: metadata.voice_mode === "clone" ? "Chatterbox Turbo clone" : "Chatterbox Turbo",
      mimetype: "audio/ogg; codecs=opus",
      provider: "chatterbox-turbo"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function synthesizeVoiceReply({
  text,
  speed = DEFAULT_VOICE_REPLY_SPEED,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  provider = DEFAULT_TTS_PROVIDER
}) {
  const spokenText = buildSpokenReplyText(text);
  if (!spokenText) {
    throw new Error("Voice reply text is empty.");
  }

  const locale = detectSpeechLocale(spokenText);
  const normalizedProvider = resolveEffectiveTtsProvider(provider, locale);

  if (normalizedProvider === "chatterbox-turbo") {
    const synthesized = await synthesizeWithChatterbox({
      spokenText,
      speed,
      timeoutMs,
      locale
    });
    return {
      ...synthesized,
      spokenText,
      locale,
      speed: normalizeVoiceReplySpeed(speed)
    };
  }

  const synthesized = await synthesizeWithSystemVoice({
    spokenText,
    speed,
    timeoutMs,
    locale
  });
  return {
    ...synthesized,
    spokenText,
    locale,
    speed: normalizeVoiceReplySpeed(speed)
  };
}
