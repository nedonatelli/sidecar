/**
 * Pure helpers for code-action and terminal-error prompts.
 *
 * Extracted from ChatViewProvider.sendCodeAction / diagnoseTerminalError
 * so the prompt-building logic is testable without instantiating
 * ChatViewProvider (which requires a live WebviewView + all its deps).
 */

import * as path from 'path';
import { wrapUntrustedTerminalOutput } from '../agent/injectionScanner.js';

export interface TerminalErrorEvent {
  commandLine: string;
  exitCode: number;
  cwd: string | undefined;
  output: string;
}

/**
 * Build the user-facing prompt for an inline code action (Fix / Explain /
 * Refactor). Optionally appends a diagnostic message from the editor.
 */
export function buildCodeActionPrompt(action: string, code: string, fileName: string, diagnostic?: string): string {
  let prompt = `${action} this code from ${fileName}:\n\`\`\`\n${code}\n\`\`\``;
  if (diagnostic) prompt += `\n\nDiagnostic reported by the editor:\n\`\`\`\n${diagnostic}\n\`\`\``;
  return prompt;
}

/**
 * Build the user-facing prompt for a terminal command failure. Sanitises
 * the command output via `wrapUntrustedTerminalOutput` before embedding it
 * so that injection markers inside shell output can't hijack the agent.
 */
export function buildTerminalErrorPrompt(event: TerminalErrorEvent): string {
  const cwdLine = event.cwd ? `\nWorking directory: ${event.cwd}` : '';
  const wrappedOutputBlock = wrapUntrustedTerminalOutput(event.output || '');
  return (
    `A command in my terminal just failed. Help me diagnose and fix it.\n\n` +
    `Command: \`${event.commandLine}\`\n` +
    `Exit code: ${event.exitCode}` +
    cwdLine +
    wrappedOutputBlock
  );
}

/**
 * Basename of a file path — extracted so callers don't need to import
 * `path` directly and so tests can verify the exact display name.
 */
export function fileDisplayName(filePath: string): string {
  return path.basename(filePath);
}
