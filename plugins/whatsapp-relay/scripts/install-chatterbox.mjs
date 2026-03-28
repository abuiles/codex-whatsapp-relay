import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { pluginRoot } from "./paths.mjs";

const CHATTERBOX_VENV_DIR = path.join(pluginRoot, ".venv-chatterbox");
const CHATTERBOX_PACKAGE = process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_PACKAGE ?? "chatterbox-tts";

function summarizeCommand(command, args) {
  return [command, ...args].join(" ");
}

async function runCommand(command, args, { env, streamOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      if (streamOutput) {
        process.stdout.write(text);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (streamOutput) {
        process.stderr.write(text);
      }
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const exitText = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`Command failed (${exitText}): ${summarizeCommand(command, args)}`));
    });
  });
}

async function probePythonVersion(command) {
  try {
    const { stdout } = await runCommand(command, [
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
    ]);
    const version = stdout.trim();
    const [major, minor] = version.split(".").map((value) => Number.parseInt(value, 10));
    if (major !== 3 || !Number.isFinite(minor) || minor < 10) {
      return null;
    }
    return {
      command,
      version
    };
  } catch {
    return null;
  }
}

async function resolvePython() {
  const requested = String(process.env.WHATSAPP_RELAY_TTS_CHATTERBOX_INSTALL_PYTHON ?? "").trim();
  const candidates = [
    requested,
    path.join(process.env.HOME ?? "", ".local", "bin", "python3.11"),
    "python3.11",
    "python3"
  ].filter(Boolean);
  const matches = [];

  for (const candidate of candidates) {
    const match = await probePythonVersion(candidate);
    if (match) {
      matches.push(match);
    }
  }

  if (matches.length) {
    return matches;
  }

  throw new Error(
    "Could not find a usable Python 3.10+ interpreter. Set WHATSAPP_RELAY_TTS_CHATTERBOX_INSTALL_PYTHON."
  );
}

async function main() {
  const pythonCandidates = await resolvePython();
  const venvPython = path.join(CHATTERBOX_VENV_DIR, "bin", "python");
  const installEnv = {
    ...process.env,
    PIP_PREFER_BINARY: process.env.PIP_PREFER_BINARY ?? "1"
  };
  let python = null;
  let lastError = null;

  for (const candidate of pythonCandidates) {
    try {
      await fs.rm(CHATTERBOX_VENV_DIR, { recursive: true, force: true });
      await runCommand(candidate.command, ["-m", "venv", CHATTERBOX_VENV_DIR], {
        env: installEnv
      });
      python = candidate;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!python) {
    throw lastError ?? new Error("Could not create a Chatterbox virtual environment.");
  }

  console.log(`Using ${python.command} (${python.version}) for Chatterbox Turbo setup.`);
  await runCommand(
    venvPython,
    ["-m", "pip", "install", "--upgrade", "pip", "wheel", "setuptools<81"],
    {
      env: installEnv,
      streamOutput: true
    }
  );
  await runCommand(venvPython, ["-m", "pip", "install", "--upgrade", CHATTERBOX_PACKAGE], {
    env: installEnv,
    streamOutput: true
  });
  await runCommand(venvPython, [
    "-c",
    [
      "import importlib.metadata",
      "import torch",
      "from chatterbox.tts_turbo import ChatterboxTurboTTS",
      "print(f'chatterbox={importlib.metadata.version(\"chatterbox-tts\")}')",
      "print('tts_turbo=ok')",
      "print(f'torch={torch.__version__}')",
    ].join("; ")
  ], {
    streamOutput: true
  });

  console.log("");
  console.log("Chatterbox Turbo is installed locally.");
  console.log(`Python: ${venvPython}`);
  console.log("Outbound voice replies now use Chatterbox Turbo by default.");
  console.log("If you ever want the macOS fallback instead:");
  console.log("export WHATSAPP_RELAY_TTS_PROVIDER=system");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
