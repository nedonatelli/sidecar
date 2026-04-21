/**
 * Auto Mode failure log (v0.73.3).
 *
 * Appends structured entries to `.sidecar/logs/auto-mode-failures.md`
 * whenever a task errors during an Auto Mode session. The file is
 * created on first write; the directory is expected to exist (SidecarDir
 * initialises it on extension activation).
 *
 * Pure module: no VS Code imports. Callers supply the resolved log path.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface FailureLogEntry {
  taskText: string;
  errorMessage: string;
  timestamp?: Date;
}

/**
 * Append one failure entry to the log file at `logPath`.
 * Creates the file (and any missing parent directories) on first write.
 */
export async function appendFailureLogEntry(logPath: string, entry: FailureLogEntry): Promise<void> {
  const ts = (entry.timestamp ?? new Date()).toISOString();
  const text = formatEntry(ts, entry.taskText, entry.errorMessage);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, text, 'utf8');
}

function formatEntry(timestamp: string, taskText: string, errorMessage: string): string {
  return `## ${timestamp}\n\n**Task:** ${taskText}\n\n**Error:** ${errorMessage}\n\n---\n\n`;
}
