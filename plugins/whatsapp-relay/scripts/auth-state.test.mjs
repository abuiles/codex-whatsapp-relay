import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { proto } from "@whiskeysockets/baileys";

import { AppStateKeyRequester, leadingJson, useAtomicMultiFileAuthState } from "./auth-state.mjs";

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), "wa-auth-"));

test("a torn key file is read from its first complete JSON value", async () => {
  const dir = await tempDir();
  const key = { keyData: { type: "Buffer", data: "AQID" }, timestamp: "1" };
  await fs.writeFile(path.join(dir, "app-state-sync-key-AAAA.json"), `${JSON.stringify(key)}"}\n`);
  const { state } = await useAtomicMultiFileAuthState(dir);
  const { AAAA } = await state.keys.get("app-state-sync-key", ["AAAA"]);
  assert.deepEqual([...AAAA.keyData], [1, 2, 3]);
  assert.equal(leadingJson('{"a":"}"}tail'), '{"a":"}"}');
});

test("writes are atomic and leave no temp files; missing keys are reported", async () => {
  const dir = await tempDir();
  const missing = [];
  const { state, saveCreds } = await useAtomicMultiFileAuthState(dir, { onMissingKeys: (type, ids) => missing.push([type, ids]) });
  await Promise.all(Array.from({ length: 20 }, (_, i) => state.keys.set({ "pre-key": { 1: { n: i, pad: "x".repeat(i * 10) } } })));
  await saveCreds();
  const files = await fs.readdir(dir);
  assert.deepEqual(files.sort(), ["creds.json", "pre-key-1.json"]);
  JSON.parse(await fs.readFile(path.join(dir, "pre-key-1.json"), "utf8"));
  await state.keys.set({ "pre-key": { 1: null } });
  const got = await state.keys.get("app-state-sync-key", ["Zm9v"]);
  assert.equal(got.Zm9v, null);
  assert.deepEqual(missing, [["app-state-sync-key", ["Zm9v"]]]);
});

test("missing app-state keys are requested from our own phone once per window", async () => {
  const sent = [];
  let now = 0;
  const socket = {
    user: { id: "15550001111:7@s.whatsapp.net" },
    relayMessage: async (jid, message, options) => { sent.push({ jid, message, options }); return "id"; }
  };
  const requester = new AppStateKeyRequester({ getSocket: () => socket, now: () => now });
  assert.deepEqual(await requester.request(["AAAAALCf"]), ["AAAAALCf"]);
  assert.deepEqual(await requester.request(["AAAAALCf"]), []);
  now += 11 * 60 * 1000;
  assert.deepEqual(await requester.request(["AAAAALCf"]), ["AAAAALCf"]);
  assert.equal(sent.length, 2);
  const [{ jid, message, options }] = sent;
  assert.equal(jid, "15550001111@s.whatsapp.net");
  assert.equal(message.protocolMessage.type, proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST);
  assert.equal(Buffer.from(message.protocolMessage.appStateSyncKeyRequest.keyIds[0].keyId).toString("base64"), "AAAAALCf");
  assert.equal(options.additionalAttributes.category, "peer");
  // The encoded message must round-trip through the real proto schema.
  proto.Message.encode(proto.Message.fromObject(message)).finish();
});

test("a failed key request is retried on the next miss, and no socket means no request", async () => {
  let fail = true;
  const socket = { user: { id: "1@s.whatsapp.net" }, relayMessage: async () => { if (fail) throw new Error("offline"); } };
  const requester = new AppStateKeyRequester({ getSocket: () => socket });
  assert.deepEqual(await requester.request(["AA=="]), []);
  fail = false;
  assert.deepEqual(await requester.request(["AA=="]), ["AA=="]);
  assert.deepEqual(await new AppStateKeyRequester({ getSocket: () => null }).request(["AA=="]), []);
});
