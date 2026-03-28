# Codex WhatsApp Relay

Put Codex in your WhatsApp.

WhatsApp Relay is a Codex plugin that links a local WhatsApp account to Codex, lets Codex read and send WhatsApp messages, and can optionally let you control Codex from an allowed direct chat.

The useful part is the mental model: scan a QR once, let the relay hold the WhatsApp session, and keep talking to Codex from your phone. Under the hood it uses `codex app-server`, so phone-controlled chats map to native Codex threads that can be resumed later in Codex and across WhatsApp messages.

## Why It Is Fun

- message yourself and treat that chat like a lightweight Codex client
- ask Codex to ping someone on WhatsApp without leaving your terminal
- keep a real Codex thread going from your phone with session switching and permission controls
- talk to Codex with voice notes that are transcribed locally before they hit the session
- have Codex answer back with local voice replies when you ask for them
- use the same relay for chat inspection, message sending, and phone control
- resume in your terminal with `codex resume`

## Install In Codex

Paste this prompt into Codex:

```text
Install the WhatsApp Relay plugin globally for my user account.

Use this repository as the source:
https://github.com/abuiles/codex-whatsapp-relay-plugin

Do all of the following:

1. Clone the repo into ~/.codex/plugins/whatsapp-relay if it does not exist yet.
2. If it already exists, update it from origin/main without deleting unrelated user files.
3. Run npm install inside ~/.codex/plugins/whatsapp-relay.
4. Create or update ~/.agents/plugins/marketplace.json so it contains a personal marketplace entry for this plugin.
5. Keep any existing marketplace entries that are already there.
6. Make sure the plugin entry uses:
   - name: whatsapp-relay
   - source.source: local
   - source.path: ./.codex/plugins/whatsapp-relay/plugins/whatsapp-relay
   - policy.installation: AVAILABLE
   - policy.authentication: ON_USE
   - category: Productivity
7. Do not create a repo-local marketplace entry.
8. After writing the marketplace file, tell me to restart Codex.
9. After restart, tell me to open /plugins and install WhatsApp Relay.

Do not push or publish anything. Only set up the local personal marketplace install.
```

## After Install

1. Restart Codex.
2. Open `/plugins`.
3. Install `WhatsApp Relay`.
4. Ask Codex to ping you on WhatsApp.

If WhatsApp is not linked yet, Codex should first run the auth flow, wait for you to scan the QR code, verify the session, and then send the ping. If you want phone control, ask Codex to enable it. If you use the same WhatsApp account on your phone, `Message yourself` can be used as the control surface.

## How It Works

```text
Your phone <-> WhatsApp Relay <-> Codex thread
```

1. Link a local WhatsApp session by scanning the QR shown in Codex output.
2. Codex can inspect chats, read cached messages, sync history, and send replies through MCP tools.
3. If you enable phone control, allowed direct chats continue a persistent `codex app-server` thread from WhatsApp.

## Try It

- "Link my WhatsApp account and verify the auth status."
- "Show my unread WhatsApp chats."
- "Send a WhatsApp message to Alice saying I'll be there in 10 minutes."
- "Allow my number and start WhatsApp Relay so I can control Codex from WhatsApp."

## Phone Commands

Once the controller bridge is running, allowed direct chats can send:

- plain text to continue the current Codex session
- voice notes to continue the current Codex session after local transcription
- `/new` or `/n` to start a fresh session
- `/sessions` or `/ls` to list recent Codex threads
- `/1`, `/2`, ... or `/session <number|thread-id-prefix>` or `/c <number|thread-id-prefix>` to switch this chat to another Codex session
- `/status` or `/st` to inspect the active session
- `/permissions` or `/p` to inspect the current permission level
- `/permissions ro|ww|dfa` or `/permissions read-only|workspace-write|danger-full-access` to change the session sandbox level
- `/approve` or `/a`, `/approve session`, `/deny` or `/d`, and `/cancel` or `/q` to answer pending approval prompts in `workspace-write`
- `/stop` or `/x` to cancel the in-flight Codex run
- `/help` or `/h` to see command help

`danger-full-access` requires an explicit confirmation code sent back over WhatsApp before the bridge disables the sandbox for that chat session.
Voice notes are transcribed locally with `mlx-community/parakeet-tdt-0.6b-v3` through `uvx` and `ffmpeg`. The bridge echoes the transcript back before acting on it, and very short low-confidence transcriptions are rejected so you can retry instead of sending garbage to Codex.
When voice replies are enabled with `/voice on` or a one-shot `reply in voice at 2x ...` prompt, the bridge also synthesizes a local outbound WhatsApp voice note.

## What It Does

