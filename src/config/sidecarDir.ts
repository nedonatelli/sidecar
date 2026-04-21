import { workspace, Uri } from 'vscode';
import * as path from 'path';

/**
 * Manages the `.sidecar/` project directory.
 *
 * The directory lives at the workspace root and provides persistent storage
 * for workspace index cache, agent reasoning logs, session history, plans,
 * memory, and scratchpad files.
 *
 * Committed to git:  SIDECAR.md, settings.json, specs/, plans/, memory/
 * Gitignored:        cache/, sessions/, logs/, scratchpad/
 */
export class SidecarDir {
  private root: string | null = null;
  private initialized = false;

  /** Subdirectories created on first access (lazy). */
  private static readonly SUBDIRS = [
    'specs',
    'plans',
    'memory',
    'cache',
    'sessions',
    'logs',
    'scratchpad',
    'audit-buffer',
  ] as const;

  /** Subdirectories excluded from git. */
  private static readonly GITIGNORED = ['cache', 'sessions', 'logs', 'scratchpad', 'audit-buffer'] as const;

  private static readonly GITIGNORE_CONTENT = [
    '# Ephemeral / machine-specific — do not commit',
    'cache/',
    'sessions/',
    'logs/',
    'scratchpad/',
    'audit-buffer/',
    'pids.json',
    '',
  ].join('\n');

  /**
   * Initialize the `.sidecar/` directory.
   * Creates the top-level directory and `.gitignore` if they don't exist.
   * Subdirectories are created lazily on first write.
   */
  async initialize(): Promise<boolean> {
    const rootUri = workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) return false;

    this.root = path.join(rootUri.fsPath, '.sidecar');
    const dirUri = Uri.file(this.root);

    try {
      await workspace.fs.createDirectory(dirUri);
    } catch {
      // Already exists
    }

    // Write .gitignore if missing
    const gitignoreUri = Uri.joinPath(dirUri, '.gitignore');
    try {
      await workspace.fs.stat(gitignoreUri);
    } catch {
      await workspace.fs.writeFile(gitignoreUri, Buffer.from(SidecarDir.GITIGNORE_CONTENT, 'utf-8'));
    }

    this.initialized = true;
    return true;
  }

  /** Whether the directory has been successfully initialized. */
  isReady(): boolean {
    return this.initialized && this.root !== null;
  }

  /** Absolute path to a file or subdirectory within `.sidecar/`. */
  getPath(...segments: string[]): string {
    if (!this.root) throw new Error('.sidecar directory not initialized');
    return path.join(this.root, ...segments);
  }

  /** URI for a file or subdirectory within `.sidecar/`. */
  getUri(...segments: string[]): Uri {
    return Uri.file(this.getPath(...segments));
  }

  /**
   * Ensure a subdirectory exists, creating it if needed.
   * Use this before writing files to a subdirectory.
   */
  async ensureSubdir(name: (typeof SidecarDir.SUBDIRS)[number]): Promise<string> {
    const dirPath = this.getPath(name);
    try {
      await workspace.fs.createDirectory(Uri.file(dirPath));
    } catch {
      // Already exists
    }
    return dirPath;
  }

  /** Read a JSON file from `.sidecar/`. Returns null if the file doesn't exist or is invalid. */
  async readJson<T = unknown>(subpath: string): Promise<T | null> {
    try {
      const bytes = await workspace.fs.readFile(this.getUri(subpath));
      return JSON.parse(Buffer.from(bytes).toString('utf-8')) as T;
    } catch {
      return null;
    }
  }

  /** Write a JSON file to `.sidecar/`, creating parent directories as needed. */
  async writeJson(subpath: string, data: unknown): Promise<void> {
    const uri = this.getUri(subpath);
    const dir = path.dirname(subpath);
    if (dir && dir !== '.') {
      await this.ensureSubdir(dir.split(path.sep)[0] as (typeof SidecarDir.SUBDIRS)[number]);
    }
    await workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2), 'utf-8'));
  }

  /** Append a line to a JSONL file (for logs). */
  async appendJsonl(subpath: string, data: unknown): Promise<void> {
    const uri = this.getUri(subpath);
    const dir = path.dirname(subpath);
    if (dir && dir !== '.') {
      await this.ensureSubdir(dir.split(path.sep)[0] as (typeof SidecarDir.SUBDIRS)[number]);
    }
    const line = JSON.stringify(data) + '\n';
    try {
      const existing = await workspace.fs.readFile(uri);
      const combined = Buffer.concat([existing, Buffer.from(line, 'utf-8')]);
      await workspace.fs.writeFile(uri, combined);
    } catch {
      // File doesn't exist yet — create it
      await workspace.fs.writeFile(uri, Buffer.from(line, 'utf-8'));
    }
  }

  /** Write a text file (for plans, specs, markdown). */
  async writeText(subpath: string, content: string): Promise<void> {
    const uri = this.getUri(subpath);
    const dir = path.dirname(subpath);
    if (dir && dir !== '.') {
      await this.ensureSubdir(dir.split(path.sep)[0] as (typeof SidecarDir.SUBDIRS)[number]);
    }
    await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  }

  /** Read a text file from `.sidecar/`. Returns null if not found. */
  async readText(subpath: string): Promise<string | null> {
    try {
      const bytes = await workspace.fs.readFile(this.getUri(subpath));
      return Buffer.from(bytes).toString('utf-8');
    } catch {
      return null;
    }
  }

  /** List files in a subdirectory. Returns relative paths within the subdir. */
  async listFiles(subdir: string): Promise<string[]> {
    try {
      const entries = await workspace.fs.readDirectory(this.getUri(subdir));
      return entries.filter(([, type]) => type === 1).map(([name]) => name);
    } catch {
      return [];
    }
  }
}
