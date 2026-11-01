// WhatsApp auth state on disk, file-compatible with Baileys'
// useMultiFileAuthState but safe when more than one process touches the
// folder. Baileys locks only inside one process and writes in place, so two
// writers can leave a file holding one JSON value followed by the tail of
// another; it then reads as "missing" and app-state sync parks collections
// on a missing key. Here every write goes to a temp file and is renamed into
// place, and a torn file left by older versions is read back from its first
// complete JSON value.
import fs from "node:fs/promises";
import path from "node:path";

import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";

const fileName = name => name.replace(/\//g, "__").replace(/:/g, "-");

// The first complete JSON object or array in text, or null.
export function leadingJson(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

export function parseAuthJson(text) {
  try {
    return JSON.parse(text, BufferJSON.reviver);
  } catch {
    const head = leadingJson(text);
    if (!head) return null;
    try {
      return JSON.parse(head, BufferJSON.reviver);
    } catch {
      return null;
    }
  }
}

const KEY_REQUEST_EVERY_MS = 10 * 60 * 1000;

// Baileys never asks for an app-state key it lacks; it parks the collection
// until the phone happens to share one. WhatsApp Web asks the phone directly
// with an APP_STATE_SYNC_KEY_REQUEST peer message to our own account. It is
// device-to-device protocol traffic and shows up in no chat. The phone's
// APP_STATE_SYNC_KEY_SHARE reply lands in Baileys' normal handler, which
// stores the keys and resyncs the parked collections.
export class AppStateKeyRequester {
  constructor({ getSocket, logger, now = () => Date.now() }) {
    this.getSocket = getSocket;
    this.logger = logger;
    this.now = now;
    this.askedAt = new Map(); // keyId -> last request time
  }

  async request(ids) {
    const socket = this.getSocket();
    const me = socket?.user?.id;
    if (!me || typeof socket.relayMessage !== "function") return [];
    const now = this.now();
    const due = ids.filter(id => now - (this.askedAt.get(id) ?? -Infinity) >= KEY_REQUEST_EVERY_MS);
    if (!due.length) return [];
    for (const id of due) this.askedAt.set(id, now);
    const meJid = `${me.split(":")[0].split("@")[0]}@s.whatsapp.net`;
    try {
      await socket.relayMessage(meJid, {
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
          appStateSyncKeyRequest: { keyIds: due.map(id => ({ keyId: Buffer.from(id, "base64") })) }
        }
      }, {
        additionalAttributes: { category: "peer", push_priority: "high_force" },
        additionalNodes: [{ tag: "meta", attrs: { appdata: "default" } }]
      });
      this.logger?.info?.({ keyIds: due }, "requested missing app state sync keys from phone");
      return due;
    } catch (error) {
      for (const id of due) this.askedAt.delete(id);
      this.logger?.warn?.({ err: error, keyIds: due }, "failed to request app state sync keys");
      return [];
    }
  }
}

// onMissingKeys(type, ids) is called with the ids a get() could not find, so
// the caller can ask the phone for app-state keys instead of waiting forever.
export async function useAtomicMultiFileAuthState(folder, { onMissingKeys } = {}) {
  await fs.mkdir(folder, { recursive: true });
  let counter = 0;

  const read = async name => {
    try {
      return parseAuthJson(await fs.readFile(path.join(folder, fileName(name)), "utf8"));
    } catch {
      return null;
    }
  };
  const write = async (name, data) => {
    const file = path.join(folder, fileName(name));
    const temp = `${file}.${process.pid}.${++counter}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data, BufferJSON.replacer), { mode: 0o600 });
    await fs.rename(temp, file);
  };
  const remove = name => fs.unlink(path.join(folder, fileName(name))).catch(() => {});

  const creds = (await read("creds.json")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          const missing = [];
          await Promise.all(ids.map(async id => {
            let value = await read(`${type}-${id}.json`);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            if (value == null) missing.push(id);
            data[id] = value;
          }));
          if (missing.length) onMissingKeys?.(type, missing);
          return data;
        },
        set: async data => {
          const tasks = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              const name = `${type}-${id}.json`;
              tasks.push(value ? write(name, value) : remove(name));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write("creds.json", creds)
  };
}
