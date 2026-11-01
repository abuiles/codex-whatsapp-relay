import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { DisconnectReason, proto } from "@whiskeysockets/baileys";
import { WhatsAppRuntime, credsFileIsLinked } from "./runtime.mjs";

test("auth reuses a live QR but never returns a disconnected cached QR", async () => {
  const runtime = new WhatsAppRuntime({ logLevel: "silent" });
  runtime.socket = { ws: { isOpen: true } };
  runtime.state.status = "awaiting_qr_scan";
  runtime.state.currentQrText = "live";
  runtime.start = async () => assert.fail("live auth must reuse its socket");
  assert.equal((await runtime.startAuthFlow()).qrText, "live");
  runtime.socket.ws.isOpen = false;
  runtime.state.status = "disconnected";
  let starts = 0;
  runtime.start = async () => {
    starts++;
    runtime.state.status = "awaiting_qr_scan";
    runtime.state.currentQrText = "fresh";
  };
  assert.equal((await runtime.startAuthFlow()).qrText, "fresh");
  assert.equal(starts, 1);
});

test("auth with a phone number returns a pairing code once the socket can register, and reuses it", async () => {
  const runtime = new WhatsAppRuntime({ logLevel: "silent" });
  const requested = [];
  runtime.start = async () => {
    runtime.socket = { ws: { isOpen: true }, requestPairingCode: async phone => { requested.push(phone); return `CODE${requested.length}XYZ`.slice(0, 8); } };
    runtime.state.status = "awaiting_qr_scan";
    runtime.state.currentQrText = "qr";
  };
  const first = await runtime.startAuthFlow({ phoneNumber: "+1 (555) 000-1234" });
  assert.equal(first.status, "awaiting_pairing_code");
  assert.equal(first.pairingCode, "CODE1XYZ");
  assert.deepEqual(requested, ["15550001234"]);
  // Asking again on the same live socket must not invalidate the code the user is typing.
  assert.equal((await runtime.startAuthFlow({ phoneNumber: "15550001234" })).pairingCode, "CODE1XYZ");
  assert.equal(requested.length, 1);
  // A different number gets its own code.
  assert.equal((await runtime.startAuthFlow({ phoneNumber: "+44 7700 900123" })).pairingCode, "CODE2XYZ");
  assert.deepEqual(requested, ["15550001234", "447700900123"]);
  await assert.rejects(runtime.startAuthFlow({ phoneNumber: "12" }), /country code/);
  runtime.state.status = "connected";
  assert.equal((await runtime.startAuthFlow({ phoneNumber: "15550001234" })).status, "connected");
  assert.equal(requested.length, 2);
});

test("closed and replaced sockets cannot leave a usable stale QR", async () => {
  const source = await fs.readFile(new URL("runtime.mjs", import.meta.url), "utf8");
  const begin = source.indexOf('    socket.ev.on("connection.update", (update) => {');
  const end = source.indexOf('    socket.ev.on("messages.upsert", (payload)', begin);
  const code = source.slice(begin, end);
  let handler;
  const socket = { ev: { on: (_, fn) => { handler = fn; } } };
  const runtime = { socket, closing: true, state: { status: "awaiting_qr_scan", currentQrText: "stale", pairingCode: { code: "STALE123" } }, events: { emit() {} } };
  const context = { socket, DisconnectReason, disconnectCode: () => DisconnectReason.connectionLost,
    disconnectLabel: () => "connection_lost", printQrToTerminal: false };
  const harness = vm.runInNewContext(`class Harness {
    #renderQr(value) { return value; }
    #scheduleReconnect() {}
    install() { ${code} }
  }
  const harness = Object.assign(new Harness(), runtime);
  harness.install();
  harness;`, { ...context, runtime });
  handler({ connection: "close", lastDisconnect: { error: new Error("closed") } });
  assert.equal(runtime.state.currentQrText, null);
  assert.equal(runtime.state.pairingCode, null);
  assert.equal(runtime.state.status, "disconnected");
  harness.socket = {};
  handler({ qr: "obsolete QR" });
  assert.equal(runtime.state.currentQrText, null);
});

