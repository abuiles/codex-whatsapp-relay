---
name: whatsapp-relay
description: Connect and manage a local WhatsApp account from Codex using a terminal QR code and WhatsApp MCP tools.
---

# WhatsApp Relay

Use this skill when the user wants to connect WhatsApp, inspect recent chats, read messages, sync older history on demand, send a message from Codex, or control Codex from an allowed WhatsApp number.

## Workflow

1. Check local auth state first:

   Use the `whatsapp_auth_status` plugin tool.

2. If WhatsApp is not authenticated, run the QR flow:

   Use the `whatsapp_start_auth` plugin tool.

3. The tool returns a terminal QR block. Tell the user to scan that QR directly from the terminal or Codex output.

4. After auth succeeds, prefer the plugin's WhatsApp MCP tools for chat listing, history sync, message review, and sending replies.

5. If the QR code expires, rerun `whatsapp_start_auth`.

6. If the user wants to control Codex from WhatsApp, set up the controller bridge:

   Use `whatsapp_allow_controller`, then `whatsapp_start_controller_bridge`.

7. Once the bridge is running, allowed direct chats can:

   - send plain text to continue the current Codex session
   - send voice notes that are transcribed locally before continuing the current Codex session
   - receive outbound WhatsApp voice-note replies when voice reply mode is enabled for that chat
   - send `/new` to start fresh
   - send `/sessions` to list recent Codex threads
   - send `/connect <thread-id-prefix>` to switch this chat to another Codex session
   - send `/status` to inspect the active session
   - send `/permissions` to inspect the current permission level
   - send `/permissions read-only|workspace-write|danger-full-access` to change the session sandbox level
   - send `/approve`, `/approve session`, `/deny`, or `/cancel` to answer pending approvals in `workspace-write`
   - send `/stop` to cancel the in-flight Codex run
   - send `/help` to see command help

   The bridge uses `codex app-server` under the hood so each allowed number maps to a native Codex thread that can be resumed across messages.
   `workspace-write` is the safe default because guarded command and file-change approvals can be answered from WhatsApp.
   `danger-full-access` requires an explicit confirmation code from the chat before the bridge disables sandboxing for that session.
   Voice notes are transcribed locally with Parakeet v3 via `uvx` and `ffmpeg`, and short low-confidence transcripts are rejected so the chat can retry instead of sending a bad prompt to Codex.
   Outbound voice replies are synthesized locally. The default provider is macOS `say`, and `ResembleAI/chatterbox-turbo` can be installed as an optional local provider for richer speech.
   While the bridge is running, treat it as the sole owner of the live WhatsApp session. Prefer cached reads from MCP tools and route outbound messages through the bridge instead of reconnecting a second socket.
   If the allowed controller is the same WhatsApp account linked to the plugin, the self chat can be used as the control surface and should be treated as a valid source of prompts.

## Local state

 - Auth credentials: `plugins/whatsapp-relay/data/auth*`
- Chat cache: `plugins/whatsapp-relay/data/store.json`

## Rules

- Do not guess a chat if multiple names match. List candidates first.
- If the user asks for older messages that are not in the local cache yet, use `whatsapp_sync_history` before concluding the history is unavailable.
- Keep outbound messages short and explicit when the user asks you to send one.
- If the user only wants a draft, do not call the send tool.
- Keep `npm run whatsapp:auth` as a local fallback, not the primary path.
- When relaying a QR from the plugin tools, preserve the compact block as-is instead of restyling or expanding it.
- Only allow explicit controller numbers to drive Codex from WhatsApp. Group chats should not be used as a control surface.
- Treat anything under `plugins/whatsapp-relay/data/auth*` as sensitive local state and keep it out of git.
- Typed slash commands remain the most reliable admin surface for sessions, permissions, and approvals; voice notes are best for natural prompts plus short commands like `help`, `status`, `stop`, and `new session`.
