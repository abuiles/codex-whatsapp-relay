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
v0.4.3

Do all of the following:

1. Clone the repo into ~/.codex/plugins/whatsapp-relay if it does not exist yet.
2. If it already exists, fetch tags and check out v0.4.3 without deleting unrelated user files.
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

If you send another normal prompt while that same project or `/btw` scope is already busy, the relay now queues it, acknowledges that it was queued, and automatically runs it after the current task finishes unless you explicitly stop the active run. Stopping a scope also clears that scope's queued follow-ups so stale prompts do not linger.

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

## MCP media, history and receipts

The local MCP server now includes `whatsapp_prepare_media`, `whatsapp_send_media`,
`whatsapp_download_media`, and `whatsapp_message_status`. Prepare a local file
first, review its absolute path, SHA-256 and caption, then send with that hash
as `expectedSha256`. Supported types are image, video, audio, document and WebP
sticker. Voice notes require an Ogg Opus file. The relay caps a single file at
100 MiB. Media preparation does not upload or send a message.

Message reads expose IDs and cached media metadata. Downloads require a retained
raw message envelope; older cache entries may lack one. Downloaded files stay
under the private runtime data directory, small images return inline previews,
and view-once media is excluded. A submitted message ID does not prove delivery;
`whatsapp_message_status` reports only the acknowledgements the cache received.

The existing `whatsapp_send_message` tool also accepts a `media` object with the
same fields as `whatsapp_send_media`; leave `text` empty for media and use
`media.caption` where applicable. The existing `whatsapp_read_messages` tool can
select an exact `messageId`; with `downloadMedia: true` it downloads that media.
These options use the same native MCP connection when a host caches older tool
names. No text command or encoded-message workaround is used.

On supported Node.js versions, SIGHUP flushes the cache and replaces only the
MCP worker with `process.execve`, retaining its stdio connection. Tool-list-change
notifications announce the updated schema. This does not restart Codex or other
MCP workers. Use only for an explicitly authorized, identified WhatsApp worker.
Wait for in-flight tool calls to finish first; unfinished calls are not replayed.

Read results explicitly report `source: local_cache` and unverified history
completeness. Phone/LID mappings are merged, but neither an active socket nor a
successful cached read establishes that all latest phone history has arrived.
History refresh records its stanza ID in a private metadata journal before
dispatch. `whatsapp_sync_history` accepts `statusOnly: true` and an optional
`requestId` to check late responses without contacting the phone again. A timeout
keeps the original request unresolved; the same anchor is not automatically
retried. Only a response with the matching session ID confirms that request.
Message reads expose actual receipt counts. A server ACK confirms server receipt;
it does not establish delivery to the recipient's phone or audio playback.
`npm install` reapplies the reviewed pairing and pre-login acknowledgement
backports to the pinned Baileys rc14 dependency. Review `scripts/patch-baileys.mjs`
before changing the Baileys version. These fixes are reapplied on every install of the pinned dependency.

## Headless tools and the runtime daemon

Codex starts one MCP worker per thread. WhatsApp allows one live socket per
linked device, so the workers no longer connect themselves: the first tool call
starts `runtime-daemon.mjs`, a single background process per data directory that
owns the socket, and every worker proxies to it over a private Unix socket
(`runtime.sock`, mode 0600). The daemon reconnects on its own after network
drops, hands the session to the controller bridge or the terminal QR flow while
they run, restarts itself after the relay scripts are updated, and exits after
ten idle minutes when no credentials exist. If it cannot be reached, workers
answer read-only tools from the cache (`runtime_mode: cache_only`) and refuse to
send. Set `WHATSAPP_DAEMON=off` to keep the previous in-process behaviour.

Beyond chat listing, reading and sending, the MCP covers what an agent would
otherwise need the WhatsApp UI for:

- `whatsapp_search_messages` — full-text search across cached chats.
- `whatsapp_inbox` — everything new across chats since a cursor (or every unread chat), including offline backlog; optional long-poll.
- `whatsapp_wait_for_messages` — long-poll for new messages from a timestamp cursor.
- `whatsapp_recover_messages` — ask your phone to resend messages shown as `[undecryptable]`.
- `phoneNumber` recipients (verified with WhatsApp first) and `replyToMessageId` quoting.
- `whatsapp_react`, `whatsapp_edit_message`, `whatsapp_delete_message`, `whatsapp_forward_message`, `whatsapp_mark_read`.
- `whatsapp_send_poll`, `whatsapp_send_location`.
- `whatsapp_check_number`, `whatsapp_contact_info`, `whatsapp_group_info`.
- `whatsapp_reconnect` — reopen the saved session after it was replaced or dropped.

Attention and automation (run inside the daemon, so they work with no Codex
thread open):

- `whatsapp_digest` — what needs you: unread chats, @mentions and replies to you, questions you have not answered. Muted chats sink.
- `whatsapp_watch` / `whatsapp_unwatch` / `whatsapp_list_watches` — persisted rules (chat, sender, keywords, regex, chat kind, mentions of you) that record, show a macOS notification, or start a background `codex exec` run. Matches are batched for 15 s; Codex runs are one at a time, at most 6 an hour (`WHATSAPP_CODEX_RUNS_PER_HOUR`) and 5 minutes apart per rule. `whatsapp_alerts` reads what fired, with a cursor.
- `whatsapp_schedule_message` / `whatsapp_list_scheduled` / `whatsapp_cancel_scheduled` — sent by the daemon at the time given; marked `missed` (never sent late) if the daemon was offline for more than `maxLateMinutes`, and `unknown` (never resent) if it stopped mid-send.

