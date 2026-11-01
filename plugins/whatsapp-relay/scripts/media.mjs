import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { authDir, dataDir } from "./paths.mjs";
import { unwrapMessage } from "./store.mjs";

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus", ".wav": "audio/wav", ".pdf": "application/pdf", ".txt": "text/plain" };

export async function prepareMedia({ filePath, mediaType, caption, mimetype, voiceNote = false, expectedSha256 }) {
  if (!path.isAbsolute(filePath ?? "")) throw new Error("filePath must be an absolute local path.");
  if (!["image", "video", "audio", "document", "sticker"].includes(mediaType)) throw new Error("Unsupported mediaType.");
  const source = await fs.realpath(filePath);
  const credentialRoot = await fs.realpath(authDir).catch(() => path.resolve(authDir));
  if (source === credentialRoot || source.startsWith(`${credentialRoot}${path.sep}`)) throw new Error("WhatsApp authentication files cannot be uploaded.");
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MEDIA_BYTES) throw new Error("Media must be a nonempty regular file no larger than 100 MiB.");
  let mime = mimetype ?? MIME[path.extname(source).toLowerCase()] ?? (mediaType === "document" ? "application/octet-stream" : null);
  const prefix = mediaType === "sticker" ? "image/webp" : `${mediaType}/`;
  if (!mime || (mediaType !== "document" && !mime.startsWith(prefix))) throw new Error("mimetype does not match the selected mediaType.");
  const handle = await fs.open(source, "r");
  const header = Buffer.alloc(64);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const baseMime = mime.split(";")[0];
  const signatures = {
    "image/png": () => header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    "image/jpeg": () => header[0] === 255 && header[1] === 216 && header[2] === 255,
    "image/webp": () => header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP",
    "video/mp4": () => header.toString("ascii", 4, 8) === "ftyp",
    "audio/mp4": () => header.toString("ascii", 4, 8) === "ftyp",
    "audio/mpeg": () => header.toString("ascii", 0, 3) === "ID3" || (header[0] === 255 && (header[1] & 224) === 224),
    "audio/ogg": () => header.toString("ascii", 0, 4) === "OggS",
    "audio/wav": () => header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE",
    "application/pdf": () => header.toString("ascii", 0, 5) === "%PDF-"
  };
  if ((mediaType !== "document" && !signatures[baseMime]) || (signatures[baseMime] && !signatures[baseMime]())) throw new Error("File signature does not match a supported media format.");
  if (voiceNote && (mediaType !== "audio" || !/^audio\/ogg(?:;.*)?$/.test(mime))) throw new Error("Voice notes require an Ogg/Opus audio file; other audio can be sent as an attachment.");
  if (voiceNote) {
    if (!header.subarray(0, 4).equals(Buffer.from("OggS")) || !header.includes(Buffer.from("OpusHead"))) throw new Error("Voice-note file must contain Ogg Opus audio.");
  }
  if (mediaType === "audio" && baseMime === "audio/ogg") {
    if (!header.includes(Buffer.from("OpusHead"))) throw new Error("WhatsApp Ogg audio must contain Opus audio; convert this file before sending.");
    const codec = /;\s*codecs\s*=\s*"?([^;"\s]+)/i.exec(mime)?.[1];
    if (codec && codec.toLowerCase() !== "opus") throw new Error("The declared audio codec does not match the Ogg Opus file.");
    // Preserve the SDK's documented Opus MIME instead of overriding it with
    // generic audio/ogg just because the input filename ends in .ogg.
    mime = "audio/ogg; codecs=opus";
  }
  if (caption && !["image", "video", "document"].includes(mediaType)) throw new Error("Captions are supported for images, videos and documents.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error("File changed since preparation; review the new content before sending.");
  const content = { [mediaType]: { url: source }, mimetype: mime };
  if (caption) content.caption = caption;
  if (mediaType === "audio") content.ptt = voiceNote;
  if (mediaType === "document") content.fileName = path.basename(source);
  return { filePath: source, mediaType, mimetype: mime, bytes: stat.size, sha256, content };
}

function isViewOnce(message) {
  if (!message) return false;
  if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) return true;
  return isViewOnce(message.ephemeralMessage?.message ?? message.documentWithCaptionMessage?.message);
}

export async function freezePreparedMedia(media) {
  const handle = await fs.open(media.filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== media.bytes || stat.size > MAX_MEDIA_BYTES) throw new Error("File changed since preparation; review it before sending.");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!part.bytesRead) break;
      bytes += part.bytesRead;
    }
    const content = buffer.subarray(0, bytes);
    if (bytes !== media.bytes || createHash("sha256").update(content).digest("hex") !== media.sha256) throw new Error("File changed since preparation; review it before sending.");
    // The SDK receives approved bytes, so later source-file edits cannot change
    // what is uploaded while connection or encryption work is pending.
    return { ...media, content: { ...media.content, [media.mediaType]: content } };
  } finally {
    await handle.close();
  }
}

export async function downloadMessageMedia(raw, socket, { logger, download = downloadMediaMessage, directory = path.join(dataDir, "downloads") } = {}) {
  if (!raw?.message) throw new Error("This cache entry has no downloadable message data; sync the message through MCP first.");
  if (isViewOnce(raw.message)) throw new Error("View-once media cannot be saved by this tool.");
  const payload = unwrapMessage(raw.message);
  const media = payload?.imageMessage ?? payload?.videoMessage ?? payload?.audioMessage ?? payload?.documentMessage ?? payload?.stickerMessage;
  if (!media) throw new Error("Selected message does not contain downloadable media.");
  const mime = media.mimetype ?? "application/octet-stream";
  const extension = Object.entries(MIME).find(([, value]) => value === mime)?.[0] ?? ".bin";
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const outputPath = path.join(directory, `${randomUUID()}${extension}`);
  const stream = await download(raw, "stream", {}, { logger, reuploadRequest: socket.updateMediaMessage });
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, _, callback) {
    bytes += chunk.length;
    callback(bytes > MAX_MEDIA_BYTES ? new Error("Download exceeds the relay's 100 MiB limit.") : null, chunk);
  } });
  try {
    await pipeline(stream, limiter, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    if (!bytes) throw new Error("Downloaded media is empty.");
  } catch (error) {
    await fs.unlink(outputPath).catch(() => {});
    throw error;
  }
  return { path: outputPath, mimetype: mime, bytes };
}
