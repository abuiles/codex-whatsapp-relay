// Scheduled messages and drafts, persisted and sent by the runtime daemon.
// A draft has no sendAt and is sent only by whatsapp_send_draft, after the
// user has seen it. A send is never retried: an entry moves to "sending" before the call, so a
// crash mid-send leaves it as "unknown" instead of sending it twice.
import { randomUUID } from "node:crypto";

import { scheduledFile } from "./paths.mjs";
import { JsonFile } from "./watch-rules.mjs";

export const MAX_LATE_MINUTES = 60;

export class ScheduledStore extends JsonFile {
  constructor(filePath = scheduledFile) {
    super(filePath, () => ({ version: 1, items: [] }));
  }

  async add(input) {
    const item = { id: `s_${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), status: "pending", ...input };
    this.data.items.push(item);
    await this.save();
    return item;
  }

  async cancel(id) {
    const item = this.data.items.find(entry => entry.id === id);
    if (!item || !["pending", "draft"].includes(item.status)) return item ?? null;
    item.status = "cancelled";
    item.cancelledAt = new Date().toISOString();
    await this.save();
    return item;
  }

  list({ includeDone = false } = {}) {
    return this.data.items.filter(item => includeDone || ["draft", "pending", "sending"].includes(item.status))
      .sort((a, b) => (a.sendAt ?? 0) - (b.sendAt ?? 0));
  }

  draft(id) {
    const item = this.data.items.find(entry => entry.id === id);
    if (!item) throw new Error(`No draft ${id}. whatsapp_list_scheduled lists drafts.`);
    if (item.status !== "draft") throw new Error(`${id} is ${item.status}, not a draft; nothing was sent.`);
    return item;
  }

  // Same bookkeeping as a scheduled send: "sending" before the call, so a
  // crash leaves "unknown" rather than a draft that could go out twice.
  async sendDraft(id, { text, send }) {
    const item = this.draft(id);
    if (text !== undefined) item.text = text;
    item.status = "sending";
    await this.save();
    const result = await send(item).catch(error => ({ ok: false, error: error.message }));
    if (result.retry) { item.status = "draft"; item.error = result.error; }
    else {
      item.status = result.ok ? "sent" : "failed";
      item.sentAt = new Date().toISOString();
      if (result.messageId) item.messageId = result.messageId;
      if (result.error) item.error = result.error;
    }
    await this.save();
    return { item, result };
  }

  async scheduleDraft(id, { text, sendAt, maxLateMinutes }) {
    const item = this.draft(id);
    if (text !== undefined) item.text = text;
    Object.assign(item, { status: "pending", sendAt, maxLateMinutes });
    await this.save();
    return item;
  }

  // Call once at startup: an entry left in "sending" by a crash has an unknown outcome.
  async recoverInterrupted() {
    const stuck = this.data.items.filter(item => item.status === "sending");
    for (const item of stuck) {
      item.status = "unknown";
      item.error = "the relay stopped while this message was being sent; check the chat before sending again";
    }
    if (stuck.length) await this.save();
    return stuck;
  }

  // send(item) returns { ok, messageId?, error?, retry? }; it is the normal send tool.
  async runDue({ send, now = Date.now() }) {
    const done = [];
    for (const item of this.data.items) {
      if (item.status !== "pending" || item.sendAt > now) continue;
      if (now - item.sendAt > (item.maxLateMinutes ?? MAX_LATE_MINUTES) * 60_000) {
        item.status = "missed";
        item.error = `not sent: the relay was offline until ${new Date(now).toISOString()}`;
        done.push(item);
        continue;
      }
      item.status = "sending";
      await this.save();
      const result = await send(item).catch(error => ({ ok: false, error: error.message }));
      // Refused before anything was sent (rate limit): safe to try next tick.
      if (result.retry) { item.status = "pending"; item.error = result.error; done.push(item); continue; }
      item.status = result.ok ? "sent" : "failed";
      item.sentAt = new Date().toISOString();
      if (result.messageId) item.messageId = result.messageId;
      if (result.error) item.error = result.error;
      done.push(item);
    }
    if (done.length) await this.save();
    return done;
  }
}
