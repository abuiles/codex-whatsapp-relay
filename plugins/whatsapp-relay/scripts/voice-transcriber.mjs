import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pluginRoot } from "./paths.mjs";

const DEFAULT_PARAKEET_MODEL =
  process.env.WHATSAPP_RELAY_STT_MODEL ?? "mlx-community/parakeet-tdt-0.6b-v3";
const DEFAULT_WHISPER_CPP_MODEL =
  process.env.WHATSAPP_RELAY_STT_WHISPER_CPP_MODEL ??
  process.env.WHATSAPP_RELAY_STT_MODEL ??
  path.join(pluginRoot, "tools", "whisper.cpp", "models", "ggml-small.bin");
const DEFAULT_WHISPER_CPP_BIN =
  process.env.WHATSAPP_RELAY_STT_WHISPER_CPP_BIN ??
  path.join(pluginRoot, "tools", "whisper.cpp", "Release", "whisper-cli.exe");
const DEFAULT_WHISPER_CPP_LANGUAGE = String(
  process.env.WHATSAPP_RELAY_STT_LANGUAGE ?? "auto"
)
  .trim()
  .toLowerCase();
const DEFAULT_WHISPER_CPP_THREADS = resolvePositiveInt(
  process.env.WHATSAPP_RELAY_STT_THREADS,
  Math.min(os.cpus()?.length ?? 4, 8)
);

export const DEFAULT_TRANSCRIPTION_PROVIDER = normalizeSttProvider(
  process.env.WHATSAPP_RELAY_STT_PROVIDER,
  process.platform === "win32" ? "whisper-cpp" : "parakeet-mlx"
);
export const DEFAULT_TRANSCRIPTION_MODEL = resolveDefaultModel(
  DEFAULT_TRANSCRIPTION_PROVIDER
);

const DEFAULT_TIMEOUT_MS = resolveTimeoutMs(
  process.env.WHATSAPP_RELAY_STT_TIMEOUT_MS,
  8 * 60 * 1000
);

function resolveTimeoutMs(value, fallbackMs) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeSttProvider(value, fallback = "parakeet-mlx") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  switch (normalized) {
    case "parakeet":
    case "parakeet-mlx":
    case "mlx":
      return "parakeet-mlx";
    case "whisper":
    case "whisper.cpp":
    case "whisper-cpp":
    case "whispercpp":
      return "whisper-cpp";
    default:
      return fallback;
  }
}

function resolveDefaultModel(provider) {
  return provider === "whisper-cpp" ? DEFAULT_WHISPER_CPP_MODEL : DEFAULT_PARAKEET_MODEL;
}

