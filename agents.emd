# Agent Notes

## Release Workflow

Use this repo's release process every time a new version ships.

1. Work from `main`, not `master`.
2. Make sure the target changes are already merged into `main`.
3. Update `CHANGELOG.md`.
4. Move the current `Unreleased` notes into a new versioned section with the release date.
5. Leave a fresh `Unreleased` section at the top.
6. Bump the version in `package.json`.
7. If `package-lock.json` is tracked in the environment where the release is being prepared, keep it in sync with the new version.
8. Update the README install instructions so they point at the latest released tag.
9. In the README section `Install In Codex`, update all release-pinned values together:
10. The repository URL must stay correct.
11. The `Install the current release tag:` value must match the new tag, for example `v0.4.2`.
12. The step that checks out the release must use that same tag.
13. Keep the install instructions pinned to a release tag instead of a floating branch.
14. Run `npm run check`.
15. Run `npm test`.
16. If the release touches voice replies or local TTS routing, run a smoke test with `npm run whatsapp:tts:smoke`.
17. Commit the release preparation changes on `main`.
18. Push `main`.
19. Create and push an annotated git tag in the format `vX.Y.Z`.
20. Publish the GitHub release using the matching changelog entry as the release notes.

## Local Plugin Reinstall

When refreshing the locally installed Codex plugin after a release:

1. Reinstall from the release tag, not from a floating branch.
2. The installed plugin repo lives at `~/.codex/plugins/whatsapp-relay`.
3. Fetch tags, check out the desired release tag, and run `npm install`.
4. Do not force a new WhatsApp authentication flow if existing auth state is available.
5. If needed, copy local runtime state from the main repo plugin data into the installed plugin data:
6. `plugins/whatsapp-relay/data/auth`
7. `plugins/whatsapp-relay/data/store.json`
8. `plugins/whatsapp-relay/data/controller-config.json`
9. Do not copy `controller-state.json` across installs because it can preserve stale process IDs.

## Notes

- The repo's primary branch is `main`.
- The README install prompt is part of the release surface and must be updated on every new release.
- The goal is that a fresh Codex install follows the latest tagged release by default.
