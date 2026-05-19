import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { franc } from "franc";
import { pluginRoot } from "./paths.mjs";

export const DEFAULT_VOICE_REPLY_SPEED = "1x";
export const DEFAULT_TTS_PROVIDER = normalizeTtsProvider(
  process.env.WHATSAPP_RELAY_TTS_PROVIDER,
  process.platform === "win32" ? "system" : "chatterbox-turbo"
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
const DEFAULT_KOKORO_ROOT = path.join(pluginRoot, "tools", "kokoro-onnx");
const DEFAULT_KOKORO_PYTHON = path.join(
  DEFAULT_KOKORO_ROOT,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python"
);
const DEFAULT_KOKORO_MODEL_FILE = path.join(DEFAULT_KOKORO_ROOT, "kokoro-v1.0.onnx");
const DEFAULT_KOKORO_VOICES_FILE = path.join(DEFAULT_KOKORO_ROOT, "voices-v1.0.bin");
const CHATTERBOX_AUDIO_PROMPT = String(
  process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_AUDIO_PROMPT ?? ""
).trim();
const CHATTERBOX_TTS_SCRIPT = path.join(pluginRoot, "scripts", "chatterbox_tts.py");
const KOKORO_TTS_SCRIPT = path.join(pluginRoot, "scripts", "kokoro_tts.py");
const CHATTERBOX_FRANC_LANGUAGE_IDS = new Map([
  ["ara", "ar"],
  ["arb", "ar"],
  ["cmn", "zh"],
  ["dan", "da"],
  ["deu", "de"],
  ["ell", "el"],
  ["eng", "en"],
  ["fin", "fi"],
  ["fra", "fr"],
  ["heb", "he"],
  ["hin", "hi"],
  ["ita", "it"],
  ["jpn", "ja"],
  ["kor", "ko"],
  ["msa", "ms"],
  ["zsm", "ms"],
  ["nld", "nl"],
  ["nno", "no"],
  ["nob", "no"],
  ["nor", "no"],
  ["pol", "pl"],
  ["por", "pt"],
  ["rus", "ru"],
  ["spa", "es"],
  ["swa", "sw"],
  ["swe", "sv"],
  ["tur", "tr"],
  ["zho", "zh"]
]);
const CHATTERBOX_SUPPORTED_LANGUAGE_IDS = new Set(CHATTERBOX_FRANC_LANGUAGE_IDS.values());
const CHATTERBOX_LANGUAGE_ALIASES = new Map([
  ...CHATTERBOX_FRANC_LANGUAGE_IDS.entries(),
  ...[...CHATTERBOX_SUPPORTED_LANGUAGE_IDS].map((languageId) => [languageId, languageId]),
  ["iw", "he"],
  ["nb", "no"],
  ["nn", "no"]
]);
const KOKORO_LANGUAGE_CONFIGS = new Map([
  ["en", { lang: "en-us", voice: "af_sarah" }],
  ["es", { lang: "es", voice: "ef_dora" }],
  ["fr", { lang: "fr-fr", voice: "ff_siwis" }],
  ["hi", { lang: "hi", voice: "hf_alpha" }],
  ["it", { lang: "it", voice: "if_sara" }],
  ["ja", { lang: "ja", voice: "jf_alpha" }],
  ["pt", { lang: "pt-br", voice: "pf_dora" }],
  ["zh", { lang: "zh", voice: "zf_xiaobei" }]
]);

let voiceCachePromise = null;

function powershellBin() {
  return process.env.WHATSAPP_RELAY_TTS_POWERSHELL_BIN ?? "powershell.exe";
}

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
    case "sapi":
    case "windows":
    case "windows-sapi":
    case "win32":
      return "system";
    case "kokoro":
    case "kokoro-onnx":
      return "kokoro";
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

export function resolveEffectiveTtsProvider(provider, languageId) {
  const normalizedProvider = normalizeTtsProvider(provider, DEFAULT_TTS_PROVIDER);
  if (normalizedProvider === "kokoro") {
    return "kokoro";
  }

  if (normalizedProvider === "chatterbox-turbo" && !languageId) {
    return "system";
  }

  if (
    normalizedProvider === "chatterbox-turbo" &&
    languageId !== "en" &&
    !isTruthyEnv(process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH)
  ) {
    return "system";
  }

  return normalizedProvider;
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

export function normalizeSpeechLanguageId(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/_/g, "-");
  const direct = CHATTERBOX_LANGUAGE_ALIASES.get(normalized);
  if (direct) {
    return direct;
  }

  const base = normalized.split("-")[0];
  return CHATTERBOX_LANGUAGE_ALIASES.get(base) ?? null;
}

export function detectSpeechLocale(text) {
  return detectSpeechLanguageId(text) ?? "other";
}

export function detectSpeechLanguageId(text) {
  const sample = String(text ?? "").trim();
  if (!sample) {
    return null;
  }

  const detected = franc(sample, {
    minLength: 10,
    only: [...CHATTERBOX_FRANC_LANGUAGE_IDS.keys()]
  });
  return normalizeSpeechLanguageId(detected);
}

async function listSystemVoices() {
  if (!voiceCachePromise) {
    voiceCachePromise =
      process.platform === "win32" ? listWindowsSystemVoices() : listMacSystemVoices();
  }

  return voiceCachePromise;
}

async function listMacSystemVoices() {
  return runCommand("say", ["-v", "?"], {
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

async function listWindowsSystemVoices() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()",
    "try {",
    "  $voices = $synth.GetInstalledVoices() | ForEach-Object {",
    "    [PSCustomObject]@{ Name = $_.VoiceInfo.Name; Culture = $_.VoiceInfo.Culture.Name }",
    "  }",
    "  $voices | ConvertTo-Json -Compress",
    "} finally {",
    "  $synth.Dispose()",
    "}"
  ].join("; ");

  return runCommand(
    powershellBin(),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs: DEFAULT_TIMEOUT_MS }
  )
    .then(({ stdout }) => {
      const parsed = JSON.parse(stdout.trim() || "[]");
      const voices = Array.isArray(parsed) ? parsed : [parsed];
      return voices
        .map((voice) => ({
          name: String(voice.Name ?? "").trim(),
          locale: String(voice.Culture ?? "").trim().replace(/-/g, "_")
        }))
        .filter((voice) => voice.name);
    })
    .catch(() => []);
}

function preferredVoiceNamesForLocale(locale) {
  switch (locale) {
    case "fr":
      return [
        process.env.WHATSAPP_RELAY_TTS_VOICE_FR,
        "Microsoft Hortense Desktop",
        "Microsoft Paul Desktop",
        "Microsoft Julie Desktop",
        "Hortense",
        "Paul",
        "Julie"
      ].filter(Boolean);
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

  const exactLocales =
    locale === "es"
      ? ["es_MX", "es_ES"]
      : locale === "en"
        ? ["en_US", "en_GB"]
        : locale === "fr"
          ? ["fr_FR", "fr_CA"]
          : locale === "pt"
            ? ["pt_BR", "pt_PT"]
            : locale === "it"
              ? ["it_IT"]
              : [];
  for (const exactLocale of exactLocales) {
    const exactVoice = voices.find((voice) => voice.locale === exactLocale);
    if (exactVoice) {
      return exactVoice.name;
    }
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

function buildChatterboxArgs({ textFile, outputFile, device, audioPromptPath, languageId }) {
  const args = [
    CHATTERBOX_TTS_SCRIPT,
    "--text-file",
    textFile,
    "--output-file",
    outputFile,
    "--device",
    normalizeChatterboxDevice(device, DEFAULT_CHATTERBOX_DEVICE)
  ];

  if (languageId) {
    args.push("--language-id", languageId);
  }

  if (audioPromptPath) {
    args.push("--audio-prompt-path", audioPromptPath);
  }

  return args;
}

function resolveKokoroPython() {
  const explicit = String(process.env.WHATSAPP_RELAY_TTS_KOKORO_PYTHON ?? "").trim();
  return explicit || DEFAULT_KOKORO_PYTHON;
}

function resolveKokoroModelFile() {
  const explicit = String(process.env.WHATSAPP_RELAY_TTS_KOKORO_MODEL ?? "").trim();
  return explicit || DEFAULT_KOKORO_MODEL_FILE;
}

function resolveKokoroVoicesFile() {
  const explicit = String(process.env.WHATSAPP_RELAY_TTS_KOKORO_VOICES ?? "").trim();
  return explicit || DEFAULT_KOKORO_VOICES_FILE;
}

function normalizeKokoroLanguageId(value) {
  const normalized = normalizeSpeechLanguageId(value);
  if (normalized && KOKORO_LANGUAGE_CONFIGS.has(normalized)) {
    return normalized;
  }

  const fallback = normalizeSpeechLanguageId(
    process.env.WHATSAPP_RELAY_TTS_KOKORO_DEFAULT_LANGUAGE ?? "fr"
  );
  return fallback && KOKORO_LANGUAGE_CONFIGS.has(fallback) ? fallback : "fr";
}

export function resolveKokoroLanguageConfig(languageId) {
  const normalized = normalizeKokoroLanguageId(languageId);
  const config = KOKORO_LANGUAGE_CONFIGS.get(normalized) ?? KOKORO_LANGUAGE_CONFIGS.get("fr");
  const explicitVoice = String(process.env.WHATSAPP_RELAY_TTS_KOKORO_VOICE ?? "").trim();
  return {
    languageId: normalized,
    lang: config.lang,
    voice: explicitVoice || config.voice
  };
}

function buildKokoroArgs({
  textFile,
  outputFile,
  modelFile,
  voicesFile,
  voice,
  lang
}) {
  return [
    KOKORO_TTS_SCRIPT,
    "--text-file",
    textFile,
    "--output-file",
    outputFile,
    "--model-file",
    modelFile,
    "--voices-file",
    voicesFile,
    "--voice",
    voice,
    "--lang",
    lang,
    "--speed",
    "1.0"
  ];
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
  if (process.platform === "win32") {
    return synthesizeWithWindowsSapi({ spokenText, speed, timeoutMs, locale });
  }

  if (process.platform !== "darwin") {
    throw new Error("System TTS is only wired for Windows SAPI and macOS say.");
  }

  return synthesizeWithMacSay({ spokenText, speed, timeoutMs, locale });
}

async function synthesizeWithMacSay({ spokenText, speed, timeoutMs, locale }) {
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

async function synthesizeWithWindowsSapi({ spokenText, speed, timeoutMs, locale }) {
  const voice = await resolveVoiceName(locale);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-sapi-"));

  try {
    const textFile = path.join(tempDir, "reply.txt");
    const rawAudioFile = path.join(tempDir, "reply.wav");
    const outputFile = path.join(tempDir, "reply.ogg");
    const scriptFile = path.join(tempDir, "sapi-tts.ps1");

    await fs.writeFile(textFile, spokenText, "utf8");

    const script = [
      "param([string]$TextFile, [string]$OutputFile, [string]$VoiceName)",
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.Speech",
      "$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()",
      "try {",
      "  if ($VoiceName) { $synth.SelectVoice($VoiceName) }",
      "  $synth.SetOutputToWaveFile($OutputFile)",
      "  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)",
      "  $synth.Speak($text)",
      "} finally {",
      "  $synth.Dispose()",
      "}"
    ].join("\n");

    await fs.writeFile(scriptFile, script, "utf8");

    await runCommand(
      powershellBin(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptFile,
        textFile,
        rawAudioFile,
        voice ?? ""
      ],
      { timeoutMs }
    );

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
      provider: "windows-sapi"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeWithChatterbox({ spokenText, speed, timeoutMs, locale, languageId }) {
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
        audioPromptPath: CHATTERBOX_AUDIO_PROMPT,
        languageId
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
      languageId,
      device: metadata.device ?? DEFAULT_CHATTERBOX_DEVICE,
      voice:
        metadata.voice_mode === "clone"
          ? metadata.model === "chatterbox-multilingual"
            ? "Chatterbox Multilingual clone"
            : "Chatterbox Turbo clone"
          : metadata.model === "chatterbox-multilingual"
            ? "Chatterbox Multilingual"
            : "Chatterbox Turbo",
      mimetype: "audio/ogg; codecs=opus",
      provider:
        metadata.model === "chatterbox-multilingual"
          ? "chatterbox-multilingual"
          : "chatterbox-turbo"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function synthesizeWithKokoro({ spokenText, speed, timeoutMs, languageId }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-kokoro-"));
  const pythonBin = resolveKokoroPython();
  const modelFile = resolveKokoroModelFile();
  const voicesFile = resolveKokoroVoicesFile();
  const languageConfig = resolveKokoroLanguageConfig(languageId);

  try {
    await ensureFileExists(
      pythonBin,
      "Install Kokoro locally or set WHATSAPP_RELAY_TTS_KOKORO_PYTHON."
    );
    await ensureFileExists(
      modelFile,
      "Download kokoro-v1.0.onnx or set WHATSAPP_RELAY_TTS_KOKORO_MODEL."
    );
    await ensureFileExists(
      voicesFile,
      "Download voices-v1.0.bin or set WHATSAPP_RELAY_TTS_KOKORO_VOICES."
    );
    await ensureFileExists(KOKORO_TTS_SCRIPT, "The Kokoro bridge script is missing.");

    const textFile = path.join(tempDir, "reply.txt");
    const rawAudioFile = path.join(tempDir, "reply.wav");
    const outputFile = path.join(tempDir, "reply.ogg");
    await fs.writeFile(textFile, spokenText, "utf8");

    const { stdout } = await runCommand(
      pythonBin,
      buildKokoroArgs({
        textFile,
        outputFile: rawAudioFile,
        modelFile,
        voicesFile,
        voice: languageConfig.voice,
        lang: languageConfig.lang
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
      locale: languageConfig.languageId,
      languageId: languageConfig.languageId,
      voice: metadata.voice ?? languageConfig.voice,
      lang: metadata.lang ?? languageConfig.lang,
      mimetype: "audio/ogg; codecs=opus",
      provider: "kokoro-onnx"
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function synthesizeVoiceReply({
  text,
  speed = DEFAULT_VOICE_REPLY_SPEED,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  provider = DEFAULT_TTS_PROVIDER,
  languageIdHint = null
}) {
  const spokenText = buildSpokenReplyText(text);
  if (!spokenText) {
    throw new Error("Voice reply text is empty.");
  }

  const languageId =
    normalizeSpeechLanguageId(languageIdHint) ?? detectSpeechLanguageId(spokenText);
  const locale = languageId ?? detectSpeechLocale(spokenText);
  const normalizedProvider = resolveEffectiveTtsProvider(provider, languageId);

  if (normalizedProvider === "chatterbox-turbo") {
    const synthesized = await synthesizeWithChatterbox({
      spokenText,
      speed,
      timeoutMs,
      locale,
      languageId
    });
    return {
      ...synthesized,
      spokenText,
      locale,
      speed: normalizeVoiceReplySpeed(speed)
    };
  }

  if (normalizedProvider === "kokoro") {
    const synthesized = await synthesizeWithKokoro({
      spokenText,
      speed,
      timeoutMs,
      languageId
    });
    return {
      ...synthesized,
      spokenText,
      locale: synthesized.locale,
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
