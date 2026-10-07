import type { ToolUseContentBlock } from '../../ollama/types.js';
import { isExecutionConfigPath } from '../tools/shared.js';

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
/**
 * The shell command a tool call would run, for the tools that take one:
 * run_command, run_tests with an explicit `command`, and
 * research_log_experiment. Null for every other call.
 */
export function shellCommandOf(toolUse: ToolUseContentBlock): string | null {
  const input = toolUse.input as Record<string, unknown>;
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (!cmd) return null;
  return ['run_command', 'run_tests', 'research_log_experiment'].includes(toolUse.name) ? cmd : null;
}

export function detectIrrecoverable(toolUse: ToolUseContentBlock): string | null {
  const name = toolUse.name;
  const input = toolUse.input as Record<string, unknown>;

  // Every tool that runs a shell command, not only run_command: run_tests and
  // research_log_experiment take a free-form command too.
  const shellCommand = shellCommandOf(toolUse);
  if (shellCommand !== null) {
    const cmd = shellCommand;
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

  // A file another program runs commands from (VS Code tasks, MCP servers,
  // git hook managers): planting one runs code later, outside any approval.
  if (name === 'write_file' || name === 'edit_file' || name === 'delete_file') {
    const target = typeof input.path === 'string' ? input.path : '';
    if (target && isExecutionConfigPath(target)) {
      return `Changes ${target}, a file other tools run commands from`;
    }
  }

  return null;
}
