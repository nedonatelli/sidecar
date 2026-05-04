import { getConfig } from '../../config/settings.js';
import type { ToolExecutorContext } from './shared.js';

/**
 * True when Audit Mode is active — writes should buffer, reads should
 * read-through the buffer for buffered paths. Checked per-call so the
 * user flipping agentMode mid-session takes effect on the next tool
 * dispatch. Returns false when no context is available or the mode
 * isn't `audit`, so tools that don't check this fall through to the
 * real-disk path unchanged.
 */
export function isAuditModeActive(context?: ToolExecutorContext): boolean {
  try {
    return (context?.config ?? getConfig()).agentMode === 'audit';
  } catch {
    return false;
  }
}

/**
 * Audit Mode v0.61 a.4: when the agent is running in audit mode and
 * `sidecar.audit.bufferGitCommits` is on, the `git_commit` tool call
 * queues the commit into the audit buffer instead of executing it.
 * The commit runs as part of the same flush that lands the buffered
 * file writes, so the user sees one atomic accept boundary.
 *
 * False when either check fails — settings read is guarded so a
 * broken workspace config can't throw on the hot commit path.
 */
export function shouldBufferCommits(context?: ToolExecutorContext): boolean {
  try {
    const cfg = context?.config ?? getConfig();
    return cfg.agentMode === 'audit' && cfg.auditBufferGitCommits === true;
  } catch {
    return false;
  }
}
