// Tools beyond reading and sending: attention (digest, watch rules, alerts),
// media text, status updates, chat management, group admin, presence,
// blocking, contact cards, scheduled messages and drafts. They share the helpers of
// createWhatsAppService through ctx.
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { downloadMessageMedia, freezePreparedMedia, prepareMedia } from "./media.mjs";
import { extractMediaText, mediaKind } from "./media-text.mjs";
import { MAX_LATE_MINUTES } from "./scheduler.mjs";
import { STATUS_JID, queryPhoneDigits } from "./store.mjs";
import { readAlerts } from "./watch-rules.mjs";

const iso = seconds => seconds ? new Date(seconds * 1000).toISOString() : "unknown-time";

// Phone numbers or JIDs to user JIDs; never guesses beyond digits@s.whatsapp.net.
export function toUserJid(value, store) {
  if (value.includes("@")) return store ? store.canonicalJid(value) : value;
  const digits = queryPhoneDigits(value);
  if (!digits) throw new Error(`"${value}" is not a phone number with country code or a WhatsApp ID.`);
  return `${digits}@s.whatsapp.net`;
}

export function extraTools(ctx) {
  const { runtime, store, textResult, liveSocket, resolveChatOrError, resolveRecipient, cachedMessage, sendContent,
    sendStored, refreshCache, freshness, messageSummary, chatSummary, watches, scheduled, bugReporter, mode, mediaInput, recipient, chatTarget } = ctx;

  // The daemon shares one in-memory copy with its alert engine and scheduler;
  // a cache-only worker rereads the daemon's file on every call.
  const loaded = name => mode === "cache_only" ? ctx[name].load() : ctx[name].ensureLoaded();

  function lastMessages(chat) {
    const newest = [...(store.data.messages[chat.id] ?? [])].reverse().find(entry => entry.rawMessage);
    if (!newest) throw new Error(`No cached message in ${chat.displayName}; WhatsApp needs the newest message to apply this change. Call whatsapp_sync_history first.`);
    const raw = store.getRawMessage(chat.id, newest.id);
    return [{ key: raw.key, messageTimestamp: raw.messageTimestamp }];
  }

  function ruleLine(rule) {
    const parts = [`- ${rule.id}`, rule.label ? `label="${rule.label}"` : null, `action=${rule.action}`,
      rule.chatId ? `chat=${store.chatName(rule.chatId)} (${rule.chatId})` : null, rule.chatKind && rule.chatKind !== "any" ? `kind=${rule.chatKind}` : null,
      rule.from ? `from="${rule.from}"` : null, rule.contains?.length ? `contains=${JSON.stringify(rule.contains)}` : null,
      rule.regex ? `regex=/${rule.regex}/i` : null, rule.mentionsMe ? "mentions_me=yes" : null, rule.once ? "once=yes" : null,
      rule.expiresAt ? `expires=${new Date(rule.expiresAt).toISOString()}` : null, `fired=${rule.firedCount ?? 0}`,
      rule.lastFiredAt ? `last_fired=${rule.lastFiredAt}` : null];
    return parts.filter(Boolean).join(" ");
  }

  // A worker without the daemon has its own copy of these files; writing
  // them there would race the daemon's copy and be lost.
  const needDaemon = what => {
    if (mode === "cache_only") throw new Error(`${what} needs the relay runtime daemon, which is unreachable. Check runtime-daemon.log, then call whatsapp_auth_status.`);
  };

  function sendTime({ sendAt, inMinutes }) {
    const at = sendAt ? Date.parse(sendAt) : Date.now() + inMinutes * 60_000;
    if (!Number.isFinite(at)) throw new Error("sendAt is not a valid ISO 8601 time.");
    if (at < Date.now() + 30_000) throw new Error("sendAt must be at least 30 seconds in the future; leave it out to send now.");
    return at;
  }

  const engineNote = mode === "daemon"
    ? "engine: running in the relay runtime daemon"
    : "engine: not running in this process (rules fire only while the relay runtime daemon runs)";

  const timing = {
    sendAt: z.string().optional().describe("ISO 8601 time with offset, e.g. 2026-11-02T09:00:00-05:00"),
    inMinutes: z.number().min(1).max(60 * 24 * 60).optional(),
    maxLateMinutes: z.number().min(1).max(24 * 60).optional()
  };

  return [
    {
      name: "whatsapp_digest",
      description: "What needs your attention, grouped by chat: unread counts, messages that @mention you or reply to you, and questions waiting for your reply. Muted and archived chats sink to the bottom. Reads only; marks nothing read.",
      input: {
        sinceHours: z.number().min(1).max(24 * 14).optional().describe("Look back this many hours (default 24)"),
        limitPerChat: z.number().int().min(1).max(20).optional(),
        maxChats: z.number().int().min(1).max(100).optional(),
        includeMuted: z.boolean().optional()
      },
      mutates: false,
      async handler({ sinceHours = 24, limitPerChat = 3, maxChats = 30, includeMuted = true }) {
        await refreshCache();
        const state = await freshness();
        const sinceTimestamp = Math.floor(Date.now() / 1000 - sinceHours * 3600);
        const chats = store.digest({ sinceTimestamp, limitPerChat }).filter(chat => includeMuted || !chat.muted);
        const lines = [...state, `since: ${iso(sinceTimestamp)}`, `chats_needing_attention: ${chats.length}`,
          `mentions_total: ${chats.reduce((sum, chat) => sum + chat.mentions.length, 0)}`,
          `questions_total: ${chats.reduce((sum, chat) => sum + chat.questions.length, 0)}`,
          `unread_total: ${chats.reduce((sum, chat) => sum + chat.unread, 0)}`];
        for (const chat of chats.slice(0, maxChats)) {
          lines.push("", `## ${chat.chatName} (${chat.chatId}) unread=${chat.unread}${chat.markedUnread ? " marked_unread=yes" : ""}${chat.muted ? " muted=yes" : ""}`);
          if (chat.mentions.length) lines.push("mentions_or_replies_to_you:", ...chat.mentions.map(m => messageSummary(m)));
          if (chat.questions.length) lines.push("awaiting_your_reply:", ...chat.questions.map(m => messageSummary(m)));
          const shown = new Set([...chat.mentions, ...chat.questions].map(m => m.id));
          const latest = chat.latest.filter(m => !shown.has(m.id));
          if (latest.length) lines.push("latest:", ...latest.map(m => messageSummary(m)));
        }
        if (chats.length > maxChats) lines.push("", `(${chats.length - maxChats} more chats; raise maxChats)`);
        return textResult(lines.join("\n"));
      }
    },
    {
      name: "whatsapp_watch",
      description: "Add a persistent rule that reacts to new incoming messages, even while no Codex thread is open. Match by chat, sender, keywords, regex, chat kind or @mentions of you. action=notify shows a macOS notification; codex starts a background `codex exec` run (capped: one at a time, 6/hour, 5 min cooldown per rule) with the matched messages; record only logs to whatsapp_alerts. Matches are batched for 15 s.",
      input: {
        label: z.string().max(80).optional(),
        ...chatTarget,
        from: z.string().min(1).optional().describe("Sender name (partial, accent-insensitive), phone number, or WhatsApp ID"),
        contains: z.array(z.string().min(1)).max(20).optional().describe("Fire when the text contains any of these words"),
        regex: z.string().max(200).optional(),
        chatKind: z.enum(["any", "direct", "group"]).optional(),
        mentionsMe: z.boolean().optional().describe("In groups, only messages that @mention you or reply to you"),
        includeMuted: z.boolean().optional(),
        action: z.enum(["notify", "codex", "record"]).optional(),
        codexPrompt: z.string().max(4000).optional().describe("Instructions for the Codex run; matched messages are included automatically"),
        codexSandbox: z.enum(["read-only", "workspace-write"]).optional(),
        cooldownMinutes: z.number().min(0).max(1440).optional(),
        once: z.boolean().optional(),
        expiresInHours: z.number().min(0.1).max(24 * 365).optional()
      },
      mutates: false,
      async handler({ chatId, chatName, expiresInHours, action = "notify", regex, ...rest }) {
        needDaemon("Adding a watch rule");
        await loaded("watches");
        if (regex) new RegExp(regex, "iu");
        const chat = chatId || chatName ? resolveChatOrError({ chatId, chatName }) : null;
        if (!chat && !rest.from && !rest.contains?.length && !regex && !rest.mentionsMe && action === "codex") {
          throw new Error("A codex rule must be narrowed by chat, sender, keywords, regex or mentionsMe; it would otherwise start a run for every message.");
        }
        const rule = await watches.add({ ...rest, action, regex, chatId: chat?.id,
          expiresAt: expiresInHours ? Date.now() + expiresInHours * 3600_000 : undefined });
        return textResult([`status: watching`, ruleLine(rule), engineNote].join("\n"));
      }
    },
    {
      name: "whatsapp_unwatch",
      description: "Remove a watch rule by id (see whatsapp_list_watches).",
      input: { id: z.string().min(1) },
      mutates: false,
      async handler({ id }) {
        needDaemon("Removing a watch rule");
        await loaded("watches");
        return textResult(await watches.remove(id) ? `removed: ${id}` : `No watch rule ${id}.`, { isError: false });
      }
    },
    {
      name: "whatsapp_list_watches",
      description: "List active watch rules and whether the alert engine is running.",
      input: {},
      mutates: false,
      async handler() {
        await loaded("watches");
        const rules = watches.list();
        return textResult([engineNote, `rule_count: ${rules.length}`, ...rules.map(ruleLine)].join("\n"));
      }
    },
    {
      name: "whatsapp_alerts",
      description: "Read what watch rules did (notified, recorded, Codex run started/finished, deferred by the run cap), oldest first after a cursor. Codex results include the path of the saved final message.",
      input: { cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional() },
      mutates: false,
      async handler({ cursor = 0, limit = 50 }) {
        const { alerts, nextCursor } = await readAlerts({ cursor, limit, alertsPath: ctx.alertsPath });
        const lines = [`alerts: ${alerts.length}`, `next_cursor: ${nextCursor}`];
        for (const alert of alerts) {
          lines.push(`- seq=${alert.seq} at=${alert.at} rule=${alert.ruleId}${alert.label ? ` label="${alert.label}"` : ""} outcome=${alert.outcome}` +
            `${alert.reason ? ` reason="${alert.reason}"` : ""}${alert.outputFile ? ` output=${alert.outputFile}` : ""}${alert.error ? ` error="${alert.error}"` : ""}`);
          for (const m of alert.messages ?? []) lines.push(`    [${iso(m.timestamp)}] ${m.chatName} id=${m.id} ${m.sender}: ${m.text}`);
        }
        return textResult(lines.join("\n"));
      }
    },
    {
      name: "whatsapp_report_bug",
      description: "Report a bug in this WhatsApp relay: a tool crashed, returned something wrong, or cannot do what its description says. A coding agent watching the reports fixes the relay. Say which tool and arguments you used and what went wrong; message text in args is replaced by its length, so the report never contains anyone's messages. Sends nothing to WhatsApp.",
      input: {
        tool: z.string().min(1).optional().describe("The whatsapp_* tool that misbehaved"),
        args: z.record(z.string(), z.unknown()).optional().describe("The arguments you passed"),
        problem: z.string().min(1).max(2000).describe("What went wrong, including the error text if there was one"),
        expected: z.string().max(1000).optional().describe("What you expected instead")
      },
      mutates: false,
      async handler({ tool, args, problem, expected }) {
        const filed = await bugReporter.report({ source: "agent", tool, args, problem, expected });
        if (!filed.id) return textResult(`status: not_filed\nreason: ${filed.skipped}\nCarry on with another approach; the earlier report covers this.`);
        return textResult([`status: filed`, `bug_report: ${filed.id}`,
          "Tell the user it was reported, and carry on another way with the whatsapp_* tools; do not switch to the WhatsApp app."].join("\n"));
      }
    },
    {
      name: "whatsapp_media_text",
      description: "Make media searchable: transcribe voice notes, audio and video, OCR images, and extract text from PDFs and documents, all on this machine. The text is saved with the message (whatsapp_search_messages finds it) and returned. Images are also returned inline so you can describe them. Give messageIds, or a chat to process its newest media.",
      input: {
        ...chatTarget,
        messageIds: z.array(z.string().min(1)).max(25).optional(),
        limit: z.number().int().min(1).max(25).optional(),
        force: z.boolean().optional().describe("Redo messages that already have text")
      },
      mutates: false,
      async handler({ chatId, chatName, messageIds, limit = 5, force = false }) {
        const chat = resolveChatOrError({ chatId, chatName });
        const list = store.data.messages[chat.id] ?? [];
        const targets = messageIds
          ? messageIds.map(id => list.find(entry => entry.id === id) ?? { id, missing: true })
          : list.filter(entry => entry.media && mediaKind(entry.media.mimetype, entry.media.fileName) && (force || !entry.extractedText)).slice(-limit);
        if (!targets.length) return textResult(`No unprocessed media with a text extractor in ${chat.displayName}.`);
        const socket = await liveSocket("Media download");
        const content = [];
        const lines = [`chat: ${chat.displayName} (${chat.id})`];
        let images = 0;
        for (const entry of targets) {
          if (entry.missing) { lines.push(`- id=${entry.id} error=not_in_cache`); continue; }
          if (entry.extractedText && !force) { lines.push(`- id=${entry.id} kind=${entry.extractedKind} cached=yes`, entry.extractedText); continue; }
          try {
            const raw = store.getRawMessage(chat.id, entry.id);
            if (!raw) throw new Error("no raw message cached; it cannot be downloaded");
            const file = await downloadMessageMedia(raw, socket, { logger: runtime.logger });
            const result = await extractMediaText({ filePath: file.path, mimetype: file.mimetype, fileName: entry.media?.fileName });
            store.setExtractedText(chat.id, entry.id, result.text, result.kind);
            lines.push(`- id=${entry.id} [${iso(entry.timestamp)}] ${store.senderName(entry)} kind=${result.kind} chars=${result.text.length}${result.truncated ? " truncated=yes" : ""} file=${file.path}`,
              result.text || "(no text found)");
            if (result.kind === "ocr" && images < 3 && file.bytes <= 5 * 1024 * 1024) {
              images += 1;
              content.push({ type: "image", mimeType: file.mimetype, data: (await fs.readFile(file.path)).toString("base64") });
            }
          } catch (error) {
            lines.push(`- id=${entry.id} error=${error.message.split("\n")[0]}`);
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }, ...content], isError: false };
      }
    },
    {
      name: "whatsapp_status",
      description: "Status updates (stories). action=list shows your contacts' status updates from the last 24 h grouped by person; action=post publishes a text or media status to an explicit audience (\"contacts\" = everyone saved in your address book that the cache knows, or a list of phone numbers).",
      input: {
        action: z.enum(["list", "post"]),
        sinceHours: z.number().min(1).max(48).optional(),
        text: z.string().max(700).optional(),
        media: z.object(mediaInput).optional(),
        backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        audience: z.union([z.literal("contacts"), z.array(z.string().min(7)).min(1).max(1000)]).optional()
      },
      mutates: true,
      async handler({ action, sinceHours = 24, text, media, backgroundColor, audience }) {
        if (action === "list") {
          await refreshCache();
          const updates = store.statusUpdates({ sinceTimestamp: Math.floor(Date.now() / 1000 - sinceHours * 3600) });
          const byPoster = new Map();
          for (const update of updates) {
            const key = update.fromMe ? "me" : update.participant ?? "unknown";
            byPoster.set(key, [...(byPoster.get(key) ?? []), update]);
          }
          const lines = [...await freshness(), `status_updates: ${updates.length}`, `posters: ${byPoster.size}`];
          for (const [poster, items] of byPoster) {
            lines.push("", `## ${poster === "me" ? "me" : `${store.chatName(poster)} (${poster})`}`, ...items.map(m => messageSummary(m)));
          }
          return textResult(lines.join("\n"));
        }
        if (!audience) throw new Error("Posting a status needs an explicit audience: \"contacts\" or a list of phone numbers.");
        if (!text?.trim() && !media) throw new Error("Provide text or media.");
        if (text?.trim() && media) throw new Error("Use media.caption for a media status.");
        const jids = audience === "contacts"
          ? [...new Set(Object.values(store.data.contacts).filter(contact => contact.name)
            .map(contact => [contact.phoneNumber, contact.id].find(jid => jid?.endsWith("@s.whatsapp.net"))).filter(Boolean))]
          : audience.map(value => toUserJid(value));
        if (!jids.length) throw new Error("No saved contacts with phone numbers are cached; pass phone numbers as audience.");
        const content = media ? (await freezePreparedMedia(await prepareMedia(media))).content : { text };
        const chat = { id: STATUS_JID, displayName: "Status updates" };
        return sendContent(chat, content, { statusJidList: jids, broadcast: true, backgroundColor }, [`audience_size: ${jids.length}`]);
      }
    },
    {
      name: "whatsapp_manage_chat",
      description: "Change a chat the way the phone's chat list does: archive, unarchive, pin, unpin, mute (durationHours, omit for always), unmute, mark_unread, clear (delete all messages in the chat for you), star or unstar a message (messageId). Syncs to your phone.",
      input: {
        ...chatTarget,
        action: z.enum(["archive", "unarchive", "pin", "unpin", "mute", "unmute", "mark_unread", "clear", "star", "unstar"]),
        durationHours: z.number().min(0.1).max(24 * 365).optional(),
        messageId: z.string().min(1).optional()
      },
      mutates: true,
      async handler({ chatId, chatName, action, durationHours, messageId }) {
        const chat = resolveChatOrError({ chatId, chatName });
        const socket = await liveSocket("Changing a chat");
        let local = {};
        switch (action) {
          case "archive": case "unarchive":
            await socket.chatModify({ archive: action === "archive", lastMessages: lastMessages(chat) }, chat.id);
            local = { archived: action === "archive" };
            break;
          case "pin": case "unpin":
            await socket.chatModify({ pin: action === "pin" }, chat.id);
            local = { pinned: action === "pin" ? Date.now() : null };
            break;
          case "mute": {
            // WhatsApp stores the end time in milliseconds; -1 is "always".
            const until = durationHours ? Date.now() + durationHours * 3600_000 : -1;
            await socket.chatModify({ mute: until }, chat.id);
            local = { muteEndTime: until };
            break;
          }
          case "unmute":
            await socket.chatModify({ mute: null }, chat.id);
            local = { muteEndTime: null };
            break;
          case "mark_unread":
            await socket.chatModify({ markRead: false, lastMessages: lastMessages(chat) }, chat.id);
            local = { unreadCount: -1 };
            break;
          case "clear":
            await socket.chatModify({ clear: true, lastMessages: lastMessages(chat) }, chat.id);
            break;
          case "star": case "unstar": {
            if (!messageId) throw new Error("Starring needs messageId.");
            const { entry } = cachedMessage(chat, messageId);
            await socket.star(chat.id, [{ id: entry.id, fromMe: entry.fromMe }], action === "star");
            break;
          }
        }
        if (Object.keys(local).length) store.upsertChat({ id: chat.id, ...local });
        return textResult([`status: applied`, `action: ${action}`, `chat: ${chat.displayName} (${chat.id})`,
          ...(local.muteEndTime > 0 ? [`muted_until: ${new Date(local.muteEndTime).toISOString()}`] : [])].join("\n"));
      }
    },
    {
      name: "whatsapp_group_admin",
      description: "Manage groups: create (subject + participants), add, remove, promote, demote (participants), subject, description, invite_link, revoke_invite, join (inviteLink), leave, settings (announcement/not_announcement = who can send; locked/unlocked = who can edit info). Participants are phone numbers or WhatsApp IDs.",
      input: {
        action: z.enum(["create", "add", "remove", "promote", "demote", "subject", "description", "invite_link", "revoke_invite", "join", "leave", "settings"]),
        ...chatTarget,
        participants: z.array(z.string().min(5)).max(256).optional(),
        subject: z.string().min(1).max(100).optional(),
        description: z.string().max(2048).optional(),
        inviteLink: z.string().min(5).optional(),
        setting: z.enum(["announcement", "not_announcement", "locked", "unlocked"]).optional()
      },
      mutates: true,
      async handler({ action, chatId, chatName, participants, subject, description, inviteLink, setting }) {
        const socket = await liveSocket("Group admin");
        const jids = () => {
          if (!participants?.length) throw new Error(`${action} needs participants.`);
          return participants.map(value => toUserJid(value, store));
        };
        if (action === "create") {
          if (!subject) throw new Error("create needs a subject.");
          const metadata = await socket.groupCreate(subject, jids());
          store.upsertChat({ id: metadata.id, name: metadata.subject, subject: metadata.subject });
          return textResult(`status: created\ngroup: ${metadata.subject} (${metadata.id})\nparticipants: ${metadata.participants?.length ?? "?"}`);
        }
        if (action === "join") {
          const code = /([A-Za-z0-9]{10,})\/?$/.exec(inviteLink ?? "")?.[1];
          if (!code) throw new Error("join needs an inviteLink like https://chat.whatsapp.com/XXXX.");
          return textResult(`status: joined\ngroup_id: ${await socket.groupAcceptInvite(code)}`);
        }
        const chat = resolveChatOrError({ chatId, chatName });
        if (!chat.id.endsWith("@g.us")) throw new Error(`${chat.displayName} is not a group.`);
        const head = `group: ${chat.displayName} (${chat.id})`;
        switch (action) {
          case "add": case "remove": case "promote": case "demote": {
            const results = await socket.groupParticipantsUpdate(chat.id, jids(), action);
            return textResult([head, `action: ${action}`, ...(results ?? []).map(r => `- ${r.jid} status=${r.status}${r.status === "200" ? " ok" : r.status === "403" ? " (invite needed or not allowed)" : r.status === "408" ? " (they recently left)" : r.status === "409" ? " (already in group)" : ""}`)].join("\n"));
          }
          case "subject":
            if (!subject) throw new Error("subject needs subject.");
            await socket.groupUpdateSubject(chat.id, subject);
            store.upsertChat({ id: chat.id, name: subject, subject });
            return textResult(`${head}\nstatus: subject_updated`);
          case "description":
            await socket.groupUpdateDescription(chat.id, description || undefined);
            return textResult(`${head}\nstatus: description_updated`);
          case "invite_link":
            return textResult(`${head}\ninvite_link: https://chat.whatsapp.com/${await socket.groupInviteCode(chat.id)}`);
          case "revoke_invite":
            return textResult(`${head}\nnew_invite_link: https://chat.whatsapp.com/${await socket.groupRevokeInvite(chat.id)}`);
          case "leave":
            await socket.groupLeave(chat.id);
            return textResult(`${head}\nstatus: left`);
          case "settings":
            if (!setting) throw new Error("settings needs setting.");
            await socket.groupSettingUpdate(chat.id, setting);
            return textResult(`${head}\nstatus: ${setting}`);
        }
        throw new Error(`Unsupported action ${action}.`);
      }
    },
    {
      name: "whatsapp_presence",
      description: "Presence: show typing/recording/paused in a chat, go available/unavailable, or subscribe to a contact and report whether they are online and when they were last seen (if their privacy settings allow).",
      input: {
        action: z.enum(["typing", "recording", "paused", "available", "unavailable", "get"]),
        ...recipient,
        waitSeconds: z.number().min(0).max(10).optional()
      },
      mutates: false,
      async handler({ action, chatId, chatName, phoneNumber, waitSeconds = 3 }) {
        const socket = await liveSocket("Presence");
        if (action === "available" || action === "unavailable") {
          await socket.sendPresenceUpdate(action);
          return textResult(`status: ${action}`);
        }
        const chat = await resolveRecipient({ chatId, chatName, phoneNumber });
        if (action !== "get") {
          await socket.sendPresenceUpdate(action === "typing" ? "composing" : action, chat.id);
          return textResult(`status: ${action}\nchat: ${chat.displayName} (${chat.id})`);
        }
        await socket.presenceSubscribe(chat.id);
        const deadline = Date.now() + waitSeconds * 1000;
        let seen = runtime.presence?.get(store.canonicalJid(chat.id));
        while (!seen && Date.now() < deadline) { await delay(250); seen = runtime.presence?.get(store.canonicalJid(chat.id)); }
        if (!seen) return textResult(`chat: ${chat.displayName} (${chat.id})\npresence: unknown (no update within ${waitSeconds}s; their privacy settings may hide it)`);
        return textResult([`chat: ${chat.displayName} (${chat.id})`, `presence: ${seen.lastKnownPresence ?? "unknown"}`,
          `last_seen: ${seen.lastSeen ? iso(seen.lastSeen) : "hidden_or_online"}`, `observed_at: ${new Date(seen.at).toISOString()}`].join("\n"));
      }
    },
    {
      name: "whatsapp_block",
      description: "Block or unblock a contact, or list blocked contacts.",
      input: { action: z.enum(["block", "unblock", "list"]), ...recipient },
      mutates: true,
      async handler({ action, chatId, chatName, phoneNumber }) {
        const socket = await liveSocket("Blocking");
        if (action === "list") {
          const list = await socket.fetchBlocklist();
          return textResult([`blocked_count: ${list.length}`, ...list.map(jid => `- ${store.chatName(jid)} (${jid})`)].join("\n"));
        }
        const chat = await resolveRecipient({ chatId, chatName, phoneNumber });
        if (chat.id.endsWith("@g.us")) throw new Error("Groups cannot be blocked; use whatsapp_group_admin leave or whatsapp_manage_chat mute.");
        await socket.updateBlockStatus(chat.id, action);
        return textResult(`status: ${action}ed\nchat: ${chat.displayName} (${chat.id})`);
      }
    },
    {
      name: "whatsapp_send_contact",
      description: "Send one or more contact cards (name + phone number) to a chat, group, or phone number.",
      input: {
        ...recipient,
        contacts: z.array(z.object({ name: z.string().min(1).max(100), phoneNumber: z.string().min(7) })).min(1).max(10)
      },
      mutates: true,
      async handler({ chatId, chatName, phoneNumber, contacts }) {
        const cards = contacts.map(({ name, phoneNumber: number }) => {
          const digits = queryPhoneDigits(number);
          if (!digits) throw new Error(`${number} is not an international phone number.`);
          const safe = name.replace(/[\r\n;]/g, " ");
          return { displayName: safe, vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${safe}\nTEL;type=CELL;waid=${digits}:+${digits}\nEND:VCARD` };
        });
        const chat = await resolveRecipient({ chatId, chatName, phoneNumber });
        return sendContent(chat, { contacts: { displayName: cards.length === 1 ? cards[0].displayName : `${cards.length} contacts`, contacts: cards } });
      }
    },
    {
      name: "whatsapp_schedule_message",
      description: "Schedule a text message. The relay runtime daemon sends it at sendAt (it must be running then; if it is offline for more than maxLateMinutes past the time, the message is marked missed instead of sent late). Never retried automatically.",
      input: {
        ...recipient,
        text: z.string().min(1).max(4000),
        ...timing
      },
      mutates: true,
      async handler({ chatId, chatName, phoneNumber, text, sendAt, inMinutes, maxLateMinutes = MAX_LATE_MINUTES }) {
        needDaemon("Scheduling a message");
        await loaded("scheduled");
        if (!!sendAt === !!inMinutes) throw new Error("Provide exactly one of sendAt or inMinutes.");
        const at = sendTime({ sendAt, inMinutes });
        const chat = await resolveRecipient({ chatId, chatName, phoneNumber });
        const item = await scheduled.add({ chatId: chat.id, chatName: chat.displayName, text, sendAt: at, maxLateMinutes });
        return textResult([`status: scheduled`, `id: ${item.id}`, `chat: ${chat.displayName} (${chat.id})`, `send_at: ${new Date(at).toISOString()}`,
          mode === "daemon" ? "sender: relay runtime daemon" : "sender: the relay runtime daemon (not this process); it must be running at send time"].join("\n"));
      }
    },
    {
      name: "whatsapp_list_scheduled",
      description: "List drafts and scheduled messages (drafts and pending by default; includeDone shows sent, failed, missed, cancelled and unknown ones with message IDs or errors).",
      input: { includeDone: z.boolean().optional() },
      mutates: false,
      async handler({ includeDone = false }) {
        await loaded("scheduled");
        const items = scheduled.list({ includeDone });
        return textResult([`scheduled: ${items.length}`, ...items.map(item =>
          `- ${item.id} status=${item.status}${item.sendAt ? ` send_at=${new Date(item.sendAt).toISOString()}` : ""} chat=${item.chatName} (${item.chatId})` +
          `${item.messageId ? ` message_id=${item.messageId}` : ""}${item.error ? ` error="${item.error}"` : ""} text=${JSON.stringify(item.text.slice(0, 120))}`)].join("\n"));
      }
    },
    {
      name: "whatsapp_cancel_scheduled",
      description: "Cancel a pending scheduled message, or discard a draft, by id.",
      input: { id: z.string().min(1) },
      mutates: false,
      async handler({ id }) {
        needDaemon("Cancelling a scheduled message");
        await loaded("scheduled");
        const item = await scheduled.cancel(id);
        if (!item) throw new Error(`No scheduled message or draft ${id}.`);
        return textResult(item.status === "cancelled" ? `cancelled: ${id}` : `Not cancelled: ${id} is already ${item.status}.`, { isError: item.status !== "cancelled" });
      }
    },
    {
      name: "whatsapp_draft_message",
      description: "Save a text message as a draft without sending it. Use this whenever the user should see a message before it goes out (replies written for them, anything to a new contact or a group, anything you are unsure of): show the user the draft text, then call whatsapp_send_draft only after they approve. WhatsApp has no drafts for linked devices, so drafts live in the relay, not in the phone app.",
      input: {
        ...recipient,
        text: z.string().min(1).max(4000),
        replyToMessageId: z.string().min(1).optional(),
        mentions: z.array(z.string().min(5)).max(50).optional()
      },
      mutates: false,
      async handler({ chatId, chatName, phoneNumber, text, replyToMessageId, mentions }) {
        needDaemon("Saving a draft");
        await loaded("scheduled");
        const chat = await resolveRecipient({ chatId, chatName, phoneNumber });
        if (replyToMessageId) cachedMessage(chat, replyToMessageId);
        const item = await scheduled.add({ status: "draft", sendAt: null, chatId: chat.id, chatName: chat.displayName, text,
          ...(replyToMessageId ? { replyToMessageId } : {}), ...(mentions?.length ? { mentions } : {}) });
        return textResult([`status: draft_saved`, `id: ${item.id}`, `chat: ${chat.displayName} (${chat.id})`,
          ...(replyToMessageId ? [`reply_to: ${replyToMessageId}`] : []), `text: ${JSON.stringify(text)}`,
          "Nothing was sent. Show this draft to the user; after they approve, call whatsapp_send_draft with this id (optionally with edited text or a send time). whatsapp_cancel_scheduled discards it."].join("\n"));
      }
    },
    {
      name: "whatsapp_send_draft",
      description: "Send a draft the user has approved, now or at sendAt/inMinutes. text replaces the draft text first (the user's edits). Never call this for a draft the user has not seen.",
      input: { id: z.string().min(1), text: z.string().min(1).max(4000).optional(), ...timing },
      mutates: true,
      async handler({ id, text, sendAt, inMinutes, maxLateMinutes = MAX_LATE_MINUTES }) {
        needDaemon("Sending a draft");
        await loaded("scheduled");
        if (sendAt && inMinutes) throw new Error("Provide at most one of sendAt or inMinutes.");
        if (sendAt || inMinutes) {
          const at = sendTime({ sendAt, inMinutes });
          const item = await scheduled.scheduleDraft(id, { text, sendAt: at, maxLateMinutes });
          return textResult([`status: scheduled`, `id: ${item.id}`, `chat: ${item.chatName} (${item.chatId})`, `send_at: ${new Date(at).toISOString()}`].join("\n"));
        }
        const { item, result } = await scheduled.sendDraft(id, { text, send: sendStored });
        if (result.retry) return textResult([`status: rate_limited`, `id: ${id}`, `reason: ${result.error}`, "Nothing was sent; the draft is kept. Try again later."].join("\n"), { isError: true });
        if (!result.ok) return textResult([`status: failed`, `id: ${id}`, `error: ${result.error}`, "The draft is marked failed; check the chat before sending it again."].join("\n"), { isError: true });
        return textResult([`status: submitted`, `id: ${id}`, `chat: ${item.chatName} (${item.chatId})`,
          ...(result.messageId ? [`message_id: ${result.messageId}`] : ["via: controller_bridge"]), "delivery: not_yet_verified"].join("\n"));
      }
    }
  ];
}
