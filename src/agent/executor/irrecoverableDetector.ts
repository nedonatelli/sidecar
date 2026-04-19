import type { ToolUseContentBlock } from '../../ollama/types.js';

/**
 * Detect tool calls that are destructive and hard or impossible to
 * undo. These force an escalated confirmation gate — the user must
 * explicitly type a confirmation phrase, rather than one-click Allow,
 * and the gate runs even in autonomous mode so a runaway agent can't
 * slip a `git push --force` past without the user seeing it.
 *
 * Returns a human-readable description of the destructive action if
 * detected, or null for normal tool calls. Matches are intentionally
 * conservative — we'd rather miss a destructive pattern than prompt
 * on innocuous calls.
 */
export function detectIrrecoverable(toolUse: ToolUseContentBlock): string | null {
  const name = toolUse.name;
  const input = toolUse.input as Record<string, unknown>;

  if (name === 'run_command') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    // Recursive force-delete (rm -rf, rm -fr, rm -Rf…)
    if (/\brm\s+(-[frRf]{1,3}|--force\s+--recursive|--recursive\s+--force)\b/.test(cmd)) {
      return 'Recursive force-delete (rm -rf)';
    }
    // Force push to a remote
    if (/\bgit\s+push\s+(?:[^|;&]*\s)?(?:--force\b|--force-with-lease\b|-f\b)/.test(cmd)) {
      return 'Force push to remote (git push --force)';
    }
    // Hard reset discards uncommitted work
    if (/\bgit\s+reset\s+--hard\b/.test(cmd)) {
      return 'Hard reset (git reset --hard discards uncommitted changes)';
    }
    // Force branch delete
    if (/\bgit\s+branch\s+-D\b/.test(cmd)) {
      return 'Force branch delete (git branch -D)';
    }
    // Clean untracked files
    if (/\bgit\s+clean\s+-[fdx]{1,3}\b/.test(cmd)) {
      return 'git clean (removes untracked files)';
    }
    // Database DROP / TRUNCATE
    if (/\b(?:DROP|TRUNCATE)\s+(?:DATABASE|TABLE|SCHEMA|INDEX)\b/i.test(cmd)) {
      return 'Destructive SQL (DROP / TRUNCATE)';
    }
    // chmod / chown on home dir roots
    if (/\b(?:chmod|chown)\b.*[\s=](?:\/|~|\$HOME)/.test(cmd)) {
      return 'Permission change targeting home or root';
    }
  }

  return null;
}
