# Codex WhatsApp Relay

Put Codex in your WhatsApp.

WhatsApp Relay is a Codex plugin that links a local WhatsApp account to Codex, lets Codex read and send WhatsApp messages, and can optionally let you control Codex from an allowed direct chat.

The useful part is the mental model: scan a QR once, let the relay hold the WhatsApp session, and keep talking to Codex from your phone. Under the hood it uses `codex app-server`, so phone-controlled chats map to native Codex threads that can be resumed later in Codex and across WhatsApp messages.

The controller bridge is now project-aware. One chat can keep `api` busy, switch to `web`, fire a one-shot prompt into another repo, and still ask a disposable `/btw` side question without losing the main thread.

## What You Can Do

- link your local WhatsApp account to Codex with one QR scan
- read chats, inspect cached messages, sync history, and send WhatsApp replies from Codex
- treat one allowed WhatsApp chat like a lightweight Codex client
- keep multiple projects alive from one chat and switch between them without losing session state
- target a different project with a one-off prompt while staying in your current project
- jump between saved Codex sessions inside one project
- approve, deny, stop, or lower permissions from WhatsApp
- talk to Codex with voice notes and get local voice-note replies back
- resume the same work later in your terminal with `codex resume`

## Install In Codex

Paste this prompt into Codex:

```text
Install the WhatsApp Relay plugin globally for my user account.

Use this repository as the source:
https://github.com/abuiles/codex-whatsapp-relay

Install the current release tag:
v0.4.2

Do all of the following:

1. Clone the repo into ~/.codex/plugins/whatsapp-relay if it does not exist yet.
2. If it already exists, fetch tags and check out v0.4.2 without deleting unrelated user files.
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
                +----------------------+
                |   Codex app-server   |
                |   native threads     |
                +----------+-----------+
                           ^
                           |
Your phone <-> WhatsApp Relay daemon <-> WhatsApp session
```

1. Link a local WhatsApp session by scanning the QR shown in Codex output.
2. Codex can inspect chats, read cached messages, sync history, and send replies through MCP tools.
3. If you enable phone control, allowed direct chats continue a persistent `codex app-server` thread from WhatsApp.

## Multi-Project Mental Model

```text
One WhatsApp chat
      |
      +--> current project  -> sticky default lane
      |        Example: /project alpha-app
      |
      +--> /in other-project ... -> one-shot lane
      |        Does the work there, then leaves you where you were
      |
      +--> /btw ... -> disposable side thread
               Never changes the current project or project session
```

```text
You are in project-a
      |
      +--> project-b is still running in the background
      |
      +--> project-b finishes
               |
               +--> relay posts a completion message
                    and reminds you that you are still in project-a
```

## Try It

- "Link my WhatsApp account and verify the auth status."
- "Show my unread WhatsApp chats."
- "Send a WhatsApp message to Alice saying I'll be there in 10 minutes."
- "Allow my number and start WhatsApp Relay so I can control Codex from WhatsApp."
- "Start new session in alpha app inside code directory."
- "/project alpha-app"
- "/in alpha-app run the failing tests and explain the error"
- "/btw what changed in GPT-5.4 reasoning modes?"

## Phone Commands

Once the controller bridge is running, allowed direct chats can send:

- plain text to continue the active project's current Codex session
- voice notes to continue the active project's current Codex session after local transcription

Project control:

- `/projects` to list configured projects and show which one is active or busy
- `/project` to inspect the active project for this chat
- `/project <number|alias|project hint|path hint>` to switch to another project, letting Codex resolve natural project hints against the projects that already exist and auto-adding a repo when a path resolves locally
- natural text like `start new session in alpha app inside code directory` to jump to a repo and start fresh there
- `/new` or `/n` to start a fresh session in the active project
- `/in <project> <prompt>` to send a one-shot prompt into another project without switching away
- `/btw <prompt>` to ask a disposable side question and then return to your current project

