import * as fs from 'fs';
import * as path from 'path';
import { workspace } from 'vscode';

export type ThinkingMode = 'single' | 'self-debate' | 'tree-of-thought' | 'red-team';

/**
 * Persistent store for thinking blocks from agent loops.
 * Maintains an in-memory ring buffer and persists to `.sidecar/thinking/<taskId>.md`.
 *
 * Each thinking block is appended as a timestamped entry. The first write
 * includes a frontmatter header with the mode selection.
 */
export class ThinkingStore {
  // In-memory ring buffer: Map<taskId, string[]> with max 50 entries per task
  private buffer = new Map<string, string[]>();
  private readonly MAX_ENTRIES = 50;
  private thinkingDir: string | undefined;

  constructor() {
    // Initialize the thinking directory path lazily from the workspace root
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
      this.thinkingDir = path.join(workspaceRoot, '.sidecar', 'thinking');
    }
  }

  /**
   * Append a thinking block to the store.
   * Adds to in-memory buffer and writes to disk asynchronously.
   * @param taskId Unique identifier for the task/session
   * @param content The thinking content (markdown text)
   * @param mode The thinking mode (single, self-debate, tree-of-thought, red-team)
   */
  async append(taskId: string, content: string, mode: ThinkingMode): Promise<void> {
    // Maintain in-memory ring buffer
    if (!this.buffer.has(taskId)) {
      this.buffer.set(taskId, []);
    }

    const entries = this.buffer.get(taskId)!;
    if (entries.length >= this.MAX_ENTRIES) {
      entries.shift(); // Remove oldest entry
    }

    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}]\n${content}`;
    entries.push(entry);

    // Fire-and-forget write to disk
    if (this.thinkingDir) {
      this.writeToDisk(taskId, mode).catch(() => {
        // Silently ignore write errors
      });
    }
  }

  /**
   * Write the current buffer for a task to disk.
   * On first write, includes frontmatter with the mode.
   * Subsequent writes append new entries.
   */
  private async writeToDisk(taskId: string, mode: ThinkingMode): Promise<void> {
    if (!this.thinkingDir) return;

    const thinkingPath = path.join(this.thinkingDir, `${taskId}.md`);

    // Ensure directory exists
    await fs.promises.mkdir(this.thinkingDir, { recursive: true });

    const entries = this.buffer.get(taskId) || [];

    // Check if file already exists
    let content = '';
    try {
      content = await fs.promises.readFile(thinkingPath, 'utf-8');
    } catch {
      // File doesn't exist yet, write with frontmatter
      content = `---\nmode: ${mode}\ntaskId: ${taskId}\ncreatedAt: ${new Date().toISOString()}\n---\n\n`;
    }

    // Append all buffered entries
    if (entries.length > 0) {
      content += entries.join('\n\n') + '\n';
    }

    await fs.promises.writeFile(thinkingPath, content, 'utf-8');
  }

  /**
   * Retrieve the thinking history for a task.
   * Returns the in-memory buffer entries.
   */
  get(taskId: string): string[] {
    return this.buffer.get(taskId) || [];
  }

  /**
   * Clear the in-memory buffer for a task (but leave the disk file intact).
   */
  clear(taskId: string): void {
    this.buffer.delete(taskId);
  }
}
