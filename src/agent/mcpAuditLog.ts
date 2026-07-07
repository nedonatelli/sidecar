import type { SidecarDir } from '../config/sidecarDir.js';
import { redactSecrets } from './securityScanner.js';

/**
 * Persistent MCP forensic log — `.sidecar/logs/mcp.jsonl`.
 *
 * The Output Channel is ephemeral: after an extension reload there is no
 * record of what command a `.mcp.json` server spawned, which tools it exposed,
 * or which responses tripped the injection heuristic. This mirror gives an
 * on-disk trail for those events. Always-on (unlike `api.jsonl`, which is
 * gated by `verboseLogs`) because MCP lifecycle events are low-volume and the
 * whole point is having the record when something already went wrong.
 */

export type McpAuditEvent =
  | {
      event: 'spawn';
      server: string;
      command: string;
      args: string[];
    }
  | {
      event: 'connected';
      server: string;
      transport: 'stdio' | 'http' | 'sse';
      toolCount: number;
      tools: string[];
      lazy: boolean;
    }
  | { event: 'connect-failed'; server: string; transport: 'stdio' | 'http' | 'sse'; error: string }
  | { event: 'reconnect-scheduled'; server: string; delayMs: number; attempt: number }
  | { event: 'connection-dropped'; server: string }
  | { event: 'disconnected'; server: string }
  | { event: 'injection-signals'; server: string; tool: string; signals: string[] };

let _auditDir: SidecarDir | null = null;

/** Wire the SidecarDir instance so MCP audit entries can be persisted. Called from servicesInit at activation. */
export function setMcpAuditDir(dir: SidecarDir | null): void {
  _auditDir = dir;
}

/**
 * Append one MCP lifecycle event to `.sidecar/logs/mcp.jsonl`, stamped with
 * the current time. Spawn commands/args are secret-redacted before they land
 * on disk. No-ops when no SidecarDir is wired (tests, no workspace).
 */
export function logMcpEvent(entry: McpAuditEvent): void {
  if (!_auditDir) return;
  const record: Record<string, unknown> = { ...entry, timestamp: new Date().toISOString() };
  if (entry.event === 'spawn') {
    record.command = redactSecrets(entry.command);
    record.args = entry.args.map((a) => redactSecrets(a));
  }
  _auditDir.appendJsonl('logs/mcp.jsonl', record).catch(() => {
    // Best-effort — never throw on logging failures
  });
}
