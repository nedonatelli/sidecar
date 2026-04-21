import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export interface PinnedEntry {
  id: string;
  /** Workspace-relative or absolute path that was pinned. */
  path: string;
  /** Display name shown in the sidebar. Defaults to basename(path). */
  label: string;
  /** Multiplier applied at injection time — higher entries land first. Default 1.0. */
  boost: number;
  /** Restrict to specific H2 headings within the file. Undefined = whole file. */
  headings?: string[];
  /** Resolved content captured at pin time. */
  content: string;
  pinnedAt: number;
}

/**
 * Persistent store for user-pinned memory entries.
 *
 * Entries are written to `<storeDir>/pins.json` (top-level `.sidecar/`,
 * tracked in git so team invariants travel with the repo). The content of
 * each entry is resolved at pin time and stored inline — the file on disk
 * is only the source of truth for the label/path/boost metadata, not for
 * re-retrieval.
 *
 * Injection into the system prompt happens via `injectSystemContext` in
 * `systemPrompt.ts` with always-include semantics: pinned entries are
 * appended before the RRF retrieval budget is applied, are never
 * mid-chopped, and survive context compaction because the system prompt
 * is rebuilt fresh on every turn.
 */
export class PinnedMemoryStore {
  private entries: PinnedEntry[] = [];
  private ready = false;
  private readonly pinsFile: string;
  private _onChange: (() => void) | undefined;

  constructor(storeDir: string) {
    this.pinsFile = path.join(storeDir, 'pins.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.pinsFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed as PinnedEntry[];
      }
    } catch {
      this.entries = [];
    }
    this.ready = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.pinsFile), { recursive: true });
    await fs.writeFile(this.pinsFile, JSON.stringify(this.entries, null, 2), 'utf8');
  }

  isReady(): boolean {
    return this.ready;
  }

  getEntries(): PinnedEntry[] {
    return [...this.entries].sort((a, b) => b.boost - a.boost);
  }

  setOnChange(fn: () => void): void {
    this._onChange = fn;
  }

  async pin(
    entryPath: string,
    content: string,
    opts?: { label?: string; boost?: number; headings?: string[] },
  ): Promise<PinnedEntry> {
    const id = createHash('sha256')
      .update(`${entryPath}:${JSON.stringify(opts?.headings ?? null)}`)
      .digest('hex')
      .slice(0, 12);

    const entry: PinnedEntry = {
      id,
      path: entryPath,
      label: opts?.label ?? path.basename(entryPath),
      boost: opts?.boost ?? 1.0,
      headings: opts?.headings,
      content,
      pinnedAt: Date.now(),
    };

    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.entries[idx] = entry;
    } else {
      this.entries.push(entry);
    }

    await this.persist();
    this._onChange?.();
    return entry;
  }

  async unpin(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
    this._onChange?.();
  }

  async updateContent(id: string, content: string): Promise<void> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    entry.content = content;
    entry.pinnedAt = Date.now();
    await this.persist();
  }

  size(): number {
    return this.entries.length;
  }
}