function extensionForMimeType(mimeType) {
  const normalized = String(mimeType ?? "").toLowerCase();
  if (normalized.includes("ogg")) {
    return ".ogg";
  }
  if (normalized.includes("mpeg") || normalized.includes("mp3")) {
    return ".mp3";
  }
  if (normalized.includes("wav") || normalized.includes("wave")) {
    return ".wav";
  }
  if (normalized.includes("aac")) {
    return ".aac";
  }
  if (normalized.includes("mp4") || normalized.includes("m4a")) {
    return ".m4a";
  }
  return ".audio";
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

async function runCommand(command, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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

function normalizeSentence(sentence = {}) {
  return {
    text: String(sentence.text ?? "").trim(),
    start: Number.isFinite(sentence.start) ? sentence.start : null,
    end: Number.isFinite(sentence.end) ? sentence.end : null,
    duration: Number.isFinite(sentence.duration) ? sentence.duration : null,
    confidence: Number.isFinite(sentence.confidence) ? sentence.confidence : null
  };
}

function secondsFromWhisperOffset(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function secondsFromWhisperTimestamp(value) {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, millis] = match;
  return (
    Number(hours) * 60 * 60 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis) / 1000
  );
}

function normalizeWhisperSegment(segment = {}) {
  const text = String(segment.text ?? "").trim();
  const start =
    secondsFromWhisperOffset(segment.offsets?.from) ??
    secondsFromWhisperTimestamp(segment.timestamps?.from);
  const end =
    secondsFromWhisperOffset(segment.offsets?.to) ??
    secondsFromWhisperTimestamp(segment.timestamps?.to);
  const duration = Number.isFinite(start) && Number.isFinite(end) ? end - start : null;

  return {
    text,
    start,
    end,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
    confidence: null
  };
}

export function parseWhisperCppTranscript(parsed = {}) {
  const directTranscript = String(parsed.text ?? "").trim();
  const rawSegments = Array.isArray(parsed.transcription)
    ? parsed.transcription
    : Array.isArray(parsed.segments)
      ? parsed.segments
      : [];
  const sentences = rawSegments.map(normalizeWhisperSegment).filter((segment) => segment.text);
  const transcript =
    directTranscript || sentences.map((sentence) => sentence.text).join(" ").trim();

  return {
    transcript,
    sentences,
    language: String(parsed.result?.language ?? parsed.language ?? "").trim() || null
  };
}

function summarizeConfidence(sentences) {
  const confidences = sentences
    .map((sentence) => sentence.confidence)
    .filter((value) => Number.isFinite(value));

  if (!confidences.length) {
    return {
      avgConfidence: null,
      minConfidence: null
    };
  }

  const total = confidences.reduce((sum, value) => sum + value, 0);
  return {
    avgConfidence: total / confidences.length,
    minConfidence: Math.min(...confidences)
  };
}

async function transcribeWithParakeet({ normalizedFile, outputDir, model, timeoutMs }) {
  const transcriptFile = path.join(outputDir, "transcript.json");

  await runCommand(
    "uvx",
    [
      "--from",
      "parakeet-mlx",
      "parakeet-mlx",
      normalizedFile,
      "--model",
      model,
      "--output-format",
      "json",
      "--output-dir",
      outputDir,
      "--output-template",
      "transcript"
    ],
    { timeoutMs }
  );

  const rawTranscript = await fs.readFile(transcriptFile, "utf8");
  const parsed = JSON.parse(rawTranscript);
  const transcript = String(parsed.text ?? "").trim();
  const sentences = Array.isArray(parsed.sentences)
    ? parsed.sentences.map(normalizeSentence)
    : [];

  return {
    transcript,
    sentences,
    language: null
  };
}

async function transcribeWithWhisperCpp({ normalizedFile, outputDir, model, timeoutMs }) {
  await ensureFileExists(
    DEFAULT_WHISPER_CPP_BIN,
    "Install whisper.cpp or set WHATSAPP_RELAY_STT_WHISPER_CPP_BIN."
  );
  await ensureFileExists(
    model,
    "Download a ggml Whisper model or set WHATSAPP_RELAY_STT_WHISPER_CPP_MODEL."
  );

  const outputBase = path.join(outputDir, "transcript");
  const transcriptFile = `${outputBase}.json`;
  const args = [
    "-m",
    model,
    "-f",
    normalizedFile,
    "-l",
    DEFAULT_WHISPER_CPP_LANGUAGE || "auto",
    "-t",
    String(DEFAULT_WHISPER_CPP_THREADS),
    "-oj",
    "-of",
    outputBase,
    "-np"
  ];

  await runCommand(DEFAULT_WHISPER_CPP_BIN, args, {
    timeoutMs,
    cwd: path.dirname(DEFAULT_WHISPER_CPP_BIN)
  });

  const rawTranscript = await fs.readFile(transcriptFile, "utf8");
  return parseWhisperCppTranscript(JSON.parse(rawTranscript));
}

export async function transcribeVoiceNote({
  audioBuffer,
  mimeType,
  provider = DEFAULT_TRANSCRIPTION_PROVIDER,
  model = null,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer ?? "");
  if (!buffer.length) {
    throw new Error("Voice note is empty.");
  }

  const normalizedProvider = normalizeSttProvider(provider, DEFAULT_TRANSCRIPTION_PROVIDER);
  const resolvedModel = String(model ?? "").trim() || resolveDefaultModel(normalizedProvider);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "whatsapp-relay-stt-"));
  try {
    const sourceFile = path.join(tempDir, `voice-note${extensionForMimeType(mimeType)}`);
    const normalizedFile = path.join(tempDir, "voice-note.wav");
    const outputDir = path.join(tempDir, "output");

    await fs.writeFile(sourceFile, buffer);
    await fs.mkdir(outputDir, { recursive: true });

    await runCommand(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        sourceFile,
        "-ac",
        "1",
        "-ar",
        "16000",
        normalizedFile
      ],
      { timeoutMs }
    );

    const parsed =
      normalizedProvider === "whisper-cpp"
        ? await transcribeWithWhisperCpp({
            normalizedFile,
            outputDir,
            model: resolvedModel,
            timeoutMs
          })
        : await transcribeWithParakeet({
            normalizedFile,
            outputDir,
            model: resolvedModel,
            timeoutMs
          });
    const transcript = String(parsed.transcript ?? "").trim();
    if (!transcript) {
      throw new Error("Voice note transcription was empty.");
    }

    const sentences = Array.isArray(parsed.sentences) ? parsed.sentences : [];
    const confidenceSummary = summarizeConfidence(sentences);

    return {
      transcript,
      sentences,
      model: resolvedModel,
      provider: normalizedProvider,
      language: parsed.language ?? null,
      mimeType: String(mimeType ?? "") || null,
      ...confidenceSummary
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
