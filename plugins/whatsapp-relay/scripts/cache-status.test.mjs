import test from "node:test";
import assert from "node:assert/strict";
import { cacheStatusLines, missingHistoryHint } from "./cache-status.mjs";

test("idle caches expose a saved-session reconnect action without claiming absent history", () => {
  const text = cacheStatusLines({ status: "idle", hasCreds: true, pid: 123 }, { updatedAt: "2020-01-01" }).join("\n");
  assert.match(text, /sync_state: cache_only_disconnected/);
  assert.match(text, /cache_updated_at: 2020-01-01/);
  assert.match(text, /whatsapp_reconnect/);
  assert.doesNotMatch(text, /whatsapp_start_auth/);
  assert.match(text, /history_completeness: not_verified/);
  assert.match(missingHistoryHint, /does not prove it is absent/);
});

test("connected and bridge-owned caches never suggest duplicate authentication", () => {
  const live = cacheStatusLines({ status: "connected", hasCreds: true }).join("\n");
  assert.match(live, /live_updates_connected/);
  assert.doesNotMatch(live, /whatsapp_start_auth/);
  assert.match(live, /history_completeness: not_verified/);
  const bridge = cacheStatusLines({ status: "disconnected", sessionOwner: "controller_bridge", hasCreds: true }).join("\n");
  assert.match(bridge, /do not open a second direct socket/);
  assert.doesNotMatch(bridge, /whatsapp_start_auth/);
});
