# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed — app-state sync stuck on missing keys, stale tools after updates

- Auth files are now written to a temp file and renamed into place. Baileys wrote them in place with only an in-process lock, so two relay processes could leave a key file with trailing bytes; it then read as missing and chat state (archive, pin, mute, read marks) stopped syncing. Torn files left by older versions are read back from their first complete JSON value.
- When app-state sync needs a key the relay does not have, it asks the phone for it (an invisible device-to-device request, at most once per key every 10 minutes) instead of waiting for the phone to share it on its own. The reply resyncs the parked collections.
- Open Codex threads pick up new and changed tools after an update: the MCP server reloads itself in place (same process, same stdio pipe) once the scripts have stopped changing and no call is in flight, then tells Codex the tool list changed. Set `WHATSAPP_MCP_AUTO_RELOAD=off` to disable.
- Timeouts, aborts and connection errors are no longer filed as relay bug reports.

### Added — bug reports a coding agent can act on

- `whatsapp_report_bug` lets Codex report a relay bug (tool, arguments, what went wrong) to `bug-reports.jsonl` in the data directory, so a coding agent watching the file can fix it without the user relaying it.
- A tool that crashes with a programming error (`TypeError`, `ReferenceError`, ...) files a report by itself and says so in its result. Errors a tool raises on purpose, like an unknown chat, are not reported.
- Reports replace message text with its length (IDs and JIDs are kept), repeat reports within 10 minutes are skipped, and at most 20 are filed an hour.

### Added — drafts, logout alerts, and steering away from the UI

- `whatsapp_draft_message` saves a message without sending it; `whatsapp_send_draft` sends it after approval (now or scheduled, optionally with edited text) through the normal send path and its rate limits. A crash mid-send leaves the draft `unknown`, never resent.
- The runtime daemon shows a desktop notification and records an alert when WhatsApp logs the device out, instead of every later tool call failing silently.
- `whatsapp_read_messages` says when the cache ran out and points to `whatsapp_sync_history`.
- The MCP server now sends instructions, and the skill description and rules were rewritten, so Codex uses the relay tools for WhatsApp instead of driving WhatsApp Desktop through computer use, which is what it had kept doing for everyday sends.

### Added — link with a pairing code

- `whatsapp_start_auth` takes an optional `phoneNumber` and returns an 8-character pairing code to type on the phone (Linked Devices -> Link with phone number instead) when QR scanning fails. Repeated calls on the same attempt return the same code. `npm run whatsapp:auth -- --phone <number>` does the same in a terminal.
- An abandoned pairing attempt no longer counts as a linked account: a session counts as linked only once its credentials hold the signed device `account`, which Baileys writes on pairing success.

### Fixed — sent replies left chats unread

- A message sent through the relay now marks its chat read, as replying does on the phone. Previously the relay cached its own send first, so WhatsApp's echo was treated as a duplicate and the reset never ran.

### Fixed — headless reliability

- One runtime daemon now owns the live WhatsApp socket per data directory. Codex starts one MCP worker per thread, and each worker used to open its own linked-device socket; every send, download or sync replaced the others' connections (`connectionReplaced`), never reconnected, and left most workers serving a stale cache. Workers are now thin proxies over a private Unix socket and start the daemon on demand. `WHATSAPP_DAEMON=off` restores in-process mode.
- `connectionReplaced` and `logged_out` sessions report a clear `next_step` instead of a generic error; the new `whatsapp_reconnect` reopens the saved session without a QR code.
- The controller bridge, the terminal QR flow and `npm run whatsapp:status` hand the session over to, or query, the daemon instead of opening a competing socket. The daemon resumes automatically when they exit.
- Cache reads reload from disk unless this process holds the live socket, so a worker never answers from a days-old in-memory snapshot.
- Name lookup is accent-, case- and word-order-insensitive, matches phone numbers in any format, and reports `no_cached_match` with next steps instead of a dead end.
- Protocol edits and revokes update their target message; replies record the quoted message ID; group senders show their saved names.

### Added — features that work without the WhatsApp UI