Session control:

- `/sessions` or `/ls [project]` to list recent Codex threads for a project
- `/1`, `/2`, ... to jump to one of the most recently listed sessions
- `/session <number|thread-id-prefix>` to switch the current project's session
- `/session <project> <number|thread-id-prefix>` or `/c <...>` to switch another project's session directly
- `/status` or `/st [project]` to inspect the active project session or another project's session, including the live run status and latest progress preview while a run is active

Permissions and approvals:

- `/permissions` or `/p [project]` to inspect the current permission level
- `/ro`, `/ww`, or `/dfa` to quickly switch the active project's permission level
- `/permissions ro|ww|dfa` or `/permissions <project> read-only|workspace-write|danger-full-access` to change a project's sandbox level
- `/approve` or `/a [project|btw] [session]`, `/deny` or `/d [project|btw]`, and `/cancel` or `/q [project|btw]` to answer pending approval prompts
- `/stop` or `/x [project|btw]` to cancel an in-flight Codex run
- `/help` or `/h` to see command help

Voice replies:

- `/voice status` to inspect whether spoken replies are enabled for this chat
- `/voice on` or `/voice on 2x` to enable local spoken replies
- `/voice off` to go back to text-only replies
- `reply in voice at 1x ...` or `reply in voice at 2x ...` for a one-off spoken answer without changing the chat default

`danger-full-access` requires an explicit confirmation code sent back over WhatsApp before the bridge disables the sandbox for that project session. For the active project, the bridge now asks you to confirm with a short reply like `/dfa 123456`; for another project it uses `/dfa <project> 123456`.
Voice notes are transcribed locally with `mlx-community/parakeet-tdt-0.6b-v3` through `uvx` and `ffmpeg`. The bridge echoes the transcript back before acting on it, and very short low-confidence transcriptions are rejected so you can retry instead of sending garbage to Codex.
High-impact repo actions such as merges, releases, rebases, retargets, and deletes are intentionally not executed straight from voice; the bridge asks you to resend those as text so a misheard number does not mutate the wrong branch or PR.
When voice replies are enabled with `/voice on` or a one-shot `reply in voice at 2x ...` prompt, the bridge also synthesizes a local outbound WhatsApp voice note.
If a spoken reply contains something you need to click or copy, such as a preview URL, link, slash command, or confirmation code, the bridge now sends a short text companion with those actionable bits.

Project switching is sticky per chat. One-shot `/in` prompts do not change the active project, and `/btw` always uses a fresh disposable thread.

## Working Across Projects From WhatsApp

The chat always has one current project. Normal text and voice prompts go there. On top of that, you can send one-off work to another project, jump between saved sessions inside a project, and answer approvals without losing your place.

The practical model is:

- Use `/project <alias>` when you want to move your default lane to another project.
- Use `/project` or `/projects` to see numbered shortcuts, then `/project 2` to jump quickly without typing the alias.
- Use `/project <natural hint>` when you want Codex to choose among the projects that already exist, for example `/project blood project`.
- Use `/in <alias> <prompt>` when you want to send one prompt somewhere else without switching away.
- Use `/btw <prompt>` for disposable side questions that should not touch any project session.
- Use `/ls [project]` and `/session [project] <number>` when you want to switch this chat to another saved Codex thread inside the same project.

Quick mnemonic:

```text
/project  -> move my main lane
/in       -> send one thing elsewhere
/session  -> switch threads inside one project
/btw      -> ask a side question and come right back
```

Examples:

- Start something long in `project-b`, then switch to `project-a`:
  - `/project project-b`
  - `run the full test suite and tell me what is failing`
  - `/project project-a`
  - `keep working on the login bug`
- Send one-off work to `project-b` while staying focused on `project-a`:
  - `/project project-a`
  - `/in project-b run pwd and tell me which branch you are on`
- Ask a side question without disturbing either project:
  - `/btw what changed in GPT-5.4 reasoning modes?`

