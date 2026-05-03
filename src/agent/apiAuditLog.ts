import type { SidecarDir } from '../config/sidecarDir.js';

export interface ApiAuditEntry {
  runId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  timestamp: string;
}

let _auditDir: SidecarDir | null = null;

/** Wire the SidecarDir instance so API audit entries can be persisted. Called from extension.ts at activation. */
export function setApiAuditDir(dir: SidecarDir | null): void {
  _auditDir = dir;
}

/**
 * Append one per-turn API call entry to `.sidecar/logs/api.jsonl`.
 * No-ops when `verboseLogs` is off or no SidecarDir is wired.
 */
export function logApiCall(entry: ApiAuditEntry, verboseLogs: boolean): void {
  if (!verboseLogs || !_auditDir) return;
  _auditDir.appendJsonl('logs/api.jsonl', entry).catch(() => {
    // Best-effort — never throw on logging failures
  });
}
