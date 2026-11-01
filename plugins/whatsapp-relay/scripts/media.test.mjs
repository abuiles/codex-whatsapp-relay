import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { prepareMedia, downloadMessageMedia } from "./media.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVc8AAAAASUVORK5CYII=", "base64");
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-media-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "image.png"); await fs.writeFile(filePath, png);
  return { directory, filePath };
}

test("media preflight validates the exact local image without sending", async t => {
  const { filePath } = await fixture(t);
  const result = await prepareMedia({ filePath, mediaType: "image", caption: "Synthetic" });
  assert.equal(result.mimetype, "image/png");
  assert.equal(result.content.image.url, await fs.realpath(filePath));
  assert.equal(result.content.caption, "Synthetic");
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(prepareMedia({ filePath, mediaType: "image", expectedSha256: "0".repeat(64) }), /changed/);
  await assert.rejects(prepareMedia({ filePath, mediaType: "audio" }), /mimetype/);
  await assert.rejects(prepareMedia({ filePath: "relative.png", mediaType: "image" }), /absolute/);
  await assert.rejects(prepareMedia({ filePath, mediaType: "image", voiceNote: true }), /Voice notes/);
  await fs.writeFile(filePath, "not an image");
  await assert.rejects(prepareMedia({ filePath, mediaType: "image" }), /signature/);
});

test("video, audio, documents and stickers use their native Baileys payloads", async t => {
  const { directory } = await fixture(t);
  const formats = [
    ["video", "video.mp4", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")])],
    ["audio", "audio.mp3", Buffer.from("ID3synthetic")],
    ["document", "note.txt", Buffer.from("Synthetic test document")],
    ["sticker", "sticker.webp", Buffer.from("RIFF0000WEBPsynthetic")]
  ];
  for (const [mediaType, name, bytes] of formats) {
    const filePath = path.join(directory, name); await fs.writeFile(filePath, bytes);
    const result = await prepareMedia({ filePath, mediaType });
    assert.equal(result.content[mediaType].url, await fs.realpath(filePath));
  }
  const voicePath = path.join(directory, "voice.ogg");
  await fs.writeFile(voicePath, "OggS00000000000000000000000000OpusHead");
  const voice = await prepareMedia({ filePath: voicePath, mediaType: "audio", voiceNote: true });
  assert.equal(voice.content.ptt, true);
  assert.equal(voice.content.mimetype, "audio/ogg; codecs=opus");
  const normal = await prepareMedia({ filePath: voicePath, mediaType: "audio", mimetype: "audio/ogg" });
  assert.equal(normal.content.ptt, false);
  assert.equal(normal.content.mimetype, "audio/ogg; codecs=opus");
  assert.equal(normal.sha256, voice.sha256);
  await assert.rejects(prepareMedia({ filePath: voicePath, mediaType: "audio", mimetype: "audio/ogg; codecs=vorbis" }), /declared audio codec/);
  await fs.writeFile(voicePath, "OggS00000000000000000000000000vorbis");
  await assert.rejects(prepareMedia({ filePath: voicePath, mediaType: "audio" }), /must contain Opus/);
});

test("media downloads stream into a private file and preserve bytes", async t => {
  const { directory } = await fixture(t);
  let reupload;
  const socket = { updateMediaMessage() {} };
  const result = await downloadMessageMedia({ message: { imageMessage: { mimetype: "image/png" } } }, socket, {
    directory, download: async (_, type, options, context) => { assert.equal(type, "stream"); reupload = context.reuploadRequest; return Readable.from([png]); }
  });
  assert.deepEqual(await fs.readFile(result.path), png);
  assert.equal(result.bytes, png.length);
  assert.equal(reupload, socket.updateMediaMessage);
  assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
});

test("unavailable and view-once media fail explicitly without a download", async t => {
  const { directory } = await fixture(t);
  const options = { directory, download: async () => assert.fail("must not download") };
  await assert.rejects(downloadMessageMedia(null, {}, options), /no downloadable/);
  await assert.rejects(downloadMessageMedia({ message: { conversation: "hi" } }, {}, options), /does not contain/);
  await assert.rejects(downloadMessageMedia({ message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: {} } } } } } }, {}, options), /View-once/);
});

test("failed downloads remove only their partial output", async t => {
  const { directory, filePath } = await fixture(t);
  const stream = Readable.from((async function* () { yield png; throw new Error("synthetic failure"); })());
  await assert.rejects(downloadMessageMedia({ message: { imageMessage: { mimetype: "image/png" } } }, {}, {
    directory, download: async () => stream
  }), /synthetic failure/);
  assert.deepEqual(await fs.readdir(directory), [path.basename(filePath)]);
});

test("approved media bytes stay immutable across later source-file edits", async t => {
  const { freezePreparedMedia } = await import("./media.mjs");
  const { filePath } = await fixture(t);
  const prepared = await prepareMedia({ filePath, mediaType: "image" });
  const frozen = await freezePreparedMedia(prepared);
  await fs.writeFile(filePath, "changed after snapshot");
  assert.deepEqual(frozen.content.image, png);
  await assert.rejects(freezePreparedMedia(prepared), /changed since preparation/);
  await fs.writeFile(filePath, Buffer.alloc(png.length, 0));
  await assert.rejects(freezePreparedMedia(prepared), /changed since preparation/);
});

test("the real SDK encodes the frozen approved bytes without a network upload", async t => {
  const { freezePreparedMedia } = await import("./media.mjs");
  const { prepareWAMessageMedia } = await import("@whiskeysockets/baileys");
  const { filePath } = await fixture(t);
  const prepared = await prepareMedia({ filePath, mediaType: "image" });
  const frozen = await freezePreparedMedia(prepared);
  const encoded = await prepareWAMessageMedia({ ...frozen.content, jpegThumbnail: Buffer.alloc(0) }, {
    upload: async () => ({ mediaUrl: "https://example.invalid/synthetic", directPath: "/synthetic" })
  });
  assert.equal(Buffer.from(encoded.imageMessage.fileSha256).toString("hex"), prepared.sha256);
  assert.equal(Number(encoded.imageMessage.fileLength), png.length);
});
