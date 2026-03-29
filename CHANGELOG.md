# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
