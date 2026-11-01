// Relay bug reports, one JSON object per line. The agent files one with
// whatsapp_report_bug, and the service files one itself when a tool crashes
// with a programming error (TypeError and friends). A coding agent watching
// the file can pick reports up and fix the relay without a human relaying
// them. Reports never carry message text: string arguments that are not IDs
// or JIDs are replaced by their length.
import fs from "node:fs/promises";
import path from "node:path";

import { bugReportsFile } from "./paths.mjs";

const DEDUPE_MS = 10 * 60 * 1000;
const MAX_PER_HOUR = 20;
const ID_FIELDS = /(^|[a-z])(id|ids|jid|jids|chat|chatName|tool|status|mode|sendAt|kind|emoji)$/i;
const JID = /^[\w.:-]+@[\w.]+$/;
const MAX_FIELD = 500;

// Errors a handler throws on purpose are plain Errors ("Chat not found");
// a TypeError or ReferenceError means the relay code itself is wrong.
// Timeouts and aborts are the network, not the code.
const NOT_BUGS = new Set(["Error", "ZodError", "AbortError", "TimeoutError", "DaemonUnavailableError"]);
export function isInternalError(error) {
  return error instanceof Error && !NOT_BUGS.has(error.name) && !/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND/.test(error.code ?? "");
}

export function redactArgs(value, key = "") {
  if (Array.isArray(value)) return value.map(item => redactArgs(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactArgs(v, k)]));
  }
  if (typeof value === "string" && !ID_FIELDS.test(key) && !JID.test(value)) return `<${value.length} chars>`;
  return value;
}

const clip = text => (text == null ? undefined : String(text).slice(0, MAX_FIELD));
const signature = report => `${report.tool ?? ""}|${String(report.error ?? report.problem ?? "").split("\n")[0].replace(/\d+/g, "#")}`;

export class BugReporter {
  constructor({ file = bugReportsFile, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.recent = new Map(); // signature -> last report time
    this.filed = [];
  }

  // Returns the stored report, or { skipped } when it repeats a recent one or
  // the hourly cap is hit, so a crash loop cannot flood the watcher.
  async report({ source, tool, args, error, stack, problem, expected }) {
    const now = this.now();
    this.filed = this.filed.filter(at => now - at < 3600_000);
    const draft = { tool, error: clip(error), problem: clip(problem) };
    const sig = signature(draft);
    if (now - (this.recent.get(sig) ?? -Infinity) < DEDUPE_MS) return { skipped: "duplicate of a report filed in the last 10 minutes" };
    if (this.filed.length >= MAX_PER_HOUR) return { skipped: `more than ${MAX_PER_HOUR} reports in the last hour` };

    const report = {
      id: `bug-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: new Date(now).toISOString(),
      source,
      ...(tool ? { tool } : {}),
      ...(args && Object.keys(args).length ? { args: redactArgs(args) } : {}),
      ...(draft.error ? { error: draft.error } : {}),
      ...(stack ? { stack: String(stack).split("\n").slice(0, 8).join("\n") } : {}),
      ...(draft.problem ? { problem: draft.problem } : {}),
      ...(expected ? { expected: clip(expected) } : {})
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    this.recent.set(sig, now);
    this.filed.push(now);
    return report;
  }
}