test("positive provider acknowledgements update status but errors and obsolete sockets do not", async () => {
  const source = await fs.readFile(new URL("runtime.mjs", import.meta.url), "utf8");
  const begin = source.indexOf('    socket.ws.on("CB:ack,class:message"');
  const end = source.indexOf('    socket.ev.on("connection.update"', begin);
  let handler;
  const updates = [];
  const socket = { ws: { on: (_, callback) => { handler = callback; } } };
  const runtime = { socket, store: { updateMessage: (key, update) => updates.push({ key, update }) },
    historyRequests: { recordAck: async () => {} } };
  vm.runInNewContext(`(function() { ${source.slice(begin, end)} }).call(runtime)`, { socket, runtime, proto });
  handler({ attrs: { from: "10000000000@s.whatsapp.net", id: "synthetic" } });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].update.status, proto.WebMessageInfo.Status.SERVER_ACK);
  handler({ attrs: { from: "10000000000@s.whatsapp.net", id: "synthetic", error: "479" } });
  handler({ attrs: { id: "missing-from" } });
  assert.equal(updates[1].key.fromMe, true);
  assert.equal(updates[1].key.remoteJid, undefined);
  runtime.socket = {};
  handler({ attrs: { from: "10000000000@s.whatsapp.net", id: "obsolete" } });
  assert.equal(updates.length, 2);
});

test("a socket that is still connecting is reused instead of orphaned", async () => {
  const runtime = new WhatsAppRuntime({ logLevel: "silent" });
  const connecting = { ws: { isOpen: false } };
  runtime.socket = connecting;
  runtime.state.status = "connecting";
  runtime.initialize = async () => assert.fail("must not open a second socket");
  assert.equal(await runtime.start(), connecting);
  assert.equal(await runtime.start(), connecting);
  await runtime.stop();
  assert.equal(runtime.reconnectPending(), false);
});

test("every unexpected close, including 440, goes through the single backoff scheduler", async () => {
  const source = await fs.readFile(new URL("runtime.mjs", import.meta.url), "utf8");
  const begin = source.indexOf('    socket.ev.on("connection.update", (update) => {');
  const end = source.indexOf('    socket.ev.on("messages.upsert", (payload)', begin);
  const code = source.slice(begin, end);
  const scheduled = [];
  let handler;
  const socket = { ev: { on: (_, fn) => { handler = fn; } } };
  const runtime = { socket, closing: false, state: { status: "connected" }, events: { emit() {} } };
  const harness = vm.runInNewContext(`class Harness {
    #renderQr(value) { return value; }
    #scheduleReconnect(code) { scheduled.push(code); }
    install() { ${code} }
  }
  const harness = Object.assign(new Harness(), runtime);
  harness.install();
  harness;`, { socket, scheduled, runtime, DisconnectReason, printQrToTerminal: false,
    disconnectCode: error => error.code, disconnectLabel: () => "x" });
  handler({ connection: "close", lastDisconnect: { error: { code: DisconnectReason.connectionReplaced } } });
  harness.closing = true;
  handler({ connection: "close", lastDisconnect: { error: { code: DisconnectReason.connectionLost } } });
  assert.deepEqual(scheduled, [DisconnectReason.connectionReplaced]);
});

test("an abandoned pairing-code attempt does not count as a linked account", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "creds-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "creds.json");
  assert.equal(credsFileIsLinked(file), false);
  // requestPairingCode saves `me` and the code before the phone confirms.
  await fs.writeFile(file, JSON.stringify({ me: { id: "15550001234@s.whatsapp.net" }, pairingCode: "ABCD1234", registered: false }));
  assert.equal(credsFileIsLinked(file), false);
  // Pairing success (QR or code) adds the signed device account.
  await fs.writeFile(file, JSON.stringify({ me: { id: "15550001234:3@s.whatsapp.net" }, account: { details: "x" }, registered: false }));
  assert.equal(credsFileIsLinked(file), true);
  // A file caught mid-write keeps the old answer rather than looking logged out.
  await fs.writeFile(file, "{\"me\":");
  assert.equal(credsFileIsLinked(file), true);
});