- `whatsapp_search_messages` (full-text across chats), `whatsapp_wait_for_messages` (long-poll for new messages with a cursor).
- `whatsapp_inbox`: everything new across chats, grouped by chat, with an arrival-order cursor that includes offline backlog.
- `whatsapp_recover_messages`: asks your own phone to resend messages this device could not decrypt.
- Unread counts now include offline backlog, ignore Baileys' per-batch deltas, reset when you reply or read elsewhere, and track "marked unread" separately. Existing caches are repaired once on load.
- Undecryptable and system messages are labelled instead of shown blank.
- Every read reports `connected_since`, or `stale_since` with a `freshness_warning` when it is not live. `whatsapp_auth_status` shows the reconnect count.
- Send to a `phoneNumber` (verified on WhatsApp first) and reply with `replyToMessageId` in `whatsapp_send_message` / `whatsapp_send_media`.
- `whatsapp_react`, `whatsapp_edit_message`, `whatsapp_delete_message`, `whatsapp_forward_message`, `whatsapp_mark_read`, `whatsapp_send_poll`, `whatsapp_send_location`.
- `whatsapp_check_number`, `whatsapp_contact_info`, `whatsapp_group_info` (participants, admins; lists all groups without arguments).
- `whatsapp_list_chats` filters by `kind` (direct or group); results show replies, reactions and edits.
- The optional final-send confirmation toggle covers every new sending tool; new read-only tools are auto-approved.

### Added — attention, automation and the rest of the phone

- `whatsapp_digest`: unread chats, @mentions and replies to you, and questions awaiting your reply, muted chats last.
- Persisted watch rules (`whatsapp_watch`, `whatsapp_unwatch`, `whatsapp_list_watches`, `whatsapp_alerts`) evaluated by the daemon: record, macOS notification, or a background `codex exec` run capped at one at a time, 6 an hour and a 5-minute cooldown per rule.
- Scheduled messages sent by the daemon; missed or interrupted ones are reported, never sent late or twice.
- `whatsapp_sync_history` `untilDate` paging; `whatsapp_media_text` (local transcription, OCR, PDF and document text, searchable); `threadOf` reply threads.
- Reads show view-once, quoted text, mentions, contact cards, poll tallies, archived/pinned/muted/disappearing state; `whatsapp_list_chats` gains `filter` and the phone's pinned order.
- `whatsapp_manage_chat`, `whatsapp_group_admin`, `whatsapp_status`, `whatsapp_presence`, `whatsapp_block`, `whatsapp_send_contact`, and `mentions` on sends.
- Outgoing rate limits (20/min overall, 6/min per chat, 10 new chats/hour, configurable) refuse sends that could get the account banned.

- Apply the optional final-send confirmation toggle to separately named official Slack MCP connections, without changing their authentication or enabled state.

### Added

- Optional connector-reply skill with a tested, network-free Gmail argument builder and saved-draft validator for native thread linkage and clean MIME content.
- Optional native-host final-send confirmation toggle for WhatsApp, with opt-in Slack/Gmail tool policies; draft/read preparation remains available without prompts and unrelated settings stay unchanged.
- CI on Node.js 22 and 24 with reproducible dependency installation and checks for every JavaScript source file.

### Fixed

- Include Gmail forwarding in final-send approval coverage while allowing Slack upload-URL preparation; remembered policies pick up coverage additions when enabled again.
- Snapshot approved media bytes before connecting/uploading, so later source-file edits cannot change the outgoing attachment.
- Ignore all runtime data, downloaded media, and pairing QR artifacts in Git.
- Keep the documented `audio/ogg; codecs=opus` MIME for verified Opus input, reject conflicting codec declarations, and expose audio download preflight without another send.
- Persist history request stanza IDs before dispatch, correlate exact sessions, retain timed-out requests for late-response checks, and prevent automatic retries at an unresolved anchor.
- Resolve self-device receipts without recipient JIDs, retain per-recipient receipt timestamps across history merges, and expose real receipt counts without treating one group member as the whole group.
- Support media through existing send/read MCP tools as well as dedicated media tools; add a tested in-place worker reload that preserves the host's stdio connection.
- Preserve acknowledgement progress across duplicate pending snapshots and early receipts; record positive provider acknowledgements and keep history anchors separate from cache-boundary timestamps.
- Serialize cache snapshots so a slow earlier write cannot replace a newer snapshot; clean up failed temporary writes without blocking subsequent saves.
- Preserve and merge phone/LID identities, retain bounded raw media envelopes for downloads and retries, label cached-history completeness, avoid duplicate unread counts, and pass milliseconds to on-demand history requests.
- Add local media preflight, image/video/audio/document/sticker submission, cached delivery-status inspection, and streaming media download with small-image previews. Actual send/download verification remains a separate live acceptance gate.
- Backport Baileys companion registration refresh and pre-login notification acknowledgements for QR pairing on rc14; pin the dependency and reapply the reviewed fixes after installation.
- Discard disconnected QR codes, reuse the live authentication socket, and ignore connection updates from replaced sockets.

## [0.4.3] - 2026-03-30

### Fixed