## Session Switching Inside One Project

Each project keeps its own session history. That means you can return to an older thread for the same project without affecting other projects.

Examples:

- List recent sessions for the current project:
  - `/ls`
- List recent sessions for another project:
  - `/ls alpha-app`
- Switch the current project to the second listed session:
  - `/session 2`
- Switch another project directly:
  - `/session alpha-app 2`
- Connect by thread id prefix:
  - `/session alpha-app 019d36f3`

The bridge keeps one active session pointer per project in each chat. You can switch that pointer whenever you want.

Important limitation: the bridge only allows one in-flight Codex run per project alias at a time. If you want true parallel work on the same repo family, use separate worktrees as separate projects and switch between those project aliases from WhatsApp.

```text
repo root
  |
  +-- worktree-a  -> project-a
  +-- worktree-b  -> project-b
  +-- worktree-c  -> project-c

One repo family, several WhatsApp-manageable projects
```

## Background Completions, Approvals, and Permissions

If `project-b` finishes while you are working in `project-a`, the bridge posts the completion back into the chat and tells you that you are still in `project-a`. It does not switch you automatically.

The same applies to approvals and failures:

- approvals can be answered without switching projects, for example `/a project-b` or `/d project-b`
- failures call out which project failed and remind you which project is still active
- permission changes can be done quickly with `/ro`, `/ww`, or `/dfa` for the active project, or explicitly with `/p project-b ww`

That makes the WhatsApp flow predictable: `/project` changes your main lane, `/in` sends one prompt to another lane, `/session` changes which saved thread a project points at, and background events never steal focus.

## Voice-Mode Project Control

Voice notes can now drive the same project controls through a Codex intent-classification step. That means the bridge does not depend on a hardcoded phrase table for project and session juggling. Instead, the transcribed note is classified as either a bridge command or a normal prompt before the bridge acts on it, using a lightweight dedicated Codex model rather than your main work session settings.

Examples of intents the classifier should understand:

- `projects`
- `project alpha app`
- `list sessions for alpha app`
- `session alpha app 2`
- `status for alpha app`
- `start new session in alpha app`
- `workspace write`
- `read only`
- `danger full access`

Practical rule: if you want to juggle projects by voice, make the intent explicit. Say `project ...`, `sessions ...`, `session ...`, `status ...`, or `start new session in ...` so Codex can cleanly map the transcript into a bridge action.

Voice-mode mental model:

```text
voice note
   |
   +--> local transcription
   |
   +--> intent classification
          |
          +--> bridge command
          |      project / session / permissions / status
          |
          +--> normal prompt
                 send it to the current project session
```

## What It Does

- links WhatsApp with a QR shown in Codex output
- lets Codex inspect recent chats and messages
- lets Codex send WhatsApp messages
- can sync older history on demand
- can expose Codex through WhatsApp for allowed phone numbers
- can switch a phone chat between existing Codex threads
- can keep multiple project runs active at the same time from one chat
- can switch the active project per chat and auto-discover repos from local directory hints
- can send one-off prompts to another project without switching the main thread
- can handle disposable `/btw` questions outside the main project thread
- can run each phone chat at `read-only`, `workspace-write`, or `danger-full-access`
- can transcribe WhatsApp voice notes locally and feed them into the active Codex session
- can synthesize local WhatsApp voice-note replies with either macOS `say` or `ResembleAI/chatterbox-turbo`

## Safety Notes

- `workspace-write` is the default bridge permission level. It keeps the chat inside the workspace and relays approval prompts back to WhatsApp before guarded actions run.
- `danger-full-access` is per-chat and requires a short confirmation code reply such as `/dfa 123456`. Use `/new` or `/permissions workspace-write` to drop back down.
- Only one controller bridge should own the live WhatsApp session at a time. Starting a second checkout now refuses instead of silently replacing the current bridge.
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
