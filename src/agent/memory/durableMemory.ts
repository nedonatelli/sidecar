import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { neutralizeInjections } from '../injectionGuard.js';

export interface DurableInstructionEntry {
  /** sha256 of the normalized text — content-addressed, so re-latching dedupes. */
  id: string;
  /** The instruction, verbatim as the user said it. */
  text: string;
  /** Where the entry came from. Only compaction extraction writes today. */
  source: 'compaction-extraction';
  firstSeen: number;
  lastSeen: number;
  /** Distinct persist events — a rule re-latched across sessions is load-bearing. */
  seenCount: number;
}

/** Caps chosen against LOCAL_MAX_SYSTEM_CHARS pressure: the injected section
 *  must stay a footnote, not a second SIDECAR.md. */
export const MAX_DURABLE_ENTRIES = 20;
export const MAX_DURABLE_SECTION_CHARS = 2000;

/**
 * Cross-session sink of the durable-context package (v0.121 second half).
 *
 * The in-session half (compaction.durableInstructions, proven 0–8 p=0.0078)
 * keeps standing instructions alive through summarization; this store makes
 * them survive the SESSION: the same extraction that latches an instruction
 * into the summary persists it to `.sidecar/memory/durable-instructions.json`
 * (gitignored per-user state), and the next session re-injects it into the
 * system prompt.
 *
 * Write path is harness-assisted by design — voluntary tool adoption measured
 * ~0/10 across five local families, so the load-bearing writer is the
 * compaction hook, not a save_memory tool.
 *
 * Trust boundary: entries originate from USER text (the extraction only reads
 * user messages), but they are workspace state re-injected into prompts, so
 * every entry passes `neutralizeInjections` at render time and the section is
 * clearly fenced as remembered context. See SECURITY.md.
 */
export class DurableMemoryStore {
  private entries: DurableInstructionEntry[] = [];
  private ready = false;
  private readonly file: string;

  constructor(storeDir: string) {
    this.file = path.join(storeDir, 'durable-instructions.json');
  }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.entries = parsed as DurableInstructionEntry[];
    } catch {
      this.entries = [];
    }
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  size(): number {
    return this.entries.length;
  }

  getEntries(): DurableInstructionEntry[] {
    // Most-reinforced first, then most recent — the rules a user repeats
    // across sessions outrank a one-off.
    return [...this.entries].sort((a, b) => b.seenCount - a.seenCount || b.lastSeen - a.lastSeen);
  }

  /**
   * Persist latched instructions. Content-addressed: a re-latched rule bumps
   * `lastSeen`/`seenCount` instead of duplicating. Oldest least-reinforced
   * entries are evicted past MAX_DURABLE_ENTRIES.
   */
  async addAll(texts: string[], now = Date.now()): Promise<number> {
    let added = 0;
    for (const raw of texts) {
      const text = raw.trim();
      if (text === '') continue;
      const id = createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16);
      const existing = this.entries.find((e) => e.id === id);
      if (existing) {
        existing.lastSeen = now;
        existing.seenCount += 1;
      } else {
        this.entries.push({ id, text, source: 'compaction-extraction', firstSeen: now, lastSeen: now, seenCount: 1 });
        added++;
      }
    }
    if (this.entries.length > MAX_DURABLE_ENTRIES) {
      this.entries = this.getEntries().slice(0, MAX_DURABLE_ENTRIES);
    }
    if (added > 0 || texts.length > 0) await this.persist();
    return added;
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.entries, null, 2), 'utf8');
  }
}

/**
 * Render the remembered-instructions prompt section. Pure and shared by the
 * production injector (`injectSystemContext`) and the eval harness, so both
 * paths inject byte-identical semantics. Every entry is injection-screened at
 * render time; the section is budget-capped and never mid-chops an entry.
 * Returns '' when there is nothing to say.
 */
export function renderDurableMemorySection(
  entries: DurableInstructionEntry[],
  maxChars = MAX_DURABLE_SECTION_CHARS,
): string {
  if (entries.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const { text } = neutralizeInjections(entry.text, 'remembered instruction');
    const line = `- ${text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return '';
  // Provenance only — no scope editorializing. The entries are the user's own
  // words verbatim; whatever scope the user stated travels inside the entry
  // (the memory-recall trap-prompt lesson: the product must not reinterpret
  // instruction scope on the user's behalf).
  return (
    '\n\n## Remembered Instructions\n' +
    '<!-- Standing instructions the user gave in EARLIER sessions of this project, preserved verbatim. -->\n' +
    lines.join('\n')
  );
}