- links WhatsApp with a QR shown in Codex output
- lets Codex inspect recent chats and messages
- lets Codex send WhatsApp messages
- can sync older history on demand
- can expose Codex through WhatsApp for allowed phone numbers
- can switch a phone chat between existing Codex threads
- can run each phone chat at `read-only`, `workspace-write`, or `danger-full-access`
- can transcribe WhatsApp voice notes locally and feed them into the active Codex session
- can synthesize local WhatsApp voice-note replies with either macOS `say` or `ResembleAI/chatterbox-turbo`

## Safety Notes

- `workspace-write` is the default bridge permission level. It keeps the chat inside the workspace and relays approval prompts back to WhatsApp before guarded actions run.
- `danger-full-access` is per-chat and requires a confirmation code. Use `/new` or `/permissions workspace-write` to drop back down.
- Auth material under `plugins/whatsapp-relay/data/auth*` is local runtime state and should never be committed.
- Typed slash commands remain the most reliable way to change sessions or permissions. Voice notes work best for natural prompts and short spoken commands like `help`, `status`, `stop`, and `new session`.

## Voice Notes

Voice-note control is local-first. The bridge downloads the WhatsApp audio, normalizes it with `ffmpeg`, runs Parakeet v3 through `uvx`, and then forwards the transcript into the existing `codex app-server` session.

You need these local tools available on the machine running the bridge:

- `ffmpeg`
- `uvx`

Optional environment variables:

- `WHATSAPP_RELAY_STT_MODEL` to override the default `mlx-community/parakeet-tdt-0.6b-v3`
- `WHATSAPP_RELAY_STT_TIMEOUT_MS` to extend or reduce the transcription timeout

The first voice note can be noticeably slower because `uvx` may need to install `parakeet-mlx` and download the model cache.

## Voice Replies

Outbound voice replies are also local-first.

The default provider is Chatterbox. English replies use `Chatterbox-Turbo`, and supported non-English replies use `Chatterbox-Multilingual`.

Provider selection is controlled with environment variables:

- `WHATSAPP_RELAY_TTS_PROVIDER=system` opts out of Chatterbox and uses the macOS `say` fallback.
- `WHATSAPP_RELAY_TTS_PROVIDER=chatterbox-turbo` explicitly keeps outbound voice replies on `ResembleAI/chatterbox-turbo`.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_PYTHON` overrides the Python interpreter used for Chatterbox. By default the bridge looks for `plugins/whatsapp-relay/.venv-chatterbox/bin/python`.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_DEVICE=auto|mps|cpu` controls the Chatterbox device selection. `auto` is the default.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_AUDIO_PROMPT=/absolute/path/to/reference.wav` optionally enables voice cloning for Chatterbox with a local reference clip.
- `WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH=0` opts non-English replies back into the macOS fallback instead of multilingual Chatterbox.
- `WHATSAPP_RELAY_TTS_TIMEOUT_MS` extends or reduces the outbound TTS timeout for either provider.

If you want the controller bridge to keep using Chatterbox across restarts, persist it in the bridge config. `whatsapp_start_controller_bridge` accepts `ttsProvider` and `ttsChatterboxAllowNonEnglish`, stores them in `plugins/whatsapp-relay/data/controller-config.json`, and reuses them for future daemon starts.

To install Chatterbox Turbo locally:

```bash
npm run whatsapp:install-chatterbox
```

The installer creates `plugins/whatsapp-relay/.venv-chatterbox`, prefers `python3.11` when that interpreter can build a working virtualenv, falls back to `python3` otherwise, and installs `chatterbox-tts` there so the bridge can call it directly. It also pins `setuptools<81` because the current Perth dependency still imports `pkg_resources`.

To smoke-test whichever provider is active:

```bash
npm run whatsapp:tts:smoke -- --text "Testing local voice replies."
```

To smoke-test Chatterbox Turbo explicitly:

```bash
WHATSAPP_RELAY_TTS_PROVIDER=chatterbox-turbo \
npm run whatsapp:tts:smoke -- --provider chatterbox-turbo --text "Testing Chatterbox Turbo locally."
```

To force the multilingual route during a smoke test, pass a language hint:

```bash
WHATSAPP_RELAY_TTS_PROVIDER=chatterbox-turbo \
npm run whatsapp:tts:smoke -- --provider chatterbox-turbo --language-id es --text "Claro, te doy el resumen corto ahora."
```

The Chatterbox path is slower than `say` because the Python process and model are loaded locally for each generated reply. It is now the preferred provider. English uses Turbo, while supported non-English replies route through the multilingual model. If you prefer the lighter macOS voice path everywhere, set `WHATSAPP_RELAY_TTS_PROVIDER=system`. If you only want the macOS fallback for non-English replies, set `WHATSAPP_RELAY_TTS_CHATTERBOX_ALLOW_NON_ENGLISH=0`. On machines where Perth's native implicit watermarker is unavailable, the helper falls back to Perth's dummy watermarker so local synthesis still works.

## CLI Fallback

If you need to test outside Codex:

```bash
npm run whatsapp:auth
npm run whatsapp:controller
npm run whatsapp:status
```
