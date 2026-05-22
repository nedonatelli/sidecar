import * as fs from 'fs/promises';
import * as path from 'path';

export interface TeamMemoryEntry {
  /** Filename without the .md extension — used as the section heading. */
  label: string;
  content: string;
  filename: string;
}

/**
 * Loads shared team context from `.sidecar/team-memory/*.md`.
 *
 * Files are tracked in git so every developer on the team automatically
 * receives the same context injections. Each .md file becomes one
 * `## Team Memory` sub-section in the system prompt, sorted alphabetically
 * by filename so the injection order is stable and reviewable in diffs.
 *
 * No schema beyond plain markdown is required — the filename (minus .md)
 * becomes the label, the file body becomes the content.
 */
export class TeamMemoryStore {
  private entries: TeamMemoryEntry[] = [];
  private ready = false;
  private readonly dir: string;

  constructor(sidecarDir: string) {
    this.dir = path.join(sidecarDir, 'team-memory');
  }

  getDir(): string {
    return this.dir;
  }

  isReady(): boolean {
    return this.ready;
  }

  getEntries(): TeamMemoryEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  async load(): Promise<void> {
    let filenames: string[];
    try {
      filenames = await fs.readdir(this.dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.ready = true;
        return;
      }
      throw err;
    }

    const mdFiles = filenames.filter((f) => f.endsWith('.md')).sort();
    const loaded: TeamMemoryEntry[] = [];

    for (const filename of mdFiles) {
      try {
        const raw = await fs.readFile(path.join(this.dir, filename), 'utf-8');
        const content = raw.trim();
        if (content) {
          loaded.push({ label: filename.slice(0, -3), content, filename });
        }
      } catch {
        // skip unreadable files silently
      }
    }

    this.entries = loaded;
    this.ready = true;
  }
}