- `/voice on` and `/voice off` can now be changed while a Codex run is still active, and in-flight replies honor the updated voice mode instead of the stale run-start setting.

## [0.4.2] - 2026-03-29

### Added

- Multi-project WhatsApp controller support, including sticky per-project sessions, `/projects`, `/project`, `/in`, and `/btw` flows inside one chat.
- New project and session helpers for multi-project work, including project-aware session browsing and switching.
- Global controller ownership locking so one checkout cannot silently steal the live WhatsApp session from another.

### Changed

- Project switching now lets Codex resolve natural project hints against the configured projects instead of relying only on exact aliases.
- Voice replies can now send a text companion when the answer includes actionable artifacts like links, slash commands, or confirmation codes.
- High-impact voice prompts now ask for text confirmation more precisely, avoiding benign prompts while still blocking risky repo actions from voice.
- Danger full access confirmations are shorter and easier to confirm from WhatsApp.
- README and bridge help text now document the multi-project controller flows.

### Fixed

- Legacy single-project state is now fully migrated into per-project buckets so thread and error state do not leak across projects.
- Background completions now clearly tell you when a result came from another project while you were already focused elsewhere.
- Approval replies now preserve multi-word project targets instead of collapsing them to the last token.
- Controller summaries and MCP status output now report the active project's thread instead of a stale chat-level thread id.

## [0.4.1] - 2026-03-28

### Changed

- Controller bridge restarts now reuse persisted local TTS defaults from `controller-config.json`, so outbound voice replies can stay on Chatterbox across daemon restarts.
- Chatterbox is now the default outbound TTS integration for WhatsApp voice replies, with Turbo for English and Chatterbox Multilingual for supported non-English languages.
- The non-English override can still force macOS `say` as a fallback when operators do not want multilingual Chatterbox.
- Voice-reply language tags are now stripped more robustly so hidden metadata does not leak into visible replies or local TTS.
- The local smoke-test command now accepts an explicit `--language-id` override for multilingual routing checks.
- Chatterbox install verification now checks the multilingual import path, and persisted boolean-like relay settings are normalized more safely when loaded from disk.

## [0.4.0] - 2026-03-28

### Added

- Optional local outbound TTS provider support for `ResembleAI/chatterbox-turbo`.
- Local Chatterbox installer and smoke-test commands for operator setup.
- Shortcut commands for WhatsApp bridge control, including `/n`, `/st`, `/ls`, `/p`, `/a`, `/d`, `/q`, `/x`, and `/h`.
- Numbered session switching so recent thread lists can be resumed with `/1`, `/2`, or `/session <number>`.

### Changed

- Bridge status now reports the active outbound voice-reply provider.
- README and skill docs now cover outbound voice replies and Chatterbox Turbo setup.
- WhatsApp bridge help, status, MCP startup output, and docs now advertise the shorter command forms.
- Permission switching now accepts `ro`, `ww`, and `dfa` alongside the full permission names.

## [0.3.0] - 2026-03-28

### Added

- Voice-note control for WhatsApp bridge chats with local Parakeet v3 transcription.
- Local audio download and transcription pipeline using Baileys media download, `ffmpeg`, and `uvx --from parakeet-mlx`.

### Changed

- WhatsApp bridge help and session handling now accept voice notes alongside text prompts.
- Short low-confidence voice-note transcripts now ask for a retry instead of sending a likely-garbled prompt to Codex.
- Spoken `cancelar` now cancels a pending approval from a voice-controlled chat.

### Fixed

- Transcriber timeout cleanup now force-kills the child process only when it is still actually running.

## [0.2.0] - 2026-03-28

### Added

- Per-chat bridge permission levels for `read-only`, `workspace-write`, and `danger-full-access`.
- WhatsApp approval handling for guarded command and file-change actions while running in `workspace-write`.
- WhatsApp session browsing and switching with `/sessions` and `/connect <thread-id-prefix>`.

### Changed

- The controller bridge now defaults to `workspace-write` with explicit approval prompts instead of forcing non-interactive workspace writes.

### Security

- Ignore rotated auth directories under `plugins/whatsapp-relay/data/auth*` so leaked local WhatsApp credentials do not get staged accidentally.

## [0.1.0] - 2026-03-27

### Added

- Initial prerelease of `WhatsApp Relay`.
- Terminal QR authentication flow for linking a local WhatsApp account.
- MCP tools for auth status, listing chats, reading messages, sending messages, and syncing history.
- Bidirectional WhatsApp-to-Codex control bridge for allowed phone numbers.
- Native Codex `app-server` transport for phone-controlled Codex sessions.
