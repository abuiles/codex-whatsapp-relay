import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhatsAppControllerBridge } from "./controller-bridge.mjs";
import { prepareMedia } from "./media.mjs";

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-controller-media-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "image.png");
  await fs.writeFile(filePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVc8AAAAASUVORK5CYII=", "base64"));
  const media = await prepareMedia({ filePath, mediaType: "image" });
  return { chatId: "10000000000@s.whatsapp.net", filePath, mediaType: "image", expectedSha256: media.sha256 };
}

test("controller media dispatch uses its existing socket and caches the returned ID", async t => {
  const payload = await fixture(t);
  const events = [];
  const context = {
    runtime: { ensureConnected: async () => ({ sendMessage: async (id, content) => {
      assert.equal(id, payload.chatId); assert.ok(Buffer.isBuffer(content.image)); return { key: { id: "synthetic-media" } };
    } }), store: { ingestSent: message => events.push(message.key.id) } },
    rememberOutgoingMessage: id => events.push(id)
  };
  await WhatsAppControllerBridge.prototype.handleOutboxCommand.call(context, { type: "send_media", payload });
  assert.deepEqual(events, ["synthetic-media", "synthetic-media"]);
});

test("controller never automatically retries an ambiguous media send", async t => {
  const payload = await fixture(t);
  const failure = new Error("socket closed after upload");
  const context = { runtime: { ensureConnected: async () => ({ sendMessage: async () => { throw failure; } }) } };
  await assert.rejects(WhatsAppControllerBridge.prototype.handleOutboxCommand.call(context, { type: "send_media", payload }), error => error === failure && error.retryable === false);
});

test("controller rejects changed approved media before a connection attempt", async t => {
  const payload = await fixture(t);
  await fs.appendFile(payload.filePath, "changed");
  const context = { runtime: { ensureConnected: async () => assert.fail("must not connect") } };
  await assert.rejects(WhatsAppControllerBridge.prototype.handleOutboxCommand.call(context, { type: "send_media", payload }), error => error.code === "ERR_CONTROLLER_COMMAND_INVALID");
});

test("a partial text submission preserves successful IDs and quarantines the failure", async () => {
  let calls = 0;
  const remembered = [];
  const context = { runtime: { ensureConnected: async () => ({ sendMessage: async () => {
    calls++; if (calls === 2) throw new Error("unknown second outcome"); return { key: { id: "part-one" } };
  } }), store: { ingestSent() {} } }, rememberOutgoingMessage: id => remembered.push(id) };
  await assert.rejects(WhatsAppControllerBridge.prototype.sendTextMessage.call(context, "10000000000@s.whatsapp.net", "x".repeat(4000)), error => error.retryable === false);
  assert.equal(calls, 2);
  assert.deepEqual(remembered, ["part-one"]);
});
