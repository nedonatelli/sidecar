import { workspace, Uri } from 'vscode';

export interface FileChange {
  filePath: string;
  originalContent: string | null; // null if file was newly created
  timestamp: number;
}

export class ChangeLog {
  private changes: FileChange[] = [];

  async snapshotFile(filePath: string): Promise<void> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return;

    // Check if we already have a snapshot for this file in this session
    if (this.changes.some(c => c.filePath === filePath)) return;

    const fileUri = Uri.joinPath(rootUri, filePath);
    let originalContent: string | null = null;
    try {
      const bytes = await workspace.fs.readFile(fileUri);
      originalContent = Buffer.from(bytes).toString('utf-8');
    } catch {
      // File doesn't exist yet — will be a new creation
      originalContent = null;
    }

    this.changes.push({
      filePath,
      originalContent,
      timestamp: Date.now(),
    });
  }

  getChanges(): FileChange[] {
    return [...this.changes];
  }

  hasChanges(): boolean {
    return this.changes.length > 0;
  }

  async rollbackAll(): Promise<{ restored: number; deleted: number; failed: number }> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return { restored: 0, deleted: 0, failed: 0 };

    let restored = 0;
    let deleted = 0;
    let failed = 0;

    // Process in reverse order (undo latest changes first)
    for (const change of [...this.changes].reverse()) {
      try {
        const fileUri = Uri.joinPath(rootUri, change.filePath);
        if (change.originalContent === null) {
          // File was newly created — delete it
          await workspace.fs.delete(fileUri);
          deleted++;
        } else {
          // File existed before — restore original content
          await workspace.fs.writeFile(fileUri, Buffer.from(change.originalContent, 'utf-8'));
          restored++;
        }
      } catch {
        failed++;
      }
    }

    this.changes = [];
    return { restored, deleted, failed };
  }

  async rollbackFile(filePath: string): Promise<boolean> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return false;

    const change = this.changes.find(c => c.filePath === filePath);
    if (!change) return false;

    try {
      const fileUri = Uri.joinPath(rootUri, filePath);
      if (change.originalContent === null) {
        await workspace.fs.delete(fileUri);
      } else {
        await workspace.fs.writeFile(fileUri, Buffer.from(change.originalContent, 'utf-8'));
      }
      this.changes = this.changes.filter(c => c.filePath !== filePath);
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.changes = [];
  }
}
