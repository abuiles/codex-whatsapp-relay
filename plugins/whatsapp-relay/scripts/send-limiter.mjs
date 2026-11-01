// Outgoing pacing. WhatsApp bans accounts that send fast or cold-message many
// new numbers, and an agent loop can do both by accident. Limits are per
// process (the daemon is the only sender) and refuse rather than queue, so a
// refused send never goes out later behind the agent's back.
const env = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const SEND_LIMITS = {
  globalPerMinute: env("WHATSAPP_SEND_RATE_GLOBAL_PER_MIN", 20),
  chatPerMinute: env("WHATSAPP_SEND_RATE_CHAT_PER_MIN", 6),
  newChatsPerHour: env("WHATSAPP_NEW_CHATS_PER_HOUR", 10)
};

export class SendLimiter {
  constructor({ limits = SEND_LIMITS, now = () => Date.now() } = {}) {
    this.limits = limits;
    this.now = now;
    this.sends = [];
    this.newChats = [];
  }

  // Returns null when allowed, or { reason, retryAfterSeconds }.
  check(chatId, { isNewChat = false } = {}) {
    const now = this.now();
    this.sends = this.sends.filter(send => now - send.at < 60_000);
    this.newChats = this.newChats.filter(at => now - at < 3600_000);
    const wait = (oldest, window) => Math.max(1, Math.ceil((oldest + window - now) / 1000));
    if (this.sends.length >= this.limits.globalPerMinute) {
      return { reason: `more than ${this.limits.globalPerMinute} sends in the last minute`, retryAfterSeconds: wait(this.sends[0].at, 60_000) };
    }
    const inChat = this.sends.filter(send => send.chatId === chatId);
    if (inChat.length >= this.limits.chatPerMinute) {
      return { reason: `more than ${this.limits.chatPerMinute} sends to this chat in the last minute`, retryAfterSeconds: wait(inChat[0].at, 60_000) };
    }
    if (isNewChat && this.newChats.length >= this.limits.newChatsPerHour) {
      return { reason: `more than ${this.limits.newChatsPerHour} first messages to new chats in the last hour`, retryAfterSeconds: wait(this.newChats[0], 3600_000) };
    }
    return null;
  }

  record(chatId, { isNewChat = false } = {}) {
    const at = this.now();
    this.sends.push({ chatId, at });
    if (isNewChat) this.newChats.push(at);
  }
}
