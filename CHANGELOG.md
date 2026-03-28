# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Optional local outbound TTS provider support for `ResembleAI/chatterbox-turbo`.
- Local Chatterbox installer and smoke-test commands for operator setup.

### Changed

- Bridge status now reports the active outbound voice-reply provider.
- README and skill docs now cover outbound voice replies and Chatterbox Turbo setup.

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
