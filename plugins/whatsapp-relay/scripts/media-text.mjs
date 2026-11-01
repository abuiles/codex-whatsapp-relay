// Turn downloaded media into searchable text with local tools only: voice
// notes and video audio are transcribed, images OCR'd, PDFs and office
// documents converted. Nothing is uploaded anywhere.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";

import { transcribeVoiceNote } from "./voice-transcriber.mjs";

const MAX_TEXT = 20_000;

function run(command, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return reject(new Error(`${command} is not installed (brew install ${command === "pdftotext" ? "poppler" : command})`));
      if (error) return reject(new Error(`${command} failed: ${String(stderr || error.message).trim().split("\n").at(-1)}`));
      resolve(stdout);
    });
  });
}

export function mediaKind(mimetype = "", fileName = "") {
  const type = mimetype.split(";")[0].trim().toLowerCase();
  const ext = fileName.toLowerCase().split(".").at(-1);
  if (type.startsWith("audio/")) return "transcript";
  if (type.startsWith("video/")) return "transcript";
  if (type === "image/webp") return null; // stickers
  if (type.startsWith("image/")) return "ocr";
  if (type === "application/pdf" || ext === "pdf") return "pdf_text";
  if (/officedocument|msword|rtf|opendocument\.text/.test(type) || ["doc", "docx", "rtf", "odt", "pages"].includes(ext)) return "document_text";
  if (type.startsWith("text/") || ["application/json", "text/csv"].includes(type) || ["txt", "md", "csv", "json"].includes(ext)) return "plain_text";
  return null;
}

export async function extractMediaText({ filePath, mimetype, fileName }) {
  const kind = mediaKind(mimetype, fileName);
  let text;
  switch (kind) {
    case "transcript": {
      const result = await transcribeVoiceNote({ audioBuffer: await fs.readFile(filePath), mimeType: mimetype });
      text = result.transcript ?? "";
      break;
    }
    case "ocr":
      text = await run("tesseract", [filePath, "stdout"]);
      break;
    case "pdf_text":
      text = await run("pdftotext", ["-layout", "-l", "50", filePath, "-"]);
      break;
    case "document_text":
      text = await run("textutil", ["-convert", "txt", "-stdout", filePath]);
      break;
    case "plain_text":
      text = await fs.readFile(filePath, "utf8");
      break;
    default:
      throw new Error(`No text extractor for ${mimetype || fileName || "this media"}.`);
  }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { kind, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}
