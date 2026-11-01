import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Metadata only. A timed-out request remains unresolved across worker reloads.
export class HistoryRequests {
  constructor(filePath) {
    this.filePath = filePath;
    this.requests = new Map();
    this.loaded = false;
    this.writes = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.requests)) throw new Error("Invalid history request journal");
      this.requests = new Map(data.requests.map(request => [request.id, request]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  list(chatId, requestId) {
    return [...this.requests.values()]
      .filter(request => (!chatId || request.chatId === chatId) && (!requestId || request.id === requestId))
      .map(request => structuredClone(request));
  }

  findUnresolved(chatId, anchorMessageId) {
    return this.list(chatId).find(request => request.anchorMessageId === anchorMessageId && request.state !== "response_received");
  }

  async update(id, patch) {
    const previous = this.requests.get(id);
    const changes = typeof patch === "function" ? patch(previous) : patch;
    const request = { ...previous, ...changes, id, updatedAt: new Date().toISOString() };
    this.requests.set(id, request);
    // Keep unresolved work; retain at most 100 completed requests.
    const complete = [...this.requests.values()].filter(item => item.state === "response_received");
    for (const item of complete.slice(0, -100)) this.requests.delete(item.id);
    const snapshot = JSON.stringify({ version: 1, requests: [...this.requests.values()] }, null, 2);
    const save = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, snapshot, { mode: 0o600, flag: "wx" });
        await fs.rename(temp, this.filePath);
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
    this.writes = save;
    await save;
    return structuredClone(request);
  }

  async recordResponse(payload, canonical = value => value) {
    const id = payload.peerDataRequestSessionId;
    const request = id && this.requests.get(id);
    if (!request) return;
    const ids = (payload.messages ?? [])
      .filter(message => canonical(message.key?.remoteJid) === canonical(request.chatId))
      .map(message => message.key?.id).filter(Boolean);
    return this.update(id, {
      state: "response_received",
      responseAt: new Date().toISOString(),
      sessionMatched: true,
      events: (request.events ?? 0) + 1,
      messages: (request.messages ?? 0) + ids.length,
      receivedMessageIds: [...new Set([...(request.receivedMessageIds ?? []), ...ids])].slice(0, 100)
    });
  }

  async recordAck(id, error) {
    if (!this.requests.has(id)) return;
    return this.update(id, previous => ({
      serverAckAt: new Date().toISOString(),
      ...(error ? { state: previous.state === "response_received" ? previous.state : "provider_rejected", error: `Provider rejected history request: ${error}` } : {})
    }));
  }
}
