export function cacheStatusLines({ status, hasCreds, sessionOwner, pid = process.pid, connectedSince, disconnectedSince, nextReconnectAt, reconnectCount }, meta = {}) {
  const live = status === "connected";
  return [
    "source: local_cache",
    `connection: ${status}`,
    `runtime_pid: ${pid}`,
    ...(sessionOwner ? [`live_session_owner: ${sessionOwner}`] : []),
    `sync_state: ${live ? "live_updates_connected" : "cache_only_disconnected"}`,
    `cache_updated_at: ${meta.updatedAt ?? "unknown"}`,
    `last_history_sync_at: ${meta.lastHistorySyncAt ?? "unknown"}`,
    `last_message_event_at: ${meta.lastMessageEventAt ?? "unknown"}`,
    "history_completeness: not_verified",
    ...(live && connectedSince ? [`connected_since: ${connectedSince}`] : []),
    ...(reconnectCount ? [`reconnects_this_process: ${reconnectCount}`] : []),
    ...(live ? [] : [
      `stale_since: ${disconnectedSince ?? meta.lastMessageEventAt ?? "unknown"}`,
      ...(nextReconnectAt ? [`next_reconnect_at: ${nextReconnectAt}`] : []),
      "freshness_warning: not connected; messages that arrived after stale_since may be missing and unread counts may be low"
    ]),
    ...(live ? [] : [sessionOwner === "controller_bridge"
      ? "next_step: inspect the existing controller bridge connection; do not open a second direct socket"
      : hasCreds
      ? "next_step: call whatsapp_reconnect to reopen the saved session (no QR code); live tools also reconnect on demand"
      : "next_step: authentication is required before live synchronization"])
  ];
}

export const missingHistoryHint = "next_step: a missing cached conversation or message does not prove it is absent on the phone; older-history sync requires a known message anchor and cannot guarantee newest-phone completeness; do not guess a recipient or retry a send";
