import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { buildPairingQRData, getBinaryNodeChild, getBinaryNodeChildren } from "@whiskeysockets/baileys";

const dependency = new URL("../node_modules/@whiskeysockets/baileys/lib/Socket/", import.meta.url);

test("installed socket refreshes the current QR without consuming refs or changing its timer", async () => {
  const source = await fs.readFile(new URL("socket.js", dependency), "utf8");
  const code = source.slice(source.indexOf("    let refreshPairingQR;"), source.indexOf("    // device paired for the first time"));
  assert.ok(code.length > 0, "run the pairing backport before testing");
  const ws = new EventEmitter();
  ws.isOpen = true;
  const creds = { noiseKey: { public: Buffer.alloc(32, 1) }, signedIdentityKey: { public: Buffer.alloc(32, 2) }, advSecretKey: randomBytes(32).toString("base64") };
  const events = [];
  const timers = [];
  const context = { ws, creds, Buffer, randomBytes, browser: ["Mac OS", "Chrome", "14.4.1"],
    getBinaryNodeChild, getBinaryNodeChildren, buildPairingQRData, qrTimeout: undefined,
    S_WHATSAPP_NET: "s.whatsapp.net", sendNode: async () => {},
    ev: { emit: (name, data) => events.push({ name, data }) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, qrTimer: null,
    end: () => assert.fail("refresh must not exhaust refs"), Boom: Error, DisconnectReason: {} };
  vm.runInNewContext(code, context);
  const pair = { tag: "iq", attrs: { id: "test" }, content: [{ tag: "pair-device", attrs: {}, content: ["ref1", "ref2"].map(ref => ({ tag: "ref", attrs: {}, content: Buffer.from(ref) })) }] };
  await ws.listeners("CB:iq,type:set,pair-device")[0](pair);
  const qrEvents = () => events.filter(e => e.name === "connection.update");
  const initial = qrEvents().at(-1).data.qr;
  const refresh = child => ws.emit("CB:notification,type:companion_reg_refresh", { tag: "notification", attrs: {}, content: [{ tag: child, attrs: {} }] });
  const oldSecret = creds.advSecretKey;
  refresh("unexpected");
  assert.equal(creds.advSecretKey, oldSecret);
  for (let i = 0; i < 50; i++) refresh(i % 2 ? "pair-device-rotate-qr" : "companion_reg_refresh");
  assert.equal(qrEvents().length, 51);
  assert.equal(timers.length, 1);
  assert.equal(Buffer.from(creds.advSecretKey, "base64").length, 32);
  assert.notEqual(qrEvents().at(-1).data.qr, initial);
  assert.ok(qrEvents().every(e => e.data.qr.split(",")[0].endsWith("ref1")));
  timers[0].fn();
  assert.ok(qrEvents().at(-1).data.qr.split(",")[0].endsWith("ref2"));
  assert.equal(qrEvents().at(-1).data.qr.split(",")[3], creds.advSecretKey);
  for (const guard of ["registered", "closed"]) {
    if (guard === "registered") creds.me = { id: "test@s.whatsapp.net" };
    else { delete creds.me; ws.isOpen = false; }
    const previous = creds.advSecretKey;
    refresh("companion_reg_refresh");
    assert.equal(creds.advSecretKey, previous);
  }
});

test("installed notification acknowledgement works before a device ID exists", async () => {
  const source = await fs.readFile(new URL("messages-recv.js", dependency), "utf8");
  const code = source.slice(source.indexOf("    const sendMessageAck = "), source.indexOf("    const rejectCall = "));
  const sent = [];
  const context = { authState: { creds: {} }, logger: { debug() {} },
    buildAckStanza: (node, error, id) => { assert.equal(id, undefined); return { tag: "ack", attrs: { id: node.attrs.id } }; },
    sendNode: async stanza => sent.push(stanza) };
  const ack = vm.runInNewContext(`${code}\nsendMessageAck`, context);
  await ack({ tag: "notification", attrs: { id: "prelogin", type: "companion_reg_refresh" } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tag, "ack");
});