Everything else the phone can do:

- `whatsapp_sync_history` with `untilDate` pages back to a date (50 per request, 2 s apart, `maxRequests` cap).
- `whatsapp_media_text` — local transcription (voice notes, video), OCR (`tesseract`), PDF (`pdftotext`) and document text; the text becomes searchable.
- `whatsapp_read_messages` with `threadOf` returns a reply thread. Reads show view-once flags, quoted text, mentions, contact cards and live poll tallies.
- `whatsapp_list_chats` with `filter` (archived, pinned, muted, disappearing) and `order: "phone"` (pinned first).
- `whatsapp_manage_chat` — archive, pin, mute, mark unread, clear, star.
- `whatsapp_group_admin` — create, add/remove/promote/demote, subject, description, invite links, join, leave, settings.
- `whatsapp_status` — read your contacts' status updates, or post one to an explicit audience.
- `whatsapp_presence`, `whatsapp_block`, `whatsapp_send_contact`, and `mentions` in `whatsapp_send_message`.

Sends are paced to keep the account clear of WhatsApp's spam detection: at most
20 a minute overall, 6 a minute to one chat and 10 first messages to new chats
an hour (`WHATSAPP_SEND_RATE_GLOBAL_PER_MIN`, `WHATSAPP_SEND_RATE_CHAT_PER_MIN`,
`WHATSAPP_NEW_CHATS_PER_HOUR`). A send over the limit is refused with
`status: rate_limited` and `retry_after_seconds`; it is never queued.

If a sending call loses its connection to the daemon after it was submitted,
the result says `outcome: unknown`; read the chat before trying again.

## CLI Fallback

If you need to test outside Codex:

```bash
npm run whatsapp:auth
npm run whatsapp:controller
npm run whatsapp:status
```

If scanning the QR code fails, link with a pairing code instead: pass your own
number to `whatsapp_start_auth` as `phoneNumber`, or run
`npm run whatsapp:auth -- --phone +15551234567`. On the phone, open Linked
Devices -> Link a Device -> Link with phone number instead, and type the
8-character code.

### Optional final-send confirmations

Codex supports per-tool approval policies. Enable confirmation for the relay's
text/media send tools without prompting for reads or media preparation:

```bash
npm run confirmations -- on
npm run confirmations -- status
npm run confirmations -- off
```

This optional helper requires Python 3.11+ and edits only its managed block in
`$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`). Off removes the helper's
policy overrides; it does not grant permissions or disable other safeguards.
On restores the same selected tools. Existing conflicting policies are left
untouched and require manual reconciliation. No messages are sent by the helper.

To include connected Slack and Gmail final-send tools, supply the actual app IDs
from their connector metadata on the first run:

```bash
npm run confirmations -- on --slack-app-id YOUR_SLACK_APP_ID --gmail-app-id YOUR_GMAIL_APP_ID
```

Separately named Codex MCP connections using the exact official Slack endpoint
`https://mcp.slack.com/mcp` are also discovered automatically, including when
Slack is the only configured service. Run `on` again after adding connections.
The same toggle covers final sends in all discovered connections while keeping
their existing enabled/disabled states and OAuth configuration intact. This
does not authorize new Slack workspaces or implement a hosted account picker;
each independent organization still needs its own OAuth authorization. Turning
the toggle off restores the prior policy, including any user-owned prompts.

Slack sends, scheduled messages, edits to posted messages, and final file sharing
are covered; Gmail send, send-draft, and forwarding are covered. Slack upload-URL preparation, draft creation/editing, and known relay read/prepare tools receive explicit
approval overrides so they do not prompt; other operations keep their existing policy. This uses native host approval controls, not
a claim of server-side enforcement by the relay. Managed host policies take
precedence; loading changes in an existing host depends on its configuration
refresh support. Do not restart another session or job to apply these settings.
The controller is a separate autonomous sender and is not gated by MCP tool
approvals; keep it disabled unless explicitly authorized.

The relay adds no ChatGPT signature to outbound content. Slack or another service
may still display its own app identity; this setting does not hide platform labels.
See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [plugin server policy](https://developers.openai.com/plugins/build/plugins).

### Clean native reply preparation

The optional `skills/connector-replies` skill provides native reply guidance for
Gmail and Slack and makes the relay's reply limitations explicit. Install it in
your Codex skills directory if you use those connectors. Its Python helper only
prepares native Gmail draft arguments and validates supplied draft readback data;
it has no credentials or network access and never sends mail.

The helper uses the fetched Gmail message ID as `reply_message_id`, preserves
the subject and intended recipient, and builds clean HTML/plain-text alternatives
without copying a `>` quote chain from the parent. It distinguishes a follow-up
to your own sent message from a reply to another sender. Native draft verification
checks the actual thread, reply headers, recipients and MIME bodies before a send.
Local fixture validation alone is not evidence that a hosted connector saved the
correct draft. The hosted Gmail/Slack implementation is not changed by this skill.
