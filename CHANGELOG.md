# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
